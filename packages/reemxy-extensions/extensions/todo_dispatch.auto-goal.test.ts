// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { expect, test } from "bun:test";
import { forecastTodoPlan, formatPlanForecast, formatTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { autoGoalDeadlineState, decideTodoDispatch } from "./todo_dispatch";
import { readGoalDeadline, rehydrateDeadlineState, STATE_ENTRY } from "./deadlines";
import { renderDeadlineReminder, renderDeadlineUi, renderPresence } from "./goal_deadlines";

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

test("a missed automatic forecast remains anchored even when estimates change", () => {
	const first = propose(now + 60 * 60_000)!;
	const revisedAt = now + 65 * 60_000;
	const next = autoGoalDeadlineState({
		current: first,
		planKey: "changed-estimates",
		forecastFinish: revisedAt + 2 * 60 * 60_000,
		now: revisedAt,
		hasRealGoal: false,
		hasRealDeadline: false,
	})!;

	expect(next).toBeUndefined();
	expect(renderDeadlineReminder(first, Math.floor(revisedAt / 1_000))).toContain("5m");
	expect(renderDeadlineUi(first, Math.floor(revisedAt / 1_000), true).join(" ")).toContain("missed");
	expect(renderPresence([], first, revisedAt)).toContain("missed");
	expect(renderPresence([], first, revisedAt)).not.toContain("on track");
});

test("scope growth and estimate churn retain the original clock across an inactive checkpoint", () => {
	const first = propose(now + 3 * 60 * 60_000, { openRows: ["original"] })!;
	const grown = propose(now + 8 * 60 * 60_000, {
		current: { ...first, active: false },
		planKey: "revised",
		openRows: ["original", "appended"],
		now: now + 4 * 60 * 60_000,
	})!;
	expect(grown.goalStartedAt).toBe(first.goalStartedAt);
	expect(grown.baselineDeadlineAt).toBe(first.baselineDeadlineAt);
	expect(grown.active).toBe(true);
	expect(grown.autoScopeGrowthRows).toEqual(["appended"]);
	expect(readGoalDeadline([{ type: "custom", customType: STATE_ENTRY, data: grown }])?.deadlineAt).toBe(
		first.baselineDeadlineAt! * 1000,
	);
});

test("dispatcher includes archived closure pace without reviving archived rows", () => {
	const phases = [
		{
			name: "live",
			tasks: [
				{
					content: "open",
					status: "pending",
					schedule: {
						dependencies: [],
						owner: "worker",
						resources: [],
						firstRequirementAt: now - 12 * 3_600_000,
						cumulativeReestimateCount: 6,
						estimate: {
							optimisticSeconds: 1200,
							likelySeconds: 1800,
							pessimisticSeconds: 3600,
							updatedAt: now,
							confidence: "medium",
							basis: "replay",
						},
					},
				},
			],
		},
	];
	const archivedPhases = [
		{
			name: "archive",
			tasks: Array.from({ length: 8 }, (_, i) => ({
				content: `closed ${i}`,
				status: "completed",
				schedule: { finishedAt: now - (10 - (i * 10) / 7) * 3_600_000 },
			})),
		},
	];
	const decision = decideTodoDispatch(
		{
			phases,
			archivedPhases,
			jobs: { running: [], recent: [] },
			now,
			isMainSession: true,
			taskEnabled: true,
			capacity: 3,
		},
		{ forecastTodoPlan, formatPlanForecast, formatTaskForecast },
	);
	expect(decision.forecast.autoDeadlineForecast.rowsPerHour).toBeCloseTo(0.7);
	expect(decision.forecast.rows.map(row => row.content)).toEqual(["open"]);
	const state = propose(decision.forecast.autoDeadlineForecast.finish, { openRows: ["open"] });
	expect(state.baselineDeadlineAt * 1000).toBe(Math.ceil(decision.forecast.autoDeadlineForecast.finish / 1000) * 1000);
});

test("legacy plan identity recovers its missed anchor instead of granting a new clock", () => {
	const first = propose(now + 3 * 60 * 60_000)!;
	const next = propose(now + 8 * 60 * 60_000, {
		current: { ...first, active: false },
		planKey: "changed",
		openRows: ["Deliver the patch", "new scope"],
	});
	expect(next.goalStartedAt).toBe(first.goalStartedAt);
	expect(next.baselineDeadlineAt).toBe(first.baselineDeadlineAt);
	expect(next.autoScopeGrowthRows).toEqual(["new scope"]);
});


test("split, reorder, archive and restart cannot grant an old goal a new initial forecast", () => {
 const first = propose(now + 60 * 60_000, { goalId: "goal-a", openRows: ["original"], membershipFingerprint: "original-set", predictionVersion: "v1" })!;
 const persisted = JSON.parse(JSON.stringify({ ...first, active: false }));
 const restored = rehydrateDeadlineState([{ type: "custom", customType: STATE_ENTRY, data: persisted }]);
 const split = propose(now + 8 * 60 * 60_000, { current: restored, goalId: "goal-a", planKey: "split-reestimated", openRows: ["child-b", "child-a"], now: now + 2 * 60 * 60_000 })!;
 expect(readGoalDeadline([{ type: "custom", customType: STATE_ENTRY, data: split }])?.deadlineAt).toBe(first.baselineDeadlineAt! * 1000);
 expect(split.autoAnchorId).toBe(first.autoAnchorId);
 expect(split.autoMembershipFingerprint).toBe("original-set");
 expect(split.autoInitialForecastFinish).toBe(first.autoInitialForecastFinish);
 expect(split.autoEvents!.slice(0, first.autoEvents!.length)).toEqual(first.autoEvents!);
 expect(split.autoEvents!.at(-1)!.rows).toEqual(["child-b", "child-a"]);
 expect(propose(now + 9 * 60 * 60_000, { current: split, goalId: "goal-a", planKey: "reordered", openRows: ["child-a", "child-b"] })).toBeUndefined();
 const removed = propose(now + 9 * 60 * 60_000, { current: { ...split, active: false }, goalId: "goal-a", openRows: [] })!;
 expect(removed.baselineDeadlineAt).toBe(first.baselineDeadlineAt);
 expect(removed.active).toBe(true);
 const nextGoal = propose(now + 9 * 60 * 60_000, { current: removed, goalId: "goal-b", openRows: ["new goal"] })!;
 expect(nextGoal.goalId).toBe("goal-b");
 expect(nextGoal.autoAnchorId).not.toBe(first.autoAnchorId);
 expect(nextGoal.autoEvents!.at(-1)!.oldDeadlineAt).toBe(first.baselineDeadlineAt);
});
