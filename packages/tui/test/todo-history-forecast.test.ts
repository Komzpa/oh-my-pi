import { expect, test } from "bun:test";
import {
	calibrateTodoPlan,
	forecastTodoPlan,
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
