import { expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { applyOpsToPhases, TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

// Minimized from session 01a0f9b1: full custom checkpoint at line 17035,
// append at 17881, and archive/done at 17935. The session owns hydration;
// this test defends the tool boundary without importing another topic's reducer.
const snapshot: TodoPhase[] = [
	{
		name: "Fixes",
		tasks: [
			{ content: "Add /brrrr strong-models-only routing mode", status: "in_progress" },
			{ content: "Bind row artifact to resource worktree, not owner cwd", status: "in_progress" },
			{ content: "QA delivery and runtime topic on wave 5 install", status: "completed" },
		],
	},
];
const append = { op: "append" as const, phase: "Fixes", items: ["Run peer slash commands and route peer replies"] };
const done = { op: "done", task: "Bind row artifact to resource worktree, not owner cwd" } as const;

function sessionFor(phases: TodoPhase[], entries: SessionEntry[]): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
		sessionManager: { getBranch: () => entries } as unknown as SessionManager,
	};
}
function checkpoint(): SessionEntry {
	return {
		type: "custom",
		customType: "user_todo_edit",
		data: { phases: structuredClone(snapshot) },
		id: "23252e13",
		parentId: null,
		timestamp: "2026-10-05T06:38:25.384Z",
	};
}

test("todo view preserves hydrated compact edits instead of resurrecting the full checkpoint", async () => {
	const applied = applyOpsToPhases(snapshot, [append, done]);
	expect(applied.errors).toEqual([]);
	const hydrated = applied.phases.map(phase => ({
		...phase,
		tasks: phase.tasks.filter(task => task.content !== "QA delivery and runtime topic on wave 5 install"),
	}));
	const entries: SessionEntry[] = [
		checkpoint(),
		{
			type: "message",
			id: "097258b2",
			parentId: "23252e13",
			timestamp: "2026-10-05T08:35:42.253Z",
			message: {
				role: "toolResult",
				toolName: "todo",
				toolCallId: "append",
				content: [],
				isError: false,
				timestamp: 1791189342253,
				details: { op: "append", edit: { v: 1, kind: "op", at: 1791189341108, op: "append", params: append } },
			},
		},
		{
			type: "message",
			id: "a5db1528",
			parentId: "097258b2",
			timestamp: "2026-10-05T08:47:16.120Z",
			message: {
				role: "toolResult",
				toolName: "todo",
				toolCallId: "done",
				content: [],
				isError: false,
				timestamp: 1791190035864,
				details: {
					op: "done",
					edit: {
						v: 1,
						kind: "archive",
						at: 1791190034973,
						operation: { v: 1, kind: "op", at: 1791190034973, op: "done", params: done },
						archivedPhases: [{ name: "Fixes", tasks: [snapshot[0]!.tasks[2]!] }],
					},
				},
			},
		},
	];
	const result = await new TodoTool(sessionFor(hydrated, entries)).execute("view", { op: "view" });
	expect(result.details?.phases).toEqual(hydrated);
});

test("negative control: a session ending at its full checkpoint views the identical plan", async () => {
	const result = await new TodoTool(sessionFor(structuredClone(snapshot), [checkpoint()])).execute("view", {
		op: "view",
	});
	expect(result.details?.phases).toEqual(snapshot);
});
