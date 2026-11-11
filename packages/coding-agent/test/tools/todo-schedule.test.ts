import { describe, expect, it, spyOn } from "bun:test";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import danglingReplay from "./fixtures/stored-dangling-edge-dc.json";
import selfEdgeReplay from "./fixtures/stored-self-edge-dc.json";
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
		cwd: `${import.meta.dir}/../../../../tmp/todo-schedule-test`,
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
	it("resets reestimates on owner changes without discarding row history", async () => {
		for (const withEstimate of [false, true]) {
			const phases = structuredClone(initialPlan);
			const schedule = phases[0].tasks[1].schedule!;
			schedule.reestimateCount = 5;
			schedule.estimateRevision = 6;
			schedule.attemptHistory = [
				{
					attemptId: "old-owner:1",
					workerName: "old-owner",
					resolvedModel: "local/test",
					effort: "high",
					startedAt: 100,
					finishedAt: 200,
					durationMs: 100,
					terminalStatus: "failed",
					deliverablePaths: [],
				},
			];
			const harness = createHarness(phases);
			const result = await harness.tool.execute("restaff", {
				op: "schedule",
				updates: [
					{
						task: "Build parser",
						owner: " new-owner ",
						...(withEstimate ? { estimate: { ...schedule.estimate!, likelySeconds: 75 } } : {}),
					},
				],
			});
			expect(result.isError).not.toBe(true);
			expect(harness.phases()[0].tasks[1].schedule).toMatchObject({
				owner: "new-owner",
				reestimateCount: 0,
				estimateRevision: withEstimate ? 7 : 6,
				attemptHistory: schedule.attemptHistory,
			});
			const restored = markdownToPhases(phasesToMarkdown(harness.phases()));
			expect(restored.errors).toEqual([]);
			expect(restored.phases[0].tasks[1].schedule).toEqual(harness.phases()[0].tasks[1].schedule);
			await harness.tool.execute("same-owner", {
				op: "schedule",
				updates: [{ task: "Build parser", owner: " new-owner " }],
			});
			expect(harness.phases()[0].tasks[1].schedule?.reestimateCount).toBe(0);
			await harness.tool.execute("reestimate", {
				op: "schedule",
				updates: [{ task: "Build parser", estimate: { ...schedule.estimate!, likelySeconds: 80 } }],
			});
			expect(harness.phases()[0].tasks[1].schedule?.reestimateCount).toBe(1);
			await harness.tool.execute("same-owner-again", {
				op: "schedule",
				updates: [{ task: "Build parser", owner: " new-owner " }],
			});
			expect(harness.phases()[0].tasks[1].schedule?.reestimateCount).toBe(1);
			await harness.tool.execute("clear-owner", {
				op: "schedule",
				updates: [{ task: "Build parser", owner: "" }],
			});
			expect(harness.phases()[0].tasks[1].schedule?.owner).toBeUndefined();
			expect(harness.phases()[0].tasks[1].schedule?.reestimateCount).toBe(0);
		}
	});
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
						estimate: { ...estimate, confidence: "high", basis: "Same numeric estimate after evidence changed" },
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
			expect(archived).toEqual([]);
			expect(harness.phases()[0].tasks[0]).toMatchObject({
				status: "completed",
				schedule: { finishedAt: 1_800_000_000_000 },
			});

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

	it("does not ask to split a row that is already running under its owner", () => {
		const estimate = {
			optimisticSeconds: 5100,
			likelySeconds: 7200,
			pessimisticSeconds: 12000,
			confidence: "low" as const,
			basis: "measured suite progress",
		};
		const issues = getTodoPlanningIssues([
			{
				name: "Work",
				tasks: [
					{
						content: "Running suite",
						status: "in_progress",
						schedule: { dependencies: [], owner: "job:4242", estimate },
					},
					{ content: "Unstarted suite", status: "pending", schedule: { dependencies: [], estimate } },
				],
			},
		] as never);
		expect(issues.filter(issue => issue.code === "task-too-large").map(issue => issue.task)).toEqual([
			"Unstarted suite",
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
	it("renames scheduled rows without detaching metadata or dependencies", async () => {
		const attempt = {
			attemptId: "worker:100",
			workerName: "worker",
			resolvedModel: "model",
			effort: "high",
			startedAt: 100,
			finishedAt: 200,
			durationMs: 100,
			terminalStatus: "failed" as const,
			deliverablePaths: ["result.txt"],
		};
		const initial: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{
						content: "Old title",
						status: "in_progress",
						schedule: {
							owner: "worker",
							resources: ["checkout"],
							dependencies: [],
							estimate: {
								optimisticSeconds: 10,
								likelySeconds: 20,
								pessimisticSeconds: 30,
								confidence: "high",
								basis: "Measured",
								updatedAt: 90,
							},
							attemptHistory: [attempt],
							executor: { workerId: "worker", startedAt: 100 },
							startedAt: 80,
							progress: { at: 110, evidence: "Worker is editing" },
						},
					},
					{ content: "Dependent", status: "pending", schedule: { dependencies: ["Old title"] } },
					{ content: "Closed title", status: "completed", schedule: { finishedAt: 70 } },
				],
			},
		];
		const harness = createHarness(initial);
		const result = await harness.tool.execute("rename", {
			op: "schedule",
			updates: [
				{ task: "Old title", content: "New title" },
				{ task: "Closed title", content: "Closed title renamed" },
			],
		});

		expect(result.isError).not.toBe(true);
		expect(harness.phases()[0]?.tasks[0]).toMatchObject({
			content: "New title",
			status: "in_progress",
			schedule: {
				owner: "worker",
				resources: ["checkout"],
				attemptHistory: [attempt],
				executor: { workerId: "worker", startedAt: 100 },
				startedAt: 80,
				progress: { evidence: "Worker is editing" },
			},
		});
		expect(harness.phases()[0]?.tasks[1]?.schedule?.dependencies).toEqual(["New title"]);
		expect(harness.phases()[0]?.tasks[2]).toMatchObject({ content: "Closed title renamed", status: "completed" });

		const serialized = JSON.parse(JSON.stringify(result)) as { details: unknown; content: unknown };
		const restored = getLatestTodoPhasesFromEntries([
			{
				type: "custom",
				id: "base",
				parentId: null,
				timestamp: "2026-09-25T11:00:00.000Z",
				customType: "user_todo_edit",
				data: { phases: initial },
			},
			{
				type: "message",
				id: "rename",
				parentId: "base",
				timestamp: "2026-09-25T11:00:01.000Z",
				message: {
					role: "toolResult",
					toolName: "todo",
					content: serialized.content,
					details: serialized.details,
					isError: false,
				},
			},
		] as unknown as SessionEntry[]);
		expect(restored[0]?.tasks[0]?.content).toBe("New title");
		expect(restored[0]?.tasks[0]?.schedule?.owner).toBe("worker");
		expect(restored[0]?.tasks[0]?.schedule?.attemptHistory).toEqual([attempt]);
		expect(restored[0]?.tasks[1]?.schedule?.dependencies).toEqual(["New title"]);
		expect(restored[0]?.tasks[2]).toMatchObject({ content: "Closed title renamed", status: "completed" });
	});

	it("rejects blank and colliding rename targets atomically", async () => {
		for (const content of ["Already exists", "  "]) {
			const harness = createHarness([
				{
					name: "Work",
					tasks: [
						{ content: "Rename me", status: "pending" },
						{ content: "Already exists", status: "pending" },
					],
				},
			]);
			const before = structuredClone(harness.phases());
			const result = await harness.tool.execute(`bad-rename-${content}`, {
				op: "schedule",
				updates: [{ task: "Rename me", owner: "changed-owner", content }],
			});
			expect(result.isError).toBe(true);
			const message = result.content.find(part => part.type === "text");
			if (message?.type !== "text") throw new Error("Expected rename validation error");
			expect(message.text).toContain(content.trim() ? "another row already has that content" : "must be nonblank");
			expect(harness.phases()).toEqual(before);
		}
	});
});

