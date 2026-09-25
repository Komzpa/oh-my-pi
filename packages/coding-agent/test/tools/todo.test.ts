import { beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	archiveTodoPhases,
	formatTodoView,
	getLatestTodoArchiveFromEntries,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	nextActionableTask,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
	TodoTool,
	forecastTodoLivePlan,
} from "@oh-my-pi/pi-coding-agent/tools";
import { forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";

import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	selectCollapsedTodos,
	type TodoItem,
	type TodoPhase,
	todoMatchesAnyDescription,
	todoToolRenderer,
} from "@oh-my-pi/pi-tui/tools/todo";
import type { Component } from "@oh-my-pi/pi-tui";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

function closedArchiveFixture(now: number, rowCount = 400): TodoPhase[] {
	return Array.from({ length: 8 }, (_, phaseIndex) => ({
		name: phaseIndex === 7 ? "Open phase" : `Closed phase ${phaseIndex + 1}`,
		tasks: Array.from({ length: rowCount / 8 }, (_, taskIndex) => {
			const index = phaseIndex * (rowCount / 8) + taskIndex;
			const content = `Closed task ${String(index + 1).padStart(3, "0")}`;
			return {
				content,
				status: index === rowCount - 1 ? ("in_progress" as const) : ("completed" as const),
				schedule: {
					finishedAt: now - 10 * 60_000 - (rowCount - index),
					dependencies: index === rowCount - 1 ? ["Closed task 001"] : [],
					estimate: {
						optimisticSeconds: 60,
						likelySeconds: 180,
						pessimisticSeconds: 420,
						confidence: "high" as const,
						basis: `fixture estimate ${index}`,
						updatedAt: now - 20 * 60_000,
					},
					executor: {
						workerId: `fixture-worker-${index}`,
						startedAt: now - 30 * 60_000,
						finishedAt: now - 10 * 60_000 - (rowCount - index),
						outcome: "completed" as const,
					},
				},
			};
		}),
	}));
}

describe("todo archive policy", () => {
	const now = Date.parse("2026-09-25T08:00:00.000Z");

	it("archives seven aged closed phases wholesale and keeps ten recent closed rows beside open work", () => {
		const phases = closedArchiveFixture(now);
		const beforeForecast = forecastTodoPlan(phases, { now });
		const archived = archiveTodoPhases(phases, now);
		const liveTasks = archived.phases.flatMap(phase => phase.tasks);
		const archivedTasks = archived.archivedPhases.flatMap(phase => phase.tasks);

		expect(archived.phases.map(phase => phase.name)).toEqual(["Open phase"]);
		expect(liveTasks).toHaveLength(11);
		expect(liveTasks.filter(task => task.status === "completed")).toHaveLength(10);
		expect(liveTasks.find(task => task.content === "Closed task 400")?.status).toBe("in_progress");
		expect(archivedTasks).toHaveLength(389);
		expect(archived.archivedPhases.slice(0, 7).every(phase => phase.tasks.length === 50)).toBe(true);
		expect(archivedTasks[0]?.schedule?.estimate?.basis).toBe("fixture estimate 0");
		expect(archivedTasks[0]?.schedule?.executor?.workerId).toBe("fixture-worker-0");
		const ordinaryView = formatTodoView(archived.phases, { now });
		const archiveView = formatTodoView(archived.phases, { now, archive: true, archivedPhases: archived.archivedPhases });
		expect(ordinaryView).not.toContain("Closed task 001");
		expect(archiveView).toContain("Closed task 001");
		const afterForecast = forecastTodoLivePlan(archived.phases, archived.archivedPhases, { now });
		expect(afterForecast.rows.find(row => row.content === "Closed task 400")?.issues.some(
			issue => issue.includes("Missing prerequisite") || issue.includes("unresolved prerequisite"),
		)).toBe(false);
		expect(afterForecast.rows.some(row => row.content === "Closed task 001")).toBe(false);
		expect(beforeForecast.rows.find(row => row.content === "Closed task 400")?.issues.some(
			issue => issue.includes("Missing prerequisite"),
		)).toBe(false);
	});

	it("keeps a whole closed phase before grace and archives it at ten minutes regardless of tail", () => {
		const phases: TodoPhase[] = [{
			name: "Finished",
			tasks: [{ content: "Recent completed", status: "completed", schedule: { finishedAt: now - 10 * 60_000 + 1 } }],
		}];
		expect(archiveTodoPhases(phases, now).phases).toEqual(phases);
		phases[0]!.tasks[0]!.schedule!.finishedAt = now - 10 * 60_000;
		expect(archiveTodoPhases(phases, now)).toEqual({ phases: [], archivedPhases: phases });
	});

	it("does not prematurely archive a closed phase with unknown finish time or any open work", () => {
		const phases: TodoPhase[] = [
			{ name: "Unknown finish", tasks: [{ content: "No timestamp", status: "abandoned" }] },
			{ name: "Blocked work", tasks: [
				{ content: "Old closed", status: "completed", schedule: { finishedAt: now - 20 * 60_000 } },
				{ content: "Still blocked", status: "blocked" },
			] },
		];
		expect(archiveTodoPhases(phases, now)).toEqual({ phases, archivedPhases: [] });
	});

	it("retains unknown-time terminal rows while bounding dated closed rows in an open phase", () => {
		const phases: TodoPhase[] = [{ name: "Mixed", tasks: [
			{ content: "Unknown finish", status: "completed" },
			...Array.from({ length: 12 }, (_, index) => ({
				content: `Dated ${index}`,
				status: "abandoned" as const,
				schedule: { finishedAt: now - 60_000 - index * 1_000 },
			})),
			{ content: "Blocked open work", status: "blocked" as const },
		] }];
		const archived = archiveTodoPhases(phases, now);
		expect(archived.phases[0]?.tasks.map(task => task.content)).toEqual([
			"Unknown finish", ...Array.from({ length: 9 }, (_, index) => `Dated ${index}`), "Blocked open work",
		]);
		expect(archived.archivedPhases[0]?.tasks.map(task => task.content)).toEqual(["Dated 9", "Dated 10", "Dated 11"]);
	});

	it("archives only on successful mutations and recovers rows in explicit archive view", async () => {
		setSystemTime(new Date(now));
		try {
			const session = createSession(closedArchiveFixture(now));
			const writes = vi.spyOn(session, "setTodoPhases");
			const entries: SessionEntry[] = [];
			Object.assign(session, { sessionManager: { getBranch: () => entries } });
			const tool = new TodoTool(session);
			const defaultView = await tool.execute("view-before", { op: "view" });
			expect(writes).not.toHaveBeenCalled();
			expect(defaultView.details?.phases).toHaveLength(8);
			expect(defaultView.details?.archivedPhases).toBeUndefined();
			const failed = await tool.execute("failed", { op: "done", task: "No such task" });
			expect(failed.isError).toBe(true);
			expect(writes).not.toHaveBeenCalled();
			expect(failed.details?.edit).toBeUndefined();

			const updated = await tool.execute("archive", { op: "block", task: "Closed task 400", reason: "Waiting" });
			expect(writes).toHaveBeenCalledTimes(1);
			expect(updated.details?.edit).toMatchObject({ v: 1, kind: "archive", at: now, operation: { kind: "op" } });
			expect(updated.details?.archiveSummary).toEqual({ count: 389, fromAt: now, toAt: now });
			expect(updated.details?.archivedPhases).toBeUndefined();
			expect(updated.details?.phases.flatMap(phase => phase.tasks)).toHaveLength(11);
			const archivedEdit = updated.details?.edit;
			if (!archivedEdit || archivedEdit.kind !== "archive") throw new Error("Expected archive event");
			entries.push({ type: "custom", customType: "user_todo_edit", data: { edit: archivedEdit }, id: "archived", parentId: null, timestamp: new Date(now).toISOString() } as SessionEntry);
			const ordinary = await tool.execute("ordinary", { op: "view" });
			expect(ordinary.details?.archiveSummary?.count).toBe(389);
			expect(ordinary.details?.archivedPhases).toBeUndefined();
			const archiveView = await tool.execute("explicit", { op: "view", archive: true });
			expect(archiveView.details?.archivedPhases?.flatMap(phase => phase.tasks)).toHaveLength(389);
			expect(archiveView.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Closed task 001") });
			expect(writes).toHaveBeenCalledTimes(1);
		} finally {
			setSystemTime();
			vi.restoreAllMocks();
		}
	});
});

beforeAll(async () => {
	await initTheme();
});

describe("resolveTodoMarkdownPath", () => {
	it("defaults to TODO.md under cwd", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(resolveTodoMarkdownPath("", cwd)).toBe(path.join(cwd, "TODO.md"));
	});

	it("strips surrounding double quotes before resolving", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(resolveTodoMarkdownPath('"my todos.md"', cwd)).toBe(path.join(cwd, "my todos.md"));
	});

	it("rejects internal URL schemes", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(() => resolveTodoMarkdownPath("artifact://todo", cwd)).toThrow("internal scheme");
	});
});

