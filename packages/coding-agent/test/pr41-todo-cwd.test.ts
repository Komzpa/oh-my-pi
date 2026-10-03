import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { applyOpsToPhases, TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";

describe("PR #41 todo artifact cwd", () => {
	it("keeps sequential execution cwd local and does not leak it into standalone todo ops", async () => {
		const makeSession = (cwd: string) => {
			let phases: Parameters<NonNullable<ToolSession["setTodoPhases"]>>[0] = [];
			return {
				session: {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					settings: Settings.isolated(),
					getSessionSpawns: () => "*",
					getTodoPhases: () => phases,
					setTodoPhases: next => {
						phases = next;
					},
				} satisfies ToolSession,
				getPhases: () => phases,
			};
		};

		const first = makeSession("/tmp/pr41-first-checkout");
		await new TodoTool(first.session).execute("first", { op: "init", items: ["First row"] });
		expect(first.getPhases()[0]?.tasks[0]?.artifactCwd).toBe("/tmp/pr41-first-checkout");

		const second = makeSession("/tmp/pr41-second-checkout");
		await new TodoTool(second.session).execute("second", { op: "init", items: ["Second row"] });
		expect(second.getPhases()[0]?.tasks[0]?.artifactCwd).toBe("/tmp/pr41-second-checkout");
		expect(first.getPhases()[0]?.tasks[0]?.artifactCwd).toBe("/tmp/pr41-first-checkout");

		const standalone = applyOpsToPhases([], [{ op: "init", items: ["Independent row"] } as never]);
		expect(standalone.phases[0]?.tasks[0]?.artifactCwd).toBeUndefined();
	});
});
