import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export interface TodoExecutorObservation {
	workerId: string;
	agentProfile?: string;
	description?: string;
	resolvedModel?: string;
	thinkingLevel?: string;
	startedAt: number;
	finishedAt?: number;
}

/** Attach an observed worker only when one row identifies it unambiguously. */
export function applyTodoExecutorObservation(
	phases: readonly TodoPhase[],
	observation: TodoExecutorObservation,
): TodoPhase[] | undefined {
	const candidates = phases
		.flatMap(phase => phase.tasks)
		.filter(
			task =>
				task.schedule?.executor?.workerId === observation.workerId || task.schedule?.owner === observation.workerId,
		);
	const named =
		candidates.length > 0
			? candidates
			: phases
					.flatMap(phase => phase.tasks)
					.filter(
						task =>
							observation.description?.trim() === task.content.trim() &&
							task.status !== "completed" &&
							task.status !== "abandoned",
					);
	if (named.length !== 1) return undefined;
	const target = named[0]!;
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
	};
	if (JSON.stringify(previous) === JSON.stringify(executor)) return undefined;
	return phases.map(phase => ({
		...phase,
		tasks: phase.tasks.map(task => (task === target ? { ...task, schedule: { ...task.schedule, executor } } : task)),
	}));
}
