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