it("persists and clears the row review artifact through schedule replay", async () => {
	const harness = createHarness(initialPlan);
	const result = await harness.tool.execute("publish-review", {
		op: "schedule",
		updates: [{ task: "Build parser", review: "user", reviewPage: " http://localhost/review/parser " }],
	});
	expect(result.isError).not.toBe(true);
	const restored = markdownToPhases(phasesToMarkdown(harness.phases()));
	expect(restored.phases[0].tasks[1].schedule?.reviewPage).toBe("http://localhost/review/parser");
	const clear = validateToolArguments(harness.tool, {
		type: "toolCall",
		id: "clear-review",
		name: "todo",
		arguments: {
			op: "schedule",
			updates: [{ task: "Build parser", review: null, reviewPage: null, reviewCard: null, speculativeOn: null }],
		},
	});
	await harness.tool.execute("clear-review", harness.tool.parameters.assert(clear));
	expect(harness.phases()[0].tasks[1].schedule?.review).toBeUndefined();
	expect(harness.phases()[0].tasks[1].schedule?.reviewPage).toBeUndefined();
	const replayed = markdownToPhases(phasesToMarkdown(harness.phases()));
	expect(replayed.phases[0].tasks[1].schedule?.review).toBeUndefined();
	expect(replayed.phases[0].tasks[1].schedule?.reviewPage).toBeUndefined();
});

