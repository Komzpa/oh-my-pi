import { afterEach, describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeAllVmContexts,
	executeInVmContext,
	type JsEvalWorkerFactories,
	type JsEvalWorkerHandle,
	setJsEvalWorkerFactoriesForTests,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolResourceScope } from "@oh-my-pi/pi-natives";

setDefaultTimeout(2_000);

const EXECUTION_MARKER = `OMP_EVAL_HOST_EXECUTION_${crypto.randomUUID().replaceAll("-", "_")}`;

interface FailingHandleState {
	runMessages: number;
	terminations: number;
}

function createSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

function createInitFailingHandle(
	mode: JsEvalWorkerHandle["mode"],
	errorMessage: string,
	state: FailingHandleState,
): JsEvalWorkerHandle {
	const messageListeners = new Set<(message: WorkerOutbound) => void>();
	return {
		mode,
		send(message: WorkerInbound) {
			if (message.type === "run") {
				state.runMessages++;
				return;
			}
			if (message.type !== "init") return;
			queueMicrotask(() => {
				for (const listener of messageListeners)
					listener({ type: "init-failed", error: { message: errorMessage } });
			});
		},
		onMessage(handler) {
			messageListeners.add(handler);
			return () => messageListeners.delete(handler);
		},
		onError() {
			return () => {};
		},
		async close() {
			return true;
		},
		async terminate() {
			state.terminations++;
			messageListeners.clear();
		},
	};
}

async function executeBlockingProbe(sessionKey: string): Promise<void> {
	const code = `const end = Date.now() + 250;\nwhile (Date.now() < end) {}\nprocess.env[${JSON.stringify(EXECUTION_MARKER)}] = "executed";`;
	await executeInVmContext({
		sessionKey,
		sessionId: sessionKey,
		ownerId: `owner:${sessionKey}`,
		cwd: process.cwd(),
		session: createSession(),
		code,
		filename: `[${sessionKey}].js`,
		timeoutMs: 20,
		// A real deadline is intentional: fake time cannot demonstrate that a
		// synchronous same-realm fallback blocks the host timer from firing.
		runState: { signal: AbortSignal.timeout(20) },
	});
}

async function captureStartupError(sessionKey: string): Promise<Error> {
	try {
		await executeBlockingProbe(sessionKey);
		return new Error("JS eval unexpectedly executed the cell");
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

describe("JS eval isolated startup failures", () => {
	let restoreFactories: (() => void) | undefined;

	afterEach(async () => {
		restoreFactories?.();
		restoreFactories = undefined;
		vi.restoreAllMocks();
		delete process.env[EXECUTION_MARKER];
		await disposeAllVmContexts();
	});

	it("surfaces dual spawn failure without running synchronous cell code on the host", async () => {
		let attempt = 0;
		const factories: JsEvalWorkerFactories = {
			async spawnProcess() {
				throw new Error("subprocess spawn failed");
			},
			spawnWorker() {
				attempt++;
				throw new Error(`worker spawn failed on attempt ${attempt}`);
			},
		};
		restoreFactories = setJsEvalWorkerFactoriesForTests(factories);

		const first = await captureStartupError("dual-spawn");
		expect(first.message).toContain(
			process.platform === "linux"
				? "Refusing an unbounded JS eval Worker fallback on Linux"
				: "worker spawn failed on attempt 1",
		);
		expect(attempt).toBe(process.platform === "linux" ? 0 : 1);
		expect(process.env[EXECUTION_MARKER]).toBeUndefined();

		// A distinct second failure for the same key proves the rejected startup
		// and its owner registration were removed instead of being reused.
		const second = await captureStartupError("dual-spawn");
		expect(second.message).toContain(
			process.platform === "linux"
				? "Refusing an unbounded JS eval Worker fallback on Linux"
				: "worker spawn failed on attempt 2",
		);
		expect(attempt).toBe(process.platform === "linux" ? 0 : 2);
		expect(process.env[EXECUTION_MARKER]).toBeUndefined();
	});

	it("terminates both init failures and clears startup ownership without executing the cell", async () => {
		let startupAttempt = 0;
		const state: FailingHandleState = { runMessages: 0, terminations: 0 };
		const factories: JsEvalWorkerFactories = {
			async spawnProcess() {
				startupAttempt++;
				return createInitFailingHandle("process", `subprocess init failed on attempt ${startupAttempt}`, state);
			},
			spawnWorker() {
				return createInitFailingHandle("worker", `worker init failed on attempt ${startupAttempt}`, state);
			},
		};
		restoreFactories = setJsEvalWorkerFactoriesForTests(factories);

		const first = await captureStartupError("dual-init");
		expect(first.message).toContain(
			process.platform === "linux"
				? "Failed to initialize isolated JS eval subprocess"
				: "worker init failed on attempt 1",
		);
		expect(state).toEqual({ runMessages: 0, terminations: process.platform === "linux" ? 1 : 2 });
		expect(process.env[EXECUTION_MARKER]).toBeUndefined();

		const second = await captureStartupError("dual-init");
		expect(second.message).toContain(
			process.platform === "linux"
				? "Failed to initialize isolated JS eval subprocess"
				: "worker init failed on attempt 2",
		);
		expect(state).toEqual({ runMessages: 0, terminations: process.platform === "linux" ? 2 : 4 });
		expect(process.env[EXECUTION_MARKER]).toBeUndefined();
	});
	it("keeps the event loop responsive while the real JS worker scope is set up", async () => {
		const originalWrap = ToolResourceScope.prototype.wrapCommandAsync;
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const wrapAsync = vi.spyOn(ToolResourceScope.prototype, "wrapCommandAsync").mockImplementation(async function (
			this: ToolResourceScope,
			command: string[],
			env?: Record<string, string>,
		) {
			started.resolve();
			await gate.promise;
			return originalWrap.call(this, command, env);
		});
		const wrapSync = vi.spyOn(ToolResourceScope.prototype, "wrapCommand");
		let output = "";
		const execution = executeInVmContext({
			sessionKey: "scoped-worker-startup",
			sessionId: "scoped-worker-startup",
			ownerId: "owner:scoped-worker-startup",
			cwd: process.cwd(),
			session: createSession(),
			code: "print(41 + 1)",
			filename: "[scoped-worker-startup].js",
			timeoutMs: 15_000,
			runState: {
				onText: chunk => {
					output += chunk;
				},
			},
		});
		await started.promise;
		// A real zero-delay macrotask is the condition under test: it can only
		// run while first-use scope setup remains pending if the loop is free.
		const timer = Promise.withResolvers<void>();
		setTimeout(() => timer.resolve(), 0);
		await timer.promise;
		gate.resolve();
		await execution;
		expect(output.trim()).toBe("42");
		expect(wrapAsync).toHaveBeenCalledTimes(1);
		expect(wrapSync).not.toHaveBeenCalled();
	}, 15_000);

	it("closes the real JS worker scope when async scope setup fails", async () => {
		const close = vi.spyOn(ToolResourceScope.prototype, "close");
		vi.spyOn(ToolResourceScope.prototype, "wrapCommandAsync").mockRejectedValue(
			new Error("test scope setup unavailable"),
		);
		const error = await captureStartupError("scope-setup-failure");
		expect(error.message).toContain(
			process.platform === "linux"
				? "Refusing an unbounded JS eval Worker fallback on Linux"
				: "Failed to start isolated JS eval worker",
		);
		expect(close.mock.calls.length).toBeGreaterThan(0);
		expect(process.env[EXECUTION_MARKER]).toBeUndefined();
	});
});
