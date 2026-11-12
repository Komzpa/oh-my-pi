import {
	todoNeedsOwnerDecision,
	classifyTodoDisplayRow,
	TODO_AUDIT_PROFILES,
	type TodoScheduleInputTask,
	isTodoAwaitingReview,
	parseUserWait,
	todoRowAfterWorker,
	type TodoDisplayContext,
	type TodoPlanForecast,
	type TodoScheduleInput,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { prompt } from "@oh-my-pi/pi-utils";
import notices from "./gate-notices.md" with { type: "text" };

export interface LeadRowInstructionOptions {
	now: number;
	dispatchRefusals?: ReadonlyMap<string, string>;
	forecast?: TodoPlanForecast;
	reviewAnswers?: ReadonlySet<string>;
	userBlockAsked?: ReadonlySet<string>;
}

/** The same row projection as the TODO view, with actions at the event instead of in a runbook. */
export function renderLeadRowInstructions(
	phases: TodoScheduleInput,
	context: TodoDisplayContext,
	options: LeadRowInstructionOptions,
): string {
	const externalGates = new Set<string | undefined>();
	return phases
		.flatMap(phase => phase.tasks)
		.sort((a, b) => Number(todoNeedsOwnerDecision(b.schedule)) - Number(todoNeedsOwnerDecision(a.schedule)))
		.flatMap(row => {
			if ((row.status === "completed" || row.status === "abandoned") && !isTodoAwaitingReview(row)) return [];
			const display = classifyTodoDisplayRow(row, phases, context);
			const after = todoRowAfterWorker(row);
			const forecast = options.forecast?.rows.find(item => item.content === row.content);
			const data: Record<string, unknown> = {
				rowInstruction: true,
				row: JSON.stringify(row.content),
				state: display.state,
			};
			switch (display.state) {
				case "working":
					if (forecast && (forecast.overdue || forecast.reestimateCount >= 2)) {
						data.estimateAction = true;
						data.owner = display.worker?.id;
						data.capReached = forecast.reestimateCount >= 2;
					} else data.waitWorker = true;
					break;
				case "waiting":
					if (display.reason === "cap full") data.waitCapacity = true;
					else {
						data.waitDependency = true;
						data.dependency = display.dependency;
					}
					break;
				case "handoff pending":
					data.handoffAction = true;
					data.reviewPage = row.schedule?.reviewPage;
					break;
				case "awaiting integration": {
					const audit = after?.kind === "verify" ? after.audit : undefined;
					data.integrationAction = true;
					data.integrationCommands = audit?.integrationCommits?.map(commit =>
						`git -C '${audit.repoPath.replaceAll("'", "'\\''")}' merge --no-edit ${commit}`,
					);
					break;
				}
				case "audit queued":
				case "auditing":
				case "verifying":
					data.waitAudit = true;
					break;
				case "ready to close":
					data.closeAction = true;
					break;
				case "needs you":
					data.reviewAction = options.reviewAnswers?.has(row.content) ?? false;
					data.waitReview = !data.reviewAction;
					break;
				case "needs worker":
					if (options.dispatchRefusals?.has(row.content)) {
						data.dispatchRefusal = options.dispatchRefusals.get(row.content);
						break;
					}
					data.workerAction = true;
					data.proofAction =
						after?.kind === "needs-worker" &&
						(after.reason === "audit-failed" || after.reason === "audit-inconclusive");
					data.previous = display.previous ?? row.schedule?.owner;
					data.reason = display.reason;
					data.findings = after?.kind === "needs-worker" ? after.findings : undefined;
					break;
				case "stuck": {
					const userWait = parseUserWait(row.blocker);
					if (userWait) {
						data.askUser = !options.userBlockAsked?.has(row.content);
						data.waitUser = !data.askUser;
						data.question = userWait.question;
					} else if (display.reason?.startsWith("blocked dependency")) {
						data.waitDependency = true;
						data.dependency = display.reason;
					} else {
						data.waitExternal = true;
						data.reason = display.reason;
					}
					break;
				}
				default: {
					const unmapped: never = display.state;
					throw new Error(`Unmapped TODO state: ${unmapped}`);
				}
			}
			if (data.waitExternal) {
				if (externalGates.has(row.blocker)) return [];
				externalGates.add(row.blocker);
				data.row = phases
					.flatMap(phase => phase.tasks)
					.filter(item => item.status === "blocked" && item.blocker === row.blocker)
					.map(item => JSON.stringify(item.content))
					.join(", ");
			}
			return [prompt.render(notices, data).trim()];
		})
		.join("\n");
}

/** A failed/exhausted audit requires an execution/repair worker, not another review. */
export function refuseProofReview(row: TodoScheduleInputTask, agent: unknown, now: number): string | undefined {
	const after = todoRowAfterWorker(row);
	if (
		!TODO_AUDIT_PROFILES.includes(String(agent ?? "")) ||
		after?.kind !== "needs-worker" ||
		(after.reason !== "audit-failed" && after.reason !== "audit-inconclusive")
	)
		return;
	return renderLeadRowInstructions([{ name: "Proof", tasks: [row] }], { workers: [], owners: new Map() }, { now });
}
