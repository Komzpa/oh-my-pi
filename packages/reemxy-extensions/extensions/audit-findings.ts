import type { TodoSchedule, TodoAuditFinding } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export type AuditFinding = TodoAuditFinding;

/** Legacy generic defects are advisory; only explicit regression/gate kinds default to blocking. */
export function findingSeverity(finding: AuditFinding): "blocker" | "later" {
	return finding.severity ?? (["regression", "product_regression", "broken_gate", "broken_build", "broken_test", "data_loss", "wrong_model_numbers"].includes(finding.kind) ? "blocker" : "later");
}

export function auditFindingPatch(schedule: TodoSchedule, findings: AuditFinding[], base: string): Partial<TodoSchedule> {
	const blockers = findings.filter(finding => findingSeverity(finding) === "blocker");
	const rounds = (schedule.auditRounds ?? 0) + (blockers.length ? 1 : 0);
	return {
		auditRounds: rounds,
		auditBase: base,
		auditEscalation: blockers.length && rounds > 2 ? blockers.map(finding => finding.evidence).join("\n") : undefined,
		auditFollowUps: [...new Set([
			...(schedule.auditFollowUps ?? []),
			...findings.filter(finding => findingSeverity(finding) === "later").map(finding =>
				finding.action?.trim() || `Inspect and correct ${finding.kind}: ${finding.evidence}`),
		])],
	};
}
