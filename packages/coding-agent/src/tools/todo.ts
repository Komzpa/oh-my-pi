import { logger } from "@oh-my-pi/pi-utils";
import { getTodoPlanCalibrationStore, type TodoPlanCalibrationStore } from "./todo-plan-calibration";
import { patchTodoSchedule, reconcileAuditResourceChange } from "../session/todo-schedule-patch";
import {
	selectLatestBranchEntry,
	selectBranchNewestFirst,
	isTodoSelectionEntryMetadata,
	type BranchSource,
} from "../session/branch-selection";
import type {
	TodoArchivePersistedEdit,
	TodoArchiveSummary,
	TodoOperationPersistedEdit,
	TodoReworkAttemptPersistedEdit,
} from "@oh-my-pi/pi-tui/tools/todo";
import {
	formatTodoArchiveSummary,
	type TodoStatus,
	type TodoDeploymentBinding,
	type TodoOperation,
	type TodoItem,
	type TodoPhase,
	type TodoCompletionTransition,
	type TodoToolDetails,
	type TodoPersistedEdit,
} from "@oh-my-pi/pi-tui/tools/todo";
import {
	todoNeedsOwnerDecision,
	retainTodoDependencyReviews,
	forecastTodoPlan,
	formatPlanForecast,
	formatPlanForecastDisplay,
	formatTaskForecastDisplay,
	getTodoPlanningIssues,
	type TodoConfidence,
	type RowRiskOptions,
	type TodoSchedule,
	type TodoPlanForecast,
	type TodoPlanPrediction,
	type TodoReworkAttempt,
	validateTodoDependencies,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import { launchScope } from "@oh-my-pi/pi-utils/launch-trace";
import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import todoRequirementsDescription from "../prompts/tools/todo-requirements.md" with { type: "text" };
import todoComposition from "../prompts/tools/todo-composition.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionContextEntryMetadata } from "../session/session-context";
import type { SessionEntry } from "../session/session-entries";
import { loadRowRisk } from "../task/row-risk";
import { cfgTaskMaxConcurrency } from "../task/settings";

import { AgentRegistry } from "../registry/agent-registry";
import {
	checkRequirementDeliveredIdentity,
	currentRequirementIdentity,
	currentRequirementGitStatus,
	formatRequirementIdentity,
	hashArtifactFile,
	identityOf,
	type Identity,
	REQUIREMENT_ARTIFACT_LIMITS,
	describeGitCheckoutState,
	parseRequirementIdentity,
	type RequirementIdentity,
	type RequirementGitStatusSnapshots,
	type RequirementIdentityTarget,
	resolveResourceArtifact,
	sameIdentity,
} from "../utils/requirement-artifact";
import {
	matchingRequirementBranchNewestFirst,
	latestRequirementsFromSession,
	type RequirementEntryMetadata,
} from "../session/requirements-branch-selection";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";

import * as nodePath from "node:path";
import {
	REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
	appendRequirementsSnapshot,
	classifyRequirement,
	formatDoneGateRefusal,
	formatRequirementActionRefusal,
	evaluateRequirementDoneGate,
	invalidateStaleRequirementVerdicts,
	getRequirementRowVerdict,
	parseRequirementReceiptIdentities,
	getRequirementReceiptArtifactRowLabels,
	getPersistedRequirementAuditRejections,
	prepareAwaitingUserCheck,
	type RequirementsLedgerAppender,
	type RequirementLedgerItem,
	type RequirementDoneGateIssue,
} from "./requirements-ledger";

import { normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { readGoalDeadline, readGoalDeadlineFromManager } from "../goals/deadlines";
import { applyTodoExecutorObservation, appendTodoReworkAttempt, type TodoExecutorObservation } from "./todo-executor";

import {
	readTodoPlanHistory,
	settleTodoPlanRecord,
	todoPlanCalibrationHistory,
	todoPlanMembers,
	TODO_PLAN_HISTORY_CUSTOM_TYPE,
} from "./todo-plan-history";

export interface ReviewPageAnswer {
	task: string;
	page: string;
	card: string;
	contentSha: string;
	answer: "accept" | "redo" | "drop";
	note: string;
	at: string;
}

/** Gate evidence already resolved by TodoTool; notices must not probe it again. */
interface RequirementTodoToolDetails extends TodoToolDetails {
	requirementGateIssues?: RequirementDoneGateIssue[];
}

/** Whether an unknown value is a persisted todo phase. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(
		task =>
			isRecord(task) &&
			typeof task.content === "string" &&
			(task.status === "pending" ||
				task.status === "in_progress" ||
				task.status === "completed" ||
				task.status === "abandoned" ||
				task.status === "blocked"),
	);
}

/**
 * Phases a successful, state-changing `todo` result committed, or undefined
 * for errors, pure `view` reads, and requirement classification. A direct call
 * lands these on the branch through its own `toolResult` entry; a caller that
 * produces no `todo` toolResult (the eval bridge) must persist them itself or
 * the next branch rehydration (resume, rewind, fork, /btw) silently reverts the
 * change.
 */
export function committedTodoPhases(result: AgentToolResult): TodoPhase[] | undefined {
	if (result.isError || !isRecord(result.details)) return undefined;
	const { op, phases } = result.details;
	if (op === "view" || op === "classify" || !Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
	return phases;
}

/** Compact todo edit carried by new persisted todo results/custom entries. */
export function committedTodoEdit(result: AgentToolResult): TodoPersistedEdit | undefined {
	if (result.isError || !isRecord(result.details)) return undefined;
	const edit = result.details.edit;
	return isTodoPersistedEdit(edit) ? edit : undefined;
}

export const TODO_FULL_SNAPSHOT_CHECKPOINT_INTERVAL = 100;

export const TODO_CLOSED_COMPACTION_THRESHOLD = 50;
export const TODO_LIVE_CLOSED_TAIL = 10;

/** Compact closed history at a row closure, retaining actionable review and dependency context. */
export function archiveTodoPhases(
	phases: TodoPhase[],
	_now: number,
): { phases: TodoPhase[]; archivedPhases: TodoPhase[] } {
	const isClosed = (task: TodoItem): boolean => task.status === "completed" || task.status === "abandoned";
	const tasks = phases.flatMap(phase => phase.tasks);
	const closed = tasks.filter(isClosed);
	if (closed.length < TODO_CLOSED_COMPACTION_THRESHOLD) return { phases, archivedPhases: [] };
	const dependencies = new Set(
		tasks
			.filter(task => !isClosed(task))
			.flatMap(task => [
				...(task.schedule?.dependencies ?? []),
				...(task.schedule?.speculativeOn ? [task.schedule.speculativeOn] : []),
			]),
	);
	// Legacy rows lack finish times: their stable list order supplies the recent tail.
	const recent = [...closed].sort((a, b) => (a.schedule?.finishedAt ?? 0) - (b.schedule?.finishedAt ?? 0));
	const retained = new Set(recent.slice(-TODO_LIVE_CLOSED_TAIL));
	const live: TodoPhase[] = [];
	const archivedPhases: TodoPhase[] = [];
	for (const phase of phases) {
		const keep: TodoItem[] = [];
		const remove: TodoItem[] = [];
		for (const task of phase.tasks) {
			const schedule = task.schedule;
			const protectedRow =
				dependencies.has(task.content) ||
				schedule?.review === "user" ||
				schedule?.review === "redo" ||
				schedule?.handoffPending ||
				schedule?.reviewPagePending;
			if (isClosed(task) && !retained.has(task) && !protectedRow) remove.push(cloneTask(task));
			else keep.push(task);
		}
		if (keep.length) live.push({ ...phase, tasks: keep });
		if (remove.length) archivedPhases.push({ ...phase, tasks: remove });
	}
	return { phases: live, archivedPhases };
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = type(
	'"init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "schedule" | "view"',
).describe("operation to apply");

const TodoEstimateInput = type({
	optimisticSeconds: type("number"),
	likelySeconds: type("number"),
	pessimisticSeconds: type("number"),
	confidence: type('"low" | "medium" | "high"'),
	basis: type("string"),
});

const TodoScheduleUpdateInput = type({
	task: type("string"),
	"content?": type("string").describe("Rename the row; keeps its owner and history"),
	"dependencies?": type("string").array(),
	"owner?": type("string"),
	"agentProfile?": type("string"),
	"resources?": type("string").array(),
	"readOnly?": "boolean",
	"estimate?": TodoEstimateInput,
	"evidence?": type("string"),
	"materialInputs?": type({
		criterion: type("string"),
		receipts: type("string").array(),
		prerequisites: type("string").array(),
	}).describe(
		"Immutable criterion revision and receipt/source locators, including newly available prerequisite receipts. Administrative prose is not a material input.",
	),
	"decision?": type('"owner"').describe(
		"Agent-authored product content beyond the owner request needs an owner decision",
	),
	"review?": type('"user" | "accepted" | "redo" | "drop" | null'),
	"reviewCard?": type("string | null").describe("Published review card slug"),
	"reviewPage?": type("string | null").describe("HTTP URL of the published decision review page"),
	"speculativeOn?": type("string | null"),
	"postDeadline?": type("boolean").describe(
		"Explicitly move this row outside deadline scope; keep it as an after deadline follow-up",
	),
});

const InitListEntry = type({
	phase: type("string"),
	items: type("string").array().atLeastLength(1),
});

const todoSchema = type({
	op: TodoOp,
	"awaitingUser?": type({ action: "string", "ids?": type("string").array() }).describe(
		"user-owned pending check for block: exact action and optional card or other ids",
	),
	"list?": InitListEntry.array().describe("phases for init"),
	"task?": type("string").describe("verbatim task content; with view, show that task and its full attempt history"),
	"phase?": type("string").describe("phase name; with view, lists that whole phase including closed rows"),
	"archive?": type("boolean").describe("with view, include archived rows"),
	"previewReason?": type({
		task: "string",
		kind: '"deferred" | "not-applicable" | "external-blocker"',
		detail: "string",
		"deferUntil?": "number",
	}),
	"items?": type("string")
		.describe("task content")
		.array()
		.describe("tasks for single-phase init or append; exact task contents to close in one done/drop"),
	"reason?": type("string").describe(
		"required concise external blocker (max 160 normalized characters), naming its actor or condition",
	),
	"updates?": TodoScheduleUpdateInput.array().describe("atomic batch of task scheduling updates (schedule)"),
	"override?": type("string").describe(
		"names the plan-check demand this call answers; the gate suppresses that demand for a few turns",
	),
}).describe("apply a single todo operation");

type TodoParams = TodoSchema;
type TodoSchema = typeof todoSchema.infer;

/** A single todo op entry (the params object itself). */
type TodoOpEntryValue = TodoParams;

const artifactCwdScope = new AsyncLocalStorage<string>();

function bindArtifactCwd(task: TodoItem): void {
	const artifactCwd = artifactCwdScope.getStore();
	if (artifactCwd) {
		task.artifactCwd = artifactCwd;
		task.artifactOwner = "main";
	}
}

export interface RequirementRowArtifact {
	cwd: string;
	head: string | null;
	dirty: boolean;
	sha256?: string;
	/** SHA-256 over HEAD plus sorted dirty-path status and content; set only for dirty Git checkouts. */
	dirtyFingerprint?: string;
	reason?: string;
	awaitingUser?: TodoItem["awaitingUser"];
	/** Canonical identities offered to QA, or the exact receipt checked by its typed probes. */
	identities?: RequirementIdentity[];
	identityCheck?: { artifact: string; reason?: string };
}

export interface RequirementRowArtifactContext {
	cwd: string;
	sessionManager?: {
		getBranch(): SessionEntry[];
		getBranchMatching?(predicate: (metadata: RequirementEntryMetadata) => boolean): SessionEntry[];
		getCachedBranchMatching?(predicate: (metadata: RequirementEntryMetadata) => boolean): SessionEntry[];
		getLeafId?(): string | null;
		getSessionId?(): string | null;
		getEntryCount?(): number;
		readonly bodyRevision?: number;
	};
	setTodoPhases?: (phases: TodoPhase[]) => void;
	getAsyncJobSnapshot?: () => { running?: readonly { id: string; agentId?: string }[] } | undefined;
	signal?: AbortSignal;
	/**
	 * Checkout a finished non-isolated worker actually ran in, captured at the task
	 * execution boundary. Used only for a row scheduled to that exact owner.
	 */
	executionCheckout?: { owner: string; cwd: string };
	/** Saved receipt artifact to authenticate by kind before any owner or checkout lookup. */
	receipt?: string;
	gitStatusSnapshots?: RequirementGitStatusSnapshots;
}

const ABSOLUTE_ARTIFACT_PATH = /\/(?:home|srv|tmp|var|mnt|workspaces|Users)\/[^\s"'`),;]+/g;

function unknownRequirementArtifact(cwd: string, reason = "checkout mapping unavailable"): RequirementRowArtifact {
	return { cwd, head: null, dirty: true, reason };
}

/** Attach row-owned pending checks to the artifact used by every completion surface. */
export async function getRequirementRowArtifact(
	ctx: RequirementRowArtifactContext,
	row: string,
	phases: readonly TodoPhase[],
	checkoutCache?: Map<string, Promise<RequirementRowArtifact>>,
): Promise<RequirementRowArtifact> {
	let artifact = await resolveRequirementRowArtifact(ctx, row, phases, checkoutCache);
	if (ctx.receipt && artifact.head && !artifact.identityCheck && !artifact.reason) {
		const parsed = parseRequirementReceiptIdentities(ctx.receipt);
		if ("legacy" in parsed && parsed.commits.length === 1) {
			const check = await checkRequirementDeliveredIdentity(
				{ kind: "git", repo: artifact.cwd, commit: parsed.commits[0]! },
				ctx.signal,
				ctx.gitStatusSnapshots,
			);
			if (check.state === "fresh") artifact = { ...artifact, identityCheck: { artifact: ctx.receipt } };
		}
	}

	const tasks = phases.flatMap(phase => phase.tasks).filter(task => task.content === row);
	const pending = tasks.length === 1 ? tasks[0]!.awaitingUser : undefined;
	return pending?.action.trim() ? { ...artifact, awaitingUser: pending } : artifact;
}

/**
 * Declared typed targets of one row: its deploy string, or every explicit absolute
 * resource (an exact Git root is a `git:` location; any other file or directory is a
 * `file:` target, a directory by manifest). Explicit absolute resources never fall
 * through to the owner map; legacy textual descriptors keep the old resolver.
 * A receipt keeps its own immutable `paths=`; the Git root never widens or invents them.
 */
async function declaredRequirementTargets(
	task: TodoItem,
	cwd: string,
): Promise<RequirementIdentityTarget[] | { error: string } | undefined> {
	if (task.deployment !== undefined) {
		const parsed = parseRequirementIdentity(task.deployment);
		if ("error" in parsed) return { error: parsed.error };
		if (parsed.identity.kind !== "deploy") return { error: "deployment declaration is not a deploy: identity" };
		if (parsed.identity.scope !== undefined) return [parsed.identity];
		const { value: _value, ...target } = parsed.identity;
		return [target];
	}
	const schedule = (task as TodoItem & { schedule?: unknown }).schedule;
	const resources = isRecord(schedule) && Array.isArray(schedule.resources) ? schedule.resources : [];
	if (resources.length === 0 || resources.some(resource => typeof resource !== "string")) return undefined;
	for (const resource of resources as string[]) {
		if (
			!nodePath.isAbsolute(resource) &&
			!resource.startsWith(".") &&
			!(await fs.promises.lstat(nodePath.resolve(cwd, resource)).catch(() => undefined))
		)
			return undefined;
	}
	const targets: RequirementIdentityTarget[] = [];
	const canonicalResources = new Set<string>();
	for (const given of resources as string[]) {
		const resource = nodePath.resolve(cwd, given);
		const canonical = await fs.promises.realpath(resource).catch(() => nodePath.resolve(resource));
		if (canonicalResources.has(canonical)) return { error: `duplicate canonical resource ${resource}` };
		canonicalResources.add(canonical);
		const info = await fs.promises.lstat(resource).catch(() => undefined);
		const repo = info?.isDirectory() ? vcs.git(resource)?.info().repoRoot : undefined;
		if (repo === undefined || nodePath.resolve(repo) !== nodePath.resolve(resource)) {
			// Missing, symlinked, or special paths stay typed: the helper reports them unverifiable.
			targets.push({ kind: "file", path: resource });
			continue;
		}
		targets.push({ kind: "git", repo });
	}
	return targets;
}

/** Read-only coverage of a parsed receipt against the row's own declared targets; no probe runs here. */
async function requirementReceiptCoverageIssue(
	row: string,
	targets: readonly RequirementIdentityTarget[],
	identities: readonly RequirementIdentity[],
	declaredDeploymentValue?: string,
): Promise<string | undefined> {
	const canonical = async (value: string) => fs.promises.realpath(value).catch(() => nodePath.resolve(value));
	const covered = new Set<number>();
	for (const identity of identities) {
		let index = -1;
		for (const [candidate, target] of targets.entries()) {
			if (target.kind === "deploy") {
				if (identity.kind !== "deploy") continue;
				const { value: _value, ...declared } = identity;
				const { value: _targetValue, ...declaredTarget } = target;
				if (JSON.stringify(declared) === JSON.stringify(declaredTarget)) index = candidate;
			} else if (identity.kind !== "deploy") {
				const actual = await canonical(identity.kind === "file" ? identity.path : identity.repo);
				const expected = await canonical(target.kind === "file" ? target.path : target.repo);
				const directory =
					target.kind === "file" && (await fs.promises.stat(expected).catch(() => undefined))?.isDirectory();
				const relative = nodePath.relative(expected, actual);
				if (
					(actual === expected && identity.kind === target.kind) ||
					(directory &&
						relative !== ".." &&
						!relative.startsWith(`..${nodePath.sep}`) &&
						!nodePath.isAbsolute(relative))
				)
					index = candidate;
			}
			if (index >= 0) break;
		}
		if (index < 0)
			return `receipt identity ${formatRequirementIdentity(identity)} is outside row ${JSON.stringify(row)}'s declared targets`;
		const target = targets[index]!;
		if (
			identity.kind === "deploy" &&
			target.kind === "deploy" &&
			declaredDeploymentValue !== undefined &&
			identity.value !== declaredDeploymentValue
		)
			return `receipt deployment value ${JSON.stringify(identity.value)} does not match declared value ${JSON.stringify(declaredDeploymentValue)}`;
		if (identity.kind === "git" && target.kind === "git") {
			if (identity.paths?.length === 0) return `receipt git identity for ${target.repo} names an empty paths list`;
			const declaredPaths = target.paths;
			if (
				declaredPaths !== undefined &&
				JSON.stringify([...declaredPaths].sort()) !== JSON.stringify([...(identity.paths ?? [])].sort())
			)
				return `receipt git paths do not match the declared scope for ${target.repo}`;
		}
		covered.add(index);
	}
	const uncovered = targets.filter((_target, index) => !covered.has(index));
	if (uncovered.length)
		return `receipt does not cover declared ${uncovered.map(target => (target.kind === "file" ? target.path : target.kind === "git" ? target.repo : target.target)).join(", ")}`;
	return undefined;
}

/** Typed row identity: kind parse and declared coverage, then real probes; never owner-map fallback. */
async function resolveTypedRequirementArtifact(
	ctx: RequirementRowArtifactContext,
	row: string,
	task: TodoItem,
): Promise<RequirementRowArtifact | undefined> {
	const declaredTargets = await declaredRequirementTargets(task, ctx.cwd);
	const receipt = ctx.receipt;
	const declaration = task.deployment ? parseRequirementIdentity(task.deployment) : undefined;
	const declaredDeploymentValue =
		declaration && "identity" in declaration && declaration.identity.kind === "deploy"
			? declaration.identity.value
			: undefined;
	let targets: RequirementIdentityTarget[] | { error: string } | undefined = declaredTargets;
	let parsed:
		| { identities: RequirementIdentity[] }
		| { error: string }
		| { legacy: true; commits: string[] }
		| undefined;
	// Optional resource pins do not turn a typed file/readback receipt into a Git
	// checkout: its own declared target and current SHA-256 govern freshness.
	if (targets === undefined && receipt !== undefined) {
		parsed = parseRequirementReceiptIdentities(receipt);
		if ("error" in parsed) return unknownRequirementArtifact(row, `invalid typed identity (${parsed.error})`);
		if (!("legacy" in parsed))
			targets = parsed.identities.map(identity => {
				if (identity.kind === "deploy") {
					if (identity.scope !== undefined) return identity;
					const { value: _value, ...target } = identity;
					return target;
				}
				if (identity.kind === "git")
					return {
						kind: "git",
						repo: identity.repo,
						...(identity.paths !== undefined ? { paths: identity.paths } : {}),
					};
				return { kind: "file", path: identity.path };
			});
	}
	if (!targets) return undefined;
	if ("error" in targets) return unknownRequirementArtifact(row, `invalid typed declaration (${targets.error})`);
	const resolvedTargets = targets;
	const location = resolvedTargets
		.map(target => (target.kind === "file" ? target.path : target.kind === "git" ? target.repo : target.target))
		.join("; ");
	// Current identities of the row's OWN targets are the exact QA input and the quoted retry form.
	const current = async (): Promise<RequirementRowArtifact> => {
		const identities: RequirementIdentity[] = [];
		const errors: string[] = [];
		for (const target of resolvedTargets) {
			const resolved = await currentRequirementIdentity(target, ctx.signal, ctx.gitStatusSnapshots);
			if ("error" in resolved) errors.push(resolved.error);
			else identities.push(resolved.identity);
		}
		if (errors.length) {
			const gitTarget = resolvedTargets.find(target => target.kind === "git");
			const state =
				gitTarget?.kind === "git"
					? await describeGitCheckoutState(gitTarget.repo, ctx.signal, ctx.gitStatusSnapshots)
					: undefined;
			return {
				cwd: location,
				head: state?.head ?? null,
				dirty: state?.dirty ?? false,
				reason: `current identity unavailable (${errors.join("; ")})`,
			};
		}
		const observedDeployment = identities.find(identity => identity.kind === "deploy");
		if (
			declaredDeploymentValue !== undefined &&
			observedDeployment?.kind === "deploy" &&
			observedDeployment.value !== declaredDeploymentValue
		)
			return unknownRequirementArtifact(
				location,
				`deployment currently reports ${JSON.stringify(observedDeployment.value)} but row declares ${JSON.stringify(declaredDeploymentValue)}`,
			);
		return { cwd: location, head: null, dirty: false, identities };
	};
	if (receipt === undefined) return current();
	const reject = async (reason: string): Promise<RequirementRowArtifact> => {
		const own = await current();
		const retry = own.identities
			? `retry with row ${JSON.stringify(row)} @ ${own.identities.map(formatRequirementIdentity).join("; ")}`
			: own.reason!;
		return {
			...own,
			reason: undefined,
			identityCheck: {
				artifact: receipt,
				reason: formatRequirementActionRefusal(
					`Re-audit ${JSON.stringify(row)} on its current artifact.`,
					`${reason}; ${retry}`,
				),
			},
		};
	};
	let receiptIdentities = parsed ?? parseRequirementReceiptIdentities(receipt);
	if ("legacy" in receiptIdentities) {
		const target = resolvedTargets.length === 1 ? resolvedTargets[0] : undefined;
		const labels = getRequirementReceiptArtifactRowLabels(receipt, new Set([row]));
		if (
			target?.kind !== "git" ||
			target.paths !== undefined ||
			labels.length !== 1 ||
			labels[0] !== row ||
			receiptIdentities.commits.length !== 1
		)
			return reject("receipt has no unambiguous row-bound Git identity");
		receiptIdentities = { identities: [{ kind: "git", repo: target.repo, commit: receiptIdentities.commits[0]! }] };
	}
	if ("error" in receiptIdentities) return reject(`invalid typed identity (${receiptIdentities.error})`);
	const coverageIssue = await requirementReceiptCoverageIssue(
		row,
		resolvedTargets,
		receiptIdentities.identities,
		declaredDeploymentValue,
	);
	if (coverageIssue) return reject(coverageIssue);
	for (const identity of receiptIdentities.identities) {
		const check = await checkRequirementDeliveredIdentity(identity, ctx.signal, ctx.gitStatusSnapshots);
		if (check.state === "stale")
			return reject(`stale ${check.kind} ${check.location}: expected ${check.expected}, observed ${check.observed}`);
		if (check.state === "unverifiable")
			return reject(`unverifiable ${check.kind} ${check.location}: expected ${check.expected} (${check.reason})`);
	}
	return {
		cwd: location,
		head: null,
		dirty: false,
		identities: receiptIdentities.identities,
		identityCheck: { artifact: receipt },
	};
}

interface RequirementArtifactPlan {
	phases: readonly TodoPhase[];
	latest: Map<string, TodoItem[]>;
	historical: Map<string, TodoItem | null>;
	historicalLoaded: boolean;
}
const requirementArtifactPlans = new WeakMap<
	object,
	{
		leaf: string | null;
		count: number | undefined;
		revision: number;
		plan: RequirementArtifactPlan;
		entries: SessionEntry[];
	}
>();

function isRequirementArtifactTodoMetadata(metadata: RequirementEntryMetadata): boolean {
	return (
		(metadata.type === "custom" && metadata.customType === USER_TODO_EDIT_CUSTOM_TYPE) ||
		(metadata.type === "message" && metadata.messageRole === "toolResult" && metadata.toolName === "todo")
	);
}

/** Latest full snapshot and subsequent edits, never obsolete artifact snapshots. */
export function currentRequirementTodoEntries(
	manager: Pick<NonNullable<RequirementRowArtifactContext["sessionManager"]>, "getBranch">,
): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const entry of matchingRequirementBranchNewestFirst(manager, isRequirementArtifactTodoMetadata)) {
		entries.push(entry);
		if (canonicalTodoPhases(entry) !== undefined) break;
	}
	return entries.reverse();
}

const requirementArtifactHistories = new WeakMap<
	object,
	{ latest?: string; revision?: number; rows: Map<string, TodoItem | null> }
>();

/** Explicit archived-row lookup: retain row facts and advance only across new entries. */
function historicalRequirementRows(
	manager: NonNullable<RequirementRowArtifactContext["sessionManager"]>,
): Map<string, TodoItem | null> {
	const cached = requirementArtifactHistories.get(manager);
	const rows = new Map<string, TodoItem | null>();
	let latest: string | undefined;
	for (const entry of matchingRequirementBranchNewestFirst(manager, isRequirementArtifactTodoMetadata)) {
		latest ??= entry.id;
		if (
			cached &&
			manager.bodyRevision !== undefined &&
			cached.revision === manager.bodyRevision &&
			entry.id === cached.latest
		) {
			for (const [row, task] of cached.rows) if (!rows.has(row)) rows.set(row, task);
			break;
		}
		const snapshots: (readonly TodoPhase[])[] = [];
		observeLatestTodoPhases([entry], phases => snapshots.push(phases));
		for (const phases of snapshots.reverse()) {
			const observed = new Map<string, TodoItem | null>();
			for (const phase of phases)
				for (const task of phase.tasks) observed.set(task.content, observed.has(task.content) ? null : task);
			for (const [row, task] of observed) if (!rows.has(row)) rows.set(row, task ? cloneTask(task) : null);
		}
	}
	requirementArtifactHistories.set(manager, { latest, revision: manager.bodyRevision, rows });
	return rows;
}

const requirementRowChangeHistories = new WeakMap<
	object,
	{ latest?: string; revision?: number; phases: TodoPhase[]; changes: Map<string, { at: string; id: string }> }
>();

/** Exact legacy receipt history is demanded explicitly; subsequent checks fold only its new tail. */
export function historicalRequirementRowChanges(
	manager: NonNullable<RequirementRowArtifactContext["sessionManager"]>,
): Map<string, { at: string; id: string }> {
	const cached = requirementRowChangeHistories.get(manager);
	const tail: SessionEntry[] = [];
	let extendsCached = false;
	let latest: string | undefined;
	for (const entry of matchingRequirementBranchNewestFirst(manager, isRequirementArtifactTodoMetadata)) {
		latest ??= entry.id;
		if (
			cached &&
			manager.bodyRevision !== undefined &&
			cached.revision === manager.bodyRevision &&
			entry.id === cached.latest
		) {
			extendsCached = true;
			break;
		}
		tail.push(entry);
	}
	if (extendsCached && tail.length === 0) return cached!.changes;
	tail.reverse();
	if (extendsCached)
		tail.unshift({
			type: "custom",
			customType: USER_TODO_EDIT_CUSTOM_TYPE,
			id: cached!.latest!,
			parentId: null,
			timestamp: new Date(0).toISOString(),
			data: { phases: cached!.phases },
		});
	const updates = getTodoRowChanges(tail);
	const changes = extendsCached ? new Map(cached!.changes) : new Map<string, { at: string; id: string }>();
	for (const [row, change] of updates) if (!extendsCached || change.id !== cached!.latest) changes.set(row, change);
	requirementRowChangeHistories.set(manager, {
		latest,
		revision: manager.bodyRevision,
		phases: getLatestTodoPhasesFromEntries(tail),
		changes,
	});
	return changes;
}

function requirementArtifactPlan(
	manager: NonNullable<RequirementRowArtifactContext["sessionManager"]>,
	includeHistorical = false,
): RequirementArtifactPlan {
	const leaf = manager.getLeafId?.();
	const revision = manager.bodyRevision;
	const count = manager.getEntryCount?.();
	const cached = requirementArtifactPlans.get(manager);
	const cacheable = leaf !== undefined && revision !== undefined;
	if (
		cacheable &&
		cached?.leaf === leaf &&
		cached.revision === revision &&
		cached.count === count &&
		(!includeHistorical || cached.plan.historicalLoaded)
	)
		return cached.plan;
	const entries = currentRequirementTodoEntries(manager);
	if (
		cacheable &&
		cached?.revision === revision &&
		cached.entries.length === entries.length &&
		cached.entries.every((entry, index) => entry === entries[index]) &&
		(!includeHistorical || cached.plan.historicalLoaded)
	) {
		requirementArtifactPlans.set(manager, { leaf, revision, count, entries, plan: cached.plan });
		return cached.plan;
	}
	const phases = getLatestTodoPhasesFromEntries(entries);
	const latest = new Map<string, TodoItem[]>();
	for (const phase of phases) {
		for (const task of phase.tasks) {
			const matches = latest.get(task.content) ?? [];
			matches.push(task);
			latest.set(task.content, matches);
		}
	}
	const historical = includeHistorical ? historicalRequirementRows(manager) : new Map<string, TodoItem | null>();
	const plan = { phases, latest, historical, historicalLoaded: includeHistorical };
	if (cacheable) requirementArtifactPlans.set(manager, { leaf, revision, count, entries, plan });
	return plan;
}

/** Share the completion/publication gate's current plan and demanded archived row facts. */
export function getRequirementGateBranch(
	manager: NonNullable<RequirementRowArtifactContext["sessionManager"]>,
	requirements: readonly RequirementLedgerItem[],
	targetRows: ReadonlySet<string>,
	phases: readonly TodoPhase[],
): SessionEntry[] {
	const branch = currentRequirementTodoEntries(manager);
	for (const entry of matchingRequirementBranchNewestFirst(
		manager,
		metadata => metadata.type === "custom" && metadata.customType === REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
	)) {
		if (
			entry.type === "custom" &&
			isRecord(entry.data) &&
			entry.data.sessionId === manager.getSessionId?.() &&
			Array.isArray(entry.data.rejected)
		) {
			branch.push(entry);
			break;
		}
	}
	const liveRows = new Set(phases.flatMap(phase => phase.tasks.map(task => task.content)));
	const archivedRows = requirements
		.filter(
			requirement => requirement.classification === "linked" && requirement.rows.some(row => targetRows.has(row)),
		)
		.flatMap(requirement => requirement.rows)
		.filter(row => !liveRows.has(row));
	if (archivedRows.length > 0) {
		const historical = requirementArtifactPlan(manager, true).historical;
		const tasks = archivedRows.flatMap(row => {
			const task = historical.get(row);
			return task ? [task] : [];
		});
		branch.unshift({
			type: "custom",
			customType: USER_TODO_EDIT_CUSTOM_TYPE,
			id: "archived-requirement-rows",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			data: { phases: [{ name: "Archived", tasks }] },
		});
	}
	return branch;
}

/** Read the active TODO snapshot through the append-aware artifact-plan selection cache.
 * Treat returned phases as shared state; persist edits with copied rows instead. */
export function getRequirementArtifactTodoPhases(
	manager: NonNullable<RequirementRowArtifactContext["sessionManager"]>,
): readonly TodoPhase[] {
	return requirementArtifactPlan(manager).phases;
}

/** Resolve a row's persisted checkout, then read its current HEAD and dirty state without blocking the CLI. */
async function resolveRequirementRowArtifact(
	ctx: RequirementRowArtifactContext,
	row: string,
	phases: readonly TodoPhase[],
	checkoutCache?: Map<string, Promise<RequirementRowArtifact>>,
): Promise<RequirementRowArtifact> {
	let task: TodoItem | undefined;
	for (const phase of phases) {
		for (const candidate of phase.tasks) {
			if (candidate.content !== row) continue;
			if (task) return unknownRequirementArtifact(`duplicate TODO row ${JSON.stringify(row)}`);
			task = candidate;
		}
	}
	const archived = !task;
	if (!task && ctx.sessionManager) {
		const historical = requirementArtifactPlan(ctx.sessionManager, true).historical.get(row);
		if (historical === null)
			return unknownRequirementArtifact(`duplicate historical TODO row ${JSON.stringify(row)}`);
		task = historical;
	}
	if (!task) return unknownRequirementArtifact("unknown row");
	// Typed declarations resolve by receipt kind before owner/registry/checkout lookup.
	const typed = await resolveTypedRequirementArtifact(ctx, row, task);
	if (typed) return typed;

	const schedule = (task as TodoItem & { schedule?: unknown }).schedule;
	const metadata = isRecord(schedule) ? schedule : undefined;
	const owner = typeof metadata?.owner === "string" ? metadata.owner : undefined;
	const mainOwner = owner === undefined || owner.toLowerCase() === "main";
	const resources = Array.isArray(metadata?.resources) ? metadata.resources : [];
	const paths: string[] = [];
	const branchNames: string[] = [];
	for (const resource of resources) {
		if (typeof resource !== "string") continue;
		// An exact absolute path is a filesystem path verbatim: leading and trailing
		// whitespace is part of the name and is never trimmed (norm 16). Legacy
		// textual descriptor trimming applies only to non-path descriptors.
		if (nodePath.isAbsolute(resource)) {
			paths.push(resource);
			continue;
		}
		const value = resource.trim();
		// Legacy textual descriptor: trimmed text that is itself an absolute path
		// binds it verbatim; otherwise embedded absolute paths are extracted.
		if (nodePath.isAbsolute(value)) paths.push(value);
		else paths.push(...(value.match(ABSOLUTE_ARTIFACT_PATH) ?? []));
		const branch = /^(?:branch:|branch=|refs\/heads\/)(.+)$/.exec(value)?.[1];
		if (branch) branchNames.push(branch);
	}
	if (new Set(branchNames).size > 1) return unknownRequirementArtifact(`ambiguous branches ${branchNames.join(", ")}`);
	const effectiveOwner = owner ?? "main";
	// The binding persisted on the session's latest copy of this row counts even
	// when the caller's in-memory plan predates it; it must be for the same owner
	// and the same schedule, so a reassigned row never inherits an old checkout.
	let persistedCwd: string | undefined;
	const latest =
		archived || !ctx.sessionManager ? [] : (requirementArtifactPlan(ctx.sessionManager).latest.get(row) ?? []);
	const latestTask = latest.length === 1 ? latest[0]! : undefined;
	const latestSchedule = latestTask && "schedule" in latestTask ? latestTask.schedule : undefined;
	for (const candidate of [
		task,
		JSON.stringify(latestSchedule) === JSON.stringify(schedule) ? latestTask : undefined,
	]) {
		if (
			!persistedCwd &&
			typeof candidate?.artifactCwd === "string" &&
			nodePath.isAbsolute(candidate.artifactCwd) &&
			candidate.artifactOwner === effectiveOwner
		)
			persistedCwd = candidate.artifactCwd;
	}
	const declaredDeployment =
		task.deployment ??
		(JSON.stringify(latestSchedule) === JSON.stringify(schedule) ? latestTask?.deployment : undefined);
	if (declaredDeployment) return unknownRequirementArtifact(`unresolved deployment ${declaredDeployment}`);
	const finishedCheckout =
		!mainOwner && owner !== undefined && ctx.executionCheckout?.owner === owner
			? ctx.executionCheckout.cwd
			: undefined;

	const running = archived ? [] : (ctx.getAsyncJobSnapshot?.()?.running ?? []);
	const activeJob = owner === undefined ? undefined : running.find(job => job.id === owner || job.agentId === owner);
	const registry = AgentRegistry.global();
	let agent = archived || owner === undefined ? undefined : registry.get(owner);
	if (!agent && activeJob?.agentId) agent = registry.get(activeJob.agentId);
	if (!agent && !archived && paths.length === 0 && !persistedCwd && !finishedCheckout) {
		for (const reference of registry.list()) {
			if (!("todoRow" in reference) || reference.todoRow !== row) continue;
			if (agent) return unknownRequirementArtifact(`ambiguous registered owners for ${JSON.stringify(row)}`);
			agent = reference;
		}
		if (
			agent &&
			owner !== undefined &&
			owner !== agent.id &&
			owner !== activeJob?.id &&
			owner !== activeJob?.agentId
		) {
			return unknownRequirementArtifact(
				`owner ${JSON.stringify(owner)} conflicts with registered row owner ${JSON.stringify(agent.id)}`,
			);
		}
	}
	// Main owns the session checkout by default, including an explicit empty
	// resource list. Named resources and persisted bindings still take precedence;
	// an unmapped worker must never inherit Main's checkout.
	const ownerCwd = mainOwner
		? archived || paths.length || persistedCwd
			? undefined
			: ctx.cwd
		: resources.length > 0
			? undefined
			: (finishedCheckout ?? persistedCwd ?? agent?.session?.sessionManager.getCwd());
	// A reassigned worker whose checkout is not known must not inherit the row's initial main checkout.
	if (
		!archived &&
		owner &&
		!mainOwner &&
		!ownerCwd &&
		!persistedCwd &&
		!finishedCheckout &&
		paths.length === 0 &&
		branchNames.length === 0
	) {
		return unknownRequirementArtifact(`unknown checkout for owner ${JSON.stringify(owner)}`);
	}
	if (branchNames.length > 0) {
		const anchor =
			ownerCwd ??
			paths[0] ??
			(typeof task.artifactCwd === "string" && nodePath.isAbsolute(task.artifactCwd) ? task.artifactCwd : undefined);
		if (!anchor) return unknownRequirementArtifact(`unknown worktree for ${branchNames.join(", ")}`);
		try {
			const worktrees = await vcs.requireGit(anchor).worktrees(ctx.signal);
			const matches = worktrees.filter(worktree =>
				branchNames.includes(worktree.branch?.replace(/^refs\/heads\//, "") ?? ""),
			);
			if (matches.length !== 1) return unknownRequirementArtifact(`unknown worktree for ${branchNames.join(", ")}`);
			paths.push(matches[0]!.path);
		} catch {
			return unknownRequirementArtifact(`unknown worktree for ${branchNames.join(", ")}`);
		}
	}
	const uniquePaths = [...new Set(paths)];
	// Explicit resources win over any checkout: several files, a single file, or a
	// non-Git directory are bound by their content SHA (manifest for sets).
	if (uniquePaths.length > 1) return resolveResourceArtifact(uniquePaths, ctx.signal);
	// A matching live execution is authoritative for the checkout it just used;
	// a prior binding is only the fallback after that execution has ended.
	const path = uniquePaths[0] ?? finishedCheckout ?? persistedCwd ?? ownerCwd;
	if (!path)
		return unknownRequirementArtifact(
			`unknown artifact mapping for ${JSON.stringify(row)} (owner ${JSON.stringify(owner ?? null)})`,
		);

	try {
		const info = await fs.promises.stat(path);
		if (info.isFile()) return resolveResourceArtifact([path], ctx.signal);
		if (!info.isDirectory()) return unknownRequirementArtifact(path, "resource is neither a file nor a directory");
	} catch {
		return unknownRequirementArtifact(path, "resource path is missing or inaccessible");
	}
	const cwd = path;
	const repo = vcs.git(cwd);
	if (!repo) return resolveResourceArtifact([cwd], ctx.signal);
	const repoRoot = repo.info().repoRoot;
	let current = checkoutCache?.get(repoRoot);
	if (!current) {
		current = Promise.all([repo.headSha(ctx.signal), currentRequirementGitStatus(repo, ctx.signal, true)])
			.then(async ([head, status]): Promise<RequirementRowArtifact> => {
				if (!status) return { cwd: repoRoot, head: head ?? null, dirty: false };
				const fingerprint = await dirtyCheckoutFingerprint(repoRoot, head ?? null, status, ctx.signal);
				if ("reason" in fingerprint) return unknownRequirementArtifact(repoRoot, fingerprint.reason);
				// Fail closed on concurrent drift: the fingerprint is the audited identity
				// only while HEAD and the full Git change/path set still match after
				// all hashing.
				const [headAfter, statusAfter] = await Promise.all([
					repo.headSha(ctx.signal),
					currentRequirementGitStatus(repo, ctx.signal, true),
				]);
				if (headAfter !== head || statusAfter !== status)
					return unknownRequirementArtifact(repoRoot, "Git checkout changed while fingerprinting");
				return { cwd: repoRoot, head: head ?? null, dirty: true, dirtyFingerprint: fingerprint.sha256 };
			})
			.catch(() => unknownRequirementArtifact(repoRoot, "Git HEAD or status unavailable"));
		checkoutCache?.set(repoRoot, current);
	}
	return current;
}

/**
 * Content identity of a dirty checkout: HEAD plus every porcelain entry sorted by
 * path, each with its status code and current content. A path whose status stays
 * `M` still changes the fingerprint when its bytes change. Deleted paths hash as
 * absent, symlinks by target (never followed), renames by both paths; anything
 * else (directories such as submodules, unreadable or oversized files) fails closed.
 */
async function dirtyCheckoutFingerprint(
	repoRoot: string,
	head: string | null,
	status: string,
	signal?: AbortSignal,
): Promise<{ sha256: string } | { reason: string }> {
	const repo = vcs.git(repoRoot);
	if (!repo) return { reason: "Git checkout unavailable while fingerprinting" };
	const observeMode = process.platform !== "win32" && (await repo.configGet("core.fileMode", signal)) !== "false";
	const fields = status.split("\0");
	const entries: Array<[path: string, code: string, origin: string]> = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (!field) continue;
		const code = field.slice(0, 2);
		// Porcelain -z writes the rename/copy source as the following field.
		const origin = code.includes("R") || code.includes("C") ? (fields[++index] ?? "") : "";
		entries.push([field.slice(3), code, origin]);
	}
	if (entries.length > REQUIREMENT_ARTIFACT_LIMITS.maxFiles)
		return { reason: `dirty checkout exceeds file-count bound ${REQUIREMENT_ARTIFACT_LIMITS.maxFiles}` };
	entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
	const hash = new Bun.CryptoHasher("sha256").update(`head\0${head ?? ""}\0`);
	let bytes = 0;
	const seen: Array<[absolute: string, relative: string, identity: Identity]> = [];
	for (const [relative, code, origin] of entries) {
		const absolute = nodePath.join(repoRoot, relative);
		let content: string;
		try {
			const info = await fs.promises.lstat(absolute);
			seen.push([absolute, relative, identityOf(info)]);
			if (info.isSymbolicLink()) content = `symlink\0${await fs.promises.readlink(absolute)}`;
			else if (info.isFile()) {
				bytes += info.size;
				if (bytes > REQUIREMENT_ARTIFACT_LIMITS.maxBytes)
					return { reason: `dirty checkout exceeds aggregate byte bound ${REQUIREMENT_ARTIFACT_LIMITS.maxBytes}` };
				content = `file\0${observeMode ? (info.mode & 0o100 ? "100755" : "100644") : ""}\0${await hashArtifactFile(absolute, signal)}`;
			} else return { reason: `${relative}: dirty path is neither a file nor a symlink` };
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				signal?.throwIfAborted();
				return { reason: `${relative}: ${error instanceof Error ? error.message : String(error)}` };
			}
			content = "absent";
		}
		hash.update(`${code}\0${relative}\0${origin}\0${content}\0`);
	}
	// Re-check every earlier entry's metadata after all hashing, so a file rewritten
	// while a later file was hashed fails closed (same stability contract as the
	// explicit-set manifest recheck in resolveResourceArtifact).
	for (const [absolute, relative, identity] of seen) {
		const current = await fs.promises
			.lstat(absolute)
			.then(identityOf)
			.catch(() => undefined);
		if (!current || !sameIdentity(identity, current)) return { reason: `${relative}: changed while fingerprinting` };
	}
	return { sha256: hash.digest("hex") };
}

/** Persist an unambiguous live audit checkout on the canonical TODO row before the worker can disappear. */
export async function bindRequirementRowArtifact(
	ctx: RequirementRowArtifactContext,
	row: string,
	phases: readonly TodoPhase[],
	pi: RequirementsLedgerAppender,
	checkoutCache?: Map<string, Promise<RequirementRowArtifact>>,
): Promise<RequirementRowArtifact> {
	const artifact = await getRequirementRowArtifact(ctx, row, phases, checkoutCache);
	// Typed rows bind nothing else: their declarations and artifactCwd are never overwritten.
	if (artifact.identities || artifact.identityCheck) return artifact;
	// Unresolved mappings bind nothing; resolved Git, file and manifest identities persist their real cwd.
	if (!ctx.sessionManager) return artifact;
	let original: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content !== row) continue;
			if (original) return unknownRequirementArtifact(`duplicate TODO row ${JSON.stringify(row)}`);
			original = task;
		}
	}
	// An archived row already has persisted checkout ownership; never resurrect it in the active plan.
	if (!original) return artifact;
	const scheduledOwner = (original as TodoItem & { schedule?: { owner?: unknown } }).schedule?.owner;
	const executionCheckoutIsAuthoritative =
		typeof scheduledOwner === "string" &&
		ctx.executionCheckout?.owner === scheduledOwner &&
		nodePath.resolve(ctx.executionCheckout.cwd) === nodePath.resolve(artifact.cwd);
	if ((artifact.reason || (!artifact.head && !artifact.sha256)) && !executionCheckoutIsAuthoritative) return artifact;

	const currentPhases = getRequirementArtifactTodoPhases(ctx.sessionManager);
	let current: TodoItem | undefined;
	for (const phase of currentPhases) {
		for (const task of phase.tasks) {
			if (task.content !== row) continue;
			if (current) return unknownRequirementArtifact(`duplicate TODO row ${JSON.stringify(row)}`);
			current = task;
		}
	}
	if (
		!current ||
		JSON.stringify((current as TodoItem & { schedule?: unknown }).schedule) !==
			JSON.stringify((original as TodoItem & { schedule?: unknown }).schedule) ||
		(current.artifactOwner ?? "main") !== (original.artifactOwner ?? "main")
	) {
		return unknownRequirementArtifact(`TODO row ${JSON.stringify(row)} changed during artifact binding`);
	}
	const owner = (current as TodoItem & { schedule?: { owner?: unknown } }).schedule?.owner;
	const artifactOwner = typeof owner === "string" ? owner : "main";
	if (original.artifactCwd === artifact.cwd && original.artifactOwner === artifactOwner) return artifact;
	const boundPhases = currentPhases.map(phase => ({
		...phase,
		tasks: phase.tasks.map(task => (task === current ? { ...task, artifactCwd: artifact.cwd, artifactOwner } : task)),
	}));
	pi.appendEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: boundPhases });
	ctx.setTodoPhases?.(boundPhases);
	return artifact;
}

