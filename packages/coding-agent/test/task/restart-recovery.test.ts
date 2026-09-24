import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import {
	captureSubagentsForRestart,
	restoreSubagentsAfterRestart,
} from "@oh-my-pi/pi-coding-agent/task/restart-recovery";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/hub";
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
			systemPrompt: "Persisted subagent prompt",
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
		get isStreaming() {
			return streaming;
		},
		deliverIrcMessage: async (message: IrcMessage) => {
			options?.onDelivery?.(message);
			return "woken" as const;
		},
		dispose: async () => manager.close(),
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

function registerRoot(registry: AgentRegistry, session: AgentSession, sessionFile: string, id = MAIN_AGENT_ID): void {
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
		const revived = new Map<string, TestSession>();
		const installReviver = (targetRegistry: AgentRegistry, calls: string[], sessions: Map<string, TestSession>) => {
			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async ref => {
				if (!ref.sessionFile) return undefined;
				return async () => {
					calls.push(ref.id);
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
			}, 0);
		};
		installReviver(freshRegistry, revivalCalls, revived);

		const first = await restoreSubagentsAfterRestart(freshRootSession.session);
		expect(first.resumed).toEqual([running.id]);
		expect(first.restoredIdle).toEqual([idle.id]);
		expect(first.parked).toEqual([parked.id]);
		expect(first.failures).toEqual([]);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toMatchObject({ from: MAIN_AGENT_ID, to: running.id });
		expect(deliveries[0]?.body).toContain("persisted session_init and conversation history");
		expect(revivalCalls).toEqual([running.id, idle.id]);
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
		expect(freshRegistry.get(parked.id)).toMatchObject({
			status: "parked",
			session: null,
			displayName: "Parked label",
		});
		expect(freshRegistry.get(tombstoned.id)?.status).toBe("aborted");
		expect(freshRegistry.get(tombstoned.id)?.session).toBeNull();
		expect(freshRegistry.get(otherChild.id)).toBe(sameOtherRef);

		const second = await restoreSubagentsAfterRestart(freshRootSession.session);
		expect(second.resumed).toEqual([running.id]);
		expect(second.restoredIdle).toEqual([idle.id]);
		expect(second.parked).toEqual([parked.id]);
		expect(deliveries).toHaveLength(1);
		expect(revivalCalls).toEqual([running.id, idle.id]);

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
		expect(third.restoredIdle).toEqual([running.id, idle.id]);
		expect(third.parked).toEqual([parked.id]);
		expect(third.failures).toEqual([]);
		expect(deliveries).toHaveLength(1);
		expect(thirdRevivalCalls).toEqual([running.id, idle.id]);
		expect(thirdRegistry.get(running.id)).toMatchObject({
			status: "idle",
			session: thirdRevived.get(running.id)?.session,
		});
		expect(thirdRegistry.get(idle.id)).toMatchObject({ status: "idle", session: thirdRevived.get(idle.id)?.session });
		expect(thirdRegistry.get(parked.id)).toMatchObject({ status: "parked", session: null });
	});

	it("leaves children with shutdown-pending tool calls parked and surfaces final-branch diagnostics", async () => {
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
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async () => {
			reviveCalls++;
			return undefined;
		}, 0);

		const report = await restoreSubagentsAfterRestart(resumedRoot.session);
		expect(report.pendingToolCalls).toHaveLength(1);
		expect(report.pendingToolCalls[0]?.calls).toMatchObject([{ toolName: "bash", toolCallId: "pending-bash" }]);
		expect(report.resumed).toEqual([]);
		expect(reviveCalls).toBe(0);
		expect(resumedRegistry.get(child.id)).toMatchObject({ status: "parked", session: null });
		expect(resumedRoot.notices).toHaveLength(1);
		expect(resumedRoot.notices[0]?.message).toContain("bash pending-bash");
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
			0,
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
		await expect(captureSubagentsForRestart(rootSession.session)).rejects.toThrow(/isolation/);
		expect(
			rootManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === "subagent_restart_handoff"),
		).toBe(false);
	});
});
