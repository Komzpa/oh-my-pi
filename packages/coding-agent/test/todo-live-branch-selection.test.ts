import * as todo from "../src/tools/todo";
import type { ToolSession } from "../src/sdk";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { Settings } from "../src/config/settings";
import { expect, test } from "bun:test";
import {
	sessionContextEntryMetadata,
	type BranchSource,
	type SessionContextEntryMetadata,
} from "../src/session/branch-selection";
import type { SessionEntry } from "../src/session/session-entries";
import { getLatestTodoPhasesFromEntries, getLiveTodoBranchEntries } from "../src/tools/todo";

function entry(id: string, data: unknown, customType = "user_todo_edit"): SessionEntry {
	return { id, type: "custom", parentId: null, timestamp: "2026-11-07T00:00:00Z", customType, data };
}

test("live plan replay reads only snapshot, delta and HUD despite long obsolete todo history", () => {
	const snapshot = entry("snapshot", {
		phases: [{ name: "Ship", tasks: [{ content: "Deliver", status: "pending" }] }],
	});
	const delta = entry("delta", {
		edit: { v: 1, kind: "schedule_patch", at: 1, task: "Deliver", patch: { owner: "Worker" } },
	});
	const hud = entry("hud", { visibility: "revealed" }, "todo_hud_state");
	const history = [...Array.from({ length: 7000 }, (_, i) => entry(`old-${i}`, { phases: [] })), snapshot, delta, hud];
	let decoded = 0;
	const manager: BranchSource = {
		getBranch() {
			throw new Error("full branch read");
		},
		getBranchMatching() {
			throw new Error("full selection read");
		},
		*iterateBranchMatchingNewestFirst(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			for (let i = history.length - 1; i >= 0; i--) {
				const value = history[i]!;
				if (predicate(sessionContextEntryMetadata(value))) {
					decoded++;
					yield value;
				}
			}
		},
	};
	const selected = getLiveTodoBranchEntries(manager);
	expect(selected.map(value => value.id)).toEqual(["snapshot", "delta", "hud"]);
	expect(getLatestTodoPhasesFromEntries(selected)[0]?.tasks[0]?.schedule?.owner).toBe("Worker");
	expect(decoded).toBe(3);
	history.push(entry("clear", { phases: [] }));
	expect(getLatestTodoPhasesFromEntries(getLiveTodoBranchEntries(manager))).toEqual([]);
	expect(decoded).toBe(4);
});

test("legacy branch sources preserve compact edits after their latest full snapshot", () => {
	const snapshot = entry("snapshot", {
		phases: [{ name: "Ship", tasks: [{ content: "Deliver", status: "pending" }] }],
	});
	const delta = entry("delta", {
		edit: { v: 1, kind: "schedule_patch", at: 1, task: "Deliver", patch: { owner: "Worker" } },
	});
	const manager = { getBranch: () => [entry("old", { phases: [] }), snapshot, delta] };
	expect(getLatestTodoPhasesFromEntries(getLiveTodoBranchEntries(manager))[0]?.tasks[0]?.schedule?.owner).toBe(
		"Worker",
	);
});

test("50 native todo view/update calls stay off historical payloads after resume", async () => {
	const history = Array.from({ length: 7000 }, (_, i) => entry(`old-${i}`, { phases: [] }));
	history.push(
		entry("archive", {
			edit: {
				v: 1,
				kind: "archive",
				at: 1,
				archivedPhases: [{ name: "Done", tasks: [{ content: "Shipped", status: "completed" }] }],
			},
		}),
	);
	let phases: TodoPhase[] = [{ name: "Ship", tasks: [{ content: "Deliver", status: "pending" }] }];
	history.push(entry("snapshot", { phases }));
	let decoded = 0;
	let rejectFull = false;
	const manager = {
		bodyRevision: 0,
		getBranch() {
			if (rejectFull) throw new Error("full branch read");
			return history;
		},
		getBranchMatching(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			if (rejectFull && predicate({ type: "custom", customType: "user_todo_edit" }))
				throw new Error("full TODO selection");
			return history.filter(value => predicate(sessionContextEntryMetadata(value)));
		},
		getLatestBranchMatching(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			return history.findLast(value => predicate(sessionContextEntryMetadata(value)));
		},
		*iterateBranchMatchingNewestFirst(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			for (const value of history.toReversed())
				if (predicate(sessionContextEntryMetadata(value))) {
					decoded++;
					yield value;
				}
		},
	};
	const session = {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: (next: TodoPhase[]) => {
			phases = next;
		},
		sessionManager: manager,
	} as unknown as ToolSession;
	// Older versions have no archive prewarm API; the first execute must still
	// expose their unbounded read instead of failing to import the regression.
	if (todo.getTodoArchiveBranchEntries) todo.getTodoArchiveBranchEntries(manager);
	const warmDecoded = decoded;
	rejectFull = true;
	const tool = new todo.TodoTool(session);
	for (let cycle = 0; cycle < 50; cycle++) {
		const result = await tool.execute(
			`cycle-${cycle}`,
			cycle % 2 === 0
				? { op: "view", archive: true }
				: { op: "schedule", updates: [{ task: "Deliver", owner: `Worker${cycle}` }] },
		);
		expect(result.isError).not.toBe(true);
		if (cycle % 2 === 0) {
			expect(result.details?.archivedPhases?.[0]?.tasks[0]?.content).toBe("Shipped");
			expect(result.details?.archiveSummary?.count).toBe(1);
			// Results are owned by the caller; editing a view must not poison the folded cache.
			result.details!.archivedPhases![0]!.tasks[0]!.content = "consumer edit";
			result.details!.archiveSummary!.count = 99;
		} else history.push(entry(`update-${cycle}`, { phases }));
	}
	expect(phases[0]?.tasks[0]?.schedule?.owner).toBe("Worker49");
	expect(decoded - warmDecoded).toBeLessThanOrEqual(50);
	manager.bodyRevision++;
	history[7000] = entry("archive", {
		edit: {
			v: 1,
			kind: "archive",
			at: 2,
			archivedPhases: [{ name: "Done", tasks: [{ content: "Rewritten", status: "completed" }] }],
		},
	});
	expect(todo.getLatestTodoArchiveFromEntries(todo.getTodoArchiveBranchEntries(manager))[0]?.tasks[0]?.content).toBe(
		"Rewritten",
	);
	history.push(entry("init", { edit: { v: 1, kind: "op", at: 3, op: "init", params: {} } }));
	expect(todo.getLatestTodoArchiveFromEntries(todo.getTodoArchiveBranchEntries(manager))).toEqual([]);
	expect(todo.getTodoArchiveSummaryFromEntries(todo.getTodoArchiveBranchEntries(manager))).toBeUndefined();
	history.pop();
	expect(todo.getLatestTodoArchiveFromEntries(todo.getTodoArchiveBranchEntries(manager))[0]?.tasks[0]?.content).toBe(
		"Rewritten",
	);
});