/** Preserve checkout bindings written to the canonical transcript if a caller's tracker snapshot lags. */
function mergeCanonicalArtifactBindings(phases: TodoPhase[], canonical: readonly TodoPhase[]): TodoPhase[] {
	const rows = new Map<string, TodoItem[]>();
	for (const task of canonical.flatMap(phase => phase.tasks))
		rows.set(task.content, [...(rows.get(task.content) ?? []), task]);
	for (const task of phases.flatMap(phase => phase.tasks)) {
		const matches = rows.get(task.content);
		if (matches?.length !== 1) continue;
		const source = matches[0]!;
		if (
			JSON.stringify((task as TodoItem & { schedule?: unknown }).schedule) !==
				JSON.stringify((source as TodoItem & { schedule?: unknown }).schedule) ||
			typeof source.artifactCwd !== "string" ||
			typeof source.artifactOwner !== "string"
		)
			continue;
		task.artifactCwd = source.artifactCwd;
		task.artifactOwner = source.artifactOwner;
	}
	return phases;
}

export interface TodoCompletionSelector {
	task?: string;
	phase?: string;
	items?: string[];
}

/** Resolve the rows a todo operation will touch so gate notices match execution. */
export function getTodoActionRows(
	phases: TodoPhase[],
	entry: {
		op: string;
		task?: string;
		phase?: string;
		items?: string[];
		list?: Array<{ phase: string; items: string[] }>;
	},
): string[] {
	if (entry.op === "init") {
		const replacement = new Set([...(entry.items ?? []), ...(entry.list?.flatMap(item => item.items) ?? [])]);
		return phases.flatMap(phase => phase.tasks.map(task => task.content).filter(row => !replacement.has(row)));
	}
	if (entry.op === "append") return [...new Set(entry.items ?? [])];
	if (!["done", "drop", "rm", "start", "block", "unblock"].includes(entry.op)) return [];
	const errors: string[] = [];
	const targets =
		entry.op === "done" || entry.op === "drop"
			? getCompletionTargets(phases, entry, errors)
			: getTaskTargets(phases, { ...entry, op: entry.op as TodoOpEntryValue["op"] }, errors);
	return errors.length === 0 ? [...new Set(targets.map(task => task.content))] : [];
}

