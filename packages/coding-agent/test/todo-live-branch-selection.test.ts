import { expect, test } from "bun:test";
import {
	sessionContextEntryMetadata,
	type BranchSource,
	type SessionContextEntryMetadata,
} from "../src/session/branch-selection";
import type { SessionEntry } from "../src/session/session-entries";
import { getLatestTodoPhasesFromEntries, getLiveTodoBranchEntries } from "../src/tools/todo";

function entry(id: string, data: unknown, customType = "user_todo_edit"): SessionEntry {
	return { id, type: "custom", parentId: null, timestamp: "2026-11-07T00:00:00Z", customType, data };
}

test("live plan replay reads only snapshot, delta and HUD despite long obsolete todo history", () => {
	const snapshot = entry("snapshot", {
		phases: [{ name: "Ship", tasks: [{ content: "Deliver", status: "pending" }] }],
	});
	const delta = entry("delta", {
		edit: { v: 1, kind: "schedule_patch", at: 1, task: "Deliver", patch: { owner: "Worker" } },
	});
	const hud = entry("hud", { visibility: "revealed" }, "todo_hud_state");
	const history = [...Array.from({ length: 7000 }, (_, i) => entry(`old-${i}`, { phases: [] })), snapshot, delta, hud];
	let decoded = 0;
	const manager: BranchSource = {
		getBranch() {
			throw new Error("full branch read");
		},
		getBranchMatching() {
			throw new Error("full selection read");
		},
		*iterateBranchMatchingNewestFirst(predicate: (metadata: SessionContextEntryMetadata) => boolean) {
			for (let i = history.length - 1; i >= 0; i--) {
				const value = history[i]!;
				if (predicate(sessionContextEntryMetadata(value))) {
					decoded++;
					yield value;
				}
			}
		},
	};
	const selected = getLiveTodoBranchEntries(manager);
	expect(selected.map(value => value.id)).toEqual(["snapshot", "delta", "hud"]);
	expect(getLatestTodoPhasesFromEntries(selected)[0]?.tasks[0]?.schedule?.owner).toBe("Worker");
	expect(decoded).toBe(3);
	history.push(entry("clear", { phases: [] }));
	expect(getLatestTodoPhasesFromEntries(getLiveTodoBranchEntries(manager))).toEqual([]);
	expect(decoded).toBe(4);
});

test("legacy branch sources preserve compact edits after their latest full snapshot", () => {
	const snapshot = entry("snapshot", {
		phases: [{ name: "Ship", tasks: [{ content: "Deliver", status: "pending" }] }],
	});
	const delta = entry("delta", {
		edit: { v: 1, kind: "schedule_patch", at: 1, task: "Deliver", patch: { owner: "Worker" } },
	});
	const manager = { getBranch: () => [entry("old", { phases: [] }), snapshot, delta] };
	expect(getLatestTodoPhasesFromEntries(getLiveTodoBranchEntries(manager))[0]?.tasks[0]?.schedule?.owner).toBe(
		"Worker",
	);
});
