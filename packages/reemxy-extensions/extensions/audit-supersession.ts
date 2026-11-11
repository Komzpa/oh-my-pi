import * as path from "node:path";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import {
	todoAuditOrigin,
	todoAuditTarget,
	todoSupersededReason,
	type TodoAuditOrigin,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";

const PREFIX = "Audit follow-up: ";
export function auditLineage(row: TodoItem, rows: readonly TodoItem[]): TodoAuditOrigin | undefined {
	if (row.schedule?.auditOrigin) return row.schedule.auditOrigin;
	if (!row.content.startsWith(PREFIX)) return;
	const title = row.content.slice(PREFIX.length);
	const parent = rows.find(candidate => candidate.content === title);
	return todoAuditOrigin(parent ?? { content: title });
}

/** Conservative feasibility: a finding must carry a structured file resource that exists inside this checkout. */
export async function checkableAuditFinding(row: TodoItem, cwd: string): Promise<boolean> {
	for (const resource of row.schedule?.resources ?? []) {
		const file = path.resolve(cwd, resource);
		if (file.startsWith(`${path.resolve(cwd)}${path.sep}`) && (await Bun.file(file).exists())) return true;
	}
	return false;
}

export function reconcileSupersededAudit(
	row: TodoItem,
	origin: TodoAuditOrigin,
	head: string,
	feasible: boolean,
	now: number,
	currentRepo = origin.repoPath,
): TodoItem {
	if (["completed", "abandoned"].includes(row.status)) return row;
	const schedule = row.schedule ?? {};
	const old = todoAuditTarget(origin);
	if (origin.resolution === "retarget") {
		const attempted =
			(schedule.attemptHistory?.length ?? 0) > (origin.attemptsBefore ?? 0) ||
			schedule.executor?.finishedAt !== undefined;
		const verdict = schedule.audit?.verdict;
		if (!attempted && !["fail", "inconclusive", "omitted", "unavailable"].includes(verdict ?? "")) return row;
		if (schedule.executor?.outcome === "completed" && (!verdict || verdict === "pass"))
			return { ...row, status: "completed", blocker: undefined, schedule: { ...schedule, finishedAt: now } };
	} else if (feasible && !origin.parent.startsWith("Push:")) {
		const note = `${old} merged/removed; verify on current HEAD; do not look for the old PR/branch`;
		return {
			...row,
			status: "pending",
			blocker: undefined,
			notes: [...(row.notes ?? []), note],
			schedule: {
				...schedule,
				auditOrigin: {
					...origin,
					supersededAt: now,
					retargetHead: head,
					attemptsBefore: schedule.attemptHistory?.length ?? 0,
					resolution: "retarget",
				},
				finishedAt: undefined,
				previewTracked: false,
				previewPending: false,
				auditBase: undefined,
				readOnly: true,
				owner: undefined,
				ownerReadOnly: undefined,
				dependencies: [],
				resources: [`git:${currentRepo}@${head}`],
				executor: undefined,
				audit: undefined,
				deliveryCritic: undefined,
				auditEscalation: undefined,
				auditFollowUps: undefined,
				review: undefined,
				reviewSummary: undefined,
				handoffPending: false,
				reviewPagePending: false,
				estimate: {
					optimisticSeconds: 30,
					likelySeconds: 60,
					pessimisticSeconds: 120,
					confidence: "low",
					basis: note,
					updatedAt: now,
				},
				progress: { at: now, evidence: [...(row.notes ?? []), note].join("\n") },
			},
		};
	}
	const reason = todoSupersededReason(origin);
	return {
		...row,
		status: "abandoned",
		blocker: undefined,
		notes: [...(row.notes ?? []), reason],
		schedule: {
			...schedule,
			auditOrigin: { ...origin, supersededAt: origin.supersededAt ?? now, resolution: "accept" },
			finishedAt: now,
			review: "drop",
			auditEscalation: undefined,
			handoffPending: false,
			reviewPagePending: false,
			progress: { at: now, evidence: reason },
		},
	};
}

/** Retargets are read-only one-shot checks, never a source of backlog pressure. */
export function withoutSupersededAudits(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		...phase,
		tasks: phase.tasks.filter(row => !row.schedule?.auditOrigin?.supersededAt),
	}));
}
