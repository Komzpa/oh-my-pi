import { expect, test } from "bun:test";
import {
	calibrateTodoPlan,
	forecastTodoPlan,
	formatPlanForecastDisplay,
	formatPlanForecast,
	formatTaskForecast,
	formatTaskForecastDisplay,
	renderTodoPlanDisplay,
	TODO_PREDICTION_VERSION,
	type TodoPlanPrediction,
	type TodoScheduleInput,
	type TodoScheduleInputTask,
} from "../src/tools/todo-schedule";
import snapshots from "./fixtures/dc-forecast-snapshots.json";

const hour = 3_600_000;
const now = Date.parse("2026-11-07T14:11:47.215Z");
function plan(seconds = 3600, owner = "one"): { name: string; tasks: TodoScheduleInputTask[] }[] {
	return [
		{
			name: "work",
			tasks: [
				{
					content: "a",
					status: "pending",
					schedule: {
						owner,
						dependencies: [],
						resources: [],
						estimate: {
							optimisticSeconds: seconds,
							likelySeconds: seconds,
							pessimisticSeconds: seconds,
							updatedAt: now,
							confidence: "medium",
							basis: "declared residual",
						},
					},
				},
			],
		},
	];
}
function history(): TodoPlanPrediction[] {
	return Array.from({ length: 25 }, (_, i) => ({
		sessionId: `s${i % 5}`,
		originAt: now - (100 - i) * hour,
		rawP50Finish: now - (99 - i) * hour,
		predictionVersion: TODO_PREDICTION_VERSION,
		membershipFingerprint: `set${i}`,
		actualFinish: now - (97 - i) * hour,
		observedAt: now - (96 - i) * hour,
		upperFinish: now - (96 - i) * hour,
	}));
}

test("saved DC censored sets no longer select the next-day throughput/row-multiplier controls", () => {
	for (const key of ["11:12", "18:11"] as const) {
		const s = snapshots[key];
		const t = Date.parse(s.timestamp);
		const f = forecastTodoPlan(s.phases as TodoScheduleInput, { now: t, capacity: 32 });
		expect(f.rawP50Finish).toBeGreaterThanOrEqual(t);
		expect(f.rawP80Finish).toBeGreaterThanOrEqual(f.rawP50Finish!);
		expect(f.autoDeadlineForecast!.finish).toBe(f.rawP80Finish);
		expect(f.autoDeadlineForecast!.finish!).toBeLessThan(
			Date.parse(key === "11:12" ? "2026-11-08T12:27:22+04:00" : "2026-11-08T01:48:33+04:00"),
		);
		expect(f.calibrationStatus).toBe("insufficient");
		expect(f.calibrationOrigins).toBe(0);
		const withoutHistory = s.phases.map(p => ({
			...p,
			tasks: p.tasks.filter(r => !["completed", "abandoned"].includes(r.status)),
		}));
		expect(forecastTodoPlan(withoutHistory as TodoScheduleInput, { now: t, capacity: 32 }).rawP50Finish).toBe(
			f.rawP50Finish,
		);
	}
});

test("equal serial work splitting preserves raw quantiles despite slow row throughput", () => {
	const whole = plan();
	const split = plan(1800);
	split[0]!.tasks.push({ ...structuredClone(split[0]!.tasks[0]!), content: "b" });
	expect(forecastTodoPlan(split, { now }).rawP80Finish).toBe(forecastTodoPlan(whole, { now }).rawP80Finish);
	split[0]!.tasks[1]!.schedule!.owner = "two";
	expect(forecastTodoPlan(split, { now, capacity: 2 }).rawP50Finish).toBe(now + hour / 2);
	expect(forecastTodoPlan(split, { now, capacity: 1 }).rawP50Finish).toBe(now + hour);
	split[0]!.tasks.forEach(r => {
		r.schedule!.resources = ["lock"];
	});
	expect(forecastTodoPlan(split, { now, capacity: 2 }).rawP50Finish).toBe(now + hour);
	split[0]!.tasks[0]!.schedule!.dependencies = ["b"];
	split[0]!.tasks[1]!.schedule!.dependencies = ["a"];
	expect(forecastTodoPlan(split, { now }).rawP50Finish).toBeUndefined();
});

