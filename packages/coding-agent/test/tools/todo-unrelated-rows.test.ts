import { describe, expect, it } from "bun:test";
import { applyOpsToPhases } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

function phases(): TodoPhase[] {
	return [
		{
			name: "Phase",
			tasks: [
				{ content: "Bedroom aircon control", status: "in_progress" },
				{ content: "Known-good AC codes diffed against YAP1F encoder", status: "in_progress" },
				{ content: "Protocol-lib YAP1F frames drive Living AC by power", status: "in_progress" },
			],
		},
	];
}

function statusOf(next: TodoPhase[], content: string): string | undefined {
	return next.flatMap(p => p.tasks).find(t => t.content === content)?.status;
}

// Grievance 465: a named-row op must not rewrite unrelated rows.
describe("todo ops leave unrelated rows alone", () => {
	it("start does not demote unrelated in_progress rows to pending", () => {
		const { phases: next, errors } = applyOpsToPhases(phases(), [{ op: "start", task: "Bedroom aircon control" }]);
		expect(statusOf(next, "Known-good AC codes diffed against YAP1F encoder")).toBe("in_progress");
		expect(statusOf(next, "Protocol-lib YAP1F frames drive Living AC by power")).toBe("in_progress");
		expect(errors).toEqual([]);
	});

	it("start marks its pending target in_progress", () => {
		const { phases: next, errors } = applyOpsToPhases(
			[{ name: "Phase", tasks: [{ content: "Target", status: "pending" }] }],
			[{ op: "start", task: "Target" }],
		);
		expect(statusOf(next, "Target")).toBe("in_progress");
		expect(errors).toEqual([]);
	});

	it("unblock does not touch unrelated in_progress rows", () => {
		const base = phases();
		base[0]!.tasks[0]!.status = "blocked";
		const { phases: next } = applyOpsToPhases(base, [{ op: "unblock", task: "Bedroom aircon control" }]);
		expect(statusOf(next, "Known-good AC codes diffed against YAP1F encoder")).toBe("in_progress");
		expect(statusOf(next, "Protocol-lib YAP1F frames drive Living AC by power")).toBe("in_progress");
	});
});
