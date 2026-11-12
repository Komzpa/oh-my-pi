import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
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
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	createRequirementCandidates,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";

function renderTodos(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.todoContainer.render(120).join("\n"));
}

function setModeTodos(mode: InteractiveMode, session: AgentSession, todos: TodoItem[] | TodoPhase[]): void {
	const phases =
		todos.length > 0 && "tasks" in todos[0]
			? (todos as TodoPhase[])
			: [{ name: "Todos", tasks: todos as TodoItem[] }];
	session.setTodoPhases(phases);
	mode.setTodos(todos);
}

function setExpandedModeTodos(mode: InteractiveMode, session: AgentSession, todos: TodoPhase[]): void {
	mode.todoExpanded = true;
	setModeTodos(mode, session, todos);
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
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
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
		mode.todoExpanded = false;
		session.setTodoPhases([]);
		setModeTodos(mode, session, []);
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

	it("preserves row bindings and leaves requirement-linked rows open during subagent reconciliation", async () => {
		await replaceMode();
		setTodoClearDelay(-1);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const cwd = tempDir.path();
		const phases = [
			{
				name: "Implementation",
				tasks: [
					{
						content: "linked row",
						status: "pending",
						schedule: { owner: "Auditor", resources: [cwd] },
						artifactCwd: cwd,
						artifactOwner: "Worker",
					},
					{
						content: "unlinked row",
						status: "blocked",
						blocker: "waiting for worker",
						schedule: { owner: "Worker", resources: [cwd] },
						artifactCwd: cwd,
						artifactOwner: "Worker",
					},
				],
			},
		] as unknown as TodoPhase[];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		const linked = classifyRequirement(
			createRequirementCandidates(
				[],
				["Keep the linked row open until its audit passes"],
				"2026-10-25T12:00:00.000Z",
			),
			"R1",
			"linked",
			{ rows: ["linked row"] },
		);
		if ("error" in linked) throw new Error(linked.error);
		appendRequirementsSnapshot(
			{ appendEntry: (customType, data) => session.sessionManager.appendCustomEntry(customType, data) },
			linked.requirements,
		);
		mode.setTodos(session.getTodoPhases());
		await mode.init();

		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Worker",
			index: 0,
			agent: "task",
			description: "linked row and unlinked row",
			status: "completed",
			detached: true,
		});
		vi.advanceTimersByTime(100);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();

		const result = session.getTodoPhases()[0]?.tasks;
		expect(result?.[0]).toMatchObject({
			content: "linked row",
			status: "pending",
			artifactCwd: cwd,
			artifactOwner: "Worker",
		});
		expect(result?.[1]).toMatchObject({
			content: "unlinked row",
			status: "blocked",
			schedule: { owner: "Worker", resources: [cwd] },
			artifactCwd: cwd,
			artifactOwner: "Worker",
		});
		expect(result?.[1]?.blocker).toBe("waiting for worker");
		appendRequirementsSnapshot(
			{ appendEntry: (customType, data) => session.sessionManager.appendCustomEntry(customType, data) },
			[],
		);
	});

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
		setModeTodos(mode, session, session.getTodoPhases());
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

		setModeTodos(mode, session, unfinishedPlan());
		vi.advanceTimersByTime(60_000);

		const rendered = renderTodos(mode);
		// Progress counts every closed task, abandoned included: the walking
		// viewport hides both, so the counter is the only signal they existed.
		expect(rendered).toContain("2/3");
		expect(rendered).toContain("current task");
	});

	it("keeps the pinned HUD as the only task tree beside an expanded mutation result", () => {
		const phases = unfinishedPlan();
		setModeTodos(mode, session, phases);

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

	it("renders session todos after global settings are reset", async () => {
		resetSettingsForTest();
		try {
			setModeTodos(mode, session, [
				{ name: "Active", tasks: [{ content: "Keep the session plan", status: "pending" }] },
			]);
			expect(mode.todoContainer.render(120).join("\n")).toContain("Keep the session plan");
		} finally {
			await Settings.init({ inMemory: true, cwd: tempDir.path() });
		}
	});

	it("keeps an unfinished plan's progress when auto-clear is instant", () => {
		setTodoClearDelay(0);

		setModeTodos(mode, session, unfinishedPlan());

		const rendered = renderTodos(mode);
		expect(rendered).toContain("2/3");
		expect(rendered).toContain("current task");
	});

	it("leaves closed todos visible when auto-clear is disabled", () => {
		setTodoClearDelay(-1);

		setExpandedModeTodos(mode, session, [
			{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] },
		]);

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
		setModeTodos(mode, session, phases);

		const rendered = renderTodos(mode).toLowerCase();
		expect(rendered).toContain("eta");
		expect(rendered).toContain("critical");
		expect(rendered).toContain("planned task");

		const compact = Bun.stripANSI(mode.renderCompactStatusLine(160, []).join("\n")).toLowerCase();
		expect(compact).toContain("eta");
		expect(compact).toContain("critical");

		mode.todoExpanded = true;
		setModeTodos(mode, session, phases);
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
		setModeTodos(mode, session, phases);

		const compact = renderTodos(mode);
		const compactLines = compact.split("\n");
		expect(compactLines.filter(line => line.includes("needs unblock:")).length).toBe(1);
		expect(compactLines.filter(line => line.includes("awaits prerequisite:")).length).toBe(1);
		expect(compact).toContain("waiting for the upstream");
		expect(compact).toContain("…");
		expect(compact).not.toContain(reason);

		mode.todoExpanded = true;
		setModeTodos(mode, session, phases);
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
		setModeTodos(mode, session, phases);

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
		setExpandedModeTodos(mode, session, phases);
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
			setModeTodos(mode, session, [
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
			setModeTodos(mode, session, session.getTodoPhases());
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
		setExpandedModeTodos(mode, session, session.getTodoPhases());
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
		setModeTodos(mode, session, session.getTodoPhases());
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
		// A real plan is active: the TODO tree alone accounts for every live
		// worker, so the pinned Subagents panel must not repeat them.
		const pinnedWorkers = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(pinnedWorkers).not.toContain("Subagents");
		expect(pinnedWorkers).not.toContain("NeighborWorker");
	});

	it("completes and auto-dismisses only after an explicit Main TODO done command", async () => {
		await replaceMode();
		setTodoClearDelay(1);
		mode.todoExpanded = true;
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
		setModeTodos(mode, session, session.getTodoPhases());
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
		setModeTodos(mode, session, oldPhases);
		mode.setTodoExpanded(true);
		setModeTodos(mode, session, newPhases);
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
		setModeTodos(mode, session, older);
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
		setModeTodos(mode, session, newer);
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
		setModeTodos(mode, session, completed);
		vi.advanceTimersByTime(500);
		setModeTodos(mode, session, replacement);
		vi.advanceTimersByTime(1000);
		await Promise.resolve();
		expect(renderTodos(mode)).toContain("new");
		expect(renderTodos(mode)).not.toContain("old");
	});

	it("treats identical canonical todo edits as new snapshots after dismissal", async () => {
		await replaceMode();
		vi.useFakeTimers();
		setTodoClearDelay(1);
		mode.todoExpanded = true;
		const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "same task", status: "completed" }] }];
		const oldSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		setModeTodos(mode, session, phases);
		vi.advanceTimersByTime(1000);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).toBe("");

		const newSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		setModeTodos(mode, session, phases);
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
		mode.todoExpanded = true;
		const settle = Promise.withResolvers<void>();
		vi.spyOn(session, "settleInFlightMessagePersistence").mockReturnValue(settle.promise);
		const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "same task", status: "completed" }] }];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		setModeTodos(mode, session, phases);
		const oldSessionId = session.sessionManager.getSessionId();
		vi.advanceTimersByTime(1000);

		await session.sessionManager.newSession();
		const newSessionId = session.sessionManager.getSessionId();
		const newSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		setModeTodos(mode, session, phases);
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
		setModeTodos(mode, session, phases);
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
	it("bounds the ledger HUD while keeping the full plan available when expanded", () => {
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 18, configurable: true });
		const tasks: TodoItem[] = Array.from({ length: 20 }, (_, index) => ({
			content: `Ledger work ${index}`,
			status: "pending",
		}));
		session.sessionManager.appendCustomEntry("requirements_ledger", {
			requirements: [{ classification: "accepted", rows: tasks.map(task => task.content) }],
		});
		setModeTodos(mode, session, [{ name: "Ledger phase", tasks }]);
		const collapsed = renderTodos(mode);
		expect(collapsed).toContain("20 open");
		expect(collapsed).toContain("requirements");
		expect(collapsed).toContain("more rows");
		expect(collapsed).not.toContain("Ledger work 19");
		expect(mode.todoContainer.render(120).length).toBeLessThanOrEqual(mode.getTodoHudPanelRows());
		mode.setTodoExpanded(true);
		expect(renderTodos(mode)).toContain("Ledger work 19");
	});
});

