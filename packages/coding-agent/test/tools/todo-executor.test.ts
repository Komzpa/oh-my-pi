import { expect, it } from "bun:test";
import { applyTodoExecutorObservation } from "../../src/tools/todo-executor";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

it("persists a linked worker's profile, resolved model and actual lifecycle times on one row", () => {
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "Merge branch", status: "in_progress", schedule: { owner: "MergeWorker" } },
				{ content: "Neighbor", status: "pending", schedule: { owner: "Main" } },
			],
		},
	];
	const started = applyTodoExecutorObservation(phases, {
		workerId: "MergeWorker",
		agentProfile: "luna",
		startedAt: 1000,
	});
	expect(started?.[0]?.tasks[0]?.schedule?.executor).toEqual({
		workerId: "MergeWorker",
		agentProfile: "luna",
		startedAt: 1000,
	});
	const finished = applyTodoExecutorObservation(started!, {
		workerId: "MergeWorker",
		agentProfile: "luna",
		resolvedModel: "openai/gpt-6-luna",
		thinkingLevel: "high",
		startedAt: 1000,
		finishedAt: 2500,
	});
	expect(finished?.[0]?.tasks[0]?.schedule?.executor).toEqual({
		workerId: "MergeWorker",
		agentProfile: "luna",
		resolvedModel: "openai/gpt-6-luna",
		thinkingLevel: "high",
		startedAt: 1000,
		finishedAt: 2500,
	});
	expect(finished?.[0]?.tasks[1]?.schedule?.executor).toBeUndefined();
	expect(
		applyTodoExecutorObservation(finished!, {
			workerId: "MergeWorker",
			agentProfile: "luna",
			startedAt: 1000,
			finishedAt: 2500,
		}),
	).toBeUndefined();
});

it("links an exact task description and declines ambiguous or unrelated descriptions", () => {
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "Review schema", status: "pending" },
				{ content: "Review schema", status: "pending" },
				{ content: "Deploy", status: "pending" },
			],
		},
	];
	expect(
		applyTodoExecutorObservation(phases, { workerId: "A", description: "Review schema", startedAt: 1 }),
	).toBeUndefined();
	expect(
		applyTodoExecutorObservation(phases, { workerId: "A", description: "Unrelated", startedAt: 1 }),
	).toBeUndefined();
	expect(
		applyTodoExecutorObservation(phases, { workerId: "A", description: "Deploy", startedAt: 1 })?.[0]?.tasks[2]
			?.schedule?.executor?.workerId,
	).toBe("A");
});

it("links a worker from task text, assigns owner and starts a pending row", () => {
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "Review API response", status: "pending" },
				{ content: "Review API response and add regression", status: "pending" },
			],
		},
	];

	const updated = applyTodoExecutorObservation(phases, {
		workerId: "Worker-1",
		agentProfile: "task",
		description: "Regression scout",
		taskText: "Please Review API response and add regression before reporting back.",
		startedAt: 10,
		runningWorkerIds: new Set(["Worker-1"]),
	});

	expect(
		updated?.[0]?.tasks.map(task => ({ content: task.content, status: task.status, owner: task.schedule?.owner })),
	).toEqual([
		{ content: "Review API response", status: "pending", owner: undefined },
		{ content: "Review API response and add regression", status: "in_progress", owner: "Worker-1" },
	]);
	expect(updated?.[0]?.tasks[1]?.schedule?.executor).toEqual({
		workerId: "Worker-1",
		agentProfile: "task",
		startedAt: 10,
	});
});

it("does not link a short row title found inside unrelated task text", () => {
	const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Push", status: "pending" }] }];
	expect(
		applyTodoExecutorObservation(phases, {
			workerId: "Worker-1",
			taskText: "Run the six browser shards; do not push anything.",
			startedAt: 10,
			runningWorkerIds: new Set(["Worker-1"]),
		}),
	).toBeUndefined();
});

it("leaves ambiguous task-text matches unchanged", () => {
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "Read logs", status: "pending" },
				{ content: "Read logs", status: "pending" },
			],
		},
	];

	expect(
		applyTodoExecutorObservation(phases, {
			workerId: "Worker-1",
			taskText: "Read logs and report the key failure.",
			startedAt: 10,
			runningWorkerIds: new Set(["Worker-1"]),
		}),
	).toBeUndefined();
});

it("does not take a row owned by another running worker", () => {
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{
					content: "Inspect database migration",
					status: "pending",
					schedule: { owner: "Worker-A" },
				},
			],
		},
	];

	expect(
		applyTodoExecutorObservation(phases, {
			workerId: "Worker-B",
			taskText: "Inspect database migration and summarize blockers.",
			startedAt: 10,
			runningWorkerIds: new Set(["Worker-A", "Worker-B"]),
		}),
	).toBeUndefined();
});

it("records terminal outcome without closing the row", () => {
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{
					content: "Run preflight",
					status: "in_progress",
					schedule: {
						owner: "Worker-1",
						executor: { workerId: "Worker-1", agentProfile: "task", startedAt: 10 },
					},
				},
			],
		},
	];

	const updated = applyTodoExecutorObservation(phases, {
		workerId: "Worker-1",
		agentProfile: "task",
		startedAt: 10,
		finishedAt: 20,
		outcome: "failed",
		runningWorkerIds: new Set(["Worker-1"]),
	});

	expect(updated?.[0]?.tasks[0]).toMatchObject({
		content: "Run preflight",
		status: "in_progress",
		schedule: {
			owner: "Worker-1",
			executor: { workerId: "Worker-1", agentProfile: "task", startedAt: 10, finishedAt: 20, outcome: "failed" },
		},
	});
});
