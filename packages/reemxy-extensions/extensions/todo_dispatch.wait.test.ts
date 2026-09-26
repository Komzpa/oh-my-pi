// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	const first = wait({ toolName: "wait", toolCallId: "first", input: {} }, ctx) as { block?: boolean; reason?: string } | undefined;
	expect(first).toMatchObject({ block: true });
	expect(first?.reason).toMatch(/\b\d+ of \d+ possible worker/);
	expect(wait({ toolName: "wait", toolCallId: "repeated", input: {} }, ctx)).toBeUndefined();
	expect(forecasts).toBe(1);
});

async function waitOnReadyRowWithStaleOwner(): Promise<{ block?: boolean; reason?: string } | undefined> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "todo-wait-ready-"));
	try {
		const now = Date.now();
		const phases = chainedPlan(6, now);
		const tasks = phases[0]!.tasks;
		for (let index = 0; index < 5; index++) {
			const task = tasks[index]!;
			task.content = index === 4 ? "Existing review handoff" : `Running row ${index + 1}`;
			task.status = "in_progress";
			task.schedule.dependencies = [];
			task.schedule.resources = [];
			task.schedule.owner = index === 4 ? "AuthorReviewManifest-2" : `worker-${index + 1}`;
		}
		const ready = tasks[5]!;
		ready.content = "Author full-screen review manifest with CSS deltas";
		ready.status = "in_progress";
		ready.schedule.dependencies = [];
		ready.schedule.resources = [];
		ready.schedule.owner = "AuthorReviewManifest";
		const running = tasks.slice(0, 5).map((task, index) => ({
			id: `task-${index + 1}`,
			agentId: task.schedule.owner,
			type: "task" as const,
			status: "running" as const,
			label: task.content,
			startTime: now,
		}));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
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
			cwd,
			sessionManager: {
				getHeader: () => ({ id: "wait-ready" }),
				getBranch: () => [{ type: "custom", customType: "user_todo_edit", data: { phases } }],
				getSessionFile: () => undefined,
			},
			getAsyncJobSnapshot: () => ({
				running,
				recent: [],
				nonJobAgents: running.map((job) => ({ id: job.agentId, live: true })),
			}),
			getTaskMaxConcurrency: () => 20,
			hasPendingMessages: () => false,
			isIdle: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		return handlers.get("tool_call")!({ toolName: "wait", toolCallId: "ready", input: {} }, ctx) as { block?: boolean; reason?: string } | undefined;
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("one ready row does not imply spare machine capacity", async () => {
	const result = await waitOnReadyRowWithStaleOwner();
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("Author full-screen review manifest with CSS deltas");
	expect(result?.reason).not.toMatch(/\b\d+ of \d+ possible worker/);
});

test("a dead scheduled owner prompts conditional owner repair", async () => {
	const result = await waitOnReadyRowWithStaleOwner();
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain('owner="AuthorReviewManifest"');
	expect(result?.reason).toContain("not running");
	expect(result?.reason).toContain("todo schedule");
	expect(result?.reason).toContain("otherwise start");
});
