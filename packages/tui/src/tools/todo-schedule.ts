import { sanitizeText } from "@oh-my-pi/pi-utils";
import { truncateToWidth } from "../utils";

export type TodoConfidence = "low" | "medium" | "high";
export type TodoForecastConfidence = TodoConfidence | "unknown";
export type TodoScheduleStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** A qualitative, user-maintained estimate. All durations are seconds; `updatedAt` is Unix milliseconds. */
export interface TodoEstimate {
	optimisticSeconds: number;
	likelySeconds: number;
	pessimisticSeconds: number;
	confidence: TodoConfidence;
	basis: string;
	updatedAt: number;
}

/** Forecast metadata belongs to the exact task content; there are deliberately no generated IDs. */
export interface TodoSchedule {
	/** `undefined` means unknown; `[]` explicitly means independent. References are exact task content. */
	dependencies?: string[];
	/** Exclusive while this task is running. */
	owner?: string;
	/** Exclusive identifiers while this task is running. `undefined` means undeclared. */
	resources?: string[];
	estimate?: TodoEstimate;
	/** Server-owned revisions; first estimate is revision 1, with zero reestimates. */
	estimateRevision?: number;
	reestimateCount?: number;
	progress?: { at: number; evidence: string };
	startedAt?: number;
	finishedAt?: number;
}

export interface TodoScheduleInputTask {
	content: string;
	status: TodoScheduleStatus;
	blocker?: string;
	schedule?: TodoSchedule;
}

export interface TodoScheduleInputPhase {
	name: string;
	tasks: readonly TodoScheduleInputTask[];
}

/** Native todo shape accepted without importing todo.ts (and without a runtime cycle). */
export type TodoScheduleInput = readonly TodoScheduleInputPhase[];

export interface TodoTaskForecast {
	content: string;
	status: TodoScheduleStatus;
	blocker?: string;
	/** Direct blocked prerequisite and its reason, when known. */
	awaitingPrerequisite?: string;
	estimateRangeSeconds?: { optimistic: number; likely: number; pessimistic: number };
	planningIssues?: TodoPlanningIssue[];
	owner?: string;
	earliestStart?: number;
	earliestFinish?: number;
	latestStart?: number;
	latestFinish?: number;
	totalFloatSeconds?: number;
	freeFloatSeconds?: number;
	resourceStart?: number;
	/** Approximate per-task fixed-path P95 finish; not a network percentile. */
	resourceFinish?: number;
	/** Unique fixed path through dependencies and deterministic resource ordering, ending at this task. */
	fixedPath?: string[];
	fixedPathExpectedSeconds?: number;
	fixedPathSigmaSeconds?: number;
	fixedPathP95Finish?: number;
	/** Resource-scheduled finish using PERT mean durations. */
	expectedResourceFinish?: number;
	/** Min/max scenario envelope, not a probability interval. */
	range?: { earliest: number; latest: number };
	/** Criticality uses natural project float, not user-deadline slack. */
	critical: boolean;
	criticalityKnown?: boolean;
	/** Dependency-ready only; resource availability/capacity is modeled separately. */
	ready: boolean;
	/** True when an open runnable task lacks a valid estimate. */
	estimateRequired: boolean;
	estimateMeanSeconds?: number;
	stale: boolean;
	overdue: boolean;
	estimateRevision: number;
	reestimateCount: number;
	confidence: TodoForecastConfidence;
	resourceConfidence?: TodoForecastConfidence;
	issues: string[];
	/** Original timestamp, retained even when `now` advances or the estimate is stale. */
	estimateUpdatedAt?: number;
	progressAt?: number;
	startedAt?: number;
	finishedAt?: number;
}

export type TodoDeadlineStatus = "overdue" | "at-risk" | "on-track" | "unknown";

export interface TodoPlanForecast {
	rows: TodoTaskForecast[];
	now: number;
	deadlineAt?: number;
	/** Missing whenever any required open task is unresolved. All times are Unix milliseconds. */
	earliestFinish?: number;
	/** Max per-row fixed-path analytical P95 finish; an approximation, not a network percentile. */
	resourceFinish?: number;
	/** Same max as `resourceFinish`, with its fixed-path approximation explicit. */
	fixedPathP95Finish?: number;
	/** Resource-scheduled finish using PERT mean durations, retained for calibration. */
	expectedResourceFinish?: number;
	/** Max fixed-path P95 of forecastable rows only; never a full-plan ETA. */
	knownWorkFinish?: number;
	/** Number of open task rows that cannot be forecast. */
	unresolvedCount: number;
	/** Plan repairs are derived from the shared obligation checker, not forecast simulation. */
	planningIssues: TodoPlanningIssue[];
	/** Min/max scenario envelope, not a probability interval. */
	range?: { earliest: number; latest: number };
	confidence: TodoForecastConfidence;
	resourceConfidence?: TodoForecastConfidence;
	resourceAssumptions?: string[];
	deadlineStatus?: TodoDeadlineStatus;
	/** True only after the absolute deadline has passed; predicted lateness is `at-risk`. */
	deadlineMissed?: boolean;
	deadlineSlackSeconds?: number;
	issues: string[];
}

export interface TodoForecastOptions {
	now: number;
	deadlineAt?: number;
	/** Positive integer concurrency; 0 means Unlimited. Omitted/invalid input uses default 32; effective capacity is bounded by forecastable open tasks. */
	capacity?: number;
}

export type TodoDependencyIssueCode =
	| "dependencies-unknown"
	| "duplicate-task"
	| "missing-dependency"
	| "ambiguous-dependency"
	| "self-dependency"
	| "dependency-cycle"
	| "abandoned-dependency"
	| "invalid-schedule-metadata"
	| "unresolved-prerequisite"
	| "completed-dependency-history-unknown";

export interface TodoDependencyIssue {
	code: TodoDependencyIssueCode;
	task: string;
	dependency?: string;
	message: string;
}
export type TodoPlanningIssueCode =
	| "missing-estimate"
	| "missing-dependencies"
	| "task-too-large"
	| "blocked-without-reason";

const PLANNING_ACTION_LABELS: Record<TodoPlanningIssueCode, string> = {
	"missing-estimate": "estimate remaining effort",
	"missing-dependencies": "clarify prerequisites",
	"task-too-large": "decompose to at most one hour",
	"blocked-without-reason": "record blocker reason and recover",
};
export interface TodoPlanningIssue {
	task: string;
	code: TodoPlanningIssueCode;
	message: string;
}

export function getTodoPlanningIssues(phases: TodoScheduleInput): TodoPlanningIssue[] {
	return collectTodoPlanningIssues(phases, analyzeDependencies(phases));
}

const CONFIDENCE_RANK: Record<TodoConfidence, number> = { low: 0, medium: 1, high: 2 };
const STALE_MINIMUM_MS = 5 * 60_000;
const DEFAULT_CAPACITY = 32;
const FIXED_PATH_P95_Z = 1.64485362695;
const CPM_TIE_TOLERANCE_MS = 1;

type ResourceScenario = "optimistic" | "expected" | "pessimistic";
interface DurationEstimates {
	optimistic: number;
	expected: number;
	pessimistic: number;
	spread: number;
}

interface PlanNode {
	index: number;
	content: string;
	status: TodoScheduleStatus;
	schedule?: TodoSchedule;
	blocker?: string;
	estimate?: TodoEstimate;
	predecessors: PlanNode[];
	successors: PlanNode[];
	issues: string[];
	dependencyIssues: TodoDependencyIssue[];
	dependencySetKnown: boolean;
	invalid: boolean;
	stale: boolean;
	ready: boolean;
	confidence: TodoForecastConfidence;
	earliestStart?: number;
	earliestFinish?: number;
	latestStart?: number;
	latestFinish?: number;
	naturalLatestStart?: number;
	freeFloatSeconds?: number;
	durationEstimates?: DurationEstimates;
	fixedPathParent?: PlanNode;
	fixedPathExpectedSeconds?: number;
	fixedPathVarianceSeconds?: number;
	fixedPathStart?: number;
	fixedPathAmbiguous?: boolean;
	resourceConfidence: TodoForecastConfidence;
}

