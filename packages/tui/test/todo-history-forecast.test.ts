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

test("calibration uses the median row ratio and excludes old and future completions", () => {
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
	expect(plan.calibration?.ratio).toBeCloseTo(3);
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

function smallPlan(at: number): TodoScheduleInputTask[] {
	return [
		["pipeline", 1200, 2100, 0.1],
		["heat", 1800, 3300, 0.1],
		["fold", 2700, 3600, 0.1],
		["screenshots", 2700, 3600, 0.5],
	].map(([content, likely, pessimistic, age]): TodoScheduleInputTask => {
		const first: TodoEstimate = {
			optimisticSeconds: Number(likely) / 2,
			likelySeconds: Number(likely),
			pessimisticSeconds: Number(pessimistic),
			updatedAt: at - Number(age) * hour,
			confidence: "medium",
			basis: "18:11 DC shape",
		};
		return {
			content: String(content),
			status: "pending",
			schedule: {
				firstEstimate: first,
				estimate: first,
				owner: String(content),
				resources: [],
				dependencies: content === "fold" ? ["pipeline"] : [],
			},
		};
	});
}

function longHistory(at: number): TodoScheduleInputTask[] {
	return Array.from({ length: 25 }, (_, i) => {
		const finishedAt = at - ((24 - i) / 1.05) * hour;
		return {
			content: `historical ${i}`,
			status: "completed",
			schedule: {
				finishedAt,
				...(i < 9
					? {
							firstEstimate: {
								...estimate(finishedAt - (20 + i * 4) * hour),
								optimisticSeconds: 3600,
								likelySeconds: ((20 + i * 4) * 3600) / 6.96,
								pessimisticSeconds: 12 * 3600,
							},
						}
					: {}),
			},
		};
	});
}

test("18:11 DC small split rows stay in the evening despite nine giant historical misses", () => {
	const at = Date.parse("2026-11-07T18:11:00+04:00");
	const plan = forecastTodoPlan([{ name: "DC", tasks: [...smallPlan(at), ...longHistory(at)] }], {
		now: at,
		capacity: 5,
	});
	expect(plan.autoDeadlineForecast!.finish!).toBeGreaterThanOrEqual(Date.parse("2026-11-07T19:15:00+04:00"));
	expect(plan.autoDeadlineForecast!.finish!).toBeLessThanOrEqual(Date.parse("2026-11-07T22:30:00+04:00"));
	expect(plan.autoDeadlineForecast!.rowsPerHour).toBeCloseTo(1.05);
	for (const row of plan.autoDeadlineForecast!.rowFactors) expect(row.calibrationRatio).toBeLessThanOrEqual(2);
	console.info(
		JSON.stringify({ replay: "DC 18:11", finish: new Date(plan.autoDeadlineForecast!.finish!).toISOString() }),
	);
});

test("splitting fresh work preserves the deadline even with slow historical row throughput", () => {
	const run = (split: boolean, history: boolean) =>
		forecastTodoPlan(
			[
				{
					name: "split",
					tasks: [
						...Array.from({ length: split ? 2 : 1 }, (_, i): TodoScheduleInputTask => {
							const seconds = split ? 1800 : 3600;
							const first = {
								...estimate(now),
								optimisticSeconds: seconds,
								likelySeconds: seconds,
								pessimisticSeconds: seconds,
							};
							return {
								content: `step ${i}`,
								status: "pending",
								schedule: {
									firstEstimate: first,
									estimate: first,
									owner: "worker",
									resources: [],
									dependencies: i ? ["step 0"] : [],
								},
							};
						}),
						...(history
							? longHistory(now).map(row => ({ ...row, schedule: { finishedAt: row.schedule.finishedAt } }))
							: []),
					],
				},
			],
			{ now, capacity: 5 },
		);
	expect(run(true, true).autoDeadlineForecast!.finish).toBe(run(false, true).autoDeadlineForecast!.finish);
	// With no history the declared one-hour path is unchanged, split or whole.
	expect(run(false, false).autoDeadlineForecast!.finish).toBe(now + hour);
	expect(run(true, false).autoDeadlineForecast!.finish).toBe(now + hour);
});

test("comparable small on-time closures outweigh giant misses and duplicate identities", () => {
	const small = Array.from({ length: 3 }, (_, i): TodoScheduleInputTask => ({
		content: `small ${i}`,
		status: "completed",
		schedule: {
			firstEstimate: {
				...estimate(now - 1200_000),
				optimisticSeconds: 600,
				likelySeconds: 1200,
				pessimisticSeconds: 2100,
			},
			finishedAt: now,
		},
	}));
	const tasks = [...smallPlan(now), ...longHistory(now), ...small];
	const run = (rows: TodoScheduleInputTask[]) =>
		forecastTodoPlan([{ name: "similar", tasks: rows }], { now, capacity: 5 });
	const plan = run(tasks);
	expect(plan.autoDeadlineForecast!.rowFactors[0]!.calibrationRatio).toBe(1);
	expect(plan.autoDeadlineForecast!.finish).toBe(run([...smallPlan(now), ...small]).autoDeadlineForecast!.finish);
	expect(run([...tasks, ...Array.from({ length: 10 }, () => tasks[4]!)]).autoDeadlineForecast!.finish).toBe(
		plan.autoDeadlineForecast!.finish,
	);
});

test("a row that exhausts its own pessimistic budget can escalate beyond the fresh prior", () => {
	const tasks = smallPlan(now);
	const row = tasks[0]!;
	row.schedule!.firstEstimate!.updatedAt = now - 12 * hour;
	row.schedule!.estimate = { ...row.schedule!.firstEstimate!, updatedAt: now };
	row.schedule!.cumulativeReestimateCount = 6;
	const plan = forecastTodoPlan([{ name: "slipped", tasks: [...tasks, ...longHistory(now)] }], { now, capacity: 5 });
	expect(plan.autoDeadlineForecast!.rowFactors[0]!.calibrationRatio).toBeGreaterThan(2);
	expect(plan.autoDeadlineForecast!.finish!).toBeGreaterThanOrEqual(plan.autoDeadlineForecast!.throughputFinish!);
});
