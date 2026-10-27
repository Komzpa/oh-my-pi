import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	createRestartQueueController,
	type RestartControlIdentity,
	type RestartQueueController,
	type RestartRequestRecord,
} from "@oh-my-pi/pi-coding-agent/task/restart-queue";
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
	},
): AgentSession {
	return {
		sessionManager: manager,
		agent: { getPendingModelNewsCount: () => 0 },
		isStreaming: options.wasRunning ?? false,
		isDisposed: false,
		beginRestartDrain: () => ({
			wasRunning: options.wasRunning ?? false,
			waitForQuiescence: () => options.quiescence,
			release: () => {},
		}),
		abort: options.abort,
		sendCustomMessage: async () => {},
		deliverIrcMessage: async () => "woken",
		emitNotice: () => {},
	} as unknown as AgentSession;
}

async function makeController(options: {
	abort: (options?: unknown) => Promise<void>;
	workerQuiescence: Promise<void>;
	restart: () => Promise<void>;
	onStateChange?: (record: RestartRequestRecord) => void;
	abortGraceMs?: number;
}): Promise<{ controller: RestartQueueController; identity: RestartControlIdentity }> {
	const cwd = temp!.path();
	const root = track(SessionManager.create(cwd, path.join(cwd, "sessions")));
	root.appendMessage({ role: "user", content: "restart settlement integration", timestamp: Date.now() });
	await root.ensureOnDisk();
	const rootFile = root.getSessionFile();
	if (!rootFile) throw new Error("Expected root session file");
	const child = track(SessionManager.create(cwd, rootFile.slice(0, -".jsonl".length)));
	child.appendSessionInit({
		systemPrompt: ["Persisted worker prompt"],
		task: "Finish worker assignment",
		tools: ["read", "yield"],
	});
	child.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
	await child.ensureOnDisk();
	const childFile = child.getSessionFile();
	if (!childFile) throw new Error("Expected worker session file");
	const rootSession = session(root, { quiescence: Promise.resolve() });
	const workerSession = session(child, {
		wasRunning: true,
		quiescence: options.workerQuiescence,
		abort: options.abort,
	});
	const registry = AgentRegistry.global();
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_AGENT_ID,
		kind: "main",
		session: rootSession,
		sessionFile: rootFile,
		status: "idle",
	});
	registry.register({
		id: child.getSessionId(),
		displayName: "worker",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: workerSession,
		sessionFile: childFile,
		status: "running",
	});
	const identity = { instanceId: "worker-settlement", sessionId: root.getSessionId(), generation: 1 };
	return {
		identity,
		controller: createRestartQueueController({
			session: rootSession,
			identity: () => identity,
			restartWorkerGraceMs: 5,
			restartWorkerAbortGraceMs: options.abortGraceMs,
			restart: options.restart,
			onStateChange: options.onStateChange,
		}),
	};
}

beforeEach(() => {
	temp = TempDir.createSync("@pi-restart-worker-settlement-");
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	for (const manager of managers) await manager.close().catch(() => {});
	managers.clear();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	await temp?.remove();
	temp = undefined;
});

