import {
	type TodoStatus,
	type TodoOperation,
	type TodoItem,
	type TodoPhase,
	type TodoCompletionTransition,
	type TodoToolDetails,
} from "@oh-my-pi/pi-tui/tools/todo";
import {
	forecastTodoPlan,
	formatPlanForecast,
	formatPlanForecastDisplay,
	formatTaskForecastDisplay,
	getTodoPlanningIssues,
	type TodoSchedule,
	type TodoPlanForecast,
	validateTodoDependencies,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";
import { cfgTaskMaxConcurrency } from "../task/settings";

import { normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { readGoalDeadline } from "../goals/deadlines";

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
 * for errors and pure `view` reads. A direct call lands these on the branch
 * through its own toolResult entry; a caller that produces no `todo`
 * toolResult (the eval bridge) must persist them itself or the next branch
 * rehydration (resume, rewind, fork, /btw) silently reverts the change.
 */
export function committedTodoPhases(result: AgentToolResult): TodoPhase[] | undefined {
	if (result.isError || !isRecord(result.details)) return undefined;
	const { op, phases } = result.details;
	if (op === "view" || !Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
	return phases;
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
	"dependencies?": type("string").array(),
	"owner?": type("string"),
	"resources?": type("string").array(),
	"estimate?": TodoEstimateInput,
	"evidence?": type("string"),
});

const InitListEntry = type({
	phase: type("string"),
	items: type("string").array().atLeastLength(1),
});

const todoSchema = type({
	op: TodoOp,
	"list?": InitListEntry.array().describe("phases for init"),
	"task?": type("string").describe("verbatim task content"),
	"phase?": type("string").describe("phase name; with view, lists that whole phase including closed rows"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": type("string")
		.describe("task content")
		.array()
		.describe("tasks for single-phase init or append; exact task contents to close in one done/drop"),
	"reason?": type("string").describe(
		"required concise external blocker (max 160 normalized characters), naming its actor or condition",
	),
	"updates?": TodoScheduleUpdateInput.array().describe("atomic batch of task scheduling updates (schedule)"),
}).describe("apply a single todo operation");

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
		for (const task of phase.tasks) previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
	}
	for (const phase of updated) {
		for (const task of phase.tasks) {
			const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
			const enteredProgress = task.status === "in_progress" && previousStatus !== "in_progress";
			const enteredClosed =
				(task.status === "completed" || task.status === "abandoned") && previousStatus !== task.status;
			if (!enteredProgress && !enteredClosed) continue;
			const schedule: TodoSchedule = { ...task.schedule };
			if (enteredProgress) {
				schedule.startedAt = now;
				if (previousStatus === "completed" || previousStatus === "abandoned") delete schedule.finishedAt;
			}
			if (enteredClosed) schedule.finishedAt = now;
			task.schedule = schedule;
		}
	}
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
			tasks: phase.tasks.map(task => ({ ...task })),
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

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	let latest: TodoPhase[] | undefined;
	const completionTimes = new Map<string, number>();
	for (const entry of entries) {
		const phases = canonicalTodoPhases(entry);
		if (!phases) continue;
		latest = phases;
		const completedTasks = new Set<string>();
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.status === "completed") completedTasks.add(todoTransitionKey(phase.name, task.content));
			}
		}
		for (const key of completionTimes.keys()) if (!completedTasks.has(key)) completionTimes.delete(key);
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			toolName?: string;
			isError?: boolean;
			details?: { completedTasks?: unknown };
		};
		if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;
		if (!Array.isArray(message.details?.completedTasks)) continue;
		const timestamp = Date.parse(entry.timestamp);
		if (!Number.isFinite(timestamp)) continue;
		for (const transition of message.details.completedTasks) {
			if (!isRecord(transition) || typeof transition.phase !== "string" || typeof transition.content !== "string")
				continue;
			let matches = 0;
			let completed = false;
			for (const phase of phases) {
				if (phase.name !== transition.phase) continue;
				for (const task of phase.tasks) {
					if (task.content !== transition.content) continue;
					matches++;
					completed = task.status === "completed";
				}
			}
			if (matches === 1 && completed) {
				completionTimes.set(todoTransitionKey(transition.phase, transition.content), timestamp);
			}
		}
	}
	if (!latest) return [];
	const restored = clonePhases(latest);
	for (const phase of restored) {
		for (const task of phase.tasks) {
			if (task.status !== "completed" || Number.isFinite(task.schedule?.finishedAt)) continue;
			const finishedAt = completionTimes.get(todoTransitionKey(phase.name, task.content));
			if (finishedAt !== undefined) task.schedule = { ...task.schedule, finishedAt };
		}
	}
	return restored;
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
		tasks: listEntry.items.map<TodoItem>(content => ({ content, status: "pending" })),
	}));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
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
		phase.tasks.push({ content, status: "pending" });
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

/** Reuse the shared graph validator; unknown prerequisites remain forecast issues. */
function validateScheduleDependencyGraph(
	phases: TodoPhase[],
	scheduleOverrides: Map<TodoItem, TodoSchedule>,
	errors: string[],
): void {
	const candidatePhases = phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => {
			const schedule = scheduleOverrides.get(task) ?? task.schedule;
			return {
				content: task.content,
				status: task.status,
				...(task.blocker === undefined ? {} : { blocker: task.blocker }),
				...(schedule === undefined ? {} : { schedule }),
			};
		}),
	}));
	for (const issue of validateTodoDependencies(candidatePhases)) {
		if (
			issue.code === "dependencies-unknown" ||
			issue.code === "unresolved-prerequisite" ||
			issue.code === "abandoned-dependency" ||
			issue.code === "completed-dependency-history-unknown"
		)
			continue;
		errors.push(issue.message);
	}
}

