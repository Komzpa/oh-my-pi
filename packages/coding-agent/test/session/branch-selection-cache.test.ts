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
	const initial = manager.getCachedBranchMatching(predicate);
	for (let i = 0; i < 100; i++) expect(manager.getCachedBranchMatching(predicate)).toEqual(initial);
	expect(visits).toBe(1);
	// Mutating the returned array must not corrupt the next consumer's snapshot.
	expect(() => {
		initial.length = 0;
	}).toThrow();
	expect(manager.getCachedBranchMatching(predicate)).toHaveLength(1);
	manager.appendCustomEntry("progress", { elapsed: 1 });
	expect(manager.getCachedBranchMatching(predicate)).toBe(initial);
	expect(visits).toBe(2);
	manager.appendCustomEntry("plan", { status: "completed" });
	expect(manager.getCachedBranchMatching(predicate).at(-1)).toMatchObject({ data: { status: "completed" } });
	expect(visits).toBe(3);
	const entry = manager.getEntry(id)!;
	if (entry.type !== "custom") throw new Error("Expected custom entry");
	entry.data = { status: "blocked" };
	manager.updateEntry(entry);
	expect(manager.getCachedBranchMatching(predicate)[0]).toMatchObject({ data: { status: "blocked" } });
	expect(visits).toBeGreaterThan(3);
	manager.branch(id);
	expect(manager.getCachedBranchMatching(predicate)).toHaveLength(1);
});

test("ordinary selection observes changed predicate closure state", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("a", {});
	manager.appendCustomEntry("b", {});
	let kind = "a";
	const predicate = (entry: { customType?: string }) => entry.customType === kind;
	expect(manager.getBranchMatching(predicate)[0]).toMatchObject({ customType: "a" });
	kind = "b";
	expect(manager.getBranchMatching(predicate)[0]).toMatchObject({ customType: "b" });
});

test("a prune append invalidates cached tool output without modifying its raw body", () => {
	const manager = SessionManager.inMemory();
	const id = manager.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text: "large body" }],
		isError: false,
		timestamp: 1,
	});
	const predicate = (entry: { type: string }) => entry.type === "message";
	expect(manager.getCachedBranchMatching(predicate)[0]).toMatchObject({
		message: { content: [{ text: "large body" }] },
	});
	manager.appendToolResultPrune([{ entryId: id, notice: "[pruned]" }], 2);
	expect(manager.getCachedBranchMatching(predicate)[0]).toMatchObject({
		message: { content: [{ text: "[pruned]" }] },
	});
	expect(manager.getEntry(id)).toMatchObject({ message: { content: [{ text: "large body" }] } });
});
