import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { asyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/async-job-views";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRegistryApi, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { createRestartQueueController } from "@oh-my-pi/pi-coding-agent/task/restart-queue";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { collectPendingToolCalls, SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import {
	captureSubagentsForRestart,
	sendRootContinuationOnce,
	restoreSubagentsAfterRestart,
} from "@oh-my-pi/pi-coding-agent/task/restart-recovery";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { readRestartIsolation } from "@oh-my-pi/pi-coding-agent/task/restart-isolation";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Transcript {
	id: string;
	sessionFile: string;
}

interface TestSession {
	session: AgentSession;
	notices: Array<{ level: string; message: string; source?: string }>;
}

const tempDirs: TempDir[] = [];
const managers = new Set<SessionManager>();

function track(manager: SessionManager): SessionManager {
	managers.add(manager);
	return manager;
}

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

async function createTranscript(
	cwd: string,
	directory: string,
	options: { task: string; includeInit?: boolean; isolated?: boolean },
): Promise<Transcript> {
	await fs.mkdir(directory, { recursive: true });
	const manager = SessionManager.create(cwd, directory);
	if (options.includeInit !== false) {
		manager.appendSessionInit({
			systemPrompt: ["Persisted subagent prompt"],
			task: options.task,
			tools: ["read", "yield"],
			isolated: options.isolated,
		});
	}
	manager.appendMessage({ role: "user", content: "Begin the durable assignment", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted subagent file");
	const transcript = { id: path.basename(sessionFile, ".jsonl"), sessionFile };
	await manager.close();
	return transcript;
}

async function createRootSession(cwd: string, directory: string): Promise<{ manager: SessionManager; file: string }> {
	const manager = track(SessionManager.create(cwd, directory));
	manager.appendMessage({ role: "user", content: "Root session", timestamp: Date.now() });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted root session file");
	return { manager, file };
}

function makeTestSession(
	manager: SessionManager,
	options?: { streaming?: boolean; onDelivery?: (message: IrcMessage) => void },
): TestSession {
	let streaming = options?.streaming ?? false;
	const notices: TestSession["notices"] = [];
	const session = {
		sessionManager: manager,
		getRestartBranchEntries: async () => manager.getBranch(),
		getRestartPendingInputCount: () => 0,
		get isStreaming() {
			return streaming;
		},
		deliverRestartContinuation: async (requestId: string, content: string) => {
			manager.appendCustomMessageEntry("restart-root-continuation", content, true, { requestId });
			await manager.flush();
		},
		deliverIrcMessage: async (message: IrcMessage) => {
			options?.onDelivery?.(message);
			return "woken" as const;
		},
		dispose: async () => manager.close(),
		getTodoPhases: () => [],
		commitTodoPhases: () => {},
		emitNotice: (level: string, message: string, source?: string) => notices.push({ level, message, source }),
	} as unknown as AgentSession;
	return {
		session,
		notices,
		setStreaming(value: boolean) {
			streaming = value;
		},
	} as TestSession & { setStreaming(value: boolean): void };
}

function registerRoot(
	registry: AgentRegistryApi,
	session: AgentSession,
	sessionFile: string,
	id = MAIN_AGENT_ID,
): void {
	registry.register({ id, displayName: id, kind: "main", session, sessionFile, status: "idle" });
}

async function appendUnfinishedToolCall(sessionFile: string): Promise<void> {
	const manager = track(await SessionManager.open(sessionFile));
	manager.appendMessage({ role: "user", content: "Continue tool work", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "pending-bash", name: "bash", arguments: { command: "echo pending" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	manager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "SIGTERM",
		kind: "signal",
		recordedAt: new Date().toISOString(),
	});
	await manager.flush();
	await manager.close();
}

async function appendTerminalYield(sessionFile: string): Promise<void> {
	const manager = track(await SessionManager.open(sessionFile));
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "terminal-yield", name: "yield", arguments: { data: "completed" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "terminal-yield",
		toolName: "yield",
		content: [{ type: "text", text: "accepted" }],
		details: { status: "success", type: "final" },
		isError: false,
		timestamp: Date.now(),
	});
	manager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "SIGTERM",
		kind: "signal",
		recordedAt: new Date().toISOString(),
	});
	await manager.flush();
	await manager.close();
}

beforeEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	for (const manager of managers) await manager.close().catch(() => {});
	managers.clear();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("subagent restart recovery", () => {
	it("does not let terminal notices erase a later pending notice of the same request", async () => {
		const cwd = makeTempDir("@pi-child-later-notice-");
		const { manager } = await createRootSession(cwd, path.join(cwd, "sessions"));
		manager.appendCustomMessageEntry("restart-queued", "completed", true, { requestId: "same", state: "completed" });
		manager.appendCustomMessageEntry("restart-queued", "later pending", true, { requestId: "same", state: "queued" });
		const context = buildSessionContext(manager.getBranch(), undefined, undefined, {});
		expect(context.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: "later pending" })]));
	});

	it("does not let a stale pending delivery override a durable controller terminal transition", async () => {
		const cwd = makeTempDir("@pi-controller-terminal-notice-");
		const { manager } = await createRootSession(cwd, path.join(cwd, "sessions"));
		manager.appendCustomEntry("restart_request_transition", { record: { requestId: "same", state: "completed" } });
		manager.appendCustomMessageEntry("restart-queued", "stale pending", true, { requestId: "same", state: "queued" });
		const context = buildSessionContext(manager.getBranch(), undefined, undefined, {});
		expect(context.messages.some(message => message.role === "custom" && message.content === "stale pending")).toBe(
			false,
		);
	});

	it.each(["completed", "cancelled", "failed"] as const)(
		"child context reconciles exact terminal notice %s without dropping a different pending request",
		async state => {
			const cwd = makeTempDir("@pi-child-terminal-context-");
			const { manager } = await createRootSession(cwd, path.join(cwd, "sessions"));
			manager.appendCustomMessageEntry("restart-queued", "old restriction", true, {
				requestId: "old",
				state: "queued",
			});
			manager.appendCustomMessageEntry("restart-queued", "new restriction", true, {
				requestId: "new",
				state: "queued",
			});
			manager.appendCustomMessageEntry("restart-queued", "old request ended", true, { requestId: "old", state });
			const context = buildSessionContext(manager.getBranch(), undefined, undefined, {});
			const notices = context.messages.filter(
				message => message.role === "custom" && message.customType === "restart-queued",
			);
			expect(notices).toHaveLength(2);
			expect(notices).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ details: { requestId: "new", state: "queued" } }),
					expect.objectContaining({ details: { requestId: "old", state } }),
				]),
			);
		},
	);

	it.each([false, true])(
		"reconciles an idle child's queued notice after cross-instance completion without waking it (retry: %s)",
		async retry => {
			const cwd = makeTempDir("@pi-child-restart-notice-");
			const { manager, file } = await createRootSession(cwd, path.join(cwd, "sessions"));
			const root = makeTestSession(manager).session;
			const registry = AgentRegistry.global();
			registerRoot(registry, root, file);
			const requestId = "restart-child-notice";
			const child = await createTranscript(cwd, file.slice(0, -6), { task: "preserve completed checkpoint" });
			const childManager = track(await SessionManager.open(child.sessionFile));
			childManager.appendCustomMessageEntry(
				"restart-queued",
				`Restart ${requestId} is queued. Do not start another model turn.`,
				true,
				{ requestId, state: "queued" },
			);
			childManager.appendCustomEntry("worker-checkpoint", { completed: "bounded work" });
			await childManager.flush();
			registry.register({
				id: child.id,
				displayName: "idle child",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: makeTestSession(childManager).session,
				sessionFile: child.sessionFile,
				status: "idle",
			});
			await captureSubagentsForRestart(root, { requestId });
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "old", sessionId: manager.getSessionId(), generation: 0 },
				record: {
					version: 1,
					requestId,
					sessionId: manager.getSessionId(),
					state: "restarting",
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning: false,
				},
			});
			await manager.flush();
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			registerRoot(AgentRegistry.global(), root, file);
			const deliveries: IrcMessage[] = [];
			let childNoticeAttempts = 0;
			const noticeSession = (m: SessionManager): AgentSession => {
				const session = makeTestSession(m, { onDelivery: message => deliveries.push(message) }).session;
				Object.assign(session, {
					reconcileRestartNotices: async () => {},
					sendRestartNotice: async (message: { content: string; details?: unknown }) => {
						if (m.getSessionId() !== manager.getSessionId()) {
							childNoticeAttempts++;
							if (retry && childNoticeAttempts === 1) throw new Error("temporary notice delivery failure");
						}
						m.appendCustomMessageEntry("restart-queued", message.content, true, message.details);
						await m.flush();
					},
				});
				return session;
			};
			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
				async ref => async () => noticeSession(track(await SessionManager.open(ref.sessionFile!))),
				() => 0,
			);
			Object.assign(root, {
				reconcileRestartNotices: async () => {},
				sendRestartNotice: noticeSession(manager).sendRestartNotice,
			});
			const controller = createRestartQueueController({
				session: root,
				identity: () => ({ instanceId: "new", sessionId: manager.getSessionId(), generation: 1 }),
				restart: async () => {},
			});
			try {
				await controller.restore();
				await controller.restore();
				expect(controller.snapshot().request?.state).toBe("completed");
				if (retry) {
					const report = await restoreSubagentsAfterRestart(root, {
						requestId,
						beforeChildResume: childSession =>
							childSession
								.sendRestartNotice({
									customType: "restart-queued",
									content: "Restart request completed",
									display: true,
									details: { requestId, state: "completed" },
								})
								.then(() => undefined),
					});
					expect(report.failures).toEqual([]);
					expect(childNoticeAttempts).toBe(2);
				}
				expect(deliveries).toHaveLength(0);
				const restored = AgentRegistry.global().get(child.id)!;
				expect(restored.status).toBe("idle");
				const persistedChild = track(await SessionManager.open(child.sessionFile));
				const entries = persistedChild.getBranch();
				expect(entries.some(entry => entry.type === "custom" && entry.customType === "worker-checkpoint")).toBe(
					true,
				);
				const context = buildSessionContext(entries, undefined, undefined, {});
				const notices = context.messages.filter(
					message => message.role === "custom" && message.customType === "restart-queued",
				);
				expect(notices).toHaveLength(1);
				expect(notices[0]).toMatchObject({ details: { requestId, state: "completed" } });
			} finally {
				controller.dispose();
			}
		},
	);

	it.each(["checkpointed", "restarting"] as const)(
		"manual resume of %s revives captured workers while reporting failed",
		async state => {
			const cwd = makeTempDir("@pi-manual-restart-workers-");
			const { manager, file } = await createRootSession(cwd, path.join(cwd, "sessions"));
			const root = makeTestSession(manager).session;
			const registry = AgentRegistry.global();
			registerRoot(registry, root, file);
			const child = await createTranscript(cwd, file.slice(0, -6), { task: "captured assignment" });
			registry.register({
				id: child.id,
				displayName: "captured child",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: makeTestSession(track(await SessionManager.open(child.sessionFile))).session,
				sessionFile: child.sessionFile,
				status: "idle",
			});
			await captureSubagentsForRestart(root, { requestId: "manual-handoff" });
			manager.appendCustomEntry("restart_request_transition", {
				version: 1,
				identity: { instanceId: "old", sessionId: manager.getSessionId(), generation: 0 },
				record: {
					version: 1,
					requestId: "manual-handoff",
					sessionId: manager.getSessionId(),
					state,
					requestedAt: Date.now(),
					updatedAt: Date.now(),
					rootWasRunning: false,
				},
			});
			await manager.flush();
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			registerRoot(AgentRegistry.global(), root, file);
			const revived: string[] = [];
			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
				async ref => async () => {
					revived.push(ref.id);
					return makeTestSession(track(await SessionManager.open(ref.sessionFile!))).session;
				},
				() => 0,
			);
			const notices: string[] = [];
			Object.assign(root, {
				reconcileRestartNotices: async () => {},
				sendRestartNotice: async (message: { content: string }) => {
					notices.push(message.content);
				},
			});
			const controller = createRestartQueueController({
				session: root,
				identity: () => ({ instanceId: "manual", sessionId: manager.getSessionId(), generation: 1 }),
				restart: async () => {
					throw new Error("must not restart");
				},
				restartSuccessor: false,
			});
			try {
				await controller.restore();
				expect(revived).toEqual([child.id]);
				expect(AgentRegistry.global().get(child.id)?.session).toBeTruthy();
				expect(controller.snapshot().request?.state).toBe("failed");
				expect(notices).toHaveLength(1);
				expect(notices[0]).toContain(" failed;");
				expect(notices[0]).not.toContain(" completed;");
			} finally {
				controller.dispose();
			}
		},
	);

	it("revives the next child as soon as a slot frees while another child is stalled", async () => {
		const cwd = makeTempDir("@pi-restart-recovery-slots-");
		const { manager, file } = await createRootSession(cwd, path.join(cwd, "sessions"));
		const root = makeTestSession(manager).session;
		registerRoot(AgentRegistry.global(), root, file);
		const children: Transcript[] = [];
		for (let index = 0; index < 5; index++) {
			const child = await createTranscript(cwd, file.slice(0, -6), { task: `assignment ${index}` });
			children.push(child);
			const childManager = track(await SessionManager.open(child.sessionFile));
			AgentRegistry.global().register({
				id: child.id,
				displayName: child.id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: makeTestSession(childManager).session,
				sessionFile: child.sessionFile,
				status: "idle",
			});
		}
		await captureSubagentsForRestart(root);
		await Promise.all([...managers].map(value => value.close()));
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const reopened = track(await SessionManager.open(file));
		const successor = makeTestSession(reopened).session;
		registerRoot(AgentRegistry.global(), successor, file);
		const release = Promise.withResolvers<void>();
		const fifthStarted = Promise.withResolvers<void>();
		const started: string[] = [];
		let active = 0;
		let peak = 0;
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async ref => async () => {
				started.push(ref.id);
				peak = Math.max(peak, ++active);
				try {
					if (started.length === 1) await release.promise;
					if (started.length === 5) fifthStarted.resolve();
					return makeTestSession(track(await SessionManager.open(ref.sessionFile!))).session;
				} finally {
					active--;
				}
			},
			() => 0,
		);
		const restoring = restoreSubagentsAfterRestart(successor);
		let filledVacancy = false;
		try {
			filledVacancy = await Promise.race([fifthStarted.promise.then(() => true), Bun.sleep(500).then(() => false)]);
		} finally {
			release.resolve();
		}
		const report = await restoring;
		expect(filledVacancy).toBe(true);
		expect(peak).toBeLessThanOrEqual(4);
		expect(new Set(started).size).toBe(5);
		expect(report.restoredIdle.sort()).toEqual(children.map(child => child.id).sort());
		expect(report.failures).toEqual([]);
	});

	it("restores same identities across fresh registries and sends one continuation only", async () => {
		const cwd = makeTempDir("@pi-restart-recovery-");
		const { manager: rootManager, file: rootFile } = await createRootSession(cwd, path.join(cwd, "sessions"));
		const rootArtifactDir = rootFile.slice(0, -".jsonl".length);
		const running = await createTranscript(cwd, rootArtifactDir, { task: "original running assignment" });
		const idle = await createTranscript(cwd, rootArtifactDir, { task: "original idle assignment" });
		const parked = await createTranscript(cwd, rootArtifactDir, { task: "original parked assignment" });
		const tombstoned = await createTranscript(cwd, rootArtifactDir, { task: "killed assignment" });
		await fs.writeFile(`${tombstoned.sessionFile}.tombstone`, "killed");
		await fs.writeFile(`${tombstoned.sessionFile.slice(0, -".jsonl".length)}.md`, "stale killed result");
		await fs.writeFile(
			`${running.sessionFile.slice(0, -".jsonl".length)}.md`,
			"stale prior output; not proof of completion",
		);

		const otherRoot = await createRootSession(cwd, path.join(cwd, "other-sessions"));
		const otherRootId = "OtherRoot";
		const otherChild = await createTranscript(cwd, otherRoot.file.slice(0, -".jsonl".length), {
			task: "another root assignment",
		});
		const registry = AgentRegistry.global();
		const rootSession = makeTestSession(rootManager).session;
		registerRoot(registry, rootSession, rootFile);
		const otherRootSession = makeTestSession(otherRoot.manager).session;
		registerRoot(registry, otherRootSession, otherRoot.file, otherRootId);

		const runningManager = track(await SessionManager.open(running.sessionFile));
		const idleManager = track(await SessionManager.open(idle.sessionFile));
		registry.register({
			id: otherChild.id,
			displayName: "Other root child",
			kind: "sub",
			parentId: otherRootId,
			session: null,
			sessionFile: otherChild.sessionFile,
			status: "parked",
		});
		registry.register({
			id: running.id,
			displayName: "Runner label",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(runningManager, { streaming: true }).session,
			sessionFile: running.sessionFile,
			status: "running",
		});
		registry.register({
			id: idle.id,
			displayName: "Idle label",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(idleManager).session,
			sessionFile: idle.sessionFile,
			status: "idle",
		});
		registry.register({
			id: parked.id,
			displayName: "Parked label",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: parked.sessionFile,
			status: "parked",
		});

		const originalRunningSessionId = runningManager.getSessionId();
		const originalIdleSessionId = idleManager.getSessionId();
		await captureSubagentsForRestart(rootSession);
		const handoff = rootManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === "subagent_restart_handoff");
		expect(handoff?.type).toBe("custom");
		if (!handoff || handoff.type !== "custom") throw new Error("Expected durable restart handoff");
		expect(JSON.stringify(handoff.data)).not.toContain("original running assignment");

		await Promise.all([runningManager.close(), idleManager.close(), rootManager.close(), otherRoot.manager.close()]);
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();

		const freshRootManager = track(await SessionManager.open(rootFile));
		const freshRootSession = makeTestSession(freshRootManager);
		const freshRegistry = AgentRegistry.global();
		registerRoot(freshRegistry, freshRootSession.session, rootFile);
		const freshOtherRootManager = track(await SessionManager.open(otherRoot.file));
		registerRoot(freshRegistry, makeTestSession(freshOtherRootManager).session, otherRoot.file, otherRootId);
		const sameOtherRef = freshRegistry.register({
			id: otherChild.id,
			displayName: "Other root child",
			kind: "sub",
			parentId: otherRootId,
			session: null,
			sessionFile: otherChild.sessionFile,
			status: "parked",
		});
		const deliveries: IrcMessage[] = [];
		const revivalCalls: string[] = [];
		const firstRevivalRelease = Promise.withResolvers<void>();
		const secondRevivalStarted = Promise.withResolvers<void>();
		const revived = new Map<string, TestSession>();
		const installReviver = (
			targetRegistry: AgentRegistryApi,
			calls: string[],
			sessions: Map<string, TestSession>,
		) => {
			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
				async ref => {
					if (!ref.sessionFile) return undefined;
					return async () => {
						calls.push(ref.id);
						if (calls === revivalCalls && calls.length === 1) await firstRevivalRelease.promise;
						else if (calls === revivalCalls && calls.length === 2) secondRevivalStarted.resolve();
						const manager = track(await SessionManager.open(ref.sessionFile!));
						const fake = makeTestSession(manager, {
							onDelivery: message => {
								deliveries.push(message);
								targetRegistry.setStatus(ref.id, "running", fake.session);
							},
						});
						sessions.set(ref.id, fake);
						return fake.session;
					};
				},
				() => 0,
			);
		};
		installReviver(freshRegistry, revivalCalls, revived);

		const restoring = restoreSubagentsAfterRestart(freshRootSession.session);
		let overlapped = false;
		try {
			overlapped = await Promise.race([
				secondRevivalStarted.promise.then(() => true),
				Bun.sleep(500).then(() => false),
			]);
		} finally {
			firstRevivalRelease.resolve();
		}
		const first = await restoring;
		expect(overlapped).toBe(true);
		expect(first.resumed).toEqual([running.id]);
		expect(first.restoredIdle).toEqual([idle.id]);
		expect(first.parked).toEqual([]);
		expect(first.failures).toEqual([]);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toMatchObject({ from: MAIN_AGENT_ID, to: running.id });
		expect(deliveries[0]?.body).toContain("persisted session_init and conversation history");
		expect([...revivalCalls].sort()).toEqual([running.id, idle.id].sort());
		expect(freshRegistry.get(running.id)).toMatchObject({
			id: running.id,
			displayName: "Runner label",
			parentId: MAIN_AGENT_ID,
			sessionFile: running.sessionFile,
			status: "running",
		});
		expect(revived.get(running.id)?.session.sessionManager.getSessionId()).toBe(originalRunningSessionId);
		expect(freshRegistry.get(idle.id)).toMatchObject({
			id: idle.id,
			displayName: "Idle label",
			parentId: MAIN_AGENT_ID,
			sessionFile: idle.sessionFile,
			status: "idle",
		});
		expect(revived.get(idle.id)?.session.sessionManager.getSessionId()).toBe(originalIdleSessionId);
		// Historical peers remain discoverable, but must not delay live-child recovery.
		expect(freshRegistry.get(parked.id)).toBeUndefined();
		await ensurePersistedRoster(freshRegistry, freshRootManager.getSessionFile());
		expect(freshRegistry.get(parked.id)).toMatchObject({
			status: "parked",
			session: null,
		});
		expect(freshRegistry.get(tombstoned.id)?.status).toBe("aborted");
		expect(freshRegistry.get(tombstoned.id)?.session).toBeNull();
		expect(freshRegistry.get(otherChild.id)).toBe(sameOtherRef);

		const second = await restoreSubagentsAfterRestart(freshRootSession.session);
		expect(second.resumed).toEqual([running.id]);
		expect(second.restoredIdle).toEqual([idle.id]);
		expect(second.parked).toEqual([]);
		expect(deliveries).toHaveLength(1);
		expect([...revivalCalls].sort()).toEqual([running.id, idle.id].sort());

		await Promise.all([
			...Array.from(revived.values(), item => item.session.sessionManager.close()),
			freshRootManager.close(),
			freshOtherRootManager.close(),
		]);
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();

		const thirdRootManager = track(await SessionManager.open(rootFile));
		const thirdRootSession = makeTestSession(thirdRootManager);
		const thirdRegistry = AgentRegistry.global();
		registerRoot(thirdRegistry, thirdRootSession.session, rootFile);
		const thirdRevivalCalls: string[] = [];
		const thirdRevived = new Map<string, TestSession>();
		installReviver(thirdRegistry, thirdRevivalCalls, thirdRevived);

		const third = await restoreSubagentsAfterRestart(thirdRootSession.session);
		expect(third.resumed).toEqual([]);
		expect([...third.restoredIdle].sort()).toEqual([running.id, idle.id].sort());
		expect(third.parked).toEqual([]);
		expect(third.failures).toEqual([]);
		expect(deliveries).toHaveLength(1);
		expect([...thirdRevivalCalls].sort()).toEqual([running.id, idle.id].sort());
		expect(thirdRegistry.get(running.id)).toMatchObject({
			status: "idle",
			session: thirdRevived.get(running.id)?.session,
		});
		expect(thirdRegistry.get(idle.id)).toMatchObject({ status: "idle", session: thirdRevived.get(idle.id)?.session });
		expect(thirdRegistry.get(parked.id)).toBeUndefined();
		await ensurePersistedRoster(thirdRegistry, rootFile);
		expect(thirdRegistry.get(parked.id)).toMatchObject({ status: "parked", session: null });
	});

	it("restarts with 300 completed refs and hands off exactly the two live children", async () => {
		const cwd = makeTempDir("@pi-restart-large-roster-");
		const { manager: rootManager, file: rootFile } = await createRootSession(cwd, path.join(cwd, "sessions"));
		const rootArtifactDir = rootFile.slice(0, -".jsonl".length);
		const registry = AgentRegistry.global();
		const rootSession = makeTestSession(rootManager).session;
		registerRoot(registry, rootSession, rootFile);
		const completedAt = Date.now() - 60_000;
		for (let index = 0; index < 300; index++) {
			const id = `Finished-${String(index).padStart(3, "0")}`;
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: null,
				sessionFile: path.join(rootArtifactDir, `${id}.jsonl`),
				status: "parked",
				lifecycle: { acceptedAt: completedAt, terminalAt: completedAt },
			});
		}
		const live: Transcript[] = [];
		const childManagers: SessionManager[] = [];
		const settled = await createTranscript(cwd, rootArtifactDir, { task: "already accepted result" });
		const settledManager = track(await SessionManager.open(settled.sessionFile));
		childManagers.push(settledManager);
		registry.register({
			id: settled.id,
			displayName: settled.id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(settledManager).session,
			sessionFile: settled.sessionFile,
			status: "idle",
			lifecycle: { acceptedAt: completedAt, terminalAt: completedAt },
		});
		for (const task of ["first live worker", "second live worker"]) {
			const transcript = await createTranscript(cwd, rootArtifactDir, { task });
			const manager = track(await SessionManager.open(transcript.sessionFile));
			childManagers.push(manager);
			live.push(transcript);
			registry.register({
				id: transcript.id,
				displayName: transcript.id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: makeTestSession(manager, { streaming: true }).session,
				sessionFile: transcript.sessionFile,
				status: "running",
			});
		}

		await captureSubagentsForRestart(rootSession);
		const handoff = rootManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === "subagent_restart_handoff");
		expect(handoff?.type).toBe("custom");
		if (!handoff || handoff.type !== "custom") throw new Error("Expected durable restart handoff");
		expect(
			(handoff.data as { children: Array<{ id: string; status: string }> }).children
				.map(({ id, status }) => ({
					id,
					status,
				}))
				.toSorted((left, right) => left.id.localeCompare(right.id)),
		).toEqual(
			live.map(({ id }) => ({ id, status: "running" })).sort((left, right) => left.id.localeCompare(right.id)),
		);
		expect((handoff.data as { omittedChildren?: unknown[] }).omittedChildren ?? []).toEqual([]);
		await Promise.all([...childManagers.map(manager => manager.close()), rootManager.close()]);
	});

	it("keeps the newest live refs and records omitted workers when the live limit is exceeded", async () => {
		const cwd = makeTempDir("@pi-restart-live-limit-");
		const { manager: rootManager, file: rootFile } = await createRootSession(cwd, path.join(cwd, "sessions"));
		const rootArtifactDir = rootFile.slice(0, -".jsonl".length);
		const registry = AgentRegistry.global();
		const rootSession = makeTestSession(rootManager).session;
		registerRoot(registry, rootSession, rootFile);
		for (let index = 0; index < 257; index++) {
			const id = `Idle-${String(index).padStart(3, "0")}`;
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: rootSession,
				sessionFile: path.join(rootArtifactDir, `${id}.jsonl`),
				status: "idle",
				createdAt: index,
				lastActivity: index,
			});
		}
		const running = await createTranscript(cwd, rootArtifactDir, { task: "priority running worker" });
		const runningManager = track(await SessionManager.open(running.sessionFile));
		registry.register({
			id: running.id,
			displayName: running.id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(runningManager, { streaming: true }).session,
			sessionFile: running.sessionFile,
			status: "running",
		});

		await captureSubagentsForRestart(rootSession);
		const handoff = rootManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === "subagent_restart_handoff");
		expect(handoff?.type).toBe("custom");
		if (!handoff || handoff.type !== "custom") throw new Error("Expected durable restart handoff");
		const data = handoff.data as {
			children: Array<{ id: string; status: string }>;
			omittedChildren?: Array<{ id: string; reason: string }>;
		};
		expect(data.children).toHaveLength(256);
		expect(data.children[0]).toMatchObject({ id: running.id, status: "running" });
		expect(data.children.some(child => child.id === "Idle-256")).toBe(true);
		expect(data.children.some(child => child.id === "Idle-000")).toBe(false);
		expect(data.omittedChildren?.map(child => child.id).sort()).toEqual(["Idle-000", "Idle-001"]);
		expect(data.omittedChildren?.every(child => child.reason.includes("not revived"))).toBe(true);
		await Promise.all([runningManager.close(), rootManager.close()]);
	});

	it("closes an interrupted tool call and resumes the same child once", async () => {
		const cwd = makeTempDir("@pi-restart-pending-");
		const { manager: rootManager, file: rootFile } = await createRootSession(cwd, path.join(cwd, "sessions"));
		const child = await createTranscript(cwd, rootFile.slice(0, -".jsonl".length), { task: "pending task" });
		const registry = AgentRegistry.global();
		const rootSession = makeTestSession(rootManager);
		registerRoot(registry, rootSession.session, rootFile);
		const childManager = track(await SessionManager.open(child.sessionFile));
		registry.register({
			id: child.id,
			displayName: "Pending child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(childManager, { streaming: true }).session,
			sessionFile: child.sessionFile,
			status: "running",
		});
		await captureSubagentsForRestart(rootSession.session);
		await childManager.close();
		await appendUnfinishedToolCall(child.sessionFile);
		await rootManager.close();

		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const resumedRootManager = track(await SessionManager.open(rootFile));
		const resumedRoot = makeTestSession(resumedRootManager);
		const resumedRegistry = AgentRegistry.global();
		registerRoot(resumedRegistry, resumedRoot.session, rootFile);
		let reviveCalls = 0;
		const deliveries: IrcMessage[] = [];
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async ref => async () => {
				reviveCalls++;
				const manager = track(await SessionManager.open(ref.sessionFile!));
				const revived = makeTestSession(manager, {
					onDelivery: message => {
						deliveries.push(message);
						resumedRegistry.setStatus(ref.id, "running", revived.session);
					},
				});
				return revived.session;
			},
			() => 0,
		);

		const report = await restoreSubagentsAfterRestart(resumedRoot.session);
		expect(report.resumed).toEqual([child.id]);
		expect(report.pendingToolCalls).toEqual([]);
		expect(report.failures).toEqual([]);
		expect(reviveCalls).toBe(1);
		expect(deliveries).toHaveLength(1);
		expect(resumedRegistry.get(child.id)).toMatchObject({ status: "running" });
		const resumedChild = resumedRegistry.get(child.id)?.session;
		expect(resumedChild).toBeTruthy();
		const branch = await resumedChild!.getRestartBranchEntries();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		const interruption = branch.find(
			entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "pending-bash",
		);
		expect(interruption).toMatchObject({
			type: "message",
			message: { isError: true, details: { status: "interrupted" } },
		});
		const again = await restoreSubagentsAfterRestart(resumedRoot.session);
		expect(again.resumed).toEqual([child.id]);
		expect(deliveries).toHaveLength(1);
	});

	it("uses the latest terminal yield rather than a stale output artifact", async () => {
		const cwd = makeTempDir("@pi-restart-terminal-yield-");
		const { manager: rootManager, file: rootFile } = await createRootSession(cwd, path.join(cwd, "sessions"));
		const child = await createTranscript(cwd, rootFile.slice(0, -".jsonl".length), {
			task: "finished during restart",
		});
		await fs.writeFile(`${child.sessionFile.slice(0, -".jsonl".length)}.md`, "old successful output");
		const registry = AgentRegistry.global();
		const rootSession = makeTestSession(rootManager);
		registerRoot(registry, rootSession.session, rootFile);
		const childManager = track(await SessionManager.open(child.sessionFile));
		registry.register({
			id: child.id,
			displayName: "Yielded child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(childManager, { streaming: true }).session,
			sessionFile: child.sessionFile,
			status: "running",
		});
		await captureSubagentsForRestart(rootSession.session);
		await childManager.close();
		await appendTerminalYield(child.sessionFile);
		await rootManager.close();

		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const resumedRootManager = track(await SessionManager.open(rootFile));
		const resumedRoot = makeTestSession(resumedRootManager);
		const resumedRegistry = AgentRegistry.global();
		registerRoot(resumedRegistry, resumedRoot.session, rootFile);
		const revivalCalls: string[] = [];
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async ref => async () => {
				revivalCalls.push(ref.id);
				const manager = track(await SessionManager.open(ref.sessionFile!));
				return makeTestSession(manager).session;
			},
			() => 0,
		);

		const report = await restoreSubagentsAfterRestart(resumedRoot.session);
		expect(report.restoredIdle).toEqual([child.id]);
		expect(report.resumed).toEqual([]);
		expect(revivalCalls).toEqual([child.id]);
		expect(resumedRegistry.get(child.id)).toMatchObject({ status: "idle", displayName: "Yielded child" });
	});

	it("refuses a running child without a durable revivable contract before recording a handoff", async () => {
		const cwd = makeTempDir("@pi-restart-contract-");
		const { manager: rootManager, file: rootFile } = await createRootSession(cwd, path.join(cwd, "sessions"));
		const rootArtifactDir = rootFile.slice(0, -".jsonl".length);
		const noInit = await createTranscript(cwd, rootArtifactDir, { task: "missing init", includeInit: false });
		const isolated = await createTranscript(cwd, rootArtifactDir, { task: "isolated", isolated: true });
		const registry = AgentRegistry.global();
		const rootSession = makeTestSession(rootManager);
		registerRoot(registry, rootSession.session, rootFile);
		const noInitManager = track(await SessionManager.open(noInit.sessionFile));
		registry.register({
			id: noInit.id,
			displayName: "Missing contract",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(noInitManager, { streaming: true }).session,
			sessionFile: noInit.sessionFile,
			status: "running",
		});
		await expect(captureSubagentsForRestart(rootSession.session)).rejects.toThrow(/session_init/);
		expect(
			rootManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === "subagent_restart_handoff"),
		).toBe(false);
		registry.unregister(noInit.id);
		await noInitManager.close();
		const isolatedManager = track(await SessionManager.open(isolated.sessionFile));
		registry.register({
			id: isolated.id,
			displayName: "Isolated",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(isolatedManager, { streaming: true }).session,
			sessionFile: isolated.sessionFile,
			status: "running",
		});
		await captureSubagentsForRestart(rootSession.session);
		expect(await Bun.file(path.join(rootArtifactDir, `${isolated.id}.restart-isolation.json`)).json()).toMatchObject({
			id: isolated.id,
			cwd,
		});
	});
});

