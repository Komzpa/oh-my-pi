import { clearCache as clearFsCache } from "../capability/fs";
import type { Settings } from "../config/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AgentSession } from "../session/agent-session";
import type { MCPDiscoverOptions, MCPLoadResult, MCPManager } from "./manager";
import { cfgMcpEnableProjectConfig } from "./settings";
import { resolveMCPTransformContext } from "./transforms";

const pendingReloads = new WeakMap<MCPManager, { session: AgentSession; promise: Promise<MCPLoadResult> }>();

/** The session surface an MCP reconnect rebinds. */
export interface MCPReloadHost {
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void;
	refreshMCPTools(mcpTools: CustomTool[]): Promise<void>;
}

/**
 * Reconnect every configured server of `manager` and rebind `host`'s MCP tools, so
 * config edits (and a cwd the manager was re-pointed at) take effect without a restart.
 */
export async function reconnectMCPServers(
	manager: MCPManager,
	host: MCPReloadHost,
	options: MCPDiscoverOptions,
): Promise<MCPLoadResult> {
	await manager.disconnectAll();
	// Prompt enrichment is asynchronous. Clear commands before rediscovery so
	// removed/disabled servers cannot leave stale `/server:prompt` entries;
	// newly loaded prompts repopulate them through the manager callback.
	host.setMCPPromptCommands([]);
	// External edits to mcp.json (not via writeMCPConfigFile) otherwise
	// keep stale env/command after reload.
	clearFsCache();
	const result = await manager.discoverAndConnect(options);
	await host.refreshMCPTools(manager.getTools());
	return result;
}

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
	// The busy check lives here on purpose: TUI mutations call this preflight BEFORE saving config, so a
	// refused reload never leaves a saved-but-unloaded server (see MCPCommandController).
	if (session.isStreaming || session.isBashRunning || session.isEvalRunning) throw new MCPReloadBusyError();
	const pending = manager ? pendingReloads.get(manager) : undefined;
	if (pending && pending.session !== session) throw new Error("MCP reload is owned by another session");
}

/** Reconnect the session-owned MCP runtime with the same policy as TUI reload. */
export function reloadMCPServers(
	session: AgentSession,
	manager: MCPManager,
	settings: Settings,
): Promise<MCPLoadResult> {
	assertMCPReloadAllowed(session, manager);
	const pending = pendingReloads.get(manager);
	if (pending) return pending.promise;
	const promise = reconnectSessionMCPServers(session, manager, settings);
	pendingReloads.set(manager, { session, promise });
	void promise
		.finally(() => {
			if (pendingReloads.get(manager)?.promise === promise) pendingReloads.delete(manager);
		})
		.catch(() => {});
	return promise;
}

async function reconnectSessionMCPServers(
	session: AgentSession,
	manager: MCPManager,
	settings: Settings,
): Promise<MCPLoadResult> {
	// The session can be disposed while a step runs; each rebind step re-checks so a
	// late reconnect never resurrects capabilities on it or leaves a transport alive.
	const host: MCPReloadHost = {
		setMCPPromptCommands: commands => {
			if (session.isDisposed) throw new Error("Session disposed during MCP reload");
			session.setMCPPromptCommands(commands);
		},
		refreshMCPTools: async mcpTools => {
			if (session.isDisposed) {
				await manager.disconnectAll();
				throw new Error("Session disposed during MCP reload");
			}
			await session.refreshMCPTools(mcpTools);
		},
	};
	return reconnectMCPServers(manager, host, {
		enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
		filterExa: true,
		filterBrowser: session.getEvalPreludes().some(definition => definition.name === "browser"),
		builtinTransforms: resolveMCPTransformContext(settings, {
			evalActive: session.getActiveToolNames().includes("eval"),
		}),
		extensionRoots: session.effectiveExtensionRoots,
	});
}
