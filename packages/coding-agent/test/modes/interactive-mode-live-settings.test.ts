import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createLocalInteractiveSessionConnection } from "@oh-my-pi/pi-coding-agent/modes/interactive-session";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as theme from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

import {
	cfgStatusLineContextLine,
	cfgStatusLineLeftSegments,
	cfgSymbolPreset,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("InteractiveMode live settings", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let reportGlyphProtocol: (supported: boolean) => void;

	beforeAll(async () => {
		await theme.initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-live-ui-settings-");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true, "statusLine.preset": "custom" },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.ui.terminal, "onGlyphProtocolReport").mockImplementation(callback => {
			reportGlyphProtocol = callback;
		});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		await theme.setSymbolPreset("unicode");
		vi.restoreAllMocks();
	});

	it("restores the supplied runtime draft instead of the frontend writer's draft", async () => {
		mode.stop();
		const localRead = vi
			.spyOn(session.sessionManager, "consumeDraft")
			.mockRejectedValue(new Error("frontend writer"));
		const consumeDraft = vi.fn(async () => "Черновик владельца 🐈");
		const connection = { ...createLocalInteractiveSessionConnection(session), consumeDraft };
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			connection,
		);
		await mode.init({ suppressWelcomeIntro: true });
		expect(mode.editor.getText()).toBe("Черновик владельца 🐈");
		expect(consumeDraft).toHaveBeenCalledTimes(1);
		expect(localRead).not.toHaveBeenCalled();
	});

	it("shuts down the supplied owner without disposing the frontend session", async () => {
		mode.stop();
		const events: string[] = [];
		const connection = {
			...createLocalInteractiveSessionConnection(session),
			consumeDraft: async () => null,
			beginDispose: async () => {
				events.push("begin");
			},
			saveDraft: async (text: string) => {
				events.push(`draft:${text}`);
			},
			disposeSession: async () => {
				events.push("dispose");
			},
		};
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			connection,
		);
		await mode.init({ suppressWelcomeIntro: true });
		mode.editor.setText("не отправлено 🐈");
		vi.spyOn(mode.ui.terminal, "drainInput").mockResolvedValue(undefined);
		const localBegin = vi.spyOn(session, "beginDispose");
		const localDispose = vi.spyOn(session, "dispose");
		const quit = vi.spyOn(postmortem, "quit").mockRejectedValue(new Error("captured owner exit"));
		const exitProcess = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => undefined as never);
		try {
			await mode.shutdown();
			expect(exitProcess).toHaveBeenCalledWith(0);
			expect(events).toEqual(["begin", "draft:не отправлено 🐈", "dispose"]);
			expect(localBegin).not.toHaveBeenCalled();
			expect(localDispose).not.toHaveBeenCalled();
		} finally {
			localBegin.mockRestore();
			localDispose.mockRestore();
			quit.mockRestore();
			exitProcess.mockRestore();
		}
	});

	it("applies status-line and thinking-visibility changes made outside the settings panel", async () => {
		cfgStatusLineLeftSegments.set(session.settings, ["time", "model"]);
		cfgStatusLineContextLine.set(session.settings, "off");
		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();

		const effective = mode.statusLine.getEffectiveSettingsForTest();
		expect(effective.leftSegments).toEqual(["time", "model"]);
		expect(effective.contextLine).toBe("off");
		expect(mode.hideThinkingBlock).toBe(true);
	});

	it("coalesces restored agent registrations and renders their final state", async () => {
		const sync = vi.spyOn(mode, "syncRunningSubagentBadge");
		const badge = vi.spyOn(mode.statusLine, "setRunningSubagents");
		const registry = AgentRegistry.global();
		const ids = Array.from({ length: 100 }, (_, index) => `restore-burst-${index}`);
		vi.useFakeTimers();
		try {
			for (const id of ids) {
				registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
			}
			expect(sync).not.toHaveBeenCalled();
			vi.advanceTimersByTime(100);
			expect(sync).toHaveBeenCalledTimes(1);
			expect(badge.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining(ids));
			for (const id of ids) registry.unregister(id);
			vi.advanceTimersByTime(100);
			expect(sync).toHaveBeenCalledTimes(2);
			expect(badge.mock.calls.at(-1)?.[0].some(id => ids.includes(id))).toBe(false);
		} finally {
			vi.useRealTimers();
			for (const id of ids) registry.unregister(id);
		}
	});

	it("keeps an explicitly configured unicode status bar after Glyph Protocol confirmation", async () => {
		cfgSymbolPreset.set(session.settings, "unicode");
		await theme.setSymbolPreset("unicode");
		reportGlyphProtocol(true);
		expect(theme.getSymbolPresetOverride()).toBe("unicode");
		expect(theme.theme.getSymbolPreset()).toBe("unicode");
	});

	it("upgrades an unconfigured unicode status bar after Glyph Protocol confirmation", async () => {
		await theme.setSymbolPreset("unicode");
		reportGlyphProtocol(true);
		expect(theme.getSymbolPresetOverride()).toBe("nerd");
	});
});
