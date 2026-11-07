import { expect, test } from "bun:test";
import type { TodoScheduleInputTask } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { measuredRecoveryForecast, recoveryActionObserved, recoveryDemand, RECOVERY_STEP_MS } from "./dispatch_wake";
const plan = (): Array<{ name: string; tasks: TodoScheduleInputTask[] }> => [
	{
		name: "Ship",
		tasks: [
			{ content: "Delivery", status: "pending" },
			{ content: "QA", status: "pending" },
		],
	},
];
const running = new Set<string>();

test("SLIPPED demand keeps its key across ignored slip steps and rearms after satisfied step", () => {
	const phases = plan();
	const first = recoveryDemand(phases, running, 1000, 2, 2000, 3000);
	expect(first.pending?.kind).toBe("deadline");
	const later = recoveryDemand(phases, running, 1000 + RECOVERY_STEP_MS, 2, 2000, 3000, first);
	expect(later.pending?.key).toBe(first.pending?.key);
	const satisfied = { ...first, satisfied: first.pending!.key, pending: undefined };
	expect(recoveryDemand(phases, running, 1000, 2, 2000, 3000, satisfied).pending).toBeUndefined();
	expect(recoveryDemand(phases, running, 1000 + 2 * RECOVERY_STEP_MS, 2, 2000, 3000, satisfied).pending?.key).not.toBe(
		first.pending?.key,
	);
});

test("idle row demands staffing after ten continuous minutes of spare capacity; hold must name the row", () => {
	const phases = plan();
	let state = recoveryDemand(phases, running, 1000, 2, undefined, undefined);
	state = recoveryDemand(phases, running, 1000 + RECOVERY_STEP_MS - 1, 2, undefined, undefined, state);
	expect(state.pending).toBeUndefined();
	state = recoveryDemand(phases, running, 1000 + RECOVERY_STEP_MS, 2, undefined, undefined, state);
	expect(state.pending?.kind).toBe("idle");
	phases[0]!.tasks[1]!.status = "blocked";
	phases[0]!.tasks[1]!.blocker = "Owner approval";
	expect(recoveryActionObserved(state.pending!, phases, running)).toBe(false);
	phases[0]!.tasks[0]!.status = "blocked";
	phases[0]!.tasks[0]!.blocker = "Waiting for access";
	expect(recoveryActionObserved(state.pending!, phases, running)).toBe(true);
	const full = recoveryDemand(plan(), new Set(["a", "b"]), 1000 + RECOVERY_STEP_MS, 2, undefined, undefined);
	expect(full.pending).toBeUndefined();
	expect(full.idleSince).toEqual({});
});

test("staffing must be a new live executor; completion and estimate changes are not structural recovery", () => {
	const phases = plan();
	const state = recoveryDemand(phases, running, 3000, 2, 2000, undefined);
	phases[0]!.tasks[0]!.status = "completed";
	expect(recoveryActionObserved(state.pending!, phases, running)).toBe(false);
	const row = phases[0]!.tasks[1]!;
	row.schedule = { owner: "qa", executor: { workerId: "qa", startedAt: 4000 } };
	expect(recoveryActionObserved(state.pending!, phases, running)).toBe(false);
	expect(recoveryActionObserved(state.pending!, phases, new Set(["qa"]))).toBe(true);
});

test("forecast records measured completed rows per hour and computed ETA, rejecting a zero pace", () => {
	const phases = plan();
	const state = recoveryDemand(phases, running, 1000, 2, 2000, undefined);
	expect(() => measuredRecoveryForecast(state, phases, 3601000)).toThrow("zero rows/hour");
	phases[0]!.tasks[0]!.status = "completed";
	expect(measuredRecoveryForecast(state, phases, 3601000)).toEqual({
		at: 3601000,
		from: 1000,
		completed: 1,
		rowsPerHour: 1,
		open: 1,
		eta: 7201000,
	});
});

test("live legacy owners and non-dispatchable rows never accrue idle age", () => {
	const phases = plan();
	phases[0]!.tasks[0]!.schedule = { owner: "live" };
	const state = recoveryDemand(
		phases,
		new Set(["live", "alias"]),
		1000,
		2,
		undefined,
		undefined,
		undefined,
		1,
		new Set(["Delivery"]),
	);
	expect(state.idleSince).toEqual({});
	expect(
		recoveryDemand(
			phases,
			new Set(["live", "alias"]),
			601000,
			2,
			undefined,
			undefined,
			state,
			1,
			new Set(["Delivery"]),
		).pending,
	).toBeUndefined();
});

test("splitting an open row requires new linked children; adding unrelated rows cannot satisfy recovery", () => {
	const phases = plan();
	const demand = recoveryDemand(phases, running, 3000, 2, 2000, undefined).pending!;
	phases[0]!.tasks.push({ content: "Piece A", status: "pending" }, { content: "Piece B", status: "pending" });
	expect(recoveryActionObserved(demand, phases, running)).toBe(false);
	phases[0]!.tasks[0]!.schedule = { dependencies: ["Piece A", "Piece B"] };
	expect(recoveryActionObserved(demand, phases, running)).toBe(true);
});
