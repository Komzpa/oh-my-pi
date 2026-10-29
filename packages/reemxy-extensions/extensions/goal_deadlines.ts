// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { selectBranchEntries, selectLatestBranchEntry } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncateMiddleToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { todoMatchesAnyDescription } from "@oh-my-pi/pi-tui/tools/todo";
import { prompt } from "@oh-my-pi/pi-utils";
import gateNotices from "./gate-notices.md" with { type: "text" };
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { isTodoSelectionEntryMetadata } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { SettingsManager } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import type { ActiveGoalRef, DeadlineState, QuotaSnapshot } from "./deadlines";
import * as deadlineSdk from "./deadlines";
import wrapUpInstructions from "./goal-deadline-wrap-up.md" with { type: "text" };
import { appendTimedNote } from "./lead_time_notes";

export const REMINDER_MAX_CHARS = 800;

export function isDeadlineStateEntryMetadata(metadata: SessionContextEntryMetadata): boolean {
	return (metadata.type === "custom" && metadata.customType === deadlineSdk.STATE_ENTRY) ||
		(metadata.type === "message" && metadata.toolName === "goal_deadline");
}

export function isGoalLifecycleEntryMetadata(metadata: SessionContextEntryMetadata): boolean {
	return metadata.type === "mode_change" ||
		(metadata.type === "custom" && (metadata.customType === "pi-goal-focus" || metadata.customType === "pi-goal-state"));
}

export function latestDeadlineStateEntries(ctx: ExtensionContext) {
	const entry = selectLatestBranchEntry(ctx.sessionManager, isDeadlineStateEntryMetadata);
	return entry ? [entry] : [];
}

function userEntries(ctx: ExtensionContext) {
	return selectBranchEntries(ctx.sessionManager, metadata => metadata.type === "message" && metadata.messageRole === "user");
}

const PRESENCE_DEFAULTS = {
	activeMinutes: 15,
	awayMinutes: 30,
	quietStartHour: 23,
	quietEndHour: 9,
	atRiskMinutes: 60,
};

type PresenceSettings = Partial<typeof PRESENCE_DEFAULTS>;

function readPresenceSettings(value: unknown): PresenceSettings {
	if (!value || typeof value !== "object") return {};
	const settings = value as PresenceSettings;
	const result: PresenceSettings = {};
	if (Number.isFinite(settings.activeMinutes)) result.activeMinutes = Math.max(0, settings.activeMinutes!);
	if (Number.isFinite(settings.awayMinutes)) result.awayMinutes = Math.max(0, settings.awayMinutes!);
	if (Number.isInteger(settings.quietStartHour)) result.quietStartHour = ((settings.quietStartHour! % 24) + 24) % 24;
	if (Number.isInteger(settings.quietEndHour)) result.quietEndHour = ((settings.quietEndHour! % 24) + 24) % 24;
	if (Number.isFinite(settings.atRiskMinutes)) result.atRiskMinutes = Math.max(0, settings.atRiskMinutes!);
	return result;
}

function presenceSettings(cwd?: string): typeof PRESENCE_DEFAULTS {
	const settings = SettingsManager.create(cwd);
	return {
		...PRESENCE_DEFAULTS,
		...readPresenceSettings(settings.getGlobalSettings().reemxyPresence),
		...readPresenceSettings(settings.getProjectSettings().reemxyPresence),
	};
}

function presenceTimeZone(state: DeadlineState | null): string {
	return deadlineSdk.resolveTimeZone(state?.timezone);
}

export type Presence = "away" | "watching" | "firefighting";

type PresenceLocalTime = { hour: number; minute: number; weekend: boolean; display: string };
type PresenceDeadline = { dueAt: number; state: "on track" | "at risk" | "missed"; display: string };

function presenceLocalTime(now: number, timeZone: string): PresenceLocalTime {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	}).formatToParts(new Date(now));
	const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
	const weekday = values.weekday ?? "";
	return {
		hour: Number(values.hour),
		minute: Number(values.minute),
		weekend: weekday === "Sat" || weekday === "Sun",
		display: `${values.hour ?? "??"}:${values.minute ?? "??"} ${timeZone}`,
	};
}

function latestUserMessageAt(entries: readonly unknown[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as {
			type?: unknown;
			timestamp?: unknown;
			message?: { role?: unknown; timestamp?: unknown };
		};
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const timestamp = entry.timestamp ?? entry.message.timestamp;
		const milliseconds =
			typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
		if (Number.isFinite(milliseconds)) return milliseconds;
	}
	return undefined;
}

function presenceDeadline(
	state: DeadlineState | null,
	now: number,
	timeZone: string,
	settings: typeof PRESENCE_DEFAULTS,
): PresenceDeadline | undefined {
	if (!state?.active || state.stages.length === 0) return undefined;
	const dueAt = (state.baselineDeadlineAt ?? Math.max(...state.stages.map(stage => stage.deadlineAt))) * 1_000;
	if (!Number.isFinite(dueAt)) return undefined;
	const stateName = dueAt <= now ? "missed" : dueAt - now <= settings.atRiskMinutes * 60_000 ? "at risk" : "on track";
	const display = deadlineSdk.formatLocalClock(dueAt, timeZone);
	return { dueAt, state: stateName, display };
}

export function derivePresence(
	entries: readonly unknown[],
	state: DeadlineState | null,
	now = Date.now(),
	settings = presenceSettings(),
): Presence {
	const timeZone = presenceTimeZone(state);
	const local = presenceLocalTime(now, timeZone);
	const lastMessageAt = latestUserMessageAt(entries);
	const ageMinutes =
		lastMessageAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, (now - lastMessageAt) / 60_000);
	const deadline = presenceDeadline(state, now, timeZone, settings);
	const recent = ageMinutes <= settings.activeMinutes;
	const quietHours = local.hour >= settings.quietStartHour || local.hour < settings.quietEndHour;
	if (ageMinutes >= settings.awayMinutes || (ageMinutes >= settings.activeMinutes && quietHours)) return "away";
	if (recent && (deadline?.state === "at risk" || deadline?.state === "missed") && (quietHours || local.weekend))
		return "firefighting";
	return "watching";
}

