import { expect, test } from "bun:test";
import {
	forecastTodoPlan,
	formatPlanForecast,
	type TodoEstimate,
	type TodoScheduleInputTask,
} from "../src/tools/todo-schedule";

const now = Date.parse("2026-11-07T07:12:00Z");
const hour = 3_600_000;
function estimate(at: number, minutes = 40): TodoEstimate {
	return {
		optimisticSeconds: 20 * 60,
		likelySeconds: minutes * 60,
		pessimisticSeconds: 3600,
		confidence: "medium",
		basis: "DC replay",
		updatedAt: at,
	};
}
function replay(): TodoScheduleInputTask[] {
	return [
		...Array.from({ length: 7 }, (_, i): TodoScheduleInputTask => ({
			content: `DC open ${i}`,
			status: "in_progress",
			schedule: {
				owner: `worker-${i}`,
				resources: [],
				dependencies: [],
				startedAt: now,
				firstRequirementAt: now - (12 + (i * 5) / 6) * hour,
				estimate: estimate(now, 30 + (i * 20) / 6),
				cumulativeReestimateCount: 6 + (i * 10) / 6,
			},
		})),
		// Eight observed closures define seven intervals in ten hours: 0.7 rows/hour.
		...Array.from({ length: 8 }, (_, i): TodoScheduleInputTask => ({
			content: `DC closed ${i}`,
			status: "completed",
			schedule: { finishedAt: now - (10 - (i * 10) / 7) * hour },
		})),
	];
}

test("DC replay cannot turn seven aged, repeatedly revised rows into a two-hour deadline", () => {
	const plan = forecastTodoPlan([{ name: "DC", tasks: replay() }], { now, capacity: 3 });
	expect(plan.autoDeadlineForecast?.finish ?? plan.fixedPathP95Finish).toBeGreaterThanOrEqual(now + 10 * hour);
	expect(plan.autoDeadlineForecast?.rowsPerHour).toBeCloseTo(0.7);
	expect(plan.autoDeadlineForecast?.finish).toBeGreaterThanOrEqual(now + 10 * hour);
	expect(plan.autoDeadlineForecast?.winningBound).toBe("throughput");
	expect(formatPlanForecast(plan, now)).toContain("0.70 rows/h");
	expect(formatPlanForecast(plan, now)).toContain("Estimate-honesty defect: DC open 0");
	console.info(
		JSON.stringify({
			replay: "DC",
			pertHours: (plan.fixedPathP95Finish! - now) / hour,
			deadlineHours: (plan.autoDeadlineForecast!.finish! - now) / hour,
		}),
	);
});

test("insufficient closures preserve the analytical forecast; unresolved work never becomes a complete ETA", () => {
	const tasks = replay().slice(0, 9);
	const plan = forecastTodoPlan([{ name: "DC", tasks }], { now, capacity: 3 });
	expect(plan.autoDeadlineForecast?.rowsPerHour).toBeUndefined();
	expect(plan.autoDeadlineForecast?.finish).toBe(plan.fixedPathP95Finish);
	tasks.push({ content: "unknown", status: "pending" });
	expect(forecastTodoPlan([{ name: "DC", tasks }], { now }).autoDeadlineForecast?.finish).toBeUndefined();
});

test("calibration uses elapsed/first-budget sums and excludes old and future completions", () => {
	const tasks = [1, 4].map((hours, i): TodoScheduleInputTask => ({
		content: `closed ${i}`,
		status: "completed",
		schedule: {
			firstEstimate: estimate(now - hours * hour, i ? 60 : 30),
			finishedAt: now,
		},
	}));
	tasks.push({
		content: "old",
		status: "completed",
		schedule: { firstEstimate: estimate(now - 200 * hour), finishedAt: now - 100 * hour },
	});
	tasks.push({
		content: "future",
		status: "completed",
		schedule: { firstEstimate: estimate(now), finishedAt: now + hour },
	});
	const plan = forecastTodoPlan([{ name: "history", tasks: [...tasks, replay()[0]!] }], { now });
	expect(plan.calibration?.samples).toBe(2);
	expect(plan.calibration?.ratio).toBeCloseTo(5 / 1.5);
});

test("failed attempts impose a remaining floor and expose capped pessimism in the time-note formatter", () => {
	const row = replay()[0]!;
	row.schedule!.attemptHistory = [
		{
			attemptId: "fail",
			workerName: "worker",
			resolvedModel: "test",
			effort: "high",
			startedAt: now - 2 * hour,
			finishedAt: now,
			durationMs: 2 * hour,
			terminalStatus: "failed",
			deliverablePaths: [],
		},
	];
	const plan = forecastTodoPlan([{ name: "rework", tasks: [row] }], { now });
	expect(plan.autoDeadlineForecast?.rowFactors[0]?.remainingFloorSeconds).toBeGreaterThanOrEqual(7200);
	expect(plan.fixedPathP95Finish).toBeGreaterThanOrEqual(now + 2 * hour);
	expect(formatPlanForecast(plan, now)).toContain("does not exceed a failed attempt");
});

test("batch closures count distinct rows rather than timestamp groups, excluding duplicate identities", () => {
	const tasks = replay();
	for (const task of tasks.slice(8)) task.schedule!.finishedAt = now;
	tasks.push(tasks[8]!);
	const plan = forecastTodoPlan([{ name: "batch", tasks }], { now, capacity: 3 });
	expect(plan.autoDeadlineForecast?.closureSamples).toBe(8);
	expect(plan.autoDeadlineForecast?.rowsPerHour).toBeCloseTo(0.7);
});
