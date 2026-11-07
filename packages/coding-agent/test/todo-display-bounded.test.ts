import { expect, test } from "bun:test";
import { sessionContextEntryMetadata, type SessionContextEntryMetadata } from "../src/session/branch-selection";
import type { SessionEntry } from "../src/session/session-entries";
import { getTodoArchiveBranchEntries } from "../src/tools/todo";
import { readTodoDisplayArchive } from "../src/tools/todo-plan-display";

test("HUD archive refresh after a new snapshot does not decode 300k old snapshots", () => {
	const entry = (id: string, data: unknown): SessionEntry => ({
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-11-07T00:00:00Z",
		customType: "user_todo_edit",
		data,
	});
	const history = Array.from({ length: 300_000 }, (_, i) => entry(`old-${i}`, { phases: [] }));
	history.push(
		entry("archive", {
			edit: {
				v: 1,
				kind: "archive",
				at: 1000,
				archivedPhases: [{ name: "Done", tasks: [{ content: "Shipped", status: "completed" }] }],
			},
		}),
	);
	let decoded = 0;
	const manager = {
		bodyRevision: 0,
		getLeafId: () => history.at(-1)!.id,
		getBranch: () => {
			decoded += history.length;
			return history;
		},
		getBranchMatching(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			return history.filter(value => {
				if (!predicate(sessionContextEntryMetadata(value))) return false;
				decoded++;
				return true;
			});
		},
		getLatestBranchMatching(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			const value = history.findLast(value => predicate(sessionContextEntryMetadata(value)));
			if (value) decoded++;
			return value;
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
	// Resume owns the one historical archive fold. HUD uses that same owner.
	getTodoArchiveBranchEntries(manager);
	decoded = 0;
	for (let turn = 0; turn < 10; turn++) {
		history.push(entry(`snapshot-${turn}`, { phases: [] }));
		const before = decoded;
		const view = readTodoDisplayArchive(manager);
		expect(view.summary?.count).toBe(1);
		expect(view.phases[0]?.tasks[0]?.content).toBe("Shipped");
		expect(decoded - before).toBeLessThan(10);
	}
	history.push(entry("init", { edit: { v: 1, kind: "op", at: 2000, op: "init", params: {} } }));
	expect(readTodoDisplayArchive(manager).phases).toEqual([]);
});
