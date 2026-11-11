import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ToolCallEvent,
	ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch from "./todo_dispatch";

async function harness() {
	const row = { content: "Produce unique evidence", status: "pending" as const, schedule: { dependencies: [] } };
	const phases: TodoPhase[] = [{ name: "Work", tasks: [row] }];
	const journal: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const hooks = new Map<string, ExtensionHandler<ToolCallEvent, ToolCallEventResult>>();
	await todoDispatch(
		{
			on: (name: string, hook: ExtensionHandler<ToolCallEvent, ToolCallEventResult>) => hooks.set(name, hook),
			getActiveTools: () => ["todo", "task", "read", "wait"],
			appendEntry: (customType: string, data: unknown) => journal.push({ type: "custom", customType, data }),
			sendMessage: () => {},
			pi: {
				...schedule,
				getLatestTodoPhasesFromEntries,
				readGoalDeadline: () => undefined,
				agentPauseGate: { paused: false },
			},
			registerSoftToolRequirementProvider: () => {},
		} as unknown as ExtensionAPI,
		{ reviewPageProbe: async () => 200, reviewPageOpener: () => {} },
	);
	const ctx = {
		cwd: process.cwd(),
		getTodoPreviewConfig: () => ({ enabled: false, paths: [], thresholdMinutes: 15 }),
		sessionManager: {
			getHeader: () => ({ id: "duplicate-row-fixture" }),
			getBranch: () => journal,
			getBranchMatching: (predicate: (entry: { type: string; customType: string }) => boolean) =>
				journal.filter(predicate),
			getLatestBranchMatching: (predicate: (entry: { type: string; customType: string }) => boolean) =>
				journal.findLast(predicate),
			getSessionFile: () => undefined,
		},
		getTodoPhases: () => structuredClone(phases),
		updateTodoSchedule: () => true,
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 20,
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}),
		setInterval: () => ({}),
		clearInterval: () => {},
		clearTimer: () => {},
	} as unknown as ExtensionContext;
	return { row, ctx, hook: hooks.get("tool_call")! };
}

test("registered dispatcher rejects a duplicate writer row before its batch can spawn", async () => {
	const { row, ctx, hook } = await harness();
	const result = await hook(
		{
			type: "tool_call",
			toolName: "task",
			toolCallId: "duplicate",
			input: {
				context: "same exact row",
				tasks: [
					{ name: "FirstEvidence", agent: "task", row: row.content, task: row.content },
					{ name: "SecondEvidence", agent: "task", row: row.content, task: row.content },
				],
			},
		} as ToolCallEvent,
		ctx,
	);
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("Task batch repeats writer row");
});