it("clears an accepted proposal before reopening its unfinished implementation through validated calls", async () => {
	const phases = structuredClone(initialPlan);
	phases[0].tasks[2].status = "completed";
	const row = phases[0].tasks[1];
	row.status = "completed";
	row.schedule!.review = "accepted";
	const harness = createHarness(phases);
	const clear = validateToolArguments(harness.tool, {
		type: "toolCall",
		id: "clear-acceptance",
		name: "todo",
		arguments: { op: "schedule", updates: [{ task: "Build parser", review: null }] },
	});
	const cleared = await harness.tool.execute("clear-acceptance", harness.tool.parameters.assert(clear));
	expect(cleared.isError).not.toBe(true);
	const resume = await harness.tool.execute("resume-implementation", { op: "start", task: "Build parser" });
	expect(resume.isError).not.toBe(true);
	const restaff = await harness.tool.execute("restaff-implementation", {
		op: "schedule",
		updates: [{ task: "Build parser", owner: "implementation-owner" }],
	});
	expect(restaff.isError).not.toBe(true);
	expect(harness.phases()[0].tasks[1].status).toBe("in_progress");
	expect(harness.phases()[0].tasks[1].schedule?.review).toBeUndefined();
	const restored = markdownToPhases(phasesToMarkdown(harness.phases()));
	expect(restored.phases[0].tasks[1].status).toBe("in_progress");
});

it("accepts the live previewReason-only schedule but rejects a truly empty schedule", async () => {
	const harness = createHarness(initialPlan);
	const before = structuredClone(harness.phases());
	const input = {
		op: "schedule" as const,
		i: "Deferring preview refresh until push",
		previewReason: {
			task: "Land power and e2e repair patches, gates, push again",
			kind: "deferred" as const,
			detail:
				"Review checkout fast-forwards to the pushed SHA after CI PID 647137 and rack fix land; preview refresh happens once then.",
		},
		updates: [],
	};
	const result = await harness.tool.execute("live-preview-defer", input);
	expect(result.isError).not.toBe(true);
	expect(result.details?.op).toBe("schedule");
	expect(harness.phases()).toEqual(before);
	const empty = await harness.tool.execute("empty-schedule", { op: "schedule", updates: [] });
	expect(empty.isError).toBe(true);
	expect(empty.content).toContainEqual(
		expect.objectContaining({ text: expect.stringContaining("schedule requires a non-empty updates array") }),
	);
});

