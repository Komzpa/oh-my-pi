export * from "./todo-infra";
import { todoAttemptIsInfra, todoWorkAttempts } from "./todo-infra";
import { drawAttemptChain, riskCells, riskRandom, type RowRiskOptions, type RowRiskForecast } from "./todo-row-risk";
export * from "./todo-row-risk";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { truncateToWidth } from "../utils";
import { TRUNCATE_LENGTHS } from "../render/render-utils";

export type TodoConfidence = "low" | "medium" | "high";
export type TodoForecastConfidence = TodoConfidence | "unknown";
/** Delivered legacy rows can retain an open raw status; all consumers use the same state. */
export function isTodoAwaitingReview(task: { status: string; schedule?: TodoSchedule }): boolean {
	return (
		task.status !== "abandoned" &&
		!!task.schedule &&
		(!task.schedule.reviewAnswers?.length || !!task.schedule.auditEscalation) &&
		(task.schedule?.review === "user" || (todoNeedsOwnerDecision(task.schedule) && todoRowHasDeliverable(task))) &&
		(!!task.schedule.auditEscalation ||
			task.schedule.reviewPagePending === true ||
			task.status === "completed" ||
			task.schedule.visibleAt !== undefined ||
			task.schedule.firstDeliveredAt !== undefined ||
			!!task.schedule.reviewSummary?.trim() ||
			task.schedule.attemptHistory?.some(
				attempt => Array.isArray(attempt.deliverablePaths) && attempt.deliverablePaths.length > 0,
			) === true)
	);
}

/** Saved decisions belong to this content identity, across attempts and forwarded page answers. */
export function todoNeedsOwnerDecision(schedule: TodoSchedule | undefined): boolean {
	return (
		schedule?.decision === "owner" &&
		!schedule.reviewAnswers?.length &&
		schedule.review !== "accepted" &&
		schedule.review !== "redo" &&
		schedule.review !== "drop"
	);
}

/** A review decision was actually handed to the user, rather than merely prepared. */
export function isTodoReviewHandedOff(task: { status: string; schedule?: TodoSchedule }): boolean {
	const schedule = task.schedule;
	return (
		isTodoAwaitingReview(task) &&
		schedule?.handoffPending !== true &&
		schedule?.reviewPagePending !== true &&
		(!!schedule?.reviewPage?.trim() || (schedule?.handoffPending === false && !!schedule.reviewSummary?.trim()))
	);
}

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

/** Immutable delivery lineage and the harness-owned one-shot supersession receipt. */
export interface TodoAuditOrigin {
	parent: string;
	remote?: string;
	branch?: string;
	commit?: string;
	repoPath?: string;
	supersededAt?: number;
	retargetHead?: string;
	attemptsBefore?: number;
	resolution?: "retarget" | "accept";
}

export function todoAuditOrigin(parent: { content: string; schedule?: TodoSchedule }): TodoAuditOrigin {
	const schedule = parent.schedule;
	const receipt = schedule?.executor?.gitCommits?.at(-1) ?? schedule?.attemptHistory?.at(-1)?.gitCommits?.at(-1);
	const target = /^Push: run project gates and push ([^/\s]+)\/(.+)$/.exec(parent.content);
	const binding = schedule?.resources?.map(resource => /^git:(.+)@([0-9a-f]{7,64})$/.exec(resource)).find(Boolean);
	return {
		parent: parent.content,
		remote: target?.[1] ?? schedule?.audit?.remote,
		branch: target?.[2] ?? schedule?.audit?.branch,
		commit: receipt?.commit ?? binding?.[2] ?? schedule?.audit?.head,
		repoPath: receipt?.repoPath ?? binding?.[1] ?? schedule?.audit?.repoPath,
	};
}

export function todoAuditTarget(origin: TodoAuditOrigin): string {
	return [origin.remote && origin.branch ? `${origin.remote}/${origin.branch}` : origin.branch, origin.commit]
		.filter(Boolean)
		.join("@");
}

export function todoSupersededReason(origin: TodoAuditOrigin): string {
	return `superseded: ${todoAuditTarget(origin)} merged/removed; finding not carried forward`;
}

/** Retain the keyed review protocol without deriving a dependency graph here.
 * Its consumer still validates every edge against the current graph. */
export function retainTodoDependencyReviews(schedule: TodoSchedule): void {
	for (const evidence of [schedule.progress?.evidence, schedule.audit?.evidence]) {
		const key = /^Dependency review (chain:[0-9a-f]+):/.exec(evidence ?? "")?.[1];
		if (key && evidence)
			schedule.dependencyReviews = {
				...schedule.dependencyReviews,
				[key]: [...new Set([...(schedule.dependencyReviews?.[key] ?? []), evidence])],
			};
	}
}

/** Forecast metadata belongs to the exact task content; there are deliberately no generated IDs. */
/** Explicit immutable locators, criterion revision and available prerequisite receipts; never prose. */
export interface TodoMaterialInputs {
	criterion: string;
	receipts: string[];
	prerequisites: string[];
}

export interface TodoSchedule {
	materialInputs?: TodoMaterialInputs;
	dependencyReviews?: Record<string, string[]>;
	/** Queued dispatch owns no resources until admission succeeds. */
	resourceWait?: { row: string; workerId?: string };
	/** Agent-authored product choices beyond the ledger request require an owner decision. */
	decision?: "owner";
	agentProfile?: string;
	/** Explicit scope cut, retained as a visible follow-up. */
	postDeadline?: boolean;
	/** `undefined` means unknown; `[]` explicitly means independent. References are exact task content. */
	dependencies?: string[];
	/** Exclusive while this task is running. */
	owner?: string;
	/** Exclusive identifiers while running. `undefined` is undeclared; [] grants no file writes. */
	resources?: string[];
	/** Read claims do not exclude writers; reads may observe concurrent changes. */
	readOnly?: boolean;
	/** Mode of the current owner's resource claim, independent of the row policy. */
	ownerReadOnly?: { owner: string; readOnly: boolean };
	estimate?: TodoEstimate;
	/** Immutable first accepted estimate for session calibration and original promise. */
	firstEstimate?: TodoEstimate;
	/** Server-owned revisions; first estimate is revision 1, with zero reestimates. */
	estimateRevision?: number;
	/** PERT mean captured at first dispatch, used by empirical attempt ratios. */
	riskEstimateMeanSeconds?: number;
	/** Reestimates under the current owner; resets on restaffing for the exhaustion gate. */
	reestimateCount?: number;
	/** Row-wide reestimates, retained across owner changes for calibration and churn. */
	cumulativeReestimateCount?: number;
	progress?: { at: number; evidence: string };
	startedAt?: number;
	finishedAt?: number;
	/** Time this row first entered the plan as a user requirement. */
	firstRequirementAt?: number;
	/** Measured preview commit ancestry; written by the preview runtime. */
	visibleAt?: number;
	previewPending?: boolean;
	previewTracked?: boolean;
	previewIdentityMissing?: boolean;
	previewPartial?: boolean;
	/** First usable result was handed to the user at this time. */
	firstDeliveredAt?: number;
	/** Short final worker report retained for the user's review handoff. */
	reviewSummary?: string;
	handoffPending?: boolean;
	/** Durable audit convergence and advisory backlog, retained across executor runs. */
	auditRounds?: number;
	auditBase?: string;
	auditEscalation?: string;
	auditFollowUps?: string[];
	auditOrigin?: TodoAuditOrigin;
	deliveryCritic?: {
		key: string;
		startedAt: number;
		verdict: "pending" | "clean" | "defects";
		/** Severity-aware clean verdicts also satisfy the runtime row audit. */
		classified?: boolean;
		findings?: TodoAuditFinding[];
		timedOut?: boolean;
		evidence?: string;
	};
	/** Runtime-owned audit of a delivered worker result; `delivery` binds it to one executor run. */
	audit?: TodoRowAudit;
	/** Published decision artifact, probed at the idle lead boundary. */
	reviewPage?: string;
	/** Published card slug; legacy rows use an unambiguous landed row/title match. */
	reviewCard?: string;
	/** Applied (page, card, content hash, answer) receipts, retained across rework. */
	reviewAnswers?: string[];
	/** A refused handoff remains pending until its published row card resolves. */
	reviewPagePending?: boolean;
	/** Append-only durable attempts for this exact row. */
	attemptHistory?: TodoReworkAttempt[];
	/** User review state for a delivered implementation result. */
	review?: "user" | "accepted" | "redo" | "drop";
	reviewClosingBlocked?: string;
	/** Completion-gate reason recorded when the user's Accept closed the row anyway. */
	acceptedAuditFollowUp?: string;
	/** A row whose work is speculative until the named review is accepted. */
	speculativeOn?: string;
	/** Observed Task worker that actually executed this row, independent of forecast ownership. */
	/** Durable membership for concurrent row workers. */
	workerIds?: string[];
	executor?: {
		gitCommits?: { commit: string; repoPath: string }[];
		workerId: string;
		resumedAfterCrash?: boolean;
		agentProfile?: string;
		resolvedModel?: string;
		thinkingLevel?: string;
		startedAt: number;
		finishedAt?: number;
		outcome?: "completed" | "failed" | "aborted";
	};
}

/**
 * One batched audit of delivered rows at one repository head. A pass verifies the row; a defect
 * or two genuinely inconclusive audits return it to a worker.
 * Missing verdicts retry once, then return a concrete evidence task to the lead.
 */
export interface TodoAuditFinding {
	kind: string;
	evidence: string;
	severity?: "blocker" | "later";
	action?: string;
}

export interface TodoRowAudit {
	materialInputs?: TodoMaterialInputs;
	evidenceHistory?: { inputsKey: string; evidence: string }[];
	remote?: string;
	branch?: string;
	issues?: TodoAuditFinding[];
	workerId?: string;
	/** The worker was explicitly stopped; do not relaunch this audit for the same delivery and head. */
	cancelled?: boolean;
	/** `todoRowDeliveryKey` of the executor run being audited; a newer run invalidates this record. */
	delivery: string;
	repoPath: string;
	head: string;
	/** Resource set recorded when the audit started; legacy records may omit it. */
	resourcesKey?: string;
	/** This inconclusive result records that the pinned checkout did not match. */
	bindingMismatch?: boolean;
	startedAt: number;
	verdict: "pending" | "pass" | "fail" | "inconclusive" | "omitted" | "unavailable";
	agent?: string;
	/** Audit attempts for this delivery at this head, including missing verdicts. */
	attempts?: number;
	/** Evidence text already audited; timestamp-only updates cannot restart the same audit. */
	evidence?: string;
	findings?: string;
	at?: number;
}

