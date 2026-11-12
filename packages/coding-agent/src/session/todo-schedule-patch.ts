import type { TodoSchedulePatchPersistedEdit, TodoPhase, TodoItem } from "@oh-my-pi/pi-tui/tools/todo";
import {
	retainTodoDependencyReviews,
	todoAuditOrigin,
	todoSupersededReason,
	todoNeedsOwnerDecision,
	todoAuditResourcesKey,
	type TodoSchedule,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";

/** A resource edit invalidates an automatic audit, but never a human acceptance. */
export function reconcileAuditResourceChange(previous: TodoItem, row: TodoItem): void {
	const before = previous.schedule;
	const after = row.schedule;
	const audit = before?.audit;
	if (
		!before ||
		!after ||
		!audit ||
		after.review === "accepted" ||
		todoAuditResourcesKey(before) === todoAuditResourcesKey(after)
	)
		return;
	// Preserve the old verdict as evidence, bound to the resources it actually checked.
	if (
		after.audit &&
		after.audit.delivery === audit.delivery &&
		after.audit.startedAt === audit.startedAt &&
		after.audit.resourcesKey === undefined
	)
		after.audit = { ...after.audit, resourcesKey: todoAuditResourcesKey(before) };
	delete after.auditBase;
	after.auditRounds = 0;
	const escalation = before.auditEscalation;
	if (escalation && after.auditEscalation === escalation) {
		delete after.auditEscalation;
		if (row.blocker === escalation) {
			delete row.blocker;
			if (row.status === "blocked") row.status = "pending";
		}
		if (after.review === "user" && after.reviewSummary === escalation) {
			delete after.review;
			delete after.reviewSummary;
			after.handoffPending = false;
		}
	}
	if (previous.status === "completed" && audit.verdict === "pass" && audit.agent === "qa-auditor") {
		row.status = "pending";
		delete after.finishedAt;
	}
}

/** Copy only the edited row; archived rows and their histories stay shared. */
export function patchTodoSchedule(
	phases: readonly TodoPhase[],
	task: string,
	patch: Partial<TodoSchedule>,
	at = Date.now(),
	options: { legacyFollowUps?: boolean } = {},
): TodoPhase[] | undefined {
	const matches = phases.flatMap(phase => phase.tasks).filter(row => row.content === task);
	if (matches.length !== 1) return undefined;
	const previous = matches[0]!;
	const retained = { ...previous.schedule };
	retainTodoDependencyReviews(retained);
	const row = { ...previous, schedule: { ...retained, ...structuredClone(patch) } };
	retainTodoDependencyReviews(row.schedule);
	reconcileAuditResourceChange(previous, row);
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
	if (row.schedule.auditOrigin?.resolution === "retarget" && patch.audit && patch.audit.verdict !== "pending") {
		if (patch.audit.verdict === "pass") {
			row.status = "completed";
		} else {
			const origin = row.schedule.auditOrigin;
			const reason = todoSupersededReason(origin);
			row.status = "abandoned";
			row.notes = [...(row.notes ?? []), reason];
			row.schedule.auditOrigin = { ...origin, resolution: "accept" };
			row.schedule.review = "drop";
			row.schedule.progress = { at, evidence: reason };
		}
		row.blocker = undefined;
		row.schedule.finishedAt = at;
		delete row.schedule.auditEscalation;
		delete row.schedule.reviewPagePending;
		row.schedule.handoffPending = false;
	}
	if (!options.legacyFollowUps) {
		const changedFollowUps =
			patch.auditFollowUps &&
			JSON.stringify(patch.auditFollowUps) !== JSON.stringify(previous.schedule?.auditFollowUps);
		if (changedFollowUps) {
			// Advice is evidence on this delivery, not authority for more mandatory work.
			// Keep legacy follow-up rows and their histories intact; only an explicit
			// blocking verdict above can reopen the row being patched.
			row.notes = [...new Set([...(row.notes ?? []), ...row.schedule.auditFollowUps!])];
		}
		const result = phases.map(phase =>
			phase.tasks.includes(previous)
				? { ...phase, tasks: phase.tasks.map(candidate => (candidate === previous ? row : candidate)) }
				: phase,
		);
		return result;
	}
	// Old deltas implicitly created rows; replay them without losing later row history.
	const followUp = `Audit follow-up: ${task}`;
	const changedFollowUps =
		patch.auditFollowUps &&
		JSON.stringify(patch.auditFollowUps) !== JSON.stringify(previous.schedule?.auditFollowUps);
	const actions = changedFollowUps && !row.schedule.auditOrigin?.supersededAt ? row.schedule.auditFollowUps! : [];
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
			schedule: {
				auditOrigin: todoAuditOrigin(previous),
				dependencies: [],
				progress: { at, evidence: actions.join("\n") },
			},
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
					const origin = todoAuditOrigin(row);
					const old = candidate.schedule?.auditOrigin;
					const newDelivery =
						old &&
						(["commit", "branch", "repoPath", "remote"] as const).some(
							key => origin[key] !== undefined && old[key] !== undefined && origin[key] !== old[key],
						);
					if (old?.supersededAt && !newDelivery) return candidate;
					const notes = [...new Set([...(candidate.notes ?? []), ...actions])];
					return {
						...candidate,
						notes,
						status: "pending",
						schedule: {
							...(old?.supersededAt ? { auditOrigin: origin } : candidate.schedule),
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
		adviceOnly: true,
		at,
		task,
		patch: structuredClone(patch),
		...(cleared.length ? { cleared } : {}),
	};
}
