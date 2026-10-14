/**
 * PR108 R10/R11: an accepted terminal `yield` from ANY path (direct tool call
 * or eval bridge) ends the monitored run/job with exactly one parent completion
 * (R10); accepted-terminal-once is per continuation/run — a parent continuation
 * gets a fresh slot, a same-run duplicate is rejected (R11). Uses the real eval
 * bridge against the real YieldTool and run monitor; acceptance and delivery are
 * never mocked, and no `tool_execution_end` is manufactured. Direct-path and
 * latch controls live in `executor-result-acceptance.test.ts` and
 * `yield-terminal-once.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as daemonClients from "@oh-my-pi/pi-coding-agent/launch/client";
import * as ownedServices from "@oh-my-pi/pi-coding-agent/launch/services";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	attachIrcWakeTurnMonitor,
	runSubprocess,
	SUBAGENT_WARNING_MISSING_YIELD,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const AGENT_ID = "eval-bridge-yield";
const PARENT_ID = "Parent";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * The eval runtime's real tool-call entry: one `callSessionTool` per bridged
 * `tool.yield(...)` cell call, against the session's real `YieldTool`. This is
 * the path a JS `await tool.yield({...})` / Python `getattr(tool,"yield")` takes
 * (both converge on `callSessionTool`), and it emits no `tool_execution_end`.
 */
async function bridgeYield(toolSession: ToolSession, args: Record<string, unknown>): Promise<unknown> {
	return await callSessionTool("yield", args, { session: toolSession });
}

interface Harness {
	session: AgentSession;
	toolSession: ToolSession;
	yieldTool: YieldTool;
	prompts: string[];
	/** First prompt runs `runBridgedYield`; reminder prompts record the duplicate rejection. */
	runBridgedYield: (args: Record<string, unknown>) => Promise<unknown>;
	wakeObserver: () =>
		| ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
}

function createHarness(options?: {
	asyncJobManager?: AsyncJobManager;
	toolSession?: Partial<ToolSession>;
}): Harness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const prompts: string[] = [];
	let wakeObserver: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;

	// The real YieldTool: one instance shared by the eval bridge and the session
	// surface, so the continuation boundary's `resetYieldTurnState` operates on
	// the same latch the bridge submits against (no invented reset, no bypass).
	const registry: Record<string, YieldTool> = {};
	const toolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		...options?.toolSession,
		getToolByName: (name: string) => registry[name],
	} as unknown as ToolSession;
	const yieldTool = new YieldTool(toolSession);
	registry.yield = yieldTool;

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emitAssistantText = (text: string) => {
		const message = assistantStopMessage(text);
		messages.push(message);
		emit({ type: "message_end", message } as AgentSessionEvent);
	};

	const harness: Harness = {
		session: undefined as never,
		toolSession,
		yieldTool,
		prompts,
		runBridgedYield: args => bridgeYield(toolSession, args),
		wakeObserver: () => wakeObserver,
	};

	const session = {
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		getToolByName: (name: string) => registry[name],
		setActiveToolsByName: async () => {},
		setWorkPoolYieldItems: () => {},
		asyncJobManager: options?.asyncJobManager,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			prompts.push(text);
			if (prompts.length === 1) {
				emitAssistantText("submitting through the eval bridge");
				// The eval cell's `await tool.yield({...})`: accepted by the real
				// tool, no session tool event follows.
				await harness.runBridgedYield({ data: { answer: 42 } });
				return true;
			}
			// Reminder ladder: a re-submit through the bridge hits the tool latch.
			emitAssistantText("reminder seen");
			return true;
		},
		waitForIdle: async () => {},
		isAdvisorActive: () => false,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => messages[messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: (
			observer: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined,
		) => {
			wakeObserver = observer;
		},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
	};
	harness.session = session as unknown as AgentSession;
	return harness;
}

function registerRunning(session: AgentSession) {
	return AgentRegistry.global().register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		parentId: PARENT_ID,
		session,
		status: "running",
	});
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as CreateAgentSessionResult);
}