/** One immutable terminal worker attempt attached to its owning todo row. */
export interface TodoReworkAttempt {
	gitCommits?: { commit: string; repoPath: string }[];
	attemptId: string;
	workerName: string;
	resolvedModel: string;
	effort: string;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	terminalStatus: "completed" | "failed" | "aborted";
	deliverablePaths: string[];
	rejectionReason?: string;
	reflectionAnswer?: string;
	noAnswerReason?: string;
	finalReportParagraph?: string;
	interruption?: "restart";
	infraFailureLine?: string;
	infraFailureError?: string;
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
	schedule?: TodoSchedule;
	blocker?: string;
	/** Direct blocked prerequisite and its reason, when known. */
	awaitingPrerequisite?: string;
	/** A blocked row that only the user can unblock, with the chief's own proposal when recorded. */
	waitsForUser?: TodoUserWait;
	/** Parked rows whose proposal this row proceeds on; re-check it when the user answers. */
	onProposal?: string[];
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
	/** Sum of recorded worker-attempt durations, when any are available. */
	attemptDurationMs?: number;
}

export type TodoDeadlineStatus = "overdue" | "will-miss" | "at-risk" | "on-track" | "unknown";

export interface TodoPlanPrediction {
	capacity?: number;
	provenance?: string;
	sessionId: string;
	originAt: number;
	rawP50Finish: number;
	predictionVersion: string;
	membershipFingerprint: string;
	actualFinish?: number;
	observedAt?: number;
	upperFinish?: number;
}

export const TODO_PREDICTION_VERSION = "residual-beta-pert-execution-capacity-v3/session-hour-all-prior-q80-v1";

export interface TodoPlanForecast {
	capacityAssumptions?: { requested: number; effective: number; executableObserved?: boolean };
	unknownGates?: string[];
	provenance?: string;
	rawP50Finish?: number;
	rawP80Finish?: number;
	calibratedUpperFinish?: number;
	calibrationStatus?: "sufficient" | "insufficient";
	calibrationOrigins?: number;
	calibrationSessions?: number;
	calibrationCoverage?: { covered: number; total: number; sessions: number };
	predictionVersion?: string;
	membershipFingerprint?: string;
	risk?: RowRiskForecast;
	riskModelUnavailable?: boolean;
	calibration?: { ratio: number; samples: number };
	/** Conservative deadline forecast; analytical P95 fields retain their statistical meaning. */
	autoDeadlineForecast?: {
		finish?: number;
		winningBound: "raw-pert" | "empirical-upper" | "unknown";
		calibratedPertFinish?: number;
		throughputFinish?: number;
		rowsPerHour?: number;
		closureSamples: number;
		windowStartedAt?: number;
		openRows: number;
		rowFactors: {
			content: string;
			ageSeconds: number;
			reestimates: number;
			failedAttempts: number;
			remainingFloorSeconds: number;
			calibrationRatio: number;
			slipped: boolean;
			honestyDefects: string[];
		}[];
	};
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
	/** True only after the absolute deadline has passed; predicted expected lateness is `will-miss`. */
	deadlineMissed?: boolean;
	deadlineSlackSeconds?: number;
	issues: string[];
}

