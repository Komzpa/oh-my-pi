import { expect, test } from "bun:test";
import { readGoalDeadlineFromManager, STATE_ENTRY } from "../../src/goals/deadlines";
import {
	sessionContextEntryMetadata,
	type BranchSource,
	type SessionContextEntryMetadata,
} from "../../src/session/branch-selection";
import type { SessionEntry } from "../../src/session/session-entries";

const goal = { id: "ship", createdAt: 1_790_000_000_000, status: "active" };
const state = {
	version: 1,
	goalId: goal.id,
	goalStartedAt: 1_790_000_000,
	timezone: "UTC",
	active: true,
	stages: [{ id: "ship", label: "Ship", expectedResult: "Shipped", deadlineAt: 1_790_236_800 }],
};
function entry(customType: string, data: unknown): SessionEntry {
	return { type: "custom", id: "fixture", parentId: null, timestamp: "2026-11-07T00:00:00Z", customType, data };
}
function source(history: SessionEntry[]) {
	let decoded = 0;
	const manager: BranchSource = {
		getBranch() {
			throw new Error("unexpected complete branch hydration");
		},
		getBranchMatching() {
			throw new Error("unexpected complete deadline selection");
		},
		getLatestBranchMatching(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			for (const value of history.toReversed())
				if (predicate(sessionContextEntryMetadata(value))) {
					decoded++;
					return value;
				}
		},
		*iterateBranchMatchingNewestFirst(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			for (const value of history.toReversed())
				if (predicate(sessionContextEntryMetadata(value))) {
					decoded++;
					yield value;
				}
		},
	};
	return { manager, decoded: () => decoded };
}

test("repeated deadline reads decode only latest state and explicit focus across long passive history", () => {
	const history = Array.from({ length: 7000 }, () => entry(STATE_ENTRY, state));
	history.push({
		type: "mode_change",
		id: "focus",
		parentId: null,
		timestamp: "2026-11-07T00:00:00Z",
		mode: "goal",
		data: { goal },
	} as SessionEntry);
	history.push(entry("pi-goal-state", { goal: { ...goal, id: "passive-other" } }), entry(STATE_ENTRY, state));
	const h = source(history);
	for (let cycle = 0; cycle < 50; cycle++)
		expect(readGoalDeadlineFromManager(h.manager)).toEqual({ goalId: "ship", deadlineAt: 1_790_236_800_000 });
	expect(h.decoded()).toBe(100);
	// The newest malformed state masks older valid deadlines rather than reviving them.
	history.push(entry(STATE_ENTRY, { version: 2 }));
	expect(readGoalDeadlineFromManager(h.manager)).toBeUndefined();
	expect(h.decoded()).toBe(101);
	history.pop();
	history.push({
		type: "mode_change",
		id: "unrelated",
		parentId: null,
		timestamp: "2026-11-07T00:00:00Z",
		mode: "plan",
	} as SessionEntry);
	expect(readGoalDeadlineFromManager(h.manager)).toEqual({ goalId: "ship", deadlineAt: 1_790_236_800_000 });
	history.pop();
	expect(readGoalDeadlineFromManager(h.manager)).toEqual({ goalId: "ship", deadlineAt: 1_790_236_800_000 });
	history.push(entry("pi-goal-focus", { focusedGoalId: null }));
	expect(readGoalDeadlineFromManager(h.manager)).toBeUndefined();
	history.pop();
	history.push(entry(STATE_ENTRY, { ...state, active: false }));
	expect(readGoalDeadlineFromManager(h.manager, undefined, { includePaused: true })).toBeUndefined();
});

test("legacy focus falls back only when explicit choices are absent and observes rewind and paused state", () => {
	const history = [entry("pi-goal-state", { goal: { ...goal, status: "paused" } }), entry(STATE_ENTRY, state)];
	const h = source(history);
	expect(readGoalDeadlineFromManager(h.manager)).toBeUndefined();
	expect(readGoalDeadlineFromManager(h.manager, undefined, { includePaused: true })).toEqual({
		goalId: "ship",
		deadlineAt: 1_790_236_800_000,
		paused: true,
	});
	history.push(entry("pi-goal-state", {}));
	expect(readGoalDeadlineFromManager(h.manager, undefined, { includePaused: true })).toBeUndefined();
	history.pop();
	expect(readGoalDeadlineFromManager(h.manager, undefined, { includePaused: true })?.paused).toBe(true);
	history.push({
		type: "mode_change",
		id: "clear",
		parentId: null,
		timestamp: "2026-11-07T00:00:00Z",
		mode: "none",
	} as SessionEntry);
	expect(readGoalDeadlineFromManager(h.manager, undefined, { includePaused: true })).toBeUndefined();
});

test("legacy managers retain deadline selection correctness", () => {
	const history = [entry("pi-goal-state", { goal }), entry(STATE_ENTRY, state)];
	expect(readGoalDeadlineFromManager({ getBranch: () => history })).toEqual({
		goalId: "ship",
		deadlineAt: 1_790_236_800_000,
	});
});

test("newest deadline tool state masks an older custom deadline even when malformed", () => {
	const history = [entry("pi-goal-state", { goal }), entry(STATE_ENTRY, state)];
	const h = source(history);
	history.push({
		type: "message",
		id: "tool",
		parentId: null,
		timestamp: "2026-11-07T00:00:00Z",
		message: { role: "toolResult", toolName: "goal_deadline", details: { state: { version: 2 } } },
	} as SessionEntry);
	expect(readGoalDeadlineFromManager(h.manager)).toBeUndefined();
	expect(h.decoded()).toBe(1);
	history.pop();
	expect(readGoalDeadlineFromManager(h.manager)?.deadlineAt).toBe(1_790_236_800_000);
});

test("fixed user deadlines do not hydrate any focus history", () => {
	const h = source([
		entry("pi-goal-focus", { focusedGoalId: null }),
		entry(STATE_ENTRY, {
			...state,
			baselineDeadlineAt: 1_790_236_800,
			userConstraint: { messageId: "user", quote: "by then", recordedAt: 1_790_000_000 },
		}),
	]);
	expect(readGoalDeadlineFromManager(h.manager)).toEqual({ goalId: "ship", deadlineAt: 1_790_236_800_000 });
	expect(h.decoded()).toBe(1);
});
