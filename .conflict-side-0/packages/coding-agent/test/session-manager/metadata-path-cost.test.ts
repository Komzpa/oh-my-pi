import { expect, spyOn, test } from "bun:test";
import { SessionEntryIndex } from "@oh-my-pi/pi-coding-agent/session/session-manager";

test("repeated metadata selections do not revisit disk-only TODO history and observe appended entries", () => {
	const index = new SessionEntryIndex();
	const timestamp = "2026-11-06T00:00:00Z";
	for (let i = 0; i < 1400; i++)
		index.insert(
			{
				type: "custom",
				id: `row-${i}`,
				parentId: i ? `row-${i - 1}` : null,
				timestamp,
				customType: "user_todo_edit",
				data: {},
			},
			i * 100,
			100,
		);
	expect(index.metadataPath().length).toBe(1400);
	const retained = spyOn(index, "retainedEntry");
	try {
		for (let tick = 0; tick < 20; tick++) expect(index.metadataPath().at(-1)?.id).toBe("row-1399");
		expect(retained.mock.calls.length).toBeLessThan(40);
		index.insert(
			{ type: "custom", id: "new", parentId: "row-1399", timestamp, customType: "checkpoint", data: {} },
			140000,
			100,
		);
		expect(index.metadataPath().at(-1)?.id).toBe("new");
		index.setLeaf("row-10");
		expect(index.metadataPath().map(entry => entry.id)).toEqual(Array.from({ length: 11 }, (_, i) => `row-${i}`));
	} finally {
		retained.mockRestore();
	}
});

test("path reads after the whole branch was exposed stay independent of branch length", () => {
	// Live DC 2026-11-06: branchView() exposed every entry and each of the many path reads per
	// frame re-compared all of them (9.4 s of a 30 s profile). Edits are announced via update().
	const index = new SessionEntryIndex();
	const timestamp = "2026-11-06T00:00:00Z";
	for (let i = 0; i < 1400; i++)
		index.insert({
			type: "custom",
			id: `row-${i}`,
			parentId: i ? `row-${i - 1}` : null,
			timestamp,
			customType: "user_todo_edit",
			data: {},
		});
	expect(index.branchView().length).toBe(1400);
	const retained = spyOn(index, "retainedEntry");
	try {
		for (let tick = 0; tick < 50; tick++) expect(index.metadataPath().length).toBe(1400);
		expect(retained.mock.calls.length).toBe(0);
		const middle = index.get("row-700")!;
		if (middle.type !== "custom") throw new Error("expected custom entry");
		middle.customType = "checkpoint";
		index.update(middle);
		expect(
			index
				.metadataPath()
				.filter(entry => entry.customType === "checkpoint")
				.map(entry => entry.id),
		).toEqual(["row-700"]);
	} finally {
		retained.mockRestore();
	}
});