// The replacement process has no executor closure; only the durable marker and
// transcript can authorize revival of these isolated assignments.
it.each([
	{ id: "LateWorker", status: "running" as const, running: true },
	{ id: "IdleWorker", status: "idle" as const, running: false },
	{ id: "Adaptive60Mw3Levels-2", status: "parked" as const, running: true },
])("retains and resumes $id after dispose during drain without duplicate revival", async ({ id, status, running }) => {
	const cwd = makeTempDir("@pi-late-restart-worker-");
	const { manager, file } = await createRootSession(cwd, path.join(cwd, "sessions"));
	const root = makeTestSession(manager).session;
	registerRoot(AgentRegistry.global(), root, file);
	// The isolation snapshot pass has already finished with no children.
	await captureSubagentsForRestart(root);
	const child = await createTranscript(cwd, file.slice(0, -6), {
		task: "continue the unfinished assignment",
		isolated: true,
	});
	const childFile = path.join(file.slice(0, -6), `${id}.jsonl`);
	await fs.rename(child.sessionFile, childFile);
	const childManager = track(await SessionManager.open(childFile));
	childManager.appendCustomEntry("omp:restart-pending-queues", {
		steering: [],
		followUp: [],
		pendingNextTurn: [
			{
				role: "custom",
				customType: "restart-queued",
				content: "Restart claude-dc-lag5 is draining…",
				details: { requestId: "claude-dc-lag5", state: "draining" },
			},
		],
	});
	childManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "dispose",
		kind: "normal",
		recordedAt: "2026-11-06T15:08:39Z",
	});
	await childManager.flush();
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: status === "parked" ? null : makeTestSession(childManager).session,
		sessionFile: childFile,
		status,
	});
	await captureSubagentsForRestart(root, { runningAgentIds: new Set(running ? [id] : []) });
	expect(await readRestartIsolation(childFile, id)).toMatchObject({ id, cwd });
	await childManager.close();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerRoot(AgentRegistry.global(), root, file);
	let revivals = 0;
	const deliveries: IrcMessage[] = [];
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		async ref => {
			const retained = await readRestartIsolation(ref.sessionFile!, ref.id);
			if (retained?.id !== ref.id || retained.cwd !== cwd) return undefined;
			return async () => {
				revivals++;
				const reopened = track(await SessionManager.open(ref.sessionFile!));
				expect(
					reopened
						.getEntries()
						.find(entry => entry.type === "session_init" && entry.task === "continue the unfinished assignment"),
				).toBeDefined();
				expect(
					reopened
						.getEntries()
						.find(
							entry =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								entry.message.content === "Begin the durable assignment",
						),
				).toBeDefined();
				return makeTestSession(reopened, { onDelivery: message => deliveries.push(message) }).session;
			};
		},
		() => 0,
	);
	if (!running) {
		await ensurePersistedRoster(AgentRegistry.global(), file);
		expect(AgentRegistry.global().get(id)?.status).toBe("parked");
		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: "Continue the idle assignment" });
	}
	const report = await restoreSubagentsAfterRestart(root);
	expect(report.failures).toEqual([]);
	expect(running ? report.resumed : report.restoredIdle).toEqual([id]);
	await restoreSubagentsAfterRestart(root);
	await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: "Continue" });
	expect(revivals).toBe(1);
	expect(deliveries.filter(message => message.body.includes("persisted session_init"))).toHaveLength(running ? 1 : 0);
});

