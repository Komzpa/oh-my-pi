import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRegistryApi, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	RestartBudget,
	createRestartQueueController,
	formatRestartRequestStatus,
	isRestartResumePending,
	restartNoticeText,
	type RestartControlIdentity,
	type RestartQueueController,
	type RestartRequestRecord,
} from "@oh-my-pi/pi-coding-agent/task/restart-queue";
import * as snapshotWorker from "@oh-my-pi/pi-coding-agent/task/restart-snapshot-worker";
import * as restartRecovery from "@oh-my-pi/pi-coding-agent/task/restart-recovery";
import { captureSubagentsForRestart } from "@oh-my-pi/pi-coding-agent/task/restart-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildSessionContext } from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";

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
	queuedInputCount?: number;
	abort?: AgentSession["abort"];
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
		getRestartPendingInputCount: () => options.queuedInputCount ?? 0,
		getRestartBranchEntries: async () => manager.getBranch(),
		flushRestartJournal: async () => {
			await manager.ensureOnDisk();
			await manager.flush();
		},
		reconcileRestartNotices: async () => {},
		agent: {
			getPendingModelNewsCount: () => options.queuedInputCount ?? 0,
		},
		isStreaming: options.wasRunning ?? false,
		abort: options.abort,
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
		sendRestartNotice: async (message: { details?: { requestId?: string; state?: string } }) => {
			await session.sendCustomMessage({ customType: "restart-queued", content: "", display: true, ...message });
		},
		sendCustomMessage: async (message: { details?: { requestId?: string; state?: string } }) => {
			customMessages.push(message);
			await options.onCustomMessage?.(message);
		},
		deliverRestartContinuation: async (requestId: string, content: string) => {
			manager.appendCustomMessageEntry("restart-root-continuation", content, true, { requestId });
			await manager.flush();
			options.onDelivery?.({ id: requestId, from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, body: content, ts: Date.now() });
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

function registerRoot(registry: AgentRegistryApi, session: AgentSession, file: string): void {
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
	it("freezes terminal stage elapsed while active stage elapsed keeps growing", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const identity = identityFor(manager, "elapsed-instance", 1);
		const base = {
			...coldRecord(identity, "restarting"),
			requestId: "active-elapsed",
			updatedAt: 2_000,
			drainStatus: {
				runningWorkers: [],
				queuedInputCount: 0,
				stage: "replace_runtime",
				stageStartedAt: 1_000,
			},
		};
		await appendQueueRecord(manager, identity, base);
		await appendQueueRecord(manager, identity, {
			...base,
			requestId: "terminal-elapsed",
			state: "completed",
		});
		const controller = createRestartQueueController({
			session: makeSession(manager).session,
			identity: () => identity,
			restart: async () => {},
		});
		const now = vi.spyOn(Date, "now");
		try {
			now.mockReturnValue(5_000);
			const firstTerminal = await controller.handle({ identity, op: "status", requestId: "terminal-elapsed" });
			const firstActive = await controller.handle({ identity, op: "status", requestId: "active-elapsed" });
			now.mockReturnValue(9_000);
			const secondTerminal = await controller.handle({ identity, op: "status", requestId: "terminal-elapsed" });
			const secondActive = await controller.handle({ identity, op: "status", requestId: "active-elapsed" });

			expect(firstTerminal.request?.drainStatus?.stageElapsedMs).toBe(1_000);
			expect(secondTerminal.request?.drainStatus?.stageElapsedMs).toBe(1_000);
			expect(firstActive.request?.drainStatus?.stageElapsedMs).toBe(4_000);
			expect(secondActive.request?.drainStatus?.stageElapsedMs).toBe(8_000);
			expect(formatRestartRequestStatus(firstTerminal.request, 5_000)).toBe(
				formatRestartRequestStatus(secondTerminal.request, 9_000),
			);
			expect(formatRestartRequestStatus(firstActive.request, 5_000)).not.toBe(
				formatRestartRequestStatus(secondActive.request, 9_000),
			);
		} finally {
			now.mockRestore();
			controller.dispose();
		}
	});

	it("reports restore_children as nonterminal until deferred child recovery settles", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const oldIdentity = identityFor(manager, "old-instance", 1);
		await appendQueueRecord(manager, oldIdentity, coldRecord(oldIdentity, "checkpointed"));
		const finished = Promise.withResolvers<restartRecovery.RestartRecoveryReport>();
		const recovery = vi
			.spyOn(restartRecovery, "restoreSubagentsAfterRestart")
			.mockImplementation(() => finished.promise);
		const harness = makeSession(manager, { queuedInputCount: 2 });
		const identity = identityFor(manager, "successor", 2);
		const states: RestartRequestRecord[] = [];
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {},
			deferChildren: true,
			onStateChange: record => states.push(record),
		});
		try {
			await controller.restore();
			const admitted = await controller.handle({ identity, op: "status" });
			expect(admitted.request).toMatchObject({
				state: "restarting",
				drainStatus: { stage: "restore_children", queuedInputCount: 2 },
			});
			expect(states.some(record => record.state === "completed")).toBe(false);
			expect(harness.customMessages.some(message => message.details?.state === "completed")).toBe(false);
			expect(harness.customMessages.at(-1)?.details?.state).toBe("restarting");

			const running = controller.resumeChildren();
			expect(recovery).toHaveBeenCalledTimes(1);
			expect((await controller.handle({ identity, op: "status" })).request?.state).toBe("restarting");
			finished.resolve({ resumed: [], restoredIdle: [], parked: [], pendingToolCalls: [], failures: [] });
			await running;

			expect((await controller.handle({ identity, op: "status" })).request?.state).toBe("completed");
			expect(states.at(-1)?.state).toBe("completed");
			expect(harness.customMessages.some(message => message.details?.state === "completed")).toBe(true);
		} finally {
			recovery.mockRestore();
			controller.dispose();
		}
	});

	it("finishes startup admission before deferred child recovery and starts recovery once", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const harness = makeSession(manager);
		const identity = identityFor(manager, "successor", 1);
		const finished = Promise.withResolvers<restartRecovery.RestartRecoveryReport>();
		const recovery = vi
			.spyOn(restartRecovery, "restoreSubagentsAfterRestart")
			.mockImplementation(() => finished.promise);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {},
			deferChildren: true,
		});
		try {
			await controller.restore();
			expect(recovery).not.toHaveBeenCalled();
			const running = controller.resumeChildren();
			await controller.handle({ identity, op: "status" });
			const again = controller.resumeChildren();
			expect(recovery).toHaveBeenCalledTimes(1);
			finished.resolve({ resumed: [], restoredIdle: [], parked: [], pendingToolCalls: [], failures: [] });
			await Promise.all([running, again]);
		} finally {
			recovery.mockRestore();
			controller.dispose();
		}
	});

	it("reserves downstream work before assigning a wait deadline", () => {
		const budget = new RestartBudget(10_000, [
			{ stage: "isolation", estimateMs: 5_000 },
			{ stage: "snapshot_isolation", estimateMs: 2_000 },
			{ stage: "capture_children", estimateMs: 500 },
			{ stage: "flush", estimateMs: 500 },
			{ stage: "replace_runtime", estimateMs: 1_000 },
			{ stage: "restore_children", estimateMs: 1_000 },
		]);
		expect(budget.stageDeadline("isolation")).toBe(5_000);
		expect(budget.stageDeadline("capture_children")).toBe(7_500);
		expect(budget.stageDeadline("restore_children")).toBe(10_000);
	});

	it("reports the stage that overruns the global watchdog without interrupting the root", async () => {
		const { manager, file } = await createRoot(makeTempDir());
		const boundary = Promise.withResolvers<void>();
		const harness = makeSession(manager, { wasRunning: true, quiescence: boundary.promise });
		registerRoot(AgentRegistry.global(), harness.session, file);
		const identity = identityFor(manager, "watchdog", 1);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {},
			restartTotalMs: 50,
			restartWatchdogSlackMs: 10,
		});
		try {
			await controller.handle({ identity, op: "request" });
			await Bun.sleep(100);
			expect(controller.snapshot().request?.state).toBe("queued");
			expect(harness.notices.some(item => item.message.includes("watchdog: stage root_quiescence"))).toBe(true);
			const status = formatRestartRequestStatus(controller.snapshot().request);
			expect(status).toContain("deadline:");
			expect(status).toContain("reserved remaining work:");
			await controller.handle({ identity, op: "cancel" });
			expect(harness.releaseCount).toBe(1);
		} finally {
			controller.dispose();
			boundary.resolve();
		}
	});

	it("queued restart advances when recorded workers are dead and live set is empty", async () => {
		const { manager, file } = await createRoot(makeTempDir());
		const childManager = track(SessionManager.create(manager.getCwd(), file.slice(0, -".jsonl".length)));
		childManager.appendSessionInit({ systemPrompt: ["worker"], task: "work", tools: [] });
		await childManager.ensureOnDisk();
		const rootQuiescence = Promise.withResolvers<void>();
		const harness = makeSession(manager, { quiescence: rootQuiescence.promise });
		const childNoticeStarted = Promise.withResolvers<void>();
		const childNotice = Promise.withResolvers<void>();
		const staleChildQuiescence = Promise.withResolvers<void>();
		const childHarness = makeSession(childManager, { quiescence: staleChildQuiescence.promise, wasRunning: true });
		childHarness.session.sendRestartNotice = async () => {
			childNoticeStarted.resolve();
			await childNotice.promise;
		};
		const registry = AgentRegistry.global();
		registerRoot(registry, harness.session, file);
		const childRef = registry.register({
			id: childManager.getSessionId(),
			displayName: "RecordedWorker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: childHarness.session,
			sessionFile: childManager.getSessionFile(),
			status: "running",
		});
		const identity = identityFor(manager, "dead-workers", 1);
		const terminal = Promise.withResolvers<RestartRequestRecord>();
		let restarts = 0;
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {
				restarts++;
			},
			onStateChange: record => {
				if (record.state === "completed" || record.state === "failed") terminal.resolve(record);
			},
		});
		try {
			await controller.handle({ identity, op: "request", requestId: "dead-workers" });
			await childNoticeStarted.promise;
			registry.unregister(childRef.id, childRef);
			childNotice.resolve();
			await Bun.sleep(25);
			expect(restarts).toBe(0);
			rootQuiescence.resolve();
			const result = await Promise.race([terminal.promise, Bun.sleep(250).then(() => undefined)]);
			expect(result?.state).toBe("completed");
			expect(restarts).toBe(1);
		} finally {
			controller.dispose();
			rootQuiescence.resolve();
			staleChildQuiescence.resolve();
		}
	});

	it("uses recent replacement duration to reserve more work on the next request", async () => {
		const { manager, file } = await createRoot(makeTempDir());
		const harness = makeSession(manager);
		registerRoot(AgentRegistry.global(), harness.session, file);
		const identity = identityFor(manager, "estimates", 1);
		let terminal = Promise.withResolvers<void>();
		const reserves: number[] = [];
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restartTotalMs: 10_000,
			restartStageMinimaMs: { replace_runtime: 0 },
			restart: async () => {
				await Bun.sleep(40);
			},
			onStateChange: record => {
				if (record.drainStatus?.stage === "capture_children")
					reserves.push(record.drainStatus.remainingEstimateMs!);
				if (record.state === "completed") terminal.resolve();
			},
		});
		try {
			await controller.handle({ identity, op: "request", requestId: "first" });
			await terminal.promise;
			await Bun.sleep(10);
			terminal = Promise.withResolvers<void>();
			await controller.handle({ identity, op: "request", requestId: "second" });
			await terminal.promise;
			expect(reserves[1]! - reserves[0]!).toBeGreaterThanOrEqual(35);
		} finally {
			controller.dispose();
		}
	});

	it.each(["boundary", "expiry", "cancel"] as const)(
		"keeps a busy root intact through %s and restarts only at its boundary",
		async outcome => {
			const { manager, file } = await createRoot(makeTempDir());
			const boundary = Promise.withResolvers<void>();
			let aborts = 0;
			const harness = makeSession(manager, {
				wasRunning: true,
				quiescence: boundary.promise,
				abort: async () => {
					aborts++;
				},
			});
			registerRoot(AgentRegistry.global(), harness.session, file);
			const identity = identityFor(manager, "busy-root", 1);
			const waiting = Promise.withResolvers<void>();
			const expired = Promise.withResolvers<void>();
			const terminal = Promise.withResolvers<RestartRequestRecord>();
			let restarts = 0;
			const controller = createRestartQueueController({
				session: harness.session,
				identity: () => identity,
				restartWorkerGraceMs: 5,
				restartWorkerAbortGraceMs: 1_000,
				restartRootQuiescenceMs: outcome === "boundary" ? 70_000 : 10,
				restart: async () => {
					restarts++;
				},
				onStateChange: record => {
					if (record.drainStatus?.stage === "root_quiescence") {
						waiting.resolve();
						if (record.state === "queued") expired.resolve();
					}
					if (["completed", "failed", "cancelled"].includes(record.state)) terminal.resolve(record);
				},
			});
			try {
				if (outcome === "boundary") vi.useFakeTimers();
				await controller.handle({ identity, op: "request", requestId: "busy-root" });
				await waiting.promise;
				if (outcome === "boundary") {
					vi.advanceTimersByTime(60_000);
					vi.useRealTimers();
					await Bun.sleep(50);
				} else await expired.promise;
				expect(restarts).toBe(0);
				expect(aborts).toBe(0);
				expect(controller.snapshot().request?.state).toBe(outcome === "boundary" ? "draining" : "queued");
				expect(formatRestartRequestStatus(controller.snapshot().request)).toContain("Waiting for the lead's turn");
				if (outcome === "cancel") {
					const cancelled = await controller.handle({ identity, op: "cancel", requestId: "busy-root" });
					expect(cancelled.request?.state).toBe("cancelled");
					expect(harness.releaseCount).toBe(1);
				}
				boundary.resolve();
				expect((await terminal.promise).state).toBe(outcome === "cancel" ? "cancelled" : "completed");
				await Bun.sleep(10);
				expect(restarts).toBe(outcome === "cancel" ? 0 : 1);
			} finally {
				vi.useRealTimers();
				controller.dispose();
				boundary.resolve();
			}
		},
		75_000,
	);

	it("restores the goal captured before a failed restart after relaunch", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const oldIdentity = identityFor(manager, "old-instance", 1);
		const record = { ...coldRecord(oldIdentity, "failed"), goalModeBefore: { goalId: "goal-1" } };
		await appendQueueRecord(manager, oldIdentity, record);
		const harness = makeSession(manager);
		registerRoot(AgentRegistry.global(), harness.session, manager.getSessionFile()!);
		const restored: string[] = [];
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identityFor(manager, "new-instance", 2),
			restart: async () => {},
			restoreGoalMode: async snapshot => {
				restored.push(snapshot.goalId);
			},
		});

		await controller.restore();

		expect(restored).toEqual(["goal-1"]);
		expect(controller.snapshot().request).toMatchObject({ state: "failed", goalModeBefore: { goalId: "goal-1" } });
		controller.dispose();
	});

	it("licenses active-goal startup only from a previous process checkpoint", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const oldIdentity = identityFor(manager, "old-instance", 1);
		const nextIdentity = identityFor(manager, "next-instance", 1);
		await appendQueueRecord(manager, oldIdentity, coldRecord(oldIdentity, "draining"));
		expect(isRestartResumePending(manager, manager.getSessionId(), nextIdentity.instanceId)).toBe(false);
		await appendQueueRecord(manager, oldIdentity, coldRecord(oldIdentity, "restarting"));
		expect(isRestartResumePending(manager, manager.getSessionId(), nextIdentity.instanceId)).toBe(true);
		expect(isRestartResumePending(manager, manager.getSessionId(), oldIdentity.instanceId)).toBe(false);
		await appendQueueRecord(manager, nextIdentity, coldRecord(nextIdentity, "failed"));
		expect(isRestartResumePending(manager, manager.getSessionId(), "third-instance")).toBe(false);
	});
	it("recovers a restart through the metadata index when historical message payloads cannot be loaded", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const identity = identityFor(manager, "old-instance", 1);
		await appendQueueRecord(manager, identity, coldRecord(identity, "restarting"));
		const source = {
			getBranch(): SessionEntry[] {
				throw new Error("Historical message payloads must remain unloaded during restart detection");
			},
			getBranchMatching(predicate: (metadata: { type: SessionEntry["type"]; customType?: string }) => boolean) {
				expect(predicate({ type: "message" })).toBe(false);
				return manager.getBranch().filter(entry =>
					predicate({
						type: entry.type,
						customType: entry.type === "custom" ? entry.customType : undefined,
					}),
				);
			},
		};
		expect(isRestartResumePending(source, manager.getSessionId(), "new-instance")).toBe(true);
		await appendQueueRecord(manager, identity, coldRecord(identity, "completed"));
		expect(isRestartResumePending(source, manager.getSessionId(), "new-instance")).toBe(false);
	});
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
		const restoredGoals: string[] = [];
		const identity = identityFor(manager, "queue-instance", 1);
		let restartCalls = 0;
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {
				restartCalls++;
			},
			captureGoalMode: () => ({ goalId: "goal-cancel" }),
			restoreGoalMode: async snapshot => {
				restoredGoals.push(snapshot.goalId);
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
		expect(restartNoticeText(manager.getBranch(), "cancel-me")).toBe("Restart cancelled");
		expect(harness.releaseCount).toBe(1);
		expect(harness.customMessages.at(-1)?.details).toEqual({ requestId: "cancel-me", state: "cancelled" });
		expect(restartCalls).toBe(0);
		expect(restoredGoals).toEqual(["goal-cancel"]);
		releaseQuiescence();
		controller.dispose();
	});

	it("reports running workers and queued input in restart drain status", async () => {
		const cwd = makeTempDir();
		const { manager, file } = await createRoot(cwd);
		const rootHarness = makeSession(manager, { queuedInputCount: 1 });
		const registry = AgentRegistry.global();
		registerRoot(registry, rootHarness.session, file);
		const childHarness = makeSession(manager, { wasRunning: true });
		registry.register({
			id: "worker-capture",
			displayName: "CaptureWatch",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: childHarness.session,
			sessionFile: null,
			status: "running",
			createdAt: 1_000,
		});
		const identity = identityFor(manager, "queue-instance", 1);
		const controller = createRestartQueueController({
			session: rootHarness.session,
			identity: () => identity,
			restart: async () => {},
		});

		const snapshot = await controller.handle({ identity, op: "request", requestId: "status-request" });

		expect(snapshot.request?.drainStatus).toMatchObject({
			runningWorkers: [{ id: "worker-capture", name: "CaptureWatch", startedAt: 1_000 }],
			queuedInputCount: 1,
		});
		expect(formatRestartRequestStatus(snapshot.request, 721_000)).toContain(
			"Restart waiting for 1 worker: CaptureWatch 12m; 1 queued input.",
		);
		expect(
			formatRestartRequestStatus(
				{
					...snapshot.request!,
					drainStatus: { ...snapshot.request!.drainStatus!, workerGraceDeadlineAt: 724_000 },
				},
				721_000,
			),
		).toContain("Restart waiting up to 3.0s for 1 worker to reach a safe point: CaptureWatch 12m; 1 queued input.");
		controller.dispose();
	});

	it.each([true, false])("restores the same child once when rootWasRunning=%s", async rootWasRunning => {
		const cwd = makeTempDir();
		const { manager: oldRootManager, file: rootFile } = await createRoot(cwd);
		const rootArtifactDir = rootFile.slice(0, -".jsonl".length);
		const childManager = track(SessionManager.create(cwd, rootArtifactDir));
		childManager.appendSessionInit({
			systemPrompt: ["Persisted child prompt"],
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
		const oldIdentity = identityFor(oldRootManager, "old-instance", 4);
		const completedRequest = { ...coldRecord(oldIdentity, "checkpointed"), rootWasRunning };
		await captureSubagentsForRestart(oldRoot.session, { requestId: completedRequest.requestId });
		await appendQueueRecord(oldRootManager, oldIdentity, completedRequest);
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
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async ref => {
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
			},
			() => 0,
		);

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
		expect(restartNoticeText(rootManager.getBranch(), "cold-restart-request")).toBe("Restarted");
		controller.dispose();
	});

	it.each([false, true])("checkpoints workers within their original grace window (slow root: %s)", async slowRoot => {
		const cwd = makeTempDir();
		const { manager: oldRootManager, file: rootFile } = await createRoot(cwd);
		const rootArtifactDir = rootFile.slice(0, -".jsonl".length);
		const registry = AgentRegistry.global();
		const rootDrain = Promise.withResolvers<void>();
		if (!slowRoot) rootDrain.resolve();
		const rootHarness = makeSession(oldRootManager, { quiescence: rootDrain.promise });
		registerRoot(registry, rootHarness.session, rootFile);
		const hangingManager = track(SessionManager.create(cwd, rootArtifactDir));
		hangingManager.appendSessionInit({
			systemPrompt: ["Persisted child prompt"],
			task: "Continue the hung child assignment",
			tools: ["read", "yield"],
		});
		hangingManager.appendMessage({ role: "user", content: "Begin hung child work", timestamp: Date.now() });
		await hangingManager.ensureOnDisk();
		await hangingManager.flush();
		const hangingFile = hangingManager.getSessionFile();
		if (!hangingFile) throw new Error("Expected a durable hung child session file");
		const hangingId = hangingManager.getSessionId();
		const writingManager = track(SessionManager.create(cwd, rootArtifactDir));
		writingManager.appendSessionInit({
			systemPrompt: ["Persisted child prompt"],
			task: "Finish the short child write",
			tools: ["read", "yield"],
		});
		writingManager.appendMessage({ role: "user", content: "Begin short child work", timestamp: Date.now() });
		await writingManager.ensureOnDisk();
		await writingManager.flush();
		const writingFile = writingManager.getSessionFile();
		if (!writingFile) throw new Error("Expected a durable writing child session file");
		const writePath = path.join(cwd, "child-write.txt");
		await fs.writeFile(writePath, "partial");
		const { promise: hungQuiescence, resolve: settleHungQuiescence } = Promise.withResolvers<void>();
		const writingQuiescence = (async () => {
			await Bun.sleep(5);
			await fs.writeFile(writePath, "complete");
		})();
		registry.register({
			id: hangingId,
			displayName: "Hung child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeSession(hangingManager, {
				wasRunning: true,
				quiescence: hungQuiescence,
				abort: async () => {
					settleHungQuiescence();
				},
			}).session,
			sessionFile: hangingFile,
			status: "running",
		});
		registry.register({
			id: writingManager.getSessionId(),
			displayName: "Writing child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeSession(writingManager, { wasRunning: true, quiescence: writingQuiescence }).session,
			sessionFile: writingFile,
			status: "running",
		});
		const identity = identityFor(oldRootManager, "restart-instance", 1);
		const restartCalled = Promise.withResolvers<void>();
		let graceDeadline: number | undefined;
		const controller = createRestartQueueController({
			onStateChange: record => {
				graceDeadline ??= record.drainStatus?.workerGraceDeadlineAt;
			},
			session: rootHarness.session,
			identity: () => identity,
			restartWorkerGraceMs: 25,
			restart: async () => {
				expect(await fs.readFile(writePath, "utf8")).toBe("complete");
				restartCalled.resolve();
			},
		});

		await controller.handle({ identity, op: "request", requestId: "worker-grace" });
		if (slowRoot) await Bun.sleep(50);
		const rootReleasedAt = Date.now();
		rootDrain.resolve();
		await expect(
			Promise.race([restartCalled.promise, Bun.sleep(250).then(() => "timed out" as const)]),
		).resolves.toBe(undefined);

		const handoff = oldRootManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === "subagent_restart_handoff");
		expect(handoff?.type).toBe("custom");
		if (!handoff || handoff.type !== "custom") throw new Error("Expected durable restart handoff");
		// Persisted JSON shape: demand-loaded entries may be mutation-tracking proxies.
		const children = (
			JSON.parse(JSON.stringify(handoff.data)) as {
				children: Array<{ id: string; sessionFile: string; status: string }>;
			}
		).children;
		expect(children).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: hangingId, sessionFile: path.resolve(hangingFile), status: "running" }),
				expect.objectContaining({
					id: writingManager.getSessionId(),
					sessionFile: path.resolve(writingFile),
					status: "running",
				}),
			]),
		);
		if (slowRoot) {
			expect(graceDeadline).toBeNumber();
			expect(graceDeadline!).toBeLessThanOrEqual(rootReleasedAt);
		}
		controller.dispose();
	});

	it("does not replay an older worker handoff after a later restart request failed", async () => {
		const cwd = makeTempDir();
		const { manager: oldRootManager, file: rootFile } = await createRoot(cwd);
		const rootArtifactDir = rootFile.slice(0, -".jsonl".length);
		const childManager = track(SessionManager.create(cwd, rootArtifactDir));
		childManager.appendSessionInit({
			systemPrompt: ["Persisted child prompt"],
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
		const registry = AgentRegistry.global();
		registerRoot(registry, oldRoot.session, rootFile);
		registry.register({
			id: childId,
			displayName: "Older child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeSession(childManager).session,
			sessionFile: childFile,
			status: "running",
		});
		const oldIdentity = identityFor(oldRootManager, "old-instance", 1);
		await captureSubagentsForRestart(oldRoot.session, { requestId: "older-success" });
		await appendQueueRecord(oldRootManager, oldIdentity, {
			...coldRecord(oldIdentity, "failed"),
			requestId: "new-failed-request",
		});
		await Promise.all([oldRootManager.close(), childManager.close()]);

		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const manager = track(await SessionManager.open(rootFile));
		const harness = makeSession(manager);
		const freshRegistry = AgentRegistry.global();
		registerRoot(freshRegistry, harness.session, rootFile);
		const revivalIds: string[] = [];
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async ref => {
				if (ref.id !== childId || !ref.sessionFile) return undefined;
				return async () => {
					revivalIds.push(ref.id);
					return makeSession(track(await SessionManager.open(ref.sessionFile!))).session;
				};
			},
			() => 0,
		);

		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identityFor(manager, "new-instance", 2),
			restart: async () => {},
		});
		await controller.restore();

		expect(revivalIds).toEqual([]);
		expect(harness.deliveries).toEqual([]);
		expect(controller.snapshot().request).toMatchObject({ requestId: "new-failed-request", state: "failed" });
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
	function mirrorCustomToBranch(manager: SessionManager) {
		return (message: { details?: { requestId?: string; state?: string } }) => {
			const payload = message as unknown as {
				customType?: string;
				content?: string;
				display?: boolean;
				details?: unknown;
			};
			manager.appendCustomMessageEntry(payload.customType, payload.content, payload.display, payload.details);
		};
	}

	function restartQueuedBranchTexts(manager: SessionManager): string[] {
		return manager
			.getBranch()
			.filter(entry => entry.type === "custom_message" && entry.customType === "restart-queued")
			.map(entry => String(entry.type === "custom_message" ? (entry.content ?? "") : ""));
	}

	function customMessageTexts(harness: Pick<SessionHarness, "customMessages">, requestId: string): string[] {
		return harness.customMessages
			.map(message => message as unknown as { details?: { requestId?: string }; content?: unknown })
			.filter(message => message.details?.requestId === requestId)
			.map(message =>
				typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
			);
	}

	it("completed restart supersedes queued notice in context", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const requestId = "supersede-me";
		const { promise: terminalSeen, resolve: onTerminal } = Promise.withResolvers<void>();
		const harness = makeSession(manager, {
			onCustomMessage: message => {
				mirrorCustomToBranch(manager)(message);
				const payload = message as unknown as { details?: { requestId?: string; state?: string } };
				if (payload.details?.requestId === requestId && payload.details?.state === "completed") onTerminal();
			},
		});
		const identity = identityFor(manager, "notice-instance", 1);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {},
		});

		await controller.handle({ identity, op: "request", requestId, reason: "test supersede" });
		// Await the terminal notice event itself: no wall-clock wait, the drain resolves it.
		await terminalSeen;
		manager.appendMessage({ role: "user", content: "next work after restart", timestamp: Date.now() });
		const texts = restartQueuedBranchTexts(manager);

		expect(texts.length).toBeGreaterThanOrEqual(2);
		expect(texts[0]).toContain(requestId);
		expect(texts[0]).toMatch(/do not start another model turn/i);
		const last = texts.at(-1) ?? "";
		expect(last).toContain(requestId);
		expect(last).toMatch(/complet/i);
		expect(last).toMatch(/no longer applies|resume normal work/i);
		expect(last).not.toMatch(/do not start another model turn/i);
		controller.dispose();
	});

	it("a request still queued keeps the restriction", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const { promise: quiescence } = Promise.withResolvers<void>();
		const harness = makeSession(manager, { quiescence });
		const identity = identityFor(manager, "queued-instance", 1);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {},
		});

		// The queued notice is pushed synchronously during handle(), before it resolves.
		await controller.handle({ identity, op: "request", requestId: "still-queued", reason: "stall" });
		const texts = customMessageTexts(harness, "still-queued");
		expect(texts.length).toBeGreaterThanOrEqual(1);
		expect(texts[0]).toContain("still-queued");
		expect(texts[0]).toMatch(/do not start another model turn/i);
		controller.dispose();
	});

	it("cancelled restart clears the restriction", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const { promise: quiescence } = Promise.withResolvers<void>();
		const harness = makeSession(manager, { quiescence });
		const identity = identityFor(manager, "cancel-instance", 1);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {},
		});

		await controller.handle({ identity, op: "request", requestId: "cancel-clear", reason: "stall" });
		// Cancel awaits notice delivery before resolving, so the notice is captured here.
		await controller.handle({ identity, op: "cancel", requestId: "cancel-clear" });
		const texts = customMessageTexts(harness, "cancel-clear");
		const last = texts.at(-1) ?? "";
		expect(last).toContain("cancel-clear");
		expect(last).toMatch(/cancel/i);
		expect(last).toMatch(/no longer applies|resume normal work/i);
		expect(last).not.toMatch(/do not start another model turn/i);
		controller.dispose();
	});

	it("a different requestId completion does not clear a queued request", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const { promise: terminalSeen, resolve: onTerminal } = Promise.withResolvers<void>();
		const harness = makeSession(manager, {
			onCustomMessage: message => {
				const payload = message as unknown as { details?: { requestId?: string; state?: string } };
				if (payload.details?.requestId === "first-done" && payload.details?.state === "completed") onTerminal();
			},
		});
		const identity = identityFor(manager, "scoped-instance", 1);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identity,
			restart: async () => {},
		});

		await controller.handle({ identity, op: "request", requestId: "first-done", reason: "fast" });
		await terminalSeen;
		const { promise: quiescence } = Promise.withResolvers<void>();
		const stalled = makeSession(manager, { quiescence });
		const second = createRestartQueueController({
			session: stalled.session,
			identity: () => identity,
			restart: async () => {},
		});
		await second.handle({ identity, op: "request", requestId: "other-request", reason: "stall" });
		for (const text of customMessageTexts(harness, "first-done")) {
			expect(text).not.toContain("other-request");
		}
		const otherTexts = customMessageTexts(stalled, "other-request");
		expect(otherTexts.length).toBeGreaterThanOrEqual(1);
		expect(otherTexts.at(-1) ?? "").toMatch(/do not start another model turn/i);
		controller.dispose();
		second.dispose();
	});

	it("keeps queued and completed notices distinct for the same completed request", async () => {
		const { manager } = await createRoot(makeTempDir());
		const identity = identityFor(manager, "notice-instance", 1);
		const record = coldRecord(identity, "completed");
		await appendQueueRecord(manager, identity, record);
		expect(restartNoticeText(manager.getBranch(), record.requestId, "queued")).toBe("Restart queued");
		expect(restartNoticeText(manager.getBranch(), record.requestId, "draining")).toBe("Restart draining");
		expect(restartNoticeText(manager.getBranch(), record.requestId, "completed")).toBe("Restarted");
		// Older notices did not store their own state and still resolve from the journal.
		expect(restartNoticeText(manager.getBranch(), record.requestId)).toBe("Restarted");
	});

	it.each([true, false])("restore emits completion once (queued notice: %s)", async hasQueuedNotice => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const oldIdentity = identityFor(manager, "old-instance", 1);
		const requestId = "restored-done";
		const now = Date.now();
		await appendQueueRecord(manager, oldIdentity, {
			version: 1,
			requestId,
			sessionId: oldIdentity.sessionId,
			state: "completed",
			requestedAt: now,
			updatedAt: now,
			rootWasRunning: false,
		});
		if (hasQueuedNotice)
			manager.appendCustomMessageEntry(
				"restart-queued",
				`Restart ${requestId} is queued. Do not start another model turn until it completes.`,
				true,
				{ requestId, state: "queued" },
			);
		await manager.flush();
		const harness = makeSession(manager);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identityFor(manager, "new-instance", 2),
			restart: async () => {},
		});

		await controller.restore();
		await controller.restore();

		const texts = customMessageTexts(harness, requestId);
		expect(harness.customMessages.map(message => message.details?.state)).toEqual(["restarting", "completed"]);
		expect(texts).toHaveLength(2);
		expect(texts[1]).toContain(requestId);
		expect(texts[1]).toMatch(/complet/i);
		expect(texts[1]).toMatch(/no longer applies|resume normal work/i);
		expect(texts[1]).not.toMatch(/do not start another model turn/i);
		controller.dispose();
	});
	it.each(["checkpointed", "restarting"] as const)(
		"does not claim completion after a manual resume of %s",
		async state => {
			const { manager } = await createRoot(makeTempDir());
			const oldIdentity = identityFor(manager, "old-instance", 1);
			await appendQueueRecord(manager, oldIdentity, coldRecord(oldIdentity, state));
			const harness = makeSession(manager);
			const controller = createRestartQueueController({
				session: harness.session,
				identity: () => identityFor(manager, "manual-resume", 2),
				restart: async () => {},
				restartSuccessor: false,
			});
			await controller.restore();
			expect(controller.snapshot().request?.state).toBe("failed");
			expect(harness.customMessages.map(message => message.details?.state)).toEqual(["failed"]);
			expect(customMessageTexts(harness, controller.snapshot().request!.requestId)[0]).not.toContain(" completed;");
			controller.dispose();
		},
	);
	it.each(["failed", "queued"] as const)("does not claim completion for a %s restart", async state => {
		const { manager } = await createRoot(makeTempDir());
		const oldIdentity = identityFor(manager, "old-instance", 1);
		await appendQueueRecord(manager, oldIdentity, coldRecord(oldIdentity, state));
		const harness = makeSession(manager);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identityFor(manager, "new-instance", 2),
			restart: async () => {},
		});
		await controller.restore();
		expect(controller.snapshot().request?.state).toBe("failed");
		expect(harness.customMessages.map(message => message.details?.state)).toEqual(["failed"]);
		expect(harness.deliveries).toEqual([]);
		controller.dispose();
	});
	it.each([true, false])("queues completion before continuation (queued notice: %s)", async hasQueuedNotice => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const oldIdentity = identityFor(manager, "instance-X", 1);
		const requestId = "notice-before-continuation";
		const now = Date.now();
		for (const state of ["queued", "draining", "checkpointed", "restarting"] as const) {
			await appendQueueRecord(manager, oldIdentity, {
				version: 1,
				requestId,
				sessionId: oldIdentity.sessionId,
				state,
				requestedAt: now,
				updatedAt: now,
				rootWasRunning: true,
			});
		}
		if (hasQueuedNotice)
			manager.appendCustomMessageEntry(
				"restart-queued",
				`Restart ${requestId} is queued. Do not start another model turn until it completes.`,
				true,
				{ requestId, state: "queued" },
			);
		await manager.flush();
		const order: string[] = [];
		const harness = makeSession(manager, {
			onCustomMessage: message => {
				order.push(`notice:${message.details?.state}`);
			},
			onDelivery: () => {
				order.push("continuation");
			},
		});
		registerRoot(AgentRegistry.global(), harness.session, manager.getSessionFile()!);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identityFor(manager, "instance-Y", 2),
			restart: async () => {},
		});
		await controller.restore();
		expect(order).toEqual(["notice:restarting", "notice:completed", "continuation"]);
		controller.dispose();
	});

	it("cross-instance restore appends the terminal notice to the live next-turn list", async () => {
		const cwd = makeTempDir();
		const { manager } = await createRoot(cwd);
		const oldIdentity = identityFor(manager, "instance-X", 1);
		const requestId = "cross-instance-done";
		const now = Date.now();
		for (const state of ["queued", "draining", "checkpointed", "restarting"] as const) {
			await appendQueueRecord(manager, oldIdentity, {
				version: 1,
				requestId,
				sessionId: oldIdentity.sessionId,
				state,
				requestedAt: now,
				updatedAt: now,
				rootWasRunning: false,
			});
		}
		manager.appendCustomMessageEntry(
			"restart-queued",
			`Restart ${requestId} is queued. Do not start another model turn until it completes.`,
			true,
			{ requestId, state: "queued" },
		);
		await manager.flush();
		const harness = makeSession(manager);
		const controller = createRestartQueueController({
			session: harness.session,
			identity: () => identityFor(manager, "instance-Y", 2),
			restart: async () => {},
		});
		await controller.restore();
		await controller.restore();
		const texts = customMessageTexts(harness, requestId);
		expect(harness.customMessages.map(message => message.details?.state)).toEqual(["restarting", "completed"]);
		expect(texts).toHaveLength(2);
		expect(texts[1]).toContain(requestId);
		expect(texts[1]).toMatch(/complet/i);
		expect(texts[1]).toMatch(/no longer applies|resume normal work/i);
		expect(texts[1]).not.toMatch(/do not start another model turn/i);
		expect(controller.snapshot().request).toMatchObject({ requestId, state: "completed" });
		controller.dispose();
	});
});