export interface TodoForecastOptions {
	history?: readonly TodoPlanPrediction[];
	/** Render-only fallback can show analytical metadata without fitting/sampling. */
	rawSimulation?: boolean;
	risk?: RowRiskOptions;
	now: number;
	deadlineAt?: number;
	/** Positive integer concurrency; 0 means Unlimited. Omitted/invalid input uses default 32; effective capacity is bounded by forecastable open tasks. */
	capacity?: number;
	/** Observed total executable worker slots, before subtracting active workers; 0 means none. */
	executableCapacity?: number;
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
	| "blocked-without-reason"
	| "owner-overlap";

const PLANNING_ACTION_LABELS: Record<TodoPlanningIssueCode, string> = {
	"owner-overlap": "schedule shared worker sequentially",
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

/** What the user must give, and the answer the chief would pick itself. */
export interface TodoUserWait {
	question: string;
	proposal?: string;
}

const USER_WAIT = /^\s*waits?\s+for\s+(?:the\s+)?user\s*:\s*([\s\S]*)$/iu;
const PROPOSAL_MARK = /(?:^|[\s;,.|])proposal\s*:\s*/iu;

/**
 * The one reading of a user-wait blocker: `waits for user: <question> proposal: <answer and why>`.
 * Only the user can unblock such a row (an approval, a choice, a file only the user has); every
 * other blocker is ordinary recovery work. Undefined for any other blocker. This is the only
 * parser of that form: extensions import it from this module instead of keeping their own copy.
 */
export function parseUserWait(blocker: string | undefined): TodoUserWait | undefined {
	if (typeof blocker !== "string") return undefined;
	const match = USER_WAIT.exec(blocker);
	if (!match) return undefined;
	const body = match[1]!;
	const mark = PROPOSAL_MARK.exec(body);
	const question = (mark ? body.slice(0, mark.index) : body).replace(/[\s;,.|]+$/u, "").trim();
	const proposal = mark ? body.slice(mark.index + mark[0].length).trim() : "";
	return proposal ? { question, proposal } : { question };
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
	speculativeDependencyCount: number;
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
	calibrationRatio?: number;
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
				status: isTodoAwaitingReview(task) && !todoRowAfterWorker(task) ? "completed" : task.status,
				schedule: task.schedule,
				estimate: task.schedule?.estimate,
				predecessors: [],
				successors: [],
				speculativeDependencyCount: 0,
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
		if (
			schedule.speculativeOn !== undefined &&
			(typeof schedule.speculativeOn !== "string" || !schedule.speculativeOn.trim())
		) {
			addIssue(
				node,
				{
					code: "invalid-schedule-metadata",
					task: node.content,
					message: `Speculative review reference must be non-empty text for task: ${node.content}`,
				},
				allIssues,
			);
		}
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
			if (node.schedule?.speculativeOn === dependency && predecessor.schedule?.review === "user") {
				node.speculativeDependencyCount += 1;
				continue;
			}
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
				node.predecessors.length + node.speculativeDependencyCount === node.schedule?.dependencies?.length &&
				node.predecessors.every(
					predecessor => predecessor.status === "completed" && finiteTimestamp(predecessor.schedule?.finishedAt),
				);
	}

	return { nodes, uniqueNodes, byContent, topological, issues: allIssues };
}

/** Validate exact task references for atomic schedule admission; all open tasks need explicit deps. */
export function validateTodoDependencies(phases: TodoScheduleInput): TodoDependencyIssue[] {
	// Speculation relaxes execution readiness, never graph integrity. Validate its
	// reference as an edge even when the referenced row awaits user review.
	return analyzeDependencies(
		phases.map(phase => ({
			...phase,
			tasks: phase.tasks.map(task => ({
				...task,
				schedule: task.schedule
					? {
							...task.schedule,
							speculativeOn: undefined,
							dependencies: task.schedule.speculativeOn
								? [...new Set([...(task.schedule.dependencies ?? []), task.schedule.speculativeOn])]
								: task.schedule.dependencies,
						}
					: undefined,
			})),
		})),
	).issues;
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
	const open = analysis.nodes.filter(node => !isClosed(node.status));
	const precedes = (first: PlanNode, second: PlanNode): boolean => {
		const seen = new Set<PlanNode>();
		const pending = [...second.predecessors];
		while (pending.length) {
			const node = pending.pop()!;
			if (node === first) return true;
			if (seen.has(node)) continue;
			seen.add(node);
			pending.push(...node.predecessors);
		}
		return false;
	};
	for (let i = 0; i < open.length; i++) {
		for (const other of open.slice(i + 1)) {
			const node = open[i]!;
			const owner = node.schedule?.owner;
			if (
				typeof owner !== "string" ||
				!owner ||
				["main", "root"].includes(owner.toLowerCase()) ||
				owner !== other.schedule?.owner ||
				precedes(node, other) ||
				precedes(other, node)
			)
				continue;
			issues.push({
				task: other.content,
				code: "owner-overlap",
				message: `Worker ${owner} owns two open rows without a sequential dependency: ${node.content}; ${other.content}. Exactly: todo ${JSON.stringify({ op: "schedule", updates: [{ task: other.content, dependencies: [...new Set([...(other.schedule?.dependencies ?? []), node.content])] }] })}`,
			});
		}
	}
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
			// Splitting is a decision before dispatch; a row already running under its owner cannot be cut.
			const running =
				task.status === "in_progress" && typeof task.schedule?.owner === "string" && task.schedule.owner !== "";
			if (
				!running &&
				estimate &&
				Number.isFinite(estimate.pessimisticSeconds) &&
				estimate.pessimisticSeconds > 3600
			) {
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

export function todoEstimateMeanSeconds(estimate: TodoEstimate): number {
	return (estimate.optimisticSeconds + 4 * estimate.likelySeconds + estimate.pessimisticSeconds) / 6;
}

function estimateDurations(estimate: TodoEstimate): DurationEstimates {
	const { optimisticSeconds: optimistic, pessimisticSeconds: pessimistic } = estimate;
	const spread = pessimistic - optimistic;
	return { optimistic, expected: todoEstimateMeanSeconds(estimate), pessimistic, spread };
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
		if (
			resources.length === 0 ||
			node.schedule?.readOnly ||
			(node.schedule?.ownerReadOnly?.owner === node.schedule?.owner && node.schedule?.ownerReadOnly?.readOnly) ||
			other.schedule?.readOnly ||
			(other.schedule?.ownerReadOnly?.owner === other.schedule?.owner && other.schedule?.ownerReadOnly?.readOnly)
		)
			continue;
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
	sampled?: { durations: Map<PlanNode, number>; now: number },
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
		let at = sampled ? Math.max(sampled.now, estimateAnchor(node)) : estimateAnchor(node);
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
			const anchor = sampled ? Math.max(sampled.now, estimateAnchor(node)) : estimateAnchor(node);
			const predecessorFinish = Math.max(0, ...node.predecessors.map(predecessor => finishes.get(predecessor) ?? 0));
			const baseRelease = Math.max(anchor, predecessorFinish);
			let controllers: PlanNode[] = [];
			if (node.predecessors.length > 0 && predecessorFinish >= anchor - CPM_TIE_TOLERANCE_MS) {
				controllers = node.predecessors.filter(
					predecessor => Math.abs((finishes.get(predecessor) ?? 0) - predecessorFinish) <= CPM_TIE_TOLERANCE_MS,
				);
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
				controllers =
					time > baseRelease + CPM_TIE_TOLERANCE_MS
						? resourceControllers
						: [...new Set([...controllers, ...resourceControllers])];
			}
			// Tied controllers finish together, so the row waits for all of them; the chain with the
			// larger P95 bounds its finish (2026-09-25: equal parallel shards made every later row
			// "tied or unavailable" and the whole plan (partial)).
			const parent = dominantController(controllers);
			let ambiguous = controllers.length > 0 ? parent === undefined : time > anchor + CPM_TIE_TOLERANCE_MS;
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
			const finish = time + (sampled?.durations.get(node) ?? durationMs(node, scenario));
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

/** Any tied controller will do; take the known chain with the largest P95. Undefined only when none is known. */
function dominantController(controllers: PlanNode[]): PlanNode | undefined {
	if (controllers.length <= 1) return controllers[0];
	let best: PlanNode | undefined;
	let bestP95 = Number.NEGATIVE_INFINITY;
	for (const candidate of controllers) {
		const expected = candidate.fixedPathExpectedSeconds;
		const variance = candidate.fixedPathVarianceSeconds;
		if (candidate.fixedPathAmbiguous || expected === undefined || variance === undefined) continue;
		const p95 = (candidate.fixedPathStart ?? 0) / 1_000 + expected + FIXED_PATH_P95_Z * Math.sqrt(variance);
		if (p95 > bestP95) {
			best = candidate;
			bestP95 = p95;
		}
	}
	return best;
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

/** Row focus/age is not execution. Only the current unsettled worker consumes a residual. */
function consumedExecutionMs(node: PlanNode, now: number): number {
	const executor = node.schedule?.executor;
	if (
		isClosed(node.status) ||
		node.status === "blocked" ||
		!executor?.workerId ||
		!finiteTimestamp(executor.startedAt) ||
		executor.finishedAt !== undefined ||
		executor.outcome !== undefined
	)
		return 0;
	return Math.max(0, now - Math.max(executor.startedAt, node.estimate!.updatedAt));
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

function componentData(validNodes: PlanNode[]): { nodes: PlanNode[]; complete: boolean }[] {
	const valid = new Set(validNodes);
	const visited = new Set<PlanNode>();
	const components: { nodes: PlanNode[]; complete: boolean }[] = [];
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
		components.push({ nodes: component, complete });
	}
	return components;
}

interface PlanCalibration {
	calibratedUpperFinish?: number;
	calibrationStatus: "sufficient" | "insufficient";
	calibrationOrigins: number;
	calibrationSessions: number;
	calibrationCoverage: { covered: number; total: number; sessions: number };
}

/** All-prior, as-of calibration; predictions from other base versions cannot supply residuals. */
export function calibrateTodoPlan(
	history: readonly TodoPlanPrediction[],
	now: number,
	point?: number,
): PlanCalibration {
	const hourly = new Map<string, TodoPlanPrediction>();
	for (const record of [...history]
		.filter(r => r.predictionVersion === TODO_PREDICTION_VERSION && r.originAt < now)
		.sort((a, b) => a.originAt - b.originAt)) {
		const key = `${record.sessionId}:${Math.floor(record.originAt / 3_600_000)}`;
		if (!hourly.has(key)) hourly.set(key, record);
	}
	const settled = [...hourly.values()].filter(
		r =>
			finiteTimestamp(r.actualFinish) &&
			finiteTimestamp(r.observedAt) &&
			r.observedAt! < now &&
			r.actualFinish! >= r.originAt &&
			r.actualFinish! < now &&
			finiteTimestamp(r.rawP50Finish),
	);
	const counts = new Map<string, number>();
	for (const r of settled) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1);
	const scored = settled.filter(r => finiteTimestamp(r.upperFinish));
	const result: PlanCalibration = {
		calibrationStatus: settled.length >= 20 && counts.size >= 5 ? "sufficient" : "insufficient",
		calibrationOrigins: settled.length,
		calibrationSessions: counts.size,
		calibrationCoverage: {
			covered: scored.filter(r => r.actualFinish! <= r.upperFinish!).length,
			total: scored.length,
			sessions: new Set(scored.map(r => r.sessionId)).size,
		},
	};
	if (point === undefined || result.calibrationStatus === "insufficient") return result;
	const errors = settled
		.map(r => ({ error: r.actualFinish! - r.rawP50Finish, weight: 1 / counts.get(r.sessionId)! }))
		.sort((a, b) => a.error - b.error);
	const threshold = errors.reduce((sum, r) => sum + r.weight, 0) * 0.8;
	let cumulative = 0;
	for (const r of errors) {
		cumulative += r.weight;
		if (cumulative + 1e-12 >= threshold) {
			result.calibratedUpperFinish = Math.max(point, point + r.error);
			break;
		}
	}
	return result;
}

const rawPertCache = new Map<string, { p50: number; p80: number }>();
/** Beta-PERT lambda=4, sampled through the same dependency/resource scheduler. */
function simulateRawPert(
	nodes: PlanNode[],
	capacity: number,
	priority: Map<PlanNode, number>,
	now: number,
): { p50: number; p80: number } {
	const key = JSON.stringify([
		nodes.map(n => [
			n.content,
			n.status,
			n.estimate,
			n.schedule?.dependencies,
			n.schedule?.owner,
			n.schedule?.resources,
			n.schedule?.startedAt,
			n.schedule?.finishedAt,
			n.schedule?.estimateRevision,
			n.schedule?.executor,
		]),
		capacity,
		now,
	]);
	const cached = rawPertCache.get(key);
	if (cached) return cached;
	const random = riskRandom(19731);
	const gamma = (shape: number): number => {
		const d = shape - 1 / 3;
		const c = 1 / Math.sqrt(9 * d);
		for (;;) {
			const x = Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, random()))) * Math.cos(2 * Math.PI * random());
			const v = (1 + c * x) ** 3;
			if (v <= 0) continue;
			const u = random();
			if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < (x * x) / 2 + d * (1 - v + Math.log(v))) return d * v;
		}
	};
	const open = nodes.filter(n => !isClosed(n.status));
	const finishes: number[] = [];
	for (let sample = 0; sample < 256; sample++) {
		const durations = new Map<PlanNode, number>();
		for (const n of open) {
			const e = n.estimate!;
			const width = e.pessimisticSeconds - e.optimisticSeconds;
			let seconds = e.likelySeconds;
			if (width > 0) {
				const a = gamma(1 + (4 * (e.likelySeconds - e.optimisticSeconds)) / width);
				const b = gamma(1 + (4 * (e.pessimisticSeconds - e.likelySeconds)) / width);
				seconds = e.optimisticSeconds + (width * a) / (a + b);
			}
			// A revised estimate already describes the residual at updatedAt.
			const elapsed = consumedExecutionMs(n, now);
			durations.set(n, Math.max(0, seconds * 1000 - elapsed));
		}
		const scheduled = scheduleResources(nodes, capacity, "pessimistic", priority, { durations, now });
		finishes.push(Math.max(now, ...open.map(n => scheduled.finishes.get(n) ?? Number.POSITIVE_INFINITY)));
	}
	finishes.sort((a, b) => a - b);
	const result = { p50: finishes[127]!, p80: finishes[204]! };
	if (rawPertCache.size >= 8) rawPertCache.delete(rawPertCache.keys().next().value!);
	rawPertCache.set(key, result);
	return result;
}

