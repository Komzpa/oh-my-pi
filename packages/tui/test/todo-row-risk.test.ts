import { expect, test } from "bun:test";
import {
	forecastTodoPlan,
	parseRowRiskFile,
	drawAttemptChain,
	riskRandom,
	type RowRiskOptions,
	type RowRiskComponent,
	type TodoScheduleInput,
} from "../src/tools/todo-schedule";
const now = Date.parse("2026-11-05T08:00:00Z");
const table = (v: number) => ({ q: [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95], v: Array(7).fill(v) });
const component = (v: number, p = [0, 0, 0]): RowRiskComponent => ({
	n: 20,
	n_eff: 20,
	p_redo: p,
	attempt_ratio: table(v),
	gap_ratio: table(0),
});
const risk = (): RowRiskOptions => ({
	components: {
		version: 1,
		generatedAt: new Date(now).toISOString(),
		window: { start: new Date(now - 86400_000).toISOString(), end: new Date(now).toISOString() },
		source: { runs: "runs", labels: "labels" },
		unit: "ratio",
		components: {
			"*": { "*": component(1) },
			coder: { "*": component(1), "a/m": component(1), "b/m": component(3) },
		},
	},
	pools: {
		coder: [
			{ model: "a/m", weight: 1 },
			{ model: "b/m", weight: 3 },
		],
	},
	seed: 17,
});
const phases = (): TodoScheduleInput => [
	{
		name: "DC",
		tasks: [
			{
				content: "Adaptive layout: heat pipes reach heat plant",
				status: "pending",
				schedule: {
					agentProfile: "coder",
					dependencies: [],
					resources: [],
					owner: "coder",
					estimate: {
						optimisticSeconds: 100,
						likelySeconds: 100,
						pessimisticSeconds: 100,
						confidence: "high",
						basis: "fixture",
						updatedAt: now,
					},
				},
			},
		],
	},
];
test("pool mixture has 250 second expectation and changes with live weights", () => {
	const r = risk();
	const rng = riskRandom(17);
	let sum = 0;
	for (let i = 0; i < 20000; i++) sum += drawAttemptChain(r, "coder", 100, 1, 0, rng);
	expect(Math.abs(sum / 20000 - 250)).toBeLessThan(2);
	const first = forecastTodoPlan(phases(), { now, deadlineAt: now + 200000, risk: r });
	expect(first.risk!.onTimeProbability).toBeCloseTo(0.25, 1);
	expect(first.deadlineStatus).toBe("on-track");
	r.pools.coder = [{ model: "a/m", weight: 1 }];
	const next = forecastTodoPlan(phases(), { now, deadlineAt: now + 200000, risk: r });
	expect(next.risk!.onTimeProbability).toBe(1);
	expect(next.risk!.p80Finish).toBe(now + 100000);
	expect(forecastTodoPlan(phases(), { now, deadlineAt: now + 200000, risk: r }).risk).toEqual(next.risk);
});
test("attempt 3 uses its redo probability and running elapsed is conditioned", () => {
	const r = risk();
	r.components.components.coder = { "*": component(1, [0, 0, 0.8]) };
	r.pools.coder = [];
	const random1 = riskRandom(10),
		random3 = riskRandom(10);
	let one = 0,
		three = 0;
	for (let i = 0; i < 2000; i++) {
		one += drawAttemptChain(r, "coder", 100, 1, 0, random1);
		three += drawAttemptChain(r, "coder", 100, 3, 0, random3);
	}
	expect(three).toBeGreaterThan(one * 3);
	expect(
		drawAttemptChain(
			{ ...r, components: { ...r.components, components: { "*": { "*": component(1) } } } },
			"task",
			100,
			1,
			40,
			riskRandom(1),
		),
	).toBe(60);
});
test("Monte Carlo reuses resource and dependency ordering and excludes done rows", () => {
	const base = phases()[0].tasks[0];
	const plan: TodoScheduleInput = [
		{
			name: "p",
			tasks: [
				base,
				{ ...base, content: "audit", schedule: { ...base.schedule, dependencies: [base.content] } },
				{ content: "done", status: "completed" },
			],
		},
	];
	const r = risk();
	r.pools.coder = [{ model: "a/m", weight: 1 }];
	const result = forecastTodoPlan(plan, { now, risk: r });
	expect(result.risk!.p80Finish).toBe(now + 200000);
	expect(result.risk!.criticalRows[0].content).toBe("audit");
	expect(result.risk!.criticalRows[0].lastFinishProbability).toBe(1);
});
test("missing model preserves numerical PERT and malformed or stale files reject", () => {
	const old = forecastTodoPlan(phases(), { now });
	expect(old.expectedResourceFinish).toBe(now + 100000);
	expect(old.risk).toBeUndefined();
	expect(old.riskModelUnavailable).toBe(true);
	const file = risk().components;
	expect(parseRowRiskFile(file, now)).toEqual(file);
	expect(parseRowRiskFile(file, now + 15 * 86400_000)).toBeUndefined();
	file.components["*"]["*"].p_redo = [2, 0, 0];
	expect(parseRowRiskFile(file, now)).toBeUndefined();
});

