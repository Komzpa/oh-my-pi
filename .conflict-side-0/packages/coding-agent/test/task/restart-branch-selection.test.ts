import { expect, it } from "bun:test";
import type { SessionEntry } from "../../src/session/session-entries";
import { selectLatestRestartBranchEntry, selectRestartBranchEntries } from "../../src/task/restart-branch-selection";

it("keeps restart state order and newest checkpoint equal with indexed or standalone history", () => {
	const entries: SessionEntry[] = ["restart", "other", "restart"].map((customType, index) => ({
		type: "custom",
		id: String(index),
		parentId: index ? String(index - 1) : null,
		timestamp: "2026-10-15T00:00:00.000Z",
		customType,
		data: { checkpoint: index },
	}));
	const predicate = (metadata: { type: SessionEntry["type"]; customType?: string }) =>
		metadata.type === "custom" && metadata.customType === "restart";
	const standalone = { getBranch: () => entries };
	const expected = selectRestartBranchEntries(standalone, predicate);
	const indexed = {
		getBranch: (): SessionEntry[] => {
			throw new Error("historical payload hydration");
		},
		getBranchMatching: () => expected,
		getLatestBranchMatching: () => expected.at(-1),
	};
	expect(expected.map(entry => entry.id)).toEqual(["0", "2"]);
	expect(selectRestartBranchEntries(indexed, predicate)).toEqual(expected);
	expect(selectLatestRestartBranchEntry(indexed, predicate)).toEqual(
		selectLatestRestartBranchEntry(standalone, predicate),
	);
	expect(selectLatestRestartBranchEntry({ ...indexed, getLatestBranchMatching: undefined }, predicate)?.id).toBe("2");
	expect(selectLatestRestartBranchEntry(standalone, () => false)).toBeUndefined();
});
