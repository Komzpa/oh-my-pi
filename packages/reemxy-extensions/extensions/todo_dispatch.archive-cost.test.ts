import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { dispatchTodoArchive } from "./todo_dispatch";

test("dispatch ticks replay archived rows once per TODO revision and observe init and branch changes", () => {
	const history: SessionEntry[] = Array.from({ length: 1400 }, (_, i) => ({
		type: "custom",
		id: `edit-${i}`,
		parentId: i ? `edit-${i - 1}` : null,
		timestamp: "2026-11-06T00:00:00Z",
		customType: "user_todo_edit",
		data: {
			edit: {
				v: 1,
				kind: "archive",
				at: i,
				archivedPhases: [{ name: "Done", tasks: [{ content: `row-${i}`, status: "completed" }] }],
			},
		},
	}));
	let reads = 0;
	const ctx = {
		sessionManager: {
			getBranch: () => {
				throw new Error("full journal hydration");
			},
			getLatestBranchMatching: () => history.at(-1),
			getBranchMatching: () => {
				reads++;
				return history;
			},
		},
	} as unknown as ExtensionContext;
	for (let tick = 0; tick < 20; tick++) expect(dispatchTodoArchive(ctx)[0]?.tasks.length).toBe(1400);
	expect(reads).toBe(1);
	const saved = history.at(-1)!;
	history.push({
		type: "custom",
		id: "init",
		parentId: saved.id,
		timestamp: saved.timestamp,
		customType: "user_todo_edit",
		data: { edit: { v: 1, kind: "op", at: 1500, op: "init", params: {} } },
	});
	expect(dispatchTodoArchive(ctx)).toEqual([]);
	expect(reads).toBe(2);
	history.pop();
	expect(dispatchTodoArchive(ctx)[0]?.tasks.length).toBe(1400);
	expect(reads).toBe(3);
});
