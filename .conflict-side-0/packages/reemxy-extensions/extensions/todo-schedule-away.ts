/**
 * Reemxy user-wait additions on top of the host todo forecast engine
 * (`@oh-my-pi/pi-tui/tools/todo-schedule`). The engine itself, including `parseUserWait` and the
 * "waits for you" rendering, lives only in the host module; this file adds the rules that belong
 * to the Reemxy dispatcher:
 *
 * - self-fill first: a row may wait for the user only with the chief's own proposal recorded
 *   (`user-wait-without-proposal` planning issue);
 * - while the user is away, a row that waits for the user with a proposal is parked: it leaves the
 *   forecast, and its dependents proceed on the proposal.
 *
 * `forecastPlanWithUserWaits` and `getPlanningIssuesWithUserWaits` wrap the host
 * `forecastTodoPlan` and `getTodoPlanningIssues`; they do not reimplement the forecast.
 */
import {
	type TodoForecastOptions,
	forecastTodoPlan as forecastHostPlan,
	getTodoPlanningIssues as getHostPlanningIssues,
	parseUserWait,
	type TodoPlanForecast,
	type TodoPlanningIssue,
	type TodoScheduleInput,
	type TodoScheduleInputTask,
	type TodoTaskForecast,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";

export type TodoAwayPlanningIssueCode = TodoPlanningIssue["code"] | "user-wait-without-proposal";

export interface TodoAwayPlanningIssue extends Omit<TodoPlanningIssue, "code"> {
	code: TodoAwayPlanningIssueCode;
}

export interface TodoAwayTaskForecast extends Omit<TodoTaskForecast, "planningIssues"> {
	planningIssues?: TodoAwayPlanningIssue[];
	/** Parked while the user is away: not the chief's work, not in the ETA (`userAway` forecasts only). */
	parked?: boolean;
}

export interface TodoAwayPlanForecast extends Omit<TodoPlanForecast, "rows" | "planningIssues"> {
	rows: TodoAwayTaskForecast[];
	planningIssues: TodoAwayPlanningIssue[];
}

export interface TodoAwayForecastOptions extends TodoForecastOptions {
	/** The user is away: rows waiting for the user with a proposal are parked (see `parkUserWaits`). */
	userAway?: boolean;
}

/** What every notice about a user-wait without a proposal asks for. */
export const USER_WAIT_SELF_FILL =
	'fill in your own proposal first: the choice you would make, the drafted JSON or text, and why, as "proposal: …" in the block reason. A question about your own earlier decision is not a user blocker: fix the doc or comment that caused it and unblock the row';

/** Self-fill first: a row may wait for the user only with the chief's own proposal recorded. */
export function getUserWaitPlanningIssues(phases: TodoScheduleInput): TodoAwayPlanningIssue[] {
	const issues: TodoAwayPlanningIssue[] = [];
	for (const phase of phases)
		for (const task of phase.tasks) {
			const wait = task.status === "blocked" ? parseUserWait(task.blocker) : undefined;
			if (!wait || wait.proposal !== undefined) continue;
			issues.push({
				task: task.content,
				code: "user-wait-without-proposal",
				message: `Waits for the user without a proposal; ${USER_WAIT_SELF_FILL}: ${task.content}`,
			});
		}
	return issues;
}

/** Host planning issues followed by the user-wait ones. */
export function getPlanningIssuesWithUserWaits(phases: TodoScheduleInput): TodoAwayPlanningIssue[] {
	return [...getHostPlanningIssues(phases), ...getUserWaitPlanningIssues(phases)];
}

export interface TodoParkedUserWaits {
	/** The plan without the parked rows; dependencies on them are dropped. */
	phases: TodoScheduleInput;
	parked: Array<{ content: string; question: string; proposal: string }>;
	/** Open row → parked rows whose proposal it proceeds on. */
	onProposal: Map<string, string[]>;
}

function isClosed(status: TodoScheduleInputTask["status"]): boolean {
	return status === "completed" || status === "abandoned";
}

/**
 * While the user is away, a row that waits for the user with the chief's proposal leaves the plan
 * until the user returns: it is not the chief's work, not in the ETA, and its dependents proceed on
 * the proposal. A user-wait without a proposal stays an ordinary blocked row.
 */
export function parkUserWaits(phases: TodoScheduleInput): TodoParkedUserWaits {
	const parked: TodoParkedUserWaits["parked"] = [];
	const parkedTasks = new Set<TodoScheduleInputTask>();
	for (const phase of phases)
		for (const task of phase.tasks) {
			const wait = task.status === "blocked" ? parseUserWait(task.blocker) : undefined;
			if (wait?.proposal === undefined) continue;
			parked.push({ content: task.content, question: wait.question, proposal: wait.proposal });
			parkedTasks.add(task);
		}
	const onProposal = new Map<string, string[]>();
	if (parked.length === 0) return { phases, parked, onProposal };
	const names = new Set(parked.map(row => row.content));
	const rest = phases.map(phase => ({
		...phase,
		tasks: phase.tasks
			.filter(task => !parkedTasks.has(task))
			.map(task => {
				const dependencies = task.schedule?.dependencies;
				if (!Array.isArray(dependencies) || !dependencies.some(dependency => names.has(dependency))) return task;
				if (!isClosed(task.status))
					onProposal.set(
						task.content,
						dependencies.filter(dependency => names.has(dependency)),
					);
				return {
					...task,
					schedule: { ...task.schedule, dependencies: dependencies.filter(dependency => !names.has(dependency)) },
				};
			}),
	}));
	return { phases: rest, parked, onProposal };
}

/** The host forecast with the user-wait planning issues appended, plan-wide and per row. */
function withUserWaitIssues(phases: TodoScheduleInput, plan: TodoPlanForecast): TodoAwayPlanForecast {
	const extra = getUserWaitPlanningIssues(phases);
	if (extra.length === 0) return plan;
	const byTask = new Map<string, TodoAwayPlanningIssue[]>();
	for (const issue of extra) {
		const taskIssues = byTask.get(issue.task);
		if (taskIssues) taskIssues.push(issue);
		else byTask.set(issue.task, [issue]);
	}
	return {
		...plan,
		planningIssues: [...plan.planningIssues, ...extra],
		rows: plan.rows.map(row => {
			const added = byTask.get(row.content);
			return added ? { ...row, planningIssues: [...(row.planningIssues ?? []), ...added] } : row;
		}),
	};
}

/**
 * The host forecast plus the user-wait rules. With `userAway`, parked rows keep their place in
 * `rows` (marked `parked`, outside the ETA) and rows that proceed on a proposal carry `onProposal`.
 */
export function forecastPlanWithUserWaits(
	phases: TodoScheduleInput,
	options: TodoAwayForecastOptions,
): TodoAwayPlanForecast {
	if (!options.userAway) {
		const { userAway: _userAway, ...hostOptions } = options;
		return withUserWaitIssues(phases, forecastHostPlan(phases, hostOptions));
	}
	const parking = parkUserWaits(phases);
	const plan = forecastPlanWithUserWaits(parking.phases, { ...options, userAway: false });
	if (parking.parked.length === 0) return plan;
	// Rows keep the plan's order: parked rows take their places back beside the forecast ones.
	const parkedByContent = new Map(parking.parked.map(row => [row.content, row]));
	const forecastRows = plan.rows[Symbol.iterator]();
	const rows: TodoAwayTaskForecast[] = [];
	for (const phase of phases)
		for (const task of phase.tasks) {
			const park = task.status === "blocked" ? parkedByContent.get(task.content) : undefined;
			if (park && parseUserWait(task.blocker)?.proposal !== undefined) {
				rows.push({
					content: task.content,
					status: "blocked",
					blocker: task.blocker,
					waitsForUser: { question: park.question, proposal: park.proposal },
					parked: true,
					critical: false,
					ready: false,
					estimateRequired: false,
					stale: false,
					overdue: false,
					estimateRevision: task.schedule?.estimateRevision ?? (task.schedule?.estimate ? 1 : 0),
					reestimateCount: task.schedule?.reestimateCount ?? 0,
					confidence: "unknown",
					issues: [],
				});
				continue;
			}
			const row = forecastRows.next().value as TodoAwayTaskForecast;
			const onProposal = parking.onProposal.get(row.content);
			rows.push(onProposal ? { ...row, onProposal } : row);
		}
	return { ...plan, rows };
}
