/** Reconnect the session-owned MCP runtime with the same policy as TUI reload. */
import { clearCache as clearFsCache } from "../capability/fs";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { type MCPLoadResult, type MCPManager } from "./manager";
import { cfgMcpEnableProjectConfig } from "./settings";

const pendingReloads = new WeakMap<MCPManager, { session: AgentSession; promise: Promise<MCPLoadResult> }>();

/** Busy is distinct from disposal/ownership failures so a saved config can be honestly deferred. */
export class MCPReloadBusyError extends Error {
	constructor() {
		super("MCP reload requires an idle session");
		this.name = "MCPReloadBusyError";
	}
}

/** Shared preflight for reload and TUI mutations; performs no connection or config changes. */
export function assertMCPReloadAllowed(session: AgentSession, manager?: MCPManager): void {
	if (session.isDisposed) throw new Error("Cannot reload MCP on a disposed session");
	if (session.isStreaming || session.isBashRunning || session.isEvalRunning) throw new MCPReloadBusyError();
	const pending = manager ? pendingReloads.get(manager) : undefined;
	if (pending && pending.session !== session) throw new Error("MCP reload is owned by another session");
}

export function reloadMCPServers(
	session: AgentSession,
	manager: MCPManager,
	settings: Settings,
): Promise<MCPLoadResult> {
	assertMCPReloadAllowed(session, manager);
	const pending = pendingReloads.get(manager);
	if (pending) return pending.promise;
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
