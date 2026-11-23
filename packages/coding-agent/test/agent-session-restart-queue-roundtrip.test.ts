import { sendRootContinuationOnce } from "../src/task/restart-recovery";
import restartQueuedPrompt from "../src/prompts/restart-queued.md" with { type: "text" };
import { currentRuntimeIdentity } from "../src/session/runtime-identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { IrcBridge } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createMockModel, type MockResponse, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { ExtensionUIContext, ExtensionFormDialogResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createRestartQueueController } from "@oh-my-pi/pi-coding-agent/task/restart-queue";

describe("AgentSession restart queue round trip", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager | undefined;
	let session: AgentSession | undefined;
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in model");

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-restart-queue-roundtrip-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		vi.useRealTimers();
		try {
			await session?.dispose();
		} finally {
			if (!session) await sessionManager?.close();
			authStorage?.close();
			await tempDir?.remove();
			session = undefined;
			sessionManager = undefined;
		}
	});

	function currentManager(): SessionManager {
		if (!sessionManager) throw new Error("Expected a session manager");
		return sessionManager;
	}

	function createSession(
		manager: SessionManager,
		responses: MockResponseSource = [],
		modelInputs?: string[],
		tools: AgentTool[] = [],
		asyncJobManager?: AsyncJobManager,
		transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>,
	): AgentSession {
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: manager.buildSessionContext().messages,
			},
			convertToLlm: messages => activeSession.convertMessagesToLlm(messages),
			streamFn: (model, context, options) => {
				modelInputs?.push(JSON.stringify(context.messages));
				return mock.stream(model, context, options);
			},
		});
		const activeSession = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			asyncJobManager,
			modelRegistry,
			transformContext,
		});
		return activeSession;
	}

	function appendPriorAssistant(manager: SessionManager): void {
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "prior answer" }],
			timestamp: Date.now(),
			stopReason: "stop",
		} as Parameters<SessionManager["appendMessage"]>[0]);
	}

	function hiddenNextTurnMessage(content: string): Extract<AgentMessage, { role: "custom" }> {
		return {
			role: "custom",
			customType: "restart-roundtrip-hidden",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async function checkpointHiddenMessagesForRestart(
		messages: Extract<AgentMessage, { role: "custom" }>[],
	): Promise<string> {
		const manager = sessionManager;
		if (!manager) throw new Error("Expected a session manager");
		appendPriorAssistant(manager);
		const activeSession = createSession(manager);
		session = activeSession;
		const lease = activeSession.beginRestartDrain();
		for (const message of messages) activeSession.queueDeferredMessage(message);
		await lease.waitForQuiescence();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile || !manager.isSessionOnDisk()) throw new Error("Expected a durable restart checkpoint");
		await activeSession.dispose();
		session = undefined;
		sessionManager = undefined;
		return sessionFile;
	}

	function countCustomMessageEntries(manager: SessionManager, customType: string): number {
		return manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === customType)
			.length;
	}

	function restartQueueCheckpoints(manager: SessionManager) {
		// Compare the persisted JSON shape: demand-loaded entries may be mutation-tracking proxies,
		// which bun's structural matchers do not treat as plain arrays and objects.
		return manager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:restart-pending-queues")
			.map(entry => JSON.parse(JSON.stringify(entry)) as typeof entry);
	}

	async function reopenSession(
		sessionFile: string,
		responses: MockResponse[] = [],
		modelInputs?: string[],
	): Promise<AgentSession> {
		sessionManager = await SessionManager.open(sessionFile, tempDir.path(), undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		session = createSession(sessionManager, responses, modelInputs);
		return session;
	}

	it.each([false, true])(
		"automatically delivers drain peer input behind a runtime tail once across two restarts (restore held: %s)",
		async holdRestore => {
			const manager = currentManager();
			appendPriorAssistant(manager);
			manager.appendCustomMessageEntry("runtime-status", "restart status", false);
			session = createSession(manager);
			const lease = session.beginRestartDrain();
			await session.deliverIrcMessage({
				id: "drain-peer",
				from: "peer",
				to: MAIN_AGENT_ID,
				body: "CORRECTION during drain",
				ts: Date.now(),
			});
			await lease.waitForQuiescence();
			const file = manager.getSessionFile()!;
			await session.dispose();
			session = undefined;
			sessionManager = undefined;
			const inputs: string[] = [];
			const restored = await reopenSession(file, [{ content: ["received"] }], inputs);
			if (holdRestore) {
				const restoreLease = restored.beginRestartDrain();
				await restored.waitForIdle();
				restoreLease.release();
			}
			await restored.waitForIdle();
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toContain("CORRECTION during drain");
			expect(countCustomMessageEntries(currentManager(), "irc:incoming")).toBe(1);
			const secondLease = restored.beginRestartDrain();
			await secondLease.waitForQuiescence();
			await restored.dispose();
			session = undefined;
			sessionManager = undefined;
			const secondInputs: string[] = [];
			const second = await reopenSession(file, [], secondInputs);
			await second.waitForIdle();
			expect(secondInputs).toHaveLength(0);
			expect(countCustomMessageEntries(currentManager(), "irc:incoming")).toBe(1);
			expect(second.agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("delivers captured steering, follow-ups and deferred asks in queue order without truncation", async () => {
		appendPriorAssistant(currentManager());
		session = createSession(currentManager());
		const lease = session.beginRestartDrain();
		session.agent.steer({ role: "user", content: "saved steer", timestamp: 1 });
		session.agent.followUp({ role: "user", content: "saved follow-up", timestamp: 2 });
		for (let i = 0; i < 40; i++)
			session.queueDeferredMessage({
				...hiddenNextTurnMessage(`saved ask ${i}`),
				customType: `saved-ask-${i}`,
				display: true,
			});
		await lease.waitForQuiescence();
		const file = currentManager().getSessionFile()!;
		await session.dispose();
		session = undefined;
		sessionManager = undefined;
		const inputs: string[] = [];
		const restored = await reopenSession(
			file,
			[{ content: ["steer received"] }, { content: ["follow-up received"] }, { content: ["asks received"] }],
			inputs,
		);
		await restored.waitForIdle();
		const messages = currentManager().buildSessionContext().messages;
		const delivered = messages.flatMap(message =>
			message.role === "user"
				? [message.content]
				: message.role === "custom" && message.customType.startsWith("saved-ask-")
					? [message.content]
					: [],
		);
		expect(delivered).toEqual([
			"saved steer",
			"saved follow-up",
			...Array.from({ length: 40 }, (_, i) => `saved ask ${i}`),
		]);
		expect(restartQueueCheckpoints(currentManager()).at(-1)).toMatchObject({
			data: { steering: [], followUp: [], pendingNextTurn: [] },
		});
	});

	it("surfaces an unreadable checkpoint as a visible notice and retains its journal entry", async () => {
		appendPriorAssistant(currentManager());
		currentManager().appendCustomEntry("omp:restart-pending-queues", {
			steering: [],
			followUp: [null],
			pendingNextTurn: [],
		});
		session = createSession(currentManager());
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "restart-restore") notices.push(event.message);
		});
		await session.waitForIdle();
		expect(notices).toEqual([expect.stringContaining("could not be restored")]);
		expect(restartQueueCheckpoints(currentManager()).at(-1)).toMatchObject({ data: { followUp: [null] } });
	});

	it("persists peer and advisory skips with interleaved deferred queue delivery by append only", async () => {
		const manager = currentManager();
		appendPriorAssistant(manager);
		let peerPending = false;
		let executed = 0;
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Interruptible wait",
			parameters: type({}),
			interruptible: true,
			concurrency: "exclusive",
			execute: async (_id, _args, signal) => {
				executed++;
				const aborted = Promise.withResolvers<never>();
				signal?.addEventListener("abort", () => aborted.reject(new Error("interrupted wait")), { once: true });
				return Promise.race([
					aborted.promise,
					Bun.sleep(2000).then(() => {
						throw new Error("interrupt did not arrive");
					}),
				]);
			},
		};
		const notes: AgentTool = {
			name: "context_notes",
			label: "Notes",
			description: "Save context notes",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "Context notes saved." }], details: {} }),
		};
		// Recorded 02:50:40-41 order: assistant wait -> peer skip -> second
		// assistant context_notes+wait -> saved notes -> advisory skip.
		session = createSession(
			manager,
			[
				() => {
					peerPending = true;
					return {
						content: [{ type: "toolCall", id: "peer-skip", name: "wait", arguments: {} }],
					};
				},
				() => {
					peerPending = false;
					session!.agent.steer({
						...hiddenNextTurnMessage("requirements"),
						customType: "requirements-gate-notice",
					});
					return {
						content: [
							{ type: "toolCall", id: "notes", name: "context_notes", arguments: {} },
							{ type: "toolCall", id: "advisory-skip", name: "wait", arguments: {} },
						],
					};
				},
				{ content: ["continued"], stopReason: "stop" },
			],
			undefined,
			[wait, notes],
		);
		const active = session;
		const interruptPeek = vi.spyOn(IrcBridge.prototype, "hasInterrupts").mockImplementation(() => peerPending);
		const lease = active.beginRestartDrain();
		active.queueDeferredMessage({
			...hiddenNextTurnMessage("deadline"),
			customType: "goal-deadline-time-note",
			timestamp: 1794020058033,
		});
		await lease.waitForQuiescence();
		lease.release();
		const file = manager.getSessionFile()!;
		const prefix = await Bun.file(file).text();
		const atomicWrites = vi.spyOn(FileSessionStorage.prototype, "writeLinesAtomic");
		const syncWrites = vi.spyOn(FileSessionStorage.prototype, "writeLinesSync");
		try {
			await active.prompt("continue live entry mix");
			await active.settleInFlightMessagePersistence();
			await manager.flush();
			expect(executed).toBe(0);
			const results = manager
				.getEntries()
				.flatMap(entry => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
			expect(results.map(result => result.toolCallId)).toEqual(["peer-skip", "notes", "advisory-skip"]);
			expect(results[0].content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("pending peer interrupt") }),
			]);
			expect(results[0]).toMatchObject({ details: { __synthetic: true, executed: false } });
			expect(results[1]).toMatchObject({
				isError: false,
				content: [{ type: "text", text: "Context notes saved." }],
			});
			expect(results[2].content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("pending system advisory") }),
			]);
			expect(atomicWrites).not.toHaveBeenCalled();
			expect(syncWrites).not.toHaveBeenCalled();
			expect((await Bun.file(file).text()).startsWith(prefix)).toBe(true);
			expect(countCustomMessageEntries(manager, "goal-deadline-time-note")).toBe(1);
			expect(countCustomMessageEntries(manager, "requirements-gate-notice")).toBe(1);
		} finally {
			atomicWrites.mockRestore();
			syncWrites.mockRestore();
			interruptPeek.mockRestore();
		}
		await active.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopened = await reopenSession(file);
		expect(countCustomMessageEntries(reopened.sessionManager, "goal-deadline-time-note")).toBe(1);
		expect(countCustomMessageEntries(reopened.sessionManager, "requirements-gate-notice")).toBe(1);
	});

	it("wakes a restored idle root within one second with owner input first despite background work", async () => {
		appendPriorAssistant(currentManager());
		session = createSession(currentManager());
		const lease = session.beginRestartDrain();
		session.agent.steer({ role: "user", content: "owner after restart", timestamp: Date.now() });
		await lease.waitForQuiescence();
		const file = currentManager().getSessionFile()!;
		await session.dispose();
		session = undefined;
		sessionManager = await SessionManager.open(file, tempDir.path());
		const jobs = new AsyncJobManager({});
		const background = Promise.withResolvers<string>();
		jobs.register("bash", "background worker", () => background.promise, { ownerId: "Main" });
		jobs.registerDeliverySink("Main", () => {});
		const inputs: string[] = [];
		try {
			session = createSession(currentManager(), [{ content: ["received"] }], inputs, [], jobs);
			const start = Date.now();
			while (inputs.length === 0 && Date.now() - start < 950) await Bun.sleep(5);
			expect(inputs).toHaveLength(1);
			expect(session.hasPendingAsyncWork()).toBe(true);
			expect(JSON.parse(inputs[0])[1]).toMatchObject({ role: "user", content: "owner after restart" });
			await session.waitForIdle();
		} finally {
			background.resolve("done");
			await jobs.waitForAll();
		}
	});

	it("injects steering behind a runtime notice before an independently started turn's first call", async () => {
		appendPriorAssistant(currentManager());
		currentManager().appendCustomEntry("omp:restart-pending-queues", {
			steering: [
				{ ...hiddenNextTurnMessage("runtime status"), customType: "runtime-status" },
				{ role: "user", content: "owner must be seen first", timestamp: Date.now() },
				{ role: "user", content: "second owner input", timestamp: Date.now() },
			],
			followUp: [],
			pendingNextTurn: [],
		});
		const inputs: string[] = [];
		session = createSession(currentManager(), [{ content: ["received"] }, { content: ["second received"] }], inputs);
		await session.promptCustomMessage({ customType: "todo-plan-check", content: "all rows WAIT", display: false });
		await session.waitForIdle();
		expect(inputs[0]).toContain("owner must be seen first");
		expect(inputs[0]).not.toContain("second owner input");
		expect(inputs[1]).toContain("second owner input");
		expect(
			currentManager()
				.getEntries()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
				),
		).toEqual(["owner must be seen first", "second owner input"]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("preserves every captured input while bounding newly queued hidden runtime backlog", async () => {
		const backlog = Array.from({ length: 251 }, (_, i) => hiddenNextTurnMessage(`old gate ${i}`));
		const owner = { ...hiddenNextTurnMessage("owner instruction"), attribution: "user" as const };
		appendPriorAssistant(currentManager());
		currentManager().appendCustomEntry("omp:restart-pending-queues", {
			steering: [],
			followUp: [],
			pendingNextTurn: [owner, ...backlog],
		});
		const inputs: string[] = [];
		session = createSession(currentManager(), [{ content: ["received"] }], inputs);
		const lease = session.beginRestartDrain();
		const restoredCheckpoint = restartQueueCheckpoints(currentManager()).at(-1);
		const restoredData = (restoredCheckpoint?.type === "custom" ? restoredCheckpoint.data : undefined) as {
			pendingNextTurn: AgentMessage[];
		};
		expect(restoredData.pendingNextTurn).toHaveLength(252);
		for (let i = 0; i < 251; i++) session.queueDeferredMessage(hiddenNextTurnMessage(`new gate ${i}`));
		await lease.waitForQuiescence();
		const checkpoint = restartQueueCheckpoints(currentManager()).at(-1);
		const pending = (checkpoint?.type === "custom" ? checkpoint.data : undefined) as {
			pendingNextTurn: AgentMessage[];
		};
		expect(pending.pendingNextTurn).toHaveLength(284);
		expect(pending.pendingNextTurn[0]).toMatchObject(owner);
		lease.release();
		await session.waitForIdle();
		await session.prompt("consume backlog");
		expect(inputs[0]).toContain("owner instruction");
		expect(inputs.join("\n")).toContain("new gate 250");
		expect(inputs[0]).toContain("old gate 0");
		expect(inputs.join("\n")).not.toContain("new gate 0");
	});

	it.each(["steering", "followUp"] as const)(
		"cancels a restored %s drain without a role error and delivers it on retry",
		async queue => {
			const manager = currentManager();
			manager.appendMessage({ role: "user", content: "prior task", timestamp: Date.now() - 1 });
			appendPriorAssistant(manager);
			session = createSession(manager);
			const lease = session.beginRestartDrain();
			const queued: AgentMessage = { role: "user", content: "survive cancelled drain", timestamp: Date.now() };
			if (queue === "steering") session.agent.steer(queued);
			else session.agent.followUp(queued);
			await lease.waitForQuiescence();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected checkpoint file");
			await session.dispose();
			session = undefined;
			sessionManager = undefined;
			const inputs: string[] = [];
			const restored = await reopenSession(file, [{ content: ["received"] }], inputs);
			const controller = new AbortController();
			const detach = restored.agent.addBeforeQueuedMessageDequeueHook(() => controller.abort());
			try {
				await expect(restored.agent.continue(controller.signal)).resolves.toBeUndefined();
				expect(restored.agent.state.isStreaming).toBe(false);
				expect(inputs).toEqual([]);
				expect(restored.agent.snapshotPendingQueues()[queue]).toEqual([queued]);
			} finally {
				detach();
			}
			await restored.agent.continue();
			await restored.waitForIdle();
			await currentManager().flush();
			expect(inputs).toHaveLength(1);
			expect(restored.agent.hasQueuedMessages()).toBe(false);
			expect(inputs[0]).toContain("survive cancelled drain");
			expect(
				currentManager()
					.getEntries()
					.filter(e => e.type === "message" && e.message.role === "user" && e.message.content === queued.content),
			).toHaveLength(1);
		},
	);

	it.each(["completed", "failed", "cancelled"])("does not replay queued notices after a %s restart", async state => {
		const manager = currentManager();
		appendPriorAssistant(manager);
		const notice = (requestId: string, noticeState: string) => ({
			role: "custom" as const,
			customType: "restart-queued",
			content: `Restart ${requestId} is ${noticeState}.`,
			display: true,
			details: { requestId, state: noticeState },
			timestamp: Date.now(),
		});
		const stale = notice("old-request", "queued");
		const active = notice("live-request", "queued");
		const input: AgentMessage = { role: "user", content: "preserve actual input", timestamp: Date.now() };
		manager.appendCustomEntry("omp:restart-pending-queues", {
			steering: [stale, input],
			followUp: [stale, input],
			pendingNextTurn: [stale],
		});
		manager.appendCustomEntry("restart_request_transition", { record: { requestId: "old-request", state } });
		manager.appendCustomMessageEntry("restart-queued", notice("old-request", state).content, true, {
			requestId: "old-request",
			state,
		});
		// The most recent snapshot can itself still contain obsolete notices.
		manager.appendCustomEntry("omp:restart-pending-queues", {
			steering: [stale, input],
			followUp: [stale, input, active],
			pendingNextTurn: [stale, active],
		});
		manager.appendCustomEntry("restart_request_transition", {
			record: { requestId: "live-request", state: "queued" },
		});
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await manager.close();
		sessionManager = undefined;
		const restored = await reopenSession(file);
		expect(restored.agent.peekSteeringQueue()).toEqual([input]);
		expect(restored.agent.peekFollowUpQueue()).toEqual([input, active]);
		// Recheckpoint inspects the private next-turn queue through its durable owner.
		const lease = restored.beginRestartDrain();
		await lease.waitForQuiescence();
		const checkpoint = restartQueueCheckpoints(currentManager()).at(-1);
		expect(checkpoint?.type === "custom" ? checkpoint.data : undefined).toMatchObject({ pendingNextTurn: [active] });
		lease.release();
	});

	it.each([false, true])(
		"persists completion before delivery and removes captured queued notices (busy: %s)",
		async busy => {
			const manager = currentManager();
			appendPriorAssistant(manager);
			const requestId = "claude-dc-1920-batch3";
			const stale = {
				...hiddenNextTurnMessage(`Restart ${requestId} is queued. ${restartQueuedPrompt.trim()}`),
				customType: "restart-queued",
				details: { requestId, state: "queued" },
			};
			manager.appendCustomMessageEntry(stale.customType, stale.content, true, stale.details);
			const unrelated = hiddenNextTurnMessage("preserve unrelated worker result");
			manager.appendCustomEntry("omp:restart-pending-queues", {
				steering: [stale, unrelated],
				followUp: [stale],
				pendingNextTurn: [stale],
			});
			const transition = (state: string) =>
				manager.appendCustomEntry("restart_request_transition", {
					version: 1,
					identity: { instanceId: "after", sessionId: manager.getSessionId(), generation: 1 },
					record: { requestId, state },
				});
			transition("queued");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const inputs: string[] = [];
			let captured = false;
			session = createSession(
				manager,
				Array.from({ length: 6 }, () => ({ content: ["ready"] })),
				inputs,
				[],
				undefined,
				async messages => {
					if (busy && !captured) {
						captured = true;
						entered.resolve();
						await release.promise;
					}
					return messages;
				},
			);
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			AgentRegistry.global().register({
				id: MAIN_AGENT_ID,
				displayName: "Root",
				kind: "main",
				session,
				status: "idle",
			});
			let active: Promise<boolean> | undefined;
			try {
				if (busy) {
					active = session.prompt("finish active batch");
					await entered.promise;
				}
				transition("completed");
				expect(await sendRootContinuationOnce(session, requestId)).toEqual({ state: "delivered" });
				const entries = manager.getEntries();
				const wake = entries.findIndex(
					entry => entry.type === "custom_message" && entry.customType === "restart-root-continuation",
				);
				const delivered = entries.findIndex(
					entry =>
						entry.type === "custom" &&
						entry.customType === "root_restart_continuation_receipt" &&
						(entry.data as { outcome: string }).outcome === "continuation-delivered",
				);
				expect(wake).toBeGreaterThan(-1);
				expect(delivered).toBeGreaterThan(wake);
				expect(await Bun.file(manager.getSessionFile()!).text()).toContain(`Restart ${requestId} completed`);
				expect(
					session.agent.state.messages.some(
						message => message.role === "custom" && message.customType === "restart-root-continuation",
					),
				).toBe(true);
			} finally {
				release.resolve();
				await active;
				await session.waitForIdle();
			}
			expect(inputs.join("\n")).not.toContain(stale.content);
			expect(inputs.join("\n")).toContain("preserve unrelated worker result");
			expect(inputs.at(-1)).toContain(`Restart ${requestId} completed`);
			expect(await sendRootContinuationOnce(session, requestId)).toEqual({ state: "already-delivered" });
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		},
	);

	it.each([false, true])(
		"wakes a completed root once after retiring its checkpoint request (running: %s)",
		async rootWasRunning => {
			// DC 14:44:46Z snapshot: seven custom follow-ups and four next-turn inputs,
			// including a queued checkpoint request; completion preceded child revival.
			const manager = currentManager();
			appendPriorAssistant(manager);
			const sessionId = manager.getSessionId();
			const requestId = "claude-dc-1845-calibfix-editgrant-roster";
			const stale = {
				role: "custom" as const,
				customType: "restart-queued",
				content: `Restart ${requestId} is queued. ${restartQueuedPrompt.trim()}`,
				display: true,
				details: { requestId, state: "queued" },
				timestamp: Date.now(),
			};
			manager.appendCustomMessageEntry(stale.customType, stale.content, true, stale.details);
			manager.appendCustomEntry("omp:restart-pending-queues", {
				steering: [stale],
				followUp: [
					stale,
					...Array.from({ length: rootWasRunning ? 7 : 0 }, (_, i) =>
						hiddenNextTurnMessage(`preserved worker result ${i}`),
					),
				],
				pendingNextTurn: rootWasRunning
					? [
							hiddenNextTurnMessage("preserved user reply obligation"),
							hiddenNextTurnMessage("preserved schedule"),
							stale,
							hiddenNextTurnMessage("preserved staffing"),
						]
					: [stale],
			});
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "before", sessionId, generation: 0 },
				record: {
					version: 1,
					requestId,
					sessionId,
					state: "completed",
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning,
				},
			});
			await manager.ensureOnDisk();
			const file = manager.getSessionFile()!;
			await manager.close();
			sessionManager = undefined;
			const inputs: string[] = [];
			const restored = await reopenSession(
				file,
				Array.from({ length: 12 }, () => ({ content: ["resume ready work"], stopReason: "stop" as const })),
				inputs,
			);
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			AgentRegistry.global().register({
				id: MAIN_AGENT_ID,
				displayName: "Root",
				kind: "main",
				session: restored,
				sessionFile: file,
				status: "idle",
			});
			const options = {
				session: restored,
				identity: () => ({ instanceId: "after", sessionId, generation: 1 }),
				restart: async () => {},
			};
			const controller = createRestartQueueController(options);
			try {
				await controller.restore();
				await restored.waitForIrcReplies();
				await restored.waitForIdle();
				const providerInput = inputs.join("\n");
				expect(providerInput).not.toContain(stale.content);
				for (let i = 0; i < (rootWasRunning ? 7 : 0); i++)
					expect(providerInput).toContain(`preserved worker result ${i}`);
				if (rootWasRunning) expect(providerInput).toContain("preserved user reply obligation");
				expect(providerInput).toContain(`Restart ${requestId} completed`);
				// A build without git metadata names itself by its binary hash instead.
				const commit = currentRuntimeIdentity().commit;
				expect(providerInput).toContain(commit ? `build ${commit}` : "; build ");
				const delivered = () =>
					restored.sessionManager
						.getEntries()
						.filter(
							entry =>
								entry.type === "custom" &&
								entry.customType === "root_restart_continuation_receipt" &&
								(entry.data as { outcome?: string }).outcome === "continuation-delivered",
						);
				expect(delivered()).toHaveLength(1);
				const calls = inputs.length;
				await controller.restore();
				const secondController = createRestartQueueController(options);
				try {
					await secondController.restore();
				} finally {
					secondController.dispose();
				}
				await restored.waitForIdle();
				expect(inputs).toHaveLength(calls);
				expect(delivered()).toHaveLength(1);
			} finally {
				controller.dispose();
				AgentRegistry.resetGlobalForTests();
				IrcBus.resetGlobalForTests();
			}
		},
	);

	it("withdraws restored drain notices when the durable completion is the only terminal fact", async () => {
		const manager = currentManager();
		appendPriorAssistant(manager);
		const stale = {
			role: "custom" as const,
			customType: "restart-queued",
			content: "Restart offline is queued. checkpoint before restart",
			display: true,
			details: { requestId: "offline", state: "queued" },
			timestamp: Date.now(),
		};
		manager.appendCustomMessageEntry(stale.customType, stale.content, true, stale.details);
		manager.appendCustomEntry("omp:restart-pending-queues", {
			steering: [stale],
			followUp: [stale],
			pendingNextTurn: [stale],
		});
		manager.appendCustomMessageEntry(
			"restart-root-continuation",
			"Restart offline completed at 01:51; build abc123; nothing pending — resume your plan.",
			true,
			{ requestId: "offline", state: "completed" },
		);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await manager.close();
		sessionManager = undefined;
		const inputs: string[] = [];
		const restored = await reopenSession(file, [{ content: ["resume plan work"], stopReason: "stop" }], inputs);
		await restored.prompt("continue plan");
		await restored.waitForIdle();
		expect(inputs.join("\n")).not.toContain("checkpoint before restart");
		const messages = JSON.parse(inputs[0]!) as { role: string; content: unknown }[];
		const notices = messages.filter(message => JSON.stringify(message.content).includes("Restart offline"));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.role).toBe("user");
		expect(JSON.stringify(notices[0]?.content)).toContain("Harness (not Darafei): Restart offline completed");
	});

	it.each(["checkpointed", "queued"] as const)(
		"reconciles loaded %s restart notices at the production provider boundary",
		async state => {
			const manager = currentManager();
			appendPriorAssistant(manager);
			const sessionId = manager.getSessionId();
			const requestId = "loaded-notice";
			const restriction = `Restart ${requestId} is queued. Do not start another model turn until it completes.`;
			const stale = {
				role: "custom" as const,
				customType: "restart-queued",
				content: restriction,
				display: true,
				details: { requestId, state: "queued" },
				timestamp: Date.now(),
			};
			manager.appendCustomMessageEntry(stale.customType, stale.content, true, stale.details);
			const originalNotice = JSON.stringify(manager.getBranch().at(-1));
			manager.appendCustomEntry("omp:restart-pending-queues", {
				steering: [stale, { role: "user", content: "finish unfinished assignment", timestamp: Date.now() }],
				followUp: [stale],
				pendingNextTurn: [stale],
			});
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "before", sessionId, generation: 1 },
				record: {
					version: 1,
					requestId,
					sessionId,
					state,
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning: false,
				},
			});
			await manager.ensureOnDisk();
			const file = manager.getSessionFile()!;
			await manager.close();
			sessionManager = undefined;
			const modelInputs: string[] = [];
			const restored = await reopenSession(file, [{ content: ["finished"], stopReason: "stop" }], modelInputs);
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			AgentRegistry.global().register({
				id: MAIN_AGENT_ID,
				displayName: "Root",
				kind: "main",
				session: restored,
				sessionFile: file,
				status: "idle",
			});
			const controller = createRestartQueueController({
				session: restored,
				identity: () => ({ instanceId: "after", sessionId, generation: 2 }),
				restart: async () => {},
			});
			try {
				if (state === "checkpointed") {
					await controller.restore();
					await restored.waitForIrcReplies();
				} else {
					// A still-active request must retain its restriction on an ordinary next turn.
					await restored.prompt("inspect pending restart");
				}
				await restored.waitForIdle();
				const input = modelInputs.join("\n");
				if (state === "checkpointed") {
					expect(input).toContain(`Restart ${requestId} completed at`);
					expect(input).not.toContain(restriction);
					expect(input).toContain("nothing pending — resume your plan.");
					expect(
						restored.agent.state.messages.filter(
							message => message.role === "user" && message.content === "finish unfinished assignment",
						),
					).toHaveLength(1);
					const calls = modelInputs.length;
					expect(calls).toBeGreaterThan(0);
					await controller.restore();
					expect(modelInputs).toHaveLength(calls);
				} else expect(input).toContain(restriction);
				// Reconciliation affects model context; the append-only transcript retains the notice.
				expect(manager.getSessionId()).toBe(restored.sessionId);
				expect(
					JSON.stringify(
						restored.sessionManager
							.getEntries()
							.find(entry => entry.type === "custom_message" && entry.content === restriction),
					),
				).toBe(originalNotice);
			} finally {
				controller.dispose();
				AgentRegistry.resetGlobalForTests();
				IrcBus.resetGlobalForTests();
			}
		},
	);

	it.each([true, false])(
		"Escape restores the goal without waking an idle root (root was running: %s)",
		async rootWasRunning => {
			const manager = currentManager();
			appendPriorAssistant(manager);
			const sessionId = manager.getSessionId();
			const toolCallId = "cancelled-restored-ask";
			manager.appendMessage({
				role: "toolResult",
				toolName: "ask",
				toolCallId,
				content: [{ type: "text", text: "Pending question" }],
				details: {
					pending: {
						id: toolCallId,
						html: '<form><label>Which target?<select name="target"><option>Here</option><option>There</option></select></label></form>',
					},
				},
				timestamp: Date.now(),
				isError: false,
			});
			for (const state of ["queued", "draining", "checkpointed", "restarting"] as const)
				manager.appendCustomEntry("restart_request_transition", {
					version: 1,
					identity: { instanceId: "old", sessionId, generation: 0 },
					record: {
						version: 1,
						requestId: "escape-restart",
						sessionId,
						state,
						requestedAt: Date.now(),
						updatedAt: Date.now(),
						rootWasRunning,
						goalModeBefore: { goalId: "goal" },
					},
				});
			const dialog = Promise.withResolvers<ExtensionFormDialogResult | undefined>();
			const resumed = Promise.withResolvers<void>();
			let shown = 0;
			const ui = {
				formDialog: () => {
					shown++;
					return dialog.promise;
				},
			} as unknown as ExtensionUIContext;
			const inputs: string[] = [];
			session = createSession(manager, [{ content: ["continued after dismissal"], stopReason: "stop" }], inputs);
			const restored = session;
			let askRestore: Promise<boolean> | undefined;
			let pending = false;
			const controller = createRestartQueueController({
				session: restored,
				identity: () => ({ instanceId: "new", sessionId, generation: 1 }),
				restart: async () => {},
				restorePendingAsk: settled => {
					askRestore = restored.restorePendingAsk(ui, settled, () => {
						pending = true;
					});
					return pending;
				},
				restoreGoalMode: async () => {
					resumed.resolve();
				},
			});
			try {
				await controller.restore();
				expect(shown).toBe(1);
				dialog.resolve(undefined);
				await askRestore;
				// Bound the assertion so the baseline exposes the suppressed continuation, rather than hanging teardown.
				expect(await Promise.race([resumed.promise.then(() => true), Bun.sleep(250).then(() => false)])).toBe(true);
				await restored.waitForIdle();
				expect(inputs.length).toBe(rootWasRunning ? 1 : 0);
				await manager.ensureOnDisk();
				const file = manager.getSessionFile()!;
				await restored.dispose();
				session = undefined;
				sessionManager = undefined;
				const reopened = await reopenSession(file);
				expect(await reopened.restorePendingAsk(ui)).toBe(false);
				expect(shown).toBe(1);
				const replies = reopened.sessionManager
					.getBranchView()
					.filter(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(`Answer to ${toolCallId}`),
					);
				expect(replies).toEqual([]);
				const asks = reopened.sessionManager
					.getBranchView()
					.filter(
						entry =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === toolCallId,
					);
				expect(asks).toHaveLength(1);
				expect(asks[0]).toMatchObject({ message: { isError: false, details: { pending: { id: toolCallId } } } });
			} finally {
				dialog.resolve(undefined);
				controller.dispose();
			}
		},
	);

	it("releases restored input after a restored question settles on a completed restart", async () => {
		appendPriorAssistant(currentManager());
		session = createSession(currentManager());
		const lease = session.beginRestartDrain();
		session.agent.steer({ role: "user", content: "owner after restart", timestamp: Date.now() });
		await lease.waitForQuiescence();
		const toolCallId = "restored-ask-with-input";
		const manager = currentManager();
		const sessionId = manager.getSessionId();
		manager.appendMessage({
			role: "toolResult",
			toolName: "ask",
			toolCallId,
			content: [{ type: "text", text: "Pending question" }],
			details: {
				pending: {
					id: toolCallId,
					html: '<form><label>Which target?<select name="target"><option>Here</option><option>There</option></select></label></form>',
				},
			},
			timestamp: Date.now(),
			isError: false,
		});
		for (const state of ["queued", "draining", "checkpointed", "restarting"] as const)
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "old", sessionId, generation: 0 },
				record: {
					version: 1,
					requestId: "ask-input-restart",
					sessionId,
					state,
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning: true,
				},
			});
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await session.dispose();
		session = undefined;
		sessionManager = await SessionManager.open(file, tempDir.path());
		const dialog = Promise.withResolvers<ExtensionFormDialogResult | undefined>();
		let shown = 0;
		const ui = {
			formDialog: () => {
				shown++;
				return dialog.promise;
			},
		} as unknown as ExtensionUIContext;
		const inputs: string[] = [];
		session = createSession(currentManager(), [{ content: ["received"], stopReason: "stop" }], inputs);
		const restored = session;
		let askRestore: Promise<boolean> | undefined;
		let pending = false;
		AgentRegistry.resetGlobalForTests();
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "Root",
			kind: "main",
			session: restored,
			sessionFile: file,
			status: "idle",
		});
		const controller = createRestartQueueController({
			session: restored,
			identity: () => ({ instanceId: "new", sessionId, generation: 1 }),
			restart: async () => {},
			restorePendingAsk: settled => {
				askRestore = restored.restorePendingAsk(ui, settled, () => {
					pending = true;
				});
				return pending;
			},
		});
		await controller.restore();
		expect(shown).toBe(1);
		const continuations = () =>
			restored.sessionManager
				.getBranchView()
				.filter(entry => entry.type === "custom_message" && entry.customType === "restart-root-continuation");
		expect(continuations()).toHaveLength(0);
		expect(inputs).toHaveLength(0);
		dialog.resolve(undefined);
		await askRestore;
		const start = Date.now();
		while (!inputs.join("\n").includes("owner after restart") && Date.now() - start < 1500) await Bun.sleep(10);
		expect(inputs.join("\n")).toContain("owner after restart");
		expect(continuations()).toHaveLength(1);
		await restored.waitForIdle();
	});

	it("delivers the newest state note at the next tool boundary of a running turn", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const inputs: string[] = [];
		const tool: AgentTool = {
			name: "work",
			label: "Work",
			description: "Work until released",
			parameters: type({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "work finished" }], details: {} };
			},
		};
		session = createSession(
			currentManager(),
			[
				{ content: [{ type: "toolCall", id: "work-1", name: "work", arguments: {} }] },
				{ content: ["continued with latest state"], stopReason: "stop" },
			],
			inputs,
			[tool],
		);
		const running = session.prompt("keep working");
		await entered.promise;
		try {
			for (let index = 0; index < 95; index++) {
				await session.sendCustomMessage(
					{ customType: "todo-dispatch-time-note", content: `time-state-${index}`, display: false },
					{ deliverAs: "steer", triggerTurn: false, supersedes: "todo-dispatch-time-note" },
				);
			}
			await session.sendCustomMessage(
				{ customType: "goal-deadline-time-note", content: "deadline-state", display: false },
				{ deliverAs: "steer", triggerTurn: false, supersedes: "goal-deadline-time-note" },
			);
			expect(session.agent.peekSteeringQueue()).toHaveLength(2);
			release.resolve();
			await running;
			expect(inputs[1]).toContain("time-state-94");
			expect(inputs.slice(1).join("\n")).toContain("deadline-state");
			expect(inputs.slice(1).join("\n")).not.toContain("time-state-93");
			expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		} finally {
			release.resolve();
		}
	});

	it("collapses 95 legacy time notes without replacing other kinds or user steering, and replays the latest key", async () => {
		appendPriorAssistant(currentManager());
		session = createSession(currentManager());
		const lease = session.beginRestartDrain();
		for (let index = 0; index < 95; index++) {
			session.queueDeferredMessage({
				...hiddenNextTurnMessage("x".repeat(113_000)),
				customType: "todo-dispatch-time-note",
			});
		}
		session.queueDeferredMessage({ ...hiddenNextTurnMessage("deadline"), customType: "goal-deadline-time-note" });
		session.agent.steer({ role: "user", content: "todo-dispatch-time-note", timestamp: Date.now() });
		await session.sendCustomMessage(
			{ customType: "todo-dispatch-time-note", content: "latest", display: false },
			{ deliverAs: "steer", triggerTurn: false, supersedes: "todo-dispatch-time-note" },
		);
		await session.sendCustomMessage(
			{ customType: "todo-dispatch-time-note", content: "newest", display: false },
			{ deliverAs: "steer", triggerTurn: false, supersedes: "todo-dispatch-time-note" },
		);
		await lease.waitForQuiescence();
		const checkpoint = restartQueueCheckpoints(currentManager()).at(-1);
		expect(checkpoint?.type === "custom" ? checkpoint.data : undefined).toMatchObject({
			steering: [{ role: "user", content: "todo-dispatch-time-note" }],
			followUp: [{ content: "newest", supersedes: "todo-dispatch-time-note" }],
			pendingNextTurn: [{ customType: "goal-deadline-time-note" }],
		});
		const sessionFile = currentManager().getSessionFile();
		if (!sessionFile) throw new Error("Expected durable session file");
		await session.dispose();
		session = undefined;
		sessionManager = undefined;
		const restored = await reopenSession(sessionFile);
		expect(restored.agent.peekFollowUpQueue()).toMatchObject([
			{ content: "newest", supersedes: "todo-dispatch-time-note" },
		]);
		expect(restored.agent.peekSteeringQueue()).toMatchObject([{ role: "user", content: "todo-dispatch-time-note" }]);
	});

	it("does not resurrect a restored note after an idle replacement", async () => {
		const file = await checkpointHiddenMessagesForRestart([
			{ ...hiddenNextTurnMessage("stale clock"), customType: "todo-dispatch-time-note" },
		]);
		const restored = await reopenSession(file);
		await restored.sendCustomMessage(
			{ customType: "todo-dispatch-time-note", content: "current clock", display: false, attribution: "agent" },
			{ deliverAs: "steer", triggerTurn: false, supersedes: "todo-dispatch-time-note" },
		);
		await restored.flushRestartJournal();
		const checkpoint = restartQueueCheckpoints(currentManager()).at(-1);
		expect(checkpoint?.type === "custom" ? checkpoint.data : undefined).toMatchObject({
			steering: [],
			followUp: [],
			pendingNextTurn: [],
		});
		await restored.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopened = await reopenSession(file);
		const lease = reopened.beginRestartDrain();
		await lease.waitForQuiescence();
		const latest = restartQueueCheckpoints(currentManager()).at(-1);
		expect(latest?.type === "custom" ? latest.data : undefined).toMatchObject({ pendingNextTurn: [] });
	});

	it("does not rewrite checkpoints when a superseding plan notice only refreshes its timestamp", async () => {
		appendPriorAssistant(currentManager());
		session = createSession(currentManager());
		const lease = session.beginRestartDrain();
		await lease.waitForQuiescence();
		lease.release();
		session.agent.state.isStreaming = true;
		try {
			const notice = { customType: "todo-plan-check", content: "same pending plan", display: false };
			const options = { deliverAs: "nextTurn" as const, triggerTurn: false, supersedes: "todo-plan-check" };
			await session.sendCustomMessage(notice, options);
			await session.flushRestartJournal();
			const file = currentManager().getSessionFile();
			if (!file) throw new Error("Expected durable journal");
			const before = (await Bun.file(file).stat()).size;
			const beforeEntries = restartQueueCheckpoints(currentManager()).length;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] } as Parameters<typeof vi.useFakeTimers>[0]);
			for (let index = 0; index < 100; index++) await session.sendCustomMessage(notice, options);
			vi.advanceTimersByTime(5_100);
			vi.useRealTimers();
			await Bun.sleep(50);
			await session.flushRestartJournal();
			const seconds = 5.1;
			const bytes = (await Bun.file(file).stat()).size - before;
			const entries = restartQueueCheckpoints(currentManager()).length - beforeEntries;
			process.stdout.write(
				`unchanged plan fixture: emissions=100 simulated_seconds=${seconds.toFixed(3)} entries=${entries} entries/min=${((entries * 60) / seconds).toFixed(3)} bytes=${bytes} bytes/min=${((bytes * 60) / seconds).toFixed(3)}\n`,
			);
			expect((await Bun.file(file).stat()).size - before).toBe(0);
		} finally {
			vi.useRealTimers();
			session.agent.state.isStreaming = false;
		}
	}, 10_000);

	it("coalesces 100 live queue changes in ten seconds and restores the durable checkpoint after a crash", async () => {
		appendPriorAssistant(currentManager());
		session = createSession(currentManager());
		const lease = session.beginRestartDrain();
		await lease.waitForQuiescence();
		lease.release();
		const file = currentManager().getSessionFile();
		if (!file) throw new Error("Expected durable journal");
		await session.flushRestartJournal();
		const before = (await Bun.file(file).stat()).size;
		const count = restartQueueCheckpoints(currentManager()).length;
		session.agent.state.isStreaming = true;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] } as Parameters<typeof vi.useFakeTimers>[0]);
		for (let index = 0; index < 100; index++) {
			await session.sendCustomMessage(
				{ customType: `busy-${index % 32}`, content: `${index}:${"x".repeat(2_000)}`, display: false },
				{ deliverAs: "nextTurn", triggerTurn: false, supersedes: `busy-${index % 32}` },
			);
			vi.advanceTimersByTime(100);
			await new Promise<void>(resolve => setImmediate(resolve));
		}
		session.agent.state.isStreaming = false;
		await session.flushRestartJournal();
		vi.useRealTimers();
		const writes = restartQueueCheckpoints(currentManager()).length - count;
		const bytes = (await Bun.file(file).stat()).size - before;
		process.stderr.write(`busy lead: changes=100 simulated_seconds=10 writes=${writes} bytes/min=${bytes * 6}\n`);
		expect(writes).toBe(2);
		const checkpoint = restartQueueCheckpoints(currentManager()).at(-1);
		expect(checkpoint).toMatchObject({
			data: {
				pendingNextTurn: expect.arrayContaining([
					expect.objectContaining({ customType: "busy-3", content: `99:${"x".repeat(2_000)}` }),
				]),
			},
		});
		// Freeze only durable bytes, without dispose/shutdown writing a final checkpoint.
		const crashFile = path.join(tempDir.path(), "crashed.jsonl");
		await Bun.write(crashFile, Bun.file(file));
		const crashManager = await SessionManager.open(crashFile, tempDir.path(), undefined, {
			suppressBreadcrumb: true,
		});
		const crashSession = createSession(crashManager);
		try {
			const recovery = crashSession.beginRestartDrain();
			await recovery.waitForQuiescence();
			const recovered = restartQueueCheckpoints(crashManager).at(-1);
			expect(recovered?.type === "custom" ? recovered.data : undefined).toEqual(
				checkpoint?.type === "custom" ? checkpoint.data : undefined,
			);
		} finally {
			await crashSession.dispose();
		}
		const unchanged = (await Bun.file(file).stat()).size;
		await Bun.sleep(5_100);
		await session.flushRestartJournal();
		expect((await Bun.file(file).stat()).size - unchanged).toBe(0);
	}, 30_000);

	it("does not repeat the delivery checkpoint when the delayed queue writer flushes", async () => {
		appendPriorAssistant(currentManager());
		session = createSession(currentManager(), [{ content: ["done"] }]);
		const lease = session.beginRestartDrain();
		session.queueDeferredMessage(hiddenNextTurnMessage("state for this turn"));
		await lease.waitForQuiescence();
		lease.release();
		await session.waitForIdle();
		await session.prompt("continue");
		await session.waitForIdle();
		const checkpoints = restartQueueCheckpoints(currentManager());
		expect(checkpoints.at(-1)).toMatchObject({ data: { steering: [], followUp: [], pendingNextTurn: [] } });
		await session.flushRestartJournal();
		expect(restartQueueCheckpoints(currentManager())).toHaveLength(checkpoints.length);
	});

	it("does not write another live-sized checkpoint when queues are unchanged", async () => {
		appendPriorAssistant(currentManager());
		session = createSession(currentManager());
		const lease = session.beginRestartDrain();
		// DC queue shape: 95 time notes (~113 KB), 123 deadline notes, 74 other messages.
		for (let index = 0; index < 292; index++) {
			session.queueDeferredMessage({
				...hiddenNextTurnMessage(index < 95 ? "x".repeat(113_000) : "state"),
				customType: index < 95 ? "todo-dispatch-time-note" : index < 218 ? "goal-deadline-time-note" : "other",
			});
		}
		const start = performance.now();
		await lease.waitForQuiescence();
		const initialMs = performance.now() - start;
		const writes = currentManager()
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:restart-pending-queues").length;
		lease.release();
		const nextLease = session.beginRestartDrain();
		const unchangedStart = performance.now();
		await nextLease.waitForQuiescence();
		const unchangedMs = performance.now() - unchangedStart;
		process.stderr.write(
			`restart queue benchmark: first=${initialMs.toFixed(3)}ms unchanged=${unchangedMs.toFixed(3)}ms\n`,
		);

		expect(
			currentManager()
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "omp:restart-pending-queues"),
		).toHaveLength(writes);
		expect(initialMs).toBeLessThan(50);
		expect(unchangedMs).toBeLessThan(50);
	});

	it("a repeated authoritative terminal notice supersedes a later queued notice of the same request", async () => {
		const manager = currentManager();
		appendPriorAssistant(manager);
		const inputs: string[] = [];
		session = createSession(manager, [{ content: ["checked"], stopReason: "stop" }], inputs);
		const terminal = {
			customType: "restart-queued",
			content: "terminal-repeat",
			display: true,
			details: { requestId: "same", state: "completed" },
		};
		await session.sendRestartNotice(terminal);
		manager.appendCustomMessageEntry("restart-queued", "newer-restriction", true, {
			requestId: "same",
			state: "queued",
		});
		await session.sendRestartNotice(terminal);
		await session.prompt("Check current restart state");
		expect(inputs[0]).not.toContain("newer-restriction");
		expect(
			manager
				.buildSessionContext()
				.messages.some(message => message.role === "custom" && message.content === "newer-restriction"),
		).toBe(false);
	});

	it.each(["completed", "cancelled", "failed"])(
		"retires child-local pending notices idempotently after %s without auto waking",
		async state => {
			const manager = currentManager();
			appendPriorAssistant(manager);
			const inputs: string[] = [];
			session = createSession(manager, [{ content: ["checked"], stopReason: "stop" }], inputs);
			for (const requestId of ["old", "new"])
				await session.sendRestartNotice({
					customType: "restart-queued",
					content: `restriction-${requestId}`,
					display: true,
					details: { requestId, state: "queued" },
				});
			for (let repeat = 0; repeat < 2; repeat++)
				await session.sendRestartNotice({
					customType: "restart-queued",
					content: `terminal-old-${state}`,
					display: true,
					details: { requestId: "old", state },
				});
			expect(inputs).toHaveLength(0);
			expect(
				manager
					.getBranch()
					.filter(
						entry =>
							entry.type === "custom_message" &&
							entry.customType === "restart-queued" &&
							entry.content === `terminal-old-${state}`,
					),
			).toHaveLength(1);
			await session.prompt("Inspect current state");
			expect(inputs[0]).not.toContain("restriction-old");
			expect(inputs[0]).toContain("restriction-new");
			expect(inputs[0]).toContain(`terminal-old-${state}`);
		},
	);

	it.each(["completed", "cancelled", "failed"])(
		"delivers a live %s notice on the next text-only steering request",
		async state => {
			const manager = currentManager();
			appendPriorAssistant(manager);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const inputs: string[] = [];
			session = createSession(
				manager,
				(async function* () {
					entered.resolve();
					await release.promise;
					yield { content: ["still waiting"], stopReason: "stop" as const };
					yield { content: ["resumed"], stopReason: "stop" as const };
				})(),
				inputs,
				[],
				undefined,
				async messages => messages,
			);
			const running = session.prompt("text-only plan");
			await entered.promise;
			try {
				await session.sendRestartNotice({
					customType: "restart-queued",
					content: `Restart live ${state}`,
					display: true,
					attribution: "agent",
					details: { requestId: "live", state },
				});
				session.agent.steer({ role: "user", content: "next text-only iteration", timestamp: Date.now() });
			} finally {
				release.resolve();
			}
			await running;
			await session.waitForIdle();
			expect(inputs).toHaveLength(2);
			const next = JSON.parse(inputs[1]!) as { role: string; content: unknown }[];
			const terminal = next.filter(message => JSON.stringify(message).includes(`Restart live ${state}`));
			expect(terminal).toHaveLength(1);
			expect(terminal[0]!.role).toBe("user");
		},
	);

	it("delivers restart completion into a turn already running before restore", async () => {
		const manager = currentManager();
		appendPriorAssistant(manager);
		const sessionId = manager.getSessionId();
		const requestId = "already-running-restore";
		for (const state of ["queued", "draining", "checkpointed", "restarting"] as const) {
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "old", sessionId, generation: 0 },
				record: {
					version: 1,
					requestId,
					sessionId,
					state,
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning: false,
				},
			});
		}
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const inputs: string[] = [];
		session = createSession(
			manager,
			(async function* () {
				entered.resolve();
				await release.promise;
				yield { content: ["first turn"], stopReason: "stop" as const };
				yield { content: ["restriction lifted"], stopReason: "stop" as const };
			})(),
			inputs,
		);
		const running = session.prompt("work already started at startup");
		await entered.promise;
		expect(session.isStreaming).toBe(true);
		const rootRef = AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "Root",
			kind: "main",
			session,
			status: "running",
		});
		const controller = createRestartQueueController({
			session,
			identity: () => ({ instanceId: "new", sessionId, generation: 0 }),
			restart: async () => {},
		});
		try {
			await controller.restore();
			release.resolve();
			await running;
			await session.waitForIdle();
			expect(inputs).toHaveLength(2);
			expect(inputs[1]).toContain(`Restart ${requestId} completed`);
			expect(countCustomMessageEntries(manager, "restart-queued")).toBe(1);
			await controller.restore();
			expect(countCustomMessageEntries(manager, "restart-queued")).toBe(1);
		} finally {
			release.resolve();
			controller.dispose();
			AgentRegistry.global().unregister(MAIN_AGENT_ID, rootRef);
		}
	});

	it("delivers completion without aborting a running interruptible tool or skipping its batch peer", async () => {
		const manager = currentManager();
		appendPriorAssistant(manager);
		const sessionId = manager.getSessionId();
		const requestId = "running-tool-restore";
		for (const state of ["queued", "draining", "checkpointed", "restarting"] as const) {
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "old", sessionId, generation: 0 },
				record: {
					version: 1,
					requestId,
					sessionId,
					state,
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning: false,
				},
			});
		}
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const inputs: string[] = [];
		const runs: string[] = [];
		let aborted = false;
		const tool: AgentTool = {
			name: "interruptible_wait",
			label: "Wait",
			description: "Wait for a test event",
			parameters: type({}),
			intent: "omit",
			concurrency: "exclusive",
			interruptible: true,
			execute: async (id, _params, signal) => {
				runs.push(id);
				if (id === "running-wait") {
					const onAbort = () => {
						aborted = true;
						release.resolve();
					};
					signal?.addEventListener("abort", onAbort, { once: true });
					entered.resolve();
					try {
						await release.promise;
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
				}
				return { content: [{ type: "text", text: `${id} finished normally` }], details: {} };
			},
		};
		session = createSession(
			manager,
			[
				{
					content: [
						{ type: "toolCall", id: "running-wait", name: tool.name, arguments: {} },
						{ type: "toolCall", id: "pending-wait", name: tool.name, arguments: {} },
					],
				},
				{ content: ["work continues"], stopReason: "stop" },
			],
			inputs,
			[tool],
		);
		const running = session.prompt("finish the existing tool batch");
		await entered.promise;
		const controller = createRestartQueueController({
			session,
			identity: () => ({ instanceId: "new", sessionId, generation: 1 }),
			restart: async () => {},
		});
		try {
			await controller.restore();
			// Keep the wait running past the loop's aside-interrupt poll.
			await Bun.sleep(300);
			release.resolve();
			await running;
			await session.waitForIdle();
			expect(aborted).toBe(false);
			expect(runs).toEqual(["running-wait", "pending-wait"]);
			expect(inputs).toHaveLength(2);
			expect(inputs[1]).toContain(`Restart ${requestId} completed`);
			expect(inputs[1]).toContain("running-wait finished normally");
			expect(inputs[1]).toContain("pending-wait finished normally");
			expect(countCustomMessageEntries(manager, "restart-queued")).toBe(1);
		} finally {
			release.resolve();
			await running;
			controller.dispose();
		}
	});

	it("delivers completion before restored goal work can consume pending next-turn context", async () => {
		const manager = currentManager();
		appendPriorAssistant(manager);
		const sessionId = manager.getSessionId();
		const requestId = "startup-notice-order";
		manager.appendCustomMessageEntry("restart-queued", "Do not start another model turn", true, {
			requestId,
			state: "queued",
		});
		manager.appendCustomEntry("omp:restart-pending-queues", {
			steering: [],
			followUp: [],
			pendingNextTurn: [hiddenNextTurnMessage("restored startup context")],
		});
		for (const state of ["queued", "draining", "checkpointed", "restarting"] as const) {
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "before", sessionId, generation: 0 },
				record: {
					version: 1,
					requestId,
					sessionId,
					state,
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning: false,
					goalModeBefore: { goalId: "active-goal" },
				},
			});
		}
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await manager.close();
		sessionManager = undefined;
		const inputs: string[] = [];
		const restored = await reopenSession(file, [{ content: ["work resumed"], stopReason: "stop" }], inputs);
		const controller = createRestartQueueController({
			session: restored,
			identity: () => ({ instanceId: "after", sessionId, generation: 0 }),
			restart: async () => {},
			restoreGoalMode: async () => {
				await restored.prompt("resume goal work");
			},
		});
		try {
			await controller.restore();
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toContain(`Restart ${requestId} completed`);
			expect(inputs[0]).toContain("restored startup context");
			expect(inputs[0]).not.toContain("Do not start another model turn");
			const noticeCount = countCustomMessageEntries(restored.sessionManager, "restart-queued");
			expect(noticeCount).toBe(3);
			await controller.restore();
			expect(countCustomMessageEntries(restored.sessionManager, "restart-queued")).toBe(noticeCount);
		} finally {
			controller.dispose();
		}
	});

	it.each(["steering", "followUp", "nextTurn"] as const)(
		"resumes idle checkpointed %s work without another input",
		async queue => {
			const manager = currentManager();
			appendPriorAssistant(manager);
			session = createSession(manager);
			const lease = session.beginRestartDrain();
			const text = "finish the newly submitted assignment";
			if (queue === "steering") session.agent.steer({ role: "user", content: text, timestamp: Date.now() });
			else if (queue === "followUp") session.agent.followUp({ role: "user", content: text, timestamp: Date.now() });
			else session.queueDeferredMessage(hiddenNextTurnMessage("passive context for the next user turn"));
			const sessionId = manager.getSessionId();
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "before", sessionId, generation: 1 },
				record: {
					version: 1,
					requestId: "idle-queued",
					sessionId,
					state: "checkpointed",
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning: false,
				},
			});
			await lease.waitForQuiescence();
			const file = manager.getSessionFile()!;
			await session.dispose();
			session = undefined;
			sessionManager = undefined;
			const restored = await reopenSession(file, [
				...(queue === "followUp" ? [{ content: ["resuming queued work"], stopReason: "stop" as const }] : []),
				{ content: ["assignment completed"], stopReason: "stop" },
			]);
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			AgentRegistry.global().register({
				id: MAIN_AGENT_ID,
				displayName: "Root",
				kind: "main",
				session: restored,
				sessionFile: file,
				status: "idle",
			});
			const finished = Promise.withResolvers<void>();
			const detach = restored.subscribe(event => {
				if (event.type === "agent_end") finished.resolve();
			});
			const controller = createRestartQueueController({
				session: restored,
				identity: () => ({ instanceId: "after", sessionId, generation: 2 }),
				restart: async () => {},
			});
			try {
				await controller.restore();
				const ran = await Promise.race([finished.promise.then(() => true), Bun.sleep(250).then(() => false)]);
				expect(ran).toBe(true);
				if (queue !== "nextTurn") {
					await restored.waitForIrcReplies();
					await restored.waitForIdle();
					expect(
						restored.agent.state.messages.filter(message => message.role === "user" && message.content === text),
					).toHaveLength(1);
					expect(JSON.stringify(restored.getLastAssistantMessage())).toContain("assignment completed");
					expect(restored.agent.getPendingModelNewsCount()).toBe(0);
				}
				await controller.restore();
				expect(
					restored.agent.state.messages.filter(
						message =>
							message.role === "assistant" && JSON.stringify(message.content).includes("assignment completed"),
					),
				).toHaveLength(1);
			} finally {
				controller.dispose();
				detach();
				AgentRegistry.resetGlobalForTests();
				IrcBus.resetGlobalForTests();
			}
		},
	);

	it("restores typed steering and follow-up positions once without adding them to transcript history", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		const priorMessage: AgentMessage = { role: "user", content: "already in transcript", timestamp: Date.now() };
		currentManager().appendMessage(priorMessage);
		await currentManager().ensureOnDisk();
		const originalTranscript = currentManager().buildSessionContext().messages;
		session = createSession(sessionManager);

		const steering: AgentMessage[] = [
			{ role: "user", content: "steering A", timestamp: Date.now() - 4 },
			{ role: "user", content: "steering B", timestamp: Date.now() - 3 },
		];
		const followUp: AgentMessage[] = [
			{ role: "user", content: "follow-up C", timestamp: Date.now() - 2 },
			{ role: "user", content: "unrelated pending D", timestamp: Date.now() - 1 },
		];
		for (const message of steering) session.agent.steer(message);
		for (const message of followUp) session.agent.followUp(message);

		const lease = session.beginRestartDrain();
		await lease.waitForQuiescence();
		const sessionFile = currentManager().getSessionFile();
		if (!sessionFile) throw new Error("Expected durable session file");
		expect(session.agent.peekSteeringQueue()).toEqual(steering);
		expect(session.agent.peekFollowUpQueue()).toEqual(followUp);
		expect(
			currentManager()
				.getEntries()
				.filter(entry => entry.type === "message"),
		).toHaveLength(1);
		expect(currentManager().buildSessionContext().messages).toEqual(originalTranscript);

		await session.dispose();
		session = undefined;
		sessionManager = undefined;
		const restored = await reopenSession(sessionFile);
		expect(restored.agent.peekSteeringQueue()).toEqual(steering);
		expect(restored.agent.peekFollowUpQueue()).toEqual(followUp);
		expect(currentManager().buildSessionContext().messages).toEqual(originalTranscript);

		// A later restart records the empty queue state so an older checkpoint cannot
		// re-create items that the user explicitly removed from the live queue.
		restored.agent.replaceQueues([], []);
		const emptyLease = restored.beginRestartDrain();
		await emptyLease.waitForQuiescence();
		await restored.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopenedWithoutQueue = await reopenSession(sessionFile);
		expect(reopenedWithoutQueue.agent.peekSteeringQueue()).toEqual([]);
		expect(reopenedWithoutQueue.agent.peekFollowUpQueue()).toEqual([]);
		expect(currentManager().buildSessionContext().messages).toEqual(originalTranscript);
	});

	it("persists IRC, extension and prompt input arriving during a drain for delivery after restart", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		appendPriorAssistant(sessionManager);
		session = createSession(sessionManager);
		const lease = session.beginRestartDrain();
		const ircOutcome = await session.deliverIrcMessage({
			id: "drain-irc",
			from: "peer",
			to: MAIN_AGENT_ID,
			body: "peer update",
			ts: Date.now(),
		});
		const extensionOutcome = await session.sendCustomMessage(
			{ customType: "extension-during-drain", content: "extension update", display: true },
			{ deliverAs: "aside", triggerTurn: true },
		);
		const promptOutcome = await session.promptCustomMessage({
			customType: "prompt-during-drain",
			content: "prompt update",
			display: false,
		});
		expect(ircOutcome).toBe("injected");
		expect(extensionOutcome).toBe(false);
		expect(promptOutcome).toBe(true);
		await lease.waitForQuiescence();
		const sessionFile = currentManager().getSessionFile();
		if (!sessionFile) throw new Error("Expected durable session file");
		expect(restartQueueCheckpoints(currentManager()).at(-1)).toMatchObject({
			data: {
				followUp: [
					{ customType: "irc:incoming" },
					{ customType: "extension-during-drain" },
					{ customType: "prompt-during-drain" },
				],
			},
		});
		await session.dispose();
		session = undefined;
		sessionManager = undefined;

		const restored = await reopenSession(sessionFile, [
			{ content: ["received IRC"] },
			{ content: ["received extension"] },
			{ content: ["received prompt"] },
		]);
		expect(
			restored.agent
				.peekFollowUpQueue()
				.map(message => (message.role === "custom" ? message.customType : message.role)),
		).toEqual(["irc:incoming", "extension-during-drain", "prompt-during-drain"]);
		await restored.agent.continue();
		await restored.settleInFlightMessagePersistence();
		await currentManager().flush();

		for (const customType of ["irc:incoming", "extension-during-drain", "prompt-during-drain"]) {
			expect(countCustomMessageEntries(currentManager(), customType)).toBe(1);
		}
	});

	it("does not resurrect a delivered queued message after a second reopen", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		const queued: AgentMessage = { role: "user", content: "deliver exactly once", timestamp: Date.now() };
		currentManager().appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() - 1 });
		appendPriorAssistant(sessionManager);
		session = createSession(sessionManager);
		session.agent.steer(queued);
		const lease = session.beginRestartDrain();
		await lease.waitForQuiescence();
		const sessionFile = currentManager().getSessionFile();
		if (!sessionFile) throw new Error("Expected durable session file");
		await session.dispose();
		session = undefined;
		sessionManager = undefined;

		const restored = await reopenSession(sessionFile, [{ content: ["acknowledged"] }]);
		if (restored.agent.hasQueuedMessages()) await restored.agent.continue();
		await restored.settleInFlightMessagePersistence();
		await currentManager().flush();
		const delivered = currentManager()
			.getEntries()
			.filter(
				entry =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === queued.content,
			);
		expect(delivered).toHaveLength(1);

		await restored.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopened = await reopenSession(sessionFile);
		expect(reopened.agent.peekSteeringQueue()).toEqual([]);
		expect(reopened.agent.peekFollowUpQueue()).toEqual([]);
		expect(
			currentManager()
				.buildSessionContext()
				.messages.filter(message => message.role === "user" && message.content === queued.content),
		).toHaveLength(1);
	});

	it("keeps queued input recoverable when abort supersedes message_end persistence", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		const queued: AgentMessage = { role: "user", content: "survive abort before persistence", timestamp: Date.now() };
		currentManager().appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() - 1 });
		appendPriorAssistant(sessionManager);
		session = createSession(sessionManager);
		session.agent.steer(queued);
		const lease = session.beginRestartDrain();
		await lease.waitForQuiescence();
		const sessionFile = currentManager().getSessionFile();
		if (!sessionFile) throw new Error("Expected durable session file");
		await session.dispose();
		session = undefined;
		sessionManager = undefined;

		const restored = await reopenSession(sessionFile, [{ content: ["aborted response"] }]);
		let abortPromise: Promise<void> | undefined;
		const unsubscribe = restored.agent.subscribe(event => {
			if (
				event.type === "message_end" &&
				event.message.role === "user" &&
				event.message.content === queued.content &&
				!abortPromise
			) {
				abortPromise = restored.abort();
			}
		});
		try {
			if (restored.agent.hasQueuedMessages()) await restored.agent.continue();
			if (!abortPromise) throw new Error("Expected abort at queued message_end");
			await abortPromise;
			await restored.settleInFlightMessagePersistence();
		} finally {
			unsubscribe();
		}
		await currentManager().flush();
		expect(restartQueueCheckpoints(currentManager()).at(-1)).toMatchObject({
			data: { steering: [queued], followUp: [] },
		});
		expect(
			currentManager()
				.getEntries()
				.filter(
					entry =>
						entry.type === "message" && entry.message.role === "user" && entry.message.content === queued.content,
				),
		).toHaveLength(0);

		const retryLease = restored.beginRestartDrain();
		await retryLease.waitForQuiescence();
		await restored.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopened = await reopenSession(sessionFile);
		expect(reopened.agent.peekSteeringQueue()).toEqual([queued]);
		expect(reopened.agent.peekFollowUpQueue()).toEqual([]);

		await reopened.dispose();
		session = undefined;
		sessionManager = undefined;
		const delivered = await reopenSession(sessionFile, [{ content: ["delivered once"] }]);
		if (delivered.agent.hasQueuedMessages()) await delivered.agent.continue();
		await delivered.settleInFlightMessagePersistence();
		await currentManager().flush();
		expect(
			currentManager()
				.getEntries()
				.filter(
					entry =>
						entry.type === "message" && entry.message.role === "user" && entry.message.content === queued.content,
				),
		).toHaveLength(1);

		await delivered.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopenedAfterDelivery = await reopenSession(sessionFile);
		expect(reopenedAfterDelivery.agent.peekSteeringQueue()).toEqual([]);
		expect(reopenedAfterDelivery.agent.peekFollowUpQueue()).toEqual([]);
	});

	it("keeps the original queue recoverable when queued-message atomic persistence fails", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		const queued: AgentMessage = { role: "user", content: "survive failed commit", timestamp: Date.now() };
		currentManager().appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() - 1 });
		appendPriorAssistant(sessionManager);
		await currentManager().ensureOnDisk();
		session = createSession(sessionManager);
		session.agent.steer(queued);
		const lease = session.beginRestartDrain();
		await lease.waitForQuiescence();
		const sessionFile = currentManager().getSessionFile();
		if (!sessionFile) throw new Error("Expected durable session file");
		await session.dispose();
		session = undefined;
		sessionManager = undefined;

		const restored = await reopenSession(sessionFile, [{ content: ["uncommitted answer"] }]);
		const atomicAppend = currentManager().appendEntriesAtomically.bind(sessionManager);
		if (!sessionManager || !atomicAppend) throw new Error("Expected an atomic session manager");
		currentManager().appendEntriesAtomically = <T>(append: () => T): Promise<T> =>
			atomicAppend(() => {
				append();
				throw new Error("simulated failure before durable commit");
			});
		try {
			if (restored.agent.hasQueuedMessages()) await restored.agent.continue();
			await restored.settleInFlightMessagePersistence();
		} finally {
			currentManager().appendEntriesAtomically = atomicAppend;
		}
		await currentManager().flush();
		expect(
			currentManager()
				.getEntries()
				.filter(
					entry =>
						entry.type === "message" && entry.message.role === "user" && entry.message.content === queued.content,
				),
		).toHaveLength(0);

		await restored.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopened = await reopenSession(sessionFile);
		expect(reopened.agent.peekSteeringQueue()).toEqual([queued]);
		expect(reopened.agent.peekFollowUpQueue()).toEqual([]);
	});

	it("does not replay a restored hidden next-turn message after a second reopen", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		const hiddenFirst = hiddenNextTurnMessage("hidden context A");
		const hiddenSecond = hiddenNextTurnMessage("hidden context B");
		const hidden = [hiddenFirst, hiddenSecond];
		const sessionFile = await checkpointHiddenMessagesForRestart(hidden);

		const firstReopen = await reopenSession(sessionFile, [{ content: ["first reply"] }]);
		await firstReopen.prompt("consume restored hidden context");
		await firstReopen.settleInFlightMessagePersistence();
		await currentManager().flush();
		expect(countCustomMessageEntries(currentManager(), hiddenFirst.customType)).toBe(2);
		expect(
			currentManager()
				.getEntries()
				.flatMap(entry =>
					entry.type === "custom_message" && entry.customType === hiddenFirst.customType ? [entry.content] : [],
				),
		).toEqual([hiddenFirst.content, hiddenSecond.content]);
		const firstCheckpoint = restartQueueCheckpoints(currentManager()).at(-1);
		expect(firstCheckpoint?.type === "custom" ? firstCheckpoint.data : undefined).toMatchObject({
			pendingNextTurn: [],
		});

		await firstReopen.dispose();
		session = undefined;
		sessionManager = undefined;
		const secondReopen = await reopenSession(sessionFile, [{ content: ["second reply"] }]);
		await secondReopen.prompt("continue after second reopen");
		await secondReopen.settleInFlightMessagePersistence();
		await currentManager().flush();
		expect(countCustomMessageEntries(currentManager(), hiddenFirst.customType)).toBe(2);
		expect(
			currentManager()
				.getEntries()
				.flatMap(entry =>
					entry.type === "custom_message" && entry.customType === hiddenFirst.customType ? [entry.content] : [],
				),
		).toEqual([hiddenFirst.content, hiddenSecond.content]);
		const secondCheckpoint = restartQueueCheckpoints(currentManager()).at(-1);
		expect(secondCheckpoint?.type === "custom" ? secondCheckpoint.data : undefined).toMatchObject({
			pendingNextTurn: [],
		});
	});

	it("keeps restored hidden next-turn messages pending when atomic persistence fails", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		const hidden = hiddenNextTurnMessage("restore hidden context after a failed commit");
		const sessionFile = await checkpointHiddenMessagesForRestart([hidden]);

		const restored = await reopenSession(sessionFile, [{ content: ["uncommitted reply"] }]);
		const atomicAppend = currentManager().appendEntriesAtomically.bind(sessionManager);
		if (!sessionManager || !atomicAppend) throw new Error("Expected an atomic session manager");
		currentManager().appendEntriesAtomically = <T>(append: () => T): Promise<T> =>
			atomicAppend(() => {
				append();
				throw new Error("simulated failure before durable hidden-message commit");
			});
		try {
			await restored.prompt("fail hidden context commit");
			await restored.settleInFlightMessagePersistence();
		} finally {
			currentManager().appendEntriesAtomically = atomicAppend;
		}
		await currentManager().flush();
		expect(countCustomMessageEntries(sessionManager, hidden.customType)).toBe(0);
		const failedCheckpoint = restartQueueCheckpoints(sessionManager).at(-1);
		expect(failedCheckpoint?.type === "custom" ? failedCheckpoint.data : undefined).toMatchObject({
			pendingNextTurn: [expect.objectContaining({ content: hidden.content })],
		});

		await restored.dispose();
		session = undefined;
		sessionManager = undefined;
		const retry = await reopenSession(sessionFile, [{ content: ["committed reply"] }]);
		await retry.prompt("retry hidden context delivery");
		await retry.settleInFlightMessagePersistence();
		await currentManager().flush();
		if (!sessionManager) throw new Error("Expected the retried session manager");
		expect(countCustomMessageEntries(sessionManager, hidden.customType)).toBe(1);
		expect(restartQueueCheckpoints(sessionManager).at(-1)).toMatchObject({
			type: "custom",
			data: { pendingNextTurn: [] },
		});
	});

	it("materializes a fresh session before a safe restart checkpoint", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		session = createSession(sessionManager);
		await currentManager().flush();
		expect(currentManager().isSessionOnDisk()).toBe(false);
		expect(restartQueueCheckpoints(sessionManager)).toHaveLength(0);
		const sessionId = currentManager().getSessionId();

		const lease = session.beginRestartDrain();
		try {
			await lease.waitForQuiescence();
		} finally {
			lease.release();
		}
		expect(currentManager().isSessionOnDisk()).toBe(true);
		const sessionFile = currentManager().getSessionFile();
		if (!sessionFile) throw new Error("Expected a resumable session file");
		expect(restartQueueCheckpoints(sessionManager)).toHaveLength(1);
		expect(restartQueueCheckpoints(sessionManager).at(-1)).toMatchObject({
			type: "custom",
			data: { steering: [], followUp: [], pendingNextTurn: [] },
		});

		await session.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopened = await reopenSession(sessionFile);
		expect(currentManager().getSessionId()).toBe(sessionId);
		expect(reopened.agent.peekSteeringQueue()).toEqual([]);
		expect(reopened.agent.peekFollowUpQueue()).toEqual([]);
	});
	it("does not replay a cancelled restart's checkpoint after the user empties the queue", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		appendPriorAssistant(currentManager());
		session = createSession(sessionManager);
		const lease = session.beginRestartDrain();
		session.agent.followUp({ role: "user", content: "removed before quit", timestamp: Date.now() });
		await lease.waitForQuiescence();
		expect(restartQueueCheckpoints(currentManager()).at(-1)).toMatchObject({
			data: { followUp: [{ content: "removed before quit" }] },
		});
		lease.release();
		session.clearQueue();
		await session.flushRestartJournal();
		const sessionFile = currentManager().getSessionFile();
		if (!sessionFile) throw new Error("Expected a resumable session file");
		expect(restartQueueCheckpoints(currentManager()).at(-1)).toMatchObject({
			data: { steering: [], followUp: [] },
		});

		await session.dispose();
		session = undefined;
		sessionManager = undefined;
		const reopened = await reopenSession(sessionFile);
		expect(reopened.agent.peekFollowUpQueue()).toEqual([]);
	});

	it.each(["clear", "remove", "pop"] as const)(
		"persists %s edits to restored queues across a second ordinary resume",
		async edit => {
			appendPriorAssistant(currentManager());
			session = createSession(currentManager());
			const lease = session.beginRestartDrain();
			session.agent.followUp({ role: "user", content: "keep", timestamp: Date.now() });
			session.agent.followUp({ role: "user", content: "remove", timestamp: Date.now() });
			await lease.waitForQuiescence();
			const file = currentManager().getSessionFile();
			if (!file) throw new Error("Expected a persisted checkpoint");
			await session.dispose();
			lease.release();
			session = undefined;
			sessionManager = undefined;

			const resumed = await reopenSession(file);
			expect(
				resumed.agent.peekFollowUpQueue().map(message => (message.role === "user" ? message.content : undefined)),
			).toEqual(["keep", "remove"]);
			if (edit === "clear") resumed.clearQueue();
			else if (edit === "remove") expect(resumed.removeQueuedMessage("remove", "followUp")).toBe(true);
			else expect(resumed.popLastQueuedMessage()?.text).toBe("remove");
			await resumed.dispose();
			session = undefined;
			sessionManager = undefined;

			const reopened = await reopenSession(file);
			expect(
				reopened.agent.peekFollowUpQueue().map(message => (message.role === "user" ? message.content : undefined)),
			).toEqual(edit === "clear" ? [] : ["keep"]);
		},
	);

	it("retries quiescence on the same lease after a rejected wait", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		session = createSession(sessionManager);
		session.agent.followUp({ role: "user", content: "queued", timestamp: Date.now() });
		const ensureOnDisk = vi.spyOn(sessionManager, "ensureOnDisk").mockResolvedValue();
		const onDisk = vi.spyOn(sessionManager, "isSessionOnDisk").mockReturnValue(false);
		const lease = session.beginRestartDrain();
		try {
			await expect(lease.waitForQuiescence()).rejects.toThrow("not resumable on disk");
			ensureOnDisk.mockRestore();
			onDisk.mockRestore();
			await lease.waitForQuiescence();
		} finally {
			lease.release();
		}
	});

	it("acknowledges prompt admission once a drain queues the prompt", async () => {
		if (!sessionManager) throw new Error("Expected a session manager");
		session = createSession(sessionManager);
		const lease = session.beginRestartDrain();
		try {
			let admitted = 0;
			await session.prompt("queued during drain", { onPromptAdmitted: () => admitted++ });
			expect(admitted).toBe(1);
		} finally {
			lease.release();
		}
	});
});