describe("live schedule admission", () => {
	it("replays the live restaffing call and heals stored self speculation once", async () => {
		const h = createHarness(selfEdgeReplay.phases as TodoPhase[]);
		const result = await h.tool.execute("live-self-edge-repro", selfEdgeReplay.arguments as never);
		expect(result.isError).not.toBe(true);
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		for (const name of [
			"Adaptive Facility: no crash, callout leaders clear of hall",
			"Land crash and Guide fixes on PR #109, push",
		]) {
			expect(text).toContain(name);
			expect(
				h
					.phases()
					.flatMap(p => p.tasks)
					.find(t => t.content === name)?.schedule?.speculativeOn,
			).toBeUndefined();
		}
		const row = h
			.phases()
			.flatMap(p => p.tasks)
			.find(t => t.content === "Facility 2D: too much empty space around site")!;
		expect(row.schedule?.speculativeOn).toBe("Land crash and Guide fixes on PR #109, push");
		expect(row.schedule?.owner).toBe("BuildingSquare-2");
		const restored = getLatestTodoPhasesFromEntries([
			{ type: "custom", customType: "user_todo_edit", data: { phases: selfEdgeReplay.phases } },
			{ type: "message", message: { role: "toolResult", toolName: "todo", ...JSON.parse(JSON.stringify(result)) } },
		] as SessionEntry[]);
		expect(restored).toEqual(h.phases());
		const next = await h.tool.execute("view-after-heal", { op: "view" });
		expect(
			next.content
				.filter(c => c.type === "text")
				.map(c => c.text)
				.join("\n"),
		).not.toContain("Healed stored self-edges");
	});
	it("reports legacy self-edge healing once after replaying an unrelated stored operation", async () => {
		const initial: TodoPhase[] = [
			{
				name: "W",
				tasks: [{ content: "A", status: "pending", schedule: { speculativeOn: "A" } }],
			},
		];
		const entries = [
			{ type: "custom", customType: "user_todo_edit", data: { phases: initial } },
			{
				type: "custom",
				customType: "user_todo_edit",
				data: {
					edit: {
						v: 1,
						kind: "op",
						at: Date.now(),
						op: "schedule",
						params: { op: "schedule", updates: [{ task: "A", owner: "Worker" }] },
					},
				},
			},
		] as SessionEntry[];
		const h = createHarness(getLatestTodoPhasesFromEntries(entries)!);
		const result = await h.tool.execute("heal-after-resume", {
			op: "schedule",
			updates: [{ task: "A", owner: "NewWorker" }],
		});
		expect(result.isError).not.toBe(true);
		expect(result.content).toContainEqual(
			expect.objectContaining({
				text: expect.stringContaining('Healed stored self-edges: "A"'),
			}),
		);
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				...JSON.parse(JSON.stringify(result)),
			},
		} as SessionEntry);
		const restored = getLatestTodoPhasesFromEntries(entries)!;
		expect(restored[0].tasks[0].schedule?.speculativeOn).toBeUndefined();
		expect(restored[0].tasks[0].schedule?.owner).toBe("NewWorker");
		const next = await createHarness(restored).tool.execute("already-healed", { op: "view" });
		expect(next.content).not.toContainEqual(
			expect.objectContaining({
				text: expect.stringContaining("Healed stored self-edges"),
			}),
		);
	});
	it("clears speculative targets with null or empty text", async () => {
		for (const clear of [null, ""]) {
			const h = createHarness([
				{
					name: "W",
					tasks: [
						{ content: "A", status: "pending", schedule: { dependencies: [], speculativeOn: "B" } },
						{ content: "B", status: "pending" },
					],
				},
			]);
			const r = await h.tool.execute("clear", { op: "schedule", updates: [{ task: "A", speculativeOn: clear }] });
			expect(r.isError).not.toBe(true);
			expect(h.phases()[0]!.tasks[0]!.schedule?.speculativeOn).toBeUndefined();
		}
	});
	it("rejects newly introduced self edges and two-row cycles atomically", async () => {
		for (const updates of [
			[{ task: "A", dependencies: ["A"] }],
			[{ task: "A", speculativeOn: "A" }],
			[
				{ task: "A", dependencies: ["B"] },
				{ task: "B", dependencies: ["A"] },
			],
		]) {
			const initial: TodoPhase[] = [
				{
					name: "W",
					tasks: [
						{ content: "A", status: "pending", schedule: { dependencies: [] } },
						{ content: "B", status: "pending", schedule: { dependencies: [] } },
					],
				},
			];
			const h = createHarness(initial);
			const r = await h.tool.execute("reject-edge", { op: "schedule", updates } as never);
			expect(r.isError).toBe(true);
			expect(h.phases()).toEqual(initial);
		}
	});
	it("renaming a stored cycle does not introduce a new cycle", async () => {
		const h = createHarness([
			{
				name: "W",
				tasks: [
					{ content: "A", status: "pending", schedule: { dependencies: ["B"] } },
					{ content: "B", status: "pending", schedule: { dependencies: ["A"] } },
				],
			},
		]);
		const r = await h.tool.execute("rename-old-cycle", {
			op: "schedule",
			updates: [{ task: "A", content: "Renamed A" }],
		});
		expect(r.isError).not.toBe(true);
		expect(h.phases()[0].tasks[1].schedule!.dependencies).toEqual(["Renamed A"]);
	});
	it("heals an unresolved stored target before renaming its source row", async () => {
		const initial: TodoPhase[] = [
			{ name: "W", tasks: [{ content: "A", status: "pending", schedule: { dependencies: ["Renamed A"] } }] },
		];
		const h = createHarness(initial);
		const r = await h.tool.execute("rename-self", {
			op: "schedule",
			updates: [{ task: "A", content: "Renamed A" }],
		});
		expect(r.isError).not.toBe(true);
		expect(h.phases()[0].tasks[0].content).toBe("Renamed A");
		expect(h.phases()[0].tasks[0].schedule?.dependencies).toEqual([]);
	});
	it("allows staffing when an unrelated stored cycle exists", async () => {
		const h = createHarness([
			{
				name: "W",
				tasks: [
					{ content: "A", status: "pending", schedule: { dependencies: ["B"] } },
					{ content: "B", status: "pending", schedule: { dependencies: ["A"] } },
					{ content: "Staff this", status: "pending", schedule: { dependencies: [] } },
				],
			},
		]);
		const r = await h.tool.execute("staff", { op: "schedule", updates: [{ task: "Staff this", owner: "worker" }] });
		expect(r.isError).not.toBe(true);
		expect(h.phases()[0]!.tasks[2]!.schedule?.owner).toBe("worker");
	});
	it("refuses speculative self/cycles atomically, accepting a real review target", async () => {
		const initial: TodoPhase[] = [
			{
				name: "delivery",
				tasks: [
					{ content: "Brag video inventory", status: "pending", schedule: { dependencies: [] } },
					{ content: "Finance manifest drift", status: "pending", schedule: { dependencies: [], review: "user" } },
				],
			},
		];
		const harness = createHarness(initial);
		for (const updates of [
			[{ task: "Brag video inventory", speculativeOn: "Brag video inventory" }],
			[
				{ task: "Brag video inventory", speculativeOn: "Finance manifest drift" },
				{ task: "Finance manifest drift", dependencies: ["Brag video inventory"] },
			],
		]) {
			const result = await harness.tool.execute("bad-speculation", { op: "schedule", updates });
			expect(result.isError).toBe(true);
			expect(harness.phases()).toEqual(initial);
		}
		expect(
			(
				await harness.tool.execute("valid-speculation", {
					op: "schedule",
					updates: [{ task: "Brag video inventory", speculativeOn: "Finance manifest drift" }],
				})
			).isError,
		).not.toBe(true);
	});

	it("refuses concurrent shared ownership but admits a sequential second Rack row", async () => {
		const harness = createHarness([
			{
				name: "layout",
				tasks: [
					{
						content: "Rack tiles fit 1568",
						status: "pending",
						schedule: { owner: "RackInputHeight-2", dependencies: [] },
					},
					{ content: "Rack conflict at 1462x900", status: "pending", schedule: { dependencies: [] } },
				],
			},
		]);
		const result = await harness.tool.execute("overlap", {
			op: "schedule",
			updates: [{ task: "Rack conflict at 1462x900", owner: "RackInputHeight-2" }],
		});
		expect(result.isError).toBe(true);
		expect(harness.phases()[0]!.tasks[1]!.schedule!.owner).toBeUndefined();
		const sequential = await harness.tool.execute("sequential", {
			op: "schedule",
			updates: [
				{ task: "Rack conflict at 1462x900", owner: "RackInputHeight-2", dependencies: ["Rack tiles fit 1568"] },
			],
		});
		expect(sequential.isError).not.toBe(true);
	});
});