interface DependencyAnalysis {
	nodes: PlanNode[];
	uniqueNodes: PlanNode[];
	byContent: Map<string, PlanNode>;
	topological: PlanNode[];
	issues: TodoDependencyIssue[];
}

function isClosed(status: TodoScheduleStatus): boolean {
	return status === "completed" || status === "abandoned";
}

function addIssue(node: PlanNode, issue: TodoDependencyIssue, allIssues: TodoDependencyIssue[]): void {
	node.invalid = true;
	node.issues.push(issue.message);
	node.dependencyIssues.push(issue);
	allIssues.push(issue);
}

function analyzeDependencies(
	phases: TodoScheduleInput,
	compare: (left: PlanNode, right: PlanNode) => number = (left, right) => left.index - right.index,
): DependencyAnalysis {
	const nodes: PlanNode[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			nodes.push({
				index: nodes.length,
				content: task.content,
				status: task.status,
				schedule: task.schedule,
				estimate: task.schedule?.estimate,
				predecessors: [],
				successors: [],
				issues: [],
				dependencyIssues: [],
				dependencySetKnown: isClosed(task.status),
				invalid: false,
				stale: false,
				ready: false,
				confidence: "unknown",
				resourceConfidence: "unknown",
				blocker: task.blocker,
			});
		}
	}

	const byName = new Map<string, PlanNode[]>();
	for (const node of nodes) {
		const matches = byName.get(node.content);
		if (matches) matches.push(node);
		else byName.set(node.content, [node]);
	}
	const allIssues: TodoDependencyIssue[] = [];
	const uniqueNodes: PlanNode[] = [];
	const byContent = new Map<string, PlanNode>();
	for (const [content, matches] of byName) {
		if (matches.length !== 1) {
			for (const node of matches) {
				addIssue(
					node,
					{
						code: "duplicate-task",
						task: node.content,
						message: `Task content is duplicated and cannot identify a unique task: ${content}`,
					},
					allIssues,
				);
			}
			continue;
		}
		byContent.set(content, matches[0]);
		uniqueNodes.push(matches[0]);
	}

	for (const node of uniqueNodes) {
		if (isClosed(node.status)) continue;
		const schedule = node.schedule as unknown as Record<string, unknown> | undefined;
		if (schedule !== undefined && (!schedule || typeof schedule !== "object" || Array.isArray(schedule))) {
			addIssue(
				node,
				{
					code: "invalid-schedule-metadata",
					task: node.content,
					message: `Schedule metadata is not an object for task: ${node.content}`,
				},
				allIssues,
			);
			continue;
		}
		if (!schedule) continue;
		if (schedule.owner !== undefined && (typeof schedule.owner !== "string" || schedule.owner.length === 0)) {
			addIssue(
				node,
				{
					code: "invalid-schedule-metadata",
					task: node.content,
					message: `Owner must be a non-empty string for task: ${node.content}`,
				},
				allIssues,
			);
		}
		if (
			schedule.resources !== undefined &&
			(!Array.isArray(schedule.resources) ||
				schedule.resources.some(resource => typeof resource !== "string" || resource.length === 0))
		) {
			addIssue(
				node,
				{
					code: "invalid-schedule-metadata",
					task: node.content,
					message: `Resources must be a list of non-empty strings for task: ${node.content}`,
				},
				allIssues,
			);
		}
		const estimate = schedule.estimate;
		if (
			estimate !== undefined &&
			(!estimate ||
				typeof estimate !== "object" ||
				Array.isArray(estimate) ||
				typeof (estimate as Record<string, unknown>).basis !== "string" ||
				!(estimate as Record<string, string>).basis.trim())
		) {
			addIssue(
				node,
				{
					code: "invalid-schedule-metadata",
					task: node.content,
					message: `Estimate basis must be non-empty text for task: ${node.content}`,
				},
				allIssues,
			);
		}
	}

	for (const node of uniqueNodes) {
		if (isClosed(node.status)) continue;
		const dependencies = node.schedule?.dependencies;
		if (dependencies === undefined) {
			node.dependencySetKnown = false;
			addIssue(
				node,
				{
					code: "dependencies-unknown",
					task: node.content,
					message: `Dependencies are unknown for task: ${node.content}`,
				},
				allIssues,
			);
			continue;
		}
		if (!Array.isArray(dependencies)) {
			node.dependencySetKnown = false;
			addIssue(
				node,
				{
					code: "dependencies-unknown",
					task: node.content,
					message: `Dependencies are not a valid list for task: ${node.content}`,
				},
				allIssues,
			);
			continue;
		}
		node.dependencySetKnown = true;
		const seen = new Set<string>();
		for (const dependency of dependencies) {
			if (typeof dependency !== "string") {
				node.dependencySetKnown = false;
				addIssue(
					node,
					{
						code: "dependencies-unknown",
						task: node.content,
						message: `A dependency reference is not text for task: ${node.content}`,
					},
					allIssues,
				);
				continue;
			}
			if (seen.has(dependency)) continue;
			seen.add(dependency);
			if (dependency === node.content) {
				addIssue(
					node,
					{
						code: "self-dependency",
						task: node.content,
						dependency,
						message: `Task cannot depend on itself: ${node.content}`,
					},
					allIssues,
				);
				continue;
			}
			const matches = byName.get(dependency);
			if (!matches) {
				addIssue(
					node,
					{
						code: "missing-dependency",
						task: node.content,
						dependency,
						message: `Missing dependency ${dependency} required by task: ${node.content}`,
					},
					allIssues,
				);
				continue;
			}
			if (matches.length !== 1) {
				addIssue(
					node,
					{
						code: "ambiguous-dependency",
						task: node.content,
						dependency,
						message: `Dependency content is ambiguous (${matches.length} matching tasks): ${dependency}`,
					},
					allIssues,
				);
				continue;
			}
			const predecessor = matches[0];
			node.predecessors.push(predecessor);
			predecessor.successors.push(node);
			if (predecessor.status === "abandoned") {
				addIssue(
					node,
					{
						code: "abandoned-dependency",
						task: node.content,
						dependency,
						message: `Abandoned task is not a satisfied prerequisite for ${node.content}; remove or replace the dependency: ${dependency}`,
					},
					allIssues,
				);
			}
			if (predecessor.status === "completed" && !finiteTimestamp(predecessor.schedule?.finishedAt)) {
				addIssue(
					node,
					{
						code: "completed-dependency-history-unknown",
						task: node.content,
						dependency,
						message: `Completion time was not recorded for prerequisite ${dependency}; cannot ground task: ${node.content}`,
					},
					allIssues,
				);
			}
		}
	}

	const indegree = new Map<PlanNode, number>();
	for (const node of uniqueNodes) indegree.set(node, node.predecessors.length);
	const ready: PlanNode[] = uniqueNodes.filter(node => indegree.get(node) === 0).sort(compare);
	const topological: PlanNode[] = [];
	while (ready.length > 0) {
		const node = ready.shift()!;
		topological.push(node);
		for (const successor of node.successors) {
			const next = indegree.get(successor)! - 1;
			indegree.set(successor, next);
			if (next === 0) {
				let insertion = ready.findIndex(candidate => compare(candidate, successor) > 0);
				if (insertion < 0) insertion = ready.length;
				ready.splice(insertion, 0, successor);
			}
		}
	}

	const ordered = new Set(topological);
	for (const node of uniqueNodes) {
		if (!ordered.has(node)) {
			addIssue(
				node,
				{
					code: "dependency-cycle",
					task: node.content,
					message: `Task is in or downstream of a dependency cycle: ${node.content}`,
				},
				allIssues,
			);
		}
	}
	for (const node of topological) {
		const unresolved = node.predecessors.find(predecessor => predecessor.invalid);
		if (unresolved) {
			addIssue(
				node,
				{
					code: "unresolved-prerequisite",
					task: node.content,
					dependency: unresolved.content,
					message: `Prerequisite cannot be forecast for task ${node.content}: ${unresolved.content}`,
				},
				allIssues,
			);
		}
	}

	for (const node of nodes) {
		if (node.status === "completed") node.ready = true;
		else if (node.status === "abandoned" || node.status === "blocked" || !node.dependencySetKnown) node.ready = false;
		else
			node.ready =
				node.predecessors.length === node.schedule?.dependencies?.length &&
				node.predecessors.every(
					predecessor => predecessor.status === "completed" && finiteTimestamp(predecessor.schedule?.finishedAt),
				);
	}

	return { nodes, uniqueNodes, byContent, topological, issues: allIssues };
}

