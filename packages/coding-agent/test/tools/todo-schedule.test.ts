import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	TodoTool,
	getLatestTodoArchiveFromEntries,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { forecastTodoPlan, getTodoPlanningIssues } from "@oh-my-pi/pi-tui/tools/todo-schedule";

function createHarness(initialPhases: TodoPhase[]) {
	let phases = structuredClone(initialPhases);
	const session: ToolSession = {
		cwd: "/tmp/todo-schedule-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
		settings: Settings.isolated(),
	};
	return { tool: new TodoTool(session), phases: () => phases };
}

const initialPlan: TodoPhase[] = [
	{
		name: "Implementation",
		tasks: [
			{
				content: "Earlier completed research",
				status: "completed",
				details: "Keep source notes",
				notes: ["reviewed upstream behavior"],
				schedule: { finishedAt: 100, owner: "archive" },
			},
			{
				content: "Build parser",
				status: "in_progress",
				details: "Parser details survive status changes",
				notes: ["preserve this note"],
				schedule: {
					dependencies: [],
					owner: "old-owner",
					resources: ["cpu"],
					estimate: {
						optimisticSeconds: 30,
						likelySeconds: 60,
						pessimisticSeconds: 90,
						confidence: "medium",
						basis: "Previously measured parser change size",
						updatedAt: 200,
					},
					progress: { at: 250, evidence: "Existing parse path inspected" },
					startedAt: 300,
				},
			},
			{ content: "Add parser regression", status: "pending" },
		],
	},
];

