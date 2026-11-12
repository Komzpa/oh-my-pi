import { MessagePort, parentPort } from "node:worker_threads";
import "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionContext, ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isThreadId, setCurrentThreadId } from "@oh-my-pi/pi-coding-agent/thread/identity";
import type {
	SubagentWorkerInit,
	SubagentWorkerReady,
	WorkerThreadLink,
} from "@oh-my-pi/pi-coding-agent/thread/protocol";
import { type RpcFrame, RpcLink } from "@oh-my-pi/pi-coding-agent/thread/rpc";
import type { ThreadService } from "@oh-my-pi/pi-coding-agent/thread/services";
import { agentsThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/agents";
import { identityThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/identity";
import { requestResourceScope } from "../agent_router";
import { workerToolPreflight } from "../dispatch_preflight";

export interface ScopeProbe {
	open(cwd: string): Promise<void>;
	request(
		paths: string[],
	): Promise<{ status: string; action?: { op: string; updates: Array<{ task: string; resources: string[] }> } }>;
	write(path: string): Promise<{ blocked: boolean; reason?: string }>;
}
export interface ScopeProbeGlobals {
	ready(probe: ScopeProbe): void;
}

const port = parentPort;
if (!port) throw new Error("scope fixture must run in a worker");
let ctx: ExtensionContext;
const probe: ScopeProbe = {
	open: async cwd => {
		const registry = AgentRegistry.global();
		const runtime = { flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime;
		const runner = new ExtensionRunner(
			[],
			runtime,
			cwd,
			SessionManager.inMemory(cwd),
			{} as ModelRegistry,
			undefined,
			undefined,
			undefined,
			undefined,
			{ kind: "sub", id: "Reusable-20", name: "coder", depth: 1, parentId: "ScopeLead" },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			registry,
		);
		ctx = runner.createContext();
		// Runtime-loaded extension graphs may have their own module-local singleton.
		// Keep the actual host proxy in the context; the fallback deliberately has no lead.
		AgentRegistry.installGlobal(new AgentRegistry());
	},
	request: async paths => requestResourceScope(ctx, paths),
	write: async target => {
		const refusal = await workerToolPreflight({ toolName: "write", input: { path: target } }, ctx);
		if (refusal) return { blocked: true, reason: refusal.reason };
		await Bun.write(target, "scope-bridge-receipt\n");
		return { blocked: false };
	},
};
const probeService: ThreadService = {
	name: "scope-probe",
	boot(globals) {
		if (!globals || typeof globals !== "object" || typeof Reflect.get(globals, "ready") !== "function")
			throw new Error("scope probe globals missing");
		(globals as ScopeProbeGlobals).ready(probe);
	},
};
const services: readonly ThreadService[] = [identityThreadService, agentsThreadService, probeService];
function isInit(value: unknown): value is SubagentWorkerInit {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-init" &&
		isThreadId(Reflect.get(value, "threadId")) &&
		Reflect.get(value, "replyPort") instanceof MessagePort &&
		Reflect.get(value, "counter") instanceof SharedArrayBuffer
	);
}
function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}
let frameHandler: ((frame: RpcFrame) => void) | undefined;
port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (!isInit(message)) return;
		setCurrentThreadId(message.threadId);
		const link: WorkerThreadLink = new RpcLink(
			{
				send: frame => port.postMessage(frame),
				listen: handler => {
					frameHandler = handler;
					return () => {
						frameHandler = undefined;
					};
				},
			},
			{
				name: `${message.threadId}↔scope-test`,
				sync: { port: message.replyPort, counter: new Int32Array(message.counter) },
			},
		);
		for (const service of services) service.installWorker?.(link);
		link.handle("boot", async globals => {
			for (const service of services) await service.boot?.(globals[service.name], link);
		});
		link.handle("ping", nonce => nonce);
		const ready: SubagentWorkerReady = { type: "subagent-worker-ready" };
		port.postMessage(ready);
		return;
	}
	if (isFrame(message)) frameHandler(message);
});