it("rejects lead due-time changes atomically and persists reversible post-deadline triage", async () => {
	const h = createHarness(initialPlan);
	for (const change of [
		{ deadlineAt: Date.now() + 3600000 },
		{ deadlineRenegotiation: { deadlineAt: Date.now() + 3600000, reason: "I told the user" } },
	]) {
		const result = await h.tool.execute("lead-due", {
			op: "schedule",
			updates: [{ task: "Build parser", postDeadline: true, ...change }],
		} as never);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "The deadline belongs to the user. Todo operations cannot change the due time. Re-plan the work to fit the existing deadline.",
			},
		]);
		expect(h.phases()).toEqual(initialPlan);
	}
	for (const postDeadline of [true, false]) {
		const result = await h.tool.execute("triage", {
			op: "schedule",
			updates: [{ task: "Build parser", postDeadline, evidence: "Optional polish; parser contract retained" }],
		});
		expect(result.isError).not.toBe(true);
		expect(markdownToPhases(phasesToMarkdown(h.phases())).phases[0].tasks[1].schedule?.postDeadline).toBe(
			postDeadline,
		);
	}
});

it("cannot cut a prerequisite still needed by a must-have row", async () => {
	const input = structuredClone(initialPlan);
	input[0].tasks[2].schedule = { dependencies: ["Build parser"] };
	const h = createHarness(input);
	const rejected = await h.tool.execute("cut-prerequisite", {
		op: "schedule",
		updates: [{ task: "Build parser", postDeadline: true }],
	});
	expect(rejected.isError).toBe(true);
	expect(h.phases()).toEqual(input);
	const accepted = await h.tool.execute("cut-chain", {
		op: "schedule",
		updates: [
			{ task: "Build parser", postDeadline: true },
			{ task: "Add parser regression", postDeadline: true },
		],
	});
	expect(accepted.isError).not.toBe(true);
	expect(h.phases()[0].tasks[2].schedule?.postDeadline).toBe(true);
});

