import type { AgentRegistryApi } from "./agent-registry";

// Scoped to the registry so a new runtime cannot inherit another runtime's reservations.
const reservations = new WeakMap<AgentRegistryApi, Map<string, string | undefined>>();

export function reserveRestoringAgents(
	registry: AgentRegistryApi,
	agents: Array<{ id: string; parentId?: string }>,
): (id: string) => void {
	let pending = reservations.get(registry);
	if (!pending) reservations.set(registry, (pending = new Map()));
	for (const agent of agents) pending.set(agent.id, agent.parentId);
	return id => {
		pending.delete(id);
	};
}

export function restoringAgentIds(registry: AgentRegistryApi, ownerId?: string): string[] {
	return [...(reservations.get(registry) ?? [])]
		.filter(([, parentId]) => ownerId === undefined || parentId === ownerId)
		.map(([id]) => id);
}
