import { prompt } from "@oh-my-pi/pi-utils";
import actionTemplate from "./dispatch-action.md" with { type: "text" };
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export type WakeDemand = { key: string; action: string; churn: boolean; row?: string };
export type WakeReceipt = { key: string; misses: number; action: string; toolCalls: number; mutations: number };

export function wakeDemand(
	phases: TodoScheduleInput,
	running: Set<string>,
	now: number,
	deadline?: number,
	finish?: number,
	questions: Array<{ worker: string; question: string }> = [],
): WakeDemand | undefined {
	const rows = phases
		.flatMap(phase => phase.tasks)
		.filter(row => row.status !== "completed" && row.status !== "abandoned");
	const churn = rows.find(
		row =>
			(row.schedule?.attemptHistory?.filter(
				attempt => attempt.terminalStatus !== "completed" || attempt.rejectionReason,
			).length ?? 0) >= 3 || (row.schedule?.cumulativeReestimateCount ?? row.schedule?.reestimateCount ?? 0) >= 3,
	);
	const workerQuestion = questions[0];
	const question = rows.find(row => row.status === "blocked" && row.schedule?.owner && row.blocker);
	const closed = new Set(
		phases
			.flatMap(phase => phase.tasks)
			.filter(row => row.status === "completed" || row.status === "abandoned")
			.map(row => row.content),
	);
	const ready = rows.find(
		row =>
			row.status !== "blocked" &&
			!running.has(row.schedule?.owner ?? "") &&
			(row.schedule?.dependencies ?? []).every(dep => closed.has(dep)),
	);
	const slipped = rows.length > 0 && deadline !== undefined && Math.max(now, finish ?? 0) > deadline;
	const row = churn ?? question ?? ready ?? (slipped ? rows[0] : undefined);
	if (!row && !workerQuestion) return;
	const kind = churn ? "churn" : workerQuestion || question ? "question" : ready ? "dispatch" : "slip";
	const action = prompt
		.render(actionTemplate, {
			churn: !!churn,
			question: !churn && (!!workerQuestion || !!question),
			ready: !churn && !workerQuestion && !question && !!ready,
			row: row?.content.slice(0, 180),
			owner: workerQuestion?.worker ?? row?.schedule?.owner,
			blocker: (workerQuestion?.question ?? row?.blocker)?.slice(0, 400),
		})
		.trim();
	// Estimates and wall-clock counters cannot erase an ignored CHURN demand.
	return {
		key: Bun.hash(
			JSON.stringify([
				kind,
				row?.content,
				row?.status,
				row?.schedule?.owner,
				row?.schedule?.dependencies,
				row?.blocker,
				workerQuestion,
			]),
		).toString(16),
		action,
		churn: !!churn,
		row: churn?.content,
	};
}

export function countsAsWakeAction(
	toolName: string,
	input: { op?: string; path?: string; tasks?: Array<{ name?: string; task?: string }> } | undefined,
	before: TodoScheduleInput,
	after: TodoScheduleInput,
	target?: string,
): boolean {
	if (toolName === "task") {
		if (!target) return (input?.tasks?.length ?? 0) > 0;
		const row = after.flatMap(phase => phase.tasks).find(row => row.content === target);
		return (
			input?.tasks?.some(
				task => task.task === target || (!!row?.schedule?.owner && task.name === row.schedule.owner),
			) ?? false
		);
	}
	if (toolName === "write" && input?.path?.startsWith("agent://")) return true;
	if (toolName === "ask") return true;
	if (toolName !== "todo") return false;
	const work = (phases: TodoScheduleInput) =>
		phases
			.flatMap(phase => phase.tasks)
			.filter(row => !target || row.content === target)
			.map(row => [row.content, row.status, row.blocker, row.schedule?.owner, row.schedule?.dependencies]);
	return JSON.stringify(work(before)) !== JSON.stringify(work(after));
}
