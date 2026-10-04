import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { applyOpsToPhases, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

const phases = [
	{
		name: "Delivery",
		schedule: { deadline: "2026-10-05T12:00:00Z" },
		tasks: [
			{
				content: "Implement",
				status: "in_progress" as const,
				details: "Preserve every persisted field",
				notes: ["Do not rebuild from an allowlist"],
				schedule: {
					owner: "RestoreTodoList",
					resources: ["cpu", "reviewer"],
					estimate: { optimistic: 10, likely: 20, pessimistic: 30 },
					evidence: [{ command: "bun test", exit: 0 }],
					dependencies: ["Inspect"],
				},
			},
			{ content: "Review", status: "pending" as const },
			{ content: "Inspect", status: "completed" as const },
		],
	},
	{
		name: "Deferred",
		tasks: [
			{ content: "Publish", status: "blocked" as const, blocker: "Waiting for review" },
			{ content: "Rewrite", status: "abandoned" as const },
		],
	},
];

const plainPhases: TodoPhase[] = [
	{
		name: "Work",
		tasks: [
			{ content: "Current", status: "in_progress" },
			{ content: "Next", status: "pending" },
			{ content: "Finished", status: "completed" },
			{ content: "Dropped", status: "abandoned" },
			{ content: "Waiting", status: "blocked", blocker: "Approval" },
		],
	},
];

describe("exact todo restoration", () => {
	const managers: SessionManager[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.close();
		for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
	});

	for (const source of ["toolResult", "user edit"] as const) {
		for (const [label, expected] of [
			["preserves schedule and every persisted field", phases],
			["round-trips an unchanged list without schedule fields", plainPhases],
		] as const) {
			it(`${source}: ${label}`, async () => {
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-todo-restore-"));
				directories.push(directory);
				const manager = SessionManager.create(directory, directory);
				managers.push(manager);
				if (source === "user edit") {
					manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: expected });
				} else {
					manager.appendMessage({
						role: "toolResult",
						toolCallId: "todo-init",
						toolName: "todo",
						content: [{ type: "text", text: "Todo initialized" }],
						details: { op: "init", phases: expected, storage: "session" },
						isError: false,
						timestamp: Date.now(),
					});
				}
				await manager.ensureOnDisk();
				await manager.close();
				const sessionFile = manager.getSessionFile();
				if (!sessionFile) throw new Error("Expected persisted session file");
				const restoredManager = await SessionManager.open(sessionFile);
				managers.push(restoredManager);
				// Hydration only borrows the branch reader from the owning session.
				const tracker = new TodoTracker({ sessionManager: restoredManager } as TodoTrackerHost);
				tracker.syncFromBranch();
				expect(tracker.phases).toEqual(expected);
				expect(tracker.clonePhases(tracker.phases)).toEqual(expected);
				const result = applyOpsToPhases(tracker.phases, [{ op: "view" }]);
				expect(result.errors).toEqual([]);
				expect(result.phases).toEqual(expected);
			});
		}
	}

	it("defensively copies nested metadata on set, get, and snapshot", () => {
		const original = structuredClone(phases);
		const tracker = new TodoTracker({} as TodoTrackerHost);
		tracker.setPhases(original);
		original[0].tasks[0].schedule!.resources.push("changed input");
		const read = tracker.phases as typeof phases;
		read[0].tasks[0].schedule!.resources.push("changed output");
		const snapshot = tracker.clonePhases(tracker.phases) as typeof phases;
		snapshot[0].tasks[0].schedule!.dependencies.push("changed snapshot");
		expect(tracker.phases).toEqual(phases);
	});
});
