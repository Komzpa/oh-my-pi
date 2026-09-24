import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/hub";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	createRestartQueueController,
	type RestartControlIdentity,
	type RestartQueueController,
	type RestartRequestRecord,
} from "@oh-my-pi/pi-coding-agent/task/restart-queue";
import { captureSubagentsForRestart } from "@oh-my-pi/pi-coding-agent/task/restart-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

interface SessionHarness {
	session: AgentSession;
	deliveries: IrcMessage[];
	customMessages: Array<{ details?: { requestId?: string; state?: string } }>;
	notices: Array<{ level: string; message: string }>;
	drainCount: number;
	releaseCount: number;
}

interface SessionHarnessOptions {
	quiescence?: Promise<void>;
	wasRunning?: boolean;
	onDelivery?: (message: IrcMessage) => void;
	onCustomMessage?: (message: { details?: { requestId?: string; state?: string } }) => void | Promise<void>;
}

const managers = new Set<SessionManager>();
const tempDirs: TempDir[] = [];

function track(manager: SessionManager): SessionManager {
	managers.add(manager);
	return manager;
}

function makeTempDir(): string {
	const temp = TempDir.createSync("@pi-restart-queue-");
	tempDirs.push(temp);
	return temp.path();
}

async function createRoot(cwd: string): Promise<{ manager: SessionManager; file: string }> {
	const manager = track(SessionManager.create(cwd, path.join(cwd, "sessions")));
	manager.appendMessage({ role: "user", content: "Root restart test", timestamp: Date.now() });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a durable root session file");
	return { manager, file };
}

function makeSession(manager: SessionManager, options: SessionHarnessOptions = {}): SessionHarness {
	const deliveries: IrcMessage[] = [];
	const customMessages: SessionHarness["customMessages"] = [];
	const notices: SessionHarness["notices"] = [];
	let drainCount = 0;
	let releaseCount = 0;
	const session = {
		sessionManager: manager,
		isStreaming: false,
		beginRestartDrain: () => {
			drainCount++;
			let released = false;
			return {
				wasRunning: options.wasRunning ?? false,
				waitForQuiescence: () => options.quiescence ?? Promise.resolve(),
				release: () => {
					if (released) return;
					released = true;
					releaseCount++;
				},
			};
		},
		sendCustomMessage: async (message: { details?: { requestId?: string; state?: string } }) => {
			customMessages.push(message);
			await options.onCustomMessage?.(message);
		},
		deliverIrcMessage: async (message: IrcMessage) => {
			deliveries.push(message);
			options.onDelivery?.(message);
			return "woken" as const;
		},
		emitNotice: (level: string, message: string) => notices.push({ level, message }),
	} as unknown as AgentSession;
	return {
		session,
		deliveries,
		customMessages,
		notices,
		get drainCount() {
			return drainCount;
		},
		get releaseCount() {
			return releaseCount;
		},
	};
}

function registerRoot(registry: AgentRegistry, session: AgentSession, file: string): void {
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_AGENT_ID,
		kind: "main",
		session,
		sessionFile: file,
		status: "idle",
	});
}

function identityFor(manager: SessionManager, instanceId: string, generation: number): RestartControlIdentity {
	return { instanceId, sessionId: manager.getSessionId(), generation };
}

function coldRecord(identity: RestartControlIdentity, state: RestartRequestRecord["state"]): RestartRequestRecord {
	const now = Date.now();
	return {
		version: 1,
		requestId: "cold-restart-request",
		sessionId: identity.sessionId,
		state,
		requestedAt: now,
		updatedAt: now,
		rootWasRunning: true,
	};
}

async function appendQueueRecord(
	manager: SessionManager,
	identity: RestartControlIdentity,
	record: RestartRequestRecord,
): Promise<void> {
	manager.appendCustomEntry("restart_request_transition", { version: 1, identity, record });
	await manager.flush();
}

beforeEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const manager of managers) await manager.close().catch(() => {});
	managers.clear();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	await Promise.all(tempDirs.splice(0).map(temp => temp.remove()));
});