test("running third attempt retains first dispatch scale after reestimate", () => {
	const r = risk();
	r.components.components.coder = { "*": component(1, [0, 0, 0.8]) };
	r.pools.coder = [];
	const first = phases();
	first[0].tasks[0].status = "in_progress";
	first[0].tasks[0].schedule!.startedAt = now - 40000;
	first[0].tasks[0].schedule!.executor = { workerId: "current", startedAt: now - 40000 };
	first[0].tasks[0].schedule!.estimate!.updatedAt = now - 40000;
	first[0].tasks[0].schedule!.riskEstimateMeanSeconds = 100;
	first[0].tasks[0].schedule!.estimate!.likelySeconds = 500;
	first[0].tasks[0].schedule!.estimate!.pessimisticSeconds = 500;
	const attempt = {
		attemptId: "old",
		workerName: "coder",
		resolvedModel: "a/m",
		effort: "high",
		startedAt: now - 300000,
		finishedAt: now - 200000,
		durationMs: 100000,
		terminalStatus: "failed" as const,
		deliverablePaths: [],
	};
	const initial = forecastTodoPlan(first, { now, risk: r });
	expect(initial.risk!.p80Finish).toBe(now + 60000);
	const third = structuredClone(first);
	third[0].tasks[0].schedule!.attemptHistory = [attempt, { ...attempt, attemptId: "second" }];
	const retried = forecastTodoPlan(third, { now, risk: r });
	expect(retried.risk!.p80Finish).toBeGreaterThan(initial.risk!.p80Finish);
	expect(retried.risk!.criticalRows[0].redoRisk).toBe(0.8);
});

test("unchanged plan reuses its forecast minute and refreshes when time advances", () => {
	const r = risk();
	r.pools.coder = [{ model: "a/m", weight: 1 }];
	const first = forecastTodoPlan(phases(), { now, risk: r }).risk!;
	const keypress = forecastTodoPlan(phases(), { now: now + 1000, risk: r }).risk!;
	expect(keypress).toEqual(first);
	const later = forecastTodoPlan(phases(), { now: now + 60000, risk: r }).risk!;
	expect(later.p80Finish).toBe(first.p80Finish + 60000);
});

test("row closure ratios cannot inflate worker-attempt diagnostics", () => {
	const plan = phases().map(phase => ({ ...phase, tasks: [...phase.tasks] }));
	const row = plan[0]!.tasks[0]!;
	row.schedule!.firstEstimate = { ...row.schedule!.estimate! };
	row.schedule!.riskEstimateMeanSeconds = 100;
	const accepted = structuredClone(row);
	accepted.content = "accepted calibration row";
	accepted.status = "completed";
	accepted.schedule!.firstEstimate!.updatedAt = now - 300_000;
	accepted.schedule!.startedAt = now - 300_000;
	accepted.schedule!.finishedAt = now;
	plan[0]!.tasks.push(accepted);
	const options = risk();
	options.pools.coder = [{ model: "a/m", weight: 1 }];
	const calibrated = forecastTodoPlan(plan, { now, risk: options });
	expect(calibrated.calibration).toEqual({ ratio: 1, samples: 0 });
	expect(calibrated.risk!.p50Finish).toBe(now + 100_000);
});

test("attempt diagnostic consumes only current execution after the residual revision", () => {
	const options = risk();
	options.pools.coder = [{ model: "a/m", weight: 1 }];
	const input = phases();
	const row = input[0]!.tasks[0]!;
	row.status = "in_progress";
	row.schedule!.startedAt = now - 3_600_000;
	row.schedule!.estimate!.updatedAt = now - 3_600_000;
	const predict = () => forecastTodoPlan(input, { now, risk: options }).risk!.p50Finish;
	// A focused row with no worker retains its effort, even after an hour idle.
	expect(predict()).toBe(now + 100_000);
	row.schedule!.executor = { workerId: "retry", startedAt: now - 40_000 };
	expect(predict()).toBe(now + 60_000);
	row.status = "pending";
	expect(predict()).toBe(now + 60_000);
	row.schedule!.estimate!.updatedAt = now;
	row.schedule!.firstEstimate = { ...row.schedule!.estimate!, updatedAt: now - 3_600_000 };
	expect(predict()).toBe(now + 100_000);
	row.schedule!.executor.finishedAt = now;
	row.schedule!.executor.outcome = "completed";
	expect(predict()).toBe(now + 100_000);
	const unavailable = forecastTodoPlan(input, {
		now,
		risk: options,
		executableCapacity: 0,
		deadlineAt: now + 200_000,
	});
	expect(unavailable.risk).toBeUndefined();
	expect(unavailable.deadlineStatus).toBe("unknown");
});

test("smaller worker-attempt diagnostic cannot hide a current whole-plan miss", () => {
	const options = risk();
	options.pools.coder = [{ model: "a/m", weight: 1 }];
	const input = phases();
	const row = input[0]!.tasks[0]!;
	row.schedule!.riskEstimateMeanSeconds = 10;
	const forecast = forecastTodoPlan(input, { now, risk: options, deadlineAt: now + 50_000 });
	expect(forecast.risk!.p80Finish).toBe(now + 10_000);
	expect(forecast.risk!.onTimeProbability).toBe(1);
	expect(forecast.rawP50Finish).toBe(now + 100_000);
	expect(forecast.deadlineStatus).toBe("will-miss");
});
