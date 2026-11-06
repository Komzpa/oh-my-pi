import { expect, test } from "bun:test";
import { SessionManager } from "../../src/session/session-manager";

test("unchanged frames retain selected plans, appends scan only new metadata, edits invalidate", () => {
	const manager = SessionManager.inMemory();
	const id = manager.appendCustomEntry("plan", { status: "pending" });
	let visits = 0;
	const predicate = (entry: { customType?: string }) => {
		visits++;
		return entry.customType === "plan";
	};
	const initial = manager.getBranchMatching(predicate);
	for (let i = 0; i < 100; i++) expect(manager.getBranchMatching(predicate)).toEqual(initial);
	expect(visits).toBe(1);
	// Mutating the returned array must not corrupt the next consumer's snapshot.
	initial.length = 0;
	expect(manager.getBranchMatching(predicate)).toHaveLength(1);
	manager.appendCustomEntry("progress", { elapsed: 1 });
	expect(manager.getBranchMatching(predicate)).toHaveLength(1);
	expect(visits).toBe(2);
	manager.appendCustomEntry("plan", { status: "completed" });
	expect(manager.getBranchMatching(predicate).at(-1)).toMatchObject({ data: { status: "completed" } });
	expect(visits).toBe(3);
	const entry = manager.getEntry(id)!;
	if (entry.type !== "custom") throw new Error("Expected custom entry");
	entry.data = { status: "blocked" };
	manager.updateEntry(entry);
	expect(manager.getBranchMatching(predicate)[0]).toMatchObject({ data: { status: "blocked" } });
	expect(visits).toBeGreaterThan(3);
	manager.branch(id);
	expect(manager.getBranchMatching(predicate)).toHaveLength(1);
});