/** Select the exact rows a `done`/`drop` batch names; an empty batch is an
 *  error, not a request to close every row. */
function selectCompletionBatchTargets(
	phases: TodoPhase[],
	entry: { op?: string; task?: string; items?: string[] },
	errors: string[],
): TodoItem[] {
	if (!entry.task && (entry.items?.length ?? 0) === 0) {
		errors.push(
			`${entry.op === "drop" ? "drop" : "done"} requires a task or items target; call todo with op="done", task="<exact row>" (or op="done", items=["<row1>", ...])`,
		);
		return [];
	}
	const targets: TodoItem[] = [];
	const seen = new Set<TodoItem>();
	const addTarget = (content: string) => {
		const hit = resolveTaskOrError(phases, content, errors);
		if (hit && !seen.has(hit.task)) {
			seen.add(hit.task);
			targets.push(hit.task);
		}
	};
	if (entry.task) addTarget(entry.task);
	for (const content of entry.items ?? []) addTarget(content);
	return targets;
}

/** Resolve done targets once for native mutation and the extension safety gate. */
export function getCompletionTargets(phases: TodoPhase[], entry: TodoCompletionSelector, errors: string[]): TodoItem[] {
	if (entry.items !== undefined) {
		return selectCompletionBatchTargets(phases, { op: "done", task: entry.task, items: entry.items }, errors);
	}
	return getTaskTargets(phases, { op: "done", task: entry.task, phase: entry.phase }, errors);
}

// =============================================================================
// State helpers
// =============================================================================

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

/** Starting an archived row brings it back into its phase: the archive hides closed rows, it does not forbid reopening them. */
function restoreArchivedTask(
	phases: TodoPhase[],
	archived: TodoPhase[],
	content: string | undefined,
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) return undefined;
	for (const archivedPhase of archived) {
		const task = archivedPhase.tasks.find(t => t.content === content);
		if (!task) continue;
		let phase = findPhaseByName(phases, archivedPhase.name);
		if (!phase) {
			phase = { name: archivedPhase.name, tasks: [] };
			phases.push(phase);
		}
		const restored = cloneTask(task);
		phase.tasks.push(restored);
		return { task: restored, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	return structuredClone(task);
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => {
		const { tasks, ...metadata } = phase;
		return { ...structuredClone(metadata), tasks: tasks.map(cloneTask) };
	});
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
		}
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return transitions;
}

export function stampTaskTransitionTimes(previous: TodoPhase[], updated: TodoPhase[], now: number): void {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) previousStatuses.set(task.content, task.status);
	}
	for (const phase of updated) {
		for (const task of phase.tasks) {
			const previousStatus = previousStatuses.get(task.content);
			const enteredProgress = task.status === "in_progress" && previousStatus !== "in_progress";
			const enteredClosed =
				(task.status === "completed" || task.status === "abandoned") && previousStatus !== task.status;
			if (!enteredProgress && !enteredClosed) continue;
			const schedule: TodoSchedule = { ...task.schedule };
			if (enteredProgress) {
				schedule.startedAt ??= now;
				if (previousStatus === "completed" || previousStatus === "abandoned") delete schedule.finishedAt;
			}
			if (enteredClosed) schedule.finishedAt = now;
			task.schedule = schedule;
		}
	}
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
	// Operations may preserve legacy/multi-row in-progress state. Never rewrite
	// unrelated rows to enforce a global single-active-row invariant; only
	// promote one focus row when no row is currently in progress.
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.some(task => task.status === "in_progress")) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/** Return the active todo task, preferring an in-progress item over the first pending item. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export const TODO_HUD_STATE_CUSTOM_TYPE = "todo_hud_state";

/** Entries that can carry todo state or HUD choices; replay over only these is equivalent to the full branch. */
export function isTodoStateEntryMetadata(metadata: SessionContextEntryMetadata): boolean {
	if (metadata.type === "custom")
		return metadata.customType === USER_TODO_EDIT_CUSTOM_TYPE || metadata.customType === TODO_HUD_STATE_CUSTOM_TYPE;
	return metadata.type === "message" && metadata.messageRole === "toolResult" && metadata.toolName === "todo";
}

export type TodoHudVisibility = "dismissed" | "revealed";

export interface TodoSnapshotIdentity {
	sourceEntryId: string;
	fingerprint: string;
}

export interface TodoHudStateEntryData extends TodoSnapshotIdentity {
	visibility: TodoHudVisibility;
}

function todoPhasesFingerprint(phases: readonly TodoPhase[]): string {
	return JSON.stringify(
		phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => ({ ...task })),
		})),
	);
}

/**
 * Copy JSON-shaped todo data out of a session entry by value. Entry payloads may be proxies from a lazily
 * loading session store, which structuredClone rejects; every replayed row starts as plain data.
 */
function copyTodoData<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(item => copyTodoData(item)) as T;
	const copy: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) copy[key] = copyTodoData(child);
	return copy as T;
}

// Internal scans borrow snapshots; mutation and public read boundaries make their own detached copies.
function canonicalTodoPhases(entry: SessionEntry, copy = false): TodoPhase[] | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
		const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
		return Array.isArray(phases) ? (copy ? copyTodoData(phases as TodoPhase[]) : (phases as TodoPhase[])) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as {
		role?: string;
		toolName?: string;
		details?: { op?: unknown; phases?: unknown };
		isError?: boolean;
	};
	if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	if (message.details?.op === "view") return undefined;
	const phases = message.details?.phases;
	return Array.isArray(phases) ? (copy ? copyTodoData(phases as TodoPhase[]) : (phases as TodoPhase[])) : undefined;
}

function isTodoReworkAttempt(value: unknown): value is TodoReworkAttempt {
	if (
		!isRecord(value) ||
		typeof value.attemptId !== "string" ||
		typeof value.workerName !== "string" ||
		typeof value.resolvedModel !== "string" ||
		typeof value.effort !== "string" ||
		typeof value.startedAt !== "number" ||
		!Number.isFinite(value.startedAt) ||
		typeof value.finishedAt !== "number" ||
		!Number.isFinite(value.finishedAt) ||
		typeof value.durationMs !== "number" ||
		!Number.isFinite(value.durationMs) ||
		value.durationMs < 0 ||
		(value.terminalStatus !== "completed" &&
			value.terminalStatus !== "failed" &&
			value.terminalStatus !== "aborted") ||
		!Array.isArray(value.deliverablePaths) ||
		!value.deliverablePaths.every(path => typeof path === "string")
	)
		return false;
	return [
		"rejectionReason",
		"reflectionAnswer",
		"noAnswerReason",
		"finalReportParagraph",
		"infraFailureLine",
		"infraFailureError",
	].every(key => value[key] === undefined || typeof value[key] === "string");
}

function isTodoPersistedEdit(value: unknown): value is TodoPersistedEdit {
	if (
		!isRecord(value) ||
		value.v !== 1 ||
		typeof value.at !== "number" ||
		!Number.isFinite(value.at) ||
		typeof value.kind !== "string"
	) {
		return false;
	}
	if (value.kind === "schedule_patch")
		return (
			typeof value.task === "string" &&
			(value.adviceOnly === undefined || value.adviceOnly === true) &&
			isRecord(value.patch) &&
			(value.cleared === undefined ||
				(Array.isArray(value.cleared) && value.cleared.every(key => typeof key === "string")))
		);
	if (value.kind === "op") return typeof value.op === "string" && value.params !== undefined;
	if (value.kind === "archive") {
		return (
			Array.isArray(value.archivedPhases) &&
			value.archivedPhases.every(isTodoPhase) &&
			(value.operation === undefined || (isTodoPersistedEdit(value.operation) && value.operation.kind === "op"))
		);
	}
	if (value.kind === "attempt") {
		return typeof value.phase === "string" && typeof value.content === "string" && isTodoReworkAttempt(value.attempt);
	}
	if (value.kind !== "executor" || !isRecord(value.observation)) return false;
	const observation = value.observation;
	const outcome = observation.outcome;
	return (
		typeof observation.workerId === "string" &&
		typeof observation.startedAt === "number" &&
		Number.isFinite(observation.startedAt) &&
		(observation.finishedAt === undefined ||
			(typeof observation.finishedAt === "number" && Number.isFinite(observation.finishedAt))) &&
		(outcome === undefined || outcome === "completed" || outcome === "failed" || outcome === "aborted") &&
		(observation.runningWorkerIds === undefined ||
			(Array.isArray(observation.runningWorkerIds) &&
				observation.runningWorkerIds.every(workerId => typeof workerId === "string")))
	);
}

function compactTodoEditFromEntry(entry: SessionEntry): TodoPersistedEdit | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
		const edit = (entry.data as { edit?: unknown } | undefined)?.edit;
		return isTodoPersistedEdit(edit) ? copyTodoData(edit) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as {
		role?: string;
		toolName?: string;
		details?: { op?: unknown; edit?: unknown };
		isError?: boolean;
	};
	if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	if (message.details?.op === "view") return undefined;
	return isTodoPersistedEdit(message.details?.edit) ? copyTodoData(message.details.edit) : undefined;
}

type TodoReplayResult = { phases: TodoPhase[]; mutable: boolean };

function replayTodoEdit(
	phases: TodoPhase[] | undefined,
	edit: TodoPersistedEdit,
	options: { mutable?: boolean; archived?: TodoPhase[] } = {},
): TodoReplayResult | undefined {
	if (
		!phases &&
		!(edit.kind === "op" && edit.op === "init") &&
		!(edit.kind === "archive" && edit.operation?.op === "init")
	)
		return undefined;
	const current = phases ? (options.mutable ? phases : copyTodoData(phases)) : [];
	if (edit.kind === "op" && edit.healedSelfEdges) healStoredSelfEdges(current);
	if (edit.kind === "op" && edit.healedDanglingEdges) healStoredDanglingEdges(current, options.archived);
	if (edit.kind === "schedule_patch") {
		const updated = patchTodoSchedule(
			current,
			edit.task,
			{ ...edit.patch, ...Object.fromEntries((edit.cleared ?? []).map(key => [key, undefined])) },
			edit.at,
			{ legacyFollowUps: !edit.adviceOnly },
		);
		return updated ? { phases: updated, mutable: true } : undefined;
	}
	if (edit.kind === "executor") {
		const updated = applyTodoExecutorObservation(current, {
			...edit.observation,
			runningWorkerIds: new Set(edit.observation.runningWorkerIds ?? []),
		});
		return updated ? { phases: updated, mutable: true } : undefined;
	}
	if (edit.kind === "attempt") {
		const updated = appendTodoReworkAttempt(current, edit, edit.attempt);
		return updated ? { phases: updated, mutable: true } : undefined;
	}
	if (edit.kind === "archive") {
		let updated = current;
		if (edit.operation) {
			const replayed = replayTodoEdit(updated, edit.operation, { ...options, mutable: true });
			// The committed archive is authoritative even when an operation target is already absent.
			if (replayed) updated = replayed.phases;
		}
		const archived = new Set(
			edit.archivedPhases.flatMap(phase => phase.tasks.map(task => todoTransitionKey(phase.name, task.content))),
		);
		const live = updated.flatMap(phase => {
			const tasks = phase.tasks.filter(task => !archived.has(todoTransitionKey(phase.name, task.content)));
			return tasks.length > 0 ? [{ name: phase.name, tasks }] : [];
		});
		return { phases: live, mutable: true };
	}
	let resolved = resolveTodoParams(edit.params, current.length > 0);
	if (typeof resolved === "string") return undefined;
	if (resolved.op !== edit.op || resolved.op === "view") return undefined;
	if (resolved.op === "append" && resolved.items) {
		// Replay additions idempotently; live calls still reject duplicate rows.
		const items = resolved.items.filter(content => !findTaskByContent(current, content));
		if (items.length === 0) return { phases: current, mutable: true };
		resolved = { ...resolved, items };
	}
	if (resolved.op === "schedule") {
		const errors: string[] = [];
		const next = applyEntry(current, resolved, errors, edit.at, options.archived, { replay: true });
		if (errors.length > 0) return undefined;
		applyReviewClosures(next, edit.reviewClosures ?? [], edit.at);
		return { phases: next, mutable: true };
	}
	const applied = applyParams(current, resolved, edit.at, options.archived);
	if (applied.errors.length > 0) return undefined;
	return { phases: applied.phases, mutable: true };
}