it("persists an unrevivable row as needing a worker with its previous transcript", async () => {
	const cwd = makeTempDir("@pi-restart-needs-worker-");
	const { manager, file } = await createRootSession(cwd, path.join(cwd, "sessions"));
	const root = makeTestSession(manager).session;
	registerRoot(AgentRegistry.global(), root, file);
	const child = await createTranscript(cwd, file.slice(0, -6), { task: "unfinished" });
	const live = track(await SessionManager.open(child.sessionFile));
	AgentRegistry.global().register({
		id: child.id,
		displayName: child.id,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: makeTestSession(live).session,
		sessionFile: child.sessionFile,
		status: "idle",
	});
	await captureSubagentsForRestart(root);
	await live.close();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerRoot(AgentRegistry.global(), root, file);
	let phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				Object.assign(
					{ content: "unfinished", status: "in_progress" as const },
					{ schedule: { owner: child.id, executor: { workerId: child.id, startedAt: 1 } } },
				),
			],
		},
	];
	Object.assign(root, {
		getTodoPhases: () => phases,
		commitTodoPhases: (next: TodoPhase[]) => {
			phases = next;
			manager.appendCustomEntry("user_todo_edit", { phases });
		},
	});
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		async () => undefined,
		() => 0,
	);
	const report = await restoreSubagentsAfterRestart(root);
	expect(report.failures.map(failure => failure.id)).toEqual([child.id]);
	expect(phases[0]!.tasks[0]).toMatchObject({
		status: "pending",
		schedule: { executor: { workerId: child.id, outcome: "failed" } },
	});
	expect(phases[0]!.tasks[0]!.notes).toEqual([expect.stringContaining(`previous=${child.id}; history://${child.id}`)]);
	const persisted = track(await SessionManager.open(file));
	expect(
		persisted.getEntries().findLast(entry => entry.type === "custom" && entry.customType === "user_todo_edit"),
	).toMatchObject({ data: { phases } });
});

