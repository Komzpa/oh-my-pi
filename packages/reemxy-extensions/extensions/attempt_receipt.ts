import type { TodoScheduleInputTask } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { prompt } from "@oh-my-pi/pi-utils";
import template from "./attempt-receipt.md" with { type: "text" };

/** Attempt history is durable row state; no receipt is borrowed from a neighboring title or worker. */
export function prepareAttemptBrief(row: TodoScheduleInputTask, task: string): { task: string; refusal?: string } {
	const schedule = row.schedule;
	const previous = [...(schedule?.attemptHistory ?? [])].sort((a, b) => b.finishedAt - a.finishedAt)[0];
	if (!previous && !schedule?.executor?.finishedAt) return { task };
	const findings = previous?.finalReportParagraph?.trim() || schedule?.progress?.evidence?.trim();
	const missing = !findings;
	const receipt = {
		attempt: previous?.attemptId,
		worker: previous?.workerName ?? schedule?.executor?.workerId,
		status: previous?.terminalStatus ?? schedule?.executor?.outcome,
		finishedAt: previous?.finishedAt ?? schedule?.executor?.finishedAt,
		whatExists: {
			commits: previous?.gitCommits ?? schedule?.executor?.gitCommits ?? [],
			paths: previous?.deliverablePaths ?? [],
			findings,
		},
		whatFailed: [
			previous?.rejectionReason,
			previous?.infraFailureLine,
			schedule?.audit?.verdict === "fail" ? schedule.audit.findings : undefined,
		].filter(Boolean),
		openQuestion: row.blocker ?? null,
	};
	const annotation = prompt
		.render(template, { row: row.content, missing, receipt: JSON.stringify(receipt, null, 2) })
		.trim();
	return missing ? { task, refusal: annotation } : { task: `${task}\n\n${annotation}` };
}
