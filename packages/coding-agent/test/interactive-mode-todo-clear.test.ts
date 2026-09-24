import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { todoToolRenderer, type TodoItem, type TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgTasksTodoClearDelay } from "@oh-my-pi/pi-coding-agent/tools/settings";

function renderTodos(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.todoContainer.render(120).join("\n"));
}

const FORECAST_TEST_NOW = Date.parse("2026-09-23T09:00:00.000Z");

function scheduleWithEstimate(updatedAt: number): NonNullable<TodoItem["schedule"]> {
	return {
		dependencies: [],
		owner: "WorkerA",
		estimate: {
			optimisticSeconds: 60,
			likelySeconds: 90,
			pessimisticSeconds: 150,
			confidence: "high",
			basis: "estimated from the implementation scope",
			updatedAt,
		},
	};
}

describe("InteractiveMode todo HUD persistence", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let modelRegistry: ModelRegistry;

	async function replaceMode(sessionManager?: SessionManager): Promise<void> {
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
			sessionManager: sessionManager ?? SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-clear-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		await replaceMode();
	});

	afterEach(() => {
		session.setTodoPhases([]);
		mode.setTodos([]);
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function setTodoClearDelay(todoClearDelay: number): void {
		cfgTasksTodoClearDelay.override(session.settings, todoClearDelay);
	}

	it("clears closed todos from the panel instantly without mutating session history", async () => {
		vi.useFakeTimers();
		setTodoClearDelay(0);
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{ content: "done task", status: "completed" },
					{ content: "abandoned task", status: "abandoned" },
				],
			},
		];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(session.getTodoPhases());
		vi.advanceTimersByTime(0);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).not.toContain("done task");
		expect(renderTodos(mode)).not.toContain("abandoned task");
		const compact = Bun.stripANSI(mode.renderCompactStatusLine(120, []).join("\n"));
		expect(compact).not.toContain("TODO");
		expect(session.getTodoPhases()).toEqual(phases);
	});

	/**
	 * Auto-clear used to fire on any list holding a closed task, so a plan the
	 * agent was mid-way through had its finished tasks deleted from the HUD's
	 * copy: the phase counter reset, the checked row vanished, and the stage
	 * renumbered — the panel reported no progress at all until the next `todo`
	 * call restored the real snapshot. It may only fire on a settled list.
	 */
	const unfinishedPlan = (): TodoPhase[] => [
		{
			name: "Implementation",
			tasks: [
				{ content: "done task", status: "completed" },
				{ content: "abandoned task", status: "abandoned" },
				{ content: "current task", status: "in_progress" },
			],
		},
	];

	it("keeps an unfinished plan's progress when the auto-clear delay elapses", () => {
		setTodoClearDelay(1);
		vi.useFakeTimers();

		mode.setTodos(unfinishedPlan());
		vi.advanceTimersByTime(60_000);

		const rendered = renderTodos(mode);
		// Progress counts every closed task, abandoned included: the walking
		// viewport hides both, so the counter is the only signal they existed.
		expect(rendered).toContain("2/3");
		expect(rendered).toContain("current task");
	});

	it("keeps the pinned HUD as the only task tree beside an expanded mutation result", () => {
		const phases = unfinishedPlan();
		mode.setTodos(phases);

		const mutationTranscript = Bun.stripANSI(
			todoToolRenderer
				.renderResult(
					{
						content: [{ type: "text", text: "" }],
						details: { op: "done", phases, storage: "session" },
						isError: false,
					},
					{ expanded: true, isPartial: false },
					theme,
				)
				.render(120)
				.join("\n"),
		);
		const pinnedHud = renderTodos(mode);

		expect(mutationTranscript).not.toContain("current task");
		expect(pinnedHud.match(/current task/g)?.length ?? 0).toBe(1);
		expect(pinnedHud).toContain("2/3");
	});

	it("keeps an unfinished plan's progress when auto-clear is instant", () => {
		setTodoClearDelay(0);

		mode.setTodos(unfinishedPlan());

		const rendered = renderTodos(mode);
		expect(rendered).toContain("2/3");
		expect(rendered).toContain("current task");
	});

	it("leaves closed todos visible when auto-clear is disabled", () => {
		setTodoClearDelay(-1);

		mode.setTodos([{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }]);

		expect(renderTodos(mode)).toContain("done task");
	});

	it("renders a concise ETA and task forecast in normal and compact TODO views", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(FORECAST_TEST_NOW));
		setTodoClearDelay(-1);
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{ content: "planned task", status: "in_progress", schedule: scheduleWithEstimate(FORECAST_TEST_NOW) },
				],
			},
		];
		mode.setTodos(phases);

		const rendered = renderTodos(mode).toLowerCase();
		expect(rendered).toContain("eta");
		expect(rendered).toContain("critical");
		expect(rendered).toContain("planned task");

		const compact = Bun.stripANSI(mode.renderCompactStatusLine(160, []).join("\n")).toLowerCase();
		expect(compact).toContain("eta");
		expect(compact).toContain("critical");

		mode.todoExpanded = true;
		mode.setTodos(phases);
		const expanded = renderTodos(mode).toLowerCase();
		expect(expanded).toContain("workera");
		expect(expanded).not.toMatch(/fixed-path|p95|cpm|confidence|float|eta eta/);
		mode.todoExpanded = false;
	});

	it("compacts blocked and prerequisite reasons in the HUD and restores them when expanded", () => {
		setTodoClearDelay(-1);
		const reason = "waiting for the upstream worker to finish its unusually long review";
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{ content: "Blocked item", status: "blocked", blocker: reason },
					{ content: "Waiting item", status: "pending", schedule: { dependencies: ["Blocked item"] } },
				],
			},
		];
		mode.todoExpanded = false;
		mode.setTodos(phases);

		const compact = renderTodos(mode);
		const compactLines = compact.split("\n");
		expect(compactLines.filter(line => line.includes("needs unblock:")).length).toBe(1);
		expect(compactLines.filter(line => line.includes("awaits prerequisite:")).length).toBe(1);
		expect(compact).toContain("waiting for the upstream");
		expect(compact).toContain("…");
		expect(compact).not.toContain(reason);

		mode.todoExpanded = true;
		mode.setTodos(phases);
		try {
			const expanded = Bun.stripANSI(mode.todoContainer.render(240).join("\n")).replace(/\s+/g, " ");
			expect(expanded).toContain(`Blocked item: ${reason}`);
			expect(expanded).toContain(`needs unblock: ${reason}`);
			expect(expanded).toContain(reason);
		} finally {
			mode.todoExpanded = false;
		}
	});

	it("retains unresolved task state and sanitized expanded schedule metadata", () => {
		setTodoClearDelay(-1);
		mode.todoExpanded = true;
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{
						content: "unestimated task",
						status: "pending",
						schedule: {
							owner: `${String.fromCharCode(27)}]0;unsafe${String.fromCharCode(7)}WorkerB`,
							dependencies: ["upstream task"],
						},
					},
				],
			},
		];
		mode.setTodos(phases);

		const row = forecastTodoPlan(phases, { now: FORECAST_TEST_NOW }).rows[0];
		expect(row).toMatchObject({ status: "pending", estimateRequired: true });
		expect([row.resourceFinish, row.expectedResourceFinish, row.earliestFinish]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		const raw = mode.todoContainer.render(120).join("\n");
		const rendered = Bun.stripANSI(raw).toLowerCase();
		expect(rendered).not.toMatch(/\b\d{2}:\d{2}\b/);
		expect(rendered).toContain("workerb");
		expect(raw).not.toContain(`${String.fromCharCode(27)}]0;`);
		mode.todoExpanded = false;
	});

	it("keeps the later active section visible and its ETA fixed when wall clock advances", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(FORECAST_TEST_NOW));
		setTodoClearDelay(-1);
		const phases: TodoPhase[] = [
			{ name: "Earlier pending", tasks: [{ content: "later work", status: "pending" }] },
			{
				name: "Current repair",
				tasks: [
					{
						content: "visible current work",
						status: "in_progress",
						schedule: scheduleWithEstimate(FORECAST_TEST_NOW),
					},
				],
			},
		];
		mode.setTodos(phases);
		const before = renderTodos(mode);
		expect(before).toContain("II. Current repair");
		expect(before).toContain("visible current work");
		const beforeEta = forecastTodoPlan(phases, { now: FORECAST_TEST_NOW }).rows.find(
			row => row.content === "visible current work",
		)?.resourceFinish;
		expect(beforeEta).toBeDefined();
		vi.advanceTimersByTime(180_000);
		const after = renderTodos(mode);
		expect(after).toContain("visible current work");
		const laterRow = forecastTodoPlan(phases, { now: FORECAST_TEST_NOW + 180_000 }).rows.find(
			row => row.content === "visible current work",
		);
		expect(laterRow?.resourceFinish).toBe(beforeEta);
		expect(laterRow?.overdue).toBe(true);
		expect(phases[1].tasks[0].schedule?.estimate?.updatedAt).toBe(FORECAST_TEST_NOW);
	});

	it("uses the active native goal deadline to report an overdue TODO forecast", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(FORECAST_TEST_NOW));
		setTodoClearDelay(-1);
		const goalId = "todo-render-deadline-test";
		session.sessionManager.appendCustomEntry("pi-goal-state", {
			goal: { id: goalId, createdAt: FORECAST_TEST_NOW - 60_000, status: "active" },
		});
		session.sessionManager.appendCustomEntry("reemxy-goal-deadlines", {
			version: 1,
			goalId,
			goalStartedAt: Math.floor((FORECAST_TEST_NOW - 60_000) / 1000),
			timezone: "UTC",
			active: true,
			stages: [
				{
					id: "ship",
					label: "Ship",
					expectedResult: "Verified",
					deadlineAt: Math.floor((FORECAST_TEST_NOW - 60_000) / 1000),
				},
			],
		});

		try {
			mode.setTodos([
				{
					name: "Implementation",
					tasks: [
						{
							content: "deliver after deadline",
							status: "in_progress",
							schedule: scheduleWithEstimate(FORECAST_TEST_NOW),
						},
					],
				},
			]);
			const rendered = renderTodos(mode).toLowerCase();
			expect(rendered).toContain("overdue");
		} finally {
			session.sessionManager.appendCustomEntry("pi-goal-state", { goal: null });
		}
	});

	it("reloads the visible HUD from the explicitly attached session", async () => {
		setTodoClearDelay(-1);
		const focusedDir = TempDir.createSync("@pi-focused-todo-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const focusedSession = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(focusedDir.path(), focusedDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		try {
			session.setTodoPhases([{ name: "Main plan", tasks: [{ content: "stale main task", status: "in_progress" }] }]);
			mode.setTodos(session.getTodoPhases());
			focusedSession.setTodoPhases([
				{
					name: "Worker plan",
					tasks: [
						{ content: "finished worker task", status: "completed" },
						{ content: "current worker task", status: "in_progress", schedule: scheduleWithEstimate(Date.now()) },
					],
				},
			]);

			await mode.reloadTodos(focusedSession);

			const rendered = renderTodos(mode);
			expect(rendered).toContain("Worker plan");
			expect(rendered).toContain("1/2");
			expect(rendered).toContain("current worker task");
			expect(rendered).not.toContain("stale main task");
		} finally {
			await focusedSession.dispose();
			focusedDir.removeSync();
		}
	});

	it("clears closed todos after the configured delay", async () => {
		setTodoClearDelay(1);
		vi.useFakeTimers();

		const phases: TodoPhase[] = [{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(session.getTodoPhases());
		expect(renderTodos(mode)).toContain("done task");

		vi.advanceTimersByTime(999);
		expect(renderTodos(mode)).toContain("done task");
		expect(renderTodos(mode)).toContain("TODO");

		vi.advanceTimersByTime(1);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).not.toContain("done task");
	});

	it("keeps TODOs open after worker completion and preserves the active worker HUD", async () => {
		await replaceMode();
		setTodoClearDelay(-1);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{ content: "Fix review comments", status: "pending" },
					{ content: "Fix review comments", status: "in_progress" },
					{ content: "Fix review comments", status: "blocked", blocker: "waiting on ReviewFixer" },
				],
			},
		];
		session.setTodoPhases(phases);
		mode.setTodos(session.getTodoPhases());
		await mode.init();
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "ReviewFixer",
			index: 0,
			agent: "task",
			description: "Fix review comments",
			status: "completed",
			detached: true,
		});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "NeighborWorker",
			index: 1,
			agent: "task",
			description: "Inspect adjacent work",
			status: "started",
			detached: true,
		});
		vi.advanceTimersByTime(100);

		expect(session.getTodoPhases()).toEqual(phases);
		expect(renderTodos(mode)).toContain("Fix review comments");
		expect(renderTodos(mode)).toContain("unassigned workers");
		expect(renderTodos(mode)).toContain("Inspect adjacent work");
		expect(mode.subagentContainer.render(120)).toEqual([]);
	});

	it("completes and auto-dismisses only after an explicit Main TODO done command", async () => {
		await replaceMode();
		setTodoClearDelay(1);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const startedAt = Date.now() - 60_000;
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{
						content: "Fix review comments",
						status: "in_progress",
						schedule: { ...scheduleWithEstimate(startedAt), startedAt },
					},
				],
			},
		];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(session.getTodoPhases());
		await mode.init();
		vi.useFakeTimers();
		await mode.handleTodoCommand("done Fix review comments");
		expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
		expect(renderTodos(mode)).toContain("Fix review comments");
		vi.advanceTimersByTime(999);
		expect(renderTodos(mode)).toContain("Fix review comments");
		vi.advanceTimersByTime(1);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		const completedForecast = forecastTodoPlan(session.getTodoPhases(), { now: Date.now() });
		expect(completedForecast.rows[0]?.finishedAt).toBeGreaterThan(startedAt);
		expect(completedForecast.rows[0]?.earliestStart).toBe(startedAt);
		expect(renderTodos(mode)).toBe("");
	});
	it("does not persist a stale reveal after the owning snapshot changes", async () => {
		await replaceMode();
		vi.useFakeTimers();
		const settle = Promise.withResolvers<void>();
		vi.spyOn(session, "settleInFlightMessagePersistence").mockReturnValue(settle.promise);
		const oldPhases: TodoPhase[] = [{ name: "Old", tasks: [{ content: "old", status: "completed" }] }];
		const newPhases: TodoPhase[] = [{ name: "New", tasks: [{ content: "new", status: "in_progress" }] }];
		mode.setTodos(oldPhases);
		mode.setTodoExpanded(true);
		mode.setTodos(newPhases);
		settle.resolve();
		await Promise.resolve();
		expect(
			session.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === "todo_hud_state"),
		).toBe(false);
		expect(renderTodos(mode)).toContain("new");
	});

	it("keeps a newer canonical TODO edit after an older result finishes persisting", async () => {
		await replaceMode();
		const settle = Promise.withResolvers<void>();
		vi.spyOn(session, "settleInFlightMessagePersistence").mockReturnValue(settle.promise);
		const older: TodoPhase[] = [{ name: "Old", tasks: [{ content: "old task", status: "in_progress" }] }];
		const newer: TodoPhase[] = [{ name: "New", tasks: [{ content: "new task", status: "in_progress" }] }];
		session.setTodoPhases(older);
		mode.setTodos(older);
		const pending = mode.eventController.handleEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "todo",
				toolCallId: "old-todo",
				content: [],
				isError: false,
				timestamp: Date.now(),
				details: { phases: older },
			},
		});
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases: newer });
		session.setTodoPhases(newer);
		mode.setTodos(newer);
		settle.resolve();
		await pending;
		expect(session.getTodoPhases()).toEqual(newer);
		expect(renderTodos(mode)).toContain("new task");
		expect(renderTodos(mode)).not.toContain("old task");
	});

	it("cancels an old dismissal timer when a replacement plan becomes visible", async () => {
		await replaceMode();
		vi.useFakeTimers();
		cfgTasksTodoClearDelay.override(session.settings, 1);
		const completed: TodoPhase[] = [{ name: "Old", tasks: [{ content: "old", status: "completed" }] }];
		const replacement: TodoPhase[] = [{ name: "New", tasks: [{ content: "new", status: "in_progress" }] }];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases: completed });
		mode.setTodos(completed);
		vi.advanceTimersByTime(500);
		mode.setTodos(replacement);
		vi.advanceTimersByTime(1000);
		await Promise.resolve();
		expect(renderTodos(mode)).toContain("new");
		expect(renderTodos(mode)).not.toContain("old");
	});

	it("treats identical canonical todo edits as new snapshots after dismissal", async () => {
		await replaceMode();
		vi.useFakeTimers();
		setTodoClearDelay(1);
		const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "same task", status: "completed" }] }];
		const oldSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		vi.advanceTimersByTime(1000);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).toBe("");

		const newSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		expect(newSourceEntryId).not.toBe(oldSourceEntryId);
		expect(renderTodos(mode)).toContain("same task");

		vi.advanceTimersByTime(1000);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).toBe("");
		expect(session.getTodoPhases()).toEqual(phases);
		expect(
			session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === "user_todo_edit")
				.map(entry => entry.id),
		).toEqual([oldSourceEntryId, newSourceEntryId]);
	});

	it("does not carry a pending dismissal into a new session with identical todos", async () => {
		await replaceMode();
		vi.useFakeTimers();
		setTodoClearDelay(1);
		const settle = Promise.withResolvers<void>();
		vi.spyOn(session, "settleInFlightMessagePersistence").mockReturnValue(settle.promise);
		const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "same task", status: "completed" }] }];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		const oldSessionId = session.sessionManager.getSessionId();
		vi.advanceTimersByTime(1000);

		await session.sessionManager.newSession();
		const newSessionId = session.sessionManager.getSessionId();
		const newSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		expect(newSessionId).not.toBe(oldSessionId);
		expect(renderTodos(mode)).toContain("same task");

		settle.resolve();
		await Promise.resolve();
		await session.sessionManager.flush();
		await Promise.resolve();
		expect(renderTodos(mode)).toContain("same task");
		expect(session.getTodoPhases()).toEqual(phases);
		expect(
			session.sessionManager.getBranch().map(entry => ({
				id: entry.id,
				customType: entry.type === "custom" ? entry.customType : undefined,
			})),
		).toEqual([{ id: newSourceEntryId, customType: "user_todo_edit" }]);
	});

	it("persists dismissal and explicit reveal across fresh session loads without losing tasks", async () => {
		await replaceMode();
		vi.useFakeTimers();
		const phases: TodoPhase[] = [
			{
				name: "Done",
				tasks: [{ content: "ship", status: "completed", schedule: scheduleWithEstimate(Date.now()) }],
			},
		];
		cfgTasksTodoClearDelay.override(session.settings, 0);
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Finished the plan." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		vi.advanceTimersByTime(0);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).toBe("");
		expect(session.getTodoPhases()).toEqual(phases);
		const file = session.sessionManager.getSessionFile()!;
		await replaceMode(await SessionManager.open(file));
		await mode.reloadTodos();
		expect(renderTodos(mode)).toBe("");
		expect(session.getTodoPhases()).toEqual(phases);
		mode.todoExpanded = true;
		await mode.handleTodoCommand("expand");
		expect(renderTodos(mode)).toContain("ship");
		await session.sessionManager.flush();
		await replaceMode(await SessionManager.open(file));
		await mode.reloadTodos();
		expect(renderTodos(mode)).toContain("ship");
		expect(session.getTodoPhases()).toEqual(phases);
	});
});

