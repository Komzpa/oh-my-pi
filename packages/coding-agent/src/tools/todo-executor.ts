import { todoInfraBreaker } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import {
	todoEstimateMeanSeconds,
	type TodoReworkAttempt,
	type TodoSchedule,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { stripOmpCollisionSuffixChain } from "../task/id-collision";

export interface TodoExecutorObservation {
	workerId: string;
	row?: string;
	agentProfile?: string;
	description?: string;
	taskText?: string;
	resolvedModel?: string;
	thinkingLevel?: string;
	startedAt: number;
	finishedAt?: number;
	outcome?: "completed" | "failed" | "aborted";
	runningWorkerIds?: ReadonlySet<string>;
}

const MIN_CONTAINED_TITLE = 24;

function isOpenStatus(status: TodoPhase["tasks"][number]["status"]): boolean {
	return status !== "completed" && status !== "abandoned";
}

function isOwnedByAnotherRunningWorker(
	task: TodoPhase["tasks"][number],
	observation: Pick<TodoExecutorObservation, "workerId" | "runningWorkerIds">,
): boolean {
	return getRecordedTodoWorkerIds(task).some(
		workerId => workerId !== observation.workerId && (observation.runningWorkerIds?.has(workerId) ?? false),
	);
}

function getRecordedTodoWorkerIds(task: TodoPhase["tasks"][number]): string[] {
	const ids = [...(task.schedule?.workerIds ?? []), task.schedule?.executor?.workerId, task.schedule?.owner].filter(
		(workerId): workerId is string => typeof workerId === "string" && workerId.length > 0,
	);
	return [...new Set(ids)];
}

function hasSameOmpCollisionBase(workerId: string, recordedWorkerId: string): boolean {
	return stripOmpCollisionSuffixChain(workerId) === stripOmpCollisionSuffixChain(recordedWorkerId);
}

function matchesRecordedTodoWorkerId(
	recordedWorkerId: string,
	observation: Pick<TodoExecutorObservation, "workerId" | "runningWorkerIds">,
): boolean {
	if (recordedWorkerId === observation.workerId) return true;
	return (
		observation.runningWorkerIds !== undefined &&
		!observation.runningWorkerIds.has(recordedWorkerId) &&
		hasSameOmpCollisionBase(observation.workerId, recordedWorkerId)
	);
}

export function todoMatchesObservedWorker(
	task: TodoPhase["tasks"][number],
	observation: Pick<TodoExecutorObservation, "workerId" | "runningWorkerIds">,
): boolean {
	return getRecordedTodoWorkerIds(task).some(workerId => matchesRecordedTodoWorkerId(workerId, observation));
}

function selectUniqueLongest<T extends { content: string }>(tasks: T[]): T | undefined {
	if (tasks.length === 0) return undefined;
	let longest = 0;
	for (const task of tasks) longest = Math.max(longest, task.content.trim().length);
	const longestTasks = tasks.filter(task => task.content.trim().length === longest);
	return longestTasks.length === 1 ? longestTasks[0] : undefined;
}

/** Resolve our packet's Row line, including legacy packets with trailing prose. */
export function taskPacketRow(taskText: string | undefined, contents: readonly string[]): string | undefined {
	const target = taskText?.split(/^# Target\s*$/m)[1]?.split(/^# /m)[0];
	const line = target?.match(/^Row:\s*(.+)$/m)?.[1]?.trim();
	if (!line) return undefined;
	if (contents.includes(line)) return line;
	return selectUniqueLongest(contents.filter(content => line.startsWith(`${content}. `)).map(content => ({ content })))
		?.content;
}

export function validateTodoExecutorRow(phases: readonly TodoPhase[], row: string): string | undefined {
	const matches = phases.flatMap(phase => phase.tasks).filter(task => task.content === row);
	if (!matches.length) return `Task row does not exist: ${row}`;
	if (matches.length !== 1) return `Task row is ambiguous: ${row}`;
	if (!isOpenStatus(matches[0].status)) return `Task row is closed: ${row}`;
	return undefined;
}

export function findTodoExecutorTarget(
	phases: readonly TodoPhase[],
	observation: TodoExecutorObservation,
): TodoPhase["tasks"][number] | undefined {
	const allTasks = phases.flatMap(phase => phase.tasks);
	const row =
		observation.row ??
		taskPacketRow(
			observation.taskText,
			allTasks.map(task => task.content),
		);
	if (row !== undefined) {
		const matches = allTasks.filter(task => task.content === row && isOpenStatus(task.status));
		return matches.length === 1 ? matches[0] : undefined;
	}
	const open = allTasks.filter(task => isOpenStatus(task.status));
	// A runtime review can share a writer's collision base or appear in its history.
	// Only a current exact assignment (or the explicit row above) staffs a reviewer.
	const review = ["reviewer", "qa-auditor"].includes(observation.agentProfile ?? "");
	const existing = open.filter(task =>
		review
			? task.schedule?.owner === observation.workerId || task.schedule?.executor?.workerId === observation.workerId
			: todoMatchesObservedWorker(task, observation),
	);
	if (existing.length > 0) return existing.length === 1 ? existing[0] : undefined;

	// Runtime reviews mention the row as their subject, not as an execution assignment.
	// An explicit row/owner binding above still permits a deliberately staffed review row.
	if (review) return undefined;
	const openTasks = open.filter(task => !isOwnedByAnotherRunningWorker(task, observation));
	const description = observation.description?.trim();
	if (description) {
		const exactDescription = openTasks.filter(task => task.content.trim() === description);
		if (exactDescription.length > 0) return exactDescription.length === 1 ? exactDescription[0] : undefined;
	}

	const sources = [observation.taskText, observation.description]
		.map(source => source?.trim())
		.filter((source): source is string => Boolean(source));
	const contains = openTasks.filter(task => {
		const content = task.content.trim();
		// A short title ("Push", "Commit") also occurs in unrelated task text; only a distinctive one links.
		return content.length >= MIN_CONTAINED_TITLE && sources.some(source => source.includes(content));
	});
	return selectUniqueLongest(contains);
}

/** Attach an observed worker only when one row identifies it unambiguously. */
export function applyTodoExecutorObservation(
	phases: readonly TodoPhase[],
	observation: TodoExecutorObservation,
): TodoPhase[] | undefined {
	const target = findTodoExecutorTarget(phases, observation);
	if (!target) return undefined;
	const previous = target.schedule?.executor;
	const carriedPrevious =
		previous?.workerId === observation.workerId && previous.startedAt === observation.startedAt
			? previous
			: undefined;
	const executor: NonNullable<TodoSchedule["executor"]> = {
		workerId: observation.workerId,
		...(observation.agentProfile || carriedPrevious?.agentProfile
			? { agentProfile: observation.agentProfile ?? carriedPrevious?.agentProfile }
			: {}),
		...(observation.resolvedModel || carriedPrevious?.resolvedModel
			? { resolvedModel: observation.resolvedModel ?? carriedPrevious?.resolvedModel }
			: {}),
		...(observation.thinkingLevel || carriedPrevious?.thinkingLevel
			? { thinkingLevel: observation.thinkingLevel ?? carriedPrevious?.thinkingLevel }
			: {}),
		startedAt: carriedPrevious?.startedAt ?? observation.startedAt,
		...(observation.finishedAt !== undefined || carriedPrevious?.finishedAt !== undefined
			? { finishedAt: observation.finishedAt ?? carriedPrevious?.finishedAt }
			: {}),
		...(observation.outcome || carriedPrevious?.outcome
			? { outcome: observation.outcome ?? carriedPrevious?.outcome }
			: {}),
	};
	const keepPrevious =
		previous &&
		previous.workerId !== observation.workerId &&
		(observation.finishedAt !== undefined || previous.startedAt > observation.startedAt);
	const owner = target.schedule?.owner;
	// A fresh assignment can staff the row; progress from an already recorded run
	// must not undo a later lead schedule assigning another live owner.
	const shouldSetOwner =
		(observation.finishedAt === undefined && !carriedPrevious) ||
		owner === undefined ||
		owner === observation.workerId ||
		!(observation.runningWorkerIds?.has(owner) ?? false);
	const nextSchedule = {
		...target.schedule,
		startedAt: target.schedule?.startedAt ?? observation.startedAt,
		...(target.schedule?.riskEstimateMeanSeconds === undefined && target.schedule?.estimate
			? { riskEstimateMeanSeconds: todoEstimateMeanSeconds(target.schedule.estimate) }
			: {}),
		...(!keepPrevious && shouldSetOwner
			? {
					owner: observation.workerId,
					...(owner !== observation.workerId
						? {
								reestimateCount: 0,
								cumulativeReestimateCount:
									target.schedule?.cumulativeReestimateCount ?? target.schedule?.reestimateCount ?? 0,
							}
						: {}),
				}
			: {}),
		workerIds: [...new Set([...getRecordedTodoWorkerIds(target), observation.workerId])],
		executor: keepPrevious ? previous : executor,
	};
	const nextStatus = target.status === "pending" ? "in_progress" : target.status;
	if (target.status === nextStatus && JSON.stringify(target.schedule ?? null) === JSON.stringify(nextSchedule)) {
		return undefined;
	}
	return phases.map(phase => ({
		...phase,
		tasks: phase.tasks.map(task =>
			task === target ? { ...task, status: nextStatus, schedule: nextSchedule } : task,
		),
	}));
}

/** Append only to a unique exact phase/content row; replay never guesses from worker names. */
export function appendTodoReworkAttempt(
	phases: readonly TodoPhase[],
	row: { phase: string; content: string },
	attempt: TodoReworkAttempt,
): TodoPhase[] | undefined {
	const matches = phases.flatMap(phase =>
		phase.name === row.phase ? phase.tasks.filter(task => task.content === row.content) : [],
	);
	if (
		matches.length !== 1 ||
		matches[0].schedule?.attemptHistory?.some(previous => previous.attemptId === attempt.attemptId)
	) {
		return undefined;
	}
	return phases.map(phase => ({
		...phase,
		tasks: phase.tasks.map(task =>
			task === matches[0]
				? {
						...task,
						...(todoInfraBreaker([...(task.schedule?.attemptHistory ?? []), attempt])
							? { status: "blocked" as const, blocker: `Infra breaker: ${attempt.infraFailureError}` }
							: {}),
						schedule: {
							...task.schedule,
							attemptHistory: [...(task.schedule?.attemptHistory ?? []), structuredClone(attempt)],
						},
					}
				: task,
		),
	}));
}

/**
 * Rows a respawn under a taken name inherits. Re-staffing a row with `name` = its owner collides
 * with the settled job that already holds that id, so the task tool allocates `<name>-<n>` (under a
 * parent prefix, `<parent>.<name>-<n>`); every open row that still names the requested id — or a
 * settled earlier bump with the same base — belongs to the new worker. Nothing moves while the
 * requested id itself is running: that is a second worker, not a respawn. Rows owned by another
 * running bump stay with their live worker.
 */
function respawnCollisionBase(id: string): string {
	const leaf = id.split(".").at(-1) ?? id;
	return stripOmpCollisionSuffixChain(leaf);
}
export function findRespawnOwnerRows(
	phases: readonly TodoPhase[],
	respawn: { requestedName: string; workerId: string; row?: string; runningWorkerIds: ReadonlySet<string> },
): string[] {
	const { requestedName, workerId, runningWorkerIds } = respawn;
	if (requestedName === workerId || runningWorkerIds.has(requestedName)) return [];
	if (respawnCollisionBase(workerId) !== respawnCollisionBase(requestedName)) return [];
	const base = respawnCollisionBase(requestedName);
	return phases
		.flatMap(phase => phase.tasks)
		.filter(
			task =>
				isOpenStatus(task.status) &&
				typeof task.schedule?.owner === "string" &&
				(task.schedule.owner === requestedName ||
					(respawnCollisionBase(task.schedule.owner) === base && !runningWorkerIds.has(task.schedule.owner))),
		)
		.map(task => task.content);
}
