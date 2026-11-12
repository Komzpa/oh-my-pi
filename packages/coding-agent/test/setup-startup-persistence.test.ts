import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as utils from "@oh-my-pi/pi-utils";
import { getModelDbPath } from "@oh-my-pi/pi-utils/dirs";
import * as updateCli from "../src/cli/update-cli";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "../src/config/settings";
import { createSettingsHost } from "../src/config/settings-ui";
import { cfgUpdateAuto } from "../src/modes/settings";
import { runInteractiveMode } from "../src/main";
import * as interactiveModeModule from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

class StartupDone extends Error {}

interface Launch {
	overlays: number;
	/** The update.auto value the running session reads once startup finished. */
	effectiveAutoUpdate: boolean | undefined;
}

// Cold module loading in the first launch exceeds bun's 5s default.
const TEST_TIMEOUT_MS = 30_000;
const ttyDescriptors = new Map<string, PropertyDescriptor | undefined>();
// Ambient values that would bypass the wizard or add config layers to the fixture's launches.
const AMBIENT_ENV = ["OMP_SKIP_SETUP", "PI_CONFIG_FILES"] as const;
const savedEnv = new Map<string, string | undefined>();

function isolateAmbientEnv(): void {
	for (const key of AMBIENT_ENV) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
}

function restoreAmbientEnv(): void {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
}
let dir = "";

function setTty(stream: "stdin" | "stdout", value: boolean): void {
	if (!ttyDescriptors.has(stream))
		ttyDescriptors.set(stream, Object.getOwnPropertyDescriptor(process[stream], "isTTY"));
	Object.defineProperty(process[stream], "isTTY", { value, configurable: true });
}

function configText(): string {
	const file = path.join(dir, "config.yml");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * One real launch through main.ts `runInteractiveMode`: real Settings on `dir`, the session reading
 * through an overlay exactly as sdk.ts builds it, the real setup host and wizard. Only the terminal
 * view is a stub; `keys` are fed to the wizard overlay until startup reaches the input loop.
 */
async function launch(options: { keys: string[]; configFiles?: string[]; goal?: string }): Promise<Launch> {
	resetSettingsForTest();
	const root = await Settings.init({ agentDir: dir, cwd: dir, configFiles: options.configFiles });
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "fixture-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "fixture-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: createMockModel({ handler: async () => ({ content: ["ok"] }) }).stream,
		}),
		sessionManager: SessionManager.create(dir, dir),
		settings: root.overlay({}),
		modelRegistry: new ModelRegistry(auth, path.join(dir, "models.yml"), {
			settings: root,
			cacheDbPath: getModelDbPath(dir),
		}),
	});
	const result: Launch = { overlays: 0, effectiveAutoUpdate: undefined };
	let wizard: { handleInput(data: string): void } | undefined;
	class FakeMode {
		collabController = { startupComplete() {}, async shutdown() {}, autoStart() {} };
		skillCommands = new Map();
		settings = session.settings;
		session = session;
		statusLine = {};
		ui = {
			showOverlay: (component: { handleInput(data: string): void }) => {
				result.overlays++;
				wizard = component;
				return { hide() {} };
			},
			setFocus() {},
			requestRender() {},
		};
		async init() {}
		mayAskForStartupWorktree() {
			return false;
		}
		async maybeAutoCreateWorktree() {}
		async startGoalAtStartup() {}
		playWelcomeIntro() {}
		openInBrowser() {}
		showError(message: string) {
			throw new Error(message);
		}
		showWarning() {}
		showStatus() {}
		showNewVersionNotification() {}
		showVersionUpdate() {}
		settleStartupRun() {}
		stop() {}
		async getUserInput(): Promise<never> {
			throw new StartupDone();
		}
	}
	vi.spyOn(interactiveModeModule, "InteractiveMode").mockImplementation((() => new FakeMode()) as never);
	// Real interval: the wizard's own phase machine runs on real timers; input is fed until it ends.
	const keyPump = setInterval(() => {
		if (!wizard) return;
		const key = options.keys.shift();
		if (key !== undefined) wizard.handleInput(key);
	}, 15);
	try {
		await runInteractiveMode(
			session,
			"test",
			[],
			Promise.resolve(undefined),
			[],
			() => {},
			undefined,
			undefined,
			false,
			false,
			false,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			options.goal,
		);
		throw new Error("startup unexpectedly returned");
	} catch (error) {
		if (!(error instanceof StartupDone)) throw error;
	} finally {
		clearInterval(keyPump);
		result.effectiveAutoUpdate = cfgUpdateAuto.get(session.settings);
		await session.dispose();
		auth.close();
	}
	return result;
}