export { isTodoSelectionEntryMetadata } from "../session/branch-selection";

interface TodoArchiveBranchSource extends BranchSource {
	readonly bodyRevision?: number;
}
interface TodoArchiveState {
	phases: TodoPhase[];
	summary?: TodoArchiveSummary;
}
const todoArchiveBranches = new WeakMap<
	object,
	TodoArchiveState & { latest: unknown; bodyRevision?: number; entries: SessionEntry[] }
>();

/** Fold archive history during resume without retaining decoded historical entries. */
export function getTodoArchiveBranchEntries(manager: TodoArchiveBranchSource | undefined): SessionEntry[] {
	if (!manager) return [];
	const latest = selectLatestBranchEntry(manager, isTodoSelectionEntryMetadata);
	const revision = latest?.id ?? latest;
	const cached = todoArchiveBranches.get(manager);
	const sameBody = cached?.bodyRevision === manager.bodyRevision;
	if (cached && sameBody && cached.latest === revision) return cached.entries;
	let extendsCached = false;
	let hasEdit = false;
	function* history(): IterableIterator<SessionEntry> {
		for (const entry of selectBranchNewestFirst(manager!, isTodoSelectionEntryMetadata)) {
			if (cached && sameBody && (entry.id ?? entry) === cached.latest) {
				extendsCached = true;
				if (hasEdit) yield* cached.entries.toReversed();
				return;
			}
			if (compactTodoEditFromEntry(entry)) hasEdit = true;
			yield entry;
		}
	}
	const { phases, summary, fromAt, toAt } = foldTodoArchiveNewestFirst(history());
	if (cached && extendsCached && !hasEdit) {
		cached.latest = revision;
		return cached.entries;
	}
	const entries = Number.isFinite(fromAt)
		? [fromAt, toAt].map((at, index): SessionEntry => ({
				type: "custom",
				id: `todo-archive-fold-${index}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { edit: { v: 1, kind: "archive", at, archivedPhases: index === 0 ? phases : [] } },
			}))
		: [];
	todoArchiveBranches.set(manager, { latest: revision, bodyRevision: manager.bodyRevision, entries, phases, summary });
	return entries;
}

/** Detached archive data for one consumer operation, without replaying folded entries. */
export function readTodoArchiveState(manager: TodoArchiveBranchSource | undefined): TodoArchiveState {
	getTodoArchiveBranchEntries(manager);
	const state = manager ? todoArchiveBranches.get(manager) : undefined;
	return {
		phases: state ? structuredClone(state.phases) : [],
		summary: state?.summary ? { ...state.summary } : undefined,
	};
}

/** Latest full live snapshot and its compact edit/HUD tail; archives use the full history reader. */
export function getLiveTodoBranchEntries(manager: BranchSource | undefined): SessionEntry[] {
	if (!manager) return [];
	const entries: SessionEntry[] = [];
	for (const entry of selectBranchNewestFirst(manager, isTodoSelectionEntryMetadata)) {
		entries.push(entry);
		if (canonicalTodoPhases(entry) !== undefined) break;
	}
	return entries.reverse();
}

export function shouldPersistTodoFullSnapshotCheckpoint(entriesNewestFirst: Iterable<SessionEntry>): boolean {
	let compactEditsSinceSnapshot = 0;
	for (const entry of entriesNewestFirst) {
		if (canonicalTodoPhases(entry)) return compactEditsSinceSnapshot >= TODO_FULL_SNAPSHOT_CHECKPOINT_INTERVAL;
		// Once the interval is reached the answer is `true` whether or not a snapshot is found, so stop reading.
		if (compactTodoEditFromEntry(entry) && ++compactEditsSinceSnapshot >= TODO_FULL_SNAPSHOT_CHECKPOINT_INTERVAL)
			return true;
	}
	return true;
}

// HUD sync asks for the identity on every subagent progress event; a full replay copies every
// todo edit on the branch (5 s of a 30 s live DC profile). The answer only changes when the
// selected todo entries change, so reuse it while the same newest entry and count are selected.
const latestTodoSnapshotIdentityCache = new WeakMap<
	SessionEntry,
	{ first: SessionEntry; length: number; identity: TodoSnapshotIdentity | undefined }
>();

/** Identify the latest durable canonical todo snapshot on the active branch. */
export function getLatestTodoSnapshotIdentity(entries: SessionEntry[]): TodoSnapshotIdentity | undefined {
	const last = entries.at(-1);
	if (!last) return undefined;
	const cached = latestTodoSnapshotIdentityCache.get(last);
	if (cached && cached.first === entries[0] && cached.length === entries.length) return cached.identity;
	const identity = computeLatestTodoSnapshotIdentity(entries);
	latestTodoSnapshotIdentityCache.set(last, { first: entries[0]!, length: entries.length, identity });
	return identity;
}

function computeLatestTodoSnapshotIdentity(entries: SessionEntry[]): TodoSnapshotIdentity | undefined {
	let latest: TodoPhase[] | undefined;
	let mutable = false;
	let sourceEntryId: string | undefined;
	const archived = getLatestTodoArchiveFromEntries(entries, { includeRestored: true });
	for (const entry of entries) {
		const phases = canonicalTodoPhases(entry);
		const edit = phases ? undefined : compactTodoEditFromEntry(entry);
		const replayed: TodoReplayResult | undefined = phases
			? { phases, mutable: false }
			: edit
				? replayTodoEdit(latest, edit, { mutable, archived })
				: undefined;
		if (!replayed) continue;
		latest = replayed.phases;
		mutable = replayed.mutable;
		sourceEntryId = entry.id;
	}
	if (!latest || !sourceEntryId) return undefined;
	return { sourceEntryId, fingerprint: todoPhasesFingerprint(latest) };
}

function matchesLatestTodoSnapshot(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
	snapshot: TodoSnapshotIdentity,
): boolean {
	const fingerprint = todoPhasesFingerprint(phases);
	return (
		fingerprint === snapshot.fingerprint ||
		fingerprint === todoPhasesFingerprint(getLatestTodoPhasesFromEntries(entries))
	);
}

/** Return the persisted HUD choice only when it targets the current canonical snapshot exactly. */
export function getTodoHudVisibility(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
): TodoHudVisibility | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || !matchesLatestTodoSnapshot(entries, phases, snapshot)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TODO_HUD_STATE_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<TodoHudStateEntryData> | undefined;
		if (
			data?.sourceEntryId === snapshot.sourceEntryId &&
			data.fingerprint === snapshot.fingerprint &&
			(data.visibility === "dismissed" || data.visibility === "revealed")
		) {
			return data.visibility;
		}
	}
	return undefined;
}

/** Build persisted HUD metadata only for phases matching the latest durable canonical snapshot. */
export function createTodoHudStateData(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
	visibility: TodoHudVisibility,
): TodoHudStateEntryData | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || !matchesLatestTodoSnapshot(entries, phases, snapshot)) return undefined;
	return { ...snapshot, visibility };
}

const todoPhasesNeedingCheckpoint = new WeakSet<TodoPhase[]>();

/** True once for phases the loader migrated; the owner persists them as one checkpoint. */
export function takeTodoMigrationCheckpoint(phases: TodoPhase[]): boolean {
	return todoPhasesNeedingCheckpoint.delete(phases);
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	// A full snapshot supersedes every earlier replay operation. Only its compact tail can change the live plan.
	let latest: TodoPhase[] | undefined;
	let snapshotIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const phases = canonicalTodoPhases(entries[index]!, false);
		if (!phases) continue;
		latest = phases;
		snapshotIndex = index;
		break;
	}
	let mutable = false;
	const archived = getLatestTodoArchiveFromEntries(entries, { includeRestored: true });
	for (let index = snapshotIndex + 1; index < entries.length; index++) {
		const edit = compactTodoEditFromEntry(entries[index]!);
		const replayed: TodoReplayResult | undefined = edit
			? replayTodoEdit(latest, edit, { mutable, archived })
			: undefined;
		if (!replayed) continue;
		latest = replayed.phases;
		mutable = replayed.mutable;
	}
	if (!latest) return [];
	const restored = copyTodoData(latest);
	const missingTimes = new Map<string, TodoItem[]>();
	for (const phase of restored) {
		for (const task of phase.tasks) {
			if (task.status !== "completed" || Number.isFinite(task.schedule?.finishedAt)) continue;
			const key = todoTransitionKey(phase.name, task.content);
			const matches = missingTimes.get(key) ?? [];
			matches.push(task);
			missingTimes.set(key, matches);
		}
	}
	// Old snapshots omitted finishedAt. Recover only timestamps still needed by the final rows, newest first.
	// A snapshot that removes/reopens a row cuts off older timestamps. Compact edits never supplied legacy
	// completionTimes; their transition timestamps are already in the replayed schedules.
	for (let index = snapshotIndex; index >= 0 && missingTimes.size > 0; index--) {
		const entry = entries[index]!;
		const phases = canonicalTodoPhases(entry, false);
		if (!phases) continue;
		const matches = new Map<string, { count: number; completed: boolean }>();
		for (const phase of phases) {
			for (const task of phase.tasks) {
				const key = todoTransitionKey(phase.name, task.content);
				if (!missingTimes.has(key)) continue;
				const match = matches.get(key) ?? { count: 0, completed: false };
				match.count++;
				match.completed ||= task.status === "completed";
				matches.set(key, match);
			}
		}
		for (const key of missingTimes.keys()) if (!matches.get(key)?.completed) missingTimes.delete(key);
		if (entry.type !== "message") continue;
		const message = entry.message as { details?: { completedTasks?: unknown } };
		if (!Array.isArray(message.details?.completedTasks)) continue;
		const timestamp = Date.parse(entry.timestamp);
		if (!Number.isFinite(timestamp)) continue;
		for (const transition of message.details.completedTasks) {
			if (!isRecord(transition) || typeof transition.phase !== "string" || typeof transition.content !== "string")
				continue;
			const key = todoTransitionKey(transition.phase, transition.content);
			const tasks = missingTimes.get(key);
			if (!tasks || matches.get(key)?.count !== 1) continue;
			for (const task of tasks) task.schedule = { ...task.schedule, finishedAt: timestamp };
			missingTimes.delete(key);
		}
	}
	// Legacy Accept snapshots predate reviewClosures. Close through the same derivation,
	// then let the owning loader persist one checkpoint rather than rewriting history.
	let migrated = false;
	const now = Date.now();
	for (const phase of restored) {
		for (const task of phase.tasks) {
			if (task.schedule?.review !== "accepted" || task.status === "completed" || task.status === "abandoned")
				continue;
			let acceptedAt: number | undefined;
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index]!;
				const edit = compactTodoEditFromEntry(entry);
				const params = edit?.kind === "op" ? resolveTodoParams(edit.params, true) : undefined;
				if (edit?.kind === "op" && params && typeof params !== "string" && params.op === "schedule") {
					const update = params.updates?.find(update => update.task === task.content);
					if (update?.review === "accepted") {
						acceptedAt = edit.at;
						break;
					}
					if (update?.review !== undefined) break;
				}
				const snapshot = canonicalTodoPhases(entry, false);
				if (!snapshot) continue;
				const row = snapshot
					.find(candidate => candidate.name === phase.name)
					?.tasks.find(row => row.content === task.content);
				if (row?.schedule?.review !== "accepted") break;
				const at = Date.parse(entry.timestamp);
				if (Number.isFinite(at)) acceptedAt = at;
			}
			applyReviewClosures(
				restored,
				[{ task: task.content, reason: task.schedule.reviewClosingBlocked }],
				acceptedAt ?? now,
			);
			migrated = true;
		}
	}
	if (migrated) todoPhasesNeedingCheckpoint.add(restored);
	return restored;
}

/** Recover archived rows from durable archive edits without changing the active live phases. */
function foldTodoArchiveNewestFirst(
	entries: Iterable<SessionEntry>,
	includeRestored = false,
): { phases: TodoPhase[]; summary?: TodoArchiveSummary; fromAt: number; toAt: number } {
	const archived = new Map<string, { order: number; tasks: Map<string, { order: number; task: TodoItem }> }>();
	const restored = new Set<string>();
	let order = 0;
	let fromAt = Infinity;
	let toAt = -Infinity;
	for (const entry of entries) {
		const edit = compactTodoEditFromEntry(entry);
		if (!edit) continue;
		const operation = edit.kind === "archive" ? edit.operation : edit.kind === "op" ? edit : undefined;
		if (edit.kind === "archive") {
			fromAt = Math.min(fromAt, edit.at);
			toAt = Math.max(toAt, edit.at);
			for (const phase of edit.archivedPhases.toReversed()) {
				let group = archived.get(phase.name);
				if (!group) {
					group = { order: -order++, tasks: new Map() };
					archived.set(phase.name, group);
				}
				group.order = -order++;
				for (const task of phase.tasks.toReversed()) {
					if (restored.has(task.content)) continue;
					const present = group.tasks.get(task.content);
					group.tasks.set(task.content, { order: -order++, task: present?.task ?? structuredClone(task) });
				}
			}
		}
		if (operation?.op === "init") break;
		if (!includeRestored && operation && isRecord(operation.params)) {
			const params = operation.params;
			const targets =
				operation.op === "schedule" && Array.isArray(params.updates)
					? params.updates.filter(isRecord).map(update => update.task)
					: [params.task, ...(Array.isArray(params.items) ? params.items : [])];
			for (const target of targets) if (typeof target === "string") restored.add(target);
		}
	}
	const phases = [...archived]
		.sort((a, b) => a[1].order - b[1].order)
		.map(([name, group]) => ({
			name,
			tasks: [...group.tasks.values()].sort((a, b) => a.order - b.order).map(value => value.task),
		}));
	const tasks = phases.flatMap(phase => phase.tasks);
	return {
		phases,
		fromAt,
		toAt,
		summary: tasks.length
			? {
					count: tasks.length,
					done: tasks.filter(task => task.status === "completed").length,
					dropped: tasks.filter(task => task.status === "abandoned").length,
					fromAt,
					toAt,
				}
			: undefined,
	};
}

/** Recover archived rows without retaining or changing live phases. */
export function getLatestTodoArchiveFromEntries(
	entries: SessionEntry[],
	options: { includeRestored?: boolean } = {},
): TodoPhase[] {
	return foldTodoArchiveNewestFirst(entries.toReversed(), options.includeRestored).phases;
}

export function getTodoArchiveSummaryFromEntries(
	entries: SessionEntry[],
	additional?: TodoArchivePersistedEdit,
): TodoArchiveSummary | undefined {
	const allEntries = additional
		? [
				...entries,
				{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { edit: additional } } as SessionEntry,
			]
		: entries;
	return foldTodoArchiveNewestFirst(allEntries.toReversed()).summary;
}

/** Archived completions remain dependency evidence, not live forecast rows. */
function withArchivedPrerequisites(phases: TodoPhase[], archived: TodoPhase[]): TodoPhase[] {
	const liveContents = new Set(phases.flatMap(phase => phase.tasks.map(task => task.content)));
	const dependencies = new Set(
		phases.flatMap(phase => phase.tasks.flatMap(task => task.schedule?.dependencies ?? [])),
	);
	const evidence = archived.flatMap(phase => {
		const tasks = phase.tasks.filter(
			task => task.status === "completed" && dependencies.has(task.content) && !liveContents.has(task.content),
		);
		return tasks.length > 0 ? [{ name: phase.name, tasks }] : [];
	});
	return evidence.length > 0 ? [...phases, ...evidence] : phases;
}

/** Complete ledger for accounting consumers; live rows override reopened archived identities. */
export function withTodoArchive(phases: TodoPhase[], archived: TodoPhase[]): TodoPhase[] {
	const liveContents = new Set(phases.flatMap(phase => phase.tasks.map(task => task.content)));
	const last = new Map(archived.flatMap(phase => phase.tasks.map(task => [task.content, task] as const)));
	return [
		...phases,
		...archived.map(phase => ({
			...phase,
			tasks: phase.tasks.filter(task => !liveContents.has(task.content) && last.get(task.content) === task),
		})),
	];
}

export function forecastTodoLivePlan(
	phases: TodoPhase[],
	archived: TodoPhase[],
	options: {
		now: number;
		capacity?: number;
		deadlineAt?: number;
		risk?: RowRiskOptions;
		history?: readonly TodoPlanPrediction[];
		calibrationStore?: TodoPlanCalibrationStore;
	},
): TodoPlanForecast {
	const liveContents = new Set(phases.flatMap(phase => phase.tasks.map(task => task.content)));
	const forecast = forecastTodoPlan(withTodoArchive(phases, archived), {
		...options,
		history: [
			...(options.calibrationStore ?? getTodoPlanCalibrationStore()).snapshot(options.now),
			...(options.history ?? []),
		],
	});
	forecast.rows = forecast.rows.filter(row => liveContents.has(row.content));
	return forecast;
}

/** Last meaningful change to each row in saved todo history. Closing alone does not invalidate QA. */
export function getTodoRowChanges(entries: readonly SessionEntry[]): Map<string, { at: string; id: string }> {
	const changes = new Map<string, { at: string; id: string }>();
	const previous = new Map<string, TodoItem>();
	for (const entry of entries) {
		const phases = canonicalTodoPhases(entry);
		if (!phases) continue;
		const current = new Map(phases.flatMap(phase => phase.tasks.map(task => [task.content, task] as const)));
		for (const [row, task] of current) {
			const old = previous.get(row);
			const comparable = task.status === "completed" && old ? { ...task, status: old.status } : task;
			if (!old || JSON.stringify(comparable) !== JSON.stringify(old))
				changes.set(row, { at: entry.timestamp, id: entry.id });
		}
		for (const [row, old] of previous) {
			if (!current.has(row) && old.status !== "completed") changes.set(row, { at: entry.timestamp, id: entry.id });
		}
		previous.clear();
		for (const [row, task] of current) previous.set(row, task);
	}
	return changes;
}

/** Observe canonical history without cloning an unused active-plan result. */
export function observeLatestTodoPhases(
	entries: SessionEntry[],
	onSnapshot: (phases: readonly TodoPhase[]) => void,
): void {
	for (const entry of entries) {
		const phases = canonicalTodoPhases(entry);
		if (phases) {
			onSnapshot(phases);
		}
		// Archive edits retain row identity and artifact bindings after the live
		// plan drops them. Observe them without making them the active snapshot.
		const data =
			entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE
				? entry.data
				: entry.type === "message" &&
					  entry.message.role === "toolResult" &&
					  entry.message.toolName === "todo" &&
					  !entry.message.isError
					? entry.message.details
					: undefined;
		const edit = isRecord(data) ? data.edit : undefined;
		if (
			isRecord(edit) &&
			edit.v === 1 &&
			edit.kind === "archive" &&
			Array.isArray(edit.archivedPhases) &&
			edit.archivedPhases.every(isTodoPhase)
		)
			onSnapshot(edit.archivedPhases);
	}
}

/** Reopen only active completed rows whose saved artifact pass failed freshness. */
export function reopenStaleRequirementRows(
	phases: readonly TodoPhase[],
	issues: readonly RequirementDoneGateIssue[],
): TodoPhase[] | undefined {
	const stale = new Set(issues.flatMap(issue => issue.stalePassRows ?? []));
	if (!phases.some(phase => phase.tasks.some(task => task.status === "completed" && stale.has(task.content))))
		return undefined;
	return phases.map(phase => ({
		...phase,
		tasks: phase.tasks.map(task =>
			task.status === "completed" && stale.has(task.content) ? { ...task, status: "pending" as const } : task,
		),
	}));
}

/** Last recorded completion survives removal; later open or abandoned states clear it. */
export function getCompletedTodoRows(entries: SessionEntry[]): Set<string> {
	const completed = new Set<string>();
	observeLatestTodoPhases(entries, phases => {
		const byRow = new Map<string, boolean>();
		for (const task of phases.flatMap(phase => phase.tasks))
			byRow.set(task.content, (byRow.get(task.content) ?? true) && task.status === "completed");
		for (const [row, done] of byRow) {
			if (done) completed.add(row);
			else completed.delete(row);
		}
	});
	return completed;
}

/** Closed history survives pruning; reopening removes the exemption. */
export function getClosedTodoRows(entries: SessionEntry[]): Set<string> {
	const closed = new Set<string>();
	observeLatestTodoPhases(entries, phases => {
		const byRow = new Map<string, boolean>();
		for (const task of phases.flatMap(phase => phase.tasks))
			byRow.set(
				task.content,
				(byRow.get(task.content) ?? true) && (task.status === "completed" || task.status === "abandoned"),
			);
		for (const [row, done] of byRow) {
			if (done) closed.add(row);
			else closed.delete(row);
		}
	});
	return closed;
}

/** Owner acceptance survives plan pruning; a later explicit review replaces it. */
export function getAcceptedTodoRows(entries: SessionEntry[]): Set<string> {
	const accepted = new Set<string>();
	observeLatestTodoPhases(entries, phases => {
		for (const task of phases.flatMap(phase => phase.tasks)) {
			const schedule = "schedule" in task && isRecord(task.schedule) ? task.schedule : undefined;
			const review = schedule?.review;
			if (review === "accepted") accepted.add(task.content);
			else if (review !== undefined) accepted.delete(task.content);
		}
	});
	return accepted;
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

/** `done`/`drop` accept a batch of exact task contents in `items`, so closing or pruning many
 *  rows is one call instead of one round trip per row. */
function getBatchTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	// Closing or dropping never falls back to "every row": an empty batch or a call with no target
	// is a mistake, not a request to finish the whole plan.
	if (entry.items && entry.items.length === 0 && !entry.task) {
		errors.push("items is empty; name the rows to close or drop");
		return [];
	}
	if (!entry.items && !entry.task && !entry.phase) {
		errors.push("done/drop needs a task, a phase, or items");
		return [];
	}
	if (!entry.items || entry.items.length === 0) return getTaskTargets(phases, entry, errors);
	const names = entry.task ? [entry.task, ...entry.items] : entry.items;
	const hits = names.map(name => resolveTaskOrError(phases, name, errors)?.task);
	return [...new Set(hits.filter((task): task is TodoItem => task !== undefined))];
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	// #41: `done`/`drop` select exact batch rows from `items`; all other
	// targeting keeps base selection.
	if ((entry.op === "done" || entry.op === "drop") && entry.items !== undefined) {
		return selectCompletionBatchTargets(phases, entry, errors);
	}
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

/** Enforce structural limits only; the prompt guides external-gate semantics. */
function validateBlockReason(reason: string | undefined): string | undefined {
	const normalized = reason?.replace(/\s+/g, " ").trim();
	if (!normalized || normalized.length > 160) return undefined;
	return normalized;
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	// (optionally with a bare `phase`) instead of the canonical
	// `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
	// so a common, recoverable mistake isn't a hard error. Models also fill unused
	// params with `[]`, so an empty `list` must not shadow non-empty `items`.
	const flat = entry.items && entry.items.length > 0 ? [{ phase: entry.phase, items: entry.items }] : undefined;
	const list = entry.list?.length ? entry.list : (flat ?? entry.list);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// An empty phase name cannot be explicitly targeted, so it gets the default.
	// Duplicate phase names / task contents would be permanently unaddressable
	// too (every targeting op resolves the first match), so reject them up front.
	const phases: TodoPhase[] = [];
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		const name = listEntry.phase || DEFAULT_INIT_PHASE;
		if (seenPhases.has(name)) {
			errors.push(`Duplicate phase "${name}" in init list`);
		}
		seenPhases.add(name);
		const tasks: TodoItem[] = [];
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
			const task: TodoItem = { content, status: "pending" };
			bindArtifactCwd(task);
			tasks.push(task);
		}
		phases.push({ name, tasks });
	}
	return phases;
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.phase === "") {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	// Validate the whole batch before mutating so a failing op reports every
	// duplicate and leaves nothing half-applied.
	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	const active = entry.phase === undefined ? nextActionableTask(phases) : undefined;
	const name =
		entry.phase ??
		(active ? phases.find(phase => phase.tasks.includes(active))?.name : phases.at(-1)?.name) ??
		DEFAULT_INIT_PHASE;
	let phase = findPhaseByName(phases, name);
	if (!phase) {
		phase = { name, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		const task: TodoItem = { content, status: "pending" };
		bindArtifactCwd(task);
		phase.tasks.push(task);
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	const pruneDependencies = (removed: Set<string>) => {
		if (removed.size === 0) return;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				const deps = task.schedule?.dependencies;
				if (Array.isArray(deps)) task.schedule!.dependencies = deps.filter(dep => !removed.has(dep));
			}
		}
	};
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		pruneDependencies(new Set([hit.task.content]));
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		const removed = new Set(phase.tasks.map(task => task.content));
		phase.tasks = [];
		pruneDependencies(removed);
		return phases;
	}
	const removed = new Set(phases.flatMap(phase => phase.tasks.map(task => task.content)));
	for (const phase of phases) {
		phase.tasks = [];
	}
	pruneDependencies(removed);
	return phases;
}

