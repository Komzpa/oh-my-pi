import { expect, test } from "bun:test";
import { parseDeliveryVerdict } from "./delivery_critic";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { todoRowDeliveryKey } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { checkRowAudits, settleRowAuditVerdict } from "./row_audit";
const blocker = { kind: "product_regression", severity: "blocker" as const, evidence: "Save loses the last record" };

test("row auditor defaults legacy nits to later but failing checks and regression kinds block", () => {
	const verdict = { row: "Commit candidate", verdict: "fail" as const, findings: "More assertion coverage", checks: [{ command: "bun test", exitCode: 0 }], screenshots: [] };
	expect(settleRowAuditVerdict(verdict).verdict).toBe("pass");
	expect(settleRowAuditVerdict({ ...verdict, issues: [blocker] })).toMatchObject({ verdict: "fail", findings: expect.stringContaining(blocker.evidence) });
	expect(settleRowAuditVerdict({ ...verdict, checks: [{ command: "bun test", exitCode: 1 }] }).verdict).toBe("fail");
	expect(settleRowAuditVerdict({ ...verdict, verdict: "pass", checks: [{ command: "bun test", exitCode: 1, gate: true }] }).verdict).toBe("fail");
	expect(parseDeliveryVerdict({ verdict: "defects", findings: [{ kind: "broken_gate", evidence: "build exits 1" }] })?.verdict).toBe("defects");
});


test("an audit waiting for its profile cannot reopen a delivery already taken by the critic", async () => {
	const registry = Promise.withResolvers<string | undefined>();
	let row = { content: "Commit candidate", status: "in_progress" as const, schedule: {
		executor: { workerId: "Builder", startedAt: 1, finishedAt: 2, outcome: "completed" as const, gitCommits: [{ commit: "a".repeat(40), repoPath: "/project" }] },
	} };
	let calls = 0;
	const ctx = {
		cwd: "/project", sessionManager: { getHeader: () => ({ id: "audit-critic-race" }), getBranch: () => [] },
		getTodoPhases: () => [{ name: "Delivery", tasks: [row] }],
		updateTodoSchedule: () => true,
		runRowAudit: async () => { calls++; return { details: { results: [] } }; },
	} as unknown as ExtensionContext;
	const pending = checkRowAudits(ctx, { requirementsFor: () => [], readHead: async () => "abc", resolveAuditor: () => registry.promise });
	await Bun.sleep(0);
	row = { ...row, schedule: { ...row.schedule, deliveryCritic: { key: todoRowDeliveryKey(row.schedule), startedAt: 3, verdict: "pending" } } } as typeof row;
	registry.resolve("qa-auditor");
	expect(await pending).toBe(0);
	expect(calls).toBe(0);
});