describe("release setup question persistence through startup", () => {
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-startup-"));
		isolateAmbientEnv();
		// Stored version 2: only the update question (minVersion 3) is newer.
		fs.writeFileSync(path.join(dir, "config.yml"), "setupVersion: 2\n");
		setTty("stdin", true);
		setTty("stdout", true);
		vi.spyOn(updateCli, "canSelfUpdate").mockResolvedValue(true);
		await initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		for (const [stream, descriptor] of ttyDescriptors) {
			if (descriptor) Object.defineProperty(process[stream as "stdin" | "stdout"], "isTTY", descriptor);
			else Reflect.deleteProperty(process[stream as "stdin" | "stdout"], "isTTY");
		}
		ttyDescriptors.clear();
		restoreAmbientEnv();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// Escape thrice: splash -> question, skip the question, dismiss the outro.
	const SKIP = ["\x1b", "\x1b", "\x1b"];

	it(
		"shows the question once when skipped with Esc, then never again",
		async () => {
			expect((await launch({ keys: [...SKIP] })).overlays).toBe(1);
			expect(configText()).toContain("setupVersion: 3");
			expect(configText()).not.toContain("auto:");

			expect((await launch({ keys: [] })).overlays).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not repeat the question on launches with a --config overlay",
		async () => {
			const overlay = path.join(dir, "overlay.yml");
			fs.writeFileSync(overlay, "startup:\n  checkUpdate: false\n");
			expect((await launch({ keys: [...SKIP], configFiles: [overlay] })).overlays).toBe(1);
			expect((await launch({ keys: [], configFiles: [overlay] })).overlays).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not repeat the question on launches with --goal",
		async () => {
			expect((await launch({ keys: [...SKIP], goal: "ship it" })).overlays).toBe(1);
			expect((await launch({ keys: [], goal: "ship it" })).overlays).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"persists an answered question, update.auto included, and does not ask again",
		async () => {
			// "1" selects Update automatically, Enter confirms, Esc dismisses splash/outro.
			expect((await launch({ keys: ["\x1b", "1", "\r", "\x1b"] })).overlays).toBe(1);
			expect(configText()).toContain("setupVersion: 3");
			expect(configText()).toMatch(/auto: true/);
			expect((await launch({ keys: [] })).overlays).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps /settings update.auto saved across launches after the question was answered",
		async () => {
			expect((await launch({ keys: [...SKIP] })).overlays).toBe(1);
			// The /settings host write path (createSettingsHost), not the selector controller route.
			resetSettingsForTest();
			const root = await Settings.init({ agentDir: dir, cwd: dir });
			const sessionView = root.overlay({});
			createSettingsHost().set("update.auto", true);
			await settings.flush();
			expect(cfgUpdateAuto.get(sessionView)).toBe(true);
			expect(configText()).toMatch(/auto: true/);
			expect(configText()).toContain("setupVersion: 3");
			expect((await launch({ keys: [] })).overlays).toBe(0);
			expect(configText()).toMatch(/auto: true/);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a non-TTY launch shows no question and records no completion",
		async () => {
			// A launch that is not a TTY neither shows the question nor records completion.
			setTty("stdin", false);
			expect((await launch({ keys: [] })).overlays).toBe(0);
			expect(configText()).toContain("setupVersion: 2");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps the answered choice effective in the session when a launch overlay shadows it, and persists it",
		async () => {
			const overlay = path.join(dir, "overlay.yml");
			fs.writeFileSync(overlay, "update:\n  auto: false\n");
			// "1" selects Update automatically, Enter confirms, Esc dismisses splash/outro.
			const result = await launch({ keys: ["\x1b", "1", "\r", "\x1b"], configFiles: [overlay] });
			expect(result.overlays).toBe(1);
			expect(result.effectiveAutoUpdate).toBe(true);
			expect(configText()).toMatch(/auto: true/);
			expect(configText()).toContain("setupVersion: 3");
		},
		TEST_TIMEOUT_MS,
	);
});

describe("source build skips the update question through real startup", () => {
	let binaryDir = "";
	const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-startup-"));
		isolateAmbientEnv();
		binaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-binary-"));
		fs.writeFileSync(path.join(dir, "config.yml"), "setupVersion: 2\n");
		const binary = path.join(binaryDir, "omp");
		fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
		// A compiled omp: the real canSelfUpdate judges the build.json beside process.execPath.
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		Object.defineProperty(process, "execPath", { value: binary, configurable: true, writable: true });
		setTty("stdin", true);
		setTty("stdout", true);
		await initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (execPathDescriptor) Object.defineProperty(process, "execPath", execPathDescriptor);
		for (const [stream, descriptor] of ttyDescriptors) {
			if (descriptor) Object.defineProperty(process[stream as "stdin" | "stdout"], "isTTY", descriptor);
			else Reflect.deleteProperty(process[stream as "stdin" | "stdout"], "isTTY");
		}
		ttyDescriptors.clear();
		restoreAmbientEnv();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(binaryDir, { recursive: true, force: true });
	});

	it(
		"asks the update question of a release binary without build.json",
		async () => {
			expect((await launch({ keys: ["\x1b", "\x1b", "\x1b"] })).overlays).toBe(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"shows no scene for a source build and records the version as seen on the persistent settings",
		async () => {
			fs.writeFileSync(
				path.join(binaryDir, "build.json"),
				JSON.stringify({
					status: "built",
					source_tree: "tree-0123",
					candidate_sha256: "ab".repeat(32),
					version: "1.2.3",
				}),
			);
			expect((await launch({ keys: [] })).overlays).toBe(0);
			expect(configText()).toContain("setupVersion: 3");
			expect(configText()).not.toContain("auto:");
		},
		TEST_TIMEOUT_MS,
	);
});
