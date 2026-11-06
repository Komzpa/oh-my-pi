import { isolationHasWork } from "@oh-my-pi/pi-coding-agent/task/restart-isolation";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as utils from "@oh-my-pi/pi-utils";
import { restoreSubagentsAfterRestart } from "@oh-my-pi/pi-coding-agent/task/restart-recovery";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createRestartQueueController, type RestartRequestRecord } from "@oh-my-pi/pi-coding-agent/task/restart-queue";
import { TempDir } from "@oh-my-pi/pi-utils";

const managers = new Set<SessionManager>();
let temp: TempDir | undefined;

function track(manager: SessionManager): SessionManager {
	managers.add(manager);
	return manager;
}

function session(
	manager: SessionManager,
	options: {
		wasRunning?: boolean;
		quiescence: Promise<void>;
		abort?: (options?: unknown) => Promise<void>;
		onLease?: () => void;
	},
): AgentSession {
	return {
		sessionManager: manager,
		getRestartPendingInputCount: () => 0,
		getRestartBranchEntries: async () => manager.getBranch(),
		flushRestartJournal: async () => {
			await manager.ensureOnDisk();
			await manager.flush();
		},
		agent: { getPendingModelNewsCount: () => 0 },
		isStreaming: options.wasRunning ?? false,
		isDisposed: false,
		beginRestartDrain: () => {
			options.onLease?.();
			return {
				wasRunning: options.wasRunning ?? false,
				waitForQuiescence: () => options.quiescence,
				release: () => {},
			};
		},
		abort: options.abort,
		sendRestartNotice: async (notice: Parameters<AgentSession["sendRestartNotice"]>[0]) => {
			manager.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
		},
		deliverIrcMessage: async () => "woken",
		emitNotice: () => {},
	} as unknown as AgentSession;
}