it("replays the DC dangling speculative edge and the exact failed schedule batch", async () => {
	const h = createHarness(danglingReplay.phases as TodoPhase[]);
	const result = await h.tool.execute("dc-dangling", danglingReplay.arguments as never);
	expect(result.isError).not.toBe(true);
	expect(result.content).toContainEqual(
		expect.objectContaining({ text: expect.stringContaining("Healed stored dangling edges:") }),
	);
	expect(result.content).toContainEqual(
		expect.objectContaining({
			text: expect.stringContaining('speculativeOn → "Land crash and Guide fixes on PR #109, push"'),
		}),
	);
	const restored = getLatestTodoPhasesFromEntries([
		{ type: "custom", customType: "user_todo_edit", data: { phases: danglingReplay.phases } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", ...JSON.parse(JSON.stringify(result)) } },
	] as SessionEntry[]);
	expect(restored).toEqual(h.phases());
	const next = await createHarness(restored!).tool.execute("after-resume", { op: "view" });
	expect(next.content).not.toContainEqual(
		expect.objectContaining({ text: expect.stringContaining("Healed stored dangling edges:") }),
	);
});

it("heals missing and dropped dependencies but preserves dependencies on done rows", async () => {
	const h = createHarness([
		{
			name: "DC",
			tasks: [
				{
					content: "Facility 2D: too much empty space around site",
					status: "pending",
					schedule: { dependencies: ["missing", "dropped", "done"], speculativeOn: "missing" },
				},
				{ content: "dropped", status: "abandoned" },
				{ content: "done", status: "completed", schedule: { finishedAt: Date.now() } },
			],
		},
	]);
	const result = await h.tool.execute("heal", {
		op: "schedule",
		updates: [{ task: "Facility 2D: too much empty space around site", owner: "Main" }],
	});
	expect(result.isError).not.toBe(true);
	expect(h.phases()[0].tasks[0].schedule?.dependencies).toEqual(["done"]);
	expect(h.phases()[0].tasks[0].schedule?.speculativeOn).toBeUndefined();
});

it("rejects new missing edges atomically with field-specific clearing calls", async () => {
	for (const edge of [{ dependencies: ["nonexistent"] }, { speculativeOn: "nonexistent" }]) {
		const h = createHarness([
			{
				name: "DC",
				tasks: [
					{
						content: "Facility 2D: too much empty space around site",
						status: "pending",
						schedule: { dependencies: [] },
					},
				],
			},
		]);
		const before = structuredClone(h.phases());
		const result = await h.tool.execute("new-missing", {
			op: "schedule",
			updates: [{ task: before[0].tasks[0].content, ...edge }],
		});
		expect(result.isError).toBe(true);
		expect(h.phases()).toEqual(before);
		expect(result.content).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining(`Invalid ${Object.keys(edge)[0]} target`) }),
		);
		if ("speculativeOn" in edge)
			expect(result.content).toContainEqual(
				expect.objectContaining({ text: expect.stringContaining('"speculativeOn":null') }),
			);
	}
});

