import {
	isolationHasWork,
	snapshotRestartIsolation,
	restoreRestartIsolation,
	type RestartIsolation,
} from "@oh-my-pi/pi-coding-agent/task/restart-isolation";
import {
	launchRestartSnapshots,
	smokeTestRestartSnapshotWorker,
} from "@oh-my-pi/pi-coding-agent/task/restart-snapshot-worker";
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
		getTodoPhases: () => [],
		commitTodoPhases: () => {},
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

	it.each(["linked", "alternates"])(
		"recovers staged, unstaged, deleted and unpushed work without its original %s repository",
		async kind => {
			const source = path.join(temp!.path(), "source");
			const cwd = path.join(temp!.path(), "linked");
			await $`git init ${source}`.quiet();
			await Bun.write(path.join(source, "tracked"), "baseline");
			await Bun.write(path.join(source, "deleted"), "delete me");
			await $`git -C ${source} add .`.quiet();
			await $`git -C ${source} -c user.name=Test -c user.email=test@example.com commit -m baseline`.quiet();
			if (kind === "linked") await $`git -C ${source} worktree add -b worker ${cwd}`.quiet();
			else await $`git clone --shared ${source} ${cwd}`.quiet();
			await Bun.write(path.join(cwd, "tracked"), "unpublished commit");
			await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.com commit -am unpublished`.quiet();
			const head = (await $`git -C ${cwd} rev-parse HEAD`.text()).trim();
			await Bun.write(path.join(cwd, "tracked"), "staged");
			await $`git -C ${cwd} add tracked`.quiet();
			await Bun.write(path.join(cwd, "tracked"), "dirty bytes\0\n");
			await Bun.write(path.join(cwd, "untracked"), "new bytes");
			await Bun.write(path.join(cwd, ".gitignore"), "ignored/\n");
			await Bun.write(path.join(cwd, "ignored/output.bin"), "ignored worker output\0");
			await fs.mkdir(path.join(cwd, "empty-directory"));
			await fs.rm(path.join(cwd, "deleted"));
			await fs.symlink("tracked", path.join(cwd, "link"));
			const before = await $`git -C ${cwd} status --porcelain=v1`.text();
			const item: RestartIsolation = {
				id: "worker",
				name: "Worker",
				cwd,
				marker: path.join(temp!.path(), "marker.json"),
			};
			await snapshotRestartIsolation(item, path.join(temp!.path(), "snapshots"));
			await Bun.write(path.join(cwd, "tracked"), "later worker write");
			await fs.rm(cwd, { recursive: true });
			await fs.rm(source, { recursive: true });
			await restoreRestartIsolation(item);
			expect(await Bun.file(path.join(cwd, "tracked")).text()).toBe("dirty bytes\0\n");
			expect(await Bun.file(path.join(cwd, "untracked")).text()).toBe("new bytes");
			expect(await fs.readlink(path.join(cwd, "link"))).toBe("tracked");
			expect(await Bun.file(path.join(cwd, "ignored/output.bin")).text()).toBe("ignored worker output\0");
			expect((await fs.stat(path.join(cwd, "empty-directory"))).isDirectory()).toBe(true);
			expect(await $`git -C ${cwd} status --porcelain=v1`.text()).toBe(before);
			expect((await $`git -C ${cwd} rev-parse HEAD`.text()).trim()).toBe(head);
			expect(await $`git -C ${cwd} show HEAD:tracked`.text()).toBe("unpublished commit");
			expect(await $`git -C ${cwd} show :tracked`.text()).toBe("staged");
			// Negative controls: the same observable checks detect a lost dirty file and lost history.
			await fs.rm(path.join(cwd, "tracked"));
			expect(await $`git -C ${cwd} status --porcelain=v1`.text()).not.toBe(before);
			await fs.rm(path.join(cwd, ".git/objects"), { recursive: true });
			expect((await $`git -C ${cwd} show HEAD:tracked`.quiet().nothrow()).exitCode).not.toBe(0);
		},
	);

	it("snapshots dirty isolation without the configured cleanliness wait", async () => {
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
				if (record.state === "completed" || record.state === "failed") terminal.resolve(record);
			},
		});
		try {
			const started = Date.now();
			await controller.handle({ identity, op: "request", requestId: "dirty-isolation" });
			const result = await terminal.promise;
			expect(result.error).toBeUndefined();
			expect(result.state).toBe("completed");
			const elapsed = Date.now() - started;
			expect(aborts).toBe(1);
			expect(leases).toBe(1);
			expect(restarts).toBe(1);
			const markerPath = path.join(path.dirname(childFile), `${childId}.restart-isolation.json`);
			const marker: { id: string; cwd: string; snapshotPath: string } = await Bun.file(markerPath).json();
			expect(marker.id).toBe(childId);
			expect(marker.cwd).toBe(cwd);
			expect(await Bun.file(path.join(marker.snapshotPath, "tracked.txt")).text()).toBe("settled tracked bytes\n");
			expect(await Bun.file(path.join(marker.snapshotPath, "untracked.txt")).text()).toBe("untracked bytes\n");
			await fs.rm(cwd, { recursive: true });
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			registerRoot();
			const restored = await restoreSubagentsAfterRestart(rootSession, { requestId: "dirty-isolation" });
			expect(restored.parked).not.toContain(childId);
			expect(await Bun.file(path.join(cwd, "tracked.txt")).text()).toBe("settled tracked bytes\n");
			expect(await Bun.file(path.join(cwd, "untracked.txt")).text()).toBe("untracked bytes\n");
			expect(elapsed).toBeLessThan(1_000);
		} finally {
			controller.dispose();
		}
	}, 10_000);
});

it("retains a clean second attempt first registered during the final drain flush", async () => {
	const cwd = path.join(temp!.path(), "late-worker");
	await fs.mkdir(cwd);
	await $`git init ${cwd}`.quiet();
	await Bun.write(path.join(cwd, "work.txt"), "baseline");
	await $`git -C ${cwd} add work.txt`.quiet();
	await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.com commit -m baseline`.quiet();
	const root = track(SessionManager.create(temp!.path(), path.join(temp!.path(), "sessions")));
	root.appendMessage({ role: "user", content: "restart", timestamp: Date.now() });
	await root.ensureOnDisk();
	const rootFile = root.getSessionFile()!;
	const child = track(
		await SessionManager.open(path.join(rootFile.slice(0, -6), "Adaptive60Mw3Levels-2.jsonl"), undefined, undefined, {
			initialCwd: cwd,
			parentSession: rootFile,
			suppressBreadcrumb: true,
		}),
	);
	child.appendSessionInit({
		systemPrompt: ["worker"],
		task: "unfinished assignment",
		tools: ["read"],
		isolated: true,
	});
	child.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
	await child.ensureOnDisk();
	await child.flush();
	const rootSession = session(root, { quiescence: Promise.resolve() });
	const worker = session(child, { quiescence: Promise.resolve(), wasRunning: true });
	const registry = AgentRegistry.global();
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_AGENT_ID,
		kind: "main",
		session: rootSession,
		sessionFile: rootFile,
		status: "idle",
	});
	let registered = false;
	Object.assign(rootSession, {
		flushRestartJournal: async () => {
			await root.flush();
			if (registered) return;
			registered = true;
			registry.register({
				id: "Adaptive60Mw3Levels-2",
				displayName: "Adaptive60Mw3Levels-2",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: worker,
				sessionFile: child.getSessionFile()!,
				status: "running",
			});
		},
	});
	const terminal = Promise.withResolvers<RestartRequestRecord>();
	const identity = { instanceId: "late", sessionId: root.getSessionId(), generation: 1 };
	const controller = createRestartQueueController({
		session: rootSession,
		identity: () => identity,
		restart: async () => {},
		onStateChange: record => {
			if (record.state === "completed" || record.state === "failed") terminal.resolve(record);
		},
	});
	try {
		await controller.handle({ identity, op: "request", requestId: "late-worker" });
		const result = await terminal.promise;
		expect(result.error).toBeUndefined();
		expect(result.state).toBe("completed");
		const marker = await Bun.file(
			path.join(rootFile.slice(0, -6), "Adaptive60Mw3Levels-2.restart-isolation.json"),
		).json();
		expect(marker).toMatchObject({ id: "Adaptive60Mw3Levels-2", cwd });
		expect(await Bun.file(path.join(marker.snapshotPath, "work.txt")).text()).toBe("baseline");
		expect(
			root
				.getEntries()
				.findLast(entry => entry.type === "custom" && entry.customType === "subagent_restart_handoff"),
		).toMatchObject({
			data: { children: [expect.objectContaining({ id: "Adaptive60Mw3Levels-2", status: "running" })] },
		});
	} finally {
		controller.dispose();
	}
});