export function renderPresence(
	entries: readonly unknown[],
	state: DeadlineState | null,
	now = Date.now(),
	settings = presenceSettings(),
): string {
	const timeZone = presenceTimeZone(state);
	const local = presenceLocalTime(now, timeZone);
	const lastMessageAt = latestUserMessageAt(entries);
	const ageMinutes =
		lastMessageAt === undefined ? "unknown" : String(Math.max(0, Math.floor((now - lastMessageAt) / 60_000)));
	const deadline = presenceDeadline(state, now, timeZone, settings);
	const presence = derivePresence(entries, state, now, settings);
	const deadlineSignal = deadline ? `${deadline.display} ${deadline.state}${deadline.state === "missed" ? ` at ${deadline.display}, by ${Math.floor((now - deadline.dueAt) / 60_000)}m` : ""}` : "not set";
	const signals = `last message ${ageMinutes} min ago, ${local.display}, deadline ${deadlineSignal}`;
	return `The user is: ${presence} (guess from signals: ${signals}) — the user's own words in the conversation outrank this guess.`;
}
const MAX_REASONABLE_DEADLINE_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z


function deadlineGateError(action: string, detail: string): Error {
	return new Error(`${action.replace(/\s+/g, " ").slice(0, 100)}\n${detail}`);
}

function isUnixSeconds(value: number): boolean {
	return Number.isSafeInteger(value) && value <= MAX_REASONABLE_DEADLINE_SECONDS;
}

function bounded(value: string, chars: number): string {
	return value.length <= chars ? value : value.slice(0, chars);
}

export function remainingPercent(start: number, due: number, now: number): number | null {
	if (due <= start) return null;
	if (now >= due) return 0;
	return Math.max(0, Math.min(100, Math.floor(((due - now) * 100) / (due - start))));
}

function duration(seconds: number): string {
	const absolute = Math.abs(Math.trunc(seconds));
	return `${Math.floor(absolute / 3600)}h${String(Math.floor(absolute / 60) % 60).padStart(2, "0")}m`;
}

function deadline(due: number, start: number, now: number, timezone?: string): string {
	const delta = due - now;
	const percent = remainingPercent(start, due, now);
	const clock = deadlineSdk.formatLocalTimestamp(due * 1000, timezone);
	return `${clock} ${delta < 0 ? "overdue" : "left"} ${duration(delta)} (${percent ?? "n/a"}%)`;
}

type TodoPhasesLike = ReadonlyArray<{ tasks: ReadonlyArray<{ content: string; status: string }> }>;

/** Open (not completed/abandoned) TODO rows when the session has any, else undelivered stage labels. */
export function remainingWork(state: DeadlineState, phases?: TodoPhasesLike): string[] {
	const rows = (phases ?? []).flatMap(phase =>
		phase.tasks.filter(task => task.status !== "completed" && task.status !== "abandoned").map(task => task.content),
	);
	return rows.length ? rows : state.stages.filter(stage => stage.deliveredAt === undefined).map(stage => stage.label);
}

export function renderDeadlineReminder(
	state: DeadlineState,
	now: number,
	currentQuota?: QuotaSnapshot,
	phases?: TodoPhasesLike,
): string | null {
	if (!state.active) return null;
	if (
		!isUnixSeconds(state.goalStartedAt) ||
		state.stages.some(stage => !isUnixSeconds(stage.deadlineAt)) ||
		(state.baselineDeadlineAt !== undefined && !isUnixSeconds(state.baselineDeadlineAt))
	)
		return null;
	if (deadlineSdk.isUserDeadlineMissed(state, now)) {
		const due = state.baselineDeadlineAt!;
		const overdue = Math.floor((now - due) / 60);
		const remaining = remainingWork(state, phases);
		return [
			`MISSED by ${overdue}m: deadline ${deadlineSdk.formatLocalClock(due * 1_000, state.timezone)}. Remaining: ${remaining.length ? remaining.join(", ") : "verify and report the requested deliverable"}.`,
			wrapUpInstructions.trim(),
			state.userConstraint?.statusSentAt === undefined
				? "Send one honest status message to the user now: best verified state and unfinished work."
				: "The wrap-up status was already sent; do not send it again without a new user request or new verified delivery.",
		].join("\n");
	}
	const pending = state.stages
		.filter(stage => stage.deliveredAt === undefined)
		.sort((a, b) => a.deadlineAt - b.deadlineAt);
	if (pending.length === 0) return null;
	const current = pending[0]!;
	const finalDue = state.baselineDeadlineAt ?? Math.max(...state.stages.map(stage => stage.deadlineAt));
	const overdue = pending.filter(stage => stage.deadlineAt < now).length;
	const latest = state.stages
		.filter(stage => stage.deliveredAt !== undefined)
		.sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0))[0];
	const quota = currentQuota
		? `Quota shared, not reserved: ${currentQuota.provider} start=${state.initialQuota?.remainingPercent ?? "unknown"}% now=${currentQuota.remainingPercent ?? "unknown"}% status=${currentQuota.status} as-of=${currentQuota.sourceAsOf ?? "unknown"}.`
		: "Quota now=unknown; do not infer capacity.";
	const text = [
		"Deliver usable work; reserve review time; delegate bounded cheap tasks when authorized. Adjust depth to time/quota. Overdue is not a verdict: floor it and catch up; show the latest artifact or say none.",
		...(state.auto ? ["Deadline set automatically from the TODO plan forecast."] : []),
		`Goal=${bounded(state.goalId, 64)} start=${deadlineSdk.formatLocalTimestamp(state.goalStartedAt * 1000, state.timezone)} now=${deadlineSdk.formatLocalTimestamp(now * 1000, state.timezone)} tz=${bounded(state.timezone, 40)}.`,
		`Next=${bounded(current.label, 80)}; ${deadline(current.deadlineAt, state.goalStartedAt, now, state.timezone)}; expected=${bounded(current.expectedResult, 160)}.`,
		`Final=${deadline(finalDue, state.goalStartedAt, now, state.timezone)}; overdue=${overdue}.`,
		quota,
		`Latest artifact=${bounded(latest?.deliveredArtifact ?? "none recorded", 120)}.`,
	].join("\n");
	return text.length <= REMINDER_MAX_CHARS
		? text
		: `${text.slice(0, REMINDER_MAX_CHARS - 26)}\n[More: goal_deadline.]`;
}

