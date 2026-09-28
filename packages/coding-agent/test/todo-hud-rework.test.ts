import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

beforeAll(() => initTheme());
afterEach(() => resetSettingsForTest());

describe("rework attempt TODO HUD", () => {
	it("shows the current resolved attempt and leaves a new row unbadged", async () => {
		const directory = TempDir.createSync("@omp-todo-hud-rework-");
		await Settings.init({ inMemory: true, cwd: directory.path() });
		const auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.create(directory.path(), directory.path());
		const extensionRunner = new ExtensionRunner([], new ExtensionRuntime(), directory.path(), manager, registry);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: registry,
			extensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = () => {};
		mode.ui.requestComponentRender = () => {};
		mode.ui.setFocus = () => {};
		const now = Date.now();
		const prior = [1, 2].map(index => ({
			attemptId: `worker-${index}:${now - index * 60_000}`,
			workerName: `worker-${index}`,
			resolvedModel: "codex-lb/gpt-6-luna",
			effort: index === 1 ? "high" : "xhigh",
			startedAt: now - index * 60_000,
			finishedAt: now - index * 60_000 + 30_000,
			durationMs: 30_000,
			terminalStatus: "completed" as const,
			deliverablePaths: [],
			rejectionReason: `reason ${index}`,
			reflectionAnswer: "Use the next configured rung.",
		}));
		mode.todoPhases = [
			{
				name: "Acceptance",
				tasks: [
					{
						content: "route the rejected row",
						status: "in_progress",
						schedule: {
							dependencies: [],
							owner: "RenderCut",
							resources: [],
							estimate: {
								optimisticSeconds: 60,
								likelySeconds: 90,
								pessimisticSeconds: 120,
								confidence: "medium",
								basis: "fixture for visible HUD behavior",
								updatedAt: now,
							},
							estimateRevision: 1,
							attemptHistory: prior,
							executor: {
								workerId: "RenderCut",
								resolvedModel: "codex-lb/gpt-6-sol",
								thinkingLevel: "medium",
								startedAt: now,
							},
						},
					},
				],
			},
			{ name: "Ordinary", tasks: [{ content: "new first-dispatch row", status: "pending" }] },
		] satisfies TodoPhase[];

		try {
			mode.setTodoExpanded(true);
			const rendered = mode.todoContainer.render(200).join("\n");
			const reworkRow = rendered.split("\n").find(line => line.includes("route the rejected row"));
			const ordinaryRow = rendered.split("\n").find(line => line.includes("new first-dispatch row"));
			expect(reworkRow).toContain("attempt 3 · sol:medium");
			expect(ordinaryRow).toBeDefined();
			expect(ordinaryRow).not.toContain("attempt ");
		} finally {
			mode.stop();
			await session.dispose();
			auth.close();
			directory.removeSync();
		}
	});
});
