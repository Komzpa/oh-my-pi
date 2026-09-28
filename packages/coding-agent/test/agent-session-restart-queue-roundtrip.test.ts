import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

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

	function createSession(manager: SessionManager, responses: MockResponse[] = []): AgentSession {
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: manager.buildSessionContext().messages,
			},
			streamFn: mock.stream,
		});
		return new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
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
		return manager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:restart-pending-queues");
	}

	async function reopenSession(sessionFile: string, responses: MockResponse[] = []): Promise<AgentSession> {
		sessionManager = await SessionManager.open(sessionFile, tempDir.path(), undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		session = createSession(sessionManager, responses);
		return session;
	}

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
});