function indexTasksByContent(phases: TodoPhase[]): Map<string, TodoItem[]> {
	const indexed = new Map<string, TodoItem[]>();
	for (const phase of phases) {
		for (const task of phase.tasks) {
			const matches = indexed.get(task.content);
			if (matches) matches.push(task);
			else indexed.set(task.content, [task]);
		}
	}
	return indexed;
}

/** Repair legacy self-edges before taking the next durable snapshot. */
function healStoredSelfEdges(phases: TodoPhase[]): string[] {
	const healed: string[] = [];
	for (const row of phases.flatMap(phase => phase.tasks)) {
		const schedule = row.schedule;
		if (!schedule) continue;
		const selfDependency = schedule.dependencies?.includes(row.content);
		const selfSpeculation = schedule.speculativeOn === row.content;
		if (!selfDependency && !selfSpeculation) continue;
		if (selfDependency) schedule.dependencies = schedule.dependencies!.filter(dep => dep !== row.content);
		if (selfSpeculation) delete schedule.speculativeOn;
		healed.push(row.content);
	}
	return healed;
}

/** Repair persisted edges without forgiving invalid edges submitted by this operation. */
function healStoredDanglingEdges(phases: TodoPhase[], archived: TodoPhase[] = []): string[] {
	const targets = new Map(
		[...archived, ...phases].flatMap(phase => phase.tasks.map(row => [row.content, row] as const)),
	);
	const removed: string[] = [];
	for (const row of phases.flatMap(phase => phase.tasks)) {
		const schedule = row.schedule;
		if (!schedule) continue;
		const dangling = (target: string): boolean => !targets.has(target) || targets.get(target)?.status === "abandoned";
		for (const target of schedule.dependencies ?? []) {
			if (dangling(target)) removed.push(`${JSON.stringify(row.content)} dependencies → ${JSON.stringify(target)}`);
		}
		if (schedule.dependencies) schedule.dependencies = schedule.dependencies.filter(target => !dangling(target));
		if (schedule.speculativeOn && dangling(schedule.speculativeOn)) {
			removed.push(`${JSON.stringify(row.content)} speculativeOn → ${JSON.stringify(schedule.speculativeOn)}`);
			delete schedule.speculativeOn;
		}
	}
	return removed;
}

/** Reuse the shared graph validator; unknown prerequisites remain forecast issues. */
function validateScheduleDependencyGraph(
	phases: TodoPhase[],
	scheduleOverrides: Map<TodoItem, TodoSchedule>,
	renamedTasks: Map<TodoItem, string>,
	errors: string[],
	archived: TodoPhase[],
	checkOwners = true,
): void {
	const candidatePhases = phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => {
			const schedule = scheduleOverrides.get(task) ?? task.schedule;
			return {
				content: renamedTasks.get(task) ?? task.content,
				status: task.status,
				...(task.blocker === undefined ? {} : { blocker: task.blocker }),
				...(schedule === undefined ? {} : { schedule }),
			};
		}),
	}));
	for (const issue of getTodoPlanningIssues(candidatePhases)) {
		if (checkOwners && issue.code === "owner-overlap") errors.push(issue.message);
	}
	const edges = (schedule: TodoSchedule | undefined): string[] => [
		...(schedule?.dependencies ?? []),
		...(schedule?.speculativeOn ? [schedule.speculativeOn] : []),
	];
	const graph = new Map(
		candidatePhases.flatMap(phase => phase.tasks.map(row => [row.content, edges(row.schedule)] as const)),
	);
	const previousNames = new Map(
		phases.flatMap(phase => phase.tasks.map(row => [row.content, renamedTasks.get(row) ?? row.content] as const)),
	);
	// Only a newly added edge can introduce a cycle. Check against the whole candidate
	// graph so two rows added in the same operation cannot bypass validation.
	for (const row of phases.flatMap(phase => phase.tasks)) {
		const name = renamedTasks.get(row) ?? row.content;
		// Compare resolved row identities across renames. An unresolved old title that
		// becomes a row in this operation is a new edge and still needs validation.
		const previous = new Set(
			edges(row.schedule).flatMap(dep => {
				const target = previousNames.get(dep);
				return target === undefined ? [] : [target];
			}),
		);
		for (const dependency of graph.get(name) ?? []) {
			if (previous.has(dependency)) continue;
			const target = [...candidatePhases, ...archived]
				.flatMap(phase => phase.tasks)
				.find(row => row.content === dependency);
			if (!target || target.status === "abandoned") {
				const schedule = scheduleOverrides.get(row) ?? row.schedule;
				const field = schedule?.speculativeOn === dependency ? "speculativeOn" : "dependencies";
				const clear = field === "speculativeOn" ? { speculativeOn: null } : { dependencies: [] };
				errors.push(
					`Invalid ${field} target ${JSON.stringify(dependency)} for task ${JSON.stringify(name)}: target is missing or dropped. Clear with ${JSON.stringify({ op: "schedule", updates: [{ task: name, ...clear }] })}`,
				);
				continue;
			}
			const pending = [dependency];
			const visited = new Set<string>();
			while (pending.length) {
				const current = pending.pop()!;
				if (current === name) {
					errors.push(
						dependency === name
							? `Task cannot depend on itself: ${name}`
							: `Task introduces a dependency cycle: ${name}`,
					);
					break;
				}
				if (visited.has(current)) continue;
				visited.add(current);
				pending.push(...(graph.get(current) ?? []));
			}
		}
	}
	for (const issue of validateTodoDependencies(withArchivedPrerequisites(candidatePhases, archived))) {
		if (
			issue.code === "missing-dependency" ||
			issue.code === "self-dependency" ||
			issue.code === "dependency-cycle" ||
			issue.code === "dependencies-unknown" ||
			issue.code === "unresolved-prerequisite" ||
			issue.code === "abandoned-dependency" ||
			issue.code === "completed-dependency-history-unknown"
		)
			continue;
		errors.push(issue.message);
	}
}

interface AcceptedEstimateFields {
	optimisticSeconds: number;
	likelySeconds: number;
	pessimisticSeconds: number;
	confidence: TodoConfidence;
}

function isSameAcceptedEstimate(
	left: TodoSchedule["estimate"],
	right: AcceptedEstimateFields,
): left is NonNullable<TodoSchedule["estimate"]> {
	return (
		left !== undefined &&
		left.optimisticSeconds === right.optimisticSeconds &&
		left.likelySeconds === right.likelySeconds &&
		left.pessimisticSeconds === right.pessimisticSeconds
	);
}

/** Rows in one schedule call that may share an O/L/P triple before the call is refused. */
const IDENTICAL_ESTIMATE_LIMIT = 2;

/**
 * An identical triple on three or more rows of one call is a pasted default, not an estimate: it
 * carries no per-row information and makes every forecast and every displayed duration the same
 * number (2026-10-21: seven rows were all passed 1200/2400/3600 s and all showed "40m"; the month's
 * actual/mean ratio was 0.2-0.3 for most models). The todo schema has no notion of a declared batch
 * shard, so such rows are refused. Replay of recorded history is exempt: a session stays loadable.
 */
function identicalEstimateErrors(changed: ReadonlyArray<{ task: string; estimate: AcceptedEstimateFields }>): string[] {
	const groups = new Map<string, string[]>();
	for (const { task, estimate } of changed) {
		const key = `${estimate.optimisticSeconds}/${estimate.likelySeconds}/${estimate.pessimisticSeconds}`;
		groups.set(key, [...(groups.get(key) ?? []), task]);
	}
	const errors: string[] = [];
	for (const [key, tasks] of groups) {
		if (tasks.length <= IDENTICAL_ESTIMATE_LIMIT) continue;
		const firstTask = tasks[0]!.replace(/\s+/g, " ").slice(0, 24);
		errors.push(
			`Re-estimate "${firstTask}" individually${tasks.length > 1 ? ` (+${tasks.length - 1} more rows)` : ""}, only the skipped estimates were not applied.\n${tasks.length} rows in this schedule call share the same optimistic/likely/pessimistic estimate ${key} s (${tasks.map(task => `"${task}"`).join(", ")}). An identical triple is a copied default; estimate each row separately from its own scope, history and risk.`,
		);
	}
	return errors;
}

function applyScheduleUpdates(
	phases: TodoPhase[],
	entry: TodoOpEntryValue,
	errors: string[],
	now: number,
	archived: TodoPhase[],
	options: { replay?: boolean } = {},
): TodoPhase[] {
	const updates = entry.updates;
	if (!updates || updates.length === 0) {
		if (entry.previewReason) return phases;
		errors.push("schedule requires a non-empty updates array or previewReason");
		return phases;
	}

	const initialErrorCount = errors.length;
	const tasksByContent = indexTasksByContent(phases);
	const seenUpdates = new Set<string>();
	const candidates = new Map<TodoItem, TodoSchedule>();
	const renamedTasks = new Map<TodoItem, string>();
	const renamedContent = new Map<string, string>();
	const renamedTitles = new Set<string>();
	const changedEstimates: Array<{ task: string; estimate: AcceptedEstimateFields }> = [];
	for (const update of updates) {
		if (seenUpdates.has(update.task)) {
			errors.push(`Duplicate schedule update for task "${update.task}"`);
			continue;
		}
		seenUpdates.add(update.task);
		if (!options.replay && update.review === "redo" && !update.evidence?.trim())
			errors.push(`Redo for task "${update.task}" requires the user's correction in evidence`);

		const targets = tasksByContent.get(update.task);
		if (!targets) {
			errors.push(`Task "${update.task}" not found; schedule tasks by exact content`);
			continue;
		}
		if (targets.length !== 1) {
			errors.push(`Task content "${update.task}" is not unique; schedule requires exact unique identity`);
			continue;
		}
		const task = targets[0]!;
		if (update.content !== undefined) {
			if (!update.content.trim()) {
				errors.push(`New content for task "${update.task}" must be nonblank`);
			} else if (update.content !== task.content) {
				const collision = renamedTitles.has(update.content) || tasksByContent.has(update.content);
				if (collision) {
					errors.push(
						`Cannot rename task "${update.task}" to "${update.content}": another row already has that content`,
					);
				} else {
					renamedTasks.set(task, update.content);
					renamedContent.set(task.content, update.content);
					renamedTitles.add(update.content);
				}
			}
		}
		if (update.owner !== undefined && update.owner !== "" && update.owner.trim() === "") {
			errors.push(`Owner for task "${update.task}" must be nonblank or the empty string to clear it`);
		}
		if (update.resources) {
			const seenResources = new Set<string>();
			for (const resource of update.resources) {
				const normalized = resource.trim();
				if (!normalized) errors.push(`Resources for task "${update.task}" must be nonblank identifiers`);
				if (seenResources.has(normalized)) errors.push(`Task "${update.task}" repeats resource "${resource}"`);
				seenResources.add(normalized);
			}
		}
		if (update.estimate) {
			const { optimisticSeconds, likelySeconds, pessimisticSeconds, basis } = update.estimate;
			if (
				![optimisticSeconds, likelySeconds, pessimisticSeconds].every(Number.isFinite) ||
				optimisticSeconds < 0 ||
				optimisticSeconds > likelySeconds ||
				likelySeconds > pessimisticSeconds
			) {
				errors.push(
					`Estimate for task "${update.task}" must be finite, nonnegative, and ordered optimistic ≤ likely ≤ pessimistic`,
				);
			}
			if (!basis.trim()) errors.push(`Estimate basis for task "${update.task}" must be nonblank`);
		}

		const schedule: TodoSchedule = structuredClone(
			task.schedule && typeof task.schedule === "object" ? task.schedule : {},
		);
		if (update.materialInputs !== undefined) {
			const inputs = update.materialInputs;
			if (![inputs.criterion, ...inputs.receipts, ...inputs.prerequisites].every(value => value.trim().length > 0))
				errors.push(`Material inputs for task "${update.task}" require nonblank immutable identities`);
			schedule.materialInputs = structuredClone(inputs);
		}
		if (update.dependencies !== undefined) schedule.dependencies = [...update.dependencies];
		schedule.cumulativeReestimateCount ??= schedule.reestimateCount ?? 0;
		const ownerChanged = update.owner !== undefined && (update.owner.trim() || undefined) !== schedule.owner;
		if (update.owner !== undefined) {
			if (update.owner === "") delete schedule.owner;
			else schedule.owner = update.owner.trim();
		}
		if (ownerChanged) schedule.reestimateCount = 0;

		if (update.agentProfile !== undefined) schedule.agentProfile = update.agentProfile.trim() || undefined;
		if (update.readOnly !== undefined) schedule.readOnly = update.readOnly;
		if (update.resources !== undefined) schedule.resources = update.resources.map(resource => resource.trim());
		if (update.estimate) {
			const estimate = { ...update.estimate, basis: update.estimate.basis.trim() };
			const previousEstimate = schedule.estimate;
			schedule.firstEstimate ??= previousEstimate ? { ...previousEstimate } : { ...estimate, updatedAt: now };
			if (isSameAcceptedEstimate(previousEstimate, estimate)) {
				schedule.estimate = { ...estimate, updatedAt: previousEstimate.updatedAt };
			} else {
				changedEstimates.push({ task: update.task, estimate });
				schedule.reestimateCount = (schedule.reestimateCount ?? 0) + (previousEstimate && !ownerChanged ? 1 : 0);
				schedule.cumulativeReestimateCount += previousEstimate ? 1 : 0;
				schedule.estimateRevision = (schedule.estimateRevision ?? (previousEstimate ? 1 : 0)) + 1;
				schedule.estimate = { ...estimate, updatedAt: now };
			}
		}
		retainTodoDependencyReviews(schedule);
		if (update.evidence?.trim()) schedule.progress = { at: now, evidence: update.evidence.trim() };
		retainTodoDependencyReviews(schedule);
		if (update.decision !== undefined) schedule.decision = update.decision;
		if (update.reviewCard === null) delete schedule.reviewCard;
		else if (update.reviewCard !== undefined) schedule.reviewCard = update.reviewCard.trim();
		if (update.reviewPage === null) delete schedule.reviewPage;
		else if (update.reviewPage !== undefined) schedule.reviewPage = update.reviewPage.trim();
		if (update.review === null) delete schedule.review;
		else if (update.review !== undefined) schedule.review = update.review;
		if (update.postDeadline !== undefined) schedule.postDeadline = update.postDeadline;
		if (update.speculativeOn === null || update.speculativeOn?.trim() === "") delete schedule.speculativeOn;
		else if (update.speculativeOn !== undefined) schedule.speculativeOn = update.speculativeOn.trim();
		candidates.set(task, schedule);
	}

	if (!options.replay) errors.push(...identicalEstimateErrors(changedEstimates));
	if (errors.length > initialErrorCount) return phases;
	if (renamedContent.size > 0) {
		for (const phase of phases) {
			for (const task of phase.tasks) {
				const schedule = candidates.get(task) ?? task.schedule;
				if (!schedule?.dependencies) continue;
				const previousDependencies = schedule.dependencies;
				const dependencies = previousDependencies.map(dependency => renamedContent.get(dependency) ?? dependency);
				if (dependencies.some((dependency, index) => dependency !== previousDependencies[index]))
					candidates.set(task, { ...structuredClone(schedule), dependencies });
			}
		}
	}
	if (!options.replay) {
		const rows = phases.flatMap(phase => phase.tasks);
		const deferred = new Set(
			rows
				.filter(row => (candidates.get(row) ?? row.schedule)?.postDeadline)
				.map(row => renamedTasks.get(row) ?? row.content),
		);
		for (const row of rows) {
			const schedule = candidates.get(row) ?? row.schedule;
			if (schedule?.postDeadline || row.status === "completed" || row.status === "abandoned") continue;
			for (const dependency of schedule?.dependencies ?? []) {
				if (deferred.has(dependency))
					errors.push(
						`Task "${row.content}" still requires after-deadline task "${dependency}"; keep the prerequisite in scope or record a safe dependency re-plan`,
					);
			}
		}
	}
	validateScheduleDependencyGraph(phases, candidates, renamedTasks, errors, archived, !options.replay);
	if (errors.length > initialErrorCount) return phases;
	for (const [task, schedule] of candidates) {
		const previous = { ...task, schedule: task.schedule };
		task.schedule = schedule;
		reconcileAuditResourceChange(previous, task);
	}
	for (const [task, content] of renamedTasks) task.content = content;
	for (const update of updates) {
		const row = findTaskByContent(phases, update.content ?? update.task)?.task;
		if (!row || (update.review !== "redo" && update.review !== "drop")) continue;
		delete row.blocker;
		delete row.schedule!.reviewClosingBlocked;
		if (update.review === "drop") {
			applyEntry(phases, { op: "drop", task: row.content }, errors, now, archived);
			row.schedule!.finishedAt = now;
		} else {
			row.status = "in_progress";
			delete row.schedule!.auditEscalation;
			row.schedule!.auditRounds = 0;
			row.schedule!.handoffPending = false;
			delete row.schedule!.finishedAt;
			delete row.schedule!.executor;
			row.schedule!.startedAt ??= now;
		}
	}
	return phases;
}

