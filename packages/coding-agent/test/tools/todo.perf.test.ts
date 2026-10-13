import { expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

const now = Date.UTC(2026, 8, 25, 16, 0, 0);

function largePlan(rows: number): TodoPhase[] {
	return [
		{
			name: "Large plan",
			tasks: Array.from({ length: rows }, (_, index) => {
				const content = `Large row ${String(index + 1).padStart(3, "0")}`;
				return {
					content,
					status: index === rows - 1 ? "in_progress" : index % 9 === 0 ? "pending" : "completed",
					schedule: {
						dependencies: index === 0 ? [] : [`Large row ${String(index).padStart(3, "0")}`],
						owner: index === rows - 1 ? "Worker4" : undefined,
						resources: [`lane-${index % 4}`],
						estimate: {
							optimisticSeconds: 60,
							likelySeconds: 180,
							pessimisticSeconds: 420,
							confidence: "medium",
							basis: "large-plan latency regression fixture",
							updatedAt: now - index,
						},
					},
				};
			}),
		},
	];
}

function sessionFor(phases: TodoPhase[]): ToolSession {
	let current = phases;
	return {
		cwd: "/tmp/todo-perf-test",
		hasUI: false,
		getSessionFile: () => "/tmp/todo-perf-test/session.jsonl",
		getSessionSpawns: () => "*",
		getTodoPhases: () => current,
		setTodoPhases: (next: TodoPhase[]) => {
			current = next;
		},
		settings: Settings.isolated({ "task.maxConcurrency": 4 }),
		sessionManager: { getBranch: () => [] },
	} as unknown as ToolSession;
}

test("schedule stays bounded on a 373-row todo plan", async () => {
	const phases = largePlan(373);
	const tool = new TodoTool(sessionFor(phases));

	const start = performance.now();
	const result = await tool.execute("schedule-large-plan", {
		op: "schedule",
		updates: [
			{
				task: "Large row 373",
				evidence: "perf guard evidence",
				estimate: {
					optimisticSeconds: 60,
					likelySeconds: 180,
					pessimisticSeconds: 420,
					confidence: "medium",
					basis: "perf guard estimate",
				},
			},
		],
	});
	const elapsed = performance.now() - start;

	expect(result.details?.forecast?.rows).toHaveLength(373);
	expect(elapsed).toBeLessThan(100);
});