test("whole-plan additive errors leave point raw and use as-of inverse-session quantiles", () => {
	const rows = plan();
	const raw = forecastTodoPlan(rows, { now });
	const h = history();
	const f = forecastTodoPlan(rows, { now, history: h });
	expect(f.rawP50Finish).toBe(raw.rawP50Finish);
	expect(f.calibratedUpperFinish).toBe(raw.rawP50Finish! + 2 * hour);
	expect(f.calibrationStatus).toBe("sufficient");
	expect(f.calibrationOrigins).toBe(25);
	expect(f.calibrationSessions).toBe(5);
	expect(f.calibrationCoverage).toEqual({ covered: 25, total: 25, sessions: 5 });
	// One chatty session cannot outweigh four independent sessions.
	const chatty = Array.from({ length: 80 }, (_, i) => ({
		...h[0]!,
		originAt: now - (500 + i) * hour,
		actualFinish: now - (500 + i) * hour + 21 * hour,
		rawP50Finish: now - (500 + i) * hour + hour,
	}));
	expect(calibrateTodoPlan([...h, ...chatty], now, raw.rawP50Finish).calibratedUpperFinish).toBe(
		raw.rawP50Finish! + 2 * hour,
	);
	expect(calibrateTodoPlan(h.slice(0, 19), now, raw.rawP50Finish).calibrationStatus).toBe("insufficient");
	expect(
		calibrateTodoPlan(
			h.filter(r => r.sessionId !== "s4"),
			now,
			raw.rawP50Finish,
		).calibrationStatus,
	).toBe("insufficient");
});

test("future completions, revisions and attempt outcomes cannot alter an earlier prediction", () => {
	const h = history();
	const future = { ...h[0]!, originAt: now + hour, observedAt: now + 3 * hour };
	const f = forecastTodoPlan(plan(), { now, history: [...h, future] });
	future.actualFinish = now + 999 * hour;
	future.rawP50Finish = now + 123 * hour;
	future.membershipFingerprint = "future revised audit and attempt";
	expect(JSON.stringify(forecastTodoPlan(plan(), { now, history: [...h, future] }))).toBe(JSON.stringify(f));
	const delayed = h.map(r => ({ ...r, observedAt: now + hour }));
	expect(forecastTodoPlan(plan(), { now, history: delayed }).calibrationOrigins).toBe(0);
	expect(
		calibrateTodoPlan(
			h.map(r => ({ ...r, predictionVersion: "old-model" })),
			now,
		).calibrationOrigins,
	).toBe(0);
});

test("observed executable slots bound the whole-plan ETA independently of configured unlimited", () => {
	const input = plan(600);
	const second = structuredClone(input[0]!.tasks[0]!);
	second.content = "b";
	second.schedule!.owner = "two";
	input[0]!.tasks.push(second);
	const predict = (capacity: number, executableCapacity?: number) =>
		forecastTodoPlan(input, { now, capacity, executableCapacity, deadlineAt: now + 900_000 });
	const parallel = predict(32, 2);
	const serial = predict(32, 1);
	expect(parallel.rawP50Finish).toBe(now + 600_000);
	expect(parallel.deadlineStatus).toBe("on-track");
	expect(serial.rawP50Finish).toBe(now + 1_200_000);
	expect(serial.deadlineStatus).toBe("will-miss");
	expect(predict(0, 1).rawP50Finish).toBe(serial.rawP50Finish);
	expect(predict(1, 2).rawP50Finish).toBe(serial.rawP50Finish);
	const unavailable = predict(0, 0);
	expect(unavailable.capacityAssumptions!.effective).toBe(0);
	expect(unavailable.rawP50Finish).toBeUndefined();
	expect(unavailable.rawP80Finish).toBeUndefined();
	expect(unavailable.autoDeadlineForecast!.finish).toBeUndefined();
	expect(unavailable.resourceFinish).toBeUndefined();
	expect(unavailable.expectedResourceFinish).toBeUndefined();
	expect(unavailable.earliestFinish).toBeUndefined();
	expect(unavailable.deadlineStatus).toBe("unknown");
	expect(unavailable.unknownGates).toContain("Executable worker capacity is zero");
	const conditional = predict(0);
	expect(conditional.rawP50Finish).toBe(parallel.rawP50Finish);
	expect(conditional.resourceAssumptions!.some(value => value.includes("conditional"))).toBe(true);
});

