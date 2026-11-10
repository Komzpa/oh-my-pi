import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { sessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { dispatchTodoArchive, dispatchStateEntries, todoStateEntries } from "./todo_dispatch";

function snapshot(id: string, content: string): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom",
		customType: "user_todo_edit",
		data: { phases: [{ name: "Work", tasks: [{ content, status: "pending" }] }] },
	};
}

test("todo state reads stop at the latest snapshot, including pending edits", () => {
	const entries = [snapshot("old", "Old"), snapshot("new", "Current")];
	let decoded = 0;
	const ctx = {
		sessionManager: {
			getBranch() {
				throw new Error("full branch read");
			},
			*iterateBranchMatchingNewestFirst(predicate: (metadata: object) => boolean) {
				for (const entry of entries.toReversed())
					if (predicate(sessionContextEntryMetadata(entry))) {
						decoded++;
						yield entry;
					}
			},
		},
	} as unknown as ExtensionContext;
	expect(getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as SessionEntry[])[0]?.tasks[0]?.content).toBe(
		"Current",
	);
	expect(decoded).toBe(1);
	const pending = snapshot("pending", "Pending");
	expect(
		getLatestTodoPhasesFromEntries(todoStateEntries(ctx, [pending]) as SessionEntry[])[0]?.tasks[0]?.content,
	).toBe("Pending");
	expect(decoded).toBe(2);
});

test("native snapshots remain usable with pending writes without any todo history read", () => {
	const ctx = {
		getTodoSnapshot: () => [{ name: "Work", tasks: [{ content: "Current", status: "pending" }] }],
		sessionManager: {
			getBranch() {
				throw new Error("full branch read");
			},
			getBranchMatching() {
				return [];
			},
		},
	} as unknown as ExtensionContext;
	for (const read of [todoStateEntries, dispatchStateEntries]) {
		expect(
			getLatestTodoPhasesFromEntries(read(ctx, [snapshot("pending", "Pending")]) as SessionEntry[])[0]?.tasks[0]
				?.content,
		).toBe("Pending");
	}
});

test("archive updates read only the appended tail and rebuild after switching branches", () => {
	const archived = snapshot("a", "First");
	if (archived.type === "custom")
		archived.data = {
			edit: {
				v: 1,
				kind: "archive",
				at: 1,
				archivedPhases: [{ name: "Done", tasks: [{ content: "Archived", status: "completed" }] }],
			},
		};
	let entries = [archived];
	let decoded = 0;
	const ctx = {
		sessionManager: {
			getBranch() {
				throw new Error("full branch read");
			},
			getLatestBranchMatching() {
				return entries.at(-1);
			},
			*iterateBranchMatchingNewestFirst() {
				for (const entry of entries.toReversed()) {
					decoded++;
					yield entry;
				}
			},
		},
	} as unknown as ExtensionContext;
	expect(dispatchTodoArchive(ctx)[0]?.tasks[0]?.content).toBe("Archived");
	entries.push(snapshot("b", "Next"));
	expect(dispatchTodoArchive(ctx)[0]?.tasks[0]?.content).toBe("Archived");
	expect(decoded).toBe(3);
	entries = [snapshot("other", "Other branch")];
	expect(dispatchTodoArchive(ctx)).toEqual([]);
	expect(decoded).toBe(4);
});

test("legacy managers still replay the latest todo snapshot", () => {
	const ctx = {
		sessionManager: { getBranch: () => [snapshot("a", "Old"), snapshot("b", "Current")] },
	} as unknown as ExtensionContext;
	expect(getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as SessionEntry[])[0]?.tasks[0]?.content).toBe(
		"Current",
	);
});

test("session loading warms archive history before interactive reads, including branch switches", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	await todoDispatch({
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => [],
		appendEntry: () => {},
		pi: { ...schedule, getLatestTodoPhasesFromEntries },
	} as unknown as ExtensionAPI);
	const archived = (id: string, content: string): SessionEntry =>
		({
			...snapshot(id, content),
			data: {
				edit: {
					v: 1,
					kind: "archive",
					at: 1,
					archivedPhases: [{ name: "Done", tasks: [{ content, status: "completed" }] }],
				},
			},
		}) as SessionEntry;
	let entries = [archived("a", "First archive")];
	let historyReads = 0;
	const ctx = {
		cwd: "/tmp/no-native-active-goal-fixture",
		getTodoSnapshot: () => [],
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		sessionManager: {
			getHeader: () => ({ id: "root" }),
			getBranch() {
				throw new Error("full branch read");
			},
			getLatestBranchMatching(predicate: (metadata: object) => boolean) {
				return entries.findLast(entry => predicate(sessionContextEntryMetadata(entry)));
			},
			*iterateBranchMatchingNewestFirst(predicate: (metadata: object) => boolean) {
				for (const entry of entries.toReversed())
					if (predicate(sessionContextEntryMetadata(entry))) {
						historyReads++;
						yield entry;
					}
			},
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")!({}, ctx);
	expect(historyReads).toBe(1);
	expect(dispatchTodoArchive(ctx)[0]?.tasks[0]?.content).toBe("First archive");
	expect(historyReads).toBe(1);
	entries = [archived("b", "Switched archive")];
	await handlers.get("session_switch")!({}, ctx);
	expect(historyReads).toBe(2);
	expect(dispatchTodoArchive(ctx)[0]?.tasks[0]?.content).toBe("Switched archive");
	expect(historyReads).toBe(2);
});
