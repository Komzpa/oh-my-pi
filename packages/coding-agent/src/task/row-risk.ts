import * as fs from "node:fs";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";
import * as os from "node:os";
import * as path from "node:path";
import { parseRowRiskFile, type RowRiskOptions } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { ModelRegistry } from "../config/model-registry";
import { resolveConfiguredModelPatterns, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { EffectiveExtensionRoots } from "../capability/types";
import { discoverAgents } from "./discovery";
import { cfgTaskAgentModelOverrides } from "./settings";
import type { AgentDefinition } from "./types";

/** The same seeded expansion used by spawn owns nested roles, effort suffixes and pool weights. */
type PatternResolver = (value: string | string[] | undefined, settings?: Settings, seed?: string) => string[];
type RiskRegistry = Pick<ModelRegistry, "getAvailable" | "isSelectorSuppressed"> &
	Partial<Pick<ModelRegistry, "subscribeMirror">>;
interface PoolCache {
	revision: number;
	entries: WeakMap<Settings, { key: string; pools: RowRiskOptions["pools"] }>;
}
const poolCaches = new WeakMap<RiskRegistry, PoolCache>();
function fileVersion(file: string): string {
	try {
		const stat = fs.statSync(file);
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	} catch (error) {
		if (isEnoent(error)) return "missing";
		throw error;
	}
}
const componentCaches = new Map<string, { version: string; components: RowRiskOptions["components"] | undefined }>();

export function workerRiskPools(
	settings: Settings,
	registry: RiskRegistry,
	agents: readonly Pick<AgentDefinition, "name" | "model">[],
	resolvePatterns: PatternResolver = resolveConfiguredModelPatterns,
): RowRiskOptions["pools"] {
	const available = registry
		.getAvailable()
		.filter(model => !registry.isSelectorSuppressed(`${model.provider}/${model.id}`));
	let cache = poolCaches.get(registry);
	if (!cache) {
		cache = { revision: 0, entries: new WeakMap() };
		poolCaches.set(registry, cache);
		const state = cache;
		registry.subscribeMirror?.(() => {
			state.revision++;
		});
	}
	const key = JSON.stringify([
		settings.revision,
		cache.revision,
		available.map(model => `${model.provider}/${model.id}`),
		agents.map(agent => [agent.name, agent.model]),
		fileVersion(path.join(getBaseConfigRoot(), "model-blacklist.json")),
	]);
	const cached = cache.entries.get(settings);
	// Custom resolvers may depend on caller-owned mutable state without a revision.
	const cacheable = resolvePatterns === resolveConfiguredModelPatterns;
	if (cacheable && cached?.key === key) return cached.pools;
	const overrides = cfgTaskAgentModelOverrides.get(settings);
	const pools: RowRiskOptions["pools"] = {};
	const resolved = new Map<string, string | undefined>();
	for (const agent of agents) {
		const counts = new Map<string, number>();
		for (let sample = 0; sample < 2000; sample++) {
			const patterns = resolvePatterns(
				overrides[agent.name] ?? agent.model ?? "@task",
				settings,
				`row-risk-${sample}`,
			);
			for (const pattern of patterns) {
				if (!resolved.has(pattern)) {
					const model = resolveModelRoleValue(pattern, available, { settings }).model;
					resolved.set(pattern, model ? `${model.provider}/${model.id}` : undefined);
				}
				const model = resolved.get(pattern);
				if (!model) continue;
				counts.set(model, (counts.get(model) ?? 0) + 1);
				break;
			}
		}
		pools[agent.name] = [...counts].map(([model, weight]) => ({ model, weight }));
	}
	if (cacheable) cache.entries.set(settings, { key, pools });
	return pools;
}

export async function loadRowRisk(
	settings: Settings | undefined,
	registry: ModelRegistry | undefined,
	cwd: string,
	roots?: EffectiveExtensionRoots,
	now = Date.now(),
	file = path.join(os.homedir(), ".omp/agent/row-risk.json"),
): Promise<RowRiskOptions | undefined> {
	if (!settings || !registry) return;
	try {
		const version = fileVersion(file);
		let cached = componentCaches.get(file);
		if (cached?.version !== version) {
			// Validate structure once; age is checked separately on every load.
			let raw: unknown;
			try {
				raw = await Bun.file(file).json();
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				componentCaches.set(file, { version, components: undefined });
				return;
			}
			const generatedAt =
				typeof raw === "object" && raw !== null && "generatedAt" in raw ? raw.generatedAt : undefined;
			const generated = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN;
			cached = { version, components: parseRowRiskFile(raw, generated) };
			componentCaches.set(file, cached);
		}
		const components = cached.components;
		if (components) {
			const generated = Date.parse(components.generatedAt);
			if (generated > now || now - generated > 14 * 86400_000) return;
		}
		if (!components) return;
		const { agents } = await discoverAgents(cwd, os.homedir(), roots);
		return { components, pools: workerRiskPools(settings, registry, agents), defaultWorkerType: "task" };
	} catch {
		return;
	}
}