describe("TodoTool auto-start behavior", () => {
	it("auto-starts the first task after init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("status [in_progress] (Execution)");
		expect(summary.text).toContain("diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const result = await tool.execute("call-2", { op: "done", task: "status" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		expect(result.details?.completedTasks).toEqual([{ phase: "Execution", content: "status" }]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("status (Execution) [in_progress → completed]");
		expect(summary.text).toContain("Next: diagnostics [in_progress]");
		const completedResult = await tool.execute("call-3", { op: "done", task: "diagnostics" });
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (completedSummary?.type !== "text") {
			throw new Error("Expected text summary from todo");
		}
		expect(completedSummary.text).toContain("Next: none; all tasks are closed.");
	});
});

describe("nextActionableTask", () => {
	it("returns the in-progress task before the first pending task across phases", () => {
		const task = nextActionableTask([
			{
				name: "First",
				tasks: [{ content: "queued first", status: "pending" }],
			},
			{
				name: "Second",
				tasks: [{ content: "active second", status: "in_progress" }],
			},
		]);

		expect(task?.content).toBe("active second");
	});

	it("falls back to the first pending task when nothing is in progress", () => {
		const task = nextActionableTask([
			{
				name: "Done",
				tasks: [{ content: "finished", status: "completed" }],
			},
			{
				name: "Next",
				tasks: [{ content: "first pending", status: "pending" }],
			},
		]);

		expect(task?.content).toBe("first pending");
	});
});