it("background capture survives its caller and gates recovery on dirty bytes and unpublished history", async () => {
	const cwd = path.join(temp!.path(), "background-worker");
	await $`git init ${cwd}`.quiet();
	await Bun.write(path.join(cwd, "work"), "unpublished commit");
	await $`git -C ${cwd} add .`.quiet();
	await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.com commit -m unpublished`.quiet();
	const head = (await $`git -C ${cwd} rev-parse HEAD`.text()).trim();
	await Bun.write(path.join(cwd, "work"), "dirty bytes\0");
	const item: RestartIsolation = {
		id: "background",
		name: "Background",
		cwd,
		marker: path.join(temp!.path(), "background.json"),
	};
	const capture = await launchRestartSnapshots([item], "background", Date.now() + 30_000);
	try {
		// The returned descriptor owns a pending capture, not a completed filesystem copy.
		expect(item.snapshotPath).toBeUndefined();
		await restoreRestartIsolation(item);
		expect(await Bun.file(path.join(item.snapshotPath!, "work")).text()).toBe("dirty bytes\0");
		await fs.rm(cwd, { recursive: true });
		await restoreRestartIsolation(item);
		expect(await Bun.file(path.join(cwd, "work")).text()).toBe("dirty bytes\0");
		expect((await $`git -C ${cwd} rev-parse HEAD`.text()).trim()).toBe(head);
		expect(await $`git -C ${cwd} show HEAD:work`.text()).toBe("unpublished commit");
	} finally {
		await capture?.stop();
	}
}, 40_000);

it("unfinished or failed captures prevent a worker from resuming even when its workspace exists", async () => {
	const item: RestartIsolation = {
		id: "expired",
		name: "Expired",
		cwd: temp!.path(),
		marker: path.join(temp!.path(), "expired.json"),
		captureDeadlineAt: Date.now() - 1,
	};
	await expect(restoreRestartIsolation(item)).rejects.toThrow("deadline expired");
	delete item.captureDeadlineAt;
	item.captureError = "snapshot filesystem failure";
	await expect(restoreRestartIsolation(item)).rejects.toThrow("snapshot filesystem failure");
});

it("snapshot worker CLI entry executes and acknowledges an isolated smoke job", smokeTestRestartSnapshotWorker, 40_000);