describe("restart worker settlement", () => {
	it("does not restart until a grace-expired worker abort and lease quiescence settle", async () => {
		const abort = Promise.withResolvers<void>();
		const abortStarted = Promise.withResolvers<void>();
		const quiescence = Promise.withResolvers<void>();
		const restarted = Promise.withResolvers<void>();
		const controllerState = Promise.withResolvers<RestartRequestRecord>();
		let restartCalled = false;
		const { controller, identity } = await makeController({
			workerQuiescence: quiescence.promise,
			abort: async () => {
				abortStarted.resolve();
				await abort.promise;
			},
			restart: async () => {
				restartCalled = true;
				restarted.resolve();
			},
			onStateChange: record => {
				if (record.state === "completed" || record.state === "failed") controllerState.resolve(record);
			},
		});
		await controller.handle({ identity, op: "request", requestId: "held-worker" });
		await abortStarted.promise;
		await Bun.sleep(25);
		expect(restartCalled).toBe(false);
		abort.resolve();
		await Bun.sleep(25);
		expect(restartCalled).toBe(false);
		quiescence.resolve();
		await restarted.promise;
		expect((await controllerState.promise).state).toBe("completed");
		controller.dispose();
	});

	it("settles and restarts when a worker tool ignores the first signal for longer than the old 5s grace", async () => {
		const quiescence = Promise.withResolvers<void>();
		const terminal = Promise.withResolvers<RestartRequestRecord>();
		let restarts = 0;
		let abortOptions: unknown;
		const { controller, identity } = await makeController({
			workerQuiescence: quiescence.promise,
			abort: async (options?: unknown) => {
				abortOptions = options;
				await Bun.sleep(5_400);
				quiescence.resolve();
			},
			restart: async () => {
				restarts++;
			},
			onStateChange: record => {
				if (record.state === "failed" || record.state === "completed") terminal.resolve(record);
			},
		});
		try {
			await controller.handle({ identity, op: "request", requestId: "slow-tool" });
			const result = await terminal.promise;
			expect(result.error).toBeUndefined();
			expect(result.state).toBe("completed");
			expect(restarts).toBe(1);
			expect(abortOptions).toMatchObject({ cancelBackgroundJobs: true });
		} finally {
			controller.dispose();
		}
	}, 15_000);

	it.each(["abort", "quiescence"] as const)(
		"fails a restart when worker %s ignores the abort deadline",
		async hung => {
			const never = Promise.withResolvers<void>();
			const terminal = Promise.withResolvers<RestartRequestRecord>();
			let restarts = 0;
			const { controller, identity } = await makeController({
				workerQuiescence: never.promise,
				abort: async () => {
					if (hung === "abort") await never.promise;
				},
				abortGraceMs: 20,
				restart: async () => {
					restarts++;
				},
				onStateChange: record => {
					if (record.state === "failed" || record.state === "completed") terminal.resolve(record);
				},
			});
			try {
				await controller.handle({ identity, op: "request", requestId: `hung-${hung}` });
				const result = await terminal.promise;
				expect(result.state).toBe("failed");
				expect(result.error).toContain("did not settle after abort grace period");
				expect(restarts).toBe(0);
			} finally {
				controller.dispose();
			}
		},
		1_000,
	);

	it("cancels a restart while worker abort is hung and accepts a new request", async () => {
		const never = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let restarts = 0;
		const { controller, identity } = await makeController({
			workerQuiescence: never.promise,
			abort: async () => {
				entered.resolve();
				await never.promise;
			},
			restart: async () => {
				restarts++;
			},
		});
		try {
			await controller.handle({ identity, op: "request", requestId: "cancel-hung" });
			await entered.promise;
			await controller.handle({ identity, op: "cancel", requestId: "cancel-hung" });
			await Bun.sleep(10);
			expect(controller.snapshot().request?.state).toBe("cancelled");
			expect(restarts).toBe(0);
			const next = await controller.handle({ identity, op: "request", requestId: "after-cancel" });
			expect(next.request?.requestId).toBe("after-cancel");
		} finally {
			controller.dispose();
		}
	});

	it("records failed and never restarts when worker abort rejects", async () => {
		const abortStarted = Promise.withResolvers<void>();
		const terminal = Promise.withResolvers<RestartRequestRecord>();
		const workerNeverSettles = Promise.withResolvers<void>();
		let restartCalled = false;
		const { controller, identity } = await makeController({
			workerQuiescence: workerNeverSettles.promise,
			abort: async () => {
				abortStarted.resolve();
				throw new Error("abort rejected");
			},
			restart: async () => {
				restartCalled = true;
			},
			onStateChange: record => {
				if (record.state === "failed" || record.state === "completed") terminal.resolve(record);
			},
		});
		await controller.handle({ identity, op: "request", requestId: "failed-abort" });
		await abortStarted.promise;
		expect((await terminal.promise).state).toBe("failed");
		expect(restartCalled).toBe(false);
		controller.dispose();
	});
});