function applyScheduleUpdates(
	phases: TodoPhase[],
	entry: TodoOpEntryValue,
	errors: string[],
	now: number,
): TodoPhase[] {
	const updates = entry.updates;
	if (!updates || updates.length === 0) {
		errors.push("schedule requires a non-empty updates array");
		return phases;
	}

	const initialErrorCount = errors.length;
	const tasksByContent = indexTasksByContent(phases);
	const seenUpdates = new Set<string>();
	const candidates = new Map<TodoItem, TodoSchedule>();
	for (const update of updates) {
		if (seenUpdates.has(update.task)) {
			errors.push(`Duplicate schedule update for task "${update.task}"`);
			continue;
		}
		seenUpdates.add(update.task);

		const targets = tasksByContent.get(update.task);
		if (!targets) {
			errors.push(`Task "${update.task}" not found; schedule tasks by exact content`);
			continue;
		}
		if (targets.length !== 1) {
			errors.push(`Task content "${update.task}" is not unique; schedule requires exact unique identity`);
			continue;
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
			targets[0].schedule && typeof targets[0].schedule === "object" ? targets[0].schedule : {},
		);
		if (update.dependencies !== undefined) schedule.dependencies = [...update.dependencies];
		if (update.owner !== undefined) {
			if (update.owner === "") delete schedule.owner;
			else schedule.owner = update.owner.trim();
		}
		if (update.resources !== undefined) schedule.resources = update.resources.map(resource => resource.trim());
		if (update.estimate) {
			schedule.reestimateCount = (schedule.reestimateCount ?? 0) + (schedule.estimate ? 1 : 0);
			schedule.estimateRevision = (schedule.estimateRevision ?? (schedule.estimate ? 1 : 0)) + 1;
			schedule.estimate = { ...update.estimate, basis: update.estimate.basis.trim(), updatedAt: now };
		}
		if (update.evidence?.trim()) schedule.progress = { at: now, evidence: update.evidence.trim() };
		candidates.set(targets[0], schedule);
	}

	if (errors.length > initialErrorCount) return phases;
	validateScheduleDependencyGraph(phases, candidates, errors);
	if (errors.length > initialErrorCount) return phases;
	for (const [task, schedule] of candidates) task.schedule = schedule;
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[], now = Date.now()): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			const planningIssues = getTodoPlanningIssues(phases);
			if (planningIssues.length > 0) {
				errors.push(
					`Cannot start work while plan repairs remain: ${planningIssues.map(issue => issue.message).join("; ")}`,
				);
				return phases;
			}
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
			for (const task of getBatchTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getBatchTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "block": {
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
			return applyScheduleUpdates(phases, entry, errors, now);
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
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const previous = clonePhases(phases);
	const next = applyEntry(phases, params, errors, now);
	if (params.op !== "schedule") normalizeInProgressTask(next);
	stampTaskTransitionTimes(previous, next, now);
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpEntryValue[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const previous = clonePhases(currentPhases);
	let next = clonePhases(currentPhases);
	const now = Date.now();
	for (const op of ops) {
		next = applyEntry(next, op, errors, now);
	}
	if (ops.some(op => op.op !== "schedule" && op.op !== "view")) normalizeInProgressTask(next);
	stampTaskTransitionTimes(previous, next, now);
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
	options: { now?: number; capacity?: number; all?: boolean } = {},
): string {
	const now = options.now ?? Date.now();
	const forecast = forecastTodoPlan(phases, {
		now,
		...(options.capacity === undefined ? {} : { capacity: options.capacity }),
	});
	const rows = new Map(forecast.rows.map(row => [row.content, row]));
	const lines = [formatPlanForecastDisplay(forecast, now)];
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
): string {
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
): string {
	const tasks = phases.flatMap(phase => phase.tasks);
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

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<typeof todoSchema, TodoToolDetails> {
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Write a structured todo list to track progress within a session";
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
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const resolved = resolveTodoParams(params, previousPhases.length > 0);
		if (typeof resolved === "string") {
			return {
				content: [{ type: "text", text: resolved }],
				details: { phases: previousPhases, storage },
				isError: true,
			};
		}
		const entry = resolved;
		const op = entry.op;
		const now = Date.now();
		const deadline = readGoalDeadline(this.session.sessionManager?.getBranch() ?? [], this.session.cwd, {
			includePaused: true,
		});
		// Pure-view calls are reads: no normalization, no state write.
		const readOnly = op === "view";
		const { phases: updated, errors } = readOnly
			? { phases: previousPhases, errors: [] as string[] }
			: applyParams(clonePhases(previousPhases), entry, now);
		// A batch with any error is discarded wholesale: persisting a
		// half-applied batch makes the natural retry hit "already exists" for
		// the ops that did land. State and rendered summary stay at previous.
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const forecast = forecastTodoPlan(effective, {
			now,
			capacity: cfgTaskMaxConcurrency.get(this.session.settings),
			...(deadline === undefined ? {} : { deadlineAt: deadline.deadlineAt }),
		});
		const details: TodoToolDetails = { op, phases: effective, storage, forecastAt: now, forecast };
		if (deadline) details.deadlineAt = deadline.deadlineAt;
		if (completedTasks.length > 0) details.completedTasks = completedTasks;

		const summary =
			op === "init" || readOnly
				? formatSummary(effective, errors, forecast, readOnly, now, readOnly ? entry.phase : undefined)
				: formatMutationSummary(op, previousPhases, effective, errors, forecast, now);
		return {
			content: [{ type: "text", text: summary }],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}
}
