import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TodoTracker, type TodoTrackerHost } from "../src/session/todo-tracker";

afterEach(() => mock.restore());

it("reads immutable plan snapshots without per-frame cloning and refreshes after a real edit", () => {
	const tracker = new TodoTracker({} as TodoTrackerHost);
	const phases: TodoPhase[] = [
		{ name: "Ship", tasks: [{ content: "Deliver", status: "pending", notes: ["original"] }] },
	];
	tracker.setPhases(phases);
	const initial = tracker.snapshot;
	const clone = spyOn(globalThis, "structuredClone");
	for (let frame = 0; frame < 100; frame++) {
		expect(tracker.snapshot[0]!.tasks[0]!.status).toBe("pending");
		expect(tracker.snapshot).toBe(initial);
	}
	expect(clone).toHaveBeenCalledTimes(0);
	expect(() => initial[0]!.tasks[0]!.notes!.push("changed")).toThrow();
	phases[0]!.tasks[0]!.status = "completed";
	expect(tracker.snapshot[0]!.tasks[0]!.status).toBe("pending");
	tracker.setPhases(phases);
	expect(tracker.snapshot).not.toBe(initial);
	expect(tracker.snapshot[0]!.tasks[0]!.status).toBe("completed");
	const editable = tracker.phases;
	editable[0]!.tasks[0]!.notes!.push("public copy");
	expect(tracker.snapshot[0]!.tasks[0]!.notes).toEqual(["original"]);
	expect(initial[0]!.tasks[0]!.status).toBe("pending");
});