/** Sole resource/dependency scheduler and whole-plan residual calibration owner. */
export function forecastTodoPlan(phases: TodoScheduleInput, options: TodoForecastOptions): TodoPlanForecast {
	const now = options.now;
	const deferred = phases.flatMap(phase => phase.tasks).filter(row => row.schedule?.postDeadline);
	const scoped = phases.map(phase => ({ ...phase, tasks: phase.tasks.filter(row => !row.schedule?.postDeadline) }));
	const analysis = analyzeDependencies(scoped);
	const rowFactors: NonNullable<TodoPlanForecast["autoDeadlineForecast"]>["rowFactors"] = [];
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
	const exhaustedResidualNodes = validNodes.filter(
		node =>
			!isClosed(node.status) &&
			consumedExecutionMs(node, now) > 0 &&
			consumedExecutionMs(node, now) >= node.estimate!.pessimisticSeconds * 1000,
	);
	for (const node of exhaustedResidualNodes)
		issues.push(`Residual estimate exhausted for task: ${node.content}; revise remaining work`);
	const forecastableCount = validNodes.filter(node => !isClosed(node.status)).length;
	const executableInput = options.executableCapacity;
	const executableCapacity =
		typeof executableInput === "number" && Number.isSafeInteger(executableInput) && executableInput >= 0
			? executableInput
			: undefined;
	if (executableInput !== undefined && executableCapacity === undefined)
		issues.push("Invalid executable worker capacity; live capacity is unknown");
	const noExecutableCapacity = executableCapacity === 0 && analysis.nodes.some(node => !isClosed(node.status));
	const capacity = Math.min(
		requestedCapacity === 0 ? forecastableCount : requestedCapacity,
		executableCapacity ?? forecastableCount,
		forecastableCount,
	);
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

	// Virtual "everything done" milestone: every valid sink's natural late finish is the latest
	// earliest finish over all forecastable rows. Unrelated blocked/invalid rows must not push
	// disconnected components back onto their own finish (which would zero their natural float);
	// components feeding unresolved work stay criticality-unknown via `component.complete`.
	const projectMilestone = knownProjectFinish ?? 0;
	const components = componentData(validNodes);
	const componentFor = new Map<PlanNode, (typeof components)[number]>();
	for (const component of components) for (const node of component.nodes) componentFor.set(node, component);
	for (let index = validTopological.length - 1; index >= 0; index--) {
		const node = validTopological[index];
		const component = componentFor.get(node)!;
		if (!component.complete) continue;
		const successors = node.successors.filter(successor => validSet.has(successor));
		const naturalLateFinish = successors.length
			? Math.min(...successors.map(successor => successor.naturalLatestStart!))
			: projectMilestone;
		const deadlineLateFinish = successors.length
			? Math.min(...successors.map(successor => successor.latestStart!))
			: (deadlineAt ?? projectMilestone);
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
			node.freeFloatSeconds = (projectMilestone - node.earliestFinish!) / 1000;
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
	const globalForecastKnown = !noExecutableCapacity && unresolvedCount === 0 && allResourceScenariosComplete;
	const earliestFinish = !noExecutableCapacity && !hasUnresolvedOpen ? knownProjectFinish : undefined;
	const resourceFinish = globalForecastKnown ? knownResourceFinish : undefined;
	const fixedPathP95Finish = globalForecastKnown ? knownFixedPathFinish : undefined;
	const expectedResourceFinish =
		!noExecutableCapacity && !hasUnresolvedOpen && allResourceScenariosComplete ? knownExpectedFinish : undefined;
	const knownWorkFinish = !noExecutableCapacity && unresolvedCount > 0 ? knownResourceFinish : undefined;
	const range = globalForecastKnown
		? timestampRange([knownOptimisticFinish, knownExpectedFinish, knownPessimisticFinish])
		: undefined;

	const resourceAssumptions: string[] = [];
	if (openNodes.length > 0) {
		if (noExecutableCapacity)
			resourceAssumptions.push(
				"Executable worker capacity is zero; completion ETA is unknown until capacity is available",
			);
		else if (executableCapacity === undefined)
			resourceAssumptions.push(
				"Executable worker capacity is unobserved; forecast is conditional on configured Task capacity being available",
			);
		else resourceAssumptions.push(`Observed executable worker capacity ${executableCapacity}`);
	}
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
	if (
		noExecutableCapacity ||
		exhaustedResidualNodes.length > 0 ||
		unresolvedCount > 0 ||
		!allResourceScenariosComplete
	)
		confidence = "unknown";
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
		const waitsForUser = node.status === "blocked" ? parseUserWait(node.blocker) : undefined;
		return {
			blocker: node.blocker,
			...(waitsForUser ? { waitsForUser } : {}),
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
			schedule: node.schedule,
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
			overdue:
				node.schedule?.review !== "accepted" &&
				!terminal &&
				resourceTaskFinish !== undefined &&
				now > resourceTaskFinish,
			estimateRevision: node.schedule?.estimateRevision ?? (node.estimate ? 1 : 0),
			reestimateCount: node.schedule?.reestimateCount ?? 0,
			confidence: rowConfidence,
			resourceConfidence: rowResourceConfidence,
			issues: [...new Set(rowIssues)],
			estimateUpdatedAt: node.estimate?.updatedAt,
			progressAt: node.schedule?.progress?.at,
			startedAt: node.schedule?.startedAt,
			finishedAt: node.schedule?.finishedAt,
			attemptDurationMs: recordedTodoExecution(node, now).attemptMs,
		};
	});

	for (const row of deferred)
		rows.push({
			...row,
			critical: false,
			ready: false,
			estimateRequired: false,
			stale: false,
			overdue: false,
			estimateRevision: row.schedule?.estimateRevision ?? 0,
			reestimateCount: row.schedule?.reestimateCount ?? 0,
			confidence: "unknown",
			issues: [],
		});
	for (const row of rows) for (const issue of row.issues) issues.push(issue);
	for (const issue of analysis.issues) {
		if (issue.code === "duplicate-task" && !issues.includes(issue.message)) issues.push(issue.message);
	}
	// Inter-completion throughput includes silence since the last closure. A first closure
	// establishes the clock; it is not counted as work produced in that interval.
	const closures = [...new Map(phases.flatMap(phase => phase.tasks).map(row => [row.content, row])).values()]
		.filter(row => row.status === "completed")
		.map(row => row.schedule?.finishedAt)
		.filter((at): at is number => finiteTimestamp(at) && at! <= now && at! >= now - 24 * 3_600_000)
		.sort((a, b) => a - b);
	const windowStartedAt = closures[0];
	const hours = windowStartedAt === undefined ? 0 : (now - windowStartedAt) / 3_600_000;
	const rowsPerHour = closures.length >= 3 && hours >= 1 ? (closures.length - 1) / hours : undefined;
	const measuredThroughputFinish =
		rowsPerHour && openNodes.length ? now + (openNodes.length / rowsPerHour) * 3_600_000 : undefined;
	const raw =
		options.rawSimulation !== false && globalForecastKnown && exhaustedResidualNodes.length === 0
			? simulateRawPert(validNodes, schedulerCapacity, taskPriority(validTopological), now)
			: undefined;
	const empirical = calibrateTodoPlan(options.history ?? [], now, raw?.p50);
	const finish = empirical.calibratedUpperFinish ?? raw?.p80;
	if (deadlineAt !== undefined) {
		deadlineMissed = deadlineAt < now;
		if (deadlineMissed) deadlineStatus = "overdue";
		else if (noExecutableCapacity || exhaustedResidualNodes.length > 0) deadlineStatus = "unknown";
		else if (raw && finish !== undefined) {
			deadlineSlackSeconds = (deadlineAt - finish) / 1000;
			deadlineStatus = raw.p50 > deadlineAt ? "will-miss" : finish > deadlineAt ? "at-risk" : "on-track";
		} else if (unresolvedCount > 0 || !allResourceScenariosComplete) {
			// A known partial bound may prove lateness, never whole-plan completion.
			deadlineStatus =
				knownExpectedFinish !== undefined && knownExpectedFinish > deadlineAt
					? "will-miss"
					: knownWorkFinish !== undefined && knownWorkFinish > deadlineAt
						? "at-risk"
						: "unknown";
		} else deadlineStatus = "unknown";
		if (deadlineStatus === "overdue") issues.push("Deadline is overdue as of forecast time");
		else if (deadlineStatus === "will-miss") issues.push("Expected work misses the deadline");
		else if (deadlineStatus === "at-risk") issues.push("Forecast risks missing the deadline");
	}
	const autoDeadlineForecast: NonNullable<TodoPlanForecast["autoDeadlineForecast"]> = {
		finish,
		calibratedPertFinish: raw?.p80,
		throughputFinish: measuredThroughputFinish,
		rowsPerHour,
		closureSamples: closures.length,
		windowStartedAt,
		openRows: openNodes.length,
		rowFactors,
		winningBound:
			finish === undefined
				? "unknown"
				: empirical.calibrationStatus === "sufficient"
					? "empirical-upper"
					: "raw-pert",
	};
	const plan: TodoPlanForecast = {
		autoDeadlineForecast,
		...empirical,
		capacityAssumptions: {
			requested: requestedCapacity,
			effective: capacity,
			executableObserved: executableCapacity !== undefined,
		},
		unknownGates: [
			...(noExecutableCapacity ? ["Executable worker capacity is zero"] : []),
			...exhaustedResidualNodes.map(
				node => `Residual estimate exhausted for task: ${node.content}; revise remaining work`,
			),
			...analysis.nodes
				.filter(node => node.invalid || node.status === "blocked")
				.map(node => node.blocker ?? node.content),
		],
		provenance:
			"declared residuals; 256 beta-PERT draws; recorded TODO closure target; all-prior session-balanced residuals",
		predictionVersion: TODO_PREDICTION_VERSION,
		membershipFingerprint: JSON.stringify(
			scoped
				.flatMap(phase => phase.tasks.filter(row => !isClosed(row.status)).map(row => [phase.name, row.content]))
				.sort(),
		),
		rawP50Finish: raw?.p50,
		rawP80Finish: raw?.p80,
		calibration: { ratio: 1, samples: empirical.calibrationOrigins },
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
	if (options.risk && !hasUnresolvedOpen && !noExecutableCapacity && exhaustedResidualNodes.length === 0)
		plan.risk = simulateRowRisk(validNodes, schedulerCapacity, taskPriority(validTopological), options, 1);
	else if (!options.risk) plan.riskModelUnavailable = true;
	return plan;
}