/** Validate exact task references for atomic schedule admission; all open tasks need explicit deps. */
export function validateTodoDependencies(phases: TodoScheduleInput): TodoDependencyIssue[] {
	return analyzeDependencies(phases).issues;
}

/** Display order shares the validator's graph; unknown/cyclic rows are retained, never dropped. */
export function orderTodoScheduleIndices(
	phases: TodoScheduleInput,
	forecasts: readonly TodoTaskForecast[] = [],
): number[] {
	const finishes = new Map(forecasts.map(row => [row.content, row.resourceFinish]));
	const compare = (left: PlanNode, right: PlanNode): number => {
		const leftFinish = finishes.get(left.content);
		const rightFinish = finishes.get(right.content);
		return (
			(finiteTimestamp(leftFinish) ? leftFinish : Number.POSITIVE_INFINITY) -
				(finiteTimestamp(rightFinish) ? rightFinish : Number.POSITIVE_INFINITY) || left.index - right.index
		);
	};
	const analysis = analyzeDependencies(phases, compare);
	const ordered = new Set(analysis.topological);
	return [...analysis.topological, ...analysis.nodes.filter(node => !ordered.has(node)).sort(compare)].map(
		node => node.index,
	);
}

function isValidEstimate(estimate: TodoEstimate | undefined): estimate is TodoEstimate {
	return (
		!!estimate &&
		Number.isFinite(estimate.optimisticSeconds) &&
		estimate.optimisticSeconds >= 0 &&
		Number.isFinite(estimate.likelySeconds) &&
		estimate.likelySeconds >= estimate.optimisticSeconds &&
		Number.isFinite(estimate.pessimisticSeconds) &&
		estimate.pessimisticSeconds >= estimate.likelySeconds &&
		Number.isFinite(estimate.updatedAt) &&
		typeof estimate.basis === "string" &&
		estimate.basis.trim().length > 0 &&
		(estimate.confidence === "low" || estimate.confidence === "medium" || estimate.confidence === "high")
	);
}

function collectTodoPlanningIssues(phases: TodoScheduleInput, analysis: DependencyAnalysis): TodoPlanningIssue[] {
	const dependencyUnknownTasks = new Set(
		analysis.issues.filter(issue => issue.code === "dependencies-unknown").map(issue => issue.task),
	);
	const issues: TodoPlanningIssue[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (isClosed(task.status)) continue;
			const estimate = task.schedule?.estimate;
			if (!isValidEstimate(estimate)) {
				issues.push({
					task: task.content,
					code: "missing-estimate",
					message: `Provide a finite, ordered optimistic/likely/pessimistic remaining-time estimate in seconds, with confidence and a nonblank basis, for task: ${task.content}`,
				});
			}
			if (estimate && Number.isFinite(estimate.pessimisticSeconds) && estimate.pessimisticSeconds > 3600) {
				issues.push({
					task: task.content,
					code: "task-too-large",
					message: `Decompose task into smaller tasks whose pessimistic estimate is at most 3600 seconds (1 hour): ${task.content}`,
				});
			}
			if (!Array.isArray(task.schedule?.dependencies) || dependencyUnknownTasks.has(task.content)) {
				issues.push({
					task: task.content,
					code: "missing-dependencies",
					message: `Clarify prerequisites for task ${task.content} and set dependencies explicitly (use [] if independent)`,
				});
			}
			if (task.status === "blocked" && (typeof task.blocker !== "string" || !task.blocker.trim())) {
				issues.push({
					task: task.content,
					code: "blocked-without-reason",
					message: `Blocked work requires recovery actions or safe reformulation, not just a reason; add a nonblank blocker reason and estimate remaining effort after unblocking: ${task.content}`,
				});
			}
		}
	}
	return issues;
}

function estimateDurations(estimate: TodoEstimate): DurationEstimates {
	const { optimisticSeconds: optimistic, likelySeconds: mode, pessimisticSeconds: pessimistic } = estimate;
	const spread = pessimistic - optimistic;
	return { optimistic, expected: (optimistic + 4 * mode + pessimistic) / 6, pessimistic, spread };
}

function nodeDurations(node: PlanNode): DurationEstimates {
	if (!node.durationEstimates) node.durationEstimates = estimateDurations(node.estimate!);
	return node.durationEstimates;
}

function durationMs(node: PlanNode, scenario: ResourceScenario = "expected"): number {
	if (isClosed(node.status)) return 0;
	return nodeDurations(node)[scenario] * 1000;
}

