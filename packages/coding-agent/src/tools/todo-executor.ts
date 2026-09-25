import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export interface TodoExecutorObservation {
	workerId: string;
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
	observation: TodoExecutorObservation,
): boolean {
	const owner = task.schedule?.owner;
	return (
		typeof owner === "string" && owner !== observation.workerId && (observation.runningWorkerIds?.has(owner) ?? false)
	);
}

function selectUniqueLongest<T extends { content: string }>(tasks: T[]): T | undefined {
	if (tasks.length === 0) return undefined;
	let longest = 0;
	for (const task of tasks) longest = Math.max(longest, task.content.trim().length);
	const longestTasks = tasks.filter(task => task.content.trim().length === longest);
	return longestTasks.length === 1 ? longestTasks[0] : undefined;
}

function findTodoExecutorTarget(
	phases: readonly TodoPhase[],
	observation: TodoExecutorObservation,
): TodoPhase["tasks"][number] | undefined {
	const openTasks = phases
		.flatMap(phase => phase.tasks)
		.filter(task => isOpenStatus(task.status) && !isOwnedByAnotherRunningWorker(task, observation));
	const existing = openTasks.filter(
		task =>
			task.schedule?.executor?.workerId === observation.workerId || task.schedule?.owner === observation.workerId,
	);
	if (existing.length > 0) return existing.length === 1 ? existing[0] : undefined;

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
	if (previous && previous.workerId !== observation.workerId) return undefined;
	const executor: NonNullable<TodoSchedule["executor"]> = {
		workerId: observation.workerId,
		...(observation.agentProfile || previous?.agentProfile
			? { agentProfile: observation.agentProfile ?? previous?.agentProfile }
			: {}),
		...(observation.resolvedModel || previous?.resolvedModel
			? { resolvedModel: observation.resolvedModel ?? previous?.resolvedModel }
			: {}),
		...(observation.thinkingLevel || previous?.thinkingLevel
			? { thinkingLevel: observation.thinkingLevel ?? previous?.thinkingLevel }
			: {}),
		startedAt: previous?.startedAt ?? observation.startedAt,
		...(observation.finishedAt !== undefined || previous?.finishedAt !== undefined
			? { finishedAt: observation.finishedAt ?? previous?.finishedAt }
			: {}),
		...(observation.outcome || previous?.outcome ? { outcome: observation.outcome ?? previous?.outcome } : {}),
	};
	const owner = target.schedule?.owner;
	const shouldSetOwner =
		owner === undefined || owner === observation.workerId || !(observation.runningWorkerIds?.has(owner) ?? false);
	const nextSchedule = {
		...target.schedule,
		...(shouldSetOwner ? { owner: observation.workerId } : {}),
		executor,
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
