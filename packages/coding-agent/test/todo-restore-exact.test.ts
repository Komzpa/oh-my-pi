import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { applyOpsToPhases, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

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
					estimate: {
						optimisticSeconds: 10,
						likelySeconds: 20,
						pessimisticSeconds: 30,
						confidence: "high",
						basis: "Restore test fixture",
						updatedAt: 1_725_000_000_000,
					},
					progress: { at: 1_725_000_000_000, evidence: "bun test exited 0" },
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
] as unknown as TodoPhase[];

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

	it("restores committed compact edits, renames and archives after a restart checkpoint", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-todo-restart-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, directory);
		managers.push(manager);
		const snapshot: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "Peer routing", status: "completed" },
					{ content: "Obsolete", status: "abandoned" },
					{ content: "Restore", status: "in_progress" },
					{ content: "Restart wave 10", status: "pending" },
				],
			},
		];
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: snapshot });
		const at = 1_791_200_000_000;
		// Successful old calls can overlap already-replayed rows after a stale view reset.
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			edit: {
				v: 1,
				kind: "op",
				at,
				op: "append",
				params: { op: "append", phase: "Work", items: ["Peer routing", "New work"] },
			},
		});
		manager.appendMessage({
			role: "toolResult",
			toolName: "todo",
			toolCallId: "archive",
			content: [],
			isError: false,
			timestamp: at,
			details: {
				op: "drop",
				edit: {
					v: 1,
					kind: "archive",
					at,
					operation: {
						v: 1,
						kind: "op",
						at,
						op: "drop",
						params: { op: "drop", items: ["Already archived", "Obsolete"] },
					},
					archivedPhases: [{ name: "Work", tasks: [snapshot[0]!.tasks[1]!] }],
				},
			},
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			edit: { v: 1, kind: "op", at, op: "done", params: { op: "done", task: "Restore" } },
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			edit: {
				v: 1,
				kind: "op",
				at,
				op: "schedule",
				params: { op: "schedule", updates: [{ task: "Restart wave 10", content: "Restart wave 11" }] },
			},
		});
		manager.appendCustomEntry("restart_request_transition", { record: { state: "checkpointed" } });
		await manager.ensureOnDisk();
		await manager.close();
		const restored = await SessionManager.open(manager.getSessionFile()!);
		managers.push(restored);
		const tracker = new TodoTracker({ sessionManager: restored } as TodoTrackerHost);
		tracker.syncFromBranch();
		const rows = tracker.phases.flatMap(phase =>
			phase.tasks.map(task => ({ content: task.content, status: task.status })),
		);
		expect(rows).toEqual([
			{ content: "Peer routing", status: "completed" },
			{ content: "Restore", status: "completed" },
			{ content: "Restart wave 11", status: "in_progress" },
			{ content: "New work", status: "pending" },
		]);
	});

	it("replays new rows from a committed append overlapping an existing title", () => {
		const manager = SessionManager.inMemory(import.meta.dir);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: "Existing", status: "in_progress" }] }],
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			edit: {
				v: 1,
				kind: "op",
				at: 1,
				op: "append",
				params: { op: "append", phase: "Work", items: ["Existing", "New"] },
			},
		});
		const tracker = new TodoTracker({ sessionManager: manager } as TodoTrackerHost);
		tracker.syncFromBranch();
		expect(tracker.phases[0]!.tasks.map(task => task.content)).toEqual(["Existing", "New"]);
	});

	it("replays committed archive removals when an operation target is already absent", () => {
		const manager = SessionManager.inMemory(import.meta.dir);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: "Obsolete", status: "abandoned" }] }],
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			edit: {
				v: 1,
				kind: "archive",
				at: 1,
				operation: { v: 1, kind: "op", at: 1, op: "done", params: { op: "done", task: "Absent" } },
				archivedPhases: [{ name: "Work", tasks: [{ content: "Obsolete", status: "abandoned" }] }],
			},
		});
		const tracker = new TodoTracker({ sessionManager: manager } as TodoTrackerHost);
		tracker.syncFromBranch();
		expect(tracker.phases).toEqual([]);
	});

	it("defensively copies nested metadata on set, get, and snapshot", () => {
		const original = structuredClone(phases);
		const tracker = new TodoTracker({} as TodoTrackerHost);
		tracker.setPhases(original);
		const scheduleOf = (task: TodoItem) => {
			const schedule = task.schedule;
			if (!schedule?.resources || !schedule.dependencies) throw new Error("expected scheduled task metadata");
			return schedule;
		};
		scheduleOf(original[0]!.tasks[0]!).resources!.push("changed input");
		const read = tracker.phases as typeof phases;
		scheduleOf(read[0]!.tasks[0]!).resources!.push("changed output");
		const snapshot = tracker.clonePhases(tracker.phases) as typeof phases;
		scheduleOf(snapshot[0]!.tasks[0]!).dependencies!.push("changed snapshot");
		expect(tracker.phases).toEqual(phases);
	});
});
