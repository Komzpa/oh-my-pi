import { mock } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { InteractiveSessionConnection } from "../../src/modes/interactive-session";
import { runInteractiveMode } from "../../src/main";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { convertToLlm } from "../../src/session/messages";
import { CURRENT_SETUP_VERSION } from "@oh-my-pi/pi-tui/setup/setup-version";

const directory = process.env.LAUNCHER_TEST_DIR!;
const hold = process.env.LAUNCHER_TEST_HOLD === "1";
const modelStarted = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let calls = 0;
let effects = 0;
let pending: Promise<boolean> | undefined;
const routed: string[] = [];
let connection: InteractiveSessionConnection;
let detached = false;
let receivedAfterDetach = 0;
let unsubscribe = () => {};
class Detached extends Error {}
mock.module("../../src/modes/interactive-mode", () => ({
	InteractiveMode: class {
		collabController = { startupComplete() {}, async shutdown() {} };
		skillCommands = new Map();
		optimisticSkillMessagePending = false;
		constructor(...args: unknown[]) {
			connection = args[10] as InteractiveSessionConnection;
			if (!connection) throw new Error("Normal launcher did not supply its connection");
			const prompt = connection.prompt.bind(connection);
			connection.prompt = (...args) => {
				routed.push("prompt:" + args[0]);
				return prompt(...args);
			};
			const custom = connection.promptCustomMessage.bind(connection);
			connection.promptCustomMessage = (...args) => {
				routed.push("custom:" + args[0].customType);
				return custom(...args);
			};
		}
		async init() {
			unsubscribe = connection.subscribe(() => {
				if (detached) receivedAfterDetach++;
			});
			if (hold) {
				pending = connection.prompt("running before view detach", { runCommands: false });
				await modelStarted.promise;
			}
		}
		inputs = 0;
		async getUserInput() {
			if (hold || this.inputs++ > 1) {
				unsubscribe();
				detached = true;
				throw new Detached();
			}
			return {
				text: "typed 🐈",
				started: true,
				cancelled: false,
				...(this.inputs === 1 ? { customType: "launcher-custom" } : {}),
			};
		}
		markPendingSubmissionStarted() {
			return true;
		}
		finishPendingSubmission() {}
		checkShutdownRequested() {}
		renderOptimisticSkillMessage() {}
		clearOptimisticSkillMessage() {}
		showError(error: string) {
			throw new Error(error);
		}
		showWarning() {}
		showStatus() {}
	},
}));
const settings = await Settings.init({
	inMemory: true,
	cwd: directory,
	overrides: {
		setupVersion: CURRENT_SETUP_VERSION,
		"startup.checkUpdate": false,
		"compaction.enabled": false,
		"todo.enabled": false,
	},
});
const auth = await AuthStorage.create(":memory:");
auth.keys.setRuntime("anthropic", "fixture-key");
const mockModel = createMockModel({
	handler: async () => {
		calls++;
		modelStarted.resolve();
		if (hold) await release.promise;
		effects++;
		return { content: ["completed once"] };
	},
});
const session = new AgentSession({
	agent: new Agent({
		getApiKey: () => "fixture-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mockModel.stream,
	}),
	sessionManager: SessionManager.create(directory, directory),
	settings,
	modelRegistry: new ModelRegistry(auth),
});
try {
	try {
		await runInteractiveMode(
			session,
			"test",
			undefined,
			[],
			Promise.resolve(undefined),
			hold ? [] : ["startup second"],
			() => {},
			undefined,
			undefined,
			true,
			false,
			false,
			undefined,
			undefined,
			hold ? undefined : "startup first",
		);
		throw new Error("Launcher unexpectedly returned");
	} catch (error) {
		if (!(error instanceof Detached)) throw error;
	}
	const aliveAtDetach = session.isStreaming;
	if (hold) {
		release.resolve();
		await pending;
	}
	await Bun.write(
		path.join(directory, "result.json"),
		JSON.stringify({ routed, aliveAtDetach, calls, effects, receivedAfterDetach }),
	);
} finally {
	release.resolve();
	unsubscribe();
	await session.dispose();
	auth.close();
}