describe("TodoTool operations", () => {
	function heavyTodoPlan(rowCount: number): TodoPhase[] {
		return [
			{
				name: "Sunbim 316-row fixture",
				tasks: Array.from({ length: rowCount }, (_, index) => {
					const content = `Task ${String(index + 1).padStart(3, "0")} with retained schedule history`;
					return {
						content,
						status: index === rowCount - 1 ? ("in_progress" as const) : ("completed" as const),
						schedule: {
							startedAt: 1_790_217_022_691 + index,
							finishedAt: index === rowCount - 1 ? undefined : 1_790_217_192_187 + index,
							dependencies:
								index === 0 ? [] : [`Task ${String(index).padStart(3, "0")} with retained schedule history`],
							owner: "Main",
							resources: ["native-todo", `lane-${index % 9}`],
							reestimateCount: 0,
							estimateRevision: 1,
							estimate: {
								optimisticSeconds: 60,
								likelySeconds: 180,
								pessimisticSeconds: 420,
								confidence: "high" as const,
								basis: "Large-plan regression basis retaining enough text to model Sunbim schedule history without depending on a private session fixture.",
								updatedAt: 1_790_217_111_019 + index,
							},
							progress: {
								at: 1_790_217_111_019 + index,
								evidence:
									"Large-plan regression evidence retaining enough text to model repeated progress history.",
							},
							executor: {
								workerId: `worker-${index}`,
								agentProfile: "task",
								resolvedModel: "openrouter/free",
								thinkingLevel: "low",
								startedAt: 1_790_217_111_019 + index,
								finishedAt: index === rowCount - 1 ? undefined : 1_790_217_192_187 + index,
								outcome: index === rowCount - 1 ? undefined : ("completed" as const),
							},
						},
					};
				}),
			},
		];
	}

	it("persists a one-row update compactly for a 316-row plan while retaining live details", async () => {
		const phases = heavyTodoPlan(316);
		const tool = new TodoTool(createSession(phases));

		const result = await tool.execute("large-update", {
			op: "schedule",
			updates: [
				{
					task: "Task 316 with retained schedule history",
					evidence: "One-row update for compact persistence budget",
				},
			],
		});

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases[0]?.tasks).toHaveLength(316);
		expect(result.details?.forecast?.rows).toHaveLength(316);
		const persistedBytes = new TextEncoder().encode(JSON.stringify(result.details)).length;
		expect(persistedBytes).toBeLessThan(20_000);
		expect(JSON.stringify(result.details)).not.toContain("Large-plan regression basis");
	});

	it("replays a compact persisted todo edit after an old full-snapshot entry", async () => {
		const phases = heavyTodoPlan(3);
		const tool = new TodoTool(createSession(phases));
		const result = await tool.execute("compact-update", {
			op: "schedule",
			updates: [
				{
					task: "Task 003 with retained schedule history",
					evidence: "Replay compact edit evidence",
				},
			],
		});

		const persistedDetails = JSON.parse(JSON.stringify(result.details));
		const entries = [
			{
				type: "custom",
				customType: "user_todo_edit",
				data: { phases },
				id: "base",
				parentId: null,
				timestamp: "2026-09-25T11:00:00.000Z",
			},
			{
				type: "message",
				id: "compact",
				parentId: "base",
				timestamp: "2026-09-25T11:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "compact-update",
					toolName: "todo",
					content: result.content,
					details: persistedDetails,
					isError: false,
					timestamp: 1_790_217_112_000,
				},
			},
		] as SessionEntry[];

		const restored = getLatestTodoPhasesFromEntries(entries);
		expect(restored[0]?.tasks[2]?.schedule?.progress?.evidence).toBe("Replay compact edit evidence");
		expect(restored[0]?.tasks[2]?.schedule?.progress?.at).toBe(result.details?.edit?.at);
	});

	it("jumps to a specific task out of order", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
		});
		await tool.execute("plan", {
			op: "schedule",
			updates: ["first", "second", "third"].map(task => ({
				task,
				dependencies: [],
				estimate: {
					optimisticSeconds: 10,
					likelySeconds: 20,
					pessimisticSeconds: 40,
					confidence: "high",
					basis: "Bounded task transition fixture",
				},
			})),
		});

		const result = await tool.execute("call-2", { op: "start", task: "third" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
		expect(result.details?.op).toBe("start");
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "A", items: ["a1", "a2"] },
				{ phase: "B", items: ["b1"] },
			],
		});
		await tool.execute("plan", {
			op: "schedule",
			updates: ["a1", "a2", "b1"].map(task => ({
				task,
				dependencies: [],
				estimate: {
					optimisticSeconds: 10,
					likelySeconds: 20,
					pessimisticSeconds: 40,
					confidence: "high",
					basis: "Bounded task transition fixture",
				},
			})),
		});

		const result = await tool.execute("call-2", { op: "start", task: "b1" });

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", {
			op: "append",
			phase: "Work",
			items: ["Second"],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("keeps 61-row schedule acknowledgments concise while init, view, and details remain complete", async () => {
		const items = Array.from({ length: 61 }, (_, index) => `Task ${String(index + 1).padStart(2, "0")}`);
		const tool = new TodoTool(createSession());
		const initialized = await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items }],
		});
		const initText = initialized.content.find(part => part.type === "text");
		if (initText?.type !== "text") throw new Error("Expected text summary from todo init");
		expect(initText.text).toContain("Task 25");
		expect(initText.text).toContain("Task 61");

		const scheduled = await tool.execute("call-2", {
			op: "schedule",
			updates: [
				{
					task: "Task 25",
					owner: "Worker-25",
					resources: ["release-lock"],
					dependencies: [],
					estimate: {
						optimisticSeconds: 60,
						likelySeconds: 90,
						pessimisticSeconds: 150,
						confidence: "medium",
						basis: "61-row protocol regression",
					},
				},
			],
		});
		const mutationText = scheduled.content.find(part => part.type === "text");
		if (mutationText?.type !== "text") throw new Error("Expected text summary from todo schedule");
		expect(mutationText.text).toContain("schedule: 1 row(s) changed.");
		expect(mutationText.text).toContain("Task 25 (Work)");
		expect(mutationText.text).not.toContain("Task 24");
		expect(mutationText.text).not.toContain("Task 61");
		expect(scheduled.details?.phases[0]?.tasks.map(task => task.content)).toEqual(items);
		expect(scheduled.details?.phases[0]?.tasks[24]?.schedule?.dependencies).toEqual([]);

		const view = await tool.execute("call-3", { op: "view" });
		const viewText = view.content.find(part => part.type === "text");
		if (viewText?.type !== "text") throw new Error("Expected text summary from todo view");
		for (const row of ["Task 01", "Task 25", "Task 61"]) expect(viewText.text).toContain(row);
		expect(new TextEncoder().encode(mutationText.text).length * 3).toBeLessThan(
			new TextEncoder().encode(viewText.text).length,
		);
	});

	it("view lists open rows with their critical mark and counts closed rows unless a phase is named", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "Done", items: ["old one", "old two"] },
				{ phase: "Work", items: ["build", "ship", "side note"] },
			],
		});
		await tool.execute("call-2", { op: "done", items: ["old one", "old two"] });
		const estimate = (likelySeconds: number) => ({
			optimisticSeconds: likelySeconds / 2,
			likelySeconds,
			pessimisticSeconds: likelySeconds * 2,
			confidence: "medium" as const,
			basis: "view fixture",
		});
		await tool.execute("call-3", {
			op: "schedule",
			updates: [
				{ task: "build", dependencies: [], resources: ["build"], estimate: estimate(600) },
				{ task: "ship", dependencies: ["build"], resources: ["ship"], estimate: estimate(600) },
				{ task: "side note", dependencies: [], resources: ["note"], estimate: estimate(60) },
			],
		});
		const text = async (params: Parameters<TodoTool["execute"]>[1]) => {
			const part = (await tool.execute("call-v", params)).content.find(item => item.type === "text");
			if (part?.type !== "text") throw new Error("Expected text summary from todo view");
			return part.text;
		};
		const view = await text({ op: "view" });
		expect(view).toContain("Remaining items (3, 2 critical):");
		expect(view).toContain("ship [pending] (Work) critical");
		expect(view).toContain("side note [pending] (Work)\n");
		expect(view).toContain("  Done: 2/2 closed");
		expect(view).not.toContain("old one");
		// Naming a phase lists it whole, closed rows included.
		const done = await text({ op: "view", phase: "Done" });
		expect(done).toContain("[X] old one");
		expect(done).toContain("  Work: 0/3 closed");
	});

	it("shows open rows with finished worker results as needing lead review", async () => {
		const now = Date.parse("2026-09-25T08:00:00.000Z");
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{
						content: "Read preflight result",
						status: "in_progress",
						schedule: {
							owner: "Worker-1",
							executor: {
								workerId: "Worker-1",
								agentProfile: "task",
								startedAt: now - 10_000,
								finishedAt: now - 1_000,
								outcome: "completed",
							},
						},
					},
				],
			},
		];
		const tool = new TodoTool(createSession(phases));

		const summary = await tool.execute("call-1", { op: "view" });
		const summaryText = summary.content.find(part => part.type === "text");
		if (summaryText?.type !== "text") throw new Error("Expected text summary from todo view");
		expect(summaryText.text).toContain("Read preflight result [result arrived: review] (Work)");

		const view = formatTodoView(phases, { now });
		expect(view).toContain("Read preflight result · result arrived: review · owner Worker-1");
		expect(summary.details?.phases[0]?.tasks[0]?.status).toBe("in_progress");
	});

	it("blocks a task (excluded from remaining, counted distinctly) and unblocks it", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const blocked = await tool.execute("call-2", { op: "block", task: "b", reason: "waiting on sign-off" });
		const bTask = blocked.details?.phases[0]?.tasks.find(task => task.content === "b");
		expect(bTask?.status).toBe("blocked");
		expect(bTask?.blocker).toBe("waiting on sign-off");
		const summary = blocked.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		// `a` stays the only open item; `b` leaves the remaining/open set but is surfaced as blocked.
		expect(summary.text).toContain("Overall: 0/2 closed, 1 open, 1 blocked.");
		expect(summary.text).toContain('blocker="waiting on sign-off"');
		expect(summary.text).toContain("Blocked gate: 1 row(s) are not dispatchable");

		const unblocked = await tool.execute("call-3", { op: "unblock", task: "b" });
		const bAfter = unblocked.details?.phases[0]?.tasks.find(task => task.content === "b");
		expect(bAfter?.status).toBe("pending");
		expect(bAfter?.blocker).toBeUndefined();
	});

	it("rejects missing task reasons and blank phase reasons without mutating any status", async () => {
		const tool = new TodoTool(createSession());
		const initialized = await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });
		const before = initialized.details?.phases;

		const missingTaskReason = await tool.execute("call-2", { op: "block", task: "b" });
		expect(missingTaskReason.isError).toBe(true);
		expect(missingTaskReason.details?.phases).toEqual(before);

		const blankPhaseReason = await tool.execute("call-3", { op: "block", phase: "Work", reason: " \n\t " });
		expect(blankPhaseReason.isError).toBe(true);
		expect(blankPhaseReason.details?.phases).toEqual(before);
	});

	it("does not auto-promote a blocked task to in_progress", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["only"] }] });

		const result = await tool.execute("call-2", { op: "block", task: "only", reason: "external approval required" });

		// `only` was in_progress; blocking it leaves no pending/in_progress, so normalization must not revive it.
		expect(result.details?.phases[0]?.tasks[0]?.status).toBe("blocked");
	});

	it("closes and drops a batch of named rows in one call and leaves the rest open", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b", "c", "d", "e"] }] });
		await tool.execute("call-2", { op: "done", items: ["a", "b"] });
		const result = await tool.execute("call-3", { op: "drop", task: "c", items: ["d"] });
		const status = (content: string) =>
			result.details?.phases[0]?.tasks.find(task => task.content === content)?.status;
		expect([status("a"), status("b")]).toEqual(["completed", "completed"]);
		expect([status("c"), status("d")]).toEqual(["abandoned", "abandoned"]);
		// Neighbour: a row the batch did not name stays open.
		expect(status("e")).not.toBe("completed");
		expect(status("e")).not.toBe("abandoned");
	});

	it("rejects a batch naming an unknown row", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });
		const outcome = await tool.execute("call-2", { op: "done", items: ["a", "missing"] }).then(
			result => ({ result, error: undefined as unknown }),
			error => ({ result: undefined, error }),
		);
		const text = outcome.error ? String(outcome.error) : JSON.stringify(outcome.result?.content);
		expect(text).toContain("missing");
		// Atomic: the known row in the rejected batch stays open.
		const view = await tool.execute("call-3", { op: "view" });
		expect(view.details?.phases[0]?.tasks.find(task => task.content === "a")?.status).not.toBe("completed");
	});

	it("an empty batch or a done/drop without a target changes nothing", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });
		const calls: Array<[string, Parameters<TodoTool["execute"]>[1]]> = [
			["call-2", { op: "done", items: [] }],
			["call-3", { op: "drop", items: [] }],
			["call-4", { op: "done" }],
			["call-5", { op: "drop" }],
		];
		for (const [id, args] of calls) {
			const outcome = await tool.execute(id, args).then(
				result => JSON.stringify(result.content),
				error => String(error),
			);
			expect(outcome).toMatch(/items is empty|needs a task, a phase, or items/);
		}
		const view = await tool.execute("call-6", { op: "view" });
		expect(view.details?.phases[0]?.tasks.map(task => task.status)).not.toContain("completed");
		expect(view.details?.phases[0]?.tasks.map(task => task.status)).not.toContain("abandoned");
		// Neighbour: a whole phase can still be closed by naming it.
		const phase = await tool.execute("call-7", { op: "done", phase: "Work" });
		expect(phase.details?.phases[0]?.tasks.every(task => task.status === "completed")).toBe(true);
	});

	it("blocking a phase leaves completed/abandoned tasks closed", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b", "c"] }] });
		await tool.execute("call-2", { op: "done", task: "a" });
		await tool.execute("call-3", { op: "drop", task: "c" });

		const result = await tool.execute("call-4", { op: "block", phase: "Work", reason: "waiting on infra" });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		const byContent = (content: string) => tasks.find(task => task.content === content);
		// Completed/abandoned work is untouched; only the open task becomes blocked.
		expect(byContent("a")?.status).toBe("completed");
		expect(byContent("c")?.status).toBe("abandoned");
		expect(byContent("b")?.status).toBe("blocked");
		expect(byContent("b")?.blocker).toBe("waiting on infra");
		// A completed task must never carry a blocker note.
		expect(byContent("a")?.blocker).toBeUndefined();
	});
	it("rejects an overlong normalized phase blocker without mutating any task", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b", "c"] }] });
		const blocked = await tool.execute("call-2", {
			op: "block",
			task: "b",
			reason: "Awaiting approval from the user",
		});
		const before = blocked.details?.phases;

		const result = await tool.execute("call-3", {
			op: "block",
			phase: "Work",
			reason: `Awaiting approval from the user: ${"details ".repeat(24)}`,
		});

		expect(result.isError).toBe(true);
		expect(result.details?.phases).toEqual(before);
	});

	it("re-blocking requires a replacement reason and preserves the existing blocker on rejection", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });
		const first = await tool.execute("call-2", { op: "block", task: "b", reason: "waiting on review" });
		const blockedPhases = first.details?.phases;

		const missing = await tool.execute("call-3", { op: "block", task: "b" });
		expect(missing.isError).toBe(true);
		expect(missing.details?.phases).toEqual(blockedPhases);

		const blank = await tool.execute("call-4", { op: "block", task: "b", reason: " \n\t " });
		expect(blank.isError).toBe(true);
		expect(blank.details?.phases).toEqual(blockedPhases);

		const refined = await tool.execute("call-5", { op: "block", task: "b", reason: "waiting on user" });
		const bTask = refined.details?.phases[0]?.tasks.find(task => task.content === "b");
		expect(bTask?.status).toBe("blocked");
		expect(bTask?.blocker).toBe("waiting on user");
	});

	it("rejects a block with neither task nor phase target", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const result = await tool.execute("call-2", { op: "block", reason: "oops" });
		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("block requires a task or phase target");
		// Nothing was blocked — state is unchanged.
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.every(task => task.status !== "blocked")).toBe(true);
	});

	it("rejects an unblock with neither task nor phase target", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a"] }] });
		await tool.execute("call-2", { op: "block", task: "a", reason: "x" });

		const result = await tool.execute("call-3", { op: "unblock" });
		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("unblock requires a task or phase target");
		// The blocked task stays blocked — the targetless unblock was rejected.
		expect(result.details?.phases[0]?.tasks[0]?.status).toBe("blocked");
	});

	it("preserves blocked status across the markdown round-trip", () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "blocked", blocker: "x" },
					{ content: "b", status: "completed" },
				],
			},
		];
		const md = phasesToMarkdown(phases);
		expect(md).toContain("- [!] a");

		const { phases: parsed, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		const parsedA = parsed[0]?.tasks.find(task => task.content === "a");
		expect(parsedA?.status).toBe("blocked");
		// The blocker reason must survive the round-trip, not just the status.
		expect(parsedA?.blocker).toBe("x");
	});

	it("parses checklist items with backslash-escaped brackets from /todo edit", () => {
		// Editors/serializers (e.g. content pasted from a markdown renderer) escape
		// `[` and `]`; the line still renders as a checkbox, so it must parse rather
		// than error out and drop the user's edits (issue #9188).
		const md = ["# Todos", "* \\[x] first", "- \\[ \\] second", "+ \\[/\\] third"].join("\n");
		const { phases, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		const tasks = phases[0]?.tasks ?? [];
		expect(tasks).toEqual([
			{ content: "first", status: "completed" },
			{ content: "second", status: "pending" },
			{ content: "third", status: "in_progress" },
		]);
	});

	it("normalizes a multi-line blocker reason so the markdown round-trip survives", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a"] }] });
		// A blocker reason lifted from a multi-line external error or user question.
		const blocked = await tool.execute("call-2", {
			op: "block",
			task: "a",
			reason: "waiting on user:\nline two\n\tindented three",
		});
		const phases = blocked.details?.phases ?? [];
		const stored = phases[0]?.tasks.find(task => task.content === "a");
		// Normalized at the source: whitespace runs (incl. newlines) collapse to
		// single spaces, so every one-line consumer stays intact.
		expect(stored?.blocker).toBe("waiting on user: line two indented three");

		// Without normalization the embedded newline splits the HTML comment across
		// two markdown lines: line one is an unclosed `<!-- blocker: …` and line two
		// parses as unrecognized syntax, losing the reason and adding an error.
		const md = phasesToMarkdown(phases);
		expect(md.split("\n").filter(line => line.includes("- [!]"))).toHaveLength(1);
		const { phases: parsed, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		const parsedA = parsed[0]?.tasks.find(task => task.content === "a");
		expect(parsedA?.status).toBe("blocked");
		expect(parsedA?.blocker).toBe("waiting on user: line two indented three");
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", {
			op: "append",
			phase: "Cleanup",
			items: ["Remove dead code"],
		});

		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Work", "Cleanup"]);
		expect(result.details?.phases[1]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "Work", items: ["First", "Second"] },
				{ phase: "Later", items: ["Third"] },
			],
		});

		const result = await tool.execute("call-2", { op: "done", phase: "Work" });
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = await tool.execute("call-2", { op: "rm" });
		expect(result.details?.phases[0]?.tasks).toEqual([]);
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = await tool.execute("call-2", { op: "drop", phase: "Work" });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});

	it("view echoes state without mutating it", async () => {
		const session = createSession([
			{
				name: "Work",
				tasks: [
					{ content: "First", status: "pending" },
					{ content: "Second", status: "pending" },
				],
			},
		]);
		const tool = new TodoTool(session);

		const result = await tool.execute("call-1", { op: "view" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending"]);
		// A read never normalizes or writes session state back.
		expect(session.getTodoPhases?.()?.[0]?.tasks.map(task => task.status)).toEqual(["pending", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("First");
		expect(summary.text).toContain("Second");
	});

	it("view on an empty list reports empty, not cleared", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "view" });
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list is empty.");
		expect(result.isError).toBeUndefined();
	});
});