function applyReviewClosures(
	phases: TodoPhase[],
	closures: Array<{ task: string; reason?: string }>,
	now: number,
): void {
	for (const closure of closures) {
		const row = findTaskByContent(phases, closure.task)?.task;
		if (!row || row.schedule?.review !== "accepted") continue;
		// The user's Accept on the delivered result is the acceptance: an internal
		// completion gate (for example a requirement re-audit whose auditor is out of
		// budget) never keeps the row open, blocked or red. Its reason stays on the row
		// as a background follow-up; a real defect it finds later becomes a new row.
		delete row.schedule.reviewClosingBlocked;
		if (closure.reason) row.schedule.acceptedAuditFollowUp = closure.reason;
		else delete row.schedule.acceptedAuditFollowUp;
		delete row.blocker;
		row.status = "completed";
		row.schedule.finishedAt ??= now;
	}
}

function applyEntry(
	phases: TodoPhase[],
	entry: TodoOpEntryValue,
	errors: string[],
	now = Date.now(),
	archived: TodoPhase[] = [],
	options: { replay?: boolean } = {},
): TodoPhase[] {
	const next = applyEntryOperation(phases, entry, errors, now, archived, options);
	if (entry.op !== "init") return next;
	// Reorganizing a plan does not create a new delivery or revoke its custody
	// history. Keep the complete state of an unambiguously retained row.
	const retained = new Map<string, TodoItem[]>();
	for (const task of phases.flatMap(phase => phase.tasks))
		retained.set(task.content, [...(retained.get(task.content) ?? []), task]);
	for (const phase of next) {
		phase.tasks = phase.tasks.map(task => {
			const matches = retained.get(task.content);
			return matches?.length === 1 ? structuredClone(matches[0]!) : task;
		});
	}
	return next;
}

function applyEntryOperation(
	phases: TodoPhase[],
	entry: TodoOpEntryValue,
	errors: string[],
	now = Date.now(),
	archived: TodoPhase[] = [],
	options: { replay?: boolean } = {},
): TodoPhase[] {
	if (entry.op === "schedule" || entry.op === "done" || entry.op === "drop" || entry.op === "start") {
		const targets =
			entry.op === "schedule"
				? (entry.updates ?? []).map(update => update.task)
				: [entry.task, ...(entry.items ?? [])];
		for (const target of targets) {
			if (target && !findTaskByContent(phases, target)) restoreArchivedTask(phases, archived, target);
		}
	}
	switch (entry.op) {
		case "init":
			return preserveTodoMetadata(phases, initPhases(entry, errors), true);
		case "start": {
			const hit =
				findTaskByContent(phases, entry.task ?? "") ??
				restoreArchivedTask(phases, archived, entry.task) ??
				resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			const planningIssues = getTodoPlanningIssues(phases);
			if (planningIssues.length > 0) {
				errors.push(
					`Cannot start work while plan repairs remain: ${planningIssues.map(issue => issue.message).join("; ")}`,
				);
				return phases;
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getBatchTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			const dropped = getBatchTargets(phases, entry, errors);
			for (const task of dropped) {
				task.status = "abandoned";
				if (entry.reason?.startsWith("superseded:")) task.notes = [...(task.notes ?? []), entry.reason];
			}
			if (errors.length === 0 && dropped.length > 0) {
				const droppedTitles = new Set(dropped.map(task => task.content));
				for (const phase of phases) {
					for (const task of phase.tasks) {
						if (droppedTitles.has(task.content)) continue;
						const deps = task.schedule?.dependencies;
						if (Array.isArray(deps)) task.schedule!.dependencies = deps.filter(dep => !droppedTitles.has(dep));
						if (task.schedule?.speculativeOn && droppedTitles.has(task.schedule.speculativeOn))
							delete task.schedule.speculativeOn;
					}
				}
			}
			return phases;
		}
		case "block": {
			if (!prepareAwaitingUserCheck(phases, entry, errors)) return phases;
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// A blocker is not a status-only escape hatch. Validate before resolving
			// or mutating any task so task, phase, and re-block requests are atomic.
			const reason = validateBlockReason(entry.reason);
			if (!reason) {
				errors.push("block requires a nonblank reason of at most 160 characters after whitespace normalization");
				return phases;
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				// Only actionable open work can be blocked: blocking a phase must not
				// reopen completed/abandoned tasks or erase finished progress. Existing
				// blocked tasks stay eligible only when a replacement reason is supplied.
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				task.status = "blocked";
				task.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
			if (!prepareAwaitingUserCheck(phases, entry, errors)) return phases;
			if (!entry.task && !entry.phase) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
				}
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
		case "schedule":
			return applyScheduleUpdates(phases, entry, errors, now, archived, options);
		case "view":
			return phases;
	}
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append` (lazily creates the phase, so the result
 *   matches a single-phase init when nothing exists yet)
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
function inferTodoOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (typeof args.phase === "string" && args.phase) return "append";
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. The tool sets
 * `lenientArgValidation`, so the agent loop hands `execute()` the raw
 * arguments when schema validation fails; the only failure repaired here is
 * a missing `op` alongside an unambiguous payload (models routinely send
 * `{list:[...]}` with no op). Anything else returns the schema error text
 * for a normal model retry.
 */
function resolveTodoParams(raw: unknown, hasExistingPhases: boolean): TodoOpEntryValue | string {
	// Tool arguments cannot establish user authority over the goal deadline.
	if (isRecord(raw)) {
		const updates = Array.isArray(raw.updates) ? raw.updates : [];
		const deadlineKeys = ["deadlineAt", "due", "dueAt", "deadlineRenegotiation"];
		if ([raw, ...updates].some(value => isRecord(value) && deadlineKeys.some(key => key in value)))
			return "The deadline belongs to the user. Todo operations cannot change the due time. Re-plan the work to fit the existing deadline.";
	}
	const direct = todoSchema(raw);
	if (!(direct instanceof type.errors)) return direct;
	if (isRecord(raw) && raw.op === undefined) {
		const inferred = inferTodoOp(raw, hasExistingPhases);
		if (inferred) {
			const repaired = todoSchema({ ...raw, op: inferred });
			if (!(repaired instanceof type.errors)) return repaired;
		}
	}
	return `Invalid todo arguments: ${direct.summary}`;
}

function applyParams(
	phases: TodoPhase[],
	params: TodoOpEntryValue,
	now = Date.now(),
	archived: TodoPhase[] = [],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const previous = clonePhases(phases);
	const next = applyEntry(phases, params, errors, now, archived);
	// A schedule rename keeps status, owner and history attached: it is not a
	// status transition, so content-keyed transition stamping must not see it.
	if (params.op !== "schedule") {
		normalizeInProgressTask(next);
		stampTaskTransitionTimes(previous, next, now);
	}
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpEntryValue[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = clonePhases(currentPhases);
	const now = Date.now();
	for (const op of ops) {
		const previous = clonePhases(next);
		next = applyEntry(next, op, errors, now);
		if (op.op !== "schedule" && op.op !== "view") {
			normalizeInProgressTask(next);
			stampTaskTransitionTimes(previous, next, now);
		}
	}
	return { phases: next, errors };
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
	blocked: "!",
};

export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = normalizePathLikeInput(input) || "TODO.md";
	return resolveToCwd(raw, cwd);
}

interface TodoMarkdownMetadata {
	blocker?: string;
	details?: string;
	notes?: string[];
	schedule?: TodoSchedule;
}

const TODO_METADATA_COMMENT = /\s+<!--\s*omp-todo:v1:([A-Za-z0-9_-]+)\s*-->$/;

function encodeTodoMetadata(task: TodoItem): string {
	const metadata: TodoMarkdownMetadata = {
		...(task.status === "blocked" && task.blocker !== undefined ? { blocker: task.blocker } : {}),
		...(task.details !== undefined ? { details: task.details } : {}),
		...(task.notes !== undefined ? { notes: [...task.notes] } : {}),
		...(task.schedule !== undefined ? { schedule: task.schedule } : {}),
	};
	if (Object.keys(metadata).length === 0) return "";
	const encoded = Buffer.from(JSON.stringify(metadata)).toString("base64url");
	return ` <!-- omp-todo:v1:${encoded} -->`;
}

function decodeTodoMetadata(encoded: string): TodoMarkdownMetadata {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		throw new Error("invalid todo metadata encoding");
	}
	if (!isRecord(value)) throw new Error("todo metadata must be an object");
	if (value.blocker !== undefined && typeof value.blocker !== "string") throw new Error("invalid blocker metadata");
	if (value.details !== undefined && typeof value.details !== "string") throw new Error("invalid details metadata");
	if (
		value.notes !== undefined &&
		(!Array.isArray(value.notes) || !value.notes.every(note => typeof note === "string"))
	) {
		throw new Error("invalid notes metadata");
	}
	if (value.schedule !== undefined && !isRecord(value.schedule)) throw new Error("invalid schedule metadata");
	return {
		...(typeof value.blocker === "string" ? { blocker: value.blocker } : {}),
		...(typeof value.details === "string" ? { details: value.details } : {}),
		...(Array.isArray(value.notes) ? { notes: [...value.notes] } : {}),
		...(isRecord(value.schedule) ? { schedule: structuredClone(value.schedule) as TodoSchedule } : {}),
	};
}

/**
 * Human view of the plan for `/todo`: open rows with status, owner, ETA and criticality, closed rows
 * counted per phase. `all` lists closed rows too. No round-trip metadata: that belongs to
 * `/todo edit`/`export` only.
 */
export function formatTodoView(
	phases: TodoPhase[],
	options: { now?: number; capacity?: number; all?: boolean; archive?: boolean; archivedPhases?: TodoPhase[] } = {},
): string {
	const now = options.now ?? Date.now();
	const forecast = forecastTodoLivePlan(phases, options.archivedPhases ?? [], {
		now,
		...(options.capacity === undefined ? {} : { capacity: options.capacity }),
	});
	const rows = new Map(forecast.rows.map(row => [row.content, row]));
	const lines = [formatPlanForecastDisplay(forecast, now)];
	const archivedTasks = (options.archivedPhases ?? []).flatMap(phase => phase.tasks);
	if (archivedTasks.length)
		lines.push(
			formatTodoArchiveSummary({
				count: archivedTasks.length,
				done: archivedTasks.filter(task => task.status === "completed").length,
				dropped: archivedTasks.filter(task => task.status === "abandoned").length,
				fromAt: now,
				toAt: now,
			}),
		);
	let hidden = 0;
	const finished: string[] = [];
	for (const phase of phases) {
		const closed = phase.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
		if (closed === phase.tasks.length && !options.all) {
			finished.push(`${phase.name} (${closed})`);
			hidden += closed;
			continue;
		}
		lines.push("", `${phase.name} · ${closed}/${phase.tasks.length} closed`);
		for (const task of phase.tasks) {
			const terminal = task.status === "completed" || task.status === "abandoned";
			if (terminal && !options.all) {
				hidden += 1;
				continue;
			}
			const row = rows.get(task.content);
			const owner = task.schedule?.owner;
			const parts = [
				formatOpenTaskState(task, row ? formatTaskForecastDisplay(row, now) : task.status),
				...(owner && !terminal && !["main", "root"].includes(owner.toLowerCase()) ? [`owner ${owner}`] : []),
			];
			lines.push(`  ${TODO_VIEW_MARK[task.status]} ${task.content} · ${parts.join(" · ")}`);
		}
	}
	if (finished.length > 0) lines.push("", `Closed phases: ${finished.join(", ")}`);
	if (hidden > 0) lines.push("", `${hidden} closed row(s) hidden; /todo all lists them.`);
	if (options.archive) {
		const archive = options.archivedPhases ?? [];
		const archiveCount = archive.reduce((sum, phase) => sum + phase.tasks.length, 0);
		lines.push("", `Archived rows (${archiveCount}):`);
		for (const phase of archive) {
			lines.push(`  ${phase.name}`);
			for (const task of phase.tasks) {
				const schedule = task.schedule;
				const actualSeconds =
					Number.isFinite(schedule?.startedAt) && Number.isFinite(schedule?.finishedAt)
						? Math.max(0, Math.round((schedule!.finishedAt! - schedule!.startedAt!) / 1000))
						: undefined;
				const evidence = [
					...(schedule?.owner ? [`owner ${schedule.owner}`] : []),
					...(schedule?.estimate ? [`estimate ${schedule.estimate.likelySeconds}s`] : []),
					...(actualSeconds !== undefined ? [`actual ${actualSeconds}s`] : []),
					...(schedule?.executor
						? [
								`executor ${schedule.executor.workerId}${schedule.executor.outcome ? ` (${schedule.executor.outcome})` : ""}`,
							]
						: []),
					...(Number.isFinite(schedule?.finishedAt)
						? [`finished ${new Date(schedule!.finishedAt!).toISOString()}`]
						: []),
				];
				lines.push(
					`    ${TODO_VIEW_MARK[task.status]} ${task.content}${evidence.length ? ` · ${evidence.join(" · ")}` : ""}`,
				);
			}
		}
	}
	return lines.join("\n");
}

const TODO_VIEW_MARK: Record<TodoStatus, string> = {
	pending: "☐",
	in_progress: "◐",
	completed: "☑",
	abandoned: "✗",
	blocked: "⊘",
};

function hasExecutorResult(task: TodoItem): boolean {
	return (
		task.status !== "completed" && task.status !== "abandoned" && task.schedule?.executor?.finishedAt !== undefined
	);
}

function formatOpenTaskState(task: TodoItem, forecast: string): string {
	if (task.schedule?.review === "accepted" && task.status !== "completed" && task.status !== "abandoned")
		return `accepted by user, closing${task.schedule.reviewClosingBlocked ? ` blocked: ${task.schedule.reviewClosingBlocked}` : ""}`;
	return hasExecutorResult(task) ? "result arrived: review" : forecast;
}

/**
 * Render todo phases as a Markdown checklist. `metadata` (default on) appends the hidden schedule
 * comment that `/todo edit`/`export`/`import` need for a lossless round-trip; views and model
 * reminders turn it off so readers do not get base64.
 */
export function phasesToMarkdown(phases: TodoPhase[], options: { metadata?: boolean } = {}): string {
	const withMetadata = options.metadata !== false;
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		for (const task of phases[i].tasks) {
			// One base64url HTML comment keeps structured metadata hidden from rendered Markdown.
			const metadata = withMetadata ? encodeTodoMetadata(task) : "";
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}${metadata}`);
		}
	}
	return `${out.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
	"!": "blocked",
};

import {
	createTodoToolSchema,
	type TodoToolParams as TodoToolParamsType,
	type TodoToolSchema,
} from "./todo-classify-schema";

/** Keep row-owned bindings and pending user checks when labels survive a plan replacement. */
export function preserveTodoMetadata(
	current: TodoPhase[],
	parsed: TodoPhase[],
	preservePendingCheck = false,
): TodoPhase[] {
	const prior = new Map<string, TodoItem[]>();
	for (const task of current.flatMap(phase => phase.tasks))
		prior.set(task.content, [...(prior.get(task.content) ?? []), task]);
	return parsed.map(phase => ({
		...phase,
		tasks: phase.tasks.map(task => {
			const matches = prior.get(task.content);
			if (matches?.length !== 1) return task;
			const previous = matches[0]!;
			const preserveStatus = preservePendingCheck && previous.awaitingUser !== undefined;
			const metadata = Object.fromEntries(
				Object.entries(previous).filter(([key]) => !["content", "status", "blocker"].includes(key)),
			) as Partial<TodoItem>;
			return {
				...task,
				...metadata,
				content: task.content,
				status: preserveStatus ? previous.status : task.status,
				...(preserveStatus && previous.blocker !== undefined ? { blocker: previous.blocker } : {}),
			};
		}),
	}));
}

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];

		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			currentPhase = { name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		// Tolerate backslash-escaped brackets (`- \[x\]`): some editors and
		// markdown serializers escape `[` (and `]`) when round-tripping, yet the
		// line still renders as a normal `[x]` checkbox. Accept either form.
		const taskMatch = /^[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-], [!])`);
				continue;
			}
			const rawContent = taskMatch[2].trim();
			const metadataMatch = TODO_METADATA_COMMENT.exec(rawContent);
			let content = rawContent;
			let metadata: TodoMarkdownMetadata = {};
			if (metadataMatch) {
				content = rawContent.slice(0, metadataMatch.index).trim();
				try {
					metadata = decodeTodoMetadata(metadataMatch[1]);
				} catch (error) {
					errors.push(`Line ${lineNum + 1}: ${error instanceof Error ? error.message : "invalid todo metadata"}`);
					currentPhase.tasks.push({ content: rawContent, status });
					continue;
				}
			}
			const blockerMatch = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(content);
			if (status === "blocked" && blockerMatch) content = blockerMatch[1].trim();
			const task: TodoItem = { content, status };
			if (status === "blocked") {
				const blocker = metadata.blocker ?? blockerMatch?.[2].trim();
				if (blocker !== undefined) task.blocker = blocker;
			}
			if (metadata.details !== undefined) task.details = metadata.details;
			if (metadata.notes !== undefined) task.notes = [...metadata.notes];
			if (metadata.schedule !== undefined) task.schedule = structuredClone(metadata.schedule);
			currentPhase.tasks.push(task);
			continue;
		}

		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}

	normalizeInProgressTask(phases);
	return { phases, errors };
}
function formatSummary(
	phases: TodoPhase[],
	errors: string[],
	forecast: TodoPlanForecast,
	readOnly = false,
	now = Date.now(),
	focusPhase?: string,
	accountingPhases = phases,
): string {
	const tasks = accountingPhases.flatMap(phase => phase.tasks);
	if (tasks.length === 0 || phases.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	let currentIdx = phases.findIndex(phase => phase.tasks.some(task => task.status === "in_progress"));
	if (currentIdx === -1) currentIdx = phases.findIndex(phase => phase.tasks.some(task => task.status === "pending"));
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		// The lead acts on the critical path first, so the open list says which rows are on it.
		const critical = new Set(
			forecast.rows.filter(row => row.criticalityKnown === true && row.critical).map(row => row.content),
		);
		lines.push(`Remaining items (${remainingTasks.length}${critical.size ? `, ${critical.size} critical` : ""}):`);
		for (const task of remainingTasks) {
			const state = formatOpenTaskState(task, task.status);
			lines.push(`  - ${task.content} [${state}] (${task.phase})${critical.has(task.content) ? " critical" : ""}`);
		}
	}
	// Closed = completed + abandoned, mirroring the per-phase `done` count.
	const closedAll = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const blockedAll = tasks.filter(task => task.status === "blocked").length;
	lines.push(
		`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length}).`);
	// Closed rows are counted, not listed: a long session re-read 135 finished rows on every view.
	// `view` with `phase` lists that whole phase, closed rows included.
	for (const phase of phases) {
		const closed = phase.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
		if (phase.name !== focusPhase) {
			lines.push(`  ${phase.name}: ${closed}/${phase.tasks.length} closed`);
			continue;
		}
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const blocker = task.blocker?.trim();
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? blocker
								? ` (blocked: ${blocker})`
								: " (blocked: reason required)"
							: "";
			lines.push(`    - ${checkbox} ${task.content}${tag}`);
		}
	}
	const blockedTasks = tasks.filter(task => task.status === "blocked");
	if (blockedTasks.length > 0) {
		lines.push(
			"Blocked work is not settled by recording a reason: take safe actions to clear each blocker or reformulate it, then unblock and continue the work.",
		);
		for (const task of blockedTasks) lines.push(`  - recover: ${task.content}`);
	}
	lines.push("", formatPlanForecast(forecast, now));
	if (forecast.planningIssues.length > 0) {
		lines.push(`Planning repairs required (${forecast.planningIssues.length}):`);
		for (const issue of forecast.planningIssues) lines.push(`  - ${issue.task}: ${issue.message}`);
	}
	return lines.join("\n");
}