describe("InteractiveMode todo HUD anchor", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let eventBus: EventBus;
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
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
	});

	afterEach(() => {
		mode.todoExpanded = false;
		setModeTodos(mode, session, []);
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 24, configurable: true });
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
		setModeTodos(mode, session, [
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
		expect(root).toContain("1 ✓ · 3 open");
		// Active stage: highlighted header with its own task progress, expanded as a
		// connector tree; closed tasks are not drawn while open work exists (progress
		// is carried by the header count).
		expect(lines.some(line => line.includes("I. Foundation") && line.includes("1/3"))).toBe(true);
		const secondLine = lines.find(line => line.includes("second task"));
		expect(secondLine).toContain(theme.tree.branch);
		expect(secondLine).toContain(theme.checkbox.unchecked);
		expect(lines.some(line => line.includes("third task"))).toBe(true);
		expect(lines.some(line => line.includes("first task"))).toBe(false);
		// Upcoming stage: header with its own progress; its open task shows too because
		// every open row fits the panel.
		expect(lines.some(line => line.includes("II. Verification") && line.includes("0/1"))).toBe(true);
		expect(lines.some(line => line.includes("run tests"))).toBe(true);
		// Everything open is visible, so there is no overflow row.
		expect(lines.some(line => line.includes("more"))).toBe(false);
	});

	it("marks the matching in-progress todo row when its worker has no recent commit", async () => {
		await mode.init();
		cfgTasksTodoClearDelay.override(session.settings, -1);
		vi.useFakeTimers();
		const content = "Implement worker result";
		setExpandedModeTodos(mode, session, [{ name: "Implementation", tasks: [{ content, status: "in_progress" }] }]);
		const registry = AgentRegistry.global();
		const id = "NoCommitWorker";
		const ref = registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session,
			status: "running",
		});
		// `worktreeWarning` lands with the worker-warning registry follow-up; the HUD
		// reads it optionally, so the test injects it through a narrow entry view.
		const entry = registry.get(id) as { worktreeWarning?: { minutes: number; lastLine?: string; row?: string } };
		if (!entry) throw new Error(`agent ${id} is not registered`);
		entry.worktreeWarning = { minutes: 17, lastLine: "bash bun test", row: content };
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			description: content,
			status: "started",
			detached: true,
		});
		vi.advanceTimersByTime(100);
		try {
			expect(renderTodos(mode)).toContain("⚠ 17m no commit");
			setModeTodos(mode, session, [
				{ name: "Implementation", tasks: [{ content: "Unowned task", status: "in_progress" }] },
			]);
			expect(renderTodos(mode)).not.toContain("⚠ 17m no commit");
		} finally {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id,
				index: 0,
				agent: "task",
				description: content,
				status: "completed",
				detached: true,
			});
			vi.advanceTimersByTime(100);
			registry.unregister(id, ref);
		}
	});

	it("shows a TODO-owned worker once and lists an unowned worker under TODO", async () => {
		await mode.init();
		vi.useFakeTimers();
		cfgTasksTodoClearDelay.override(session.settings, -1);
		const content = "Implement owned row";
		setModeTodos(mode, session, [{ name: "Implementation", tasks: [{ content, status: "in_progress" }] }]);
		const registry = AgentRegistry.global();
		const ownedId = "OwnedWorker";
		const unownedId = "UnownedWorker";
		const ownedRef = registry.register({
			id: ownedId,
			displayName: ownedId,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session,
			status: "running",
		});
		const unownedRef = registry.register({
			id: unownedId,
			displayName: unownedId,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session,
			status: "running",
		});
		for (const [id, description] of [
			[ownedId, content],
			[unownedId, "Review an unrelated file"],
		]) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id,
				index: 0,
				agent: "task",
				description,
				status: "started",
				detached: true,
			});
		}
		vi.advanceTimersByTime(100);
		try {
			const todo = renderTodos(mode);
			const subagents = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
			const rendered = `${todo}\n${subagents}`;
			expect(rendered).toContain("OwnedWorker");
			expect(rendered.match(/OwnedWorker/g)).toHaveLength(1);
			expect(todo).toContain("OwnedWorker");
			expect(todo).toContain("UnownedWorker");
			expect(subagents).not.toContain("OwnedWorker");
			expect(subagents).not.toContain("UnownedWorker");
		} finally {
			for (const id of [ownedId, unownedId])
				eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					index: 0,
					agent: "task",
					description: "",
					status: "completed",
					detached: true,
				});
			registry.unregister(ownedId, ownedRef);
			registry.unregister(unownedId, unownedRef);
		}
	});

	it("keeps an owned in-progress row visible in a collapsed later stage", async () => {
		await mode.init();
		vi.useFakeTimers();
		cfgTasksTodoClearDelay.override(session.settings, -1);
		const content = "Ship owned work";
		setModeTodos(mode, session, [
			{ name: "Current", tasks: [{ content: "Current pending work", status: "pending" }] },
			{
				name: "Background",
				tasks: [
					{ content, status: "in_progress" },
					{ content: "Unowned queued follow-up", status: "pending" },
				],
			},
		]);
		const registry = AgentRegistry.global();
		const id = "BackgroundWorker";
		const ref = registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session,
			status: "running",
		});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			description: content,
			status: "started",
			detached: true,
		});
		vi.advanceTimersByTime(100);
		try {
			mode.setTodoExpanded(false);
			const rendered = renderTodos(mode);
			expect(rendered).toContain(id);
			expect(rendered).toContain(content);
			expect(rendered).toContain("Unowned queued follow-up");
		} finally {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id,
				index: 0,
				agent: "task",
				description: content,
				status: "completed",
				detached: true,
			});
			vi.advanceTimersByTime(100);
			registry.unregister(id, ref);
		}
	});

	it("renders nothing when there are no todos", () => {
		setModeTodos(mode, session, []);
		expect(mode.todoContainer.render(80)).toHaveLength(0);
	});

	it("refreshes requirement counts on ledger append without replacing the collab append hook", () => {
		mode.setTodos([{ name: "Work", tasks: [{ content: "Build artifact", status: "pending" }] }]);
		const manager = session.sessionManager;
		const previousAppendHook = manager.onEntryAppended;
		const collabAppendHook = vi.fn();
		manager.onEntryAppended = collabAppendHook;
		try {
			expect(renderTodos(mode)).not.toContain("req 1");
			manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
				version: 1,
				requirements: createRequirementCandidates([], ["keep this ask"], "2026-09-28T12:00:00.000Z"),
			});
			expect(collabAppendHook).toHaveBeenCalledWith(
				expect.objectContaining({ type: "custom", customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE }),
			);
			expect(renderTodos(mode)).toContain("requirements 1: 0 passed · 1 open · 0 failed");
		} finally {
			manager.onEntryAppended = previousAppendHook;
			manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements: [] });
		}
	});
	it("reuses requirement counts across unchanged HUD renders and refreshes after append", () => {
		mode.setTodos([{ name: "Work", tasks: [{ content: "Build artifact", status: "pending" }] }]);
		const manager = session.sessionManager;
		const getBranch = vi.spyOn(manager, "getBranch");
		manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
			version: 1,
			requirements: createRequirementCandidates([], ["first ask"], "2026-09-28T12:00:00.000Z"),
		});
		getBranch.mockClear();
		try {
			renderTodos(mode);
			const initialReads = getBranch.mock.calls.length;
			for (let render = 0; render < 50; render++) renderTodos(mode);
			expect(getBranch).toHaveBeenCalledTimes(initialReads);
			manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
				version: 1,
				requirements: createRequirementCandidates([], ["first ask", "new ask"], "2026-09-28T12:01:00.000Z"),
			});
			expect(renderTodos(mode)).toContain("requirements 2: 0 passed · 2 open · 0 failed");
		} finally {
			manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements: [] });
		}
	});
	it("renders requirement counts in the TODO HUD and compact header", async () => {
		cfgTasksTodoClearDelay.override(session.settings, -1);
		const at = "2026-09-28T12:00:00.000Z";
		const requirements = [
			{ id: "R1", at, rawText: "candidate ask", classification: "candidate", rows: [] },
			{
				id: "R2",
				at,
				rawText: "passed ask",
				classification: "linked",
				rows: ["Build artifact"],
				verdict: {
					status: "pass",
					rawWords: "passed ask",
					evidence: "observed",
					artifact: "r2",
					workerId: "QA",
					auditor: "qa-auditor",
				},
			},
			{
				id: "R3",
				at,
				rawText: "failed ask",
				classification: "linked",
				rows: ["Build artifact"],
				verdict: { status: "fail", evidence: "broken", artifact: "r2", workerId: "QA" },
			},
			{
				id: "R4",
				at,
				rawText: "uncertain ask",
				classification: "linked",
				rows: ["Build artifact"],
				verdict: { status: "unverifiable", evidence: "missing access", artifact: "r2", workerId: "QA" },
			},
		];
		session.sessionManager.appendCustomEntry("requirements_ledger", { version: 1, requirements });
		try {
			mode.setTodos([{ name: "Work", tasks: [{ content: "Build artifact", status: "in_progress" }] }]);
			expect(renderTodos(mode)).toContain("TODO · requirements 4: 1 passed · 2 open · 1 failed");
			const terminal = mode.ui.terminal;
			const originalRows = Object.getOwnPropertyDescriptor(terminal, "rows");
			Object.defineProperty(terminal, "rows", { get: () => 10, configurable: true });
			try {
				renderTodos(mode);
				const compact = Bun.stripANSI(mode.statusContainer.render(180).join("\n"));
				expect(compact).toContain("requirements 4: 1 passed · 2 open · 1 failed");
			} finally {
				if (originalRows) Object.defineProperty(terminal, "rows", originalRows);
				else Reflect.deleteProperty(terminal, "rows");
			}
			// Lifecycle invalidation persists absence of the stale verdict, not a UI-only discount.
			session.sessionManager.appendCustomEntry("requirements_ledger", {
				version: 1,
				requirements: requirements.map(item => (item.id === "R2" ? { ...item, verdict: undefined } : item)),
			});
			mode.setTodos(session.getTodoPhases());
			expect(renderTodos(mode)).toContain("requirements 4: 0 passed · 3 open · 1 failed");
		} finally {
			session.sessionManager.appendCustomEntry("requirements_ledger", { version: 1, requirements: [] });
		}
	});

	it("keeps the summed progress bar but omits the roman numeral for a single-phase list", () => {
		setExpandedModeTodos(mode, session, [
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
		// A short (still non-compact) viewport keeps the overflow summary; a tall
		// one shows every stage that fits. The window follows the viewport height,
		// not a fixed row count.
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 18, configurable: true });
		const stage = (name: string): TodoPhase => ({ name, tasks: [{ content: `${name} task`, status: "pending" }] });
		setModeTodos(mode, session, [
			stage("Discovery"),
			stage("Two"),
			stage("Three"),
			stage("Four"),
			stage("Five"),
			stage("Six"),
			stage("Seven"),
			stage("Eight"),
			stage("Nine"),
			stage("Ten"),
			stage("Eleven"),
			stage("Twelve"),
		]);
		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));
		expect(lines.some(line => line.includes("II. Two"))).toBe(true);
		expect(lines.some(line => line.includes("IX. Nine"))).toBe(false);
		expect(lines.some(line => line.includes("Ten"))).toBe(false);
		expect(lines.some(line => line.includes("… 7 more stages"))).toBe(true);
		expect(lines.some(line => line.includes("4 more todos · /todo expand"))).toBe(true);
		// The header accounts for every open row, including overflow.
		const root = lines.find(line => line.includes("TODO"));
		expect(root).toContain("12 open");
	});

	it("sizes the collapsed todo window from the viewport instead of a fixed five", () => {
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 40, configurable: true });
		setModeTodos(mode, session, [
			{
				name: "Tasks",
				tasks: Array.from({ length: 7 }, (_, index): TodoItem => ({
					content: `Fitted task ${index + 1}`,
					status: "pending",
				})),
			},
		]);
		const tall = renderTodos(mode);
		for (let index = 1; index <= 7; index++) expect(tall).toContain(`Fitted task ${index}`);
		expect(tall).not.toContain("more todo");
		// Every row the window paints still fits the viewport it was sized against.
		expect(mode.todoContainer.render(120).length).toBeLessThanOrEqual(40);
	});

	it("keeps the collapsed window bounded with an overflow summary on a short viewport", () => {
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 18, configurable: true });
		setModeTodos(mode, session, [
			{
				name: "Tasks",
				tasks: Array.from({ length: 20 }, (_, index): TodoItem => ({
					content: `Crowded task ${index + 1}`,
					status: "pending",
				})),
			},
		]);
		const short = renderTodos(mode);
		expect(short).toContain("Crowded task 1");
		expect(short).not.toContain("Crowded task 2");
		expect(short).toContain("19 more todos · /todo expand");
		expect(mode.todoContainer.render(120).length).toBeLessThanOrEqual(18);
	});

	it("accounts for every hidden task within the allocated panel", () => {
		// 18 rows leaves a 6-row panel: one task row plus the exact hidden count.
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 18, configurable: true });
		setModeTodos(mode, session, [
			{
				name: "Tasks",
				tasks: Array.from({ length: 10 }, (_, index): TodoItem => ({
					content: `Task ${index + 1}`,
					status: index === 0 ? "in_progress" : "pending",
				})),
			},
		]);
		expect(renderTodos(mode)).not.toContain("Task 10");
		expect(renderTodos(mode)).toContain("9 more todos · /todo expand");

		setModeTodos(mode, session, [
			{
				name: "Tasks",
				tasks: Array.from({ length: 11 }, (_, index): TodoItem => ({
					content: `Task ${index + 1}`,
					status: index === 0 ? "in_progress" : "pending",
				})),
			},
		]);
		expect(renderTodos(mode)).not.toContain("Task 11");
		expect(renderTodos(mode)).toContain("10 more todos · /todo expand");
	});

	it("caps the stage window and names the stages past it", () => {
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 40, configurable: true });
		const stage = (name: string): TodoPhase => ({ name, tasks: [{ content: `${name} task`, status: "pending" }] });
		setModeTodos(mode, session, [
			stage("One"),
			stage("Two"),
			stage("Three"),
			stage("Four"),
			stage("Five"),
			stage("Six"),
		]);
		const oneHidden = renderTodos(mode);
		expect(oneHidden).toContain("V. Five");
		expect(oneHidden).not.toContain("VI. Six");
		expect(oneHidden).toContain("1 more stage");
	});

	it("expands and collapses the complete todo HUD through /todo", async () => {
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 22, configurable: true });
		setModeTodos(mode, session, [
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

		// A short terminal leaves a 6-row panel: 3 rows of chrome, the stage header,
		// 1 summary row, so 1 task row fits and 7 open todos are reported hidden.
		Object.defineProperty(mode.ui.terminal, "rows", { get: () => 18, configurable: true });
		mode.setTodos(mode.todoPhases);
		expect(renderTodos(mode)).not.toContain("Task 8");
		expect(renderTodos(mode)).toContain("Task 1");
		expect(renderTodos(mode)).toContain("7 more todos · /todo expand");
	});

	describe("collapsed panel row budget", () => {
		function setTerminalRows(rows: number): void {
			Object.defineProperty(mode.ui.terminal, "rows", { get: () => rows, configurable: true });
		}
		const stages: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ content: "done one", status: "completed" },
					{ content: "build a", status: "in_progress" },
					...Array.from({ length: 6 }, (_, index): TodoItem => ({
						content: `build p${index}`,
						status: "pending",
					})),
				],
			},
			{
				name: "Ship",
				tasks: [
					{ content: "ship blocked", status: "blocked" },
					{ content: "ship pending", status: "pending" },
				],
			},
		];
		afterEach(() => setTerminalRows(24));

		it("lists open rows from every stage when the panel has room", () => {
			setTerminalRows(40);
			mode.setTodos(stages);
			const text = renderTodos(mode);
			for (const content of ["build a", "build p5", "ship blocked", "ship pending"]) expect(text).toContain(content);
			expect(text).not.toContain("more todo");
		});

		it("never draws a closed row while any open row exists, even with spare room", () => {
			setTerminalRows(40);
			mode.setTodos(stages);
			expect(renderTodos(mode)).not.toContain("done one");
		});

		it("prioritises in-progress then blocked work and counts the hidden remainder exactly", () => {
			setTerminalRows(21);
			mode.setTodos(stages);
			const text = renderTodos(mode);
			const open = 9; // 7 open in Build + 2 in Ship; the completed task is never drawn
			const shown = stages
				.flatMap(stage => stage.tasks)
				.filter(task => task.status !== "completed" && text.includes(task.content));
			expect(text).toContain("build a");
			expect(text).toContain("ship blocked");
			expect(text).not.toContain("build p5");
			expect(text).toContain(`${open - shown.length} more todos · /todo expand`);
		});
	});

	describe("composer allocation callback", () => {
		type AllocationApply = (
			viewport: { columns: number; rows: number },
			chromeRows: number,
			renderInput: () => number,
		) => void;

		let allocMode: InteractiveMode | undefined;
		let allocBus: EventBus;

		function setTerminalRows(rows: number): void {
			if (allocMode) Object.defineProperty(allocMode.ui.terminal, "rows", { get: () => rows, configurable: true });
		}

		async function initCapturingAllocation(): Promise<AllocationApply> {
			allocBus = new EventBus();
			const m = new InteractiveMode(
				session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				allocBus,
			);
			allocMode = m;
			vi.spyOn(m.statusLine, "watchBranch").mockImplementation(() => {});
			let apply: AllocationApply | undefined;
			const setRuntimeChildren = m.composer.setRuntimeChildren.bind(m.composer);
			vi.spyOn(m.composer, "setRuntimeChildren").mockImplementation((roots, options) => {
				apply = options?.allocation?.apply;
				setRuntimeChildren(roots, options);
			});
			await m.init();
			if (!apply) throw new Error("Expected InteractiveMode.init to register a Composer allocation");
			setTerminalRows(40);
			return apply;
		}

		afterEach(() => {
			allocMode?.setTodos([]);
			allocMode?.stop();
			allocMode = undefined;
		});

		it("does not rebuild the HUD on every keypress when there is no plan", async () => {
			const apply = await initCapturingAllocation();
			const clear = vi.spyOn(allocMode!.todoContainer, "clear");
			for (let keypress = 0; keypress < 20; keypress++) apply({ columns: 120, rows: 40 }, 4, () => 3);
			expect(clear.mock.calls.length).toBeLessThanOrEqual(1);
		});

		it("does not rebuild the HUD on every keypress when only workers are running", async () => {
			const apply = await initCapturingAllocation();
			allocBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "Worker",
				index: 0,
				agent: "task",
				description: "Investigate flaky test",
				status: "started",
			});
			const clear = vi.spyOn(allocMode!.todoContainer, "clear");
			for (let keypress = 0; keypress < 20; keypress++) apply({ columns: 120, rows: 40 }, 4, () => 3);
			expect(clear.mock.calls.length).toBeLessThanOrEqual(1);
		});

		it("still rebuilds a planned HUD once when the row budget changes, then stays quiet", async () => {
			const apply = await initCapturingAllocation();
			allocMode!.setTodos([
				{
					name: "Build",
					tasks: Array.from({ length: 8 }, (_, index): TodoItem => ({
						content: `step ${index}`,
						status: index === 0 ? "in_progress" : "pending",
					})),
				},
			]);
			apply({ columns: 120, rows: 40 }, 4, () => 3);
			const clear = vi.spyOn(allocMode!.todoContainer, "clear");
			for (let keypress = 0; keypress < 20; keypress++) apply({ columns: 120, rows: 40 }, 4, () => 3);
			expect(clear).not.toHaveBeenCalled();
			setTerminalRows(20);
			apply({ columns: 120, rows: 20 }, 4, () => 3);
			expect(clear).toHaveBeenCalledTimes(1);
			for (let keypress = 0; keypress < 20; keypress++) apply({ columns: 120, rows: 20 }, 4, () => 3);
			expect(clear).toHaveBeenCalledTimes(1);
		});
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
			setModeTodos(mode, session, [
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
			setModeTodos(mode, session, [
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
			setModeTodos(mode, session, [
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
			setModeTodos(mode, session, [
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
