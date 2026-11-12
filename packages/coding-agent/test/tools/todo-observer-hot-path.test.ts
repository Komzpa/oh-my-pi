import { afterEach, expect, it, spyOn, mock } from "bun:test";
import type { SessionEntry } from "../../src/session/session-entries";
import { observeLatestTodoPhases, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

afterEach(() => mock.restore());

it("observes unchanged frames without cloning a discarded plan and sees a replacement snapshot", () => {
	const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Ship", status: "pending" }] }];
	const entries: SessionEntry[] = [
		{
			type: "custom",
			customType: USER_TODO_EDIT_CUSTOM_TYPE,
			id: "first",
			parentId: null,
			timestamp: "2026-11-06T00:00:00Z",
			data: { phases },
		},
	];
	const clone = spyOn(globalThis, "structuredClone");
	const statuses: string[] = [];
	for (let frame = 0; frame < 100; frame++) {
		observeLatestTodoPhases(entries, snapshot => statuses.push(snapshot[0]!.tasks[0]!.status));
	}
	expect(statuses).toEqual(Array(100).fill("pending"));
	expect(clone).toHaveBeenCalledTimes(0);
	entries.push({
		type: "custom",
		customType: USER_TODO_EDIT_CUSTOM_TYPE,
		id: "second",
		parentId: "first",
		timestamp: "2026-11-06T00:01:00Z",
		data: { phases: [{ name: "Work", tasks: [{ content: "Ship", status: "completed" }] }] },
	});
	const observed: string[] = [];
	observeLatestTodoPhases(entries, snapshot => observed.push(snapshot[0]!.tasks[0]!.status));
	expect(observed).toEqual(["pending", "completed"]);
	expect(phases[0]!.tasks[0]!.status).toBe("pending");
	expect(clone).toHaveBeenCalledTimes(0);
});