test("raw residuals exclude downtime, old attempts and row focus while tracking current execution", () => {
	const input = plan(600);
	const row = input[0]!.tasks[0]!;
	row.status = "in_progress";
	row.schedule!.startedAt = now - hour;
	row.schedule!.estimate!.updatedAt = now - hour;
	const predict = () => forecastTodoPlan(input, { now, capacity: 1, executableCapacity: 1 });
	expect(predict().rawP50Finish).toBe(now + 600_000);
	expect(predict().rows[0]!.overdue).toBe(true);
	row.schedule!.executor = { workerId: "retry", startedAt: now };
	expect(predict().rawP50Finish).toBe(now + 600_000);
	row.schedule!.executor.startedAt = now - 120_000;
	expect(predict().rawP50Finish).toBe(now + 480_000);
	// A residual revision starts a new effort clock within this same worker attempt.
	row.schedule!.estimate!.updatedAt = now - 60_000;
	row.schedule!.estimateRevision = 2;
	expect(predict().rawP50Finish).toBe(now + 540_000);
	row.schedule!.executor.finishedAt = now - 30_000;
	row.schedule!.executor.outcome = "failed";
	expect(predict().rawP50Finish).toBe(now + 600_000);
	row.status = "pending";
	delete row.schedule!.executor;
	const closed = structuredClone(row);
	closed.content = "historical";
	closed.status = "completed";
	closed.schedule!.finishedAt = now - 30_000;
	input[0]!.tasks.push(closed);
	const result = predict();
	expect(result.rawP50Finish).toBe(now + 600_000);
	expect(result.rawP80Finish).toBe(now + 600_000);
	expect(row.schedule!.startedAt).toBe(now - hour);
});