it("dropping the live speculation target clears and reports both inbound edge fields", async () => {
	const target = "Land crash and Guide fixes on PR #109, push";
	const h = createHarness([
		{
			name: "DC",
			tasks: [
				{
					content: "Facility 2D: too much empty space around site",
					status: "pending",
					schedule: { dependencies: [target], speculativeOn: target },
				},
				{ content: target, status: "pending" },
			],
		},
	]);
	const result = await h.tool.execute("drop-live-target", { op: "drop", task: target });
	expect(result.isError).not.toBe(true);
	expect(h.phases()[0].tasks[0].schedule?.dependencies).toEqual([]);
	expect(h.phases()[0].tasks[0].schedule?.speculativeOn).toBeUndefined();
	for (const field of ["dependencies", "speculativeOn"])
		expect(result.content).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining(`${field} → "${target}"`) }),
		);
});

it("replays the 18:11 speculativeOn null clear, persists it and removes the display annotation", async () => {
	const task = "Facility 2D: too much empty space around site";
	const target = "Land crash and Guide fixes on PR #109, push";
	const initial: TodoPhase[] = [
		{
			name: "DC",
			tasks: [
				{ content: task, status: "in_progress", schedule: { dependencies: [], speculativeOn: target } },
				{ content: target, status: "pending" },
				{ content: "Push camera and label fixes to PR #111", status: "in_progress" },
			],
		},
	];
	const h = createHarness(initial);
	const result = await h.tool.execute("18:11", {
		op: "schedule",
		updates: [
			{
				task,
				speculativeOn: null,
				evidence: "speculation target row was dropped; Facility 2D proceeds on its own base",
			},
			{ task: "Push camera and label fixes to PR #111", owner: "PipelineWatch1291" },
		],
	});
	expect(result.isError).not.toBe(true);
	expect(h.phases()[0].tasks[0].schedule?.speculativeOn).toBeUndefined();
	const restored = getLatestTodoPhasesFromEntries([
		{ type: "custom", customType: "user_todo_edit", data: { phases: initial } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", ...JSON.parse(JSON.stringify(result)) } },
	] as SessionEntry[]);
	expect(restored?.[0].tasks[0].schedule?.speculativeOn).toBeUndefined();
	const view = await createHarness(restored!).tool.execute("view", { op: "view" });
	expect(JSON.stringify(view.content)).not.toContain("speculative on");
	const keep = createHarness(initial);
	await keep.tool.execute("evidence-only", { op: "schedule", updates: [{ task, evidence: "still working" }] });
	expect(keep.phases()[0].tasks[0].schedule?.speculativeOn).toBe(target);
});
