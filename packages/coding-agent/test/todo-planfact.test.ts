import { afterEach, expect, test, spyOn } from "bun:test";
import { applyOpsToPhases, markdownToPhases, phasesToMarkdown } from "../src/tools/todo";
import { forecastTodoPlan, formatTaskForecastDisplay } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { applyTodoExecutorObservation } from "../src/tools/todo-executor";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

afterEach(() => {
	jestClock?.mockRestore();
});
let jestClock: { mockRestore(): void } | undefined;
const start = 1_800_000_000_000;
const estimate = (seconds: number) => ({
	optimisticSeconds: seconds,
	likelySeconds: seconds,
	pessimisticSeconds: seconds,
	confidence: "medium" as const,
	basis: "measured remaining acceptance work",
});

test("owner changes and reopening retain first promise, clock and revision history", () => {
	jestClock = spyOn(Date, "now").mockReturnValue(start);
	let phases: TodoPhase[] = [{ name: "Ship", tasks: [{ content: "Deliver", status: "pending" }] }];
	phases = applyOpsToPhases(phases, [
		{
			op: "schedule",
			updates: [{ task: "Deliver", owner: "A", dependencies: [], resources: [], estimate: estimate(60) }],
		},
		{ op: "start", task: "Deliver" },
	]).phases;
	for (let index = 1; index <= 3; index++) {
		jestClock = spyOn(Date, "now").mockReturnValue(start + index * 60_000);
		const result = applyOpsToPhases(phases, [
			{ op: "schedule", updates: [{ task: "Deliver", owner: `B${index}`, estimate: estimate(60 + index) }] },
		]);
		expect(result.errors).toEqual([]);
		phases = result.phases;
	}
	const schedule = phases[0]!.tasks[0]!.schedule!;
	expect(schedule.firstEstimate?.likelySeconds).toBe(60);
	expect(schedule.firstEstimate?.updatedAt).toBe(start);
	expect(schedule.startedAt).toBe(start);
	expect(schedule.reestimateCount).toBe(0);
	expect(schedule.cumulativeReestimateCount).toBe(3);
	expect(markdownToPhases(phasesToMarkdown(phases)).phases[0]!.tasks[0]!.schedule).toEqual(schedule);
	expect(
		formatTaskForecastDisplay(forecastTodoPlan(phases, { now: start + 180_000 }).rows[0]!, start + 180_000),
	).toContain("reestimated 3×");
	const progress = applyOpsToPhases(phases, [
		{ op: "schedule", updates: [{ task: "Deliver", evidence: "still checking" }] },
	]);
	expect(progress.phases[0]!.tasks[0]!.schedule?.cumulativeReestimateCount).toBe(3);
	expect(progress.phases[0]!.tasks[0]!.schedule?.firstEstimate).toEqual(schedule.firstEstimate);
});

test("completed session rows calibrate remaining work with bounded ratios and retained elapsed", () => {
	const first = { ...estimate(60), updatedAt: start };
	const phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [
				{
					content: "Accepted",
					status: "completed",
					schedule: { firstEstimate: first, estimate: first, startedAt: start, finishedAt: start + 600_000 },
				},
				{
					content: "Open",
					status: "in_progress",
					schedule: {
						firstEstimate: first,
						startedAt: start,
						estimate: { ...estimate(30), updatedAt: start + 300_000 },
						dependencies: [],
						owner: "worker",
						resources: [],
						reestimateCount: 3,
					},
				},
			],
		},
	];
	const forecast = forecastTodoPlan(phases, { now: start + 600_000 });
	expect(forecast.calibration).toEqual({ ratio: 10, samples: 1 });
	expect(forecast.rows.find(row => row.content === "Open")?.expectedResourceFinish).toBe(start + 800_000);
	const later = forecastTodoPlan(phases, { now: start + 660_000 });
	expect(later.expectedResourceFinish).toBeGreaterThan(forecast.expectedResourceFinish!);
	phases[0]!.tasks[0]!.schedule!.finishedAt = start + 60_000_000;
	expect(forecastTodoPlan(phases, { now: start }).calibration?.ratio).toBe(1);
	expect(forecastTodoPlan(phases, { now: start + 60_000_000 }).calibration?.ratio).toBe(20);
	delete phases[0]!.tasks[0]!.schedule!.firstEstimate;
	expect(forecastTodoPlan(phases, { now: start }).calibration).toEqual({ ratio: 1, samples: 0 });
});

test("successor launch retains cumulative churn and first clock while refreshing its owner budget", () => {
	const first = { ...estimate(60), updatedAt: start };
	const phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [
				{
					content: "Deliver",
					status: "in_progress",
					schedule: {
						owner: "A",
						reestimateCount: 5,
						firstEstimate: first,
						estimate: first,
						startedAt: start,
					},
				},
			],
		},
	];
	const updated = applyTodoExecutorObservation(phases, {
		row: "Deliver",
		workerId: "B",
		startedAt: start + 600_000,
		runningWorkerIds: new Set(),
	})!;
	expect(updated[0]!.tasks[0]!.schedule).toMatchObject({
		owner: "B",
		reestimateCount: 0,
		cumulativeReestimateCount: 5,
		firstEstimate: first,
		startedAt: start,
	});
	const revised = applyOpsToPhases(updated, [
		{ op: "schedule", updates: [{ task: "Deliver", estimate: estimate(30) }] },
	]).phases;
	expect(revised[0]!.tasks[0]!.schedule).toMatchObject({ reestimateCount: 1, cumulativeReestimateCount: 6 });
});
