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
	if (patch.auditEscalation) {
		row.status = "blocked";
		row.blocker = patch.auditEscalation;
		row.schedule.review = "user";
		row.schedule.handoffPending = true;
		row.schedule.reviewSummary = patch.auditEscalation;
		row.schedule.firstDeliveredAt ??= at;
	}
	if (!patch.auditEscalation && patch.deliveryCritic?.verdict === "defects" && patch.review === "redo") {
		row.status = "pending";
		row.blocker = undefined;
	}
	if (todoNeedsOwnerDecision(row.schedule) && row.schedule.executor?.outcome === "completed") {
		row.schedule.review = "user";
		row.schedule.firstDeliveredAt ??= at;
		row.schedule.reviewPagePending = !row.schedule.reviewPage;
	}
	if (
		(patch.audit?.verdict === "pass" || patch.deliveryCritic?.verdict === "clean") &&
		!row.schedule.auditEscalation &&
		!todoNeedsOwnerDecision(row.schedule) &&
		(row.status === "pending" || row.status === "in_progress")
	) {
		row.status = "completed";
		row.blocker = undefined;
		row.schedule.finishedAt ??= at;
	}
	const followUp = `Audit follow-up: ${task}`;
	const changedFollowUps =
		patch.auditFollowUps &&
		JSON.stringify(patch.auditFollowUps) !== JSON.stringify(previous.schedule?.auditFollowUps);
	const actions = changedFollowUps ? row.schedule.auditFollowUps! : [];
	// Existing sessions contain generated follow-ups without a lineage field. Keep
	// their new findings on that actionable row instead of nesting follow-ups.
	if (actions.length && task.startsWith("Audit follow-up: ")) {
		row.notes = [...new Set([...(previous.notes ?? []), ...actions])];
		row.schedule.progress = { at, evidence: row.notes.join("\n") };
		if (!row.schedule.auditEscalation) {
			row.status = "pending";
			row.blocker = undefined;
		}
		return phases.map(phase =>
			phase.tasks.includes(previous)
				? { ...phase, tasks: phase.tasks.map(candidate => (candidate === previous ? row : candidate)) }
				: phase,
		);
	}
	const existing = phases.flatMap(phase => phase.tasks).some(candidate => candidate.content === followUp);
	const result = phases.map(phase =>
		phase.tasks.includes(previous)
			? { ...phase, tasks: phase.tasks.map(candidate => (candidate === previous ? row : candidate)) }
			: phase,
	);
	if (actions.length && !existing) {
		const followUpRow = {
			content: followUp,
			notes: actions,
			status: "pending" as const,
			schedule: { dependencies: [], progress: { at, evidence: actions.join("\n") } },
		};
		const index = result.findIndex(phase => phase.name === "Later");
		if (index < 0) result.push({ name: "Later", tasks: [followUpRow] });
		else result[index] = { ...result[index]!, tasks: [...result[index]!.tasks, followUpRow] };
	} else if (actions.length) {
		for (let index = 0; index < result.length; index++) {
			const phase = result[index]!;
			result[index] = {
				...phase,
				tasks: phase.tasks.map(candidate => {
					if (candidate.content !== followUp) return candidate;
					const notes = [...new Set([...(candidate.notes ?? []), ...actions])];
					return {
						...candidate,
						notes,
						status: "pending",
						schedule: {
							...candidate.schedule,
							dependencies: [],
							progress: { at, evidence: notes.join("\n") },
						},
					};
				}),
			};
		}
	}
	return result;
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
