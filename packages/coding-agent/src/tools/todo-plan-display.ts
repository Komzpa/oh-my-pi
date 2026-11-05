import type { TodoDisplayRequirement } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { SessionEntry } from "../session/session-entries";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the ledger's durable wire projection without depending on an extension implementation. */
export function readTodoDisplayLedger(
	entries: readonly SessionEntry[],
	liveWorkerIds?: ReadonlySet<string>,
): {
	requirements?: TodoDisplayRequirement[];
	auditors: Map<string, string>;
} {
	let ledger: unknown;
	let assignments: unknown;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "requirements_ledger") ledger = entry.data;
		if (entry.customType === "requirements_auditor_assignments") assignments = entry.data;
	}
	const requirements: TodoDisplayRequirement[] = [];
	if (record(ledger) && Array.isArray(ledger.requirements)) {
		for (const item of ledger.requirements) {
			if (!record(item) || typeof item.classification !== "string" || !Array.isArray(item.rows)) continue;
			const rowVerdicts: Record<string, { status: string }> = {};
			if (record(item.rowVerdicts))
				for (const [title, verdict] of Object.entries(item.rowVerdicts)) {
					if (record(verdict) && typeof verdict.status === "string")
						rowVerdicts[title] = { status: verdict.status };
				}
			requirements.push({
				classification: item.classification,
				rows: item.rows.filter((row): row is string => typeof row === "string"),
				rowVerdicts,
			});
		}
	}
	const auditors = new Map<string, string>();
	if (record(assignments) && Array.isArray(assignments.jobs))
		for (const job of assignments.jobs) {
			if (!record(job) || job.agent !== "qa-auditor" || typeof job.workerId !== "string" || !Array.isArray(job.rows))
				continue;
			if (liveWorkerIds && !liveWorkerIds.has(job.workerId)) continue;
			for (const row of job.rows) if (typeof row === "string") auditors.set(row, job.workerId);
		}
	return { requirements: ledger === undefined ? undefined : requirements, auditors };
}
