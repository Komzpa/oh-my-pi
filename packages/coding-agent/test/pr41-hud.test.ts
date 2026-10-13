import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgTasksTodoClearDelay } from "@oh-my-pi/pi-coding-agent/tools/settings";

const AT = "2026-09-28T12:00:00.000Z";

describe("pr41-hud", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let modelRegistry: ModelRegistry;

	async function replaceMode(): Promise<void> {
		if (mode) {
			mode.stop();
			await session.dispose();
		}
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-pr41-hud-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		await replaceMode();
	});

	afterEach(() => {
		session.sessionManager.appendCustomEntry("requirements_ledger", { version: 1, requirements: [] });
		session.setTodoPhases([]);
		mode.setTodos([]);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("returns separate width-truncated rows when the base HUD is empty", async () => {
		await replaceMode();
		cfgTasksTodoClearDelay.override(session.settings, -1);
		session.sessionManager.appendCustomEntry("requirements_ledger", {
			version: 1,
			requirements: [{ id: "R1", at: AT, rawText: "linked ask", classification: "linked", rows: ["Some row"] }],
		});
		mode.setTodos([]);
		await mode.init();
		const width = 20;
		const rows = mode.renderRequirementHudSegment(() => [], width);
		expect(rows.length).toBe(2);
		for (const row of rows) expect(row).not.toContain("\n");
		for (const row of rows) expect(visibleWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(width);
		expect(Bun.stripANSI(rows.join("\n"))).toContain("req 1");
	});

	it("exposes a native requirement summary even with no checklist rows", async () => {
		await replaceMode();
		session.sessionManager.appendCustomEntry("requirements_ledger", {
			version: 1,
			requirements: [{ id: "R1", at: AT, rawText: "linked ask", classification: "linked", rows: ["Some row"] }],
		});
		mode.setTodos([]);
		await mode.init();
		expect(mode.todoHudNative).toBeUndefined();
		const summary = mode.describeRequirementHudSummary();
		expect(summary).toBeDefined();
		expect(JSON.stringify(summary)).toContain("req 1");
		session.sessionManager.appendCustomEntry("requirements_ledger", { version: 1, requirements: [] });
		expect(mode.describeRequirementHudSummary()).toBeUndefined();
	});
});
