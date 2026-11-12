import * as path from "node:path";
import { type AgentRegistryApi, MAIN_AGENT_ID } from "./agent-registry";
import { isAgentSessionFileInRootTree } from "./persisted-agents";

/**
 * A live nested parent already completed roster restoration before attachment.
 * Reuse its root and the shared id-indexed registry: isolate-local scan latches
 * do not cross worker links, and walking the tree through a registry proxy
 * performs synchronous RPC for every transcript. Explicit restoration and IRC
 * lookup of an evicted id still use ensurePersistedRoster.
 */
export function resolveSubagentLaunchRoster(
	registry: AgentRegistryApi,
	sessionFileHint?: string | null,
	parentAgentId?: string,
): string | undefined {
	if (parentAgentId && parentAgentId !== MAIN_AGENT_ID && sessionFileHint) {
		const parent = registry.get(parentAgentId);
		const main = registry.get(MAIN_AGENT_ID);
		const parentFile = parent?.session?.sessionManager.getSessionFile();
		const rootFile = main?.session?.sessionManager.getSessionFile();
		if (
			parentFile &&
			rootFile &&
			isAgentSessionFileInRootTree(parentFile, rootFile) &&
			isAgentSessionFileInRootTree(sessionFileHint, parentFile)
		)
			return path.resolve(rootFile);
	}
	return undefined;
}