describe("TodoTool lenient init shapes", () => {
	it("accepts a flattened init with bare items and no phase", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init", items: ["First", "Second"] });

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Tasks"]);
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("honors a bare phase on a flattened init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init", phase: "Cleanup", items: ["Remove dead code"] });

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Cleanup"]);
		expect(result.details?.phases[0]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("still errors when init has neither list nor items", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init" });

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing list for init operation");
	});
});
describe("TodoTool lenient op recovery", () => {
	// Regression: models occasionally drop `op` while sending an otherwise
	// valid payload (e.g. `{list:[...]}`). The schema keeps `op` required, but
	// `lenientArgValidation` routes the raw args to execute(), which infers
	// the op for unambiguous shapes instead of failing the call.
	it("keeps op required at the schema boundary but lenient at execute", () => {
		const tool = new TodoTool(createSession());
		expect(tool.parameters({ list: [{ phase: "Fixes", items: ["One"] }] }) instanceof type.errors).toBe(true);
		expect(tool.lenientArgValidation).toBe(true);
	});

	it("infers init from a bare list payload", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", {
			list: [{ phase: "Fixes", items: ["Bytecompiler ordering", "Posix path fd handling"] }],
		} as never);

		expect(result.isError).toBeUndefined();
		expect(result.details?.op).toBe("init");
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Fixes"]);
		expect(result.details?.phases[0]?.tasks.map(task => task.content)).toEqual([
			"Bytecompiler ordering",
			"Posix path fd handling",
		]);
	});

	it("infers append from phase plus items", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", { phase: "Work", items: ["Second"] } as never);

		expect(result.isError).toBeUndefined();
		expect(result.details?.op).toBe("append");
		expect(result.details?.phases[0]?.tasks.map(task => task.content)).toEqual(["First", "Second"]);
	});

	it("infers init from bare items only when no todos exist", async () => {
		const fresh = new TodoTool(createSession());
		const initialized = await fresh.execute("call-1", { items: ["Only task"] } as never);
		expect(initialized.isError).toBeUndefined();
		expect(initialized.details?.op).toBe("init");

		// With existing todos the same shape is ambiguous (flat init would wipe
		// the list; append lacks a phase) and must error instead of guessing.
		const populated = new TodoTool(
			createSession([{ name: "Work", tasks: [{ content: "First", status: "pending" }] }]),
		);
		const ambiguous = await populated.execute("call-2", { items: ["Second"] } as never);
		expect(ambiguous.isError).toBe(true);
	});

	it("surfaces the schema error when op is missing and not inferable", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { task: "Something" } as never);

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Invalid todo arguments");
		expect(summary.text).toContain("op");
	});
});

