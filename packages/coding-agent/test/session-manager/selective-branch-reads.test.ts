import { expect, it, spyOn } from "bun:test";
import { SessionEntryIndex, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

it("selects branch state in path order and stops a latest read before older checkpoints", async () => {
	const manager = SessionManager.inMemory();
	try {
		const first = manager.appendCustomEntry("checkpoint", { revision: 1 });
		manager.appendCustomEntry("unrelated", { payload: "x".repeat(1024 * 1024) });
		const latest = manager.appendCustomEntry("checkpoint", { revision: 2 });
		const visited: string[] = [];
		const selected = manager.getBranchMatching(metadata => {
			visited.push(metadata.id);
			return metadata.type === "custom" && metadata.customType === "checkpoint";
		});
		expect(selected.map(entry => entry.id)).toEqual([first, latest]);
		expect(visited[0]).toBe(first);
		const newestVisited: string[] = [];
		expect(
			manager.getLatestBranchMatching(metadata => {
				newestVisited.push(metadata.id);
				return metadata.type === "custom" && metadata.customType === "checkpoint";
			})?.id,
		).toBe(latest);
		expect(newestVisited).toEqual([latest]);
		manager.branch(first);
		const sibling = manager.appendCustomEntry("checkpoint", { revision: 3 });
		expect(
			manager
				.getBranchMatching(metadata => metadata.type === "custom" && metadata.customType === "checkpoint")
				.map(entry => entry.id),
		).toEqual([first, sibling]);
		expect(
			manager.getLatestBranchMatching(metadata => metadata.type === "custom" && metadata.customType === "missing"),
		).toBeUndefined();
	} finally {
		await manager.close();
	}
});

it("refreshes announced metadata and parent changes after repeated branch selections", async () => {
	const manager = SessionManager.inMemory();
	try {
		const first = manager.appendCustomEntry("checkpoint", { revision: 1 });
		const middle = manager.appendCustomEntry("unrelated", {});
		const last = manager.appendCustomEntry("checkpoint", { revision: 2 });
		const select = () =>
			manager.getBranchMatching(metadata => metadata.customType === "checkpoint").map(entry => entry.id);
		expect(select()).toEqual([first, last]);
		expect(select()).toEqual([first, last]);
		const retained = manager.getEntry(middle);
		if (!retained || retained.type !== "custom") throw new Error("Missing custom entry");
		retained.customType = "checkpoint";
		manager.updateEntry(retained);
		expect(select()).toEqual([first, middle, last]);
		const tail = manager.getEntry(last);
		if (!tail) throw new Error("Missing tail");
		tail.parentId = first;
		manager.updateEntry(tail);
		expect(select()).toEqual([first, last]);
		expect(select()).toEqual([first, last]);
		manager.branch(middle);
		expect(select()).toEqual([first, middle]);
	} finally {
		await manager.close();
	}
});

it("reads only requested custom payloads across sibling branches", () => {
	const index = new SessionEntryIndex();
	const timestamp = "2026-11-06T00:00:00Z";
	index.insert({
		type: "custom",
		id: "first",
		parentId: null,
		timestamp,
		customType: "lifecycle",
		data: { action: "spawn" },
	});
	index.insert(
		{ type: "custom", id: "archive", parentId: "first", timestamp, customType: "archive", data: {} },
		0,
		100,
	);
	index.insert({
		type: "custom",
		id: "sibling",
		parentId: "first",
		timestamp,
		customType: "lifecycle",
		data: { action: "tombstone" },
	});
	const read = spyOn(index, "get");
	try {
		expect([...index.entriesOfType("custom", "lifecycle")].map(entry => entry.id)).toEqual(["first", "sibling"]);
		expect(read.mock.calls.map(call => call[0])).toEqual(["first", "sibling"]);
	} finally {
		read.mockRestore();
	}
});

it("repeated context subtype selection reads one payload across 300k unrelated notices", async () => {
	const manager = SessionManager.inMemory();
	const id = manager.appendCustomMessageEntry("startup-context", "workspace", false, { cwd: "/fixture" });
	for (let i = 0; i < 300_000; i++) manager.appendCustomMessageEntry("unrelated-notice", "old", false);
	let decoded = 0;
	const original = SessionEntryIndex.prototype.get;
	const read = spyOn(SessionEntryIndex.prototype, "get").mockImplementation(
		function (this: SessionEntryIndex, entryId, retainIdentity) {
			read.mockClear();
			decoded++;
			return original.call(this, entryId, retainIdentity);
		},
	);
	try {
		for (let turn = 0; turn < 10; turn++) {
			expect(
				manager.getLatestBranchMatching(
					metadata =>
						metadata.type === "custom_message" &&
						(metadata.customType === undefined || metadata.customType === "startup-context"),
				)?.id,
			).toBe(id);
		}
		expect(decoded).toBe(10);
	} finally {
		read.mockRestore();
		await manager.close();
	}
}, 60_000);

it("tail receipt queries visit 500 metadata rows and decode only matching payloads in a 300k branch", async () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomMessageEntry("async-result", "outside receipt", false);
	for (let i = 0; i < 300_000; i++) manager.appendCustomEntry("unrelated", { i });
	const receipt = manager.appendCustomMessageEntry("async-result", "current receipt", false);
	let decoded = 0;
	const original = SessionEntryIndex.prototype.get;
	const read = spyOn(SessionEntryIndex.prototype, "get").mockImplementation(
		function (this: SessionEntryIndex, id, retainIdentity) {
			read.mockClear();
			decoded++;
			return original.call(this, id, retainIdentity);
		},
	);
	try {
		for (let turn = 0; turn < 10; turn++) {
			let visited = 0;
			const selected = manager.getBranchTailMatching(500, metadata => {
				visited++;
				return metadata.type === "custom_message";
			});
			expect(visited).toBe(500);
			expect(selected.map(entry => entry.id)).toEqual([receipt]);
		}
		expect(decoded).toBe(10);
	} finally {
		read.mockRestore();
		await manager.close();
	}
}, 60_000);