describe("restart queue controller", () => {
	it("rejects stale identities, deduplicates, and retries cancellation delivery before releasing a held drain", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const { promise: quiescence, resolve: releaseQuiescence } = Promise.withResolvers<void>();
		let failFirstCancelNotice = true;
		const harness = makeSession(manager, {
			quiescence,
			onCustomMessage: message => {
				if (message.details?.state === "cancelled" && failFirstCancelNotice) {
					failFirstCancelNotice = false;
					throw new Error("temporary delivery failure");
				}
			},
		});
		const identity = identityFor(manager, "queue-instance", 1);
		let restartCalls = 0;
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {
				restartCalls++;
			},
		});

		await expect(
			controller.handle({ identity: { ...identity, generation: 2 }, op: "request", requestId: "stale" }),
		).rejects.toThrow(/identity is stale/);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === "restart_request_transition"),
		).toHaveLength(0);

		const request = { identity, op: "request", requestId: "cancel-me", reason: "after this turn" } as const;
		const accepted = await controller.handle(request);
		const duplicate = await controller.handle(request);
		expect(accepted.request?.requestId).toBe("cancel-me");
		expect(duplicate.request?.requestId).toBe("cancel-me");
		expect(harness.drainCount).toBe(1);
		await expect(controller.handle({ ...request, reason: "different reason" })).rejects.toThrow(/already used/);

		const cancelRequest = { identity, op: "cancel", requestId: "cancel-me" } as const;
		await expect(controller.handle(cancelRequest)).rejects.toThrow(/cancellation notice could not be delivered/);
		expect(controller.snapshot().request?.state).toBe("cancelled");
		expect(harness.releaseCount).toBe(0);
		expect(restartCalls).toBe(0);

		const cancelled = await controller.handle(cancelRequest);
		expect(cancelled.request?.state).toBe("cancelled");
		expect(harness.releaseCount).toBe(1);
		expect(harness.customMessages.at(-1)?.details).toEqual({ requestId: "cancel-me", state: "cancelled" });
		expect(restartCalls).toBe(0);
		releaseQuiescence();
		controller.dispose();
	});

	it("restores the same child and root identities from a cold checkpoint exactly once", async () => {
		const cwd = makeTempDir();
		const { manager: oldRootManager, file: rootFile } = await createRoot(cwd);
		const rootArtifactDir = rootFile.slice(0, -".jsonl".length);
		const childManager = track(SessionManager.create(cwd, rootArtifactDir));
		childManager.appendSessionInit({
			systemPrompt: "Persisted child prompt",
			task: "Continue the original child assignment",
			tools: ["read", "yield"],
		});
		childManager.appendMessage({ role: "user", content: "Begin child work", timestamp: Date.now() });
		await childManager.ensureOnDisk();
		await childManager.flush();
		const childFile = childManager.getSessionFile();
		if (!childFile) throw new Error("Expected a durable child session file");
		const childId = childManager.getSessionId();
		const oldRoot = makeSession(oldRootManager);
		const oldRegistry = AgentRegistry.global();
		registerRoot(oldRegistry, oldRoot.session, rootFile);
		oldRegistry.register({
			id: childId,
			displayName: "Original child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeSession(childManager).session,
			sessionFile: childFile,
			status: "running",
		});
		await captureSubagentsForRestart(oldRoot.session);
		const oldIdentity = identityFor(oldRootManager, "old-instance", 4);
		await appendQueueRecord(oldRootManager, oldIdentity, coldRecord(oldIdentity, "checkpointed"));
		await Promise.all([oldRootManager.close(), childManager.close()]);

		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const rootManager = track(await SessionManager.open(rootFile));
		const rootDeliveries: IrcMessage[] = [];
		const rootHarness = makeSession(rootManager, { onDelivery: message => rootDeliveries.push(message) });
		const registry = AgentRegistry.global();
		registerRoot(registry, rootHarness.session, rootFile);
		registry.register({
			id: childId,
			displayName: "Original child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: childFile,
			status: "parked",
		});
		const childDeliveries: IrcMessage[] = [];
		const revivalIds: string[] = [];
		let revivedChildSessionId: string | undefined;
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async ref => {
			if (!ref.sessionFile) return undefined;
			return async () => {
				revivalIds.push(ref.id);
				const revivedManager = track(await SessionManager.open(ref.sessionFile!));
				revivedChildSessionId = revivedManager.getSessionId();
				const childHarness = makeSession(revivedManager, {
					onDelivery: message => {
						childDeliveries.push(message);
						registry.setStatus(ref.id, "running", childHarness.session);
					},
				});
				return childHarness.session;
			};
		}, 0);

		const currentIdentity = identityFor(rootManager, "new-instance", 5);
		const controller = createRestartQueueController({
			session: rootHarness.session,
			identity: () => currentIdentity,
			restart: async () => {},
		});
		await controller.restore();
		await controller.restore();

		expect(rootManager.getSessionId()).toBe(oldIdentity.sessionId);
		expect(revivedChildSessionId).toBe(childId);
		expect(revivalIds).toEqual([childId]);
		expect(registry.get(childId)).toMatchObject({ id: childId, status: "running", sessionFile: childFile });
		expect(childDeliveries).toHaveLength(1);
		expect(childDeliveries[0]).toMatchObject({ from: MAIN_AGENT_ID, to: childId });
		expect(rootDeliveries).toHaveLength(1);
		expect(rootDeliveries[0]).toMatchObject({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID });
		expect(controller.snapshot().request?.state).toBe("completed");
		controller.dispose();
	});

	it("does not replay a root continuation with only an unresolved durable claim", async () => {
		const cwd = makeTempDir();
		const { manager, file } = await createRoot(cwd);
		const harness = makeSession(manager);
		const registry = AgentRegistry.global();
		registerRoot(registry, harness.session, file);
		const identity = identityFor(manager, "restart-instance", 1);
		const record = coldRecord(identity, "completed");
		await appendQueueRecord(manager, identity, record);
		manager.appendCustomEntry("root_restart_continuation_receipt", {
			version: 1,
			rootSessionId: identity.sessionId,
			requestId: record.requestId,
			outcome: "continuation-claimed",
			recordedAt: Date.now(),
		});
		await manager.flush();
		const controller: RestartQueueController = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {},
		});

		await controller.restore();
		await controller.restore();

		expect(harness.deliveries).toHaveLength(0);
		const receipts = manager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "root_restart_continuation_receipt");
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			type: "custom",
			customType: "root_restart_continuation_receipt",
			data: { outcome: "continuation-claimed" },
		});
		expect(controller.snapshot().request?.state).toBe("completed");
		controller.dispose();
	});
});