beforeEach(() => {
	temp = TempDir.createSync("@pi-restart-isolation-");
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	vi.spyOn(utils, "getBaseConfigRoot").mockReturnValue(path.join(temp.path(), "config"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers) await manager.close().catch(() => {});
	managers.clear();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	await temp?.remove();
});

describe("restart isolation recovery", () => {
	it("waits for local commits but releases a clean worker whose HEAD is already upstream", async () => {
		const cwd = path.join(temp!.path(), "committed-worker");
		await fs.mkdir(cwd);
		await $`git init ${cwd}`.quiet();
		await Bun.write(path.join(cwd, "work.txt"), "baseline");
		await $`git -C ${cwd} add work.txt`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.com commit -m baseline`.quiet();
		expect(await isolationHasWork(cwd)).toBe(true);
		const remote = path.join(temp!.path(), "published.git");
		await $`git init --bare ${remote}`.quiet();
		await $`git -C ${cwd} remote add origin ${remote}`.quiet();
		await $`git -C ${cwd} push -u origin HEAD:published`.quiet();
		expect(await isolationHasWork(cwd)).toBe(false);
		await Bun.write(path.join(cwd, "work.txt"), "local commit");
		await $`git -C ${cwd} add work.txt`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.com commit -m local`.quiet();
		expect(await isolationHasWork(cwd)).toBe(true);
	});

	it.each([0, 2_000])(
		"snapshots dirty isolation after a %s ms late wake and recovers its settled bytes once",
		async lateWakeMs => {
			const cwd = path.join(temp!.path(), "worker");
			await fs.mkdir(cwd);
			await $`git init ${cwd}`.quiet();
			await Bun.write(path.join(cwd, "tracked.txt"), "committed\n");
			await $`git -C ${cwd} add tracked.txt`.quiet();
			await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.com commit -m baseline`.quiet();
			await Bun.write(path.join(cwd, "tracked.txt"), "dirty tracked bytes\n");
			await Bun.write(path.join(cwd, "untracked.txt"), "untracked bytes\n");
			const root = track(SessionManager.create(temp!.path(), path.join(temp!.path(), "sessions")));
			root.appendMessage({ role: "user", content: "restart", timestamp: Date.now() });
			await root.ensureOnDisk();
			const rootFile = root.getSessionFile()!;
			const child = track(SessionManager.create(cwd, rootFile.slice(0, -6)));
			child.appendSessionInit({
				systemPrompt: ["worker"],
				task: "Row: Adaptive Facility: no crash, callout leaders clear of hall",
				tools: ["read", "yield"],
				isolated: true,
			});
			child.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
			await child.ensureOnDisk();
			await child.flush();
			const childFile = child.getSessionFile()!;
			const childId = "FacilityBlitFix";
			const quiet = Promise.withResolvers<void>();
			const pending = Promise.withResolvers<RestartRequestRecord>();
			const terminal = Promise.withResolvers<RestartRequestRecord>();
			let leases = 0;
			let aborts = 0;
			let restarts = 0;
			const rootSession = session(root, { quiescence: Promise.resolve() });
			const worker = session(child, {
				wasRunning: true,
				quiescence: quiet.promise,
				onLease: () => {
					leases++;
				},
				abort: async () => {
					aborts++;
					await Bun.write(path.join(cwd, "tracked.txt"), "settled tracked bytes\n");
					quiet.resolve();
				},
			});
			const registerRoot = () =>
				AgentRegistry.global().register({
					id: MAIN_AGENT_ID,
					displayName: MAIN_AGENT_ID,
					kind: "main",
					session: rootSession,
					sessionFile: rootFile,
					status: "idle",
				});
			registerRoot();
			AgentRegistry.global().register({
				id: childId,
				displayName: "FacilityBlitFix",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: worker,
				sessionFile: childFile,
				status: "running",
			});
			const identity = { instanceId: "isolated", sessionId: root.getSessionId(), generation: 1 };
			const controller = createRestartQueueController({
				session: rootSession,
				identity: () => identity,
				restartIsolationWaitMs: 60_000,
				restartWorkerAbortGraceMs: 1_000,
				restartWorkerGraceMs: 1,
				restart: async () => {
					restarts++;
				},
				onStateChange: record => {
					if (record.drainStatus?.isolationPendingReason) {
						pending.resolve(record);
						if (lateWakeMs) {
							const wakeAt = record.drainStatus.stageDeadlineAt! + lateWakeMs;
							// Replay a blocked event loop, including the wait's timer waking late.
							while (Date.now() < wakeAt) {
								/* synchronous lag */
							}
						}
					}
					if (record.state === "completed" || record.state === "failed") terminal.resolve(record);
				},
			});
			try {
				const started = Date.now();
				await controller.handle({ identity, op: "request", requestId: "dirty-isolation" });
				const waiting = await pending.promise;
				expect(waiting.drainStatus?.isolationPendingReason).toContain("FacilityBlitFix");
				expect(waiting.drainStatus?.isolationPendingReason).toContain(childId);
				expect(controller.snapshot().request?.drainStatus?.isolationPendingReason).toContain(
					"uncommitted or unpushed",
				);
				expect(leases).toBe(0);
				expect(aborts).toBe(0);
				expect(restarts).toBe(0);
				const result = await terminal.promise;
				expect(result.error).toBeUndefined();
				expect(result.state).toBe("completed");
				expect(Date.now() - started).toBeLessThan(4_000 + lateWakeMs);
				expect(aborts).toBe(1);
				expect(leases).toBe(1);
				expect(restarts).toBe(1);
				const markerPath = path.join(path.dirname(childFile), `${childId}.restart-isolation.json`);
				const marker: { id: string; cwd: string; snapshotPath: string } = await Bun.file(markerPath).json();
				expect(marker.id).toBe(childId);
				expect(marker.cwd).toBe(cwd);
				expect(await $`tar -xOzf ${marker.snapshotPath} tracked.txt`.text()).toBe("settled tracked bytes\n");
				expect(await $`tar -xOzf ${marker.snapshotPath} untracked.txt`.text()).toBe("untracked bytes\n");
				await fs.rm(cwd, { recursive: true });
				AgentLifecycleManager.resetGlobalForTests();
				AgentRegistry.resetGlobalForTests();
				registerRoot();
				const restored = await restoreSubagentsAfterRestart(rootSession, { requestId: "dirty-isolation" });
				expect(restored.parked).toContain(childId);
				await restoreSubagentsAfterRestart(rootSession, { requestId: "dirty-isolation" });
				const notices = root
					.getEntries()
					.filter(entry => entry.type === "custom_message" && entry.customType === "restart-isolation-snapshots");
				expect(notices).toHaveLength(1);
				const notice = JSON.stringify(notices[0]);
				expect(notice).toContain("FacilityBlitFix");
				expect(notice).toContain(childId);
				expect(notice).toContain(marker.snapshotPath);
			} finally {
				controller.dispose();
			}
		},
		10_000,
	);
});
