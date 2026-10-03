import {
	type TodoStatus,
	type TodoOperation,
	type TodoItem,
	type TodoPhase,
	type TodoCompletionTransition,
	type TodoToolDetails,
} from "@oh-my-pi/pi-tui/tools/todo";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";

import { AgentRegistry } from "../registry/agent-registry";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	formatDoneGateRefusal,
	getLatestRequirements,
	isFreshRequirementVerdict,
	type RequirementsLedgerAppender,
} from "./requirements-ledger";

import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

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

// =============================================================================
// Schema
// =============================================================================

// Local TodoOp extends the shared base (`@oh-my-pi/pi-tui/tools/todo` TodoOperation
// stays at base text): classify is dispatched on raw args before todoSchema, so
// adding it only here keeps the tui contract untouched while making the op and
// its fields visible to the model in the tool definition it receives.
const TodoOp = type('"init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view" | "classify"');

const ClassifyClassification = type('"linked" | "not-a-requirement" | "merged"');

const InitListEntry = type({
	phase: type("string"),
	items: type("string").array().atLeastLength(1),
});

const todoSchema = type({
	op: TodoOp,
	"list?": InitListEntry.array().describe("phases for init"),
	"task?": type("string").describe("verbatim task content"),
	"phase?": type("string"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": type("string").array().describe("tasks for flat init or append"),
	"reason?": type("string").describe(
		"blocker note for block; required reason when classify uses classification not-a-requirement",
	),
	"id?": type("string").describe("requirement id (Rn) for classify"),
	"classification?": ClassifyClassification.describe(
		"classify decision: linked needs rows, not-a-requirement needs reason, merged needs mergeInto",
	),
	"rows?": type("string").array().describe("exact todo row contents for classify linked"),
	"mergeInto?": type("string").describe("target Rn for classify merged"),
});

type TodoParams = TodoSchema;
type TodoSchema = typeof todoSchema.infer;
/** A single todo op entry (the params object itself). */
type TodoOpEntryValue = TodoParams;

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

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	return structuredClone(task);
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function bindArtifactCwd(task: TodoItem, artifactCwd?: string): void {
	if (artifactCwd) {
		task.artifactCwd = artifactCwd;
		task.artifactOwner = "main";
	}
}

export interface RequirementRowArtifact {
	cwd: string;
	head: string | null;
	dirty: boolean;
}

export interface RequirementRowArtifactContext {
	cwd: string;
	sessionManager?: { getBranch(): SessionEntry[] };
	getAsyncJobSnapshot?: () => { running?: readonly { id: string; agentId?: string }[] } | undefined;
	signal?: AbortSignal;
}

const ABSOLUTE_ARTIFACT_PATH = /\/(?:home|srv|tmp|var|mnt|workspaces|Users)\/[^\s"'`),;]+/g;

function unknownRequirementArtifact(cwd: string): RequirementRowArtifact {
	return { cwd, head: null, dirty: true };
}

/** Resolve a row's persisted checkout, then read its current HEAD and dirty state without blocking the CLI. */
export async function getRequirementRowArtifact(
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
		let historical: TodoItem | undefined;
		let ambiguous = false;
		observeLatestTodoPhases(ctx.sessionManager.getBranch(), snapshot => {
			let match: TodoItem | undefined;
			for (const phase of snapshot) {
				for (const candidate of phase.tasks) {
					if (candidate.content !== row) continue;
					if (match) {
						ambiguous = true;
						return;
					}
					match = candidate;
				}
			}
			if (match) {
				historical = cloneTask(match);
				ambiguous = false;
			}
		});
		if (ambiguous) return unknownRequirementArtifact(`duplicate historical TODO row ${JSON.stringify(row)}`);
		if (historical?.status === "completed") task = historical;
	}
	if (!task) return unknownRequirementArtifact("unknown row");

	const schedule = (task as TodoItem & { schedule?: unknown }).schedule;
	const metadata = isRecord(schedule) ? schedule : undefined;
	const owner = typeof metadata?.owner === "string" ? metadata.owner : undefined;
	const resources = Array.isArray(metadata?.resources) ? metadata.resources : [];
	const paths: string[] = [];
	const branchNames: string[] = [];
	for (const resource of resources) {
		if (typeof resource !== "string") continue;
		const value = resource.trim();
		if (isAbsolute(value)) paths.push(value);
		else paths.push(...(value.match(ABSOLUTE_ARTIFACT_PATH) ?? []));
		const branch = /^(?:branch:|branch=|refs\/heads\/)(.+)$/.exec(value)?.[1];
		if (branch) branchNames.push(branch);
	}
	if (new Set(branchNames).size > 1) return unknownRequirementArtifact(`ambiguous branches ${branchNames.join(", ")}`);
	if (new Set(paths).size > 1) return unknownRequirementArtifact(paths.join(", "));

	const running = archived ? [] : (ctx.getAsyncJobSnapshot?.()?.running ?? []);
	const activeJob = owner === undefined ? undefined : running.find(job => job.id === owner || job.agentId === owner);
	const registry = AgentRegistry.global();
	let agent = archived || owner === undefined ? undefined : registry.get(owner);
	if (!agent && activeJob?.agentId) agent = registry.get(activeJob.agentId);
	if (!agent && !archived) {
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
	const effectiveOwner = owner ?? "main";
	const persistedCwd =
		typeof task.artifactCwd === "string" && isAbsolute(task.artifactCwd) && task.artifactOwner === effectiveOwner
			? task.artifactCwd
			: undefined;
	const ownerCwd =
		owner === "main"
			? archived || paths.length || persistedCwd
				? undefined
				: ctx.cwd
			: agent?.session?.sessionManager.getCwd();
	// A reassigned worker whose checkout is not known must not inherit the row's initial main checkout.
	if (
		!archived &&
		owner &&
		owner !== "main" &&
		!ownerCwd &&
		!persistedCwd &&
		paths.length === 0 &&
		branchNames.length === 0
	) {
		return unknownRequirementArtifact(`unknown checkout for owner ${JSON.stringify(owner)}`);
	}
	if (branchNames.length > 0) {
		const anchor =
			ownerCwd ??
			paths[0] ??
			(typeof task.artifactCwd === "string" && isAbsolute(task.artifactCwd) ? task.artifactCwd : undefined);
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
	if (uniquePaths.length > 1) return unknownRequirementArtifact(uniquePaths.join(", "));
	const path = uniquePaths[0] ?? ownerCwd ?? persistedCwd;
	if (!path)
		return unknownRequirementArtifact(
			`unknown artifact mapping for ${JSON.stringify(row)} (owner ${JSON.stringify(owner ?? null)})`,
		);

	let cwd = path;
	try {
		if (!(await stat(path)).isDirectory()) cwd = dirname(path);
	} catch {
		return unknownRequirementArtifact(path);
	}
	const repo = vcs.git(cwd);
	if (!repo) return unknownRequirementArtifact(cwd);
	const repoRoot = repo.info().repoRoot;
	if (ownerCwd && cwd !== ownerCwd && vcs.git(ownerCwd)?.info().repoRoot !== repoRoot) {
		return unknownRequirementArtifact(`${cwd}, ${ownerCwd} (ambiguous owner mapping)`);
	}
	let current = checkoutCache?.get(repoRoot);
	if (!current) {
		current = Promise.all([repo.headSha(ctx.signal), repo.statusPorcelain({ untracked: "all" }, ctx.signal)])
			.then(([head, status]) => ({ cwd: repoRoot, head: head ?? null, dirty: status.length > 0 }))
			.catch(() => unknownRequirementArtifact(repoRoot));
		checkoutCache?.set(repoRoot, current);
	}
	return current;
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
	if (!artifact.head || artifact.dirty || !ctx.sessionManager) return artifact;
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

	const currentPhases = getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch());
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
		current.status !== original.status ||
		JSON.stringify((current as TodoItem & { schedule?: unknown }).schedule) !==
			JSON.stringify((original as TodoItem & { schedule?: unknown }).schedule) ||
		current.artifactCwd !== original.artifactCwd ||
		current.artifactOwner !== original.artifactOwner
	) {
		return unknownRequirementArtifact(`TODO row ${JSON.stringify(row)} changed during artifact binding`);
	}
	const owner = (original as TodoItem & { schedule?: { owner?: unknown } }).schedule?.owner;
	const artifactOwner = typeof owner === "string" ? owner : "main";
	if (original.artifactCwd === artifact.cwd && original.artifactOwner === artifactOwner) return artifact;
	current.artifactCwd = artifact.cwd;
	current.artifactOwner = artifactOwner;
	pi.appendEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: currentPhases });
	return artifact;
}

