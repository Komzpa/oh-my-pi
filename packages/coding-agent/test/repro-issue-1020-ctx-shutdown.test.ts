import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createTestSession, type TestSessionContext } from "./utilities";

const hosts: Array<{ host: InteractiveMode; context: TestSessionContext }> = [];

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(async () => {
	for (const { host } of hosts) host.stop();
	vi.restoreAllMocks();
	for (const { context } of hosts) {
		Reflect.deleteProperty(context.session, "extensionRunner");
		await context.cleanup();
	}
	hosts.length = 0;
	resetSettingsForTest();
});

async function createHost(initializeUi: boolean) {
	let actions: ExtensionContextActions | undefined;
	const state = {
		streaming: false,
		queued: 0,
		asyncWork: false,
		closed: false,
		admitted: 0,
		pendingSubmission: false,
		settleAdmitted: undefined as (() => void) | undefined,
	};
	const errors: string[] = [];
	const runner = {
		initialize(
			_actions: ExtensionActions,
			contextActions: ExtensionContextActions,
			_commandActions?: ExtensionCommandContextActions,
			_uiContext?: ExtensionUIContext,
		) {
			actions = contextActions;
		},
		getComposerShapes: () => [],
		onError() {},
		async emit() {},
	};
	const context = await createTestSession({ inMemory: true });
	const session = context.session;
	Object.defineProperties(session, {
		isStreaming: { get: () => state.streaming, configurable: true },
		queuedMessageCount: { get: () => state.queued, configurable: true },
		hasAdmittedSubmission: { get: () => state.admitted > 0, configurable: true },
	});
	vi.spyOn(session, "hasPendingAsyncWork").mockImplementation(() => state.asyncWork);
	vi.spyOn(session, "waitForIdle").mockResolvedValue(undefined);
	vi.spyOn(session, "waitForAdmittedSubmissions").mockImplementation(() => {
		if (state.admitted === 0) return Promise.resolve();
		const settled = Promise.withResolvers<void>();
		state.settleAdmitted = settled.resolve;
		return settled.promise;
	});
	const host = new InteractiveMode(session, "test");
	hosts.push({ host, context });
	Object.defineProperty(session, "extensionRunner", { value: runner, configurable: true });
	Object.assign(host, {
		shutdownRequested: false,
		syncComposerShape() {},
		syncExtensionLinks() {},
		hasPendingSubmission: () => state.pendingSubmission,
		async shutdown() {
			state.closed = true;
		},
		showError(message: string) {
			errors.push(message);
		},
		setToolUIContext() {},
		setWorkingMessage() {},
		setEditorComponent() {},
		toolOutputExpanded: false,
		setToolsExpanded() {},
	});
	Object.defineProperty(host, "isShuttingDown", { get: () => state.closed });
	const controller = new ExtensionUiController(host);
	if (initializeUi) await controller.initHooksAndCustomTools();
	else controller.initializeHookRunner({} as ExtensionUIContext, false);
	if (!actions) throw new Error("Extension runtime was not initialized");
	return { host, actions, state, errors };
}

async function flushShutdown() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("interactive extension shutdown", () => {
	test("an idle background request closes the initialized host without terminal input", async () => {
		const { actions, state, errors } = await createHost(true);
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("a rebound hook runtime also closes an idle host without another submit", async () => {
		const { actions, state, errors } = await createHost(false);
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("keeps the request pending until streaming, queued input and async work settle", async () => {
		const { host, actions, state, errors } = await createHost(true);
		state.streaming = true;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.streaming = false;
		state.queued = 1;
		await host.checkShutdownRequested();
		expect(state.closed).toBe(false);

		state.queued = 0;
		state.asyncWork = true;
		await host.checkShutdownRequested();
		expect(state.closed).toBe(false);

		state.asyncWork = false;
		host.requestShutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("waits for an admitted extension submission and re-evaluates the turn it started", async () => {
		const { host, actions, state, errors } = await createHost(true);
		state.admitted = 1;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		// The submission dispatches a turn as it settles: still not a shutdown boundary.
		state.streaming = true;
		state.admitted = 0;
		state.settleAdmitted?.();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.streaming = false;
		host.requestShutdown();
		await flushShutdown();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	test("keeps the request pending while a foreground submission is still being prepared", async () => {
		const { host, actions, state, errors } = await createHost(true);
		state.pendingSubmission = true;
		actions.shutdown();
		await flushShutdown();
		expect(state.closed).toBe(false);

		state.pendingSubmission = false;
		await host.checkShutdownRequested();
		expect(state.closed).toBe(true);
		expect(errors).toEqual([]);
	});
});
