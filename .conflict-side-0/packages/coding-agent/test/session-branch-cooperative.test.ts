import { expect, test } from "bun:test";
import {
	type BranchSource,
	selectBranchEntriesCooperatively,
	sessionContextEntryMetadata,
} from "../src/session/branch-selection";
import { SessionManager } from "../src/session/session-manager";

test("digest selection stays on the active ancestry and yields without materializing the transcript", async () => {
	const manager = SessionManager.inMemory("/fixture");
	const first = manager.appendCustomEntry("sample", { open: 7 });
	for (let i = 0; i < 1024; i++) manager.appendCustomEntry("unrelated", { text: "transcript" });
	manager.appendCustomEntry("sample", { open: 6 });
	const leaf = manager.getLeafId();
	manager.appendCustomEntry("sample", { open: 99 });
	let responsive = false;
	const heartbeat = Bun.sleep(0).then(() => {
		responsive = true;
	});
	const selected = await selectBranchEntriesCooperatively(
		{
			getLeafId: () => leaf,
			getEntry: id => manager.getEntry(id),
			getBranch: () => {
				throw new Error("Full transcript walk");
			},
		},
		metadata => metadata.customType === "sample",
	);
	expect(selected.map(entry => (entry.type === "custom" ? entry.data : null))).toEqual([{ open: 7 }, { open: 6 }]);
	expect(selected[0]?.id).toBe(first);
	expect(responsive).toBe(true);
	await heartbeat;
});

test("critic skips historical payloads excluded by indexed metadata", async () => {
	const manager = SessionManager.inMemory("/fixture");
	manager.appendCustomEntry("sample", { open: 7 });
	manager.appendCustomEntry("unrelated", { text: "large historical tool output" });
	manager.appendCustomEntry("sample", { open: 6 });
	const indexedEntries = manager.getBranch().toReversed();
	const source: BranchSource = {
		getLeafId: () => manager.getLeafId(),
		getEntry: (id: string) => {
			const entry = manager.getEntry(id);
			if (entry?.type === "custom" && entry.customType === "unrelated")
				throw new Error("Excluded historical payload was read");
			return entry;
		},
		getBranch: () => manager.getBranch(),
		*iterateBranchMatchingNewestFirst(predicate) {
			for (const entry of indexedEntries) if (predicate(sessionContextEntryMetadata(entry))) yield entry;
		},
	};
	const selected = await selectBranchEntriesCooperatively(source, metadata => metadata.customType === "sample");
	expect(selected.map(entry => (entry.type === "custom" ? entry.data : null))).toEqual([{ open: 7 }, { open: 6 }]);
});