describe("TodoTool empty items tolerance", () => {
	// Regression: a stray `items: []` on an op that ignores items (here `view`)
	// must not be a hard schema rejection. The top-level `items` array dropped
	// its `atLeastLength(1)` so callers don't get "items must be tasks to append"
	// for an irrelevant empty array; length is enforced per-op at runtime.
	it("accepts op:view with an empty items array at the schema boundary", () => {
		const schema = new TodoTool(createSession()).parameters;
		expect(schema({ op: "view", items: [] }) instanceof type.errors).toBe(false);
	});

	it("defers empty append items to an op-specific runtime error", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", { op: "append", phase: "Work", items: [] });

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing items for append operation");
	});
});

describe("todoMatchesAnyDescription", () => {
	it("matches identical strings", () => {
		expect(todoMatchesAnyDescription("Sonnet #1: AGENTS audit", ["Sonnet #1: AGENTS audit"])).toBe(true);
	});

	it("matches case- and whitespace-insensitively", () => {
		expect(todoMatchesAnyDescription("  Sonnet  #1: AGENTS Audit  ", ["sonnet #1: agents audit"])).toBe(true);
	});

	it("matches when description is a long-enough substring of the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan of diff", ["Sonnet #2"])).toBe(true);
	});

	it("matches when the todo is a long-enough substring of a description", () => {
		expect(todoMatchesAnyDescription("Sonnet #3", ["Sonnet #3: git blame / history check"])).toBe(true);
	});

	it("rejects substring matches below the minimum overlap", () => {
		// "Fix" is 3 chars — too short to qualify on either side.
		expect(todoMatchesAnyDescription("Fix", ["Fix the auth module bug"])).toBe(false);
		expect(todoMatchesAnyDescription("Fix the auth module bug", ["Fix"])).toBe(false);
	});

	it("ignores empty inputs without throwing", () => {
		expect(todoMatchesAnyDescription("", ["Sonnet #1"])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [""])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [])).toBe(false);
	});

	it("returns true on the first match without scanning further descriptions", () => {
		expect(
			todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["unrelated agent task", "Sonnet #2", "Sonnet #3"]),
		).toBe(true);
	});

	it("returns false when no description overlaps the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["Reviewer1AgentsAdherence", "git blame"])).toBe(
			false,
		);
	});

	it("ignores punctuation differences in identifiers", () => {
		// One side has a method-prefix '#', the other doesn't. Reproduced
		// from a real run where 3 subagents were spawned but only 2 of 3
		// matched todos lit up because the matcher's normalizer collapsed
		// whitespace but left punctuation intact.
		expect(
			todoMatchesAnyDescription("Audit integration site in renderTodoList", [
				"Audit integration site in #renderTodoList",
			]),
		).toBe(true);
		// Dotted abbreviations like AGENTS.md collapse to a space too.
		expect(todoMatchesAnyDescription("Audit AGENTS.md compliance", ["Audit AGENTS md compliance"])).toBe(true);
	});
});
describe("todoToolRenderer.renderResult view layout", () => {
	async function buildThreePhaseAfterDone() {
		const tool = new TodoTool(createSession());
		await tool.execute("init", {
			op: "init",
			list: [
				{ phase: "Alpha", items: ["a1", "a2"] },
				{ phase: "Beta", items: ["b1", "b2"] },
				{ phase: "Gamma", items: ["c1", "c2"] },
			],
		});
		// `done a1` keeps the active task inside Alpha (auto-promotes a2), leaving
		// Beta and Gamma untouched by this update.
		const result = await tool.execute("done", { op: "done", task: "a1" });
		return {
			...result,
			content: result.content.map(part => {
				if (part.type !== "text") throw new Error("Expected a text-only TODO result");
				return part;
			}),
			details: { ...result.details!, op: "view" as const },
		};
	}
	function innerLines(component: Component): string[] {
		const lines = Bun.stripANSI(component.render(100).join("\n")).split("\n");
		return lines.slice(1, -1).map(line =>
			line
				.replace(/^│/, "")
				.replace(/│\s*$/, "")
				.trim(),
		);
	}
	const describeSnapshotResult = (phases: TodoPhase[], op: "done" | "view" = "done") => ({
		content: [{ type: "text" as const, text: "" }],
		details: { op, phases, storage: "session" as const },
		isError: false,
	});

	it("keeps successful mutations concise even when expanded, while view shows every task", () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "finished step", status: "completed" },
					{ content: "next step", status: "pending" },
				],
			},
		];
		const render = (op: "done" | "view", expanded: boolean) =>
			Bun.stripANSI(
				todoToolRenderer
					.renderResult(describeSnapshotResult(phases, op), { expanded, isPartial: false }, theme)
					.render(120)
					.join("\n"),
			);
		for (const expanded of [false, true]) {
			const mutation = render("done", expanded);
			expect(mutation).not.toContain("finished step");
			expect(mutation).not.toContain("next step");
			expect(mutation).toContain("1/2");
		}

		const view = render("view", true);
		expect(view).toContain("finished step");
		expect(view).toContain("next step");
	});

	it("renders a forecasted view snapshot from its captured timestamp", () => {
		const forecastAt = Date.parse("2026-09-23T09:00:00.000Z");
		const result = describeSnapshotResult(
			[
				{
					name: "Work",
					tasks: [
						{
							content: "scheduled step",
							status: "in_progress",
							schedule: {
								dependencies: [],
								owner: "Worker",
								resources: [],
								estimate: {
									optimisticSeconds: 60,
									likelySeconds: 90,
									pessimisticSeconds: 150,
									confidence: "high",
									basis: "fixture",
									updatedAt: forecastAt,
								},
								startedAt: forecastAt - 7 * 60_000,
							},
						},
					],
				},
			],
			"view",
		);
		const snapshot = { ...result, details: { ...result.details, forecastAt } };
		const render = () => todoToolRenderer.renderResult(snapshot, { expanded: true, isPartial: false }, theme);
		vi.useFakeTimers();
		try {
			setSystemTime(new Date(forecastAt));
			const component = render();
			const firstRender = component.render(120).join("\n");
			expect(Bun.stripANSI(firstRender)).toContain("scheduled step");
			expect(Bun.stripANSI(firstRender)).toContain("7m / 2m");
			expect(Bun.stripANSI(firstRender)).not.toContain("overdue");
			setSystemTime(new Date(forecastAt + 60 * 60_000));
			expect(component.render(120).join("\n")).toBe(firstRender);
			expect(render().render(120).join("\n")).toBe(firstRender);
		} finally {
			vi.useRealTimers();
			setSystemTime();
			vi.restoreAllMocks();
		}
	});
	it("renders overdue open forecast rows red and preserves the non-overdue status color", () => {
		const now = Date.parse("2026-09-23T10:00:00.000Z");
		const task = (content: string, startedAt: number): TodoItem => ({
			content,
			status: "in_progress",
			schedule: {
				dependencies: [],
				owner: "Worker",
				resources: [],
				estimate: {
					optimisticSeconds: 60,
					likelySeconds: 90,
					pessimisticSeconds: 150,
					confidence: "high",
					basis: "fixture",
					updatedAt: startedAt,
				},
				startedAt,
			},
		});
		const result = describeSnapshotResult(
			[{ name: "Work", tasks: [task("late step", now - 10 * 60_000), task("current step", now)] }],
			"view",
		);
		const rendered = todoToolRenderer
			.renderResult(
				{ ...result, details: { ...result.details, forecastAt: now } },
				{ expanded: true, isPartial: false },
				theme,
			)
			.render(160)
			.join("\n");

		expect(rendered).toContain(theme.fg("error", `${theme.checkbox.unchecked} late step`));
		expect(rendered).toContain(theme.fg("accent", `${theme.checkbox.unchecked} current step`));
		expect(Bun.stripANSI(rendered)).toContain("10m / 2m");
		expect(Bun.stripANSI(rendered)).toContain("0m / 2m");
	});

	it("orders view rows topologically across phase sections without changing stored order", () => {
		const phases: TodoPhase[] = [
			{
				name: "Alpha",
				tasks: [
					{ content: "Alpha later", status: "pending", schedule: { dependencies: ["Beta bridge"] } },
					{ content: "Alpha start", status: "pending", schedule: { dependencies: [] } },
				],
			},
			{
				name: "Beta",
				tasks: [{ content: "Beta bridge", status: "pending", schedule: { dependencies: ["Alpha start"] } }],
			},
		];
		const originalOrder = phases.map(phase => phase.tasks.map(task => task.content));
		const result = describeSnapshotResult(phases, "view");
		const rendered = Bun.stripANSI(
			todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme).render(140).join("\n"),
		);
		const start = rendered.indexOf("Alpha start");
		const bridge = rendered.indexOf("Beta bridge");
		const later = rendered.indexOf("Alpha later");
		expect(start).toBeGreaterThanOrEqual(0);
		expect(start).toBeLessThan(bridge);
		expect(bridge).toBeLessThan(later);
		expect(rendered.match(/I\. Alpha/g)?.length).toBe(2);
		expect(phases.map(phase => phase.tasks.map(task => task.content))).toEqual(originalOrder);
	});
	it("drops blank separator lines between view phases", async () => {
		const result = await buildThreePhaseAfterDone();
		const component = todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme);
		// No empty body line survives between phases.
		expect(innerLines(component).every(line => line.length > 0)).toBe(true);
	});
});

