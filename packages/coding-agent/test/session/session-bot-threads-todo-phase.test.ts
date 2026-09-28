import { describe, expect, it, vi } from "bun:test";
import { TodoCommandController } from "../../src/modes/controllers/todo-command-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

describe("todo phase command selectors", () => {
	it.each([
		{ command: "done Work", expectedStatus: "completed" },
		{ command: "drop Work", expectedStatus: "abandoned" },
	] as const)("uses the phase selector for /todo $command", async ({ command, expectedStatus }) => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "first row", status: "pending" },
					{ content: "another task", status: "pending" },
				],
			},
			{ name: "Elsewhere", tasks: [{ content: "untouched", status: "pending" }] },
		];
		const setTodoPhases = vi.fn();
		const ctx = {
			agent: { appendMessage: vi.fn() },
			session: { getTodoPhases: () => phases, setTodoPhases },
			sessionManager: {
				appendCustomEntry: vi.fn(),
				appendMessage: vi.fn(),
				getBranch: () => [],
				getCwd: () => "/tmp",
			},
			setTodos: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new TodoCommandController(ctx).handleTodoCommand(command);

		expect(setTodoPhases).toHaveBeenCalledTimes(1);
		const result = setTodoPhases.mock.calls[0]?.[0] as TodoPhase[];
		expect(result[0]?.tasks.map(task => task.status)).toEqual([expectedStatus, expectedStatus]);
		expect(result[1]?.tasks[0]?.content).toBe("untouched");
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});