const riskCache = new Map<string, RowRiskForecast>();
function simulateRowRisk(
	nodes: PlanNode[],
	capacity: number,
	priority: Map<PlanNode, number>,
	options: TodoForecastOptions,
	calibrationRatio: number,
): RowRiskForecast {
	const risk = options.risk!;
	const key = JSON.stringify([
		calibrationRatio,
		nodes.map(node => [node.content, node.status, node.schedule, node.calibrationRatio]),
		capacity,
		risk,
		// The HUD displays minute precision; keypress renders must reuse this simulation.
		Math.floor(options.now / 60_000),
		options.deadlineAt,
	]);
	const cached = riskCache.get(key);
	if (cached) return cached;
	const open = nodes.filter(node => !isClosed(node.status));
	const random = riskRandom(risk.seed ?? 157);
	const samples = Math.max(1, Math.min(2000, Math.floor(Number.isFinite(risk.samples) ? risk.samples! : 2000)));
	const finishes: number[] = [];
	const lastCounts = new Map<PlanNode, number>();
	const workerType = (node: PlanNode) =>
		node.schedule?.agentProfile ?? node.schedule?.executor?.agentProfile ?? risk.defaultWorkerType ?? "task";
	for (let sample = 0; sample < samples; sample++) {
		const durations = new Map<PlanNode, number>();
		for (const node of open) {
			const elapsed = consumedExecutionMs(node, options.now) / 1000;
			durations.set(
				node,
				drawAttemptChain(
					risk,
					workerType(node),
					node.schedule?.firstEstimate
						? todoEstimateMeanSeconds(node.estimate!) * (node.calibrationRatio ?? 1)
						: (node.schedule?.riskEstimateMeanSeconds ?? nodeDurations(node).expected),
					todoWorkAttempts(node.schedule?.attemptHistory).length + 1,
					elapsed,
					random,
				) * 1000,
			);
		}
		const scheduled = scheduleResources(nodes, capacity, "pessimistic", priority, { durations, now: options.now });
		const finish = Math.max(
			options.now,
			...open.map(node => scheduled.finishes.get(node) ?? Number.POSITIVE_INFINITY),
		);
		finishes.push(finish);
		const last = open.filter(node => scheduled.finishes.get(node) === finish);
		for (const node of last) lastCounts.set(node, (lastCounts.get(node) ?? 0) + 1 / last.length);
	}
	finishes.sort((a, b) => a - b);
	const percentile = (p: number) => finishes[Math.ceil(samples * p) - 1];
	const result: RowRiskForecast = {
		p50Finish: percentile(0.5),
		p80Finish: percentile(0.8),
		p90Finish: percentile(0.9),
		samples,
		onTimeProbability:
			options.deadlineAt === undefined
				? undefined
				: finishes.filter(finish => finish <= options.deadlineAt!).length / samples,
		criticalRows: open
			.map(node => {
				const cells = riskCells(risk, workerType(node));
				const weight = cells.reduce((sum, cell) => sum + cell.weight, 0);
				return {
					content: node.content,
					workerType: workerType(node),
					redoRisk:
						cells.reduce(
							(sum, cell) =>
								sum +
								cell.weight *
									cell.component.p_redo[Math.min(todoWorkAttempts(node.schedule?.attemptHistory).length, 2)],
							0,
						) / weight,
					lastFinishProbability: (lastCounts.get(node) ?? 0) / samples,
				};
			})
			.sort((a, b) => b.lastFinishProbability - a.lastFinishProbability),
	};
	if (riskCache.size >= 8) riskCache.delete(riskCache.keys().next().value!);
	riskCache.set(key, result);
	return result;
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

/** A row only the user can unblock: what it waits for and the chief's own answer. */
function formatUserWait(wait: TodoUserWait, text: (value: string) => string): string {
	return `waits for you: ${text(wait.question)} · ${wait.proposal ? `proposal: ${text(wait.proposal)}` : "no proposal yet"}`;
}

/** Recorded execution is shared by forecast metadata and each row renderer. */
function recordedTodoExecution(
	task: { status: TodoScheduleStatus; schedule?: TodoSchedule },
	now: number,
): { attemptMs?: number; activeMs?: number } {
	const schedule = task.schedule;
	const end = isClosed(task.status) ? schedule?.finishedAt : now;
	const history = [
		...new Map((schedule?.attemptHistory ?? []).map(attempt => [attempt.attemptId, attempt])).values(),
	].filter(
		attempt =>
			Number.isFinite(attempt.durationMs) &&
			attempt.durationMs >= 0 &&
			finiteTimestamp(attempt.startedAt) &&
			finiteTimestamp(attempt.finishedAt) &&
			attempt.finishedAt >= attempt.startedAt &&
			attempt.finishedAt <= (end ?? now),
	);
	const attemptMs = history.length ? history.reduce((total, attempt) => total + attempt.durationMs, 0) : undefined;
	let activeMs = attemptMs;
	const executor = schedule?.executor;
	if (
		executor &&
		finiteTimestamp(executor.startedAt) &&
		!history.some(attempt => attempt.workerName === executor.workerId && attempt.startedAt === executor.startedAt)
	) {
		const executionEnd = finiteTimestamp(executor.finishedAt)
			? executor.finishedAt
			: !executor.outcome
				? end
				: undefined;
		if (finiteTimestamp(executionEnd) && executionEnd >= executor.startedAt && executionEnd <= (end ?? now))
			activeMs = (activeMs ?? 0) + executionEnd - executor.startedAt;
	}
	return { attemptMs, activeMs };
}

/** First-start age includes unknown gaps; it cannot stand in for recorded worker execution. */
function formatTodoRowClocks(task: { status: TodoScheduleStatus; schedule?: TodoSchedule }, now: number): string[] {
	const schedule = task.schedule;
	const terminal = isClosed(task.status);
	const end = terminal ? schedule?.finishedAt : now;
	const starts = [
		schedule?.startedAt,
		schedule?.executor?.startedAt,
		...(schedule?.attemptHistory ?? []).map(attempt => attempt.startedAt),
	].filter((value): value is number => finiteTimestamp(value));
	const firstStart = starts.length ? Math.min(...starts) : undefined;
	const ageMs =
		finiteTimestamp(firstStart) && finiteTimestamp(end) && end >= firstStart ? end - firstStart : undefined;
	const queueAgeMs =
		ageMs === undefined && !terminal && finiteTimestamp(schedule?.firstRequirementAt)
			? Math.max(0, now - schedule.firstRequirementAt)
			: undefined;
	const parts: string[] = [];
	if (ageMs !== undefined) parts.push(`age ${Math.round(ageMs / 60_000)}m`);
	else if (queueAgeMs !== undefined) parts.push(`queued age ${Math.round(queueAgeMs / 60_000)}m`);
	const { activeMs } = recordedTodoExecution(task, now);
	parts.push(activeMs === undefined ? "active unknown" : `recorded active ${Math.round(activeMs / 60_000)}m`);
	// The journal has no completeness marker: age minus recorded work is not proven downtime.
	if (ageMs !== undefined || queueAgeMs !== undefined) parts.push("queue/downtime unknown");
	if (!terminal && isValidEstimate(schedule?.estimate))
		parts.push(
			`remaining estimate ${Math.ceil(schedule.estimate.likelySeconds / 60)}m at ${displayTimestamp(schedule.estimate.updatedAt, now)}`,
		);
	return parts;
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
			? row.waitsForUser
				? formatUserWait(row.waitsForUser, safeText)
				: `needs unblock${row.blocker ? `: ${safeText(row.blocker)}` : ""} · ${effort}`
			: row.awaitingPrerequisite
				? `awaits prerequisite: ${safeText(row.awaitingPrerequisite)} · ${effort}`
				: row.resourceFinish !== undefined
					? `ETA fixed-path P95: ${formatTimestamp(row.resourceFinish)}`
					: planActions
						? `plan required: ${planActions}`
						: `forecast unavailable${row.issues[0] ? `: ${safeText(row.issues[0])}` : ""}`;
	const parts = [label, ...formatTodoRowClocks(row, now)];
	if (row.schedule?.previewTracked && finiteTimestamp(row.schedule.firstRequirementAt)) {
		const end = row.schedule.visibleAt ?? now;
		parts.push(
			row.schedule.previewIdentityMissing
				? "asked→visible: no commit"
				: `asked→visible ${Math.floor(Math.max(0, end - row.schedule.firstRequirementAt) / 60_000)}m${row.schedule.visibleAt === undefined ? " (live)" : ""}`,
		);
		if (row.schedule.previewPending && !row.schedule.previewIdentityMissing)
			parts.push(
				row.schedule.previewPartial
					? "partially visible"
					: row.schedule.previewIdentityMissing
						? "no commit identity"
						: "commit not visible",
			);
	}
	if (row.schedule?.deliveryCritic)
		parts.push(
			`shadow: ${row.schedule.deliveryCritic.verdict}${row.schedule.deliveryCritic.timedOut ? " (handoff released)" : ""}`,
		);
	if (row.schedule?.review === "user") parts.push("review: user");
	if (row.schedule?.speculativeOn) parts.push(`speculative on ${safeText(row.schedule.speculativeOn)}`);
	if (row.onProposal?.length) parts.push(`on proposal: ${row.onProposal.map(safeText).join(", ")}`);
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

function formatUnknownGates(gates: string[]): string {
	const shown = gates.slice(0, 3).map(gate => truncateToWidth(safeText(gate), 120));
	if (gates.length > shown.length) shown.push(`+${gates.length - shown.length} unknown gates (see todo.view)`);
	return shown.join("; ");
}

/** Bounded plan summary; consumers needing task details use `plan.rows` and `plan.issues`. */
export function formatPlanForecast(plan: TodoPlanForecast, _now: number): string {
	const parts: string[] = [];
	const measured = plan.autoDeadlineForecast;
	if (plan.rawP50Finish === undefined) parts.push("Current ETA unknown");
	if (plan.unknownGates?.length) parts.push(formatUnknownGates(plan.unknownGates));
	if (plan.capacityAssumptions?.executableObserved === false) parts.push("Conditional on worker capacity");
	if (plan.rawP50Finish !== undefined)
		parts.push(`Current set: point ${displayTimestamp(plan.rawP50Finish, plan.now)}`);
	if (plan.calibratedUpperFinish !== undefined)
		parts.push(
			`empirical upper ${displayTimestamp(plan.calibratedUpperFinish, plan.now)} (experimental; observed coverage ${plan.calibrationCoverage?.covered ?? 0}/${plan.calibrationCoverage?.total ?? 0}, ${plan.calibrationSessions} sessions)`,
		);
	else if (plan.rawP80Finish !== undefined)
		parts.push(
			`raw model P80 ${displayTimestamp(plan.rawP80Finish, plan.now)}; calibration insufficient (${plan.calibrationOrigins ?? 0} origins, ${plan.calibrationSessions ?? 0} sessions)`,
		);
	if (measured?.rowsPerHour !== undefined)
		parts.push(
			`Throughput diagnostic: ${measured.rowsPerHour.toFixed(2)} rows/h (${measured.closureSamples} closures)`,
		);
	const awaiting = plan.rows.filter(isTodoAwaitingReview).length;
	if (awaiting) parts.push(`${awaiting} awaiting your review`);
	if (plan.risk) parts.push(`Worker-attempt diagnostic ${displayTimestamp(plan.risk.p80Finish, plan.now)}`);

	if (plan.unresolvedCount > 0) {
		if (plan.knownWorkFinish !== undefined)
			parts.push(`Known work fixed-path P95 (partial): ${formatTimestamp(plan.knownWorkFinish)}`);
		parts.push(`unresolved: ${plan.unresolvedCount}`);
	} else if (plan.resourceFinish !== undefined)
		parts.push(`Historical fixed-path P95 (normal approximation): ${formatTimestamp(plan.resourceFinish)}`);
	else parts.push("resource ETA unavailable");
	if (plan.expectedResourceFinish !== undefined)
		parts.push(`historical expected resource finish: ${formatTimestamp(plan.expectedResourceFinish)}`);
	if (plan.deadlineAt !== undefined) parts.push(`due: ${formatTimestamp(plan.deadlineAt)}`);
	if (plan.range)
		parts.push(`scenario envelope: ${formatTimestamp(plan.range.earliest)}..${formatTimestamp(plan.range.latest)}`);
	if (plan.deadlineStatus) parts.push(`deadline: ${plan.deadlineStatus}`);
	if (plan.deadlineSlackSeconds !== undefined) parts.push(`slack: ${formatSeconds(plan.deadlineSlackSeconds)}`);
	if (plan.issues.length) parts.push(`issues: ${plan.issues.length}`);
	if (plan.planningIssues.length) parts.push(`plan required: ${plan.planningIssues.length} repairs`);
	if (plan.resourceAssumptions?.length) parts.push(`resource assumptions: ${plan.resourceAssumptions.length}`);
	if (plan.riskModelUnavailable) parts.push("risk model unavailable");
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
	const critic = row.schedule?.deliveryCritic;
	const criticLabel = critic ? `shadow: ${critic.verdict}${critic.timedOut ? " (handoff released)" : ""}` : "";
	if (critic?.verdict === "pending" && !critic.timedOut) return criticLabel;
	if (isTodoAwaitingReview(row))
		return row.schedule?.reviewPage && !row.schedule.reviewPagePending
			? `awaiting your review → ${safeText(row.schedule.reviewPage)}${criticLabel ? ` · ${criticLabel}` : ""}`
			: `handoff pending → skill://review-questions-page${row.schedule?.resources?.[0] ? ` · ${safeText(row.schedule.resources[0])}` : ""}${criticLabel ? ` · ${criticLabel}` : ""}`;
	if (row.schedule?.review === "accepted" && row.status !== "completed" && row.status !== "abandoned")
		return `accepted by user, closing${row.schedule.reviewClosingBlocked ? ` blocked: ${safeText(row.schedule.reviewClosingBlocked)}` : ""}`;
	const terminal = row.status === "completed" || row.status === "abandoned";
	const effort = row.estimateRangeSeconds
		? `effort O/L/P ${Math.round(row.estimateRangeSeconds.optimistic)}/${Math.round(row.estimateRangeSeconds.likely)}/${Math.round(row.estimateRangeSeconds.pessimistic)}s`
		: "effort estimate required";
	const planActions = row.planningIssues?.map(issue => PLANNING_ACTION_LABELS[issue.code]).join(", ");
	const label = terminal
		? formatCompletion(row, now, true, expanded)
		: row.status === "blocked"
			? row.waitsForUser
				? formatUserWait(row.waitsForUser, text =>
						expanded ? safeText(text) : truncateToWidth(safeText(text), 32),
					)
				: `needs unblock${row.blocker ? `: ${expanded ? safeText(row.blocker) : truncateToWidth(safeText(row.blocker), 32)}` : ""} · ${effort}`
			: row.awaitingPrerequisite
				? `awaits prerequisite: ${expanded ? safeText(row.awaitingPrerequisite) : truncateToWidth(safeText(row.awaitingPrerequisite), 32)} · ${effort}`
				: row.resourceFinish !== undefined
					? `by ${displayTimestamp(row.resourceFinish, now)}`
					: planActions
						? `plan required: ${planActions}`
						: `forecast unavailable${row.issues[0] ? `: ${safeText(row.issues[0])}` : ""}`;
	const parts = [label, ...(criticLabel ? [criticLabel] : [])];
	if (row.schedule?.previewTracked && finiteTimestamp(row.schedule.firstRequirementAt)) {
		const end = row.schedule.visibleAt ?? now;
		parts.push(
			row.schedule.previewIdentityMissing
				? "asked→visible: no commit"
				: `asked→visible ${Math.floor(Math.max(0, end - row.schedule.firstRequirementAt) / 60_000)}m${row.schedule.visibleAt === undefined ? " (live)" : ""}`,
		);
		if (row.schedule.previewPending && !row.schedule.previewIdentityMissing)
			parts.push(
				row.schedule.previewPartial
					? "partially visible"
					: row.schedule.previewIdentityMissing
						? "no commit identity"
						: "commit not visible",
			);
	}
	if (row.schedule?.review === "user") parts.push("review: user");
	if (row.schedule?.speculativeOn)
		parts.push(`speculative on ${truncateToWidth(safeText(row.schedule.speculativeOn), 32)}`);
	parts.push(...formatTodoRowClocks(row, now));
	const cumulativeReestimates = row.schedule?.cumulativeReestimateCount ?? row.reestimateCount;
	if (row.onProposal?.length) parts.push("on proposal");
	if (row.criticalityKnown === true && row.critical) parts.push("critical");
	if (cumulativeReestimates >= 3) {
		parts.push(`reestimated ${cumulativeReestimates}×`);
		if (row.schedule?.firstEstimate) parts.push(`first ${Math.ceil(row.schedule.firstEstimate.likelySeconds / 60)}m`);
	}
	if (expanded) {
		if (row.owner && !["main", "root"].includes(row.owner.toLowerCase())) parts.push(`owner ${safeText(row.owner)}`);
		if (row.planningIssues?.length)
			parts.push(`plan required: ${row.planningIssues.map(issue => safeText(issue.message)).join("; ")}`);
		else if (row.issues.length) parts.push(row.issues.map(safeText).join("; "));
	}
	return parts.join(" · ");
}

export function formatPlanForecastDisplay(plan: TodoPlanForecast, now: number, compact = false): string {
	const parts: string[] = [];
	const finish = plan.autoDeadlineForecast?.finish;
	parts.push(finish === undefined ? "Current ETA unknown" : `ETA ${displayTimestamp(finish, now)}`);
	if (plan.deadlineAt !== undefined) {
		parts.push(`due ${displayTimestamp(plan.deadlineAt, now)}`);
		if (plan.deadlineAt < now)
			parts.push(
				`overdue ${Math.floor((now - plan.deadlineAt) / 3_600_000)}h${Math.floor(((now - plan.deadlineAt) % 3_600_000) / 60_000)}m`,
			);
		else if (plan.deadlineStatus === "will-miss" && plan.rawP50Finish !== undefined)
			parts.push(
				`MISSES ${displayTimestamp(plan.deadlineAt, now)} by ${Math.ceil((plan.rawP50Finish - plan.deadlineAt) / 60_000)}m`,
			);
		else if (plan.deadlineStatus) parts.push(plan.deadlineStatus);
	}
	if (plan.capacityAssumptions?.executableObserved === false) parts.push("conditional on worker capacity");
	const awaiting = plan.rows.filter(isTodoAwaitingReview).length;
	if (awaiting) parts.push(`${awaiting} awaiting your review`);
	if (plan.risk && !compact)
		parts.push(`Worker-attempt diagnostic ${displayTimestamp(plan.risk.p80Finish, plan.now)}`);
	if (plan.unresolvedCount > 0) {
		if (plan.knownWorkFinish !== undefined && !compact)
			parts.push(`Known work by ${displayTimestamp(plan.knownWorkFinish, now)} (partial)`);
		parts.push(`${plan.unresolvedCount} unresolved`);
	}
	if (plan.unknownGates?.length && !compact) parts.push(formatUnknownGates(plan.unknownGates));

	if (plan.planningIssues.length) parts.push(`plan required: ${plan.planningIssues.length} repairs`);
	const overdue = plan.rows.filter(row => row.overdue).length;
	if (overdue) parts.push(`${overdue} overdue`);
	if (plan.riskModelUnavailable && !compact) parts.push("risk model unavailable");
	return parts.join(" · ");
}

/** Read-only profiles whose run verifies a delivery rather than producing one. */
export const TODO_AUDIT_PROFILES: readonly string[] = ["qa-auditor", "reviewer", "gate-runner"];
/** The only profile whose row-audit verdicts count; records from any other runner are void. */
export const TODO_ROW_AUDITOR = "qa-auditor";
/** Investigation profiles: their run answers a question; the change it calls for is a next worker's. */
export const TODO_FINDINGS_PROFILES: readonly string[] = [
	"researcher",
	"profiler",
	"scout",
	"architect",
	"business-analyst",
];

/** Identity of one executor run; audits and critic verdicts are bound to it. */
export function todoRowDeliveryKey(schedule: TodoSchedule | undefined): string {
	const executor = schedule?.executor;
	return JSON.stringify([executor?.workerId, executor?.startedAt, executor?.finishedAt]);
}

// A commit id: 7-40 hex characters with at least one digit and one letter, so plain numbers and
// hex-looking words are not commits.
const COMMIT_ID = /(?<![0-9A-Za-z])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9A-Za-z])/;