function lowerConfidence(a: TodoForecastConfidence, b: TodoForecastConfidence): TodoForecastConfidence {
	if (a === "unknown" || b === "unknown") return "unknown";
	return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

function estimateStaleness(node: PlanNode, now: number, resourceStart?: number): void {
	if (isClosed(node.status) || !node.estimate) return;
	const estimate = node.estimate;
	const progressAt = node.schedule?.progress?.at;
	const validProgress = Number.isFinite(progressAt) && progressAt! <= now ? progressAt! : undefined;
	if (estimate.updatedAt > now)
		node.issues.push(`Estimate timestamp is later than forecast as-of time: ${node.content}`);
	if (Number.isFinite(progressAt) && progressAt! > now)
		node.issues.push(`Progress timestamp is later than forecast as-of time: ${node.content}`);
	if (!node.ready) return;
	const startedAt = node.schedule?.startedAt;
	const actualRelease = node.predecessors.reduce(
		(latest, predecessor) =>
			Math.max(latest, finiteTimestamp(predecessor.schedule?.finishedAt) ? predecessor.schedule!.finishedAt! : 0),
		0,
	);
	const latestActivity = Math.max(
		estimate.updatedAt,
		validProgress ?? Number.NEGATIVE_INFINITY,
		finiteTimestamp(startedAt) ? startedAt : 0,
		actualRelease,
		!finiteTimestamp(startedAt) && finiteTimestamp(resourceStart) ? resourceStart : 0,
	);
	node.stale = now - latestActivity > Math.max(STALE_MINIMUM_MS, estimate.pessimisticSeconds * 1000);
	if (node.stale) node.issues.push(`Estimate is stale; review before relying on its ETA: ${node.content}`);
}

interface ResourceSchedule {
	starts: Map<PlanNode, number>;
	finishes: Map<PlanNode, number>;
	unassigned: PlanNode[];
}

function taskPriority(topological: PlanNode[]): Map<PlanNode, number> {
	const bottomLevel = new Map<PlanNode, number>();
	for (let index = topological.length - 1; index >= 0; index--) {
		const node = topological[index];
		const childLevel = node.successors.reduce((longest, child) => Math.max(longest, bottomLevel.get(child) ?? 0), 0);
		bottomLevel.set(node, durationMs(node) + childLevel);
	}
	return bottomLevel;
}

function canStart(node: PlanNode, active: readonly { node: PlanNode }[]): boolean {
	const resources = Array.isArray(node.schedule?.resources) ? node.schedule.resources : [];
	const owner = typeof node.schedule?.owner === "string" ? node.schedule.owner : undefined;
	for (const running of active) {
		const other = running.node;
		if (owner !== undefined && owner === other.schedule?.owner) return false;
		if (resources.length === 0) continue;
		const held = Array.isArray(other.schedule?.resources) ? other.schedule.resources : [];
		if (resources.some(resource => held.includes(resource))) return false;
	}
	return true;
}

function scheduleResources(
	validNodes: PlanNode[],
	capacity: number,
	scenario: ResourceScenario,
	priority: Map<PlanNode, number>,
): ResourceSchedule {
	const starts = new Map<PlanNode, number>();
	const finishes = new Map<PlanNode, number>();
	const completed = new Set<PlanNode>();
	const unscheduled = new Set<PlanNode>();
	for (const node of validNodes) {
		if (isClosed(node.status)) {
			if (node.earliestStart !== undefined) starts.set(node, node.earliestStart);
			if (node.earliestFinish !== undefined) finishes.set(node, node.earliestFinish);
			if (scenario === "expected") {
				node.fixedPathParent = undefined;
				node.fixedPathExpectedSeconds = 0;
				node.fixedPathVarianceSeconds = 0;
				node.fixedPathStart = node.earliestFinish ?? 0;
				node.fixedPathAmbiguous = false;
			}
			completed.add(node);
		} else unscheduled.add(node);
	}
	const active: { node: PlanNode; finish: number }[] = [];
	const unassigned: PlanNode[] = [];
	const releaseAt = (node: PlanNode): number | undefined => {
		let at = estimateAnchor(node);
		for (const predecessor of node.predecessors) {
			const finishedAt = finishes.get(predecessor);
			if (finishedAt === undefined) return undefined;
			at = Math.max(at, finishedAt);
		}
		return at;
	};
	let time = Math.min(...[...unscheduled].map(estimateAnchor));
	while (unscheduled.size > 0 || active.length > 0) {
		const wasAtCapacity = active.length >= capacity;
		const releasedNow: PlanNode[] = [];
		for (let i = active.length - 1; i >= 0; i--) {
			if (active[i].finish <= time) {
				completed.add(active[i].node);
				releasedNow.push(active[i].node);
				active.splice(i, 1);
			}
		}
		while (active.length < capacity) {
			const candidates = [...unscheduled]
				.filter(
					node =>
						node.predecessors.every(predecessor => completed.has(predecessor)) &&
						(releaseAt(node) ?? Number.POSITIVE_INFINITY) <= time,
				)
				.sort((a, b) => {
					if ((a.status === "in_progress") !== (b.status === "in_progress"))
						return a.status === "in_progress" ? -1 : 1;
					return (priority.get(b) ?? 0) - (priority.get(a) ?? 0) || a.index - b.index;
				});
			const node = candidates.find(candidate => canStart(candidate, active));
			if (!node) break;
			unscheduled.delete(node);
			const anchor = estimateAnchor(node);
			const predecessorFinish = Math.max(0, ...node.predecessors.map(predecessor => finishes.get(predecessor) ?? 0));
			const baseRelease = Math.max(anchor, predecessorFinish);
			let controllers: PlanNode[] = [];
			let ambiguous = false;
			if (node.predecessors.length > 0 && Math.abs(anchor - predecessorFinish) <= CPM_TIE_TOLERANCE_MS) {
				ambiguous = node.predecessors.some(
					predecessor => Math.abs((finishes.get(predecessor) ?? 0) - predecessorFinish) <= CPM_TIE_TOLERANCE_MS,
				);
			} else if (predecessorFinish > anchor + CPM_TIE_TOLERANCE_MS) {
				controllers = node.predecessors.filter(
					predecessor => Math.abs((finishes.get(predecessor) ?? 0) - predecessorFinish) <= CPM_TIE_TOLERANCE_MS,
				);
				ambiguous = controllers.length !== 1;
			}

			const resources = Array.isArray(node.schedule?.resources) ? node.schedule.resources : [];
			const owner = node.schedule?.owner;
			const resourceControllers = releasedNow.filter(previous => {
				const held = Array.isArray(previous.schedule?.resources) ? previous.schedule.resources : [];
				const sameOwner = typeof owner === "string" && owner === previous.schedule?.owner;
				const sameResource = resources.some(resource => held.includes(resource));
				return wasAtCapacity || sameOwner || sameResource;
			});
			if (resourceControllers.length > 0) {
				if (time > baseRelease + CPM_TIE_TOLERANCE_MS) {
					controllers = resourceControllers;
					ambiguous = false;
				} else {
					controllers = [...new Set([...controllers, ...resourceControllers])];
					if (Math.abs(anchor - time) <= CPM_TIE_TOLERANCE_MS) ambiguous = true;
				}
				if (controllers.length > 1) ambiguous = true;
			}
			const parent = !ambiguous && controllers.length === 1 ? controllers[0] : undefined;
			if (!parent && time > anchor + CPM_TIE_TOLERANCE_MS) ambiguous = true;
			if (scenario === "expected") {
				const inheritedAmbiguity = parent?.fixedPathAmbiguous === true;
				const parentExpected = parent?.fixedPathExpectedSeconds ?? 0;
				const parentVariance = parent?.fixedPathVarianceSeconds ?? 0;
				const durations = nodeDurations(node);
				const taskVariance = (durations.spread / 6) ** 2;
				const pathExpected = parentExpected + durations.expected;
				const pathVariance = parentVariance + taskVariance;
				ambiguous =
					ambiguous || inheritedAmbiguity || !Number.isFinite(pathExpected) || !Number.isFinite(pathVariance);
				node.fixedPathParent = parent;
				node.fixedPathAmbiguous = ambiguous;
				node.fixedPathExpectedSeconds = ambiguous ? undefined : pathExpected;
				node.fixedPathVarianceSeconds = ambiguous ? undefined : pathVariance;
				node.fixedPathStart = parent ? parent.fixedPathStart : anchor;
			}
			const finish = time + durationMs(node, scenario);
			starts.set(node, time);
			finishes.set(node, finish);
			if (finish <= time) completed.add(node);
			else active.push({ node, finish });
		}
		if (unscheduled.size === 0 && active.length === 0) break;
		const releases = [...unscheduled]
			.filter(node => node.predecessors.every(predecessor => completed.has(predecessor)))
			.map(releaseAt)
			.filter((at): at is number => at !== undefined && at > time);
		const next = Math.min(...active.map(task => task.finish), ...releases);
		if (!Number.isFinite(next)) {
			unassigned.push(...unscheduled);
			break;
		}
		time = next;
	}
	return { starts, finishes, unassigned };
}

function fixedPathToNode(node: PlanNode): string[] | undefined {
	if (
		node.fixedPathAmbiguous ||
		node.fixedPathExpectedSeconds === undefined ||
		node.fixedPathVarianceSeconds === undefined
	)
		return undefined;
	const path: string[] = [];
	for (let current: PlanNode | undefined = node; current; current = current.fixedPathParent) {
		if (
			current.fixedPathAmbiguous ||
			current.fixedPathExpectedSeconds === undefined ||
			current.fixedPathVarianceSeconds === undefined
		)
			return undefined;
		path.push(current.content);
	}
	return path.reverse();
}

function finiteTimestamp(value: number | undefined): value is number {
	return Number.isFinite(value) && Math.abs(value!) <= 8.64e15;
}

/** Re-observing a plan cannot grant more time; only an estimate or real start can. */
function estimateAnchor(node: PlanNode): number {
	return Math.max(node.estimate!.updatedAt, finiteTimestamp(node.schedule?.startedAt) ? node.schedule!.startedAt! : 0);
}

function latestTimestamp(values: Iterable<number | undefined>): number | undefined {
	let latest: number | undefined;
	for (const value of values)
		if (finiteTimestamp(value)) latest = latest === undefined ? value : Math.max(latest, value);
	return latest;
}

function timestampRange(values: readonly (number | undefined)[]): { earliest: number; latest: number } | undefined {
	let earliest = Number.POSITIVE_INFINITY;
	let latest = Number.NEGATIVE_INFINITY;
	for (const value of values) {
		if (!finiteTimestamp(value)) return undefined;
		earliest = Math.min(earliest, value);
		latest = Math.max(latest, value);
	}
	return values.length > 0 ? { earliest, latest } : undefined;
}

function componentData(validNodes: PlanNode[]): { nodes: PlanNode[]; complete: boolean; finish: number }[] {
	const valid = new Set(validNodes);
	const visited = new Set<PlanNode>();
	const components: { nodes: PlanNode[]; complete: boolean; finish: number }[] = [];
	for (const start of validNodes) {
		if (visited.has(start)) continue;
		const component: PlanNode[] = [];
		const queue = [start];
		visited.add(start);
		let complete = true;
		while (queue.length > 0) {
			const node = queue.shift()!;
			component.push(node);
			if (node.successors.some(successor => !valid.has(successor))) complete = false;
			for (const adjacent of [...node.predecessors, ...node.successors]) {
				if (valid.has(adjacent) && !visited.has(adjacent)) {
					visited.add(adjacent);
					queue.push(adjacent);
				}
			}
		}
		components.push({
			nodes: component,
			complete,
			finish: Math.max(...component.map(node => node.earliestFinish ?? 0)),
		});
	}
	return components;
}

/** Compute PERT-mean CPM and path-aware P95 resource forecasts with optimistic/pessimistic scenarios. */
export function forecastTodoPlan(phases: TodoScheduleInput, options: TodoForecastOptions): TodoPlanForecast {
	const now = options.now;
	const analysis = analyzeDependencies(phases);
	const planningIssues = collectTodoPlanningIssues(phases, analysis);
	const issues: string[] = [];
	const deadlineAt = finiteTimestamp(options.deadlineAt) ? options.deadlineAt : undefined;
	if (options.deadlineAt !== undefined && deadlineAt === undefined)
		issues.push("Deadline timestamp is invalid and was ignored");
	const capacityInput = options.capacity;
	const capacityValid = typeof capacityInput === "number" && Number.isSafeInteger(capacityInput) && capacityInput >= 0;
	const capacityWasFallback = capacityInput === undefined || !capacityValid;
	const requestedCapacity = capacityWasFallback ? DEFAULT_CAPACITY : capacityInput!;
	if (capacityInput !== undefined && !capacityValid)
		issues.push(`Invalid task capacity; using default ${DEFAULT_CAPACITY}`);

	for (const node of analysis.nodes) {
		if (isClosed(node.status)) continue;
		if (node.status === "blocked") {
			node.invalid = true;
			node.issues.push(`Task is blocked: ${node.content}`);
		}
		if (!isValidEstimate(node.estimate)) {
			node.invalid = true;
			node.issues.push(
				node.estimate
					? `Estimate is invalid for task: ${node.content}`
					: `Estimate is unknown for task: ${node.content}`,
			);
		}
		if (node.schedule?.owner === undefined)
			node.issues.push(`Owner is undeclared; resource ETA assumes no owner conflict: ${node.content}`);
		if (node.schedule?.resources === undefined)
			node.issues.push(
				`Resources are undeclared; resource ETA assumes no unlisted resource conflict: ${node.content}`,
			);
	}
	for (const node of analysis.topological) {
		if (!node.invalid) {
			const invalidPredecessor = node.predecessors.find(predecessor => predecessor.invalid);
			if (invalidPredecessor) {
				node.invalid = true;
				node.issues.push(`Prerequisite cannot be forecast for task ${node.content}: ${invalidPredecessor.content}`);
			}
		}
	}

	const validNodes = analysis.uniqueNodes.filter(node => !node.invalid);
	const forecastableCount = validNodes.filter(node => !isClosed(node.status)).length;
	const capacity = Math.min(requestedCapacity === 0 ? forecastableCount : requestedCapacity, forecastableCount);
	const schedulerCapacity = Math.max(1, capacity);
	const validSet = new Set(validNodes);
	const hasUnresolvedOpen = analysis.nodes.some(node => !isClosed(node.status) && node.invalid);
	const validTopological = analysis.topological.filter(node => validSet.has(node));
	for (const node of validTopological) {
		if (isClosed(node.status)) {
			const finishedAt = node.schedule?.finishedAt;
			const startedAt = node.schedule?.startedAt;
			node.earliestFinish = finiteTimestamp(finishedAt) ? finishedAt : undefined;
			node.earliestStart = finiteTimestamp(startedAt) ? startedAt : node.earliestFinish;
			continue;
		}
		const predecessorFinish = Math.max(0, ...node.predecessors.map(predecessor => predecessor.earliestFinish ?? 0));
		node.earliestStart = Math.max(estimateAnchor(node), predecessorFinish);
		node.earliestFinish = node.earliestStart + durationMs(node);
	}
	const knownProjectFinish = latestTimestamp(validNodes.map(node => node.earliestFinish));

	const components = componentData(validNodes);
	if (!hasUnresolvedOpen && knownProjectFinish !== undefined)
		for (const component of components) component.finish = knownProjectFinish;
	const componentFor = new Map<PlanNode, (typeof components)[number]>();
	for (const component of components) for (const node of component.nodes) componentFor.set(node, component);
	for (let index = validTopological.length - 1; index >= 0; index--) {
		const node = validTopological[index];
		const component = componentFor.get(node)!;
		if (!component.complete) continue;
		const successors = node.successors.filter(successor => validSet.has(successor));
		const naturalLateFinish = successors.length
			? Math.min(...successors.map(successor => successor.naturalLatestStart!))
			: component.finish;
		const deadlineLateFinish = successors.length
			? Math.min(...successors.map(successor => successor.latestStart!))
			: (deadlineAt ?? component.finish);
		node.naturalLatestStart = naturalLateFinish - durationMs(node);
		node.latestFinish = deadlineLateFinish;
		node.latestStart = deadlineLateFinish - durationMs(node);
	}
	for (const node of validNodes) {
		const component = componentFor.get(node)!;
		const successors = node.successors;
		if (successors.some(successor => !validSet.has(successor))) continue;
		if (successors.length > 0) {
			node.freeFloatSeconds =
				(Math.min(...successors.map(successor => successor.earliestStart ?? now)) - node.earliestFinish!) / 1000;
		} else if (component.complete) {
			node.freeFloatSeconds = (component.finish - node.earliestFinish!) / 1000;
		}
	}

	const priority = taskPriority(validTopological);
	const resourceSchedules = new Map<ResourceScenario, ResourceSchedule>();
	for (const scenario of ["optimistic", "expected", "pessimistic"] as const)
		resourceSchedules.set(scenario, scheduleResources(validNodes, schedulerCapacity, scenario, priority));
	const expectedSchedule = resourceSchedules.get("expected");
	const optimisticSchedule = resourceSchedules.get("optimistic");
	const pessimisticSchedule = resourceSchedules.get("pessimistic");
	for (const node of analysis.nodes) estimateStaleness(node, now, expectedSchedule?.starts.get(node));
	for (const node of analysis.topological) {
		if (!validSet.has(node)) continue;
		if (isClosed(node.status)) {
			node.confidence = "high";
			continue;
		}
		let confidence: TodoForecastConfidence = node.stale ? "low" : node.estimate!.confidence;
		for (const predecessor of node.predecessors) confidence = lowerConfidence(confidence, predecessor.confidence);
		node.confidence = confidence;
	}
	if (expectedSchedule?.unassigned.length) {
		for (const node of expectedSchedule.unassigned)
			node.issues.push(`Resource scheduler could not place task: ${node.content}`);
	}
	const fixedPathByNode = new Map<PlanNode, string[]>();
	const fixedPathP95ByNode = new Map<PlanNode, number>();
	const fixedPathSigmaByNode = new Map<PlanNode, number>();
	for (const node of validNodes) {
		if (isClosed(node.status)) continue;
		const path = fixedPathToNode(node);
		const expected = node.fixedPathExpectedSeconds;
		const variance = node.fixedPathVarianceSeconds;
		const start = node.fixedPathStart;
		if (
			!path ||
			expected === undefined ||
			variance === undefined ||
			start === undefined ||
			!expectedSchedule?.starts.has(node)
		) {
			node.resourceConfidence = "unknown";
			node.issues.push(`Fixed resource path is tied or unavailable; analytic P95 ETA is unknown: ${node.content}`);
			continue;
		}
		const sigma = Math.sqrt(variance);
		const p95Finish = start + (expected + FIXED_PATH_P95_Z * sigma) * 1000;
		if (!finiteTimestamp(p95Finish) || !Number.isFinite(sigma)) {
			node.resourceConfidence = "unknown";
			node.fixedPathAmbiguous = true;
			node.issues.push(`Fixed resource path produced an invalid P95 ETA: ${node.content}`);
			continue;
		}
		fixedPathByNode.set(node, path);
		fixedPathP95ByNode.set(node, p95Finish);
		fixedPathSigmaByNode.set(node, sigma);
	}
	const openNodes = analysis.nodes.filter(node => !isClosed(node.status));
	const unresolvedCount = openNodes.filter(node => node.invalid || !fixedPathP95ByNode.has(node)).length;
	const allResourceScenariosComplete =
		!!expectedSchedule &&
		!!optimisticSchedule &&
		!!pessimisticSchedule &&
		expectedSchedule.unassigned.length === 0 &&
		optimisticSchedule.unassigned.length === 0 &&
		pessimisticSchedule.unassigned.length === 0;
	const knownExpectedFinish = expectedSchedule ? latestTimestamp(expectedSchedule.finishes.values()) : undefined;
	const knownOptimisticFinish = optimisticSchedule ? latestTimestamp(optimisticSchedule.finishes.values()) : undefined;
	const knownPessimisticFinish = pessimisticSchedule
		? latestTimestamp(pessimisticSchedule.finishes.values())
		: undefined;
	const knownFixedPathFinish = latestTimestamp(fixedPathP95ByNode.values());
	const knownTerminalFinish = latestTimestamp(
		analysis.nodes.filter(node => isClosed(node.status)).map(node => node.schedule?.finishedAt),
	);
	const knownResourceFinish = latestTimestamp([...fixedPathP95ByNode.values(), knownTerminalFinish]);
	const globalForecastKnown = unresolvedCount === 0 && allResourceScenariosComplete;
	const earliestFinish = !hasUnresolvedOpen ? knownProjectFinish : undefined;
	const resourceFinish = globalForecastKnown ? knownResourceFinish : undefined;
	const fixedPathP95Finish = globalForecastKnown ? knownFixedPathFinish : undefined;
	const expectedResourceFinish = !hasUnresolvedOpen && allResourceScenariosComplete ? knownExpectedFinish : undefined;
	const knownWorkFinish = unresolvedCount > 0 ? knownResourceFinish : undefined;
	const range = globalForecastKnown
		? timestampRange([knownOptimisticFinish, knownExpectedFinish, knownPessimisticFinish])
		: undefined;

	const resourceAssumptions: string[] = [];
	if (openNodes.some(node => node.schedule?.owner === undefined))
		resourceAssumptions.push("Undeclared owners are assumed not to conflict");
	if (openNodes.some(node => node.schedule?.resources === undefined))
		resourceAssumptions.push("Undeclared resources are assumed not to conflict");
	if (openNodes.length > 0) {
		const capacityDescription = capacityWasFallback
			? `default ${DEFAULT_CAPACITY} (omitted or invalid input)`
			: requestedCapacity === 0
				? "Unlimited (0)"
				: `requested ${requestedCapacity}`;
		resourceAssumptions.push(
			`Task capacity ${capacityDescription}; effective concurrency ${capacity} of ${forecastableCount} forecastable open tasks`,
		);
	}
	for (const assumption of resourceAssumptions) issues.push(`Resource assumption: ${assumption}`);
	const hasResourceAssumptions =
		openNodes.some(node => node.schedule?.owner === undefined || node.schedule?.resources === undefined) ||
		(openNodes.length > 0 && capacityWasFallback);

	let confidence: TodoForecastConfidence;
	if (unresolvedCount > 0 || !allResourceScenariosComplete) confidence = "unknown";
	else {
		confidence = "high";
		for (const node of validNodes)
			if (!isClosed(node.status)) confidence = lowerConfidence(confidence, node.confidence);
	}
	const resourceConfidence: TodoForecastConfidence = !globalForecastKnown
		? "unknown"
		: hasResourceAssumptions
			? lowerConfidence(confidence, "low")
			: confidence;

	let deadlineStatus: TodoDeadlineStatus | undefined;
	let deadlineMissed: boolean | undefined;
	let deadlineSlackSeconds: number | undefined;
	if (deadlineAt !== undefined) {
		deadlineMissed = deadlineAt < now;
		if (deadlineMissed) deadlineStatus = "overdue";
		else if (unresolvedCount > 0 || !allResourceScenariosComplete) {
			deadlineStatus = knownWorkFinish !== undefined && knownWorkFinish > deadlineAt ? "at-risk" : "unknown";
		} else if (globalForecastKnown && resourceFinish !== undefined) {
			deadlineSlackSeconds = (deadlineAt - resourceFinish) / 1000;
			deadlineStatus = resourceFinish > deadlineAt ? "at-risk" : "on-track";
		} else deadlineStatus = "unknown";
		if (deadlineStatus === "overdue") issues.push("Deadline is overdue as of forecast time");
		else if (deadlineStatus === "at-risk") issues.push("Forecast risks missing the deadline");
	}
	const planningIssuesByTask = new Map<string, TodoPlanningIssue[]>();
	for (const issue of planningIssues) {
		const taskIssues = planningIssuesByTask.get(issue.task);
		if (taskIssues) taskIssues.push(issue);
		else planningIssuesByTask.set(issue.task, [issue]);
	}

	const rows: TodoTaskForecast[] = analysis.nodes.map(node => {
		const duplicateClosed =
			isClosed(node.status) && node.dependencyIssues.some(issue => issue.code === "duplicate-task");
		const terminal = isClosed(node.status);
		const resourceStart = expectedSchedule?.starts.get(node);
		const expectedResourceTaskFinish = expectedSchedule?.finishes.get(node);
		const actualFinishedAt = node.schedule?.finishedAt;
		const resourceTaskFinish = terminal
			? finiteTimestamp(actualFinishedAt)
				? actualFinishedAt
				: undefined
			: fixedPathP95ByNode.get(node);
		const taskRange = timestampRange([
			optimisticSchedule?.finishes.get(node),
			expectedResourceTaskFinish,
			resourceTaskFinish,
			pessimisticSchedule?.finishes.get(node),
		]);
		const estimate = validSet.has(node) && isValidEstimate(node.estimate) ? nodeDurations(node) : undefined;
		const estimateRequired = !terminal && node.status !== "blocked" && !isValidEstimate(node.estimate);
		let rowConfidence: TodoForecastConfidence = terminal && !duplicateClosed ? "high" : node.confidence;
		if (!terminal && !validSet.has(node)) rowConfidence = "unknown";
		let rowResourceConfidence: TodoForecastConfidence = rowConfidence;
		if (
			!terminal &&
			(node.schedule?.owner === undefined || node.schedule?.resources === undefined) &&
			rowConfidence !== "unknown"
		)
			rowResourceConfidence = lowerConfidence(rowConfidence, "low");
		if (!terminal && (resourceStart === undefined || resourceTaskFinish === undefined))
			rowResourceConfidence = "unknown";
		const criticalityKnown = validSet.has(node) && componentFor.get(node)?.complete === true;
		const totalFloatSeconds =
			node.latestStart !== undefined && node.earliestStart !== undefined
				? (node.latestStart - node.earliestStart) / 1000
				: undefined;
		const naturalFloat =
			node.naturalLatestStart !== undefined && node.earliestStart !== undefined
				? (node.naturalLatestStart - node.earliestStart) / 1000
				: undefined;
		const rowIssues = [...node.issues];
		if (validSet.has(node) && !criticalityKnown)
			rowIssues.push("Critical path and deadline float are unknown because a downstream task is unresolved");
		if (
			validSet.has(node) &&
			node.freeFloatSeconds === undefined &&
			node.successors.length === 0 &&
			!componentFor.get(node)?.complete
		)
			rowIssues.push("Free float is unknown because project continuation is unresolved");
		if (
			expectedSchedule?.unassigned.includes(node) ||
			optimisticSchedule?.unassigned.includes(node) ||
			pessimisticSchedule?.unassigned.includes(node)
		)
			rowIssues.push(`Resource scheduler could not forecast task in every duration scenario: ${node.content}`);
		const blockedPrerequisite = node.predecessors.find(predecessor => predecessor.status === "blocked");
		const awaitingPrerequisite = blockedPrerequisite
			? `${blockedPrerequisite.content}${blockedPrerequisite.blocker ? `: ${blockedPrerequisite.blocker}` : ""}`
			: undefined;
		return {
			blocker: node.blocker,
			awaitingPrerequisite,
			estimateRangeSeconds: isValidEstimate(node.estimate)
				? {
						optimistic: node.estimate.optimisticSeconds,
						likely: node.estimate.likelySeconds,
						pessimistic: node.estimate.pessimisticSeconds,
					}
				: undefined,
			planningIssues: planningIssuesByTask.get(node.content),
			content: node.content,
			status: node.status,
			owner: typeof node.schedule?.owner === "string" ? node.schedule.owner : undefined,
			earliestStart: validSet.has(node) ? node.earliestStart : undefined,
			earliestFinish: validSet.has(node) ? node.earliestFinish : undefined,
			latestStart: validSet.has(node) ? node.latestStart : undefined,
			latestFinish: validSet.has(node) ? node.latestFinish : undefined,
			totalFloatSeconds,
			freeFloatSeconds: validSet.has(node) ? node.freeFloatSeconds : undefined,
			resourceStart,
			resourceFinish: resourceTaskFinish,
			fixedPath: fixedPathByNode.get(node),
			fixedPathExpectedSeconds: node.fixedPathExpectedSeconds,
			fixedPathSigmaSeconds: fixedPathSigmaByNode.get(node),
			fixedPathP95Finish: terminal ? undefined : resourceTaskFinish,
			expectedResourceFinish: expectedResourceTaskFinish,
			estimateRequired,
			estimateMeanSeconds: estimate?.expected,
			range: taskRange,
			critical: !!criticalityKnown && !terminal && Math.abs(naturalFloat ?? Number.POSITIVE_INFINITY) < 0.001,
			criticalityKnown,
			ready: node.ready,
			stale: node.stale,
			overdue: !terminal && resourceTaskFinish !== undefined && now > resourceTaskFinish,
			estimateRevision: node.schedule?.estimateRevision ?? (node.estimate ? 1 : 0),
			reestimateCount: node.schedule?.reestimateCount ?? 0,
			confidence: rowConfidence,
			resourceConfidence: rowResourceConfidence,
			issues: [...new Set(rowIssues)],
			estimateUpdatedAt: node.estimate?.updatedAt,
			progressAt: node.schedule?.progress?.at,
			startedAt: node.schedule?.startedAt,
			finishedAt: node.schedule?.finishedAt,
		};
	});

	for (const row of rows) for (const issue of row.issues) issues.push(issue);
	for (const issue of analysis.issues) {
		if (issue.code === "duplicate-task" && !issues.includes(issue.message)) issues.push(issue.message);
	}
	const plan: TodoPlanForecast = {
		rows,
		now,
		deadlineAt,
		earliestFinish: !hasUnresolvedOpen ? earliestFinish : undefined,
		resourceFinish,
		fixedPathP95Finish,
		expectedResourceFinish,
		knownWorkFinish,
		unresolvedCount,
		planningIssues,
		range,
		confidence,
		resourceConfidence,
		resourceAssumptions: resourceAssumptions.length ? resourceAssumptions : undefined,
		deadlineStatus,
		deadlineMissed,
		deadlineSlackSeconds,
		issues: [...new Set(issues)],
	};
	return plan;
}

function safeText(value: string): string {
	return sanitizeText(value)
		.replace(/[\r\n\t]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function formatTimestamp(value: number | undefined): string {
	if (!finiteTimestamp(value)) return "unknown";
	try {
		return new Date(value).toISOString();
	} catch {
		return "unknown";
	}
}

function formatSeconds(value: number | undefined): string {
	if (!Number.isFinite(value)) return "unknown";
	const absolute = Math.abs(value!);
	const sign = value! > 0 ? "+" : "";
	const digits = absolute >= 10 ? 1 : 2;
	return `${sign}${value!.toFixed(digits)}s`;
}

function formatCompletion(row: TodoTaskForecast, now: number, compact: boolean, expanded = false): string {
	const status = row.status === "completed" ? "done" : "abandoned";
	if (!finiteTimestamp(row.finishedAt))
		return expanded || !compact ? `${status} · completion time not recorded` : status;
	const clock = compact ? displayTimestamp(row.finishedAt, now) : formatTimestamp(row.finishedAt);
	const seconds = Math.floor((now - row.finishedAt) / 1000);
	if (seconds < 0) return `${status} at ${clock} · clock ahead`;
	const age =
		seconds < 60
			? `${seconds}s`
			: seconds < 3600
				? `${Math.floor(seconds / 60)}m`
				: seconds < 86400
					? `${Math.floor(seconds / 3600)}h`
					: `${Math.floor(seconds / 86400)}d`;
	return `${status} at ${clock} · ${age} ago`;
}

/** Compact item summary; task identity and detailed issues remain in structured data. */
export function formatTaskForecast(row: TodoTaskForecast, now: number, expanded = false): string {
	const terminal = row.status === "completed" || row.status === "abandoned";
	const effort = row.estimateRangeSeconds
		? `effort O/L/P ${formatSeconds(row.estimateRangeSeconds.optimistic)}/${formatSeconds(row.estimateRangeSeconds.likely)}/${formatSeconds(row.estimateRangeSeconds.pessimistic)}`
		: "remaining effort estimate required";
	const planActions = row.planningIssues?.map(issue => PLANNING_ACTION_LABELS[issue.code]).join("; ");
	const label = terminal
		? formatCompletion(row, now, false)
		: row.status === "blocked"
			? `needs unblock${row.blocker ? `: ${safeText(row.blocker)}` : ""} · ${effort}`
			: row.awaitingPrerequisite
				? `awaits prerequisite: ${safeText(row.awaitingPrerequisite)} · ${effort}`
				: row.resourceFinish !== undefined
					? `ETA fixed-path P95: ${formatTimestamp(row.resourceFinish)}`
					: planActions
						? `plan required: ${planActions}`
						: `forecast unavailable${row.issues[0] ? `: ${safeText(row.issues[0])}` : ""}`;
	const parts = [label];
	if (row.confidence !== "unknown") parts.push(`confidence: ${row.confidence}`);
	if (row.resourceConfidence && row.resourceConfidence !== "unknown")
		parts.push(`resource confidence: ${row.resourceConfidence}`);
	if (row.criticalityKnown === true) parts.push(`critical: ${row.critical ? "yes" : "no"}`);
	if (row.overdue)
		parts.push(
			`Fixed-path P95 ETA overdue; explicit reestimate required (revision ${row.estimateRevision}, reestimates ${row.reestimateCount})`,
		);
	if (row.stale)
		parts.push(expanded ? `stale estimate (updated: ${formatTimestamp(row.estimateUpdatedAt)})` : "stale estimate");
	if (expanded) {
		parts.push(`as of: ${formatTimestamp(now)}`, `ready: ${row.ready ? "yes" : "no"}`);
		if (row.owner !== undefined) parts.push(`owner: ${safeText(row.owner)}`);
		const cpm = [
			row.earliestStart === undefined ? undefined : `ES ${formatTimestamp(row.earliestStart)}`,
			row.earliestFinish === undefined ? undefined : `EF ${formatTimestamp(row.earliestFinish)}`,
			row.latestStart === undefined ? undefined : `LS ${formatTimestamp(row.latestStart)}`,
			row.latestFinish === undefined ? undefined : `LF ${formatTimestamp(row.latestFinish)}`,
		].filter((value): value is string => value !== undefined);
		if (cpm.length) parts.push(`CPM ${cpm.join(" / ")}`);
		const float = [
			row.totalFloatSeconds === undefined ? undefined : `total ${formatSeconds(row.totalFloatSeconds)}`,
			row.freeFloatSeconds === undefined ? undefined : `free ${formatSeconds(row.freeFloatSeconds)}`,
		].filter((value): value is string => value !== undefined);
		if (float.length) parts.push(`float ${float.join(" / ")}`);
		const resourceTimes = [
			row.resourceStart === undefined ? undefined : `resource start ${formatTimestamp(row.resourceStart)}`,
			terminal
				? "finish closed"
				: row.resourceFinish === undefined
					? undefined
					: `fixed-path P95 finish ${formatTimestamp(row.resourceFinish)}`,
			row.expectedResourceFinish === undefined
				? undefined
				: `expected finish ${formatTimestamp(row.expectedResourceFinish)}`,
		].filter((value): value is string => value !== undefined);
		if (resourceTimes.length) parts.push(resourceTimes.join(" / "));
		if (row.fixedPathExpectedSeconds !== undefined || row.fixedPathSigmaSeconds !== undefined)
			parts.push(
				`fixed path TE/σ seconds: ${formatSeconds(row.fixedPathExpectedSeconds)}/${formatSeconds(row.fixedPathSigmaSeconds)}`,
			);
		if (row.fixedPath?.length) parts.push(`fixed path: ${row.fixedPath.map(safeText).join(" → ")}`);
		if (row.range)
			parts.push(`scenario envelope: ${formatTimestamp(row.range.earliest)}..${formatTimestamp(row.range.latest)}`);
		if (row.planningIssues?.length)
			parts.push(`plan required: ${row.planningIssues.map(issue => safeText(issue.message)).join("; ")}`);
		else if (row.issues.length) parts.push(`issues: ${row.issues.map(safeText).join("; ")}`);
	}
	return parts.join(" | ");
}

/** Bounded plan summary; consumers needing task details use `plan.rows` and `plan.issues`. */
export function formatPlanForecast(plan: TodoPlanForecast, _now: number): string {
	const parts: string[] = [];
	if (plan.unresolvedCount > 0) {
		if (plan.knownWorkFinish !== undefined)
			parts.push(`Known work fixed-path P95 (partial): ${formatTimestamp(plan.knownWorkFinish)}`);
		parts.push(`unresolved: ${plan.unresolvedCount}`);
	} else if (plan.resourceFinish !== undefined)
		parts.push(`ETA fixed-path P95 (normal approximation): ${formatTimestamp(plan.resourceFinish)}`);
	else parts.push("resource ETA unavailable");
	if (plan.expectedResourceFinish !== undefined)
		parts.push(`expected resource finish: ${formatTimestamp(plan.expectedResourceFinish)}`);
	if (plan.deadlineAt !== undefined) parts.push(`due: ${formatTimestamp(plan.deadlineAt)}`);
	if (plan.range)
		parts.push(`scenario envelope: ${formatTimestamp(plan.range.earliest)}..${formatTimestamp(plan.range.latest)}`);
	if (plan.deadlineStatus) parts.push(`deadline: ${plan.deadlineStatus}`);
	if (plan.deadlineSlackSeconds !== undefined) parts.push(`slack: ${formatSeconds(plan.deadlineSlackSeconds)}`);
	if (plan.issues.length) parts.push(`issues: ${plan.issues.length}`);
	if (plan.planningIssues.length) parts.push(`plan required: ${plan.planningIssues.length} repairs`);
	if (plan.resourceAssumptions?.length) parts.push(`resource assumptions: ${plan.resourceAssumptions.length}`);
	return parts.join(" | ");
}

/** Human-facing clocks use minute precision; machine forecasts retain milliseconds. */
function displayTimestamp(value: number | undefined, now: number): string {
	if (!finiteTimestamp(value)) return "unknown";
	const date = new Date(value);
	const sameDay = date.toDateString() === new Date(now).toDateString();
	const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	return sameDay ? clock : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

export function formatTaskForecastDisplay(row: TodoTaskForecast, now: number, expanded = false): string {
	const terminal = row.status === "completed" || row.status === "abandoned";
	const effort = row.estimateRangeSeconds
		? `effort O/L/P ${Math.round(row.estimateRangeSeconds.optimistic)}/${Math.round(row.estimateRangeSeconds.likely)}/${Math.round(row.estimateRangeSeconds.pessimistic)}s`
		: "effort estimate required";
	const planActions = row.planningIssues?.map(issue => PLANNING_ACTION_LABELS[issue.code]).join(", ");
	const label = terminal
		? formatCompletion(row, now, true, expanded)
		: row.status === "blocked"
			? `needs unblock${row.blocker ? `: ${expanded ? safeText(row.blocker) : truncateToWidth(safeText(row.blocker), 32)}` : ""} · ${effort}`
			: row.awaitingPrerequisite
				? `awaits prerequisite: ${expanded ? safeText(row.awaitingPrerequisite) : truncateToWidth(safeText(row.awaitingPrerequisite), 32)} · ${effort}`
				: row.resourceFinish !== undefined
					? `fixed-path P95 ${displayTimestamp(row.resourceFinish, now)}`
					: planActions
						? `plan required: ${planActions}`
						: `forecast unavailable${row.issues[0] ? `: ${safeText(row.issues[0])}` : ""}`;
	const parts = [label];
	const workEnd = terminal ? row.finishedAt : row.status === "in_progress" ? now : undefined;
	const worked =
		finiteTimestamp(row.startedAt) && finiteTimestamp(workEnd) && workEnd >= row.startedAt
			? `work ${Math.floor((workEnd - row.startedAt) / 60_000)}m`
			: undefined;
	if (row.estimateRangeSeconds)
		parts.push(`${worked ? `${worked} / ` : ""}estimate ${Math.ceil(row.estimateRangeSeconds.likely / 60)}m`);
	else if (worked) parts.push(worked);
	if (row.overdue) parts.push(`overdue ${Math.ceil((now - row.resourceFinish!) / 60_000)}m`);
	if (row.criticalityKnown === true && row.critical) parts.push("critical");
	if (row.reestimateCount > 0) parts.push(`reestimated ${row.reestimateCount}×`);
	if (expanded) {
		if (row.confidence !== "unknown") parts.push(`confidence ${row.confidence}`);
		if (row.criticalityKnown === true) parts.push(`critical ${row.critical ? "yes" : "no"}`);
		if (row.owner) parts.push(`owner ${safeText(row.owner)}`);
		const cpm = [
			row.earliestStart === undefined ? undefined : `ES ${displayTimestamp(row.earliestStart, now)}`,
			row.earliestFinish === undefined ? undefined : `EF ${displayTimestamp(row.earliestFinish, now)}`,
			row.latestStart === undefined ? undefined : `LS ${displayTimestamp(row.latestStart, now)}`,
			row.latestFinish === undefined ? undefined : `LF ${displayTimestamp(row.latestFinish, now)}`,
		].filter((value): value is string => value !== undefined);
		if (cpm.length) parts.push(`CPM ${cpm.join(" / ")}`);
		const float = [
			row.totalFloatSeconds === undefined ? undefined : `total ${Math.round(row.totalFloatSeconds / 60)}m`,
			row.freeFloatSeconds === undefined ? undefined : `free ${Math.round(row.freeFloatSeconds / 60)}m`,
		].filter((value): value is string => value !== undefined);
		if (float.length) parts.push(`float ${float.join(" / ")}`);
		if (row.resourceStart !== undefined) parts.push(`resource start ${displayTimestamp(row.resourceStart, now)}`);
		if (row.expectedResourceFinish !== undefined)
			parts.push(`expected resource finish ${displayTimestamp(row.expectedResourceFinish, now)}`);
		if (row.fixedPathP95Finish !== undefined)
			parts.push(`fixed-path P95 finish ${displayTimestamp(row.fixedPathP95Finish, now)}`);
		if (row.fixedPathExpectedSeconds !== undefined || row.fixedPathSigmaSeconds !== undefined)
			parts.push(
				`fixed path TE/σ ${formatSeconds(row.fixedPathExpectedSeconds)}/${formatSeconds(row.fixedPathSigmaSeconds)}`,
			);
		if (row.fixedPath?.length) parts.push(`fixed path ${row.fixedPath.map(safeText).join(" → ")}`);
		if (row.planningIssues?.length)
			parts.push(`plan required: ${row.planningIssues.map(issue => safeText(issue.message)).join("; ")}`);
		else if (row.issues.length) parts.push(row.issues.map(safeText).join("; "));
	}
	return parts.join(" · ");
}

export function formatPlanForecastDisplay(plan: TodoPlanForecast, now: number): string {
	const parts: string[] = [];
	if (plan.unresolvedCount > 0) {
		if (plan.knownWorkFinish !== undefined)
			parts.push(`Known work fixed-path P95 ${displayTimestamp(plan.knownWorkFinish, now)} (partial)`);
		parts.push(`${plan.unresolvedCount} unresolved`);
	} else if (plan.resourceFinish !== undefined)
		parts.push(`ETA fixed-path P95 ${displayTimestamp(plan.resourceFinish, now)}`);
	else parts.push("Resource ETA unavailable");
	if (plan.deadlineAt !== undefined)
		parts.push(
			`due ${displayTimestamp(plan.deadlineAt, now)}${plan.deadlineStatus ? ` (${plan.deadlineStatus})` : ""}`,
		);
	if (plan.planningIssues.length) parts.push(`plan required: ${plan.planningIssues.length} repairs`);
	const overdue = plan.rows.filter(row => row.overdue).length;
	if (overdue) parts.push(`${overdue} overdue`);
	return parts.join(" · ");
}