describe("InteractiveMode todo HUD anchor", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-hud-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(() => {
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

	it("keeps phase identities and progress while displaying dependency-ready tasks", () => {
		mode.setTodos([
			{
				name: "Foundation",
				tasks: [
					{ content: "first task", status: "completed" },
					{ content: "second task", status: "in_progress" },
					{ content: "third task", status: "pending" },
				],
			},
			{
				name: "Verification",
				tasks: [{ content: "run tests", status: "pending" }],
			},
		]);

		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));

		// Lightened: no boxed top/bottom rules.
		expect(lines.some(line => line === "─".repeat(80))).toBe(false);
		// The title remains a compact anchor; overall progress colors the tree
		// spine and tail, not the title text.
		const root = lines.find(line => line.includes("TODO"));
		expect(root?.trim()).toBe("TODO");
		// Active stage: highlighted header with its own task progress, expanded as a
		// connector tree; the just-completed task stays as the lead row so progress
		// is visible while the stage still has open work.
		expect(lines.some(line => line.includes("I. Foundation") && line.includes("1/3"))).toBe(true);
		const secondLine = lines.find(line => line.includes("second task"));
		expect(secondLine).toContain(theme.tree.branch);
		expect(secondLine).toContain(theme.checkbox.unchecked);
		expect(lines.some(line => line.includes("third task"))).toBe(true);
		const firstLine = lines.find(line => line.includes("first task"));
		expect(firstLine).toContain(theme.checkbox.checked);
		expect(lines.some(line => line.includes("II. Verification") && line.includes("0/1"))).toBe(true);
		// No overflow rows — the header/progress counts imply what is hidden.
		expect(lines.some(line => line.includes("more"))).toBe(false);
	});

	it("renders nothing when there are no todos", () => {
		mode.setTodos([]);
		expect(mode.todoContainer.render(80)).toHaveLength(0);
	});

	it("keeps the summed progress bar but omits the roman numeral for a single-phase list", () => {
		mode.setTodos([
			{
				name: "Tasks",
				tasks: [
					{ content: "alpha", status: "pending" },
					{ content: "beta", status: "pending" },
				],
			},
		]);
		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));
		// One stage still renders the compact title; progress belongs to the
		// tree spine and tail.
		const root = lines.find(line => line.includes("TODO"));
		expect(root?.trim()).toBe("TODO");
		// The stage keeps its task progress; no roman numeral for a lone stage.
		expect(lines.some(line => line.includes("Tasks") && line.includes("0/2"))).toBe(true);
		expect(lines.some(line => line.includes("I. Tasks"))).toBe(false);
		expect(lines.some(line => line.includes("alpha"))).toBe(true);
	});

	it("bounds a multi-phase display and reports the hidden task count", () => {
		const stage = (name: string): TodoPhase => ({ name, tasks: [{ content: `${name} task`, status: "pending" }] });
		mode.setTodos([
			stage("Discovery"),
			stage("Two"),
			stage("Three"),
			stage("Four"),
			stage("Five"),
			stage("Six"),
			stage("Seven"),
		]);
		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));
		expect(lines.some(line => line.includes("II. Two"))).toBe(true);
		expect(lines.some(line => line.includes("V. Five"))).toBe(true);
		expect(lines.some(line => line.includes("Six"))).toBe(false);
		expect(lines.some(line => line.includes("2 more todos"))).toBe(true);
		// Hidden stages do not change the compact title.
		const root = lines.find(line => line.includes("TODO"));
		expect(root?.trim()).toBe("TODO");
	});

	it("renders one hidden task instead of a same-row overflow summary", () => {
		mode.setTodos([
			{
				name: "Tasks",
				tasks: Array.from({ length: 6 }, (_, index): TodoItem => ({
					content: `Task ${index + 1}`,
					status: index === 0 ? "in_progress" : "pending",
				})),
			},
		]);
		expect(renderTodos(mode)).toContain("Task 6");
		expect(renderTodos(mode)).not.toContain("more todo");

		mode.setTodos([
			{
				name: "Tasks",
				tasks: Array.from({ length: 7 }, (_, index): TodoItem => ({
					content: `Task ${index + 1}`,
					status: index === 0 ? "in_progress" : "pending",
				})),
			},
		]);
		expect(renderTodos(mode)).not.toContain("Task 7");
		expect(renderTodos(mode)).toContain("2 more todos");
	});

	it("uses one hidden task's original phase and task instead of a summary", () => {
		const stage = (name: string): TodoPhase => ({ name, tasks: [{ content: `${name} task`, status: "pending" }] });
		mode.setTodos([stage("One"), stage("Two"), stage("Three"), stage("Four"), stage("Five"), stage("Six")]);
		const oneHidden = renderTodos(mode);
		expect(oneHidden).toContain("VI. Six");
		expect(oneHidden).not.toContain("more stage");
	});

	it("expands and collapses the complete todo HUD through /todo", async () => {
		mode.setTodos([
			{
				name: "Implementation",
				tasks: Array.from({ length: 8 }, (_, index): TodoItem => ({
					content: `Task ${index + 1}`,
					status: index === 0 ? "in_progress" : "pending",
				})),
			},
		]);

		await mode.handleTodoCommand("expand");
		await mode.handleTodoCommand("expand");

		expect(renderTodos(mode)).toContain("Task 8");
		expect(renderTodos(mode)).not.toContain("more todo");

		await mode.handleTodoCommand("collapse");
		await mode.handleTodoCommand("collapse");

		expect(renderTodos(mode)).not.toContain("Task 8");
		expect(renderTodos(mode)).toContain("3 more todos");
	});

	describe("compact todo for small terminal height (< 18 rows)", () => {
		function setTerminalRows(rows: number): void {
			Object.defineProperty(mode.ui.terminal, "rows", {
				get: () => rows,
				configurable: true,
			});
		}

		afterEach(() => {
			setTerminalRows(24);
			mode.loadingAnimation = undefined;
			mode.statusContainer.disposeChildren();
		});

		it("renders todo as a single line item aligned to the right when terminal height < 18", () => {
			setTerminalRows(15);
			mode.setTodos([
				{
					name: "Phase 1",
					tasks: [
						{ content: "Setup database", status: "completed" },
						{ content: "Create API endpoints", status: "in_progress" },
						{ content: "Write tests", status: "pending" },
					],
				},
			]);

			// todoContainer is empty in compact mode
			expect(mode.todoContainer.render(100)).toHaveLength(0);

			// statusContainer renders the compact right-aligned todo above editor
			const rendered = mode.statusContainer.render(100);
			expect(rendered.length).toBeGreaterThan(0);
			const lastLine = Bun.stripANSI(rendered[rendered.length - 1] ?? "");
			expect(lastLine).toContain("TODO 1/3");
			expect(lastLine).toContain("Create API endpoints");
			// Right-aligned: ends with the todo text (with trailing space)
			expect(lastLine.trimEnd().endsWith("Create API endpoints")).toBe(true);
			expect(lastLine.startsWith(" ")).toBe(true);
		});

		it("places compact todo on the right side of the active loader / intent spinner", () => {
			setTerminalRows(14);
			mode.setTodos([
				{
					name: "Tasks",
					tasks: [
						{ content: "Inspect server", status: "in_progress" },
						{ content: "Deploy fix", status: "pending" },
					],
				},
			]);

			mode.ensureLoadingAnimation();
			mode.setWorkingMessage("Reading src/index.ts (esc to interrupt)");

			expect(mode.todoContainer.render(120)).toHaveLength(0);

			const rendered = mode.statusContainer.render(120);
			expect(rendered.length).toBeGreaterThanOrEqual(2);
			const lastLine = Bun.stripANSI(rendered[rendered.length - 1] ?? "");
			// Left side has the intent spinner/message
			expect(lastLine).toContain("Reading src/index.ts");
			// Right side has the compact todo
			expect(lastLine).toContain("TODO 0/2");
			expect(lastLine).toContain("Inspect server");
			// Left message comes before right todo
			expect(lastLine.indexOf("Reading src/index.ts")).toBeLessThan(lastLine.indexOf("TODO 0/2"));
		});

		it("shows completed summary when all tasks are done in compact mode", () => {
			setTerminalRows(16);
			mode.setTodos([
				{
					name: "Tasks",
					tasks: [
						{ content: "Task 1", status: "completed" },
						{ content: "Task 2", status: "completed" },
					],
				},
			]);

			const rendered = mode.statusContainer.render(100);
			const lastLine = Bun.stripANSI(rendered[rendered.length - 1] ?? "");
			expect(lastLine).toContain("TODO 2/2");
			expect(lastLine).toContain("done");
		});

		it("switches dynamically between multi-line HUD and compact single line on resize", () => {
			mode.setTodos([
				{
					name: "Tasks",
					tasks: [{ content: "Refactor router", status: "in_progress" }],
				},
			]);

			// Terminal >= 18 rows: full tree HUD
			setTerminalRows(24);
			expect(mode.todoContainer.render(100).length).toBeGreaterThan(0);
			expect(mode.statusContainer.render(100)).toHaveLength(0);

			// Terminal < 18 rows: compact mode
			setTerminalRows(15);
			expect(mode.todoContainer.render(100)).toHaveLength(0);
			expect(mode.statusContainer.render(100).length).toBeGreaterThan(0);
			const compactLine = Bun.stripANSI(mode.statusContainer.render(100).slice(-1)[0] ?? "");
			expect(compactLine).toContain("TODO 0/1");
			expect(compactLine).toContain("Refactor router");

			// Resize back >= 18 rows
			setTerminalRows(24);
			expect(mode.todoContainer.render(100).length).toBeGreaterThan(0);
			expect(mode.statusContainer.render(100)).toHaveLength(0);
		});
	});
});