/**
 * With an open TODO plan the TODO header already prints "ETA … · due … (overdue …)" for the same
 * deadline, so the footer keeps only what the header lacks: the stage name and its expected result.
 */
export function renderDeadlineUi(state: DeadlineState, now: number, todoShowsDue = false): string[] {
	const pending = state.stages
		.filter(stage => stage.deliveredAt === undefined)
		.sort((a, b) => a.deadlineAt - b.deadlineAt);
	if (
		!state.active ||
		pending.length === 0 ||
		!isUnixSeconds(state.goalStartedAt) ||
		state.stages.some(stage => !isUnixSeconds(stage.deadlineAt)) ||
		(state.baselineDeadlineAt !== undefined && !isUnixSeconds(state.baselineDeadlineAt))
	)
		return [];
	const current = pending[0]!;
	const finalDue = state.baselineDeadlineAt ?? Math.max(...state.stages.map(stage => stage.deadlineAt));
	const final =
		finalDue === current.deadlineAt ? "" : ` · final ${deadline(finalDue, state.goalStartedAt, now, state.timezone)}`;
	if (todoShowsDue) return [`Goal · ${current.label} → ${bounded(current.expectedResult, 120)}${final}`];
	return [
		`Deadline · ${current.label}: ${deadline(current.deadlineAt, state.goalStartedAt, now, state.timezone)}`,
		// The final deadline is repeated only when a later stage still follows the current one.
		`Expected: ${bounded(current.expectedResult, 120)}${final}`,
	];
}

export function renderMissingScheduleReminder(goal: ActiveGoalRef): string {
	return `[GOAL DEADLINES goalId=${bounded(goal.id, 64)}]\nNo deadline schedule is recorded. If the user gave a delivery time, pass the wall-clock time from the user message as stages[].local_time (for example "19:00") with the timezone to goal_deadline(action=set); the tool computes the epoch and rejects a time already more than 5 minutes past as an arithmetic error, so tell the user instead of forcing it. Never invent a time, postpone it, or silently omit it. Otherwise continue without a schedule.`;
}

function readQuota(): QuotaSnapshot | undefined {
	try {
		const path = join(homedir(), ".local/share/tasks-loop/state/llm-usage-watch/watcher.json");
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { providers?: Record<string, unknown> };
		const raw = parsed.providers?.["codex-lb"] as Record<string, unknown> | undefined;
		if (!raw) return undefined;
		return {
			provider: "codex-lb",
			remainingPercent: typeof raw.remaining_percent === "number" ? raw.remaining_percent : null,
			status: typeof raw.status === "string" ? raw.status : "unknown",
			sourceAsOf: typeof raw.source_as_of === "string" ? raw.source_as_of : null,
			recoveryAt: typeof raw.recovery_at === "string" ? raw.recovery_at : null,
		};
	} catch {
		return undefined;
	}
}

const WALL_CLOCK = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})$/;
const SANITY_PAST_SECONDS = 5 * 60;
const SANITY_AHEAD_SECONDS = 7 * 24 * 3600;
const SAME_MESSAGE_CORRECTION_SECONDS = 30 * 60;
function zonedFields(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
	const f = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
	return { year: f.year!, month: f.month!, day: f.day!, hour: f.hour!, minute: f.minute!, second: f.second! };
}
function zoneOffsetMs(ms: number, timeZone: string): number {
	const f = zonedFields(ms, timeZone);
	return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1_000) * 1_000;
}
/** Resolve "19:00" (next such moment: today, else tomorrow) or "2026-10-21 19:00" in `timeZone` to Unix seconds. */
export function resolveWallClock(text: string, timeZone: string, nowMs: number): number | undefined {
	const match = WALL_CLOCK.exec(text.trim());
	if (!match) return undefined;
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	if (hour > 23 || minute > 59) return undefined;
	const at = (year: number, month: number, day: number) => {
		const wall = Date.UTC(year, month - 1, day, hour, minute);
		let utc = wall - zoneOffsetMs(wall, timeZone);
		utc = wall - zoneOffsetMs(utc, timeZone);
		return Math.floor(utc / 1_000);
	};
	if (match[1]) return at(Number(match[1]), Number(match[2]), Number(match[3]));
	const today = zonedFields(nowMs, timeZone);
	const candidate = at(today.year, today.month, today.day);
	if (candidate * 1_000 > nowMs) return candidate;
	const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
	return at(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate());
}

const OBJECTIVE_DEADLINE_CLOCK = /(?:^|\s)(?:by|before|until|до|к)\s+(\d{1,2}:\d{2})(?=\s|$|[.,;!?])/iu;

export function deadlineStateFromGoalObjective(
	goal: ActiveGoalRef | null,
	entries: readonly unknown[],
	timeZone = deadlineSdk.resolveTimeZone(),
): DeadlineState | undefined {
	if (!goal?.objective || goal.status !== "active") return undefined;
	const clock = OBJECTIVE_DEADLINE_CLOCK.exec(goal.objective)?.[1];
	if (!clock) return undefined;
	const user = deadlineSdk.latestDeadlineUserMessage(entries, goal.objective);
	// A restart checkpoint can retain the native goal after the original user
	// message has fallen out of the selected branch. The objective remains the
	// authoritative explicit clock; anchor it at the persisted goal creation time.
	const recordedAt = user?.at ?? goal.createdAt;
	const deadlineAt = resolveWallClock(clock, timeZone, recordedAt * 1_000);
	if (deadlineAt === undefined) return undefined;
	return {
		version: 1,
		goalId: goal.id,
		goalStartedAt: goal.createdAt,
		timezone: timeZone,
		active: true,
		stages: [{ id: "user-goal-deadline", label: "Finish goal", expectedResult: goal.objective, deadlineAt }],
		baselineDeadlineAt: deadlineAt,
		userConstraint: { messageId: user?.id ?? `goal:${goal.id}`, quote: goal.objective, recordedAt },
	};
}

