import { prompt } from "@oh-my-pi/pi-utils";
import recoveryInstructions from "./dispatch-recovery.md" with { type: "text" };
import actionTemplate from "./dispatch-action.md" with { type: "text" };
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export type WakeDemand = { key: string; action: string; churn: boolean; row?: string };
export type WakeReceipt = {
	key: string;
	misses: number;
	action: string;
	toolCalls: number;
	mutations: number;
	recovery?: RecoveryState;
};

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
	const churn = questions.length
		? undefined
		: rows.find(
				row =>
					(row.schedule?.attemptHistory?.filter(
						attempt => attempt.terminalStatus !== "completed" || attempt.rejectionReason,
					).length ?? 0) >= 3 ||
					(row.schedule?.cumulativeReestimateCount ?? row.schedule?.reestimateCount ?? 0) >= 3,
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

export const RECOVERY_STEP_MS = 10 * 60_000;
export interface RecoveryDemand extends WakeDemand {
	kind: "deadline" | "idle";
	at: number;
	step?: number;
	deadline?: number;
	baseline: TodoScheduleInput;
	ready: string[];
}
export interface RecoveryState {
	idleSince: Record<string, number>;
	satisfied?: string;
	pending?: RecoveryDemand;
	samples: Array<{ at: number; completed: string[] }>;
	forecast?: { at: number; from: number; completed: number; rowsPerHour: number; open: number; eta: number };
}
const openRow = (row: TodoScheduleInput[number]["tasks"][number]) =>
	row.status !== "completed" && row.status !== "abandoned";
const staffed = (row: TodoScheduleInput[number]["tasks"][number], running: Set<string>) =>
	!!row.schedule?.executor &&
	!row.schedule.executor.outcome &&
	(running.has(row.schedule.executor.workerId) || running.has(row.schedule.owner ?? ""));

/** Same durable action-demand journal as CHURN; no prose is interpreted here. */
export function recoveryDemand(
	phases: TodoScheduleInput,
	running: Set<string>,
	now: number,
	capacity: number,
	deadline: number | undefined,
	finish: number | undefined,
	previous?: RecoveryState,
	activeCount = running.size,
): RecoveryState {
	const state: RecoveryState = structuredClone(previous ?? { idleSince: {}, samples: [] });
	const rows = phases.flatMap(phase => phase.tasks);
	const open = rows.filter(openRow);
	if (!state.samples.length || now - state.samples.at(-1)!.at >= 60_000)
		state.samples.push({
			at: now,
			completed: rows.filter(row => row.status === "completed").map(row => row.content),
		});
	// Keep one sample before the measurement window, plus the window itself.
	while (state.samples.length > 2 && state.samples[1]!.at < now - 90 * 60_000) state.samples.shift();
	const ready = open.filter(
		row =>
			row.status !== "blocked" &&
			!staffed(row, running) &&
			(row.schedule?.dependencies ?? []).every(dep => rows.some(other => other.content === dep && !openRow(other))),
	);
	const spare = activeCount < capacity;
	state.idleSince = Object.fromEntries(
		ready.filter(() => spare).map(row => [row.content, state.idleSince[row.content] ?? now]),
	);
	if (!open.length) {
		state.pending = undefined;
		return state;
	}
	if (state.pending) return state; // A receding forecast cannot erase an ignored demand.
	const slip = deadline === undefined ? 0 : Math.max(now, finish ?? 0) - deadline;
	const step = Math.ceil(slip / RECOVERY_STEP_MS);
	const key = `deadline:${deadline}:${step}`;
	const idle = ready.find(row => now - state.idleSince[row.content]! >= RECOVERY_STEP_MS);
	const missed = slip > 0 && state.satisfied !== key;
	if (!missed && !idle) return state;
	state.pending = {
		key: missed ? key : `idle:${idle!.content}:${state.idleSince[idle!.content]}`,
		kind: missed ? "deadline" : "idle",
		deadline,
		at: now,
		step: missed ? step : undefined,
		action: prompt.render(recoveryInstructions, { idle: !missed, row: idle?.content }).trim(),
		churn: false,
		row: missed ? undefined : idle!.content,
		baseline: structuredClone(phases),
		ready: ready.map(row => row.content),
	};
	return state;
}

export function recoveryActionObserved(
	demand: RecoveryDemand,
	phases: TodoScheduleInput,
	running: Set<string>,
): boolean {
	const before = demand.baseline.flatMap(phase => phase.tasks);
	const rows = phases.flatMap(phase => phase.tasks);
	const newWorker = (title: string) => {
		const row = rows.find(row => row.content === title);
		const prior = before.find(row => row.content === title);
		return (
			!!row &&
			staffed(row, running) &&
			(row.schedule?.executor?.workerId !== prior?.schedule?.executor?.workerId ||
				(row.schedule?.executor?.startedAt ?? 0) > (prior?.schedule?.executor?.startedAt ?? 0))
		);
	};
	if (demand.kind === "idle") {
		const row = rows.find(row => row.content === demand.row);
		return newWorker(demand.row!) || !!(row?.status === "blocked" && row.blocker?.trim());
	}
	return (
		demand.ready.some(newWorker) ||
		before.filter(openRow).some(prior => {
			const row = rows.find(row => row.content === prior.content);
			return (
				!row ||
				row.status === "abandoned" ||
				(row.schedule?.dependencies?.filter(
					dep =>
						!prior.schedule?.dependencies?.includes(dep) &&
						!before.some(old => old.content === dep) &&
						rows.some(child => child.content === dep),
				).length ?? 0) >= 2
			);
		})
	);
}

export function measuredRecoveryForecast(
	state: RecoveryState,
	phases: TodoScheduleInput,
	now: number,
): NonNullable<RecoveryState["forecast"]> {
	const first = state.samples[0];
	if (!first || now <= first.at) throw new Error("No measured pace window yet; split, staff, cut or escalate instead");
	const rows = phases.flatMap(phase => phase.tasks);
	const completed = rows.filter(row => row.status === "completed" && !first.completed.includes(row.content)).length;
	const rowsPerHour = (completed * 3600_000) / (now - first.at);
	if (rowsPerHour <= 0)
		throw new Error("Measured pace is zero rows/hour; no finite ETA. Split, staff, cut or escalate instead");
	const open = rows.filter(openRow).length;
	return { at: now, from: first.at, completed, rowsPerHour, open, eta: now + (open / rowsPerHour) * 3600_000 };
}
