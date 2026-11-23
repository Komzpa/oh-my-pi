import { expect, spyOn, test } from "bun:test";
import { EVAL_STATE_CONTEXT_TYPE } from "@oh-my-pi/pi-coding-agent/eval/state";
import { SessionEntryIndex } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function history(): SessionEntryIndex {
	const index = new SessionEntryIndex();
	for (let i = 0; i < 10000; i++)
		index.insert({
			type: "custom",
			id: `${i}`,
			parentId: i ? `${i - 1}` : null,
			timestamp: "2026-11-07T00:00:00Z",
			customType: "user_todo_edit",
			data: { revision: i },
		});
	return index;
}

test("200 appends and tail reads never decode historical branch payloads, even across GC", async () => {
	const index = history();
	const read = spyOn(index, "get");
	try {
		let view = index.branchView();
		expect(view.length).toBe(10000);
		expect(read).not.toHaveBeenCalled();
		for (let i = 10000; i < 10200; i++) {
			index.insert({
				type: "custom",
				id: `${i}`,
				parentId: `${i - 1}`,
				timestamp: "now",
				customType: "tick",
				data: {},
			});
			expect(index.branchView()).toBe(view);
			expect(view.at(-1)?.id).toBe(`${i}`);
		}
		view = [];
		await Bun.sleep(0);
		Bun.gc(true);
		expect(index.branchView().at(-1)?.id).toBe("10199");
		expect(read.mock.calls.length).toBe(201);
		index.setLeaf("42");
		expect(index.branchView().at(-1)?.id).toBe("42");
		expect(index.branchView().length).toBe(43);
	} finally {
		read.mockRestore();
	}
});

test("latest metadata lookup decodes one matching payload and respects rewind", () => {
	const index = history();
	const read = spyOn(index, "get");
	try {
		expect(index.latestBranchMatching(entry => entry.customType === "user_todo_edit")?.id).toBe("9999");
		expect(read.mock.calls.map(call => call[0])).toEqual(["9999"]);
		index.setLeaf("10");
		expect(index.latestBranchMatching(entry => entry.customType === "user_todo_edit")?.id).toBe("10");
		expect(index.latestBranchMatching(entry => entry.type === "model_change")).toBeUndefined();
		expect(read.mock.calls.map(call => call[0])).toEqual(["9999", "10"]);
	} finally {
		read.mockRestore();
	}
});

// A mirror must ignore hidden eval bookkeeping just as the local session does.
test("conversation tip skips administrative payloads and rejects an inactive sibling", () => {
	const index = history();
	index.insert({
		type: "message",
		id: "user",
		parentId: "9999",
		timestamp: "now",
		message: { role: "user", content: "Current", timestamp: 0 },
	});
	index.insert({
		type: "message",
		id: "eval",
		parentId: "user",
		timestamp: "now",
		message: {
			role: "custom",
			customType: EVAL_STATE_CONTEXT_TYPE,
			content: "State",
			display: false,
			attribution: "agent",
			timestamp: 0,
		},
	});
	const read = spyOn(index, "get");
	try {
		expect(index.conversationTip()?.id).toBe("user");
		expect(read.mock.calls.every(([id]) => id === "eval" || id === "user")).toBe(true);
		index.insert({
			type: "message",
			id: "sibling",
			parentId: "user",
			timestamp: "now",
			message: { role: "user", content: "Another branch", timestamp: 1 },
		});
		index.setLeaf("eval");
		expect(index.conversationTip()).toBeUndefined();
	} finally {
		read.mockRestore();
	}
});

test("lazy branches remain dense arrays for slicing, filtering and enumeration", () => {
	const index = history();
	index.setLeaf("2");
	const view = index.branchView();
	expect(Array.isArray(view)).toBe(true);
	expect(Object.keys(view)).toEqual(["0", "1", "2"]);
	expect(view.slice(1).map(entry => entry.id)).toEqual(["1", "2"]);
	expect(view.filter(entry => entry.parentId === "0").map(entry => entry.id)).toEqual(["1"]);
	expect({ ...view }[1]?.id).toBe("1");
	expect(Reflect.get(view, "01")).toBeUndefined();
	index.setLeaf("1");
	expect(index.branchView().map(entry => entry.id)).toEqual(["0", "1"]);
	expect(view.map(entry => entry.id)).toEqual(["0", "1", "2"]);
});
