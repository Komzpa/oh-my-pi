import { expect, test } from "bun:test";
import {
	renderTodoPlanDisplay,
	todoInfraBreaker,
	todoWorkAttempts,
	type TodoReworkAttempt,
} from "../src/tools/todo-schedule";

function failure(cause: string, durationMs = 47): TodoReworkAttempt {
	return {
		attemptId: cause,
		workerName: "PhonePacking-7-3-2",
		resolvedModel: "unresolved",
		effort: "unresolved",
		startedAt: 0,
		finishedAt: durationMs,
		durationMs,
		terminalStatus: "failed",
		deliverablePaths: [],
		infraFailureError: cause,
	};
}

test("sub-second admission deaths do not inflate work attempts; task failures and long failures do", () => {
	const infra = failure('Assigned resources conflict with row "Audit"; keep one writer per resource.');
	const work = failure("assertion failed");
	const long = failure("harness error", 1000);
	expect(todoWorkAttempts([infra, work, long])).toEqual([work, long]);
	expect(todoInfraBreaker([infra, infra])).toBeUndefined();
	expect(todoInfraBreaker([infra, infra, infra])).toBe(infra.infraFailureError);
	expect(todoInfraBreaker([infra, failure("spawn error: missing executable"), infra])).toBeUndefined();
	expect(todoInfraBreaker([infra, infra, work])).toBeUndefined();
});

test("HUD separates legacy infrastructure deaths from work attempts without rewriting their receipts", () => {
	const infra = failure('Assigned resources conflict with row "Audit"; keep one writer per resource.');
	const work = failure("acceptance failed", 60000);
	const history = [work, work, ...Array.from({ length: 60 }, () => infra)];
	const display = renderTodoPlanDisplay(
		[
			{
				name: "Delivery",
				tasks: [{ content: "Phone packing", status: "pending", schedule: { attemptHistory: history } }],
			},
		],
		{ workers: [], owners: new Map() },
		{ now: 1000, paint: (_tone, text) => text },
	);
	expect(display.lines.join("\n")).toContain("infra failures 60");
	expect(display.lines.join("\n")).toContain("attempt 3");
	expect(display.lines.join("\n")).not.toContain("attempt 63");
});
