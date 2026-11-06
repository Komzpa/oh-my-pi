import type { TodoSchedulePatchPersistedEdit, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { todoNeedsOwnerDecision, type TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";

/** Copy only the edited row; archived rows and their histories stay shared. */
export function patchTodoSchedule(
	phases: readonly TodoPhase[],
	task: string,
	patch: Partial<TodoSchedule>,
	at = Date.now(),
): TodoPhase[] | undefined {
	const matches = phases.flatMap(phase => phase.tasks).filter(row => row.content === task);
	if (matches.length !== 1) return undefined;
	const previous = matches[0]!;
	const row = { ...previous, schedule: { ...previous.schedule, ...structuredClone(patch) } };
	if (patch.deliveryCritic?.verdict === "defects" && patch.review === "redo") {
		row.status = "pending";
		row.blocker = undefined;
	}
	if (todoNeedsOwnerDecision(row.schedule) && row.schedule.executor?.outcome === "completed") {
		row.schedule.review = "user";
		row.schedule.firstDeliveredAt ??= at;
		row.schedule.reviewPagePending = !row.schedule.reviewPage;
	}
	if (
		patch.audit?.verdict === "pass" &&
		!todoNeedsOwnerDecision(row.schedule) &&
		(row.status === "pending" || row.status === "in_progress")
	) {
		row.status = "completed";
		row.blocker = undefined;
		row.schedule.finishedAt ??= at;
	}
	return phases.map(phase =>
		phase.tasks.includes(previous)
			? { ...phase, tasks: phase.tasks.map(candidate => (candidate === previous ? row : candidate)) }
			: phase,
	);
}

/** Preserve field clearing when JSON drops undefined object properties. */
export function buildTodoSchedulePatchEdit(
	task: string,
	patch: Partial<TodoSchedule>,
	at = Date.now(),
): TodoSchedulePatchPersistedEdit {
	const cleared = (Object.keys(patch) as Array<keyof TodoSchedule>).filter(key => patch[key] === undefined);
	return {
		v: 1,
		kind: "schedule_patch",
		at,
		task,
		patch: structuredClone(patch),
		...(cleared.length ? { cleared } : {}),
	};
}
