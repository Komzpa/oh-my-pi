import { expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isTodoSelectionEntryMetadata, selectBranchEntries } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { getLatestTodoSnapshotIdentity } from "@oh-my-pi/pi-coding-agent/tools/todo";

it("reuses the todo snapshot identity until the selected todo entries change", async () => {
	const manager = SessionManager.inMemory();
	try {
		const phases = [{ name: "A", tasks: [{ content: "one", status: "pending" }] }];
		manager.appendCustomEntry("user_todo_edit", { phases });
		const select = () => selectBranchEntries(manager, isTodoSelectionEntryMetadata);
		const first = getLatestTodoSnapshotIdentity(select());
		expect(first).toBeDefined();
		manager.appendCustomEntry("unrelated", {});
		expect(getLatestTodoSnapshotIdentity(select())).toBe(first);
		manager.appendCustomEntry("user_todo_edit", {
			phases: [{ name: "A", tasks: [{ content: "two", status: "pending" }] }],
		});
		const second = getLatestTodoSnapshotIdentity(select());
		expect(second?.sourceEntryId).not.toBe(first?.sourceEntryId);
		expect(getLatestTodoSnapshotIdentity(select().slice(0, 1))).toEqual(first);
	} finally {
		await manager.close();
	}
});