describe("restart-queued notice replay (session 01a0e3fe)", () => {
	const timestamp = "2026-10-09T02:36:00.000Z";
	let serial = 0;

	function chainId(prefix: string): string {
		serial++;
		return `${prefix}-${serial}`;
	}

	function transition(parentId: string | null, requestId: string, state: string, instanceId: string): SessionEntry {
		const id = chainId("transition");
		return {
			type: "custom",
			id,
			parentId,
			timestamp,
			customType: "restart_request_transition",
			data: { record: { requestId, state }, identity: { instanceId, sessionId: "s1" } },
		} as SessionEntry;
	}

	function queuedNotice(parentId: string | null, requestId: string): SessionEntry {
		const id = chainId("notice");
		return {
			type: "custom_message",
			id,
			parentId,
			timestamp,
			customType: "restart-queued",
			content:
				"A restart-queue status is included in this message's structured details " +
				"(`requestId` and `state`). If the state is `queued` or `draining`, finish the " +
				"provider call and tool batch already in progress. Do not start another model turn. " +
				"If the state is `cancelled`, disregard earlier queued notices and resume normal work.",
			details: { requestId, state: "queued" },
			display: true,
		} as SessionEntry;
	}

	function userMessage(parentId: string | null, text: string): SessionEntry {
		const id = chainId("message");
		return {
			type: "message",
			id,
			parentId,
			timestamp,
			message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
		} as unknown as SessionEntry;
	}

	function activeQueuedNotices(messages: Array<{ role?: unknown; customType?: unknown; details?: unknown }>) {
		return messages.filter(message => {
			if (message.role !== "custom" || message.customType !== "restart-queued") return false;
			const details = message.details;
			if (!details || typeof details !== "object" || !("state" in details)) return false;
			const state = details.state;
			return state === "queued" || state === "draining" || state === "checkpointed" || state === "restarting";
		});
	}

	it("filters queued notices whose requests completed or were superseded", () => {
		// Mirrors session 01a0e3fe: three queued notices from older instances,
		// every request completed, newest instance restarts, then the next turn.
		const reqA = "omp-update-aaaa";
		const reqB = "omp-update-bbbb";
		const reqC = "omp-update-cccc";
		const entries: SessionEntry[] = [];
		let parent: string | null = null;
		const push = (entry: SessionEntry) => {
			entries.push(entry);
			parent = entry.id;
		};
		push(userMessage(parent, "before restarts"));
		push(transition(parent, reqA, "queued", "instance-1"));
		push(queuedNotice(parent, reqA));
		push(transition(parent, reqA, "completed", "instance-2"));
		push(transition(parent, reqB, "queued", "instance-2"));
		push(queuedNotice(parent, reqB));
		push(transition(parent, reqB, "completed", "instance-3"));
		push(transition(parent, reqC, "queued", "instance-3"));
		push(queuedNotice(parent, reqC));
		push(transition(parent, reqC, "draining", "instance-3"));
		push(transition(parent, reqC, "checkpointed", "instance-3"));
		push(transition(parent, reqC, "restarting", "instance-3"));
		push(transition(parent, reqC, "completed", "instance-4"));
		push(userMessage(parent, "first turn after restart"));

		const context = buildSessionContext(entries, undefined, undefined, {});
		expect(activeQueuedNotices(context.messages)).toHaveLength(0);

		const transcript = buildSessionContext(entries, undefined, undefined, { transcript: true });
		expect(activeQueuedNotices(transcript.messages).length).toBeGreaterThan(0);
	});

	it("keeps the notice for a request that is still queued", () => {
		const requestId = "omp-update-still-queued";
		const entries: SessionEntry[] = [];
		let parent: string | null = null;
		const push = (entry: SessionEntry) => {
			entries.push(entry);
			parent = entry.id;
		};
		push(userMessage(parent, "before restart"));
		push(transition(parent, requestId, "queued", "instance-1"));
		push(queuedNotice(parent, requestId));
		push(userMessage(parent, "next turn"));

		const context = buildSessionContext(entries, undefined, undefined, {});
		const kept = activeQueuedNotices(context.messages);
		expect(kept).toHaveLength(1);
	});

	it("keeps a detail-free notice whose request id contains periods", () => {
		const requestId = "request.id";
		const entries: SessionEntry[] = [];
		let parent: string | null = null;
		const push = (entry: SessionEntry) => {
			entries.push(entry);
			parent = entry.id;
		};
		push(userMessage(parent, "before restart"));
		push(transition(parent, requestId, "queued", "instance-1"));
		const notice = queuedNotice(parent, requestId) as unknown as Record<string, unknown>;
		notice.details = undefined;
		notice.content = `Restart ${requestId} is queued. Do not start another model turn until it completes.`;
		push(notice as unknown as SessionEntry);
		push(userMessage(parent, "next turn"));

		const context = buildSessionContext(entries, undefined, undefined, {});
		expect(
			context.messages.filter(message => message.role === "custom" && message.customType === "restart-queued"),
		).toHaveLength(1);
	});

	it("adds no restart notice for a session without restart history", () => {
		const entries: SessionEntry[] = [userMessage(null, "plain turn")];
		const context = buildSessionContext(entries, undefined, undefined, {});
		expect(
			context.messages.filter(message => message.role === "custom" && message.customType === "restart-queued"),
		).toHaveLength(0);
	});
});

it("a failed replacement stops background capture before releasing worker write leases", async () => {
	const { manager, file } = await createRoot(makeTempDir());
	const harness = makeSession(manager);
	registerRoot(AgentRegistry.global(), harness.session, file);
	const identity = identityFor(manager, "failed-exec", 1);
	const stopping = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const launch = vi.spyOn(snapshotWorker, "launchRestartSnapshots").mockResolvedValue({
		stop: async () => {
			stopping.resolve();
			await stopped.promise;
		},
	});
	const controller = createRestartQueueController({
		session: harness.session,
		identity: () => identity,
		backgroundSnapshots: true,
		restart: async () => {
			throw new Error("replacement failed");
		},
	});
	try {
		await controller.handle({ identity, op: "request", requestId: "failed-exec" });
		await stopping.promise;
		expect(harness.releaseCount).toBe(0);
		stopped.resolve();
		for (let i = 0; i < 100 && !harness.releaseCount; i++) await Bun.sleep(1);
		expect(harness.releaseCount).toBe(1);
		expect(controller.snapshot().request).toMatchObject({ state: "failed", error: "replacement failed" });
	} finally {
		stopped.resolve();
		launch.mockRestore();
		controller.dispose();
	}
});