function wakeMessage(id: string, message: string, from = PARENT_ID): AgentMessage {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: message,
		display: false,
		details: { id, from, message },
		attribution: "agent",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

describe("terminal yield through the eval bridge", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AsyncJobManager.resetForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("an eval-bridged accepted terminal yield ends the job and delivers exactly one parent completion", async () => {
		const harness = createHarness();
		registerRunning(harness.session);
		mockCreateAgentSession(harness.session);

		const delivered: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
			delivered.push(text);
		});

		let runOutput = "";
		let bridgeValue: unknown;
		const bridgeAccepted = Promise.withResolvers<void>();
		harness.runBridgedYield = async args => {
			bridgeValue = await bridgeYield(harness.toolSession, args);
			bridgeAccepted.resolve();
			return bridgeValue;
		};
		try {
			const jobId = manager.register(
				"task",
				AGENT_ID,
				async ({ signal }) => {
					const result = await runSubprocess({
						cwd: "/tmp",
						agent: baseAgent,
						task: "do the work",
						index: 0,
						id: AGENT_ID,
						signal,
					});
					if (result.exitCode !== 0) throw new Error(result.abortReason ?? result.error ?? "Task failed");
					runOutput = result.output;
					return result.output;
				},
				{ ownerId: PARENT_ID },
			);

			// Precondition (passes on baseline): the real tool accepted the
			// bridged terminal submission — "Result submitted." + details.
			await bridgeAccepted.promise;
			expect(JSON.stringify(bridgeValue)).toContain("Result submitted.");

			const job = manager.getJob(jobId);
			expect(job).toBeDefined();
			await job!.promise;
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });

			// EXPECTED FAIL (R10) on 351b5d42: without the acceptance reaching the
			// run monitor the reminder ladder re-prompts instead of settling.
			expect(harness.prompts).toHaveLength(1);
			// EXPECTED FAIL (R10): finalization runs from the accepted yield, not
			// a missing-yield warning.
			expect(runOutput).not.toContain(SUBAGENT_WARNING_MISSING_YIELD);
			expect(runOutput).toContain('"answer": 42');
			// EXPECTED FAIL (R10): exactly one parent completion carrying the payload.
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain('"answer": 42');
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("control: an invalid bridged payload is rejected and delivers no parent completion", async () => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: PARENT_ID,
			session: harness.session,
			status: "idle",
		});
		const delivered: string[] = [];
		manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
			delivered.push(text);
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			const finish = observer([wakeMessage("msg-invalid", "new work", "Other")]);
			// Empty terminal payload: bounces with retryable guidance, not acceptance.
			await expect(bridgeYield(harness.toolSession, {})).rejects.toThrow(
				"yield must contain either `data` or `error`",
			);
			await finish?.(undefined);
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });

			expect(delivered).toHaveLength(0);
			expect(manager.getRunningJobs({ ownerId: PARENT_ID })).toEqual([]);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it.each(["accepted", "unverified", "owner-job"] as const)(
		"a late old-run refusal cannot reopen or spend the %s successor's result slot",
		async scenario => {
			const manager = new AsyncJobManager({});
			const jobs: Array<{ id: string; type: "eval"; startTime: number; label: string }> = [];
			const harness = createHarness({
				asyncJobManager: manager,
				toolSession: {
					requireYieldTool: true,
					getAgentId: () => AGENT_ID,
					asyncJobManager: { getRunningOwnerJobs: () => jobs } as never,
				},
			});
			AgentRegistry.global().register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: PARENT_ID,
				session: harness.session,
				status: "idle",
			});
			const delivered: string[] = [];
			manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
				delivered.push(text);
			});
			const serviceCheckStarted = Promise.withResolvers<void>();
			const oldServices = Promise.withResolvers<{ services: []; error?: string }>();
			vi.spyOn(ownedServices, "hasLiveOwnedService").mockReturnValue(true);
			// The empty/error rosters never describe a service; only service IO is
			// held here. Yield acceptance, monitors and parent delivery remain real.
			vi.spyOn(daemonClients, "daemonClientForProject").mockResolvedValue({} as never);
			const listServices = vi
				.spyOn(ownedServices, "listServicesTolerant")
				.mockImplementationOnce(() => {
					serviceCheckStarted.resolve();
					return oldServices.promise;
				})
				.mockResolvedValue({ services: [] });
			attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
			const observer = harness.wakeObserver();
			if (!observer) throw new Error("wake-turn observer was not registered");

			try {
				const first = observer([wakeMessage("stale-a", "old assignment", "Other")]);
				const lateYield = bridgeYield(harness.toolSession, { data: { report: "old" } });
				const oldRefusal = expect(lateYield).rejects.toThrow(
					scenario === "owner-job" ? "job-1" : "broker unavailable",
				);
				await serviceCheckStarted.promise;
				await first?.(undefined);
				const second = observer([wakeMessage("stale-b", "new assignment")]);
				if (scenario === "accepted") {
					await bridgeYield(harness.toolSession, { data: { report: "current" } });
				} else if (scenario === "owner-job") {
					jobs.push({ id: "job-1", type: "eval", startTime: Date.now(), label: "cell" });
				}
				oldServices.resolve({
					services: [],
					error: scenario === "owner-job" ? undefined : "broker unavailable",
				});
				await oldRefusal;

				if (scenario === "accepted") {
					// The old refusal must not clear the successor's accepted latch.
					await expect(bridgeYield(harness.toolSession, { data: { report: "replacement" } })).rejects.toThrow(
						"already submitted",
					);
				} else {
					// Nor may it spend either kind of first-refusal warning for B.
					if (scenario === "unverified") {
						listServices.mockResolvedValue({ services: [], error: "broker unavailable" });
					}
					await expect(bridgeYield(harness.toolSession, { data: { report: "current" } })).rejects.toThrow(
						scenario === "owner-job" ? "job-1" : "broker unavailable",
					);
					listServices.mockResolvedValue({ services: [] });
					await bridgeYield(harness.toolSession, { data: { report: "current" } });
				}
				await second?.(undefined);
				await manager.waitForAll();
				await manager.drainDeliveries({ timeoutMs: 1000 });
				expect(delivered).toHaveLength(1);
				expect(delivered[0]).toContain('"report": "current"');
				expect(delivered[0]).not.toContain('"report": "old"');
			} finally {
				oldServices.resolve({ services: [], error: "broker unavailable" });
				await manager.dispose({ timeoutMs: 1000 });
			}
		},
	);

	it("R11: a parent continuation gets a fresh result slot; a same-run duplicate is rejected", async () => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: PARENT_ID,
			session: harness.session,
			status: "idle",
		});
		const delivered: string[] = [];
		manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
			delivered.push(text);
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			// Monitored run 1: the worker's first (partial) terminal yield, through
			// the real eval bridge.
			const first = observer([wakeMessage("msg-1", "first assignment")]);
			await bridgeYield(harness.toolSession, { data: { report: "partial" } });
			// Same monitored run: a duplicate terminal yield must be rejected by the
			// real one-shot latch (control, passes on baseline).
			await expect(bridgeYield(harness.toolSession, { data: { report: "partial-again" } })).rejects.toThrow(
				"already submitted",
			);
			// Acceptance registers the owner job before the ref goes idle.
			expect(manager.getRunningJobs({ ownerId: PARENT_ID }).map(job => job.agentId)).toEqual([AGENT_ID]);
			await first?.(undefined);
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });

			// Monitored run 2: the parent's NEW work — the actual continuation
			// boundary (the wake observer re-arms the real tool's latch; no reset is
			// invented here). A fresh terminal yield must be accepted and delivered.
			const second = observer([wakeMessage("msg-2", "follow-up work")]);
			await bridgeYield(harness.toolSession, { data: { report: "final" } });
			await second?.(undefined);
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });

			// EXPECTED FAIL (R11) on 351b5d42: without acceptance reaching the
			// monitor, no owner job registers and the parent receives nothing —
			// not even the continuation's final result.
			expect(delivered).toHaveLength(2);
			expect(delivered[0]).toContain('"report": "partial"');
			expect(delivered[1]).toContain('"report": "final"');
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
});
