import { expect, test } from "bun:test";
import {
	selectBranchEntriesCooperatively,
	selectLatestBranchEntry,
} from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getLatestTodoPhasesFromEntries, getLiveTodoBranchEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";

test("native todo selection stops at the current snapshot and follows appends and branch moves", () => {
	const manager = SessionManager.inMemory();
	const snapshot = (content: string) =>
		manager.appendCustomEntry("user_todo_edit", {
			phases: [{ name: "Work", tasks: [{ content, status: "pending" }] }],
		});
	const old = snapshot("Old");
	for (let i = 0; i < 150_000; i++) manager.appendCustomEntry("history", {});
	const current = snapshot("Current");
	let visited = 0;
	expect(
		selectLatestBranchEntry(manager, metadata => {
			visited++;
			return metadata.customType === "user_todo_edit";
		})?.id,
	).toBe(current);
	expect(visited).toBe(1);
	const read = () => getLatestTodoPhasesFromEntries(getLiveTodoBranchEntries(manager))[0]?.tasks[0]?.content;
	expect(read()).toBe("Current");
	manager.branch(old);
	expect(read()).toBe("Old");
	snapshot("Sibling");
	expect(read()).toBe("Sibling");
	manager.branch(current);
	expect(read()).toBe("Current");
	manager.resetLeaf();
	expect(getLiveTodoBranchEntries(manager)).toEqual([]);
	expect(selectLatestBranchEntry(manager, () => true)).toBeUndefined();
});

test("receipt windows count branch entries before filtering and preserve chronological order", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "outside window", timestamp: 0 });
	const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	manager.appendCustomEntry("state", {});
	const last = manager.appendMessage({ role: "user", content: "last", timestamp: 2 });
	const messages = (metadata: { type: string }) => metadata.type === "message";
	expect(manager.getBranchTailMatching(3, messages).map(entry => entry.id)).toEqual([first, last]);
	expect(manager.getBranchTailMatching(0, messages)).toEqual([]);
	expect(manager.getBranchTailMatching(-1, messages)).toEqual([]);
	manager.getBranchTailMatching(3, messages).reverse();
	expect(manager.getBranchTailMatching(3, messages).map(entry => entry.id)).toEqual([first, last]);
	manager.branch(first);
	expect(manager.getBranchTailMatching(1, messages).map(entry => entry.id)).toEqual([first]);
});

test("cooperative sparse selection yields before scanning a large native branch", async () => {
	const manager = SessionManager.inMemory();
	const first = manager.appendCustomEntry("target", {});
	for (let i = 0; i < 150_000; i++) manager.appendCustomEntry("unrelated", {});
	let visited = 0;
	const selection = selectBranchEntriesCooperatively(manager, metadata => {
		visited++;
		return metadata.customType === "target";
	});
	await Promise.resolve();
	expect(visited).toBeLessThan(150_000);
	expect((await selection).map(entry => entry.id)).toEqual([first]);
});

test("cooperative traversal returns each entry once when a corrupt parent points to itself", async () => {
	const manager = SessionManager.inMemory();
	const id = manager.appendCustomEntry("target", {});
	manager.getEntry(id)!.parentId = id;
	let reads = 0;
	const source = {
		getBranch: () => manager.getBranch(),
		getLeafId: () => manager.getLeafId(),
		getEntry: (entryId: string) => {
			if (++reads > 2) throw new Error("Repeated cyclic traversal");
			return manager.getEntry(entryId);
		},
	};
	expect((await selectBranchEntriesCooperatively(source, () => true)).map(entry => entry.id)).toEqual([id]);
});