export interface TodoCompletionSelector {
	task?: string;
	phase?: string;
	items?: string[];
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

function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

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
			tasks: phase.tasks.map(task =>
				task.blocker === undefined
					? { content: task.content, status: task.status }
					: { content: task.content, status: task.status, blocker: task.blocker },
			),
		})),
	);
}

function canonicalTodoPhases(entry: SessionEntry): TodoPhase[] | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
		const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
		return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
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
	return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
}

/** Identify the latest durable canonical todo snapshot on the active branch. */
export function getLatestTodoSnapshotIdentity(entries: SessionEntry[]): TodoSnapshotIdentity | undefined {
	let latest: TodoPhase[] | undefined;
	let sourceEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) {
			latest = phases;
			sourceEntryId = entries[i].id;
			break;
		}
	}
	if (!latest || !sourceEntryId) return undefined;
	return { sourceEntryId, fingerprint: todoPhasesFingerprint(latest) };
}

/** Return the persisted HUD choice only when it targets the current canonical snapshot exactly. */
export function getTodoHudVisibility(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
): TodoHudVisibility | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
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
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	return { ...snapshot, visibility };
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) return clonePhases(phases);
	}
	return [];
}

/** Walk every canonical snapshot on the branch in order, then return the active phases. */
export function observeLatestTodoPhases(
	entries: SessionEntry[],
	onSnapshot: (phases: readonly TodoPhase[]) => void,
): TodoPhase[] {
	let latest: TodoPhase[] | undefined;
	for (const entry of entries) {
		const phases = canonicalTodoPhases(entry);
		if (!phases) continue;
		onSnapshot(phases);
		latest = phases;
	}
	return latest ? clonePhases(latest) : [];
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

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntryValue, errors: string[], artifactCwd?: string): TodoPhase[] {
	// Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
	// (optionally with a bare `phase`) instead of the canonical
	// `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
	// so a common, recoverable mistake isn't a hard error.
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// Duplicate phase names / task contents would be permanently unaddressable
	// (every targeting op resolves the first match), so reject them up front.
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		if (seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		}
		seenPhases.add(listEntry.phase);
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
		}
	}
	return list.map(listEntry => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>(content => {
			const task: TodoItem = { content, status: "pending" };
			bindArtifactCwd(task, artifactCwd);
			return task;
		}),
	}));
}