type TodoRowDelta = {
	kind: "added" | "removed" | "updated";
	phase: string;
	task: TodoItem;
	previous?: TodoItem;
	fields?: string[];
};

function todoRowDeltas(previous: TodoPhase[], phases: TodoPhase[]): TodoRowDelta[] {
	const before = new Map<string, { phase: string; task: TodoItem }>();
	const after = new Map<string, { phase: string; task: TodoItem }>();
	for (const phase of previous)
		for (const task of phase.tasks)
			before.set(JSON.stringify([phase.name, task.content]), { phase: phase.name, task });
	for (const phase of phases)
		for (const task of phase.tasks)
			after.set(JSON.stringify([phase.name, task.content]), { phase: phase.name, task });

	const deltas: TodoRowDelta[] = [];
	for (const [rowKey, current] of after) {
		const old = before.get(rowKey);
		if (!old) {
			deltas.push({ kind: "added", ...current });
			continue;
		}
		const fields: string[] = [];
		if (old.task.status !== current.task.status) fields.push("status");
		if (old.task.blocker !== current.task.blocker) fields.push("blocker");
		if (old.task.details !== current.task.details) fields.push("details");
		if (JSON.stringify(old.task.schedule ?? null) !== JSON.stringify(current.task.schedule ?? null))
			fields.push("schedule");
		if (JSON.stringify(old.task.notes ?? null) !== JSON.stringify(current.task.notes ?? null)) fields.push("notes");
		if (fields.length > 0) deltas.push({ kind: "updated", ...current, previous: old.task, fields });
	}
	for (const [rowKey, old] of before) if (!after.has(rowKey)) deltas.push({ kind: "removed", ...old });
	return deltas;
}

function formatMutationSummary(
	op: TodoOperation,
	previous: TodoPhase[],
	phases: TodoPhase[],
	errors: string[],
	forecast: TodoPlanForecast,
	now: number,
	accountingPhases = phases,
): string {
	const tasks = accountingPhases.flatMap(phase => phase.tasks);
	const open = tasks.filter(task => task.status === "pending" || task.status === "in_progress").length;
	const closed = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const blocked = tasks.filter(task => task.status === "blocked");
	const deltas = todoRowDeltas(previous, phases);
	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	lines.push(`${op}: ${deltas.length} row(s) changed.`);
	for (const delta of deltas) {
		const status =
			delta.previous && delta.previous.status !== delta.task.status
				? `${delta.previous.status} → ${delta.task.status}`
				: delta.task.status;
		const fields = delta.fields?.length ? `; changed=${delta.fields.join(",")}` : "";
		const blocker =
			delta.task.status === "blocked" ? `; blocker=${JSON.stringify(delta.task.blocker ?? "reason required")}` : "";
		lines.push(`  ${delta.kind} ${delta.task.content} (${delta.phase}) [${status}]${fields}${blocker}`);
	}
	lines.push(`Overall: ${closed}/${tasks.length} closed, ${open} open, ${blocked.length} blocked.`);
	const next = nextActionableTask(phases);
	lines.push(
		next
			? `Next: ${next.content} [${next.status}]`
			: blocked.length > 0
				? "Next: safely resolve or reformulate blocked work; a blocker reason does not settle the task."
				: "Next: none; all tasks are closed.",
	);
	lines.push(`Forecast: ${formatPlanForecast(forecast, now)}`);
	const changedContent = new Set(deltas.filter(delta => delta.kind !== "removed").map(delta => delta.task.content));
	const changedIssues = forecast.planningIssues.filter(issue => changedContent.has(issue.task));
	if (forecast.planningIssues.length > 0) {
		lines.push(
			`Planning repairs remain: ${forecast.planningIssues.length}${changedIssues.length === 0 ? "; details omitted for unchanged rows; use todo.view" : "."}`,
		);
		for (const issue of changedIssues) lines.push(`  - ${issue.task}: ${issue.message}`);
	}
	if (blocked.length > 0)
		lines.push(
			`Blocked gate: ${blocked.length} row(s) are not dispatchable; inspect todo.view for unchanged blocker reasons and recover safely.`,
		);
	return lines.join("\n");
}

export function buildTodoOpPersistedEdit(
	op: TodoOperation,
	params: unknown,
	at = Date.now(),
): TodoOperationPersistedEdit {
	return { v: 1, kind: "op", at, op, params: structuredClone(params) };
}

/** Build a row-keyed append event for the existing durable Todo custom-entry writer. */
export function buildTodoReworkAttemptPersistedEdit(
	row: { phase: string; content: string },
	attempt: TodoReworkAttempt,
	at = Date.now(),
): TodoReworkAttemptPersistedEdit {
	return { v: 1, kind: "attempt", at, phase: row.phase, content: row.content, attempt: structuredClone(attempt) };
}

export function buildTodoExecutorPersistedEdit(
	observation: TodoExecutorObservation,
	at = Date.now(),
): TodoPersistedEdit {
	return {
		v: 1,
		kind: "executor",
		at,
		observation: {
			workerId: observation.workerId,
			...(observation.row !== undefined ? { row: observation.row } : {}),
			...(observation.agentProfile ? { agentProfile: observation.agentProfile } : {}),
			...(observation.description ? { description: observation.description } : {}),
			...(observation.taskText ? { taskText: observation.taskText } : {}),
			...(observation.resolvedModel ? { resolvedModel: observation.resolvedModel } : {}),
			...(observation.thinkingLevel ? { thinkingLevel: observation.thinkingLevel } : {}),
			startedAt: observation.startedAt,
			...(observation.finishedAt !== undefined ? { finishedAt: observation.finishedAt } : {}),
			...(observation.outcome ? { outcome: observation.outcome } : {}),
			...(observation.runningWorkerIds ? { runningWorkerIds: [...observation.runningWorkerIds].sort() } : {}),
		},
	};
}