/** Return a unique exact git binding, if the row declares one. */
export function todoArtifactGitBinding(task: {
	schedule?: TodoSchedule;
}): { repoPath: string; head: string } | undefined {
	const bindings = new Map<string, { repoPath: string; head: string }>();
	for (const resource of task.schedule?.resources ?? []) {
		const match = /^git:(.+)@([0-9a-f]{40})$/.exec(resource);
		if (match) bindings.set(resource, { repoPath: match[1]!, head: match[2]! });
	}
	return bindings.size === 1 ? [...bindings.values()][0] : undefined;
}

/** Stable resource identity for binding audit verdicts across schedule edits. */
export function todoAuditResourcesKey(schedule: TodoSchedule | undefined): string {
	return JSON.stringify([...(schedule?.resources ?? [])].sort());
}

/** A verdict applies only to the resource set and explicit git revision it audited. */
export function todoAuditMatchesResources(schedule: TodoSchedule | undefined, audit: TodoRowAudit): boolean {
	if (audit.resourcesKey !== undefined && audit.resourcesKey !== todoAuditResourcesKey(schedule)) return false;
	const binding = todoArtifactGitBinding({ schedule });
	return (
		!binding ||
		(binding.repoPath === audit.repoPath && audit.head === binding.head) ||
		(audit.bindingMismatch === true && audit.resourcesKey !== undefined && audit.verdict === "inconclusive")
	);
}