describe("selectCollapsedTodos walking viewport (#5873)", () => {
	const mk = (n: number, inProgress: number[]): TodoItem[] =>
		Array.from({ length: n }, (_, i) => ({
			content: `Task ${i + 1}`,
			status: inProgress.includes(i + 1) ? "in_progress" : "pending",
		}));
	const never = () => false;
	const contents = (sel: { items: TodoItem[] }) => sel.items.map(t => t.content);

	it("starts at the sole in-progress task and fills with following tasks", () => {
		const sel = selectCollapsedTodos(mk(14, [6]), never, 8);
		expect(contents(sel)).toEqual([
			"Task 6",
			"Task 7",
			"Task 8",
			"Task 9",
			"Task 10",
			"Task 11",
			"Task 12",
			"Task 13",
		]);
		expect(sel.summary).toContain("6 more todos");
	});

	it("leads with the last closed task and omits the rest in collapsed mode", () => {
		const tasks: TodoItem[] = [
			{ content: "done", status: "completed" },
			{ content: "dropped", status: "abandoned" },
			{ content: "current", status: "in_progress" },
			{ content: "next", status: "pending" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		// One closed row survives so a completion is visible as it lands; earlier
		// closed work stays hidden.
		expect(contents(sel)).toEqual(["dropped", "current", "next"]);
		expect(sel.summary).toBe("");
	});

	it("keeps an out-of-order completion as the closed lead row", () => {
		const tasks: TodoItem[] = [
			{ content: "current", status: "in_progress" },
			{ content: "next", status: "pending" },
			{ content: "finished early", status: "completed" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		expect(contents(sel)).toEqual(["finished early", "current", "next"]);
	});

	it("keeps the closed lead row additive to the open-task cap", () => {
		const tasks: TodoItem[] = [{ content: "closed", status: "completed" }, ...mk(5, [1])];
		const sel = selectCollapsedTodos(tasks, never, 5);
		// All 5 open tasks fit the cap; the closed context row does not evict one.
		expect(contents(sel)).toEqual(["closed", "Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
		expect(sel.summary).toBe("");
	});

	it("places every subagent-matched todo at the head in todo order", () => {
		const tasks = mk(14, []); // all pending
		const matched = (t: TodoItem) => t.content === "Task 3" || t.content === "Task 9";
		const sel = selectCollapsedTodos(tasks, matched, 5);
		// Both matched actives lead, then following pending fill from the first active.
		expect(contents(sel).slice(0, 2)).toEqual(["Task 3", "Task 9"]);
		expect(contents(sel)).toHaveLength(5);
	});

	it("counts all hidden work when active and pending todos overflow", () => {
		const tasks = mk(10, []);
		const matched = (t: TodoItem) =>
			["Task 1", "Task 2", "Task 3", "Task 4", "Task 5", "Task 6", "Task 7"].includes(t.content);
		const sel = selectCollapsedTodos(tasks, matched, 5);
		expect(contents(sel)).toEqual(["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
		expect(sel.summary).toBe("… 5 more todos");
		// No unrelated pending rows leak in.
		expect(contents(sel).some(c => ["Task 8", "Task 9", "Task 10"].includes(c))).toBe(false);
	});

	it("shows one hidden active row only when no pending todo is omitted", () => {
		const activeOnly = selectCollapsedTodos(mk(6, []), () => true, 5);
		expect(contents(activeOnly)).toHaveLength(6);
		expect(activeOnly.summary).toBe("");
		const withPending = selectCollapsedTodos(mk(7, []), task => task.content !== "Task 7", 5);
		expect(contents(withPending)).toHaveLength(5);
		expect(withPending.summary).toBe("… 2 more todos");
	});

	it("shows a sole trailing pending todo as a real row when active tasks fill the cap", () => {
		const tasks = mk(6, []);
		const matched = (t: TodoItem) => ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"].includes(t.content);
		const sel = selectCollapsedTodos(tasks, matched, 5);
		expect(contents(sel)).toHaveLength(6);
		expect(contents(sel)).toContain("Task 6");
		expect(sel.summary).toBe("");
	});

	it("returns the whole open set with no summary when it fits", () => {
		const sel = selectCollapsedTodos(mk(3, [2]), never, 5);
		expect(contents(sel)).toEqual(["Task 1", "Task 2", "Task 3"]);
		expect(sel.summary).toBe("");
	});

	it("falls back to closed tasks when the phase has no open work", () => {
		const tasks: TodoItem[] = [
			{ content: "done a", status: "completed" },
			{ content: "done b", status: "completed" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		expect(contents(sel)).toEqual(["done a", "done b"]);
	});
});

describe("todoToolRenderer.renderCall malformed-args regression (#2005)", () => {
	// Reporter saw `TypeError: args?.ops?.map is not a function` against
	// Xiaomi Token Plan's Anthropic protocol because `parseStreamingJson`
	// surfaced `{ ops: "[..." }` shapes mid-stream. The renderer is invoked
	// on every streaming delta, so any non-array `ops` (string, object,
	// number) must NOT crash the TUI render loop and trigger the spam-warn /
	// retry cascade.
	const renderOptions = { expanded: false, isPartial: true } as const;

	it("does not throw when op is a streaming-truncated number", () => {
		// Mid-stream the new flat shape can surface `{ op: 1 }` before the
		// discriminator string lands.
		const args = { op: 1 } as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("does not throw when a flat op's items field is a non-array", () => {
		const args = {
			op: "append",
			phase: "Work",
			items: "Second" as unknown as string[],
		} as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("does not throw on the legacy streaming-truncated `ops` string", () => {
		// Old transcripts/collab-web still carry `{ ops: "[{" }` mid-stream;
		// `normalizeTodoArg` must keep tolerating the legacy batch shape.
		const args = { ops: '[{"op":"init"' } as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("renders op summary metadata for a well-formed flat call", () => {
		const args = { op: "init", items: ["a", "b", "c"] };
		const component = todoToolRenderer.renderCall(args, renderOptions, theme);
		// `Text(text, 0, 0)` from `@oh-my-pi/pi-tui` exposes the content via .render().
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("init");
		expect(rendered).toContain("3 items");
	});

	it("still renders legacy multi-op `ops` arrays from old transcripts", () => {
		const args = {
			ops: [
				{ op: "init", items: ["a", "b", "c"] },
				{ op: "done", task: "a" },
				{ op: "append", phase: "Cleanup", items: ["d"] },
			],
		};
		const component = todoToolRenderer.renderCall(args, renderOptions, theme);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("init");
		expect(rendered).toContain("3 items");
		expect(rendered).toContain("done");
		expect(rendered).toContain("append");
		expect(rendered).toContain("Cleanup");
		expect(rendered).toContain("1 item");
	});
});

describe("todoToolRenderer archived rows", () => {
	it("shows recovered evidence only on an explicit archive view", () => {
		const phases: TodoPhase[] = [{ name: "Live", tasks: [{ content: "Active work", status: "pending" }] }];
		const archivedPhases: TodoPhase[] = [{ name: "Old", tasks: [{
			content: "Historic completed work",
			status: "completed",
			schedule: {
				startedAt: 1_000,
				finishedAt: 4_000,
				estimate: { optimisticSeconds: 1, likelySeconds: 2, pessimisticSeconds: 5, confidence: "high", basis: "retained", updatedAt: 500 },
				executor: { workerId: "worker-archive", startedAt: 1_000, finishedAt: 4_000, outcome: "completed" },
			},
		}] }];
		function render(op: "view" | "done", explicit: boolean): string {
			const details = { op, phases, storage: "session" as const, ...(explicit ? { archivedPhases } : {}) };
			const result = { content: [{ type: "text" as const, text: "Todo summary" }], details } as Parameters<typeof todoToolRenderer.renderResult>[0];
			return Bun.stripANSI(todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme).render(120).join("\n"));
		}
		const explicit = render("view", true);
		expect(explicit).toContain("Historic completed work");
		expect(explicit).toContain("estimate 2s");
		expect(explicit).toContain("actual 3s");
		expect(explicit).toContain("worker-archive");
		expect(explicit).toContain("finished");
		expect(render("view", false)).not.toContain("Historic completed work");
		expect(render("done", true)).not.toContain("Historic completed work");
	});
	it("renders an archive even when the live plan is empty", () => {
		const result = {
			content: [{ type: "text" as const, text: "Todo list is empty." }],
			details: {
				op: "view" as const,
				storage: "session" as const,
				phases: [],
				archivedPhases: [{ name: "Old", tasks: [{ content: "Archived sole task", status: "completed" as const }] }],
			},
		} as Parameters<typeof todoToolRenderer.renderResult>[0];
		const rendered = Bun.stripANSI(todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme).render(120).join("\n"));
		expect(rendered).toContain("Archived sole task");
	});
});

describe("todoToolRenderer.renderResult label sanitization", () => {
	// A mirrored Cursor snapshot carries provider text verbatim into
	// `details.phases`, and the renderer interpolates it straight into terminal
	// output. A label holding ANSI/C0 sequences would rewrite the terminal every
	// time the list renders or replays.
	function renderPhases(phases: TodoPhase[]): string {
		const result = {
			content: [{ type: "text" as const, text: "1/1 tasks completed" }],
			details: { op: "view", phases, storage: "session" as const },
			isError: false,
		} as unknown as Parameters<typeof todoToolRenderer.renderResult>[0];
		const component = todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme);
		return component.render(120).join("\n");
	}

	it("strips control sequences from a mirrored task label", () => {
		const hostile = "clear\u001b[2Jscreen\u0007bell";
		const rendered = renderPhases([
			{ name: "Execution", tasks: [{ content: hostile, status: "pending" }] },
		] as unknown as TodoPhase[]);

		// The dangerous bytes are gone; the readable text survives.
		expect(rendered).not.toContain("\u001b[2J");
		expect(rendered).not.toContain("\u0007");
		expect(Bun.stripANSI(rendered)).toContain("clear");
		expect(Bun.stripANSI(rendered)).toContain("screen");
	});

	it("strips control sequences from a blocker note", () => {
		const rendered = renderPhases([
			{
				name: "Execution",
				tasks: [{ content: "ship it", status: "blocked", blocker: "waiting\u001b[2Jhere" }],
			},
		] as unknown as TodoPhase[]);

		expect(rendered).not.toContain("\u001b[2J");
		expect(Bun.stripANSI(rendered)).toContain("waiting");
	});

	it("keeps a completed label intact under the strikethrough path", () => {
		// The completed branch runs the label through `strikethroughText`, which
		// splices per character — sanitizing first keeps that from interleaving
		// styling with control bytes.
		const rendered = renderPhases([
			{ name: "Execution", tasks: [{ content: "done\u001b[2Jtask", status: "completed" }] },
		] as unknown as TodoPhase[]);

		expect(rendered).not.toContain("\u001b[2J");
		expect(Bun.stripANSI(rendered)).toContain("done");
	});

	it("strips control sequences from a phase header", () => {
		// Multi-phase renders the header; single-phase omits it.
		const rendered = renderPhases([
			{ name: "Set\u001b[2Jup", tasks: [{ content: "a", status: "pending" }] },
			{ name: "Ship", tasks: [{ content: "b", status: "pending" }] },
		] as unknown as TodoPhase[]);

		expect(rendered).not.toContain("\u001b[2J");
		expect(Bun.stripANSI(rendered)).toContain("Set");
		expect(Bun.stripANSI(rendered)).toContain("up");
	});

	it("strips control sequences from the zero-task fallback text", () => {
		// Cursor's own summary or refusal note lands here when nothing is mirrored.
		const result = {
			content: [{ type: "text" as const, text: "Todo\u001b[2Jsnapshot not mirrored" }],
			details: { phases: [], storage: "session" as const },
			isError: false,
		} as unknown as Parameters<typeof todoToolRenderer.renderResult>[0];
		const rendered = todoToolRenderer
			.renderResult(result, { expanded: true, isPartial: false }, theme)
			.render(120)
			.join("\n");

		expect(rendered).not.toContain("\u001b[2J");
		expect(Bun.stripANSI(rendered)).toContain("snapshot not mirrored");
	});

	it("flattens tabs in every result-side fragment", () => {
		// `sanitizeText` deliberately preserves tabs, and a raw tab punches holes
		// in bordered TUI output — so the display path must replace them too.
		const rendered = renderPhases([
			{ name: "Set\tup", tasks: [{ content: "ship\tit", status: "blocked", blocker: "waiting\there" }] },
			{ name: "Ship", tasks: [{ content: "b", status: "pending" }] },
		] as unknown as TodoPhase[]);

		expect(rendered).not.toContain("\t");
		expect(Bun.stripANSI(rendered)).toContain("ship");
		expect(Bun.stripANSI(rendered)).toContain("waiting");
		expect(Bun.stripANSI(rendered)).toContain("Set");
	});

	it("flattens tabs in the zero-task fallback text", () => {
		const result = {
			content: [{ type: "text" as const, text: "Todo\tsnapshot not mirrored" }],
			details: { phases: [], storage: "session" as const },
			isError: false,
		} as unknown as Parameters<typeof todoToolRenderer.renderResult>[0];
		const rendered = todoToolRenderer
			.renderResult(result, { expanded: true, isPartial: false }, theme)
			.render(120)
			.join("\n");

		expect(rendered).not.toContain("\t");
		expect(Bun.stripANSI(rendered)).toContain("snapshot not mirrored");
	});
});

describe("todoToolRenderer.renderCall preview sanitization", () => {
	// The streaming preview interpolates partially-parsed, model-authored args
	// straight into the status header. `renderStatusLine` only flattens CR/LF and
	// leaves tabs to the caller, so control sequences and tabs must be handled
	// here or a mid-stream delta rewrites the terminal.
	function renderArgs(args: unknown): string {
		const component = todoToolRenderer.renderCall(
			args as Parameters<typeof todoToolRenderer.renderCall>[0],
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);
		return component.render(120).join("\n");
	}

	it("strips control sequences from the task and phase fragments", () => {
		const rendered = renderArgs({ op: "done", task: "ship\u001b[2Jit", phase: "Exec\u0007ution" });

		expect(rendered).not.toContain("\u001b[2J");
		expect(rendered).not.toContain("\u0007");
		expect(Bun.stripANSI(rendered)).toContain("ship");
		expect(Bun.stripANSI(rendered)).toContain("Exec");
	});

	it("flattens tabs so a fragment cannot punch holes in the header", () => {
		const rendered = renderArgs({ op: "done", task: "ship\tit" });

		expect(rendered).not.toContain("\t");
		expect(Bun.stripANSI(rendered)).toContain("ship");
		expect(Bun.stripANSI(rendered)).toContain("it");
	});
});