interface DeadlineToolParams {
	action: "set" | "deliver" | "status" | "clear";
	goal_id?: string;
	goal_started_at?: number;
	timezone?: string;
	stages?: Array<{ id: string; label: string; expected_result: string; deadline_at?: number; local_time?: string }>;
	stage_id?: string;
	delivered_artifact?: string;
	user_message?: string;
}

type TodoCompletionTask = { content: string; status: string };
type TodoCompletionPhase = { tasks: TodoCompletionTask[] };
type TodoCompletionReducer = (entries: unknown[]) => TodoCompletionPhase[];

function todoCompletionBlockReason(phases: TodoCompletionPhase[]): string | undefined {
	const counts = { pending: 0, inProgress: 0, blocked: 0, abandoned: 0, other: 0 };
	const names: string[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "completed") continue;
			if (task.status === "pending") counts.pending++;
			else if (task.status === "in_progress") counts.inProgress++;
			else if (task.status === "blocked") counts.blocked++;
			else if (task.status === "abandoned") counts.abandoned++;
			else counts.other++;
			if (names.length < 3) names.push(task.content.replace(/\s+/g, " ").trim().slice(0, 80));
		}
	}
	const total = counts.pending + counts.inProgress + counts.blocked + counts.abandoned + counts.other;
	if (total === 0) return undefined;
	const summary = [
		counts.pending > 0 ? `${counts.pending} pending` : undefined,
		counts.inProgress > 0 ? `${counts.inProgress} in progress` : undefined,
		counts.blocked > 0 ? `${counts.blocked} blocked` : undefined,
		counts.abandoned > 0 ? `${counts.abandoned} abandoned` : undefined,
		counts.other > 0 ? `${counts.other} with an unknown status` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(", ");
	const guidance = [
		counts.pending + counts.inProgress + counts.blocked > 0
			? "Resolve pending, in-progress, and blocked tasks first."
			: undefined,
		counts.abandoned > 0
			? "Abandoned tasks are not completion evidence; require explicit user disposition."
			: undefined,
		counts.other > 0 ? "Tasks with unknown status are not proof of completion." : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");
	const taskNames = names.filter(name => name.length > 0);
	const namedTasks = taskNames.length
		? ` Tasks: ${taskNames.join("; ")}${total > taskNames.length ? `; +${total - taskNames.length} more` : ""}.`
		: "";
	const firstTask = truncateMiddleToWidth(JSON.stringify((taskNames[0] ?? "the unresolved TODO list").replace(/\s+/g, " ")), 32);
	const action = `Resolve TODO task ${firstTask}${total > 1 ? ` (+${total - 1} more)` : ""} before completing this goal.`;
	return `${action.slice(0, 100)}\n${total} TODO task${total === 1 ? " is" : "s are"} unresolved (${summary}). ${guidance}${namedTasks}`;
}

export default function goalDeadlines(pi: ExtensionAPI): void {
	// Pure deadline readers are also available on hosts whose bundled barrel predates their exports.
	const sdk = typeof pi.pi?.rehydrateDeadlineState === "function" ? pi.pi : deadlineSdk;
	let state: DeadlineState | null = null;
	let activeGoal: ActiveGoalRef | null = null;
	// `_goalCore` has no public accessor; use it only before branch lifecycle is recorded.
	const goalCore = pi as unknown as { _goalCore?: { state?: { goal?: unknown } } };
	const currentGoal = (): ActiveGoalRef | null => sdk.goalRef(goalCore._goalCore?.state?.goal);
	const announcedGateNoticeKeys = new Set<string>();
	const announceDeadlineGate = (deadlineState: DeadlineState, missed: boolean, phases?: TodoPhasesLike) => {
		if (!deadlineState.userConstraint || deadlineState.baselineDeadlineAt === undefined) return;
		const phase = missed ? "missed" : "upcoming";
		const key = `${deadlineState.goalId}:${deadlineState.baselineDeadlineAt}:${phase}`;
		if (announcedGateNoticeKeys.has(key)) return;
		announcedGateNoticeKeys.add(key);
		const due = deadlineSdk.formatLocalClock(deadlineState.baselineDeadlineAt * 1_000, deadlineState.timezone);
		const overdueMinutes = Math.floor((Date.now() / 1_000 - deadlineState.baselineDeadlineAt) / 60);
		const remaining = remainingWork(deadlineState, phases).join(", ") || "verify and report the requested deliverable";
		const content = prompt.render(gateNotices, { deadline: true, missed, due, goal: deadlineState.goalId, overdueMinutes, remaining }).trim();
		pi.sendMessage?.(
			{ customType: "goal-deadline-gate-notice", content, display: false, attribution: "agent" },
			{ deliverAs: "nextTurn", triggerTurn: false, interruptWait: false },
		);
	};
	const announceCompletionGate = (ctx: ExtensionContext) => {
		if (activeGoal?.status !== "active") return;
		const livePhases = ctx.getTodoPhases?.();
		const host = pi.pi as unknown as { getLatestTodoPhasesFromEntries?: TodoCompletionReducer } | undefined;
		const reason = livePhases === undefined && typeof host?.getLatestTodoPhasesFromEntries !== "function"
			? "Restore the TODO reducer before completing this goal."
			: todoCompletionBlockReason(livePhases ?? host!.getLatestTodoPhasesFromEntries!(selectBranchEntries(ctx.sessionManager, isTodoSelectionEntryMetadata)));
		if (!reason) return;
		const key = `completion:${activeGoal.id}:${reason}`;
		if (announcedGateNoticeKeys.has(key)) return;
		announcedGateNoticeKeys.add(key);
		pi.sendMessage?.({ customType: "goal-completion-gate-notice", content: prompt.render(gateNotices, { completion: true, action: reason.split("\n")[0] }).trim(), display: false, attribution: "agent" }, { deliverAs: "nextTurn", triggerTurn: false, interruptWait: false });
	};
	const focusedGoal = (ctx: ExtensionContext): ActiveGoalRef | null => {
		const lifecycle = sdk.readFocusedGoal(selectBranchEntries(ctx.sessionManager, isGoalLifecycleEntryMetadata), ctx.cwd);
		return lifecycle === undefined ? currentGoal() : lifecycle;
	};

	const persist = () => pi.appendEntry(sdk.STATE_ENTRY, state);
	const bindObjectiveDeadline = (ctx: ExtensionContext) => {
		// An automatic plan must not hide the user's explicit objective clock.
		if (state?.userConstraint || !activeGoal || !ctx.sessionManager) return;
		const derived = deadlineStateFromGoalObjective(activeGoal, userEntries(ctx));
		if (!derived) return;
		state = derived;
		persist();
	};
	const missedWorkDemand = (ctx: ExtensionContext): string | undefined => {
		if (!deadlineSdk.isUserDeadlineMissed(state)) return undefined;
		const phases = ctx.getTodoPhases?.() ?? [];
		const open = remainingWork(state!, phases);
		if (!open.length) return undefined;
		return `The recorded deadline is missed. Replan the remaining requested work now, put the most valuable shippable piece first, and keep executing. Open rows: ${open.join("; ")}. Ship the next usable piece and report the verified delta.`;
	};
	const updateUi = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const deadlineState = state?.active && (state.userConstraint || (state.auto && activeGoal?.status !== "active") || (activeGoal?.status === "active" && activeGoal.id === state.goalId)) ? state : null;
		if (!deadlineState) {
			ctx.ui.setStatus("goal-deadline", derivePresence(userEntries(ctx), null));
			ctx.ui.setWidget("goal-deadline", undefined);
			return;
		}
		const host = pi.pi as unknown as { getLatestTodoPhasesFromEntries?: TodoCompletionReducer } | undefined;
		const phases = ctx.getTodoPhases?.() ?? (
			typeof host?.getLatestTodoPhasesFromEntries === "function"
				? host.getLatestTodoPhasesFromEntries(selectBranchEntries(ctx.sessionManager, isTodoSelectionEntryMetadata))
				: []);
		const todoShowsDue = (phases ?? []).some(phase =>
			phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
		);
		const lines = renderDeadlineUi(deadlineState, Math.floor(Date.now() / 1000), todoShowsDue);
		// The widget below the editor already shows the deadline; the status keeps presence brief.
		ctx.ui.setStatus("goal-deadline", derivePresence(userEntries(ctx), deadlineState));
		ctx.ui.setWidget("goal-deadline", lines, { placement: "belowEditor" });
	};
	const refresh = (ctx: ExtensionContext) => {
		activeGoal = focusedGoal(ctx);
		updateUi(ctx);
	};
	const load = (ctx: ExtensionContext) => {
		state = sdk.rehydrateDeadlineState(latestDeadlineStateEntries(ctx));
		activeGoal = focusedGoal(ctx);
		bindObjectiveDeadline(ctx);
		updateUi(ctx);
		announceCompletionGate(ctx);
	};
	pi.on("session_start", (_event, ctx) => load(ctx));
	pi.on("session_switch", (_event, ctx) => load(ctx));
	pi.on("session_branch", (_event, ctx) => load(ctx));
	pi.on("session_tree", (_event, ctx) => load(ctx));
	pi.on("session_compact", (_event, ctx) => load(ctx));
	pi.on("message_end", (event, ctx) => {
		if (!deadlineSdk.isUserDeadlineMissed(state) || state!.userConstraint!.statusSentAt !== undefined || event.message.role !== "assistant") return;
		const content = event.message.content;
		if (!Array.isArray(content) || content.some(part => part.type === "toolCall") || !content.some(part => part.type === "text" && part.text.trim())) return;
		state = { ...state!, userConstraint: { ...state!.userConstraint!, statusSentAt: Math.floor(Date.now() / 1_000) } };
		persist();
		updateUi(ctx);
	});
	pi.on("turn_end", async (event, ctx) => {
		announceCompletionGate(ctx);
		const gateDeadlineState = state?.active && (state.userConstraint || (state.auto && activeGoal?.status !== "active") || (activeGoal?.status === "active" && activeGoal.id === state.goalId)) ? state : null;
		if (gateDeadlineState?.userConstraint) announceDeadlineGate(gateDeadlineState, deadlineSdk.isUserDeadlineMissed(gateDeadlineState), ctx.getTodoPhases?.());
		const now = Date.now();
		const deadlineState = state?.active && (state.userConstraint || (state.auto && activeGoal?.status !== "active") || (activeGoal?.status === "active" && activeGoal.id === state.goalId)) ? state : null;
		const phases = ctx.getTodoPhases?.();
		const quota = deadlineState ? readQuota() : undefined;
		const reminder = deadlineState
			? renderDeadlineReminder(deadlineState, Math.floor(now / 1_000), quota, phases)
			: activeGoal?.status === "active" ? renderMissingScheduleReminder(activeGoal) : null;
		const presence = renderPresence(userEntries(ctx), deadlineState, now);
		const content = deadlineState?.userConstraint && deadlineSdk.isUserDeadlineMissed(deadlineState)
			? [reminder, presence].filter(Boolean).join("\n\n")
			: [presence, reminder].filter(Boolean).join("\n\n");
		if (content) {
			const remaining = phases?.flatMap(phase => phase.tasks.filter(task => task.status !== "completed" && task.status !== "abandoned").map(task => task.content));
			const semanticKey = JSON.stringify({
				goal: deadlineState ? {
					id: deadlineState.goalId,
					baselineDeadlineAt: deadlineState.baselineDeadlineAt,
					statusSentAt: deadlineState.userConstraint?.statusSentAt,
					stages: deadlineState.stages.map(stage => [stage.id, stage.label, stage.expectedResult, stage.deadlineAt, stage.deliveredAt]),
					remaining,
				} : null,
				activeGoal: activeGoal?.status === "active" ? [activeGoal.id, activeGoal.status] : null,
				deadlineStatus: deadlineState?.userConstraint ? deadlineSdk.isUserDeadlineMissed(deadlineState, now / 1_000) : null,
				presence: derivePresence(userEntries(ctx), deadlineState, now),
				quota: quota ? [quota.provider, quota.remainingPercent, quota.status] : null,
			});
			const workOpen = Boolean(reminder || remaining?.length);
			await appendTimedNote(pi, ctx, "goal-deadline-time-note", content, semanticKey, deadlineSdk.formatLocalClock(now, deadlineState?.timezone), workOpen, now);
		}
		if (event.toolResults.length > 0) return;
		const reason = missedWorkDemand(ctx);
		if (reason) pi.sendMessage?.({ customType: "goal-deadline-continue", content: reason, display: false, attribution: "agent" }, { deliverAs: "nextTurn", triggerTurn: true });
	});
	pi.on("session_stop", (_event, ctx) => {
		const reason = missedWorkDemand(ctx);
		if (reason) return { decision: "block", reason };
	});
	pi.on("goal_updated", (event, ctx) => {
		activeGoal = sdk.goalRef(event.goal);
		bindObjectiveDeadline(ctx);
		announceCompletionGate(ctx);
		updateUi(ctx);
	});

	pi.on("tool_call", (event, ctx) => {
		if ((event.toolName === "wait" || event.toolName === "stop") && missedWorkDemand(ctx))
			return { block: true, reason: missedWorkDemand(ctx) };
		if ((event.toolName === "task" || (event.toolName === "todo" && (event.input.op === "init" || event.input.op === "append"))) && deadlineSdk.isUserDeadlineMissed(state)) {
			const due = deadlineSdk.formatLocalClock(state!.baselineDeadlineAt! * 1_000, state!.timezone);
			const phases = ctx.getTodoPhases?.() ?? [];
			const openRows = phases.flatMap(phase => phase.tasks.filter(task => task.status !== "completed" && task.status !== "abandoned").map(task => task.content));
			const input = event.input as Record<string, unknown>;
			const proposals = event.toolName === "task"
				? (Array.isArray(input.tasks) ? input.tasks.map(task => typeof task === "string" ? task : [task?.name, task?.task].filter(Boolean).join(" ")) : [])
				: Array.isArray(input.items) ? input.items : Array.isArray(input.list) ? input.list.flatMap((phase: { items?: unknown[] }) => phase.items ?? []) : [];
			const servesOpenWork = proposals.length > 0 && proposals.every(item => typeof item === "string" && todoMatchesAnyDescription(item, openRows));
			if (!servesOpenWork)
				return { block: true, reason: deadlineGateError(`The ${due} deadline is missed.`, "Only add or delegate work that serves an open requested TODO row; replan it, then keep delivering.").message };
		}
		const isNativeCompletion = event.toolName === "goal" && event.input.op === "complete";
		const isPluginCompletion = event.toolName === "update_goal" && event.input.status === "complete";
		if (!isNativeCompletion && !isPluginCompletion) return;

		const livePhases = ctx.getTodoPhases?.();
		const host = pi.pi as unknown as { getLatestTodoPhasesFromEntries?: TodoCompletionReducer } | undefined;
		if (livePhases === undefined && typeof host?.getLatestTodoPhasesFromEntries !== "function") {
			return { block: true, reason: "Restore the TODO reducer before completing this goal.\nTODO closure cannot be verified without the host reducer." };
		}
		const reason = todoCompletionBlockReason(livePhases ?? host!.getLatestTodoPhasesFromEntries!(selectBranchEntries(ctx.sessionManager, isTodoSelectionEntryMetadata)));
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("context", (event, ctx) => {
		refresh(ctx);
		return { messages: event.messages };
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		activeGoal = focusedGoal(ctx);
		announceCompletionGate(ctx);
		if (state?.active && event.toolName === "update_goal_task") {
			const input = event.input as { task_id?: unknown; status?: unknown; evidence?: unknown };
			const stage =
				input.status === "complete" && typeof input.task_id === "string"
					? state.stages.find(item => item.id === input.task_id && item.deliveredAt === undefined)
					: undefined;
			if (stage) {
				stage.deliveredAt = Math.floor(Date.now() / 1000);
				stage.deliveredArtifact =
					typeof input.evidence === "string" && input.evidence.trim()
						? input.evidence.trim()
						: `Goal task ${input.task_id} completed`;
				persist();
			}
		}
		updateUi(ctx);
	});

	const z = pi.zod;
	pi.registerTool({
		name: "goal_deadline",
		label: "Goal Deadline",
		description:
			"Manage milestone deadlines and durable user delivery constraints. With no focused goal, action=set records the constraint in this same session owner. user_message is an exact quote from a real user message giving the deadline; the newest matching user message is used. The goal id, start time, and local timezone default from state or focus; never infer deadline times. Pass each stage's local_time as the wall-clock string from the user message ('19:00' or '2026-10-21 19:00') with timezone; the tool computes the Unix epoch itself (a bare HH:MM means the next such moment). deadline_at is a Unix timestamp in seconds, not milliseconds, and optional: used only as a cross-check, and a value that differs from local_time by more than a minute is rejected with the resolved value. A user deadline already more than 5 minutes past, or more than 7 days ahead, is rejected as an arithmetic error. Same-goal updates preserve receipts and final due time. Only a newer direct user quote can authorize a changed user constraint; a wrong value set from the same message can be corrected within 30 minutes by quoting it again. A promised status time is not authorization.",
		parameters: z.object({
			action: z.enum(["set", "deliver", "status", "clear"]),

			goal_id: z.string().optional(),
			goal_started_at: z.number().int().optional(),
			timezone: z.string().optional(),
			user_message: z.string().optional().describe("Exact quote from a real user message authorizing this action (for set, include its explicit local HH:MM time)."),
			stages: z
				.array(
					z.object({
						id: z.string(),
						label: z.string(),
						expected_result: z.string(),
						local_time: z
							.string()
							.optional()
							.describe('Wall-clock time from the user message in `timezone`: "19:00" (next such moment) or "2026-10-21 19:00". The tool computes the epoch.'),
						deadline_at: z
							.number()
							.int()
							.optional()
							.describe(
								"Optional cross-check: Unix timestamp in seconds, not milliseconds. Must match local_time within a minute; without local_time it is the deadline itself and must be no later than 2100-01-01T00:00:00Z.",
							),
					}),
				)
				.optional(),
			stage_id: z.string().optional(),
			delivered_artifact: z.string().optional(),
		}),
		async execute(_id, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as DeadlineToolParams;
			refresh(ctx);
			if (params.action === "set") {
				const user = deadlineSdk.latestDeadlineUserMessage(userEntries(ctx), params.user_message);
				const goalId = params.goal_id ?? activeGoal?.id ?? state?.goalId ?? "session-deadline";
				const goalStartedAt = params.goal_started_at ?? activeGoal?.createdAt ?? user?.at ?? Math.floor(Date.now() / 1_000);
				const timezone = deadlineSdk.resolveTimeZone(params.timezone ?? state?.timezone);
				if (!Number.isFinite(goalStartedAt) || !params.stages?.length)
					throw deadlineGateError("Provide a valid goal start time and at least one deadline stage.", "set requires non-empty stages and a valid start time");
				const nowSeconds = Math.floor(Date.now() / 1_000);
				params.stages = params.stages.map(stage => {
					if (stage.local_time === undefined) {
						if (stage.deadline_at === undefined)
							throw deadlineGateError(`Set local_time or deadline_at for stage ${truncateMiddleToWidth(stage.id, 28)}.`, `Stage ${stage.id} needs local_time (for example "19:00") or deadline_at.`);
						return stage;
					}
					const resolved = resolveWallClock(stage.local_time, timezone, Date.now());
					if (resolved === undefined)
						throw deadlineGateError(`Set a valid local_time for stage ${truncateMiddleToWidth(stage.id, 28)}.`, `local_time must look like "19:00" or "2026-10-21 19:00"; got ${JSON.stringify(stage.local_time)} for stage ${stage.id}.`);
					if (stage.deadline_at !== undefined && Math.abs(stage.deadline_at - resolved) > 60)
						throw deadlineGateError(`Use local_time for stage ${truncateMiddleToWidth(stage.id, 28)}; remove the conflicting deadline_at.`, `deadline_at ${stage.deadline_at} for stage ${stage.id} does not match local_time ${stage.local_time} ${timezone}; it resolves to ${resolved} (${new Date(resolved * 1_000).toISOString()}). Pass local_time and let the tool compute the epoch.`);
					return { ...stage, deadline_at: resolved };
				});
				if (activeGoal && goalId !== activeGoal.id)
					throw deadlineGateError(`Set goal_id to focused goal ${truncateMiddleToWidth(activeGoal.id, 28)}.`, `deadline goal ${goalId} does not match focused goal ${activeGoal.id}`);
				const stageIds = new Set(params.stages.map(stage => stage.id));
				const resolvedStages = params.stages as Array<{ id: string; label: string; expected_result: string; deadline_at: number }>;
				if (stageIds.size !== params.stages.length) throw deadlineGateError("Give every deadline stage a unique id.", "stage ids must be unique");
				for (const stage of resolvedStages) {
					if (!Number.isSafeInteger(stage.deadline_at))
						throw deadlineGateError(`Pass Unix seconds for stage ${truncateMiddleToWidth(stage.id, 28)}.`, `deadline_at for stage ${stage.id} must be Unix seconds (integer), not milliseconds`);
					if (!isUnixSeconds(stage.deadline_at))
						throw deadlineGateError(`Set a valid Unix-second deadline for stage ${truncateMiddleToWidth(stage.id, 28)}.`, `deadline_at for stage ${stage.id} must be Unix seconds (10-digit timestamp for current dates), not milliseconds, and no later than 2100-01-01T00:00:00Z`);
				}
				const finalDue = Math.max(...resolvedStages.map(stage => stage.deadline_at));
				const quote = params.user_message ?? user?.text;
				if (params.user_message && !user)
					throw deadlineGateError("Quote the latest real user message in user_message.", "user_message must quote the latest real user message");
				const userTime = user && quote && quote.includes(deadlineSdk.formatLocalClock(finalDue * 1_000, timezone));
				const replacesUserTime = state?.userConstraint && userTime && user!.id !== state.userConstraint.messageId && user!.at >= state.userConstraint.recordedAt;
				if (state?.userConstraint && finalDue !== state.baselineDeadlineAt && !replacesUserTime && !(userTime && user && user.id === state.userConstraint.messageId && nowSeconds - state.userConstraint.recordedAt <= SAME_MESSAGE_CORRECTION_SECONDS))
					throw deadlineGateError("Keep the recorded user deadline.", "The quoted user message does not authorize changing the recorded deadline");
				// A wrong value set from the SAME user message (arithmetic slip) may be corrected shortly after; a
				// self-extension still needs the user's own words to contain the new clock time.
				const correctsSameMessage = !replacesUserTime && !!state?.userConstraint && !!userTime && !!user && user.id === state.userConstraint.messageId && nowSeconds - state.userConstraint.recordedAt <= SAME_MESSAGE_CORRECTION_SECONDS && finalDue !== state.baselineDeadlineAt;
				if (user && (!state?.userConstraint || replacesUserTime || correctsSameMessage)) {
					if (finalDue < nowSeconds - SANITY_PAST_SECONDS)
						throw deadlineGateError("Correct the deadline local_time and let the tool compute its epoch.", `deadline ${new Date(finalDue * 1_000).toISOString()} is ${Math.round((nowSeconds - finalDue) / 60)} min in the past: this is an epoch arithmetic error, not a missed deadline. Pass local_time (for example "19:00") with timezone and let the tool compute the epoch.`);
					if (finalDue > nowSeconds + SANITY_AHEAD_SECONDS)
						throw deadlineGateError("Set a deadline within 7 days using local_time.", `deadline ${new Date(finalDue * 1_000).toISOString()} is more than 7 days ahead: this is an epoch arithmetic error. Pass local_time (for example "19:00") with timezone and let the tool compute the epoch.`);
				}
				const previous = !replacesUserTime && !correctsSameMessage && (state?.userConstraint || state?.goalId === goalId) ? state : null;
				const previousStages = new Map(previous?.stages.map(stage => [stage.id, stage] as const));
				const repairedStageIds = new Set<string>();
				for (const stage of resolvedStages) {
					const old = previousStages.get(stage.id);
					if (!old || old.deadlineAt === stage.deadline_at) continue;
					if (old.deadlineAt > MAX_REASONABLE_DEADLINE_SECONDS && old.deadlineAt === stage.deadline_at * 1_000) {
						repairedStageIds.add(stage.id);
						continue;
					}
					throw deadlineGateError(`Keep stage ${truncateMiddleToWidth(stage.id, 28)} fixed or create a new stage id.`, `cannot change deadline for existing stage ${stage.id} on the same goal`);
				}
				const stages = [
					...(previous?.stages.filter(stage => !stageIds.has(stage.id)) ?? []),
					...resolvedStages.map(stage => {
						const old = previousStages.get(stage.id);
						return {
							id: stage.id,
							label: stage.label,
							expectedResult: stage.expected_result,
							deadlineAt: repairedStageIds.has(stage.id)
								? stage.deadline_at
								: (old?.deadlineAt ?? stage.deadline_at),
							...(old?.deliveredAt === undefined ? {} : { deliveredAt: old.deliveredAt }),
							...(old?.deliveredArtifact === undefined ? {} : { deliveredArtifact: old.deliveredArtifact }),
						};
					}),
				];
				const repairedBaseline = previous?.stages.some(
					stage => repairedStageIds.has(stage.id) && previous.baselineDeadlineAt === stage.deadlineAt,
				);
				const baselineDeadlineAt =
					(repairedBaseline && previous?.baselineDeadlineAt !== undefined
						? previous.baselineDeadlineAt / 1_000
						: previous?.baselineDeadlineAt) ??
					(previous?.stages.length
						? Math.max(...stages.map(stage => stage.deadlineAt))
						: Math.max(...resolvedStages.map(stage => stage.deadline_at)));
				state = {
					version: 1,
					goalId,
					goalStartedAt: previous?.goalStartedAt ?? goalStartedAt,
					timezone,
					active: true,
					stages,
					initialQuota: previous?.initialQuota ?? readQuota(),
					baselineDeadlineAt,
					...(previous?.userConstraint ? { userConstraint: previous.userConstraint } : user || !activeGoal ? { userConstraint: { messageId: user?.id ?? "unattributed", quote: quote ?? "", recordedAt: user?.at ?? goalStartedAt } } : {}),
				};
			} else if (params.action === "deliver") {
				if (!state || !params.stage_id || !params.delivered_artifact)
					throw deadlineGateError("Provide an active schedule, stage_id, and delivered_artifact.", "deliver requires an active schedule, stage_id, and delivered_artifact");
				const stage = state.stages.find(item => item.id === params.stage_id);
				if (!stage) throw deadlineGateError(`Choose a known deadline stage for stage_id ${truncateMiddleToWidth(params.stage_id, 28)}.`, `unknown stage: ${params.stage_id}`);
				stage.deliveredAt = Math.floor(Date.now() / 1000);
				stage.deliveredArtifact = params.delivered_artifact;
			} else if (params.action === "clear") {
				if (state?.userConstraint) {
					const user = deadlineSdk.latestDeadlineUserMessage(userEntries(ctx), params.user_message);
					const quoted = params.user_message?.trim() && user;
					if (!user || user.id === state.userConstraint.messageId || user.at < state.userConstraint.recordedAt || !quoted)
						throw deadlineGateError("Quote a newer real user message.", "user_message must quote a newer real user message");
				}
				state = state ? { ...state, active: false, stages: [], baselineDeadlineAt: undefined } : null;
			}
			if (params.action !== "status") persist();
			if (params.action === "set" && state?.userConstraint) announceDeadlineGate(state, deadlineSdk.isUserDeadlineMissed(state), ctx.getTodoPhases?.());
			updateUi(ctx);
			const hasInvalidTimestamp =
				state !== null &&
				(!isUnixSeconds(state.goalStartedAt) ||
					state.stages.some(stage => !isUnixSeconds(stage.deadlineAt)) ||
					(state.baselineDeadlineAt !== undefined && !isUnixSeconds(state.baselineDeadlineAt)));
			const text = state
				? (renderDeadlineReminder(state, Math.floor(Date.now() / 1000), readQuota(), ctx.getTodoPhases?.()) ??
					(hasInvalidTimestamp
						? "Goal deadline timestamp is invalid; forecast is unknown. Correct the affected stage using Unix seconds."
						: "Goal deadline schedule has no pending stages."))
				: "No goal deadline schedule is active.";
			return { content: [{ type: "text", text }], details: { state, goal: activeGoal } };
		},
	});
}
