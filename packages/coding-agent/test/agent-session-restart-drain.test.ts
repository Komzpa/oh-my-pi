import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { finalizeSubagentLifecycle } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createRestartQueueController } from "@oh-my-pi/pi-coding-agent/task/restart-queue";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession restart drain", () => {
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let neighbor: AgentSession | undefined;

	beforeAll(async () => {
		fixtureDir = path.join(os.tmpdir(), `pi-restart-drain-fixture-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(fixtureDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all([session?.dispose(), neighbor?.dispose()]);
		session = undefined;
		neighbor = undefined;
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	it("releases native wait on drain without cancelling or consuming its child job", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const manager = new AsyncJobManager({});
		const child = Promise.withResolvers<string>();
		const jobId = manager.register("task", "PendingChild", () => child.promise, { ownerId: "Main" });
		const settings = Settings.isolated({ "launch.enabled": false });
		const toolSession = {
			cwd: fixtureDir,
			settings,
			asyncJobManager: manager,
			getAgentId: () => "Main",
		} as ToolSession;
		const mock = createMockModel({ responses: [] });
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			evalToolSession: toolSession,
		});
		const waiting = new WaitTool(toolSession).execute("wait-for-child", {});
		const lease = session.beginRestartDrain();
		const result = await waiting;
		expect(result.details).toMatchObject({ interrupted: true });
		expect(result.content).toEqual([{ type: "text", text: "Wait interrupted for session restart." }]);
		expect(manager.getRunningJobs({ ownerId: "Main" }).map(job => job.id)).toEqual([jobId]);
		expect(manager.isJobResultConsumed(jobId)).toBe(false);
		await lease.waitForQuiescence();
		lease.release();
		child.resolve("preserved child result");
		await manager.waitForAll();
		const resumed = await new WaitTool(toolSession).execute("wait-after-cancel", {});
		expect(resumed.details?.jobs?.[0]).toMatchObject({ id: jobId, resultText: "preserved child result" });
	});

	it("finishes the current tool batch, checkpoints once, and resumes once on cancel", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const toolStarted = Promise.withResolvers<void>();
		const finishTool = Promise.withResolvers<void>();
		let toolRuns = 0;
		const blockingTool: AgentTool = {
			name: "blocking_tool",
			label: "Blocking Tool",
			description: "Waits for the test to release the current tool effect",
			parameters: type({}),
			execute: async () => {
				toolRuns++;
				toolStarted.resolve();
				await finishTool.promise;
				return { content: [{ type: "text", text: "effect finished" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "restart-drain-call", name: "blocking_tool", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["resumed after cancelled drain"] },
				{ content: ["queued input handled"] },
				{ content: ["post-cancel prompt accepted"] },
			],
		});
		const sessionManager = SessionManager.create(fixtureDir, fixtureDir);
		const rootAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [blockingTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		session = new AgentSession({
			agent: rootAgent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});

		const neighborMock = createMockModel({ responses: [{ content: ["neighbor remains independent"] }] });
		neighbor = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: neighborMock.stream,
				convertToLlm,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		const originalPrompt = session.prompt("Run one side effect");
		await toolStarted.promise;
		const lease = session.beginRestartDrain();
		expect(lease.wasRunning).toBe(true);
		expect(session.isRestartDraining).toBe(true);
		const releaseWait = session.waitForRestartDrainRelease();
		let releaseObserved = false;
		void releaseWait.then(
			() => {
				releaseObserved = true;
			},
			() => {},
		);
		const drained = lease.waitForQuiescence();

		expect(session.isAborting).toBe(false);
		expect(mock.calls).toHaveLength(1);
		await session.prompt("deliver after restart decision");
		expect(sessionManager.isSessionOnDisk()).toBe(true);
		await neighbor.prompt("unrelated session");
		expect(neighborMock.calls).toHaveLength(1);

		finishTool.resolve();
		await drained;
		await originalPrompt;

		expect(mock.calls).toHaveLength(1);
		expect(toolRuns).toBe(1);
		const persistedToolResults = sessionManager
			.getEntries()
			.filter(
				entry =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "restart-drain-call",
			);
		expect(persistedToolResults).toHaveLength(1);
		expect(releaseObserved).toBe(false);
		lease.release();
		await expect(releaseWait).resolves.toBe("released");
		expect(releaseObserved).toBe(true);
		expect(session.isRestartDraining).toBe(false);

		await session.waitForIdle();
		expect(mock.calls).toHaveLength(3);
		expect(
			mock.calls[2]?.context.messages.some(message =>
				JSON.stringify(message).includes("deliver after restart decision"),
			),
		).toBe(true);
		expect(toolRuns).toBe(1);

		await session.prompt("admission reopened after cancel");
		expect(mock.calls).toHaveLength(4);
	});

	it.each(["subagent", "parent"] as const)(
		"settles pending restart-drain waiters on %s disposal without crashing the parent",
		async owner => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const childMock = createMockModel({ responses: [] });
			const parentMock = createMockModel({ responses: [{ content: ["parent still running"] }] });
			const createSession = (streamFn: typeof childMock.stream) =>
				new AgentSession({
					agent: new Agent({
						getApiKey: () => "test-key",
						initialState: { model, systemPrompt: ["Test"], tools: [] },
						streamFn,
						convertToLlm,
					}),
					sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated(),
					modelRegistry,
				});
			session = createSession(childMock.stream);
			neighbor = createSession(parentMock.stream);
			const registry = AgentRegistry.global();
			const id = "drain-dispose-child";
			registry.register({ id, displayName: id, kind: "sub", session });
			const lease = session.beginRestartDrain();
			const outcomes: unknown[] = [];
			// Leave the observer without a rejection handler through teardown: a
			// normal dispose must not create an orphan rejection in the lead.
			const observer = session.waitForRestartDrainRelease().then(outcome => outcomes.push(outcome));
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			try {
				await Promise.resolve();
				expect(outcomes).toEqual([]);
				if (owner === "subagent") {
					await finalizeSubagentLifecycle({
						id,
						session,
						aborted: true,
						abortKind: "shutdown",
						keepAlive: true,
						isolated: false,
						agentIdleTtlMs: 0,
						reviveSession: null,
					});
				} else {
					await session.dispose();
				}
				const nextTurn = Promise.withResolvers<void>();
				setImmediate(() => nextTurn.resolve());
				await nextTurn.promise;
				expect(unhandled).toEqual([]);
				expect(outcomes).toEqual(["disposed"]);
				expect(session.isDisposed).toBe(true);
				lease.release();
				await expect(session.waitForRestartDrainRelease()).resolves.toBe("disposed");
				await neighbor.prompt("continue after child teardown");
				expect(parentMock.calls).toHaveLength(1);
				expect(neighbor.getLastAssistantMessage()?.content).toEqual([
					{ type: "text", text: "parent still running" },
				]);
				expect(childMock.calls).toHaveLength(0);
			} finally {
				await Promise.allSettled([observer]);
				process.off("unhandledRejection", onUnhandled);
				registry.unregister(id);
			}
		},
	);

	it("refuses to drain queued work when a persistent checkpoint is not resumable", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.create(fixtureDir, fixtureDir);
		vi.spyOn(sessionManager, "ensureOnDisk").mockResolvedValue();
		vi.spyOn(sessionManager, "isSessionOnDisk").mockReturnValue(false);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: createMockModel({ responses: [] }).stream,
				convertToLlm,
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "must survive restart" }],
			steering: true,
			timestamp: Date.now(),
		});

		const lease = session.beginRestartDrain();
		try {
			await expect(lease.waitForQuiescence()).rejects.toThrow(
				"the pending queue checkpoint is not resumable on disk",
			);
		} finally {
			lease.release();
		}
	});

	it("does not rewrite restart checkpoints for unchanged timer continuations during a held drain", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const toolStarted = Promise.withResolvers<void>();
		const finishTool = Promise.withResolvers<void>();
		const blockingTool: AgentTool = {
			name: "blocking_tool",
			label: "Blocking Tool",
			description: "Waits so restart drain remains held",
			parameters: type({}),
			execute: async () => {
				toolStarted.resolve();
				await finishTool.promise;
				return { content: [{ type: "text", text: "effect finished" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "restart-held-call", name: "blocking_tool", arguments: {} }],
					stopReason: "toolUse",
				},
			],
		});
		const sessionManager = SessionManager.create(fixtureDir, fixtureDir);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [blockingTool] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const originalPrompt = session.prompt("Run one side effect");
		await toolStarted.promise;
		const identity = { instanceId: "restart-drain-test", sessionId: sessionManager.getSessionId(), generation: 0 };
		const controller = createRestartQueueController({
			session,
			identity: () => identity,
			restart: async () => {},
		});

		await controller.handle({ identity, op: "request", requestId: "held-restart" });
		await session.promptCustomMessage({
			customType: "goal-continuation",
			content: "Continue active goal.",
			display: false,
			attribution: "agent",
		});
		await session.promptCustomMessage({
			customType: "goal-continuation",
			content: "Continue active goal.",
			display: false,
			attribution: "agent",
		});

		expect(
			sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "omp:restart-pending-queues"),
		).toHaveLength(1);
		expect(
			sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom_message" && entry.customType === "restart-queued"),
		).toHaveLength(0);

		controller.dispose();
		finishTool.resolve();
		await originalPrompt.catch(() => {});
	});
});
