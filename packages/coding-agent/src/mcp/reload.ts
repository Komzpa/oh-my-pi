/** Reconnect the session-owned MCP runtime with the same policy as TUI reload. */
import { clearCache as clearFsCache } from "../capability/fs";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { type MCPLoadResult, type MCPManager } from "./manager";
import { cfgMcpEnableProjectConfig } from "./settings";

const pendingReloads = new WeakMap<MCPManager, { session: AgentSession; promise: Promise<MCPLoadResult> }>();

export function reloadMCPServers(
	session: AgentSession,
	manager: MCPManager,
	settings: Settings,
): Promise<MCPLoadResult> {
	if (session.isDisposed) throw new Error("Cannot reload MCP on a disposed session");
	if (session.isStreaming || session.isBashRunning || session.isEvalRunning)
		throw new Error("MCP reload requires an idle session");
	const pending = pendingReloads.get(manager);
	if (pending) {
		if (pending.session !== session) throw new Error("MCP reload is owned by another session");
		return pending.promise;
	}
	const promise = reconnectMCPServers(session, manager, settings);
	pendingReloads.set(manager, { session, promise });
	void promise
		.finally(() => {
			if (pendingReloads.get(manager)?.promise === promise) pendingReloads.delete(manager);
		})
		.catch(() => {});
	return promise;
}

async function reconnectMCPServers(
	session: AgentSession,
	manager: MCPManager,
	settings: Settings,
): Promise<MCPLoadResult> {
	await manager.disconnectAll();
	if (session.isDisposed) throw new Error("Session disposed during MCP reload");
	session.setMCPPromptCommands([]);
	clearFsCache();
	const result = await manager.discoverAndConnect({
		enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
		filterExa: true,
		filterBrowser: session.getEvalPreludes().some(definition => definition.name === "browser"),
		extensionRoots: session.effectiveExtensionRoots,
	});
	// Discovery can finish after session disposal. Drain late transports instead
	// of leaving a subprocess alive or resurrecting capabilities on that session.
	if (session.isDisposed) {
		await manager.disconnectAll();
		throw new Error("Session disposed during MCP reload");
	}
	await session.refreshMCPTools(manager.getTools());
	return result;
}
