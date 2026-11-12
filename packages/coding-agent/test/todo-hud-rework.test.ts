import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { formatTodoModelBadge, InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

import liveReviewRows from "../../reemxy-extensions/extensions/fixtures/reviewdisplay-dc-live.json";

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
					...(
						[
							["flash", "deepseek/deepseek-v4-flash", "minimal", "deepseek-v4-flash · minimal effort"],
							["luna", "codex-lb/gpt-6-luna", "max", "gpt-6-luna · max effort"],
							["pro", "deepseek/deepseek-v4-pro", "low", "deepseek-v4-pro · low effort"],
							["five", "openai/gpt-5", "high", "gpt-5 · high effort"],
						] as const
					).map(([content, resolvedModel, thinkingLevel]) => ({
						content: `${content} model row`,
						status: "in_progress" as const,
						schedule: {
							owner: content,
							resources: [],
							estimate: {
								optimisticSeconds: 60,
								likelySeconds: 90,
								pessimisticSeconds: 120,
								confidence: "medium" as const,
								basis: "fixture for visible HUD behavior",
								updatedAt: now,
							},
							attemptHistory: prior.slice(0, 1),
							dependencies: [],
							executor: { workerId: "RenderCut", resolvedModel, thinkingLevel, startedAt: now },
						},
					})),
				],
			},
			{ name: "Ordinary", tasks: [{ content: "new first-dispatch row", status: "pending" }] },
		] satisfies TodoPhase[];

		const exhaustedRow = {
			content: "Adaptive layout: heat pipes reach heat plant attempt 3",
			status: "pending" as const,
			schedule: {
				attemptHistory: prior,
				executor: {
					workerId: "LandHeatLabels-2",
					resolvedModel: "abliteration/abliterated-model",
					thinkingLevel: "medium",
					startedAt: now - 2000,
					finishedAt: now,
				},
			},
		};
		mode.todoPhases[0]!.tasks.push(exhaustedRow);
		const available = spyOn(registry, "getAvailable").mockReturnValue([]);
		try {
			mode.setTodoExpanded(true);
			const rendered = mode.todoContainer.render(200).join("\n");
			const reworkRow = rendered.split("\n").findLast(line => line.includes("route the rejected row"));
			const ordinaryRow = rendered.split("\n").findLast(line => line.includes("new first-dispatch row"));
			expect(reworkRow).toContain("attempt 3 · gpt-6-sol · medium effort");
			expect(
				rendered.split("\n").findLast(line => line.includes("flash model row") && line.includes("attempt ")),
			).toContain("attempt 2 · deepseek-v4-flash · minimal effort");
			expect(
				rendered.split("\n").findLast(line => line.includes("luna model row") && line.includes("attempt ")),
			).toContain("attempt 2 · gpt-6-luna · max effort");
			expect(
				rendered.split("\n").findLast(line => line.includes("pro model row") && line.includes("attempt ")),
			).toContain("attempt 2 · deepseek-v4-pro · low effort");
			expect(
				rendered.split("\n").findLast(line => line.includes("five model row") && line.includes("attempt ")),
			).toContain("attempt 2 · gpt-5 · high effort");
			expect(ordinaryRow).toBeDefined();
			expect(ordinaryRow).not.toContain("attempt ");
			expect(rendered.split("\n").findLast(line => line.includes(exhaustedRow.content))).not.toContain(
				"abliterated-model",
			);
			available.mockReturnValue([{ ...model, provider: "abliteration", id: "abliterated-model" }]);
			mode.setTodoExpanded(true);
			expect(mode.todoContainer.render(200).join("\n")).toContain("abliterated-model · medium effort");
			const due = Math.floor((now + 14 * 60_000) / 1000);
			manager.appendCustomEntry("reemxy-goal-deadlines", {
				version: 1,
				goalId: "dc",
				goalStartedAt: Math.floor(now / 1000),
				timezone: "UTC",
				active: true,
				baselineDeadlineAt: due,
				stages: [],
				userConstraint: { messageId: "user", quote: "fixed due", recordedAt: Math.floor(now / 1000) },
			});
			mode.todoPhases = [
				{
					name: "Deadline",
					tasks: [
						{
							content: "PDU B callout",
							status: "pending",
							schedule: {
								dependencies: [],
								resources: [],
								owner: "worker",
								estimate: {
									optimisticSeconds: 4620,
									likelySeconds: 4620,
									pessimisticSeconds: 4620,
									confidence: "high",
									basis: "Live 77-minute remaining path",
									updatedAt: due * 1000 - 13 * 60_000,
								},
							},
						},
					],
				},
			];
			mode.setTodoExpanded(true);
			const missed = mode.todoContainer.render(300).join("\n");
			expect(Bun.stripANSI(missed)).toContain("by 64m");
			const summaryLine = missed.split("\n").findLast(line => line.includes("MISSES"))!;
			expect(summaryLine).toContain(theme.fg("error", Bun.stripANSI(summaryLine).trim()));
			mode.todoPhases = structuredClone(mode.todoPhases);
			mode.todoPhases[0]!.tasks[0]!.schedule!.postDeadline = true;
			mode.setTodoExpanded(true);
			const deferred = mode.todoContainer.render(300).join("\n");
			expect(Bun.stripANSI(deferred)).toContain("PDU B callout · after deadline");
			expect(Bun.stripANSI(deferred)).not.toContain("MISSES");
			const live = structuredClone(liveReviewRows) as TodoPhase[];
			live[0]!.tasks[1]!.schedule!.postDeadline = false;
			live[0]!.tasks[0]!.schedule!.reviewPage = "http://localhost:8767/review/dc/";
			mode.setTodos([{ name: "Stale", tasks: [{ content: "old snapshot", status: "pending" }] }]);
			session.setTodoPhases(live);
			mode.setTodoExpanded(true);
			const reviewHud = mode.todoContainer.render(500).join("\n");
			const plain = Bun.stripANSI(reviewHud);
			expect(plain).not.toContain("old snapshot");
			expect(plain).toContain("1 awaiting your review");
			expect(plain).toContain("1 open");
			expect(plain).toContain("◉ Facility 2D");
			expect(plain).toContain("awaiting your review → http://localhost:8767/review/dc/");
			const awaitingLine = reviewHud.split("\n").findLast(line => line.includes("◉ Facility"))!;
			expect(awaitingLine).toContain(theme.fg("accent", "◉ Facility 2D: too much empty space around site"));
			const lateLine = reviewHud
				.split("\n")
				.findLast(line => line.includes("Adaptive Facility: WebGL blit errors and tenant panes"))!;
			expect(lateLine).toContain(
				theme.fg("error", `${theme.checkbox.unchecked} Adaptive Facility: WebGL blit errors and tenant panes`),
			);
		} finally {
			available.mockRestore();
			mode.stop();
			await session.dispose();
			auth.close();
			directory.removeSync();
		}
	});
	it("renders recognizable model names and effort words without cutting model names", () => {
		const cases = [
			["deepseek/deepseek-v4-flash", "minimal", "deepseek-v4-flash · minimal effort"],
			["codex-lb/gpt-6-luna", "max", "gpt-6-luna · max effort"],
			["deepseek/deepseek-v4-pro", "low", "deepseek-v4-pro · low effort"],
			["openai/gpt-5", "high", "gpt-5 · high effort"],
			["codex-lb/gpt-6-luna", undefined, "gpt-6-luna"],
		] as const;
		for (const [identity, effort, expected] of cases) {
			expect(formatTodoModelBadge(identity, effort)).toBe(expected);
		}
	});
});
