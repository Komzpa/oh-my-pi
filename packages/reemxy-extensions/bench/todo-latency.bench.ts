// @ts-nocheck -- local performance harness for the Reemxy extension gate.
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan } from "../extensions/todo-schedule";
import todoDispatch from "../extensions/todo_dispatch";

const now = Date.UTC(2026, 8, 25, 16, 0, 0);

function largePlan(rows: number) {
	const tasks = Array.from({ length: rows }, (_, index) => ({
		content: `Latency row ${index + 1}`,
		status: index === 0 ? "in_progress" : "pending",
		schedule: {
			dependencies: index === 0 ? [] : [`Latency row ${index}`],
			owner: index === 0 ? "worker-a" : undefined,
			resources: [`lane-${index % 4}`],
			estimate: {
				optimisticSeconds: 60,
				likelySeconds: 180,
				pessimisticSeconds: 420,
				confidence: "medium",
				basis: "400-row gate benchmark",
				updatedAt: now,
			},
		},
	}));
	return [{ name: "Latency", tasks }];
}

async function gateHarness(rows: number) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const phases = largePlan(rows);
	const branch = [{ type: "custom", customType: "user_todo_edit", data: { phases } }];
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "wait"],
		pi: {
			forecastTodoPlan,
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
		cwd: "/tmp/omp-todo-latency",
		sessionManager: {
			getHeader: () => ({ id: "bench-root" }),
			getBranch: () => branch,
			getSessionFile: () => undefined,
		},
		getAsyncJobSnapshot: () => ({
			running: [
				{
					id: "worker-a",
					agentId: "worker-a",
					type: "task",
					status: "running",
					label: "Latency row 1",
					startTime: now,
				},
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
	return { wait: handlers.get("tool_call")!, ctx };
}

async function timed<T>(run: () => T): Promise<{ milliseconds: number; value: T }> {
	const started = performance.now();
	const value = run();
	return { milliseconds: performance.now() - started, value };
}

const harness = await gateHarness(400);
const first = await timed(() => harness.wait({ toolName: "wait", toolCallId: "first", input: {} }, harness.ctx));
const repeated = await timed(() => harness.wait({ toolName: "wait", toolCallId: "repeated", input: {} }, harness.ctx));
console.log(
	JSON.stringify(
		{
			rows: 400,
			firstGateMilliseconds: first.milliseconds,
			repeatedGateMilliseconds: repeated.milliseconds,
			firstBlocked: first.value?.block === true,
			repeatedAllowed: repeated.value === undefined,
		},
		null,
		2,
	),
);
