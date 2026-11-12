import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { dispatchStateEntries, readDispatchTodoPhases, todoStateEntries, updateTodoSchedule } from "./todo_dispatch";

afterEach(() => mock.restore());

test("schedule notification patches only changed rows without cloning the archived plan", () => {
	const phases = [
		{
			name: "Delivery",
			tasks: Array.from({ length: 520 }, (_, index) => ({
				content: `Row ${index}`,
				status: index < 479 ? "completed" : "pending",
				schedule: { review: "user", firstRequirementAt: 1, attemptHistory: [{ evidence: `Receipt ${index}` }] },
			})),
		},
	];
	for (const task of phases[0].tasks) {
		Object.freeze(task.schedule.attemptHistory[0]);
		Object.freeze(task.schedule.attemptHistory);
		Object.freeze(task.schedule);
		Object.freeze(task);
	}
	Object.freeze(phases[0].tasks);
	Object.freeze(phases[0]);
	Object.freeze(phases);
	const patches: Array<{ task: string; patch: unknown }> = [];
	const ctx = {
		getTodoPhases: () => phases,
		updateTodoSchedule: (task: string, patch: unknown) => patches.push({ task, patch }),
	} as unknown as ExtensionContext;
	const nativeClone = globalThis.structuredClone;
	let cloneBytes = 0;
	const clone = spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
		cloneBytes += Buffer.byteLength(JSON.stringify(value));
		return nativeClone(value, options);
	});
	updateTodoSchedule(ctx, current =>
		current.map(phase => ({
			...phase,
			tasks: phase.tasks.map(row =>
				row.content === "Row 519"
					? { ...row, schedule: { ...(row.schedule as Record<string, unknown>), firstRequirementAt: 2 } }
					: row,
			),
		})),
	);
	expect(patches).toEqual([{ task: "Row 519", patch: { firstRequirementAt: 2 } }]);
	expect(phases[0].tasks[519].schedule.firstRequirementAt).toBe(1);
	updateTodoSchedule(ctx, current => current);
	expect(patches).toHaveLength(1);
	expect(clone).toHaveBeenCalledTimes(0);
	expect(cloneBytes).toBe(0);
});

test("live state entry readers reuse the immutable owner snapshot without falling back to the cloning API", () => {
	const phases = Object.freeze([{ name: "Delivery", tasks: [{ content: "Publish", status: "pending" }] }]);
	const ctx = {
		getTodoSnapshot: () => phases,
		getTodoPhases: () => {
			throw new Error("mutable copy requested on notification path");
		},
		sessionManager: { getBranchMatching: () => [] },
	} as unknown as ExtensionContext;
	expect(todoStateEntries(ctx)).toMatchObject([{ data: { phases } }]);
	expect(dispatchStateEntries(ctx)).toMatchObject([{ data: { phases } }]);
});

test("dispatch readers bypass replay only for native snapshots and still apply pending or durable edits", () => {
	const phases: TodoPhase[] = [{ name: "Delivery", tasks: [{ content: "Ship", status: "pending" }] }];
	Object.freeze(phases[0]!.tasks[0]);
	Object.freeze(phases[0]!.tasks);
	Object.freeze(phases[0]);
	Object.freeze(phases);
	const branch = [{ type: "custom", customType: "user_todo_edit", data: { phases } }];
	const ctx = {
		getTodoSnapshot: () => phases,
		sessionManager: { getBranchMatching: () => branch },
	} as unknown as ExtensionContext;
	const replay = () => {
		throw new Error("immutable current snapshot was replayed/copied");
	};
	expect(readDispatchTodoPhases(todoStateEntries(ctx), replay)[0]!.tasks[0]!.status).toBe("pending");
	expect(readDispatchTodoPhases(dispatchStateEntries(ctx), replay)[0]!.tasks[0]!.status).toBe("pending");
	const changed: TodoPhase[] = [{ name: "Delivery", tasks: [{ content: "Ship", status: "completed" }] }];
	const replays: object[] = [];
	const pending = [{ type: "custom", customType: "user_todo_edit", data: { phases: changed } }];
	const pendingEntries = todoStateEntries(ctx, pending);
	const pendingDispatchEntries = dispatchStateEntries(ctx, pending);
	const hostReplay = (entries: never) => {
		replays.push(entries);
		return changed;
	};
	expect(readDispatchTodoPhases(pendingEntries, hostReplay)[0]!.tasks[0]!.status).toBe("completed");
	expect(readDispatchTodoPhases(pendingDispatchEntries, hostReplay)[0]!.tasks[0]!.status).toBe("completed");
	expect(readDispatchTodoPhases(branch, hostReplay)[0]!.tasks[0]!.status).toBe("completed");
	const legacyCtx = { getTodoPhases: () => phases } as unknown as ExtensionContext;
	const legacyEntries = todoStateEntries(legacyCtx);
	expect(readDispatchTodoPhases(legacyEntries, hostReplay)[0]!.tasks[0]!.status).toBe("completed");
	expect(replays).toEqual([pendingEntries, pendingDispatchEntries, branch, legacyEntries]);
	expect(phases[0]!.tasks[0]!.status).toBe("pending");
});
