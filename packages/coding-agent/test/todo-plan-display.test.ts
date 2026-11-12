import { expect, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";
import live from "../../tui/test/fixtures/plandisplay-dc.json";

test("collapsed live DC HUD reads ledger and live audit assignments without warning or detail noise", async () => {
	await initTheme();
	const directory = TempDir.createSync("@omp-plan-display-");
	await Settings.init({ inMemory: true, cwd: directory.path() });
	const auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
	const registry = new ModelRegistry(auth);
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const manager = SessionManager.create(directory.path(), directory.path());
	manager.appendCustomEntry("requirements_ledger", { requirements: live.requirements });
	manager.appendCustomEntry("requirements_auditor_assignments", { jobs: live.auditors });
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: registry,
	});
	const bus = new EventBus();
	const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, bus);
	mode.ui.requestRender = () => {};
	mode.ui.requestComponentRender = () => {};
	mode.ui.setFocus = () => {};
	try {
		await mode.init({ suppressWelcomeIntro: true });
		for (const [index, id] of ["AuditMaxTheme", "AuditMacPerf-3"].entries())
			bus.emit("task:subagent:lifecycle", {
				id,
				index,
				agent: "qa-auditor",
				agentSource: "bundled",
				status: "started",
				detached: true,
			});
		mode.setTodos(structuredClone(live.phases) as TodoPhase[]);
		mode.setTodoExpanded(false);
		const output = Bun.stripANSI(mode.todoContainer.render(200).join("\n"));
		expect(output).toContain("13 open — 0 working · 3 auditing");
		expect(output).not.toContain("0 waiting");
		expect(output).not.toContain("queue/downtime unknown");
		expect(output).toContain("requirements 54/169 passed · 4 failed");
		expect(output).toContain("Measure XMOVA render performance on mccatie M1 GPU — auditing");
		expect(output).not.toContain("effort O/L/P");
		expect(output).not.toContain("commit not visible");
		expect(output).not.toContain("(blocked)");
	} finally {
		mode.stop();
		await session.dispose();
		auth.close();
		directory.removeSync();
		resetSettingsForTest();
	}
});
