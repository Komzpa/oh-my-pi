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
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { buildWorkPoolOutputSchema } from "@oh-my-pi/pi-coding-agent/task/workpool-yield";
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
import { createSessionDefaults } from "../helpers/session-defaults";

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

function createHarness(options?: { asyncJobManager?: AsyncJobManager; toolSession?: Partial<ToolSession> }): Harness {
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
		...createSessionDefaults(),
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

	for (const rejectFirst of [false, true]) {
		it(`waits for loaded incremental acceptance before terminal close (reject first=${rejectFirst})`, async () => {
			using root = TempDir.createSync("@omp-incremental-acceptance-");
			const auth = createInMemoryAuthStorage();
			const outputSchema = {
				type: "object",
				properties: { findings: { type: "array", items: { type: "string" } } },
				required: ["findings"],
			};
			const harness = createHarness({ toolSession: { outputSchema } });
			const events = new EventBus();
			const firstInExtension = Promise.withResolvers<void>();
			const lateInExtension = Promise.withResolvers<void>();
			events.on("first-pending", () => firstInExtension.resolve());
			events.on("late-pending", () => lateInExtension.resolve());
			const extensionPath = path.join(root.path(), "delayed-result.ts");
			await Bun.write(
				extensionPath,
				`export default function(pi) {
				const released = Promise.withResolvers();
				const lateReleased = Promise.withResolvers();
				pi.events.on("release-first", () => released.resolve());
				pi.events.on("release-late", () => lateReleased.resolve());
				pi.on("tool_result", async event => {
					if (event.toolCallId === "late") {
						pi.events.emit("late-pending", undefined);
						await lateReleased.promise;
						return;
					}
					if (event.toolCallId !== "first") return;
					pi.events.emit("first-pending", undefined);
					await released.promise;
					return ${rejectFirst} ? { isError: true } : undefined;
				});
			}`,
			);
			const loaded = await loadExtensions([extensionPath], root.path(), events);
			expect(loaded.errors).toEqual([]);
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				root.path(),
				SessionManager.inMemory(root.path()),
				new ModelRegistry(auth),
			);
			const wrapped = new ExtensionToolWrapper(harness.yieldTool, runner);
			vi.spyOn(harness.session, "getToolByName").mockImplementation(name =>
				name === "yield" ? wrapped : undefined,
			);
			mockCreateAgentSession(harness.session);
			registerRunning(harness.session);
			let completedWhileFirstPending = false;
			let completedWhileLatePending = false;
			harness.runBridgedYield = async () => {
				const first = wrapped.execute("first", { type: ["findings"], data: "one" });
				await firstInExtension.promise;
				let terminalSettled = false;
				const terminal = wrapped
					.execute("terminal", { type: "result" })
					.then(result => {
						terminalSettled = true;
						return result;
					})
					.catch(error => ({ isError: true, error }));
				const late = rejectFirst ? undefined : wrapped.execute("late", { type: ["findings"], data: "two" });
				if (late) await lateInExtension.promise;
				try {
					await Bun.sleep(0);
					completedWhileFirstPending = terminalSettled;
				} finally {
					events.emit("release-first", undefined);
				}
				await first;
				await Bun.sleep(0);
				completedWhileLatePending = terminalSettled;
				events.emit("release-late", undefined);
				await late;
				const [firstResult, terminalResult] = await Promise.all([first, terminal]);
				if (rejectFirst) {
					expect(firstResult.isError).toBe(true);
					expect(terminalResult.isError).toBe(true);
					await wrapped.execute("retry-section", { type: ["findings"], data: "corrected" });
					return wrapped.execute("retry-terminal", { type: "result" });
				}
				expect(terminalResult.isError).not.toBe(true);
				return terminalResult;
			};
			try {
				const result = await runSubprocess({
					cwd: root.path(),
					agent: baseAgent,
					task: "collect findings",
					index: 0,
					id: AGENT_ID,
					outputSchema,
				});
				expect(completedWhileFirstPending).toBe(false);
				if (!rejectFirst) expect(completedWhileLatePending).toBe(false);
				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.output)).toEqual({ findings: rejectFirst ? ["corrected"] : ["one", "two"] });
				expect(result.extractedToolData?.yield).toHaveLength(rejectFirst ? 2 : 3);
			} finally {
				events.emit("release-first", undefined);
				events.emit("release-late", undefined);
				events.clear();
				auth.close();
			}
		});
	}

	for (const rejectFirst of [false, true]) {
		it(`waits for wrapped workpool acceptance before completing (reject first=${rejectFirst})`, async () => {
			using root = TempDir.createSync("@omp-workpool-acceptance-");
			const auth = createInMemoryAuthStorage();
			const items = [
				{ id: "review#1", index: 1 },
				{ id: "review#2", index: 2 },
			];
			const harness = createHarness({ toolSession: { getWorkPoolYieldItems: () => items } });
			const runner = new ExtensionRunner(
				[],
				new ExtensionRuntime(),
				root.path(),
				SessionManager.inMemory(root.path()),
				new ModelRegistry(auth),
			);
			const releaseFirst = Promise.withResolvers<void>();
			const firstInExtension = Promise.withResolvers<void>();
			vi.spyOn(runner, "hasHandlers").mockImplementation(event => event === "tool_result");
			vi.spyOn(runner, "emitToolResult").mockImplementation(async event => {
				if (event.toolCallId !== "first") return undefined;
				firstInExtension.resolve();
				await releaseFirst.promise;
				return rejectFirst ? { content: [{ type: "text", text: "revise" }], isError: true } : undefined;
			});
			const wrapped = new ExtensionToolWrapper(harness.yieldTool, runner);
			vi.spyOn(harness.session, "getToolByName").mockImplementation(name =>
				name === "yield" ? wrapped : undefined,
			);
			mockCreateAgentSession(harness.session);
			registerRunning(harness.session);
			let completedWhileFirstPending = false;
			harness.runBridgedYield = async () => {
				const first = wrapped.execute("first", { key: 1, data: "one" });
				await firstInExtension.promise;
				let secondSettled = false;
				const second = wrapped.execute("second", { key: 2, data: "two" }).then(result => {
					secondSettled = true;
					return result;
				});
				try {
					// Let runnable wrapper work finish; the first extension is still gated.
					await Bun.sleep(0);
					completedWhileFirstPending = secondSettled;
				} finally {
					releaseFirst.resolve();
				}
				const [firstResult, secondResult] = await Promise.all([first, second]);
				if (rejectFirst) {
					expect(firstResult.isError).toBe(true);
					expect(secondResult.details?.complete).not.toBe(true);
					return wrapped.execute("retry-first", { key: 1, data: "corrected" });
				}
				expect(secondResult.details?.complete).toBe(true);
				return secondResult;
			};
			try {
				const result = await runSubprocess({
					cwd: root.path(),
					agent: baseAgent,
					task: "process both items",
					index: 0,
					id: AGENT_ID,
					workPoolYieldItems: items,
					outputSchema: buildWorkPoolOutputSchema(items),
				});
				expect(completedWhileFirstPending).toBe(false);
				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.output)).toEqual({
					"review#1": rejectFirst ? "corrected" : "one",
					"review#2": "two",
				});
				expect(result.extractedToolData?.yield).toHaveLength(2);
			} finally {
				releaseFirst.resolve();
				auth.close();
			}
		});
	}

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
			try {
				bridgeValue = await bridgeYield(harness.toolSession, args);
				bridgeAccepted.resolve();
				return bridgeValue;
			} catch (error) {
				bridgeAccepted.reject(error);
				throw error;
			}
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

			const job = manager.getJob(jobId);
			expect(job).toBeDefined();
			// Precondition (passes on baseline): the real tool accepted the
			// bridged terminal submission and its semantic details. Surface
			// actual bridge or earlier job failures instead of leaving this pending.
			await Promise.race([
				bridgeAccepted.promise,
				job!.promise.then(() => {
					throw new Error(job!.errorText ?? "Task settled before the bridged yield was accepted");
				}),
			]);
			expect(bridgeValue).toMatchObject({ details: { status: "success", data: { answer: 42 } } });

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
					asyncJobManager: { getRunningJobs: () => jobs } as never,
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
				// Bun's rejection matcher waits synchronously, so observe the real
				// refusal now and assert it only after releasing the held service IO.
				const oldRefusal = lateYield.then(
					() => undefined,
					(error: unknown) => error,
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
				expect(await oldRefusal).toMatchObject({
					message: expect.stringContaining(scenario === "owner-job" ? "job-1" : "broker unavailable"),
				});

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