describe("native todo schedule operation", () => {
	it("does not re-anchor unchanged estimate resends", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		try {
			const harness = createHarness([{ name: "Revision proof", tasks: [{ content: "ship", status: "pending" }] }]);
			const estimate = {
				optimisticSeconds: 30,
				likelySeconds: 60,
				pessimisticSeconds: 90,
				confidence: "medium" as const,
				basis: "One bounded artifact",
			};
			await harness.tool.execute("first", {
				op: "schedule",
				updates: [{ task: "ship", dependencies: [], estimate }],
			});
			expect(harness.phases()[0].tasks[0].schedule).toMatchObject({ estimateRevision: 1, reestimateCount: 0 });
			const firstForecast = forecastTodoPlan(harness.phases(), { now: 1_800_000_000_000 });
			const firstP95Finish = firstForecast.rows[0].fixedPathP95Finish;
			expect(firstP95Finish).toBeDefined();

			clock.mockReturnValue(1_800_000_120_000);
			await harness.tool.execute("same-estimate", {
				op: "schedule",
				updates: [{ task: "ship", estimate }],
			});
			expect(forecastTodoPlan(harness.phases(), { now: 1_800_000_120_000 }).rows[0].fixedPathP95Finish).toBe(
				firstP95Finish,
			);

			await harness.tool.execute("evidence", {
				op: "schedule",
				updates: [
					{
						task: "ship",
						owner: "worker",
						evidence: "Artifact changed",
						estimate: { ...estimate, basis: "Same numeric estimate after evidence changed" },
					},
				],
			});
			await harness.tool.execute("view", { op: "view" });
			expect(harness.phases()[0].tasks[0].schedule).toMatchObject({
				estimateRevision: 1,
				reestimateCount: 0,
				owner: "worker",
				estimate: {
					basis: "Same numeric estimate after evidence changed",
					updatedAt: 1_800_000_000_000,
				},
				progress: { at: 1_800_000_120_000, evidence: "Artifact changed" },
			});
			expect(forecastTodoPlan(harness.phases(), { now: 1_800_000_120_000 }).rows[0]).toMatchObject({
				fixedPathP95Finish: firstP95Finish,
				estimateUpdatedAt: 1_800_000_000_000,
				estimateRevision: 1,
				reestimateCount: 0,
			});
			const rejected = await harness.tool.execute("rejected", {
				op: "schedule",
				updates: [
					{ task: "ship", estimate },
					{ task: "absent", owner: "nobody" },
				],
			});
			expect(rejected.isError).toBe(true);
			expect(harness.phases()[0].tasks[0].schedule?.reestimateCount).toBe(0);
			clock.mockReturnValue(1_800_000_240_000);
			await harness.tool.execute("revision", {
				op: "schedule",
				updates: [{ task: "ship", estimate: { ...estimate, likelySeconds: 75 } }],
			});
			const restored = markdownToPhases(phasesToMarkdown(harness.phases()));
			expect(restored.errors).toEqual([]);
			expect(restored.phases[0].tasks[0].schedule).toMatchObject({ estimateRevision: 2, reestimateCount: 1 });
			expect(restored.phases[0].tasks[0].schedule?.estimate?.updatedAt).toBe(1_800_000_240_000);
			const forecast = forecastTodoPlan(restored.phases, { now: 1_800_000_240_000 });
			expect(forecast.rows[0].fixedPathP95Finish).not.toBe(firstP95Finish);
			expect(forecast.rows[0]).toMatchObject({
				estimateRevision: 2,
				reestimateCount: 1,
				estimateUpdatedAt: 1_800_000_240_000,
			});
		} finally {
			clock.mockRestore();
		}
	});
	it("keeps completion time stable and restores only explicit completion-transition history", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		try {
			const harness = createHarness([{ name: "Work", tasks: [{ content: "ship", status: "pending" }] }]);
			await harness.tool.execute("init", { op: "init", list: [{ phase: "Work", items: ["ship"] }] });
			await harness.tool.execute("done-first", { op: "done", task: "ship" });
			expect(harness.phases()[0].tasks[0].schedule?.finishedAt).toBe(1_800_000_000_000);
			clock.mockReturnValue(1_800_000_600_000);
			const secondDone = await harness.tool.execute("done-again", { op: "done", task: "ship" });
			const archived = getLatestTodoArchiveFromEntries([
				{
					type: "custom",
					id: "archive",
					parentId: null,
					timestamp: new Date(1_800_000_600_000).toISOString(),
					customType: "user_todo_edit",
					data: { edit: secondDone.details?.edit },
				} as unknown as SessionEntry,
			]);
			expect(archived[0]?.tasks[0]?.schedule?.finishedAt).toBe(1_800_000_000_000);
			expect(archived[0]?.tasks[0]?.status).toBe("completed");

			const timestamp = "2026-09-23T17:13:21.867Z";
			const legacy = [{ name: "Work", tasks: [{ content: "legacy", status: "completed" as const }] }];
			const exactTransition = {
				type: "message",
				id: "transition",
				parentId: null,
				timestamp,
				message: {
					role: "toolResult",
					toolName: "todo",
					isError: false,
					details: {
						op: "done",
						phases: legacy,
						completedTasks: [{ phase: "Work", content: "legacy" }],
					},
				},
			};
			const latestSnapshot = {
				...exactTransition,
				id: "latest",
				message: { ...exactTransition.message, details: { op: "schedule", phases: legacy } },
			};
			const restored = getLatestTodoPhasesFromEntries([
				exactTransition,
				latestSnapshot,
			] as unknown as SessionEntry[]);
			expect(restored[0].tasks[0].schedule?.finishedAt).toBe(Date.parse(timestamp));

			const noEvidence = getLatestTodoPhasesFromEntries([latestSnapshot] as unknown as SessionEntry[]);
			expect(noEvidence[0].tasks[0].schedule?.finishedAt).toBeUndefined();
		} finally {
			clock.mockRestore();
		}
	});

	it("requires decomposition only above the one-hour pessimistic boundary", async () => {
		const harness = createHarness([
			{
				name: "Work",
				tasks: [
					{ content: "At one hour", status: "pending" },
					{ content: "Over one hour", status: "pending" },
				],
			},
		]);
		const result = await harness.tool.execute("boundary", {
			op: "schedule",
			updates: [
				{
					task: "At one hour",
					dependencies: [],
					estimate: {
						optimisticSeconds: 1,
						likelySeconds: 1800,
						pessimisticSeconds: 3600,
						confidence: "medium",
						basis: "Synthetic boundary input",
					},
				},
				{
					task: "Over one hour",
					dependencies: [],
					estimate: {
						optimisticSeconds: 1,
						likelySeconds: 1800,
						pessimisticSeconds: 3601,
						confidence: "medium",
						basis: "Synthetic boundary input",
					},
				},
			],
		});

		expect(result.isError).toBeUndefined();
		expect(getTodoPlanningIssues(harness.phases())).toMatchObject([
			{ task: "Over one hour", code: "task-too-large" },
		]);
	});

	it("accepts partial schedule repairs but refuses to start until the remainder is planned", async () => {
		const harness = createHarness([
			{
				name: "Work",
				tasks: [
					{ content: "Build parser", status: "pending" },
					{ content: "Add tests", status: "pending" },
				],
			},
		]);
		const estimate = {
			optimisticSeconds: 30,
			likelySeconds: 60,
			pessimisticSeconds: 120,
			confidence: "medium" as const,
			basis: "Synthetic bounded task",
		};
		const partial = await harness.tool.execute("partial", {
			op: "schedule",
			updates: [{ task: "Build parser", dependencies: [], estimate }],
		});
		expect(partial.isError).toBeUndefined();
		expect(harness.phases()[0].tasks[0].schedule?.estimate?.likelySeconds).toBe(60);
		expect(harness.phases()[0].tasks[1].schedule).toBeUndefined();

		const start = await harness.tool.execute("start-before-plan-complete", { op: "start", task: "Build parser" });
		expect(start.isError).toBe(true);
		expect(harness.phases()[0].tasks.map(task => task.status)).toEqual(["pending", "pending"]);

		const remainder = await harness.tool.execute("plan-remainder", {
			op: "schedule",
			updates: [{ task: "Add tests", dependencies: ["Build parser"], estimate }],
		});
		expect(remainder.isError).toBeUndefined();
		expect(getTodoPlanningIssues(harness.phases())).toEqual([]);
	});

	it("stamps grounded estimates/evidence and preserves schedules through lifecycle, view, and Markdown round-trip", async () => {
		const now = 1_800_000_000_000;
		const time = spyOn(Date, "now").mockReturnValue(now);
		try {
			const harness = createHarness(initialPlan);
			const scheduled = await harness.tool.execute("schedule-1", {
				op: "schedule",
				updates: [
					{
						task: "Build parser",
						owner: "parser-agent",
						resources: ["cpu"],
						estimate: {
							optimisticSeconds: 45,
							likelySeconds: 90,
							pessimisticSeconds: 150,
							confidence: "medium",
							basis: "One parser path and one regression boundary remain",
						},
						evidence: "Inspected the parser path; one boundary remains",
					},
					{
						task: "Add parser regression",
						dependencies: ["Build parser"],
						owner: "test-agent",
						resources: [],
						estimate: {
							optimisticSeconds: 20,
							likelySeconds: 40,
							pessimisticSeconds: 70,
							confidence: "low",
							basis: "One observable parser boundary is identified",
						},
					},
				],
			});

			expect(scheduled.isError).toBeUndefined();
			const scheduledPhases = harness.phases();
			const tasks = scheduledPhases[0]?.tasks ?? [];
			expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress", "pending"]);
			expect(tasks[0]).toMatchObject({
				status: "completed",
				details: "Keep source notes",
				notes: ["reviewed upstream behavior"],
			});
			expect(tasks[1]?.schedule).toMatchObject({
				owner: "parser-agent",
				resources: ["cpu"],
				estimate: { updatedAt: now, likelySeconds: 90 },
				progress: { at: now, evidence: "Inspected the parser path; one boundary remains" },
			});
			expect(tasks[2]?.schedule).toMatchObject({
				dependencies: ["Build parser"],
				owner: "test-agent",
				resources: [],
			});
			expect(scheduled.details?.completedTasks).toBeUndefined();

			await harness.tool.execute("done-1", { op: "done", task: "Build parser" });
			const afterDone = harness.phases()[0]?.tasks ?? [];
			expect(afterDone[0]?.status).toBe("completed");
			expect(afterDone[1]?.status).toBe("completed");
			expect(afterDone[1]?.schedule?.finishedAt).toBe(now);
			expect(afterDone[1]?.schedule?.estimate?.updatedAt).toBe(now);
			expect(afterDone[2]?.status).toBe("in_progress");
			expect(afterDone[2]?.schedule?.startedAt).toBe(now);

			await harness.tool.execute("block-1", {
				op: "block",
				task: "Add parser regression",
				reason: "waiting on assertion",
			});
			const blocked = harness.phases()[0]?.tasks[2];
			expect(blocked?.status).toBe("blocked");
			expect(blocked?.schedule?.dependencies).toEqual(["Build parser"]);
			await harness.tool.execute("unblock-1", { op: "unblock", task: "Add parser regression" });
			await harness.tool.execute("start-1", { op: "start", task: "Add parser regression" });
			expect(harness.phases()[0]?.tasks[2]?.status).toBe("in_progress");
			expect(harness.phases()[0]?.tasks[2]?.schedule?.owner).toBe("test-agent");

			const beforeView = structuredClone(harness.phases());
			const view = await harness.tool.execute("view-1", { op: "view" });
			expect(harness.phases()).toEqual(beforeView);
			expect(view.details?.phases).toEqual(beforeView);

			const roundTrip = markdownToPhases(phasesToMarkdown(beforeView));
			expect(roundTrip.errors).toEqual([]);
			expect(roundTrip.phases).toEqual(beforeView);
			const recoveredForecast = forecastTodoPlan(roundTrip.phases, { now });
			const parser = recoveredForecast.rows.find(row => row.content === "Build parser");
			const regression = recoveredForecast.rows.find(row => row.content === "Add parser regression");
			if (parser?.earliestFinish === undefined || regression?.earliestStart === undefined) {
				throw new Error("Expected dependency forecast dates after Markdown recovery");
			}
			expect(regression.earliestStart).toBeGreaterThanOrEqual(parser.earliestFinish);
			expect(roundTrip.phases[0]?.tasks[0]).toMatchObject({
				details: "Keep source notes",
				notes: ["reviewed upstream behavior"],
			});
		} finally {
			time.mockRestore();
		}
	});

	it("rejects a bad estimate atomically without changing task status or prior completed work", async () => {
		const harness = createHarness(initialPlan);
		const before = structuredClone(harness.phases());
		const result = await harness.tool.execute("schedule-bad-range", {
			op: "schedule",
			updates: [
				{ task: "Build parser", owner: "would-have-applied" },
				{
					task: "Add parser regression",
					estimate: {
						optimisticSeconds: 20,
						likelySeconds: 10,
						pessimisticSeconds: 5,
						confidence: "medium",
						basis: "Out of order on purpose",
					},
				},
			],
		});

		expect(result.isError).toBe(true);
		expect(harness.phases()).toEqual(before);
	});

	it("rejects unknown dependencies atomically", async () => {
		const harness = createHarness(initialPlan);
		const before = structuredClone(harness.phases());
		const result = await harness.tool.execute("schedule-missing-dependency", {
			op: "schedule",
			updates: [
				{ task: "Build parser", owner: "would-have-applied" },
				{ task: "Add parser regression", dependencies: ["build parser"] },
			],
		});

		expect(result.isError).toBe(true);
		expect(harness.phases()).toEqual(before);
	});

	it("rejects cyclic and self dependencies atomically", async () => {
		const harness = createHarness(initialPlan);
		const before = structuredClone(harness.phases());
		const result = await harness.tool.execute("schedule-cycle", {
			op: "schedule",
			updates: [
				{ task: "Build parser", dependencies: ["Add parser regression"] },
				{ task: "Add parser regression", dependencies: ["Build parser"] },
			],
		});

		expect(result.isError).toBe(true);
		expect(harness.phases()).toEqual(before);

		const self = await harness.tool.execute("schedule-self-cycle", {
			op: "schedule",
			updates: [{ task: "Build parser", dependencies: ["Build parser"] }],
		});
		expect(self.isError).toBe(true);
		expect(harness.phases()).toEqual(before);
	});
});
