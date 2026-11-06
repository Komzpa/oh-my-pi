import { expect, test } from "bun:test";
import {
	selectBranchEntries,
	selectBranchNewestFirst,
	selectLatestBranchEntry,
	sessionContextEntryMetadata,
} from "../../src/session/branch-selection";
import type { SessionEntry } from "../../src/session/session-entries";
import { getLatestTodoPhasesFromEntries, isTodoSelectionEntryMetadata } from "../../src/tools/todo";

const entry = (id: string, type: string, data: unknown) =>
	({ id, type: "custom", customType: type, data }) as SessionEntry;
const old = entry("old", "unrelated", { large: "historical payload" });
const first = entry("first", "user_todo_edit", {
	phases: [{ name: "Work", tasks: [{ content: "repair", status: "pending" }] }],
});
const last = entry("last", "user_todo_edit", {
	phases: [{ name: "Work", tasks: [{ content: "repair", status: "completed" }] }],
});
const branch = [old, first, last];
test("indexed selection avoids historical payloads and keeps canonical TODO decisions", () => {
	const reads: string[] = [];
	const indexed = {
		getBranch: (): SessionEntry[] => {
			throw new Error("full-history read");
		},
		getBranchMatching: (predicate: Parameters<typeof selectBranchEntries>[1]) =>
			branch.flatMap(e => {
				if (!predicate(sessionContextEntryMetadata(e))) return [];
				reads.push(e.id);
				return [e];
			}),
	};
	const selected = selectBranchEntries(indexed, isTodoSelectionEntryMetadata);
	expect(reads).toEqual(["first", "last"]);
	expect(getLatestTodoPhasesFromEntries(selected)).toEqual(getLatestTodoPhasesFromEntries(branch));
	expect(getLatestTodoPhasesFromEntries(selected)[0]?.tasks[0]?.status).toBe("completed");
});
test("legacy capability preserves chronological selection and newest-first lookup", () => {
	const legacy = { getBranch: () => branch };
	expect(selectBranchEntries(legacy, isTodoSelectionEntryMetadata)).toEqual([first, last]);
	expect([...selectBranchNewestFirst(legacy, isTodoSelectionEntryMetadata)]).toEqual([last, first]);
	expect(selectLatestBranchEntry(legacy, isTodoSelectionEntryMetadata)).toBe(last);
	expect(selectLatestBranchEntry(legacy, () => false)).toBeUndefined();
});
test("newest-first indexed iterator stops without loading older matches", () => {
	const reads: string[] = [];
	const indexed = {
		getBranch: (): SessionEntry[] => {
			throw new Error("full-history read");
		},
		*iterateBranchMatchingNewestFirst() {
			reads.push(last.id);
			yield last;
			reads.push(first.id);
			yield first;
		},
	};
	expect(selectLatestBranchEntry(indexed, isTodoSelectionEntryMetadata)).toBe(last);
	expect(reads).toEqual(["last"]);
});
