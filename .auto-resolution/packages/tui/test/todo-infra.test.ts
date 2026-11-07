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
	expect(todoInfraBreaker([infra, failure("spawn error: missing executable"), infra, infra])).toBe(
		infra.infraFailureError,
	);
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

test("HUD resets infra at success, names top cause and excludes restart interruptions", () => {
	const old = failure("spawn error: old");
	const success = { ...failure("ok"), terminalStatus: "completed" as const };
	const current = failure("spawn error: unavailable");
	const restart = {
		...failure("shutdown"),
		interruption: "restart" as const,
		infraFailureLine: "infra failure: shutdown",
	};
	const display = renderTodoPlanDisplay(
		[
			{
				name: "Work",
				tasks: [
					{
						content: "Row",
						status: "pending",
						schedule: {
							attemptHistory: [old, success, current, restart],
							resourceWait: { row: "Holder", workerId: "Holder-1" },
						},
					},
				],
			},
		],
		{ workers: [], owners: new Map() },
		{ now: 1000, paint: (_tone, text) => text },
	);
	const text = display.lines.join("\n");
	expect(text).toContain("infra failures 1 since last success: spawn error: unavailable");
	expect(text).toContain("waiting for Holder (worker Holder-1)");
	expect(text).not.toContain("shutdown");
	expect(todoWorkAttempts([restart])).toEqual([]);
});

test("HUD resource wait stays within terminal cells with long Unicode holder identities", () => {
	const display = renderTodoPlanDisplay(
		[
			{
				name: "Work",
				tasks: [
					{
						content: "Queued row",
						status: "pending",
						schedule: {
							resourceWait: { row: "共享资源".repeat(30), workerId: "Holder-".repeat(30) },
						},
					},
				],
			},
		],
		{ workers: [], owners: new Map() },
		{ width: 40, now: 1000, paint: (_tone, text) => text },
	);
	const row = display.lines.find(line => line.includes("☐"))!;
	expect(row).toContain("waiting for");
	expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
});
