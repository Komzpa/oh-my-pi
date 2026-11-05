import * as os from "node:os";
import * as path from "node:path";
import { parseRowRiskFile, type RowRiskOptions } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { ModelRegistry } from "../config/model-registry";
import {
	normalizeModelPatternList,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { EffectiveExtensionRoots } from "../capability/types";
import { discoverAgents } from "./discovery";
import { cfgTaskAgentModelOverrides } from "./settings";
import type { AgentDefinition } from "./types";

/** Settings owns pool policy; older standalone builds simply have ordered role chains. */
type PoolSettings = Settings & { getModelRolePool?(role: string): Readonly<Record<string, number>> | undefined };
export function workerRiskPools(
	settings: Settings,
	registry: Pick<ModelRegistry, "getAvailable" | "isSelectorSuppressed">,
	agents: readonly Pick<AgentDefinition, "name" | "model">[],
): RowRiskOptions["pools"] {
	const available = registry
		.getAvailable()
		.filter(model => !registry.isSelectorSuppressed(`${model.provider}/${model.id}`));
	const overrides = cfgTaskAgentModelOverrides.get(settings);
	const pools: RowRiskOptions["pools"] = {};
	for (const agent of agents) {
		const sources = normalizeModelPatternList(overrides[agent.name] ?? agent.model ?? "@task");
		for (const source of sources) {
			const role = resolveExplicitModelRole(source, settings);
			const weights = role ? (settings as PoolSettings).getModelRolePool?.(role) : undefined;
			const members = resolveConfiguredModelPatterns(source, settings);
			const resolved = members.flatMap(member => {
				const model = resolveModelRoleValue(member, available, { settings }).model;
				if (!model) return [];
				const weight = weights ? (weights[member] ?? 1) : 1;
				return [
					{ model: `${model.provider}/${model.id}`, weight: Number.isFinite(weight) && weight > 0 ? weight : 0 },
				];
			});
			const positive = resolved.filter(candidate => candidate.weight > 0);
			const candidates = positive.length
				? positive
				: resolved.slice(0, 1).map(candidate => ({ ...candidate, weight: 1 }));
			if (candidates.length) {
				// A non-pool chain selects its first available entry, rather than drawing uniformly.
				pools[agent.name] = weights ? candidates : candidates.slice(0, 1);
				break;
			}
		}
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
