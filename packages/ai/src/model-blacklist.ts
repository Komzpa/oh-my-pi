import * as fs from "node:fs";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";

interface ModelIdentity {
	provider: string;
	id: string;
}

/** Owner policy shared by all profiles; role lists and presets cannot override it. */
export function readModelBlacklist(): ReadonlyMap<string, string> {
	const file = path.join(getBaseConfigRoot(), "model-blacklist.json");
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		if (isEnoent(error)) return new Map();
		throw new Error(`Cannot read model blacklist ${file}: ${error instanceof Error ? error.message : error}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid model blacklist ${file}: expected selector-to-reason object`);
	}
	const entries = Object.entries(value);
	for (const [selector, reason] of entries) {
		if (!/^[a-z0-9][a-z0-9_-]*\/\S+$/.test(selector) || typeof reason !== "string" || !reason.trim()) {
			throw new Error(`Invalid model blacklist ${file}: each provider/model requires a nonblank reason`);
		}
	}
	return new Map(entries as [string, string][]);
}

export function modelBlacklistReason(model: ModelIdentity, blacklist = readModelBlacklist()): string | undefined {
	return blacklist.get(`${model.provider.toLowerCase()}/${model.id}`);
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
