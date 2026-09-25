// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan } from "./todo-schedule";
import todoDispatch from "./todo_dispatch";

function chainedPlan(rows: number, now: number) {
	return [
		{
			name: "Wait chain",
			tasks: Array.from({ length: rows }, (_, index) => ({
				content: `Row ${index + 1}`,
				status: index === 0 ? "in_progress" : "pending",
				schedule: {
					dependencies: index === 0 ? [] : [`Row ${index}`],
					owner: index === 0 ? "worker-a" : undefined,
					resources: [`lane-${index % 4}`],
					estimate: {
						optimisticSeconds: 60,
						likelySeconds: 180,
						pessimisticSeconds: 420,
						confidence: "medium",
						basis: "wait acknowledgement fixture",
						updatedAt: now,
					},
				},
			})),
		},
	];
}

test("wait is refused once then allowed for an unchanged 400-row chain", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const now = Date.now();
	const phases = chainedPlan(400, now);
	let forecasts = 0;
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "wait"],
		pi: {
			forecastTodoPlan: (...args: Parameters<typeof forecastTodoPlan>) => {
				forecasts++;
				return forecastTodoPlan(...args);
			},
			formatPlanForecast,
			formatTaskForecast,
			getLatestTodoPhasesFromEntries: () => phases,
			readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }),
		},
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctx = {
		cwd: "/tmp/todo-wait-test",
		sessionManager: {
			getHeader: () => ({ id: "wait-once" }),
			getBranch: () => [{ type: "custom", customType: "user_todo_edit", data: { phases } }],
			getSessionFile: () => undefined,
		},
		getAsyncJobSnapshot: () => ({
			running: [
				{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row 1", startTime: now },
			],
			recent: [],
			nonJobAgents: [{ id: "worker-a", live: true }],
		}),
		getTaskMaxConcurrency: () => 20,
		hasPendingMessages: () => false,
		isIdle: () => false,
		setTimeout: () => ({}),
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	const wait = handlers.get("tool_call")!;
	expect(wait({ toolName: "wait", toolCallId: "first", input: {} }, ctx)).toMatchObject({ block: true });
	expect(wait({ toolName: "wait", toolCallId: "repeated", input: {} }, ctx)).toBeUndefined();
	expect(forecasts).toBe(1);
});
