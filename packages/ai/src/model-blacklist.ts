import * as fs from "node:fs";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";

interface ModelIdentity {
	provider: string;
	id: string;
	blacklistIdentity?: { provider: string; id: string };
	blacklistRouteIdentity?: { provider: string; id: string };
}

let cached:
	| { file: string; mtimeMs: number; size: number; inode: number; value: ReadonlyMap<string, string> }
	| undefined;

/** Owner policy shared by all profiles; role lists and presets cannot override it. */
export function readModelBlacklist(): ReadonlyMap<string, string> {
	const file = path.join(getBaseConfigRoot(), "model-blacklist.json");
	let value: unknown;
	let version: fs.Stats;
	try {
		const stat = fs.statSync(file);
		version = stat;
		if (
			cached?.file === file &&
			cached.mtimeMs === stat.mtimeMs &&
			cached.size === stat.size &&
			cached.inode === stat.ino
		) {
			return cached.value;
		}
		value = JSON.parse(fs.readFileSync(file, "utf8"));
		// Save only after validation below. A failed read must never restore a stale policy.
		cached = undefined;
	} catch (error) {
		if (isEnoent(error)) {
			cached = undefined;
			return new Map();
		}
		throw new Error(`Cannot read model blacklist ${file}: ${error instanceof Error ? error.message : error}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid model blacklist ${file}: expected selector-to-reason object`);
	}
	const entries = Object.entries(value);
	for (const [selector, reason] of entries) {
		const separator = selector.indexOf("/");
		if (
			separator <= 0 ||
			separator === selector.length - 1 ||
			selector.trim() !== selector ||
			selector.slice(0, separator) !== selector.slice(0, separator).toLowerCase() ||
			typeof reason !== "string" ||
			!reason.trim()
		) {
			throw new Error(`Invalid model blacklist ${file}: each provider/model requires a nonblank reason`);
		}
	}
	const result = new Map(entries as [string, string][]);
	cached = { file, mtimeMs: version.mtimeMs, size: version.size, inode: version.ino, value: result };
	return result;
}

export function modelBlacklistReason(model: ModelIdentity, blacklist = readModelBlacklist()): string | undefined {
	return (
		blacklist.get(`${model.provider.toLowerCase()}/${model.id}`) ??
		(model.blacklistIdentity
			? blacklist.get(`${model.blacklistIdentity.provider.toLowerCase()}/${model.blacklistIdentity.id}`)
			: undefined) ??
		(model.blacklistRouteIdentity
			? blacklist.get(`${model.blacklistRouteIdentity.provider.toLowerCase()}/${model.blacklistRouteIdentity.id}`)
			: undefined)
	);
}

/** Re-read at dispatch so an already selected or resumed model cannot bypass a new ban. */
export function assertModelNotBlacklisted(model: ModelIdentity): void {
	const reason = modelBlacklistReason(model);
	if (reason !== undefined) throw new Error(`Model ${model.provider}/${model.id} is blacklisted: ${reason}`);
}

export function filterBlacklistedModels<T extends ModelIdentity>(models: T[]): T[] {
	const blacklist = readModelBlacklist();
	return blacklist.size ? models.filter(model => modelBlacklistReason(model, blacklist) === undefined) : models;
}

/** Preserve the catalog identity across route clones and serialized session snapshots. */
export function inheritModelBlacklistIdentity<T extends ModelIdentity>(source: ModelIdentity, alias: T): T {
	return { ...alias, blacklistIdentity: source.blacklistIdentity ?? { provider: source.provider, id: source.id } };
}
