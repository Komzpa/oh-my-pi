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
export function workerRiskPools(
	settings: Settings,
	registry: Pick<ModelRegistry, "getAvailable" | "isSelectorSuppressed">,
	agents: readonly Pick<AgentDefinition, "name" | "model">[],
	resolvePatterns: PatternResolver = resolveConfiguredModelPatterns,
): RowRiskOptions["pools"] {
	const available = registry
		.getAvailable()
		.filter(model => !registry.isSelectorSuppressed(`${model.provider}/${model.id}`));
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
		const components = parseRowRiskFile(await Bun.file(file).json(), now);
		if (!components) return;
		const { agents } = await discoverAgents(cwd, os.homedir(), roots);
		return { components, pools: workerRiskPools(settings, registry, agents), defaultWorkerType: "task" };
	} catch {
		return;
	}
}