function appendItems(
	phases: TodoPhase[],
	entry: TodoOpEntryValue,
	errors: string[],
	artifactCwd?: string,
): TodoPhase[] {
	if (!entry.phase) {
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

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		const task: TodoItem = { content, status: "pending" };
		bindArtifactCwd(task, artifactCwd);
		phase.tasks.push(task);
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[], artifactCwd?: string): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors, artifactCwd);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
					}
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "block": {
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// Collapse whitespace runs (incl. newlines) to single spaces: a blocker
			// note rides on one Markdown checklist line (as a trailing HTML comment)
			// and one HUD/summary line, so an embedded newline from a multi-line
			// external error or user question would corrupt the round-trip parse and
			// the rendered line. Normalizing here keeps every consumer one-line-safe.
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				// Only actionable open work can be blocked: blocking a phase must not
				// reopen completed/abandoned tasks or erase finished progress. An
				// already-blocked task stays eligible so a later block can refine its
				// blocker note (e.g. first blocked without a reason, then with one).
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				task.status = "blocked";
				task.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
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
			return appendItems(phases, entry, errors, artifactCwd);
		case "view":
			return phases;
		case "classify":
			// Handled on raw args before schema resolution in execute(); never reaches applyParams.
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
	artifactCwd?: string,
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const next = applyEntry(phases, params, errors, artifactCwd);
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpEntryValue[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = clonePhases(currentPhases);
	for (const op of ops) {
		next = applyEntry(next, op, errors);
	}
	normalizeInProgressTask(next);
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

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		for (const task of phases[i].tasks) {
			// A blocked task's reason rides in a trailing HTML comment: invisible in
			// rendered markdown, unambiguous to parse back (task content can't
			// contain the comment delimiters), so the note survives `/todo edit` and
			// export/import round-trips.
			const blockerNote = task.status === "blocked" && task.blocker ? ` <!-- blocker: ${task.blocker} -->` : "";
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}${blockerNote}`);
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
			// Recover a blocked task's reason from its trailing HTML comment (see
			// phasesToMarkdown), then strip the comment from the visible content.
			const rawContent = taskMatch[2].trim();
			const blockerMatch = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(rawContent);
			if (status === "blocked" && blockerMatch) {
				currentPhase.tasks.push({ content: blockerMatch[1].trim(), status, blocker: blockerMatch[2].trim() });
			} else {
				currentPhase.tasks.push({ content: rawContent, status });
			}
			continue;
		}

		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}

	normalizeInProgressTask(phases);
	return { phases, errors };
}

function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) {
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

	let currentIdx = phases.findIndex(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
		}
	}
	// Closed = completed + abandoned, mirroring the per-phase `done` count.
	const closedAll = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const blockedAll = tasks.filter(task => task.status === "blocked").length;
	// The active phase is the EARLIEST one still holding open work, so the
	// in-progress pointer can sit in a phase whose successors already have
	// completed tasks. Detect that "worked ahead" case to explain the
	// otherwise-surprising backward pointer instead of letting it read as a
	// completed task reverting to pending.
	const workedAhead = phases.some(
		(phase, idx) =>
			idx > currentIdx && phase.tasks.some(task => task.status === "completed" || task.status === "abandoned"),
	);
	lines.push(
		`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
			workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? task.blocker
								? ` (blocked: ${task.blocker})`
								: " (blocked)"
							: "";
			lines.push(`    - ${checkbox} ${task.content}${tag}`);
		}
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<typeof todoSchema, TodoToolDetails> {
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Track structured todos and classify requirements";
	readonly description: string;
	readonly parameters = todoSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	// Raw args reach execute() on schema failure; resolveTodoParams re-validates
	// and repairs the one recoverable shape (missing `op`, unambiguous payload).
	readonly lenientArgValidation = true;

	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const artifactCwd = this.session.cwd;
		let boundPhases: TodoPhase[] | undefined;
		const branch = this.session.sessionManager?.getBranch();
		if (branch) {
			for (let i = branch.length - 1; i >= 0; i--) {
				const phases = canonicalTodoPhases(branch[i]);
				if (!phases) continue;
				if (branch[i]?.type === "custom") boundPhases = phases;
				break;
			}
		}
		const previousPhases = clonePhases(boundPhases ?? this.session.getTodoPhases?.() ?? []);
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
		// classify already dispatched on rawOp above; narrow it out here so the
		// shared TodoOperation contract stays at base text.
		if (entry.op === "classify") return this.#classify(params, previousPhases, storage);
		const op = entry.op;
		// Pure-view calls are reads: no normalization, no state write.
		const readOnly = op === "view";
		const { phases: updated, errors } = readOnly
			? { phases: previousPhases, errors: [] as string[] }
			: applyParams(clonePhases(previousPhases), entry, artifactCwd);
		// A batch with any error is discarded wholesale: persisting a
		// half-applied batch makes the natural retry hit "already exists" for
		// the ops that did land. State and rendered summary stay at previous.
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const details: TodoToolDetails = { op, phases: effective, storage };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;

		return {
			content: [{ type: "text", text: formatSummary(effective, errors, readOnly) }],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}

	/** #41's done gate: the extension and direct native path share the same
	 *  target and fresh-artifact checks before a `done` batch can commit. */
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
			const targetRows = new Set<string>();
			for (const target of targets) targetRows.add(target.content);
			const requirements = getLatestRequirements(sessionManager.getBranch());
			const applicable = requirements.filter(
				requirement => requirement.classification === "linked" && requirement.rows.some(row => targetRows.has(row)),
			);
			const artifacts = new Map<string, Promise<RequirementRowArtifact>>();
			const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();
			for (const requirement of applicable) {
				const verdict = requirement.verdict;
				if (!verdict || verdict.status !== "pass" || verdict.auditor !== "qa-auditor") continue;
				for (const row of requirement.rows) {
					if (!artifacts.has(row)) {
						artifacts.set(
							row,
							getRequirementRowArtifact(
								{ cwd: this.session.cwd, sessionManager, signal },
								row,
								previousPhases,
								checkoutCache,
							),
						);
					}
				}
			}
			const unmet: string[] = [];
			for (const requirement of applicable) {
				const rowArtifacts = await Promise.all(
					requirement.rows.map(async row => {
						const artifact = await artifacts.get(row);
						return artifact ? { row, head: artifact.head, dirty: artifact.dirty } : null;
					}),
				);
				if (
					!isFreshRequirementVerdict(
						requirement,
						rowArtifacts.filter(item => item !== null),
					)
				) {
					const rows = requirement.rows.filter(row => targetRows.has(row));
					unmet.push(`${requirement.id} (${rows.map(row => JSON.stringify(row)).join(", ")})`);
				}
			}
			if (unmet.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: formatDoneGateRefusal(unmet),
						},
					],
					details: { op: "done", phases: previousPhases, storage },
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
						text: `Blocked: classify requires an Rn id and classification. Call todo with op="classify", id="<Rn>", classification="linked", rows=["<exact todo row>"] (or classification="not-a-requirement" with reason="<why this is not a requirement>", or classification="merged" with mergeInto="<other Rn>"). Then retry`,
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
						text: `Blocked: classify requires persistent session storage. Retry the same call todo with op="classify", id="${id ?? "<Rn>"}", classification="<linked|not-a-requirement|merged>" in a persisted session`,
					},
				],
				details,
				isError: true,
			};
		}
		if (classification === "linked") {
			const unknownRows = (rows ?? []).filter(row => !findTaskByContent(previousPhases, row));
			if (unknownRows.length > 0) {
				const available = previousPhases.flatMap(phase => phase.tasks.map(task => JSON.stringify(task.content)));
				return {
					content: [
						{
							type: "text",
							text: `Blocked: unknown TODO rows for ${id}: ${unknownRows.map(row => JSON.stringify(row)).join(", ")}. Available rows: ${available.length > 0 ? available.join(", ") : '(none: first create one with todo op="append", items=["<exact todo row>"] (or op="init"))'}. Call todo with op="classify", id="${id}", classification="linked", rows=[<exact existing row>]. Then retry`,
						},
					],
					details,
					isError: true,
				};
			}
		}
		const requirements = getLatestRequirements(sessionManager.getBranch());
		const result = classifyRequirement(requirements, id, classification, {
			rows,
			reason,
			mergeInto,
		});
		if ("error" in result) return { content: [{ type: "text", text: result.error }], details, isError: true };
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
