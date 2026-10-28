// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { expect, test } from "bun:test";
import { autoGoalDeadlineState } from "./todo_dispatch";
import { readGoalDeadline, STATE_ENTRY } from "./deadlines";
import { renderDeadlineReminder } from "./goal_deadlines";

const now = Date.parse("2026-10-28T09:00:00Z");
const planKey = JSON.stringify([["Work", ["Deliver the patch"]]]);

function propose(forecastFinish: number, options: Record<string, unknown> = {}) {
	return autoGoalDeadlineState({
		current: null,
		planKey,
		forecastFinish,
		now,
		hasRealGoal: false,
		hasRealDeadline: false,
		...options,
	});
}

test("an open plan forecast over 15 minutes away becomes the persisted active deadline", () => {
	const state = propose(now + 3 * 60 * 60_000)!;
	const entries = [{ type: "custom", customType: STATE_ENTRY, data: state }];

	expect(state.auto).toBe(true);
	expect(readGoalDeadline(entries)?.deadlineAt).toBe(state.baselineDeadlineAt! * 1_000);
	expect(renderDeadlineReminder(state, Math.floor(now / 1_000))).toContain(
		"Deadline set automatically from the TODO plan forecast.",
	);
});

test("a plan forecast within the next 15 minutes does not create an automatic deadline", () => {
	expect(propose(now + 14 * 60_000)).toBeUndefined();
});

test("an active real goal or deadline prevents an automatic deadline", () => {
	expect(propose(now + 3 * 60 * 60_000, { hasRealGoal: true })).toBeUndefined();
	expect(propose(now + 3 * 60 * 60_000, { hasRealDeadline: true })).toBeUndefined();
});

test("a later tick keeps the original automatic deadline for the same plan", () => {
	const first = propose(now + 3 * 60 * 60_000)!;
	const next = autoGoalDeadlineState({
		current: first,
		planKey,
		forecastFinish: now + 5 * 60_000 + 4 * 60 * 60_000,
		now: now + 5 * 60_000,
		hasRealGoal: false,
		hasRealDeadline: false,
	});

	expect(next).toBeUndefined();
	expect(first.baselineDeadlineAt).toBe(Math.ceil((now + 3 * 60 * 60_000) / 1_000));
});