function attachLiveTodoDetails(
	details: TodoToolDetails,
	phases: TodoPhase[],
	forecast: TodoPlanForecast,
): TodoToolDetails {
	Object.defineProperty(details, "phases", { value: phases, enumerable: false, configurable: true });
	Object.defineProperty(details, "forecast", { value: forecast, enumerable: false, configurable: true });
	return details;
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<TodoToolSchema<TodoSchema>, TodoToolDetails> {
	static readonly #schema: TodoToolSchema<TodoSchema> = createTodoToolSchema(todoSchema);
	readonly name = "todo";
	#calibrationReady = getTodoPlanCalibrationStore()
		.refresh()
		.catch(error => logger.warn("Forecast calibration load failed", { error }));
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Track structured todos and classify requirements";
	readonly description: string;
	readonly parameters = TodoTool.#schema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	// Raw args reach execute() on schema failure; resolveTodoParams re-validates
	// and repairs the one recoverable shape (missing `op`, unambiguous payload).
	readonly lenientArgValidation = true;
	#validatingReviewClosure = false;

	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoComposition, {
			todo: prompt.render(todoDescription),
			requirements: prompt.render(todoRequirementsDescription),
		});
	}

	/** Consume a verified page decision through the ordinary review transition. */
	async applyReviewPageAnswer(answer: ReviewPageAnswer): Promise<boolean> {
		const rows = (this.session.getTodoPhases?.() ?? []).flatMap(phase => phase.tasks);
		const matches = rows.filter(row => row.content === answer.task);
		if (matches.length !== 1) return false;
		const row = matches[0];
		const key = JSON.stringify([answer.page, answer.card, answer.contentSha, answer.answer]);
		if (
			row.schedule?.review !== "user" ||
			row.schedule.reviewPage !== answer.page ||
			(row.schedule.reviewCard && row.schedule.reviewCard !== answer.card) ||
			row.schedule.reviewAnswers?.includes(key) ||
			(answer.answer === "redo" && !answer.note.trim())
		)
			return false;
		const evidence = `owner ${answer.answer === "accept" ? "accepted" : answer.answer === "redo" ? "requested redo" : "dropped"} on review page at ${answer.at}${answer.note ? `: ${answer.note}` : ""}`;
		const result = await this.execute("review-page-answer", {
			op: "schedule",
			updates: [
				{
					task: answer.task,
					reviewCard: answer.card,
					review: answer.answer === "accept" ? "accepted" : answer.answer,
					evidence,
				},
			],
		});
		if (!committedTodoPhases(result)) return false;
		// Forecast calculation can yield; keep unrelated edits made during that await.
		const phases = clonePhases(this.session.getTodoPhases?.() ?? []);
		const target = phases.flatMap(phase => phase.tasks).find(row => row.content === answer.task);
		if (
			!target?.schedule ||
			target.schedule.reviewPage !== answer.page ||
			target.schedule.review !== (answer.answer === "accept" ? "accepted" : answer.answer)
		)
			return false;
		target.schedule.reviewAnswers = [...(target.schedule.reviewAnswers ?? []), key];
		target.schedule.reviewPagePending = false;
		target.schedule.handoffPending = false;
		target.schedule.reviewSummary = evidence;
		if (answer.answer === "redo") {
			target.status = "pending";
			target.schedule.reviewSummary = answer.note;
		}
		const edit = committedTodoEdit(result);
		if (edit?.kind === "archive")
			this.session.sessionManager?.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { edit });
		this.session.sessionManager?.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		this.session.setTodoPhases?.(phases);
		return true;
	}

	async execute(
		_toolCallId: string,
		params: TodoToolParamsType<TodoSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const result = await artifactCwdScope.run(this.session.cwd, () =>
			this.#executeTodo(_toolCallId, params, _signal, _onUpdate, _context),
		);
		if (result.details?.op === "view" && this.session.sessionManager) {
			const amendments = latestRequirementsFromSession(this.session.sessionManager).flatMap(requirement =>
				(requirement.amendments ?? []).map(amendment =>
					amendment.supersededBy
						? `${requirement.id} superseded by ${amendment.supersededBy} at ${amendment.at}: ${amendment.oldClassification} -> ${amendment.newClassification}; rows ${JSON.stringify(amendment.oldRows)} -> ${JSON.stringify(amendment.newRows)} (${amendment.reason})`
						: `${requirement.id} relinked at ${amendment.at}: rows ${JSON.stringify(amendment.oldRows)} -> ${JSON.stringify(amendment.newRows)} (${amendment.reason})`,
				),
			);
			if (amendments.length > 0) {
				for (const content of result.content) {
					if (content.type === "text") content.text += `\n${amendments.join("\n")}`;
				}
			}
		}
		return result;
	}

	async #executeTodo(
		_toolCallId: string,
		params: TodoToolParamsType<TodoSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const livePhasesSnapshot = JSON.stringify(this.session.getTodoPhases?.() ?? []);
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);
		if (this.session.sessionManager) {
			mergeCanonicalArtifactBindings(
				previousPhases,
				getLatestTodoPhasesFromEntries(currentRequirementTodoEntries(this.session.sessionManager)),
			);
		}
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const rawOp: unknown = params.op;
		if (rawOp === "classify") return this.#classify(params, previousPhases, storage);
		if (rawOp === "done") {
			const gate = await this.#doneGate(params, previousPhases, storage, _signal);
			if (gate) return gate;
		}
		const resolved = resolveTodoParams(params, previousPhases.length > 0);
		if (typeof resolved === "string") {
			return {
				content: [{ type: "text", text: resolved }],
				details: { phases: previousPhases, storage },
				isError: true,
			};
		}
		const entry = resolved;
		const sessionManager = this.session.sessionManager;
		if ((entry.op === "rm" || entry.op === "init") && sessionManager) {
			const linkedRequirements = latestRequirementsFromSession(sessionManager).filter(
				requirement => requirement.classification === "linked",
			);
			const targetErrors: string[] = [];
			const removedRows = new Set<string>();
			if (entry.op === "rm") {
				for (const task of getTaskTargets(previousPhases, entry, targetErrors)) removedRows.add(task.content);
			} else {
				const replacementRows = new Set(entry.list?.flatMap(item => item.items) ?? entry.items ?? []);
				for (const requirement of linkedRequirements) {
					for (const row of requirement.rows) {
						if (!replacementRows.has(row) && findTaskByContent(previousPhases, row)) removedRows.add(row);
					}
				}
			}
			const blocked = linkedRequirements.flatMap(requirement =>
				requirement.rows.filter(row => removedRows.has(row)).map(row => ({ requirement, row })),
			);
			if (targetErrors.length === 0 && blocked.length > 0) {
				const unfinished = blocked.find(
					({ row }) => findTaskByContent(previousPhases, row)?.task.status !== "completed",
				);
				if (unfinished) {
					const { requirement, row } = unfinished;
					return {
						content: [
							{
								type: "text",
								text: formatRequirementActionRefusal(
									`Re-audit ${requirement.id} for ${JSON.stringify(row)} before removing it.`,
									`Cannot remove unfinished requirement-linked TODO row ${JSON.stringify(row)} (${requirement.id}). Obtain a fresh qa-auditor pass and mark the row done before removing it, or relink the requirement with relink=true and a reason to its replacement row.`,
								),
							},
						],
						details: { op: entry.op, phases: previousPhases, storage },
						isError: true,
					};
				}
				// Completed rows may leave the active plan only while their saved QA
				// evidence is still fresh. Canonical snapshots retain their artifact history.
				const gate = await this.#doneGate(
					{ items: [...new Set(blocked.map(({ row }) => row))] },
					previousPhases,
					storage,
					_signal,
				);
				if (gate) {
					if (gate.details) gate.details.op = entry.op;
					return gate;
				}
			}
		}
		// Slash commands and worker completion can edit the plan during an artifact
		// probe even though native todo calls are exclusive. Never publish that stale
		// snapshot: retry must select and audit the current rows and bindings.
		const currentPhases = this.session.getTodoPhases?.() ?? [];
		if (JSON.stringify(currentPhases) !== livePhasesSnapshot) {
			return {
				content: [
					{
						type: "text",
						text: formatRequirementActionRefusal(
							`Retry ${entry.op} for ${JSON.stringify(entry.task ?? entry.items?.[0] ?? entry.phase ?? "TODO plan")} against the current plan.`,
							"TODO state changed during the artifact check; no changes were applied.",
						),
					},
				],
				details: { op: entry.op, phases: clonePhases(currentPhases), storage },
				isError: true,
			};
		}
		const op = entry.op;
		await this.#calibrationReady;
		const now = Date.now();
		const archiveState = readTodoArchiveState(this.session.sessionManager);
		const priorArchive = archiveState.phases;
		const healedRows = healStoredSelfEdges(previousPhases);
		const healedEdges = healStoredDanglingEdges(previousPhases, priorArchive);
		const manager = this.session.sessionManager;
		const deadline = manager
			? readGoalDeadlineFromManager(manager, this.session.cwd, { includePaused: true })
			: readGoalDeadline([], this.session.cwd, { includePaused: true });
		const skippedEstimates: string[] = [];
		if (entry.op === "schedule") {
			const changed = (entry.updates ?? []).flatMap(update => {
				const estimate = update.estimate;
				const previous = findTaskByContent(previousPhases, update.task)?.task.schedule?.estimate;
				return estimate && !isSameAcceptedEstimate(previous, estimate) ? [{ task: update.task, estimate }] : [];
			});
			skippedEstimates.push(...identicalEstimateErrors(changed));
			const counts = new Map<string, number>();
			const key = (estimate: AcceptedEstimateFields) =>
				`${estimate.optimisticSeconds}/${estimate.likelySeconds}/${estimate.pessimisticSeconds}`;
			for (const row of changed) counts.set(key(row.estimate), (counts.get(key(row.estimate)) ?? 0) + 1);
			const skipped = new Set(
				changed.filter(row => counts.get(key(row.estimate))! > IDENTICAL_ESTIMATE_LIMIT).map(row => row.task),
			);
			entry.updates = entry.updates?.map(update => {
				if (!skipped.has(update.task)) return update;
				const accepted = { ...update };
				delete accepted.estimate;
				return accepted;
			});
		}
		const readOnly = op === "view";
		const { phases: updated, errors } = readOnly
			? { phases: previousPhases, errors: [] as string[] }
			: applyParams(clonePhases(previousPhases), entry, now, priorArchive);
		if (op === "done" && !this.#validatingReviewClosure) {
			for (const phase of updated)
				for (const row of phase.tasks) {
					const before = previousPhases.flatMap(phase => phase.tasks).find(task => task.content === row.content);
					if (row.status === "completed" && before?.status !== "completed" && todoNeedsOwnerDecision(row.schedule))
						errors.push(
							`Owner decision required for ${JSON.stringify(row.content)}; show its product content and record the owner's answer before closing.`,
						);
				}
		}
		// Use the ordinary done operation so every native completion gate still runs.
		const reviewClosures: Array<{ task: string; reason?: string }> = [];
		if (op === "schedule" && errors.length === 0) {
			for (const update of entry.updates ?? []) {
				if (update.review !== "accepted") continue;
				let result: AgentToolResult<TodoToolDetails>;
				this.#validatingReviewClosure = true;
				try {
					result = await this.execute(
						_toolCallId,
						{ op: "done", task: update.task },
						_signal,
						undefined,
						_context,
					);
				} finally {
					this.#validatingReviewClosure = false;
				}
				const reason = result.isError
					? result.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n") || "Completion gate refused without a text reason"
					: undefined;
				reviewClosures.push({ task: update.content ?? update.task, ...(reason ? { reason } : {}) });
			}
			applyReviewClosures(updated, reviewClosures, now);
		}
		// An unsuccessful batch must neither commit an operation nor age out existing rows.
		const failed = errors.length > 0;
		const previousStatuses = new Map(
			previousPhases.flatMap(phase => phase.tasks.map(task => [task.content, task.status] as const)),
		);
		const closesRow = updated.some(phase =>
			phase.tasks.some(
				task =>
					(task.status === "completed" || task.status === "abandoned") &&
					previousStatuses.get(task.content) !== task.status,
			),
		);
		const archived = !readOnly && !failed && closesRow ? archiveTodoPhases(updated, now) : undefined;
		const effective = archived?.phases ?? (failed ? previousPhases : updated);
		const archivedPhases = op === "init" && !failed ? [] : priorArchive;
		const newArchive = archived?.archivedPhases ?? [];
		// A schedule rename changes titles, not statuses: content-keyed completion
		// diffing must not report renamed closed rows as newly completed.
		const completedTasks =
			readOnly || failed || (op === "schedule" && !reviewClosures.length)
				? []
				: getCompletionTransitions(previousPhases, updated);
		if (((!readOnly && !failed) || healedRows.length || healedEdges.length) && !this.#validatingReviewClosure)
			this.session.setTodoPhases?.(effective);
		const operation = !readOnly && !failed ? buildTodoOpPersistedEdit(op, entry, now) : undefined;
		if (operation && healedRows.length) operation.healedSelfEdges = true;
		if (operation && healedEdges.length) operation.healedDanglingEdges = true;
		if (operation && reviewClosures.length) operation.reviewClosures = reviewClosures;
		const archiveEdit: TodoArchivePersistedEdit | undefined =
			newArchive.length > 0 ? { v: 1, kind: "archive", at: now, operation, archivedPhases: newArchive } : undefined;
		const historyRecords = readTodoPlanHistory(manager);
		if (operation && !this.#validatingReviewClosure && manager) {
			for (const record of historyRecords) {
				const settled = settleTodoPlanRecord(
					record,
					withTodoArchive(effective, [...archivedPhases, ...newArchive]),
					now,
					op === "init",
				);
				if (settled) {
					manager.appendCustomEntry(TODO_PLAN_HISTORY_CUSTOM_TYPE, settled);
					try {
						await getTodoPlanCalibrationStore().append(settled);
					} catch (error) {
						logger.warn("Forecast calibration append failed", { error });
					}
				}
			}
		}
		try {
			await getTodoPlanCalibrationStore().refresh();
		} catch (error) {
			logger.warn("Forecast calibration refresh failed", { error });
		}
		const forecast = forecastTodoLivePlan(effective, [...archivedPhases, ...newArchive], {
			history: todoPlanCalibrationHistory(historyRecords, now),
			now,
			capacity: cfgTaskMaxConcurrency.get(this.session.settings),
			risk: await loadRowRisk(
				this.session.settings,
				this.session.modelRegistry,
				this.session.cwd,
				this.session.effectiveExtensionRoots?.(),
				now,
			),
			...(deadline === undefined ? {} : { deadlineAt: deadline.deadlineAt }),
		});
		if (operation && !this.#validatingReviewClosure && manager?.getSessionId && forecast.rawP50Finish !== undefined) {
			const sessionId = manager.getSessionId();
			const hour = Math.floor(now / 3_600_000);
			const members = [...todoPlanMembers(effective)]
				.filter(([, row]) => row.status !== "completed" && row.status !== "abandoned")
				.map(([key]) => key);
			if (
				members.length &&
				!historyRecords.some(
					record =>
						record.prediction.sessionId === sessionId &&
						Math.floor(record.prediction.originAt / 3_600_000) === hour,
				)
			) {
				manager.appendCustomEntry(TODO_PLAN_HISTORY_CUSTOM_TYPE, {
					prediction: {
						sessionId,
						originAt: now,
						rawP50Finish: forecast.rawP50Finish,
						capacity: forecast.capacityAssumptions?.requested,
						provenance: forecast.provenance,
						predictionVersion: forecast.predictionVersion,
						membershipFingerprint: forecast.membershipFingerprint,
						...(forecast.calibratedUpperFinish === undefined
							? {}
							: { upperFinish: forecast.calibratedUpperFinish }),
					},
					members,
				});
			}
		}
		const details = attachLiveTodoDetails(
			{
				op,
				storage,
				forecastAt: now,
				...(archiveEdit ? { edit: archiveEdit } : operation ? { edit: operation } : {}),
			} as TodoToolDetails,
			effective,
			forecast,
		);
		const archiveSummary =
			op === "init" && !failed
				? getTodoArchiveSummaryFromEntries([], archiveEdit)
				: archiveEdit
					? getTodoArchiveSummaryFromEntries(getTodoArchiveBranchEntries(this.session.sessionManager), archiveEdit)
					: archiveState.summary;
		if (archiveSummary) details.archiveSummary = archiveSummary;
		if (readOnly && entry.archive) details.archivedPhases = archivedPhases;
		if (deadline) details.deadlineAt = deadline.deadlineAt;
		if (completedTasks.length > 0) details.completedTasks = completedTasks;
		const matchingTasks =
			readOnly && entry.task
				? [...effective, ...archivedPhases].flatMap(phase =>
						phase.tasks.filter(task => task.content === entry.task).map(task => ({ phase: phase.name, task })),
					)
				: undefined;
		const accountingPhases = withTodoArchive(effective, [...archivedPhases, ...newArchive]);
		const summary = matchingTasks
			? matchingTasks.length
				? JSON.stringify(matchingTasks, null, 2)
				: `Task not found: ${JSON.stringify(entry.task)}`
			: readOnly && entry.archive
				? formatTodoView(effective, { now, all: true, archive: true, archivedPhases })
				: op === "init" || readOnly
					? formatSummary(
							effective,
							errors,
							forecast,
							readOnly,
							now,
							readOnly ? entry.phase : undefined,
							accountingPhases,
						)
					: formatMutationSummary(op, previousPhases, updated, errors, forecast, now, accountingPhases);
		const droppedEdges =
			op === "drop" && !failed
				? healStoredDanglingEdges(
						clonePhases(previousPhases).map(phase => ({
							...phase,
							tasks: phase.tasks.map(row => ({
								...row,
								status:
									effective.flatMap(p => p.tasks).find(t => t.content === row.content)?.status ?? row.status,
							})),
						})),
						archivedPhases,
					)
				: [];
		return {
			content: [
				{
					type: "text",
					text: [
						...skippedEstimates,
						summary,
						...(archiveSummary ? [formatTodoArchiveSummary(archiveSummary)] : []),
						...(healedEdges.length ? [`Healed stored dangling edges: ${healedEdges.join("; ")}`] : []),
						...(droppedEdges.length ? [`Removed inbound edges: ${droppedEdges.join("; ")}`] : []),
						...(healedRows.length
							? [`Healed stored self-edges: ${healedRows.map(row => JSON.stringify(row)).join("; ")}`]
							: []),
						...reviewClosures
							.filter(row => row.reason)
							.map(
								row =>
									`${JSON.stringify(row.task)}: accepted by user, closed; background requirement audit still open (never blocks this row): ${row.reason}`,
							),
					].join("\n"),
				},
			],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}

	/** Native completion delegates row evidence and refusal reasons to the shared ledger owner. */
	async #doneGate(
		params: Record<string, unknown>,
		previousPhases: TodoPhase[],
		storage: "memory" | "session",
		signal?: AbortSignal,
	): Promise<AgentToolResult<TodoToolDetails> | undefined> {
		const sessionManager = this.session.sessionManager;
		if (!sessionManager) return undefined;
		const task = typeof params.task === "string" ? params.task : undefined;
		const phase = typeof params.phase === "string" ? params.phase : undefined;
		const items = Array.isArray(params.items)
			? params.items.filter((item): item is string => typeof item === "string")
			: undefined;
		const selectorErrors: string[] = [];
		const targets = getCompletionTargets(previousPhases, { task, phase, items }, selectorErrors);
		if (selectorErrors.length === 0) {
			const currentRequirements = latestRequirementsFromSession(sessionManager);
			if (currentRequirements.length === 0) return undefined;
			const branch = getRequirementGateBranch(
				sessionManager,
				currentRequirements,
				new Set(targets.map(target => target.content)),
				previousPhases,
			);
			let changes: Map<string, { at: string; id: string }> | undefined;
			const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();
			const gitStatusSnapshots: RequirementGitStatusSnapshots = new Map();
			const requirements = currentRequirements;
			const requirementSnapshot = JSON.stringify(requirements);
			const open = await evaluateRequirementDoneGate(
				requirements,
				targets.map(target => target.content),
				async (row, receipt) => {
					const artifact = await getRequirementRowArtifact(
						{ cwd: this.session.cwd, sessionManager, signal, receipt, gitStatusSnapshots },
						row,
						previousPhases,
						checkoutCache,
					);
					// Saved-change fallback is an explicit legacy receipt lookup; typed identities
					// and current Git/file artifacts do not need historical row changes.
					if (receipt && !artifact.identityCheck && !artifact.sha256 && (!artifact.head || artifact.dirty))
						changes ??= historicalRequirementRowChanges(sessionManager);
					return { ...artifact, lastChange: changes?.get(row) };
				},
				getPersistedRequirementAuditRejections(branch, sessionManager.getSessionId?.() ?? null),
				getCompletedTodoRows(branch),
				new Set(
					previousPhases.flatMap(phase =>
						phase.tasks.filter(task => task.status !== "abandoned").map(task => task.content),
					),
				),
				getAcceptedTodoRows(branch),
				getClosedTodoRows(branch),
			);
			if (JSON.stringify(latestRequirementsFromSession(sessionManager)) !== requirementSnapshot) {
				return {
					content: [
						{
							type: "text",
							text: formatRequirementActionRefusal(
								"Retry todo done against the current requirements ledger.",
								"Requirement evidence changed during the artifact check; no TODO completion was applied.",
							),
						},
					],
					details: { op: "done", phases: previousPhases, storage },
					isError: true,
				};
			}
			if (open.length > 0) {
				const livePhases = this.session.getTodoPhases?.() ?? [];
				const reopened = reopenStaleRequirementRows(livePhases, open);
				let effectivePhases = previousPhases;
				if (reopened && JSON.stringify(livePhases) === JSON.stringify(previousPhases)) {
					this.session.setTodoPhases?.(reopened);
					effectivePhases = reopened;
					sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: reopened });
				}
				const invalidated = invalidateStaleRequirementVerdicts(requirements, open);
				if (JSON.stringify(invalidated) !== requirementSnapshot) {
					appendRequirementsSnapshot(
						{ appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data) },
						invalidated,
					);
					await sessionManager.flush();
				}
				const gateDetails: RequirementTodoToolDetails = {
					op: "done",
					phases: effectivePhases,
					storage,
					requirementGateIssues: open.filter(issue => (issue.stalePassRows?.length ?? 0) > 0),
				};
				return {
					content: [
						{
							type: "text",
							text: formatDoneGateRefusal(open),
						},
					],
					details: gateDetails,
					isError: true,
				};
			}
		}
		return undefined;
	}

	/** #41's classify path, dispatched on raw args before the shared schema. The shared
	 *  TodoOp union and TodoOperation in `@oh-my-pi/pi-tui/tools/todo` stay at base text;
	 *  only this tool's local TodoOp/todoSchema expose classify so the model can see the op. */
	async #classify(
		params: Record<string, unknown>,
		previousPhases: TodoPhase[],
		storage: string,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const details = { op: "classify", phases: previousPhases, storage } as unknown as TodoToolDetails;
		const id = typeof params.id === "string" ? params.id : undefined;
		const rawClassification = params.classification;
		const classification =
			rawClassification === "linked" || rawClassification === "not-a-requirement" || rawClassification === "merged"
				? rawClassification
				: undefined;
		const rows = Array.isArray(params.rows)
			? params.rows.filter((row): row is string => typeof row === "string")
			: undefined;
		const reason = typeof params.reason === "string" ? params.reason : undefined;
		const mergeInto = typeof params.mergeInto === "string" ? params.mergeInto : undefined;
		if (!id || !classification) {
			return {
				content: [
					{
						type: "text",
						text: formatRequirementActionRefusal(
							`Provide ${id ?? "an Rn id"} and its classification.`,
							`Classify call needs an Rn id and classification. Call todo with op="classify", id="<Rn>", classification="linked", rows=["<exact todo row>"] (or classification="not-a-requirement" with reason="<why this is not a requirement>", or classification="merged" with mergeInto="<other Rn>"). Then retry`,
						),
					},
				],
				details,
				isError: true,
			};
		}
		const sessionManager = this.session.sessionManager;
		if (!sessionManager) {
			return {
				content: [
					{
						type: "text",
						text: formatRequirementActionRefusal(
							`Run classify ${id} in a persisted session.`,
							`Classify requires persistent session storage. Retry the same call todo with op="classify", id="${id}", classification="<linked|not-a-requirement|merged>" in a persisted session`,
						),
					},
				],
				details,
				isError: true,
			};
		}
		let archivedTargets: TodoPhase[] = [];
		if (classification === "linked") {
			const duplicatedRows = (rows ?? []).filter((row, index, all) => {
				const activeMatches = previousPhases.flatMap(phase => phase.tasks).filter(task => task.content === row);
				return all.indexOf(row) !== index || activeMatches.length > 1;
			});
			if (duplicatedRows.length > 0) {
				const duplicate = [...new Set(duplicatedRows)][0]!;
				return {
					content: [
						{
							type: "text",
							text: formatRequirementActionRefusal(
								`Choose one unambiguous TODO row for ${id}.`,
								`Cannot link ${id} to duplicate TODO row ${JSON.stringify(duplicate)}; remove the duplicate or choose a unique row, then retry.`,
							),
						},
					],
					details,
					isError: true,
				};
			}
			const missingActiveRows = (rows ?? []).filter(row => !findTaskByContent(previousPhases, row));
			if (missingActiveRows.length > 0) {
				const historical = new Map<string, TodoPhase>();
				observeLatestTodoPhases(sessionManager.getBranch(), snapshot => {
					for (const phase of snapshot) {
						for (const task of phase.tasks) {
							if (missingActiveRows.includes(task.content))
								historical.set(task.content, { name: phase.name, tasks: [cloneTask(task)] });
						}
					}
				});
				archivedTargets = [...historical.values()];
			}
			const unknownRows = missingActiveRows.filter(row => !findTaskByContent(archivedTargets, row));
			if (unknownRows.length > 0) {
				const available = previousPhases.flatMap(phase => phase.tasks.map(task => JSON.stringify(task.content)));
				return {
					content: [
						{
							type: "text",
							text: formatRequirementActionRefusal(
								`Create or select a TODO row for ${id}.`,
								`Unknown TODO rows for ${id}: ${unknownRows.map(row => JSON.stringify(row)).join(", ")}. Available rows: ${available.length > 0 ? available.join(", ") : '(none: first create one with todo op="append", items=["<exact todo row>"] (or op="init"))'}. Call todo with op="classify", id="${id}", classification="linked", rows=[<exact existing row>]. Then retry`,
							),
						},
					],
					details,
					isError: true,
				};
			}
		}
		const requirements = latestRequirementsFromSession(sessionManager);
		// A candidate has no prior requirement binding to relink; its first
		// classification may atomically replace the row's provisional artifact.
		const initialClassification =
			requirements.find(requirement => requirement.id === id)?.classification === "candidate";
		const resourcesSupplied = params.resources !== undefined;
		const resources = Array.isArray(params.resources)
			? params.resources.filter((resource): resource is string => typeof resource === "string")
			: undefined;
		const deploymentSupplied = params.deployment !== undefined;
		let deployment: TodoDeploymentBinding | undefined;
		if (deploymentSupplied) {
			const value = params.deployment;
			const parsed =
				typeof value === "string" ? parseRequirementIdentity(value) : { error: "deployment must be a string" };
			if (
				classification !== "linked" ||
				!Array.isArray(params.rows) ||
				params.rows.length === 0 ||
				params.rows.some(row => typeof row !== "string" || !row.trim()) ||
				"error" in parsed ||
				parsed.identity.kind !== "deploy" ||
				resourcesSupplied
			) {
				return {
					content: [
						{
							type: "text",
							text: formatRequirementActionRefusal(
								`Declare a valid deployment binding for ${id}.`,
								`Deployment for ${id} requires classification="linked", nonempty exact TODO rows, and one canonical deploy identity${"error" in parsed ? ` (${parsed.error})` : ""}; deployment and resources are mutually exclusive. Call todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"], deployment="deploy:<HTTP(S) URL>@<version> field=<dot.path>" (or "deploy:<unit.service>@<version> scope=<user|system> env=<ENV_IDENTIFIER>"). Then retry`,
							),
						},
					],
					details,
					isError: true,
				};
			}
			deployment = formatRequirementIdentity(parsed.identity);
		}
		if (
			resourcesSupplied &&
			(classification !== "linked" ||
				!resources ||
				resources.length === 0 ||
				resources.length !== (params.resources as unknown[]).length ||
				resources.some(path => !nodePath.isAbsolute(path)))
		) {
			return {
				content: [
					{
						type: "text",
						text: formatRequirementActionRefusal(
							`Declare absolute resource paths for ${id}.`,
							`Resources for ${id} must be a nonempty list of absolute paths on classification="linked". Call todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"], resources=["/absolute/file-or-checkout"]. Then retry`,
						),
					},
				],
				details,
				isError: true,
			};
		}
		const affectedRows = new Set<string>();
		let replacingBinding = false;
		for (const task of [...previousPhases, ...archivedTargets].flatMap(phase => phase.tasks)) {
			if (!rows?.includes(task.content)) continue;
			const schedule = "schedule" in task && isRecord(task.schedule) ? task.schedule : undefined;
			const hasResources = Array.isArray(schedule?.resources) && schedule.resources.length > 0;
			if (deployment) {
				const previous = task.deployment;
				if (previous !== deployment) {
					affectedRows.add(task.content);
					if (previous || hasResources) replacingBinding = true;
				}
			} else if (resources) {
				// Resource identity is the order-independent manifest (common parent plus
				// sorted entries), so a pure reorder binds the same artifact, not a replacement.
				const previousResources = Array.isArray(schedule?.resources)
					? schedule.resources.filter((entry): entry is string => typeof entry === "string")
					: [];
				const sameResourceSet =
					!task.deployment &&
					previousResources.length === resources.length &&
					JSON.stringify([...previousResources].sort()) === JSON.stringify([...resources].sort());
				if (!sameResourceSet) {
					affectedRows.add(task.content);
					if (task.deployment || hasResources) replacingBinding = true;
				}
			}
		}
		if (replacingBinding && !initialClassification && (params.relink !== true || !reason?.trim())) {
			return {
				content: [
					{
						type: "text",
						text: formatRequirementActionRefusal(
							`Give ${id} a reasoned relink for its new artifact.`,
							`Replacing a saved deployment or resource binding for ${id} requires relink=true and a nonblank reason. Call todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"], relink=true, reason="<why the artifact binding changes>", deployment="deploy:<HTTP(S)-URL>@<version> field=<dot.path>" (or deployment="deploy:<literal.service>@<version> scope=<user|system> env=<ENV_KEY>", or resources=["/absolute/file-or-checkout"]). Then retry`,
						),
					},
				],
				details,
				isError: true,
			};
		}
		const result = classifyRequirement(requirements, id, classification, {
			rows,
			reason,
			mergeInto,
			relink: params.relink === true,
			supersededBy: typeof params.supersededBy === "string" ? params.supersededBy : undefined,
		});
		if ("error" in result) return { content: [{ type: "text", text: result.error }], details, isError: true };
		if (resources || deployment) {
			// Omitted bindings remain untouched; an explicit cutover stores exactly
			// one primary artifact descriptor on each selected row.
			const phases = clonePhases(previousPhases);
			const archivedPhases = clonePhases(archivedTargets);
			for (const task of [...phases, ...archivedPhases].flatMap(phase => phase.tasks)) {
				if (!rows?.includes(task.content)) continue;
				const schedule = "schedule" in task && isRecord(task.schedule) ? task.schedule : {};
				if (deployment) {
					task.deployment = deployment;
					if (Object.hasOwn(schedule, "resources")) {
						const updatedSchedule = { ...schedule };
						delete updatedSchedule.resources;
						Object.assign(task, { schedule: updatedSchedule });
					}
				} else if (resources) {
					delete task.deployment;
					Object.assign(task, { schedule: { ...schedule, resources: [...resources] } });
				}
			}
			sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases,
				...(archivedPhases.length > 0
					? {
							edit: { v: 1, kind: "archive", at: Date.now(), archivedPhases },
						}
					: {}),
			});
			this.session.setTodoPhases?.(phases);
			details.phases = phases;
		}
		if (affectedRows.size > 0) {
			result.requirements = result.requirements.map(requirement => {
				if (!requirement.rows.some(row => affectedRows.has(row))) return requirement;
				const updated = { ...requirement };
				const rowVerdicts = { ...requirement.rowVerdicts };
				for (const row of requirement.rows) {
					if (affectedRows.has(row)) {
						delete rowVerdicts[row];
					} else if (!Object.hasOwn(rowVerdicts, row)) {
						const verdict = getRequirementRowVerdict(requirement, row);
						if (verdict) {
							Object.defineProperty(rowVerdicts, row, {
								value: verdict,
								enumerable: true,
								configurable: true,
								writable: true,
							});
						}
					}
				}
				delete updated.verdict;
				if (Object.keys(rowVerdicts).length > 0) updated.rowVerdicts = rowVerdicts;
				else delete updated.rowVerdicts;
				return updated;
			});
		}
		appendRequirementsSnapshot(
			{ appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data) },
			result.requirements,
		);
		await sessionManager.flush();
		return {
			content: [{ type: "text", text: `Classified ${id} as ${classification}.` }],
			details,
		};
	}
}