/** One canonical retry identity for both lifecycle and audit planner. Legacy prose grants no retry. */
export function todoMaterialInputsKey(inputs: TodoMaterialInputs | undefined): string {
	return JSON.stringify(
		inputs
			? [inputs.criterion, [...new Set(inputs.receipts)].sort(), [...new Set(inputs.prerequisites)].sort()]
			: null,
	);
}

export function todoAuditHasNewMaterialInputs(schedule: TodoSchedule | undefined, audit: TodoRowAudit): boolean {
	const current = schedule?.materialInputs;
	if (!current) return false;
	const previous = audit.materialInputs;
	if (!previous || current.criterion !== previous.criterion) return true;
	// Removing evidence does not supply a missing prerequisite or justify
	// repeating an exhausted audit. A replacement does introduce a new input.
	return (
		current.receipts.some(receipt => !previous.receipts.includes(receipt)) ||
		current.prerequisites.some(prerequisite => !previous.prerequisites.includes(prerequisite))
	);
}

/** Use the explicitly bound delivery repository before the session's checkout. */
export function todoArtifactRepository(task: { artifactCwd?: string; schedule?: TodoSchedule }, cwd: string): string {
	return (
		todoArtifactGitBinding(task)?.repoPath ??
		task.artifactCwd ??
		task.schedule?.executor?.gitCommits?.[0]?.repoPath ??
		cwd
	);
}

/** The row carries a deliverable: commit receipts, a pinned git resource, a review page, or a
 * commit id in the evidence the lead recorded on the row. Worker output prose is never read. */
export function todoRowHasDeliverable(task: { schedule?: TodoSchedule }): boolean {
	const schedule = task.schedule;
	if (!schedule) return false;
	if (schedule.executor?.gitCommits?.length) return true;
	const last = schedule.attemptHistory?.at(-1);
	if (last?.terminalStatus === "completed" && last.gitCommits?.length) return true;
	if (schedule.resources?.some(resource => /^git:.+@[0-9a-f]{40}$/.test(resource))) return true;
	if (schedule.reviewPage) return true;
	return COMMIT_ID.test(schedule.progress?.evidence ?? "");
}

/** What a row needs after its last worker settled, decided from row state only. */
export type TodoRowAfterWorker =
	| { kind: "verify"; via: "critic" | "audit"; worker: string; audit?: TodoRowAudit }
	| {
			kind: "needs-worker";
			reason: "findings" | "aborted" | "failed" | "lost" | "audit-failed" | "audit-inconclusive";
			worker: string;
			findings?: string;
	  };

/**
 * Post-completion lifecycle of an open row whose recorded executor is not running (callers check
 * liveness). A delivered result is audited; a result without a deliverable, an aborted or lost run,
 * a failed audit, or exhausted inconclusive audits needs a worker continuing the previous output.
 * Verified results, accepted rows, and rows never started return undefined.
 */
export function todoRowAfterWorker(task: TodoScheduleInputTask): TodoRowAfterWorker | undefined {
	if (task.status === "abandoned") return undefined;
	const schedule = task.schedule;
	const executor = schedule?.executor;
	if (schedule?.auditOrigin?.resolution === "retarget" && task.status !== "completed") {
		if (schedule.audit && schedule.audit.verdict !== "pending") return undefined;
		return { kind: "verify", via: "audit", audit: schedule.audit, worker: executor?.workerId ?? "superseded-check" };
	}
	if (!schedule || !executor?.workerId) return undefined;
	if (task.status === "completed" && !schedule.audit) return undefined;
	if (schedule.review === "accepted") return undefined;
	const worker = executor.workerId;
	const delivery = todoRowDeliveryKey(schedule);
	if (schedule.auditEscalation) return undefined;
	const critic = schedule.deliveryCritic;
	if (critic?.key === delivery) {
		if (critic.verdict === "defects")
			return { kind: "needs-worker", reason: "audit-failed", worker, findings: critic.evidence };
		if (critic.verdict === "clean" && critic.classified) return undefined;
		if (critic.verdict === "pending" && !critic.timedOut) return { kind: "verify", via: "critic", worker };
	}
	// A verdict from another runner (the old gate-runner fallback) verified nothing: re-audit.
	const audit =
		schedule.audit?.delivery === delivery &&
		schedule.audit.agent === TODO_ROW_AUDITOR &&
		todoAuditMatchesResources(schedule, schedule.audit) &&
		// A conclusion applies to the inputs actually checked. Exhausted inconclusive
		// attempts still require new evidence, rather than a removal-only retry.
		((schedule.audit.verdict !== "pass" && schedule.audit.verdict !== "fail") ||
			todoMaterialInputsKey(schedule.materialInputs) === todoMaterialInputsKey(schedule.audit.materialInputs))
			? schedule.audit
			: undefined;
	if (audit?.verdict === "fail")
		return { kind: "needs-worker", reason: "audit-failed", worker, findings: audit.findings };
	if (audit?.verdict === "pass") return undefined;
	if (
		(audit?.verdict === "inconclusive" || audit?.verdict === "omitted") &&
		(audit.attempts ?? 1) >= 2 &&
		!todoAuditHasNewMaterialInputs(schedule, audit)
	)
		return { kind: "needs-worker", reason: "audit-inconclusive", worker, findings: audit.findings };
	const deliverable = todoRowHasDeliverable(task);
	const profile = String(executor.agentProfile ?? "").toLowerCase();
	const auditRun = TODO_AUDIT_PROFILES.includes(profile);
	const finished = typeof executor.finishedAt === "number";
	if (executor.outcome === "completed" && finished) {
		return deliverable && !TODO_FINDINGS_PROFILES.includes(profile)
			? { kind: "verify", via: "audit", worker, audit }
			: { kind: "needs-worker", reason: "findings", worker };
	}
	// A lost audit run of a delivered result is re-audited; the delivery stays done.
	if (auditRun && deliverable && executor.outcome === undefined)
		return { kind: "verify", via: "audit", worker, audit };
	if (executor.outcome === "aborted" || executor.outcome === "failed")
		return { kind: "needs-worker", reason: executor.outcome, worker };
	return { kind: "needs-worker", reason: "lost", worker };
}

export type TodoDisplayState =
	| "working"
	| "waiting"
	| "auditing"
	| "verifying"
	| "audit queued"
	| "handoff pending"
	| "ready to close"
	| "needs you"
	| "needs worker"
	| "stuck";

export interface TodoDisplayWorker {
	id: string;
	agent?: string;
	/** Short model badge (model and thinking level) the worker runs on, when known. */
	model?: string;
	startedAt?: number;
}

/** Structured ledger projection; the display never infers a verdict from blocker text. */
export interface TodoDisplayRequirement {
	classification: string;
	rows: readonly string[];
	rowVerdicts?: Record<string, { status: string } | undefined>;
}

export interface TodoDisplayContext {
	workers: readonly TodoDisplayWorker[];
	/** Exact ownership links established by the runtime's executor/liveness policy. */
	owners: ReadonlyMap<string, TodoDisplayWorker>;
	requirements?: readonly TodoDisplayRequirement[];
	auditors?: ReadonlyMap<string, string>;
	/** Row audit selected to launch in this runtime tick. */
	auditLaunching?: ReadonlySet<string>;
	/** Every Task slot is taken: rows that need a worker cannot get one now. */
	capacityFull?: boolean;
}

export interface TodoDisplayRowState {
	state: TodoDisplayState;
	worker?: TodoDisplayWorker;
	dependency?: string;
	/** Why a "stuck" or "needs worker" row is not moving. */
	reason?: string;
	/** Settled worker whose output the next worker continues from. */
	previous?: string;
}

export function classifyTodoDisplayRow(
	task: TodoScheduleInputTask,
	phases: TodoScheduleInput,
	context: TodoDisplayContext,
): TodoDisplayRowState {
	const owner = context.owners.get(task.content);
	if (owner && owner.agent !== "qa-auditor") return { state: "working", worker: owner };
	const rowAuditor = task.schedule?.audit?.verdict === "pending" ? task.schedule.audit.workerId : undefined;
	const verifier = context.workers.find(worker => worker.id === rowAuditor);
	if (verifier) return { state: "verifying", worker: verifier };
	const auditorId = context.auditors?.get(task.content);
	const auditor = context.workers.find(worker => worker.id === auditorId);
	if (auditor || owner?.agent === "qa-auditor") return { state: "auditing", worker: auditor ?? owner };
	if (context.auditLaunching?.has(task.content)) return { state: "verifying" };
	const tasks = phases.flatMap(phase => phase.tasks);
	const visited = new Set<string>([task.content]);
	const findDependency = (dependencies: readonly string[]): TodoDisplayRowState | undefined => {
		for (const dependency of dependencies) {
			if (visited.has(dependency)) continue;
			visited.add(dependency);
			const job = context.workers.find(worker => worker.id === dependency);
			if (job) return { state: "waiting", dependency, worker: job };
			const matches = tasks.filter(row => row.content === dependency);
			if (matches.length !== 1) continue;
			const prerequisite = matches[0]!;
			if (prerequisite.status === "completed" || prerequisite.status === "abandoned") continue;
			const liveOwner = context.owners.get(dependency);
			if (liveOwner) return { state: "waiting", dependency: liveOwner.id, worker: liveOwner };
			const indirect = findDependency(prerequisite.schedule?.dependencies ?? []);
			if (indirect) return indirect;
		}
		return undefined;
	};
	const waiting = findDependency(task.schedule?.dependencies ?? []);
	if (waiting) return waiting;
	const after = todoRowAfterWorker(task);
	if (after?.kind === "verify")
		return {
			state: "audit queued",
			reason: after.audit?.verdict === "unavailable" ? "auditor unavailable" : undefined,
		};
	if (!after && isTodoReviewHandedOff(task)) return { state: "needs you" };
	if (!after && isTodoAwaitingReview(task)) return { state: "handoff pending" };
	const linked = context.requirements?.filter(requirement => requirement.rows.includes(task.content));
	if (
		!after &&
		(isTodoAwaitingReview(task) ||
			(linked?.length && linked.every(requirement => requirement.rowVerdicts?.[task.content]?.status === "pass")))
	)
		return { state: "ready to close" };
	if (task.status === "blocked") return { state: "stuck", reason: task.blocker ?? "blocked" };
	const needsWorker = (reason: string, previous?: string): TodoDisplayRowState =>
		context.capacityFull
			? { state: "waiting", reason: "cap full", previous }
			: { state: "needs worker", reason, previous };
	for (const dependency of task.schedule?.dependencies ?? []) {
		const prerequisite = tasks.find(row => row.content === dependency);
		if (!prerequisite || prerequisite.status === "completed" || prerequisite.status === "abandoned") continue;
		return prerequisite.status === "blocked"
			? { state: "stuck", reason: `blocked dependency ${dependency}` }
			: { state: "waiting", dependency };
	}
	return after ? needsWorker(after.reason, after.worker) : needsWorker("not started");
}

