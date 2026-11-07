import { expect, test } from "bun:test";
import { selectBranchEntriesCooperatively } from "../src/session/branch-selection";
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
