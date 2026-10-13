import { describe, expect, it, vi } from "bun:test";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { handleTodoAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

function runtimeWith(phases: TodoPhase[]) {
	const state = { phases, output: [] as string[] };
	const runtime = {
		session: { getTodoPhases: () => state.phases, setTodoPhases: (next: TodoPhase[]) => (state.phases = next) },
		sessionManager: { getBranch: () => [], appendCustomEntry: vi.fn(), getCwd: () => "/tmp" },
		output: async (text: string) => {
			state.output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, state };
}

const command = (args: string) => ({ name: "todo", args }) as unknown as ParsedSlashCommand;

describe("ACP /todo", () => {
	it("shows open rows without metadata and lists closed ones only with all", async () => {
		const { runtime, state } = runtimeWith([
			{
				name: "Work",
				tasks: [
					{ content: "Finished step", status: "completed" },
					{ content: "Build it", status: "pending" },
				],
			},
		]);
		await handleTodoAcp(command(""), runtime);
		expect(state.output.at(-1)).toContain("☐ Build it");
		expect(state.output.at(-1)).not.toContain("Finished step");
		expect(state.output.at(-1)).not.toContain("omp-todo");
		await handleTodoAcp(command("all"), runtime);
		expect(state.output.at(-1)).toContain("☑ Finished step");
	});

	it("bare done closes every open row instead of silently doing nothing", async () => {
		const { runtime, state } = runtimeWith([
			{
				name: "Work",
				tasks: [
					{ content: "A", status: "in_progress" },
					{ content: "B", status: "pending" },
				],
			},
		]);
		await handleTodoAcp(command("done"), runtime);
		expect(state.phases[0]!.tasks.map(task => task.status)).toEqual(["completed", "completed"]);
		expect(state.output.at(-1)).toBe("Marked all tasks completed.");
	});
});
