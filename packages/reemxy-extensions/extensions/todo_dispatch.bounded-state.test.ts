import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	sessionContextEntryMetadata,
	type SessionContextEntryMetadata,
} from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { lifecycleGoal, rehydrateDeadlineState, STATE_ENTRY, type DeadlineState } from "./deadlines";
import { dispatchStateEntries, todoStateEntries } from "./todo_dispatch";

test("300k historical edits do not make repeated dispatch and todo reads decode history", () => {
	const state: DeadlineState = {
		version: 1,
		goalId: "goal",
		goalStartedAt: 1,
		timezone: "UTC",
		active: true,
		stages: [],
	};
	const custom = (id: string, customType: string, data: unknown): SessionEntry => ({
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		type: "custom",
		customType,
		data,
	});
	const history: SessionEntry[] = [];
	for (let i = 0; i < 300_000; i++) {
		history.push(custom(String(i), "user_todo_edit", { phases: [] }));
		if (i % 100 === 0) history.push(custom(`state-${i}`, STATE_ENTRY, state));
	}
	const goal = { id: "goal", status: "paused", createdAt: 1000 };
	history.push({
		...custom("focus", "unused", {}),
		type: "mode_change",
		mode: "goal_paused",
		data: { goal },
	} as SessionEntry);
	// Later legacy state cannot override an explicit native focus.
	history.push(custom("legacy", "pi-goal-state", { goal: { ...goal, status: "active" } }));
	history.push(
		custom("current", "user_todo_edit", {
			phases: [{ name: "Work", tasks: [{ content: "Current", status: "pending" }] }],
		}),
	);
	let decoded = 0;
	const decode = (entry: SessionEntry) => {
		decoded++;
		return JSON.parse(JSON.stringify(entry)) as SessionEntry;
	};
	let branch = history;
	const manager = {
		getBranch: () => branch.map(decode),
		getBranchMatching: (predicate: (metadata: SessionContextEntryMetadata) => boolean) =>
			branch.filter(entry => predicate(sessionContextEntryMetadata(entry))).map(decode),
		getLatestBranchMatching: (predicate: (metadata: SessionContextEntryMetadata) => boolean) => {
			const entry = branch.findLast(entry => predicate(sessionContextEntryMetadata(entry)));
			return entry ? decode(entry) : undefined;
		},
		*iterateBranchMatchingNewestFirst(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			for (let i = branch.length - 1; i >= 0; i--)
				if (predicate(sessionContextEntryMetadata(branch[i]!))) yield decode(branch[i]!);
		},
	};
	const ctx = { sessionManager: manager } as unknown as ExtensionContext;
	for (let i = 0; i < 50; i++) {
		const entries = dispatchStateEntries(ctx);
		expect(rehydrateDeadlineState(entries)).toEqual(state);
		expect(lifecycleGoal(entries, [])?.status).toBe("paused");
		expect(getLatestTodoPhasesFromEntries(entries as SessionEntry[])[0]?.tasks[0]?.content).toBe("Current");
		expect(getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as SessionEntry[])[0]?.tasks[0]?.content).toBe(
			"Current",
		);
	}
	expect(decoded).toBeLessThanOrEqual(50 * 4);
	branch = [custom("other", "user_todo_edit", { phases: [] })];
	expect(rehydrateDeadlineState(dispatchStateEntries(ctx))).toBeNull();
	expect(lifecycleGoal(dispatchStateEntries(ctx), [])).toBeUndefined();
});