it("reserves three restoring owners before revival and sends a short completion", async () => {
	const cwd = makeTempDir("@pi-restaff-");
	const { manager, file } = await createRootSession(cwd, path.join(cwd, "sessions"));
	const root = makeTestSession(manager).session;
	registerRoot(AgentRegistry.global(), root, file);
	const children: Transcript[] = [];
	for (let i = 0; i < 3; i++) {
		const child = await createTranscript(cwd, file.slice(0, -6), { task: `row ${i}` });
		children.push(child);
		AgentRegistry.global().register({
			id: child.id,
			displayName: child.id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeTestSession(track(await SessionManager.open(child.sessionFile)), { streaming: true }).session,
			sessionFile: child.sessionFile,
			status: "running",
		});
	}
	await captureSubagentsForRestart(root, { requestId: "restaff" });
	await Promise.all([...managers].map(value => value.close()));
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const successor = makeTestSession(track(await SessionManager.open(file))).session;
	successor.getTodoPhases = () => [
		{
			name: "Work",
			tasks: children.map((child, i) => ({
				content: `row ${i}`,
				status: "in_progress",
				schedule: { owner: child.id },
			})),
		},
	];
	registerRoot(AgentRegistry.global(), successor, file);
	const release = Promise.withResolvers<void>();
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		async ref => async () => {
			await release.promise;
			return makeTestSession(track(await SessionManager.open(ref.sessionFile!)), {
				streaming: true,
				onDelivery: () => {
					AgentRegistry.global().setStatus(ref.id, "running");
				},
			}).session;
		},
		() => 0,
	);
	const jobs = new AsyncJobManager({});
	const restoring = restoreSubagentsAfterRestart(successor, { requestId: "restaff" });
	const during = asyncJobSnapshot(jobs, MAIN_AGENT_ID).nonJobAgents;
	release.resolve();
	const report = await restoring;
	await sendRootContinuationOnce(successor, "restaff", report);
	const wake = successor.sessionManager
		.getEntries()
		.find(entry => entry.type === "custom_message" && entry.customType === "restart-root-continuation");
	const body = wake?.type === "custom_message" ? String(wake.content) : "";
	expect(body).toMatch(
		/^Restart restaff completed at \d{2}:\d{2}; build [a-f0-9]+; nothing pending — resume your plan\.$/,
	);
	expect(report.resumed.sort()).toEqual(children.map(child => child.id).sort());
	expect(
		during
			?.filter(agent => agent.live)
			.map(agent => agent.id)
			.sort(),
	).toEqual(children.map(child => child.id).sort());
	expect(
		asyncJobSnapshot(jobs, MAIN_AGENT_ID)
			.nonJobAgents?.filter(agent => agent.live)
			.map(agent => agent.id)
			.sort(),
	).toEqual(children.map(child => child.id).sort());
	await jobs.dispose();
});