export function formatTodoDisplayEta(at: number | undefined, now: number): string {
	if (at === undefined || !Number.isFinite(at)) return "";
	return at > now ? `ETA ${displayTimestamp(at, now)}` : `overdue ${Math.floor((now - at) / 60_000)}m`;
}

/** Collapsed plan: one accounting line, one requirements line, then phase trees. */
export function renderTodoPlanDisplay(
	phases: TodoScheduleInput,
	context: TodoDisplayContext,
	options: {
		now: number;
		forecast?: TodoPlanForecast;
		archived?: number;
		width?: number;
		paint: (tone: "dim" | "warning" | "accent", text: string) => string;
	},
): { lines: string[]; owners: (string | undefined)[] } {
	const { now, paint } = options;
	const tasks = phases.flatMap(phase => phase.tasks);
	const open = tasks.filter(
		task => isTodoAwaitingReview(task) || (task.status !== "completed" && task.status !== "abandoned"),
	);
	const states = new Map(open.map(task => [task, classifyTodoDisplayRow(task, phases, context)]));
	const count = (state: TodoDisplayState): number => [...states.values()].filter(row => row.state === state).length;
	const archived = options.archived ?? 0;
	// Current residual forecast covers the whole open set; worker-attempt risk is diagnostic.
	const forecast = options.forecast;
	const eta = forecast ? formatPlanForecastDisplay(forecast, now, options.width !== undefined) : "";
	const counts = [
		`${count("working")} working`,
		...(
			[
				"waiting",
				"auditing",
				"verifying",
				"audit queued",
				"ready to close",
				"handoff pending",
				"needs you",
				"needs worker",
				"stuck",
			] as const
		)
			.filter(state => count(state) > 0)
			.map(
				state =>
					`${count(state)} ${state === "needs you" ? "need you" : state === "needs worker" ? "need worker" : state}`,
			),
	];
	const closed = `${tasks.length - open.length + archived} closed${archived ? ` (${archived} archived)` : ""}`;
	const header = `${open.length} open — ${counts.join(" · ")} · ${closed}${eta && options.width === undefined ? ` · ${eta}` : ""}`;
	const lines = [header];
	const owners: (string | undefined)[] = [undefined];
	const push = (line: string, worker?: TodoDisplayWorker): void => {
		lines.push(line);
		owners.push(worker?.id);
	};
	if (eta && options.width !== undefined) {
		const missed = forecast?.deadlineAt !== undefined && forecast.deadlineAt < now;
		push(
			paint(
				missed || forecast?.deadlineStatus === "will-miss" ? "warning" : "dim",
				truncateToWidth(eta, options.width),
			),
		);
	}
	if (context.requirements) {
		const requirements = context.requirements.filter(
			row => row.classification !== "merged" && row.classification !== "not-a-requirement",
		);
		const passed = requirements.filter(
			row => row.rows.length && row.rows.every(title => row.rowVerdicts?.[title]?.status === "pass"),
		).length;
		const failed = requirements.filter(row =>
			row.rows.some(title => row.rowVerdicts?.[title]?.status === "fail"),
		).length;
		push(paint("dim", `requirements ${passed}/${requirements.length} passed · ${failed} failed`));
	}
	const grouped = new Map<string, TodoScheduleInputTask[]>();
	for (const task of open) {
		const state = states.get(task)!;
		if (state.state !== "waiting" || !state.dependency) continue;
		const group = grouped.get(state.dependency) ?? [];
		group.push(task);
		grouped.set(state.dependency, group);
	}
	const emitted = new Set<string>();
	const elapsed = (worker: TodoDisplayWorker): string =>
		worker.startedAt === undefined ? "" : ` ${Math.floor(Math.max(0, now - worker.startedAt) / 60_000)}m`;
	for (const [index, phase] of phases.entries()) {
		const visible = phase.tasks.filter(task => states.has(task));
		if (!visible.length) continue;
		push(
			paint(
				"dim",
				`${index + 1}. ${safeText(phase.name)} · ${phase.tasks.filter(task => !states.has(task)).length}/${phase.tasks.length}`,
			),
		);
		for (const task of visible) {
			const state = states.get(task)!;
			const group = state.dependency ? grouped.get(state.dependency) : undefined;
			if (group && group.length > 1) {
				if (emitted.has(state.dependency!)) continue;
				emitted.add(state.dependency!);
				push(
					paint(
						"dim",
						`  ${group.length} waiting on ${safeText(state.dependency!)}${state.worker ? ` (running${elapsed(state.worker)})` : ""}`,
					),
					state.worker,
				);
				for (const child of group) push(paint("dim", `    ☐ ${safeText(child.content)}`), state.worker);
				continue;
			}
			const resourceWait = task.schedule?.resourceWait;
			const capacityWait = state.state === "waiting" && state.reason === "cap full";
			const label = resourceWait
				? `waiting for ${safeText(resourceWait.row)} (worker ${safeText(resourceWait.workerId ?? "unassigned")})`
				: capacityWait
					? "waiting for a worker slot"
					: state.state === "waiting"
						? `waiting on ${safeText(state.dependency!)}`
						: state.state;
			const why =
				resourceWait || capacityWait
					? undefined
					: (state.reason ?? (state.state === "stuck" ? task.blocker : undefined));
			const blocker = why ? `: ${truncateToWidth(safeText(why), TRUNCATE_LENGTHS.TITLE)}` : "";
			const rowWorkers = state.worker
				? [
						state.worker,
						...context.workers.filter(
							worker => worker.id !== state.worker?.id && task.schedule?.workerIds?.includes(worker.id),
						),
					]
				: [];
			const worker = state.worker
				? ` · ${rowWorkers.map(worker => `${safeText(worker.id)}${worker.agent ? ` (${safeText(worker.agent)})` : ""}${worker.model ? ` ${safeText(worker.model)}` : ""}${task.schedule?.executor?.workerId === worker.id && task.schedule.executor.resumedAfterCrash ? " (resumed after crash)" : ""}${elapsed(worker)}`).join(", ")}`
				: state.previous
					? ` · after ${safeText(state.previous)}`
					: "";
			const row = options.forecast?.rows.find(row => row.content === task.content);
			const rowEta = formatTodoDisplayEta(row?.resourceFinish, now);
			const history = task.schedule?.attemptHistory ?? [];
			const attempts = todoWorkAttempts(history).length;
			const sinceSuccess = history.slice(
				history.findLastIndex(attempt => attempt.terminalStatus === "completed" && !attempt.rejectionReason) + 1,
			);
			const failures = sinceSuccess.filter(todoAttemptIsInfra);
			const causes = new Map<string, number>();
			for (const failure of failures) {
				const cause = failure.infraFailureError ?? "unknown";
				causes.set(cause, (causes.get(cause) ?? 0) + 1);
			}
			const topCause = [...causes].sort((a, b) => b[1] - a[1])[0]?.[0];
			const infra = failures.length;
			const clocks = formatTodoRowClocks(task, now).join(" · ");
			let suffix = ` — ${label}${blocker}${worker}${clocks ? ` · ${clocks}` : ""}${rowEta ? ` · ${rowEta}` : ""}${attempts >= 2 ? ` · attempt ${attempts + 1}` : ""}${infra ? ` · infra failures ${infra} since last success: ${truncateToWidth(safeText(topCause ?? "unknown"), TRUNCATE_LENGTHS.TITLE)}` : ""}`;
			const content = safeText(task.content);
			let title = content;
			if (options.width !== undefined) {
				const available = Math.max(0, options.width - 4);
				// Keep the task identifiable before spending cells on diagnostics.
				// Full clocks, models and failure receipts remain in the expanded view.
				const titleWidth = Math.min(Bun.stringWidth(content), Math.floor(available * 0.45));
				suffix = ` — ${label}${blocker}${worker}${rowEta ? ` · ${rowEta}` : ""}${attempts >= 2 ? ` · attempt ${attempts + 1}` : ""}${infra ? ` · infra failures ${infra}` : ""}`;
				if (Bun.stringWidth(suffix) > available - titleWidth) {
					const holder = state.worker ? ` · ${safeText(state.worker.id)}${elapsed(state.worker)}` : "";
					const reason = blocker || (state.previous ? ` · after ${safeText(state.previous)}` : "");
					suffix = ` — ${label}${holder}${reason}${rowEta ? ` · ${rowEta}` : ""}${infra ? ` · infra failures ${infra}` : ""}`;
				}
				suffix = truncateToWidth(suffix, Math.max(0, available - titleWidth));
				title = truncateToWidth(content, Math.max(0, available - Bun.stringWidth(suffix)));
			}
			push(
				// Highlight rows a live worker is on, so "who is running" reads at a glance;
				// rows needing the owner or stuck are warnings, everything idle stays dim.
				paint(
					state.state === "stuck" || state.state === "needs you" ? "warning" : state.worker ? "accent" : "dim",
					options.width === undefined
						? `  ☐ ${title}${suffix}`
						: truncateToWidth(`  ☐ ${title}${suffix}`, options.width),
				),
				state.worker,
			);
		}
	}
	const assigned = new Set(open.flatMap(task => [states.get(task)?.worker?.id, ...(task.schedule?.workerIds ?? [])]));
	const unassigned = context.workers.filter(worker => !assigned.has(worker.id));
	if (unassigned.length) {
		push(paint("dim", "unassigned workers"));
		for (const worker of unassigned) push(paint("dim", `  ${safeText(worker.id)}${elapsed(worker)}`), worker);
	}
	return { lines, owners };
}