test("current retry summary and deadline use residual work while row overdue debt stays historical", () => {
	const input = plan(600);
	const row = input[0]!.tasks[0]!;
	row.status = "in_progress";
	row.schedule!.startedAt = now - hour;
	row.schedule!.estimate!.updatedAt = now - hour;
	row.schedule!.executor = { workerId: "retry", startedAt: now };
	const forecast = forecastTodoPlan(input, { now, deadlineAt: now + 300_000, executableCapacity: 1 });
	const clock = new Date(now + 600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	expect(forecast.rawP50Finish).toBe(now + 600_000);
	expect(forecast.resourceFinish).toBeLessThan(now);
	expect(forecast.rows[0]!.overdue).toBe(true);
	expect(forecast.deadlineStatus).toBe("will-miss");
	expect(formatPlanForecastDisplay(forecast, now)).toStartWith(`ETA ${clock}`);
	expect(formatPlanForecastDisplay(forecast, now)).toContain("by 5m");
	const rendered = renderTodoPlanDisplay(
		input,
		{ workers: [], owners: new Map() },
		{ now, forecast, paint: (_tone, text) => text },
	);
	expect(rendered.lines[0]).toContain(`ETA ${clock}`);
	const conditional = forecastTodoPlan(input, { now, deadlineAt: now + 300_000 });
	expect(formatPlanForecastDisplay(conditional, now)).toContain("conditional on worker capacity");
	expect(formatPlanForecast(conditional, now)).toContain("Conditional on worker capacity");
});

test("pending parallel workers consume actual execution but unstarted pending rows retain their residual", () => {
	const input = plan(600);
	const row = input[0]!.tasks[0]!;
	row.schedule!.estimate!.updatedAt = now - hour;
	row.schedule!.startedAt = now - hour;
	const predict = () => forecastTodoPlan(input, { now, executableCapacity: 2 });
	expect(predict().rawP50Finish).toBe(now + 600_000);
	row.schedule!.executor = { workerId: "parallel", startedAt: now - 120_000 };
	expect(predict().rawP50Finish).toBe(now + 480_000);
	const focused = structuredClone(row);
	focused.content = "focused";
	focused.status = "in_progress";
	focused.schedule!.owner = "other";
	focused.schedule!.executor!.workerId = "other";
	input[0]!.tasks.push(focused);
	expect(predict().rawP50Finish).toBe(now + 480_000);
});

test("unfinished executor beyond PERT support requires a revised residual instead of finish-now", () => {
	const input = plan(600);
	const row = input[0]!.tasks[0]!;
	row.status = "in_progress";
	row.schedule!.startedAt = now - hour;
	row.schedule!.estimate!.updatedAt = now - hour;
	row.schedule!.executor = { workerId: "overrun", startedAt: now - 660_000 };
	const original = structuredClone(row.schedule!.estimate);
	const options = { now, executableCapacity: 1, deadlineAt: now + 300_000 };
	const forecast = forecastTodoPlan(input, options);
	expect(forecast.rawP50Finish).toBeUndefined();
	expect(forecast.autoDeadlineForecast!.finish).toBeUndefined();
	expect(forecast.deadlineStatus).toBe("unknown");
	expect(formatPlanForecastDisplay(forecast, now)).toContain("revise remaining work");
	expect(formatPlanForecast(forecast, now)).toContain("Current ETA unknown");
	expect(row.schedule!.estimate).toEqual(original);
	row.schedule!.estimate!.updatedAt = now;
	row.schedule!.estimateRevision = 2;
	expect(forecastTodoPlan(input, options).rawP50Finish).toBe(now + 600_000);
});

test("rendered retry clocks separate first-start age, recorded execution, unknown gaps and residual estimate", () => {
	const input = plan(600);
	const row = input[0]!.tasks[0]!;
	row.status = "in_progress";
	row.schedule!.startedAt = now - hour;
	row.schedule!.estimate!.updatedAt = now;
	row.schedule!.firstEstimate = { ...row.schedule!.estimate!, likelySeconds: 900, updatedAt: now - hour };
	row.schedule!.cumulativeReestimateCount = 3;
	const previous = {
		attemptId: "previous",
		workerName: "previous",
		resolvedModel: "fixture",
		effort: "high",
		startedAt: now - hour,
		finishedAt: now - 50 * 60_000,
		durationMs: 600_000,
		terminalStatus: "failed" as const,
		deliverablePaths: [],
	};
	row.schedule!.attemptHistory = [previous];
	row.schedule!.executor = { workerId: "retry", startedAt: now - 120_000 };
	const queued = structuredClone(row);
	queued.content = "queued neighbor";
	queued.status = "pending";
	delete queued.schedule!.startedAt;
	delete queued.schedule!.executor;
	delete queued.schedule!.attemptHistory;
	queued.schedule!.firstRequirementAt = now - 30 * 60_000;
	input[0]!.tasks.push(queued);
	// A worker may start while its row is pending and has never had TODO focus.
	delete row.schedule!.startedAt;
	const forecast = forecastTodoPlan(input, { now, executableCapacity: 1 });
	const [retryForecast, queuedForecast] = forecast.rows;
	for (const render of [formatTaskForecast, formatTaskForecastDisplay]) {
		const text = render(retryForecast!, now);
		expect(text).toContain("age 60m");
		expect(text).toContain("recorded active 12m");
		expect(text).toContain("queue/downtime unknown");
		expect(text).toContain("remaining estimate 10m");
		expect(render(queuedForecast!, now)).toContain("queued age 30m");
		expect(render(queuedForecast!, now)).toContain("active unknown");
	}
	expect(formatTaskForecastDisplay(retryForecast!, now)).toContain("first 15m");
	const rendered = renderTodoPlanDisplay(
		input,
		{ workers: [], owners: new Map() },
		{ now, forecast, paint: (_tone, text) => text },
	);
	expect(rendered.lines.join("\n")).toContain("recorded active 12m");
	expect(rendered.lines.join("\n")).toContain("queued age 30m");
	// A settled executor already in immutable history must not be counted twice.
	row.schedule!.executor = {
		workerId: previous.workerName,
		startedAt: previous.startedAt,
		finishedAt: previous.finishedAt,
		outcome: "failed",
	};
	const settled = forecastTodoPlan(input, { now }).rows[0]!;
	expect(formatTaskForecastDisplay(settled, now)).toContain("recorded active 10m");
	row.status = "completed";
	row.schedule!.finishedAt = now;
	const closed = forecastTodoPlan(input, { now }).rows[0]!;
	expect(formatTaskForecastDisplay(closed, now + hour)).toContain("age 60m");
	expect(formatTaskForecastDisplay(closed, now + hour)).toContain("recorded active 10m");
	delete row.schedule!.attemptHistory;
	delete row.schedule!.executor;
	const unknown = forecastTodoPlan(input, { now }).rows[0]!;
	expect(formatTaskForecastDisplay(unknown, now)).toContain("active unknown");
});
