// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import type { ActiveGoalRef, DeadlineState, QuotaSnapshot } from "./deadlines";
import * as deadlineSdk from "./deadlines";
import wrapUpInstructions from "./goal-deadline-wrap-up.md" with { type: "text" };

export const REMINDER_MAX_CHARS = 800;

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

export function renderDeadlineReminder(state: DeadlineState, now: number, currentQuota?: QuotaSnapshot): string | null {
	if (!state.active) return null;
	if (
		!isUnixSeconds(state.goalStartedAt) ||
		state.stages.some(stage => !isUnixSeconds(stage.deadlineAt)) ||
		(state.baselineDeadlineAt !== undefined && !isUnixSeconds(state.baselineDeadlineAt))
	)
		return null;
	if (deadlineSdk.isUserDeadlineMissed(state, now)) {
		const due = state.baselineDeadlineAt!;
		return [
			`deadline ${deadlineSdk.formatLocalClock(due * 1_000, state.timezone)} missed at ${deadlineSdk.formatLocalTimestamp(due * 1_000, state.timezone)}, by ${Math.floor((now - due) / 60)}m.`,
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
	return `[GOAL DEADLINES goalId=${bounded(goal.id, 64)}]\nNo deadline schedule is recorded. If the user gave a delivery time, resolve its exact date and timezone from the user message and call goal_deadline(action=set), even if the time has passed; report an overdue deadline honestly. Never invent a time, postpone it, or silently omit it. Otherwise continue without a schedule.`;
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

interface DeadlineToolParams {
	action: "set" | "deliver" | "status" | "clear";
	goal_id?: string;
	goal_started_at?: number;
	timezone?: string;
	stages?: Array<{ id: string; label: string; expected_result: string; deadline_at: number }>;
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
	return `Cannot complete goal: ${total} TODO task${total === 1 ? " is" : "s are"} unresolved (${summary}). ${guidance}${namedTasks}`;
}

export default function goalDeadlines(pi: ExtensionAPI): void {
	// Pure deadline readers are also available on hosts whose bundled barrel predates their exports.
	const sdk = typeof pi.pi?.rehydrateDeadlineState === "function" ? pi.pi : deadlineSdk;
	let state: DeadlineState | null = null;
	let activeGoal: ActiveGoalRef | null = null;
	// `_goalCore` has no public accessor; use it only before branch lifecycle is recorded.
	const goalCore = pi as unknown as { _goalCore?: { state?: { goal?: unknown } } };
	const currentGoal = (): ActiveGoalRef | null => sdk.goalRef(goalCore._goalCore?.state?.goal);
	const focusedGoal = (ctx: ExtensionContext): ActiveGoalRef | null => {
		const lifecycle = sdk.readFocusedGoal(ctx.sessionManager.getBranch(), ctx.cwd);
		return lifecycle === undefined ? currentGoal() : lifecycle;
	};

	const persist = () => pi.appendEntry(sdk.STATE_ENTRY, state);
	const updateUi = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const deadlineState = state?.active && (state.userConstraint || (activeGoal?.status === "active" && activeGoal.id === state.goalId)) ? state : null;
		if (!deadlineState) {
			ctx.ui.setStatus("goal-deadline", derivePresence(ctx.sessionManager.getBranch(), null));
			ctx.ui.setWidget("goal-deadline", undefined);
			return;
		}
		const host = pi.pi as unknown as { getLatestTodoPhasesFromEntries?: TodoCompletionReducer } | undefined;
		const phases =
			typeof host?.getLatestTodoPhasesFromEntries === "function"
				? host.getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch())
				: [];
		const todoShowsDue = (phases ?? []).some(phase =>
			phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
		);
		const lines = renderDeadlineUi(deadlineState, Math.floor(Date.now() / 1000), todoShowsDue);
		// The widget below the editor already shows the deadline; the status keeps presence brief.
		ctx.ui.setStatus("goal-deadline", derivePresence(ctx.sessionManager.getBranch(), deadlineState));
		ctx.ui.setWidget("goal-deadline", lines, { placement: "belowEditor" });
	};
	const refresh = (ctx: ExtensionContext) => {
		activeGoal = focusedGoal(ctx);
		updateUi(ctx);
	};
	const load = (ctx: ExtensionContext) => {
		state = sdk.rehydrateDeadlineState(ctx.sessionManager.getBranch());
		refresh(ctx);
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
	pi.on("goal_updated", (event, ctx) => {
		activeGoal = sdk.goalRef(event.goal);
		updateUi(ctx);
	});

	pi.on("tool_call", (event, ctx) => {
		if ((event.toolName === "task" || (event.toolName === "todo" && (event.input.op === "init" || event.input.op === "append"))) && deadlineSdk.isUserDeadlineMissed(state)) {
			const input = event.input;
			const work = event.toolName === "task"
				? (Array.isArray(input.tasks) ? input.tasks : [input]).map(item => item.name ?? item.task)
				: (input.list?.flatMap(phase => phase.items) ?? input.items ?? []);
			const user = deadlineSdk.latestDeadlineUserMessage(ctx.sessionManager.getBranch());
			const approvalLines = user && user.at >= state!.baselineDeadlineAt! && user.id !== state!.userConstraint!.messageId ? user.text.split("\n") : [];
			const missingIndex = work.findIndex(item => typeof item !== "string" || !approvalLines.includes(`Approve new work: ${item}`));
			if (work.length === 0 || missingIndex >= 0) return { block: true, reason: `Refusing new work after the user deadline. Exactly: ask the user to reply ${JSON.stringify(`Approve new work: ${work[missingIndex] ?? "<exact row or task name>"}`)}.` };
		}
		const isNativeCompletion = event.toolName === "goal" && event.input.op === "complete";
		const isPluginCompletion = event.toolName === "update_goal" && event.input.status === "complete";
		if (!isNativeCompletion && !isPluginCompletion) return;

		const branch = ctx.sessionManager.getBranch();
		const host = pi.pi as unknown as { getLatestTodoPhasesFromEntries?: TodoCompletionReducer } | undefined;
		if (typeof host?.getLatestTodoPhasesFromEntries !== "function") {
			return { block: true, reason: "Cannot verify TODO closure: the host TODO reducer is unavailable." };
		}
		const reason = todoCompletionBlockReason(host.getLatestTodoPhasesFromEntries(branch));
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("context", (event, ctx) => {
		refresh(ctx);
		const deadlineState = state?.active && (state.userConstraint || (activeGoal?.status === "active" && activeGoal.id === state.goalId)) ? state : null;
		const reminder = deadlineState
			? renderDeadlineReminder(deadlineState, Math.floor(Date.now() / 1000), readQuota())
			: activeGoal?.status === "active" ? renderMissingScheduleReminder(activeGoal) : null;
		const content = [renderPresence(ctx.sessionManager.getBranch(), deadlineState), reminder]
			.filter(Boolean)
			.join("\n\n");
		return { messages: [...event.messages, { role: "developer", content, timestamp: Date.now() }] };
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		refresh(ctx);
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
			"Manage milestone deadlines and durable user delivery constraints. With no focused goal, action=set records the constraint in this same session owner. user_message is an exact quote from the latest real user message giving the deadline. The goal id, start time, and local timezone default from state or focus; never infer deadline times. deadline_at is a Unix timestamp in seconds, not milliseconds. Same-goal updates preserve receipts and final due time. Only a newer user message giving a new time can replace a user deadline; action=clear requires the user to say /deadline close. A promised status time is not authorization.",
		parameters: z.object({
			action: z.enum(["set", "deliver", "status", "clear"]),

			goal_id: z.string().optional(),
			goal_started_at: z.number().int().optional(),
			timezone: z.string().optional(),
			user_message: z.string().optional().describe("Exact quote from the latest real user message authorizing this deadline; include its explicit local HH:MM time."),
			stages: z
				.array(
					z.object({
						id: z.string(),
						label: z.string(),
						expected_result: z.string(),
						deadline_at: z
							.number()
							.int()
							.describe(
								"Unix timestamp in seconds, not milliseconds; current dates are 10 digits and must be no later than 2100-01-01T00:00:00Z.",
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
				const user = deadlineSdk.latestDeadlineUserMessage(ctx.sessionManager.getBranch());
				const goalId = params.goal_id ?? activeGoal?.id ?? state?.goalId ?? "session-deadline";
				const goalStartedAt = params.goal_started_at ?? activeGoal?.createdAt ?? user?.at ?? Math.floor(Date.now() / 1_000);
				const timezone = deadlineSdk.resolveTimeZone(params.timezone ?? state?.timezone);
				if (!Number.isFinite(goalStartedAt) || !params.stages?.length) throw new Error("set requires non-empty stages and a valid start time");
				if (activeGoal && goalId !== activeGoal.id)
					throw new Error(`deadline goal ${goalId} does not match focused goal ${activeGoal.id}`);
				const stageIds = new Set(params.stages.map(stage => stage.id));
				if (stageIds.size !== params.stages.length) throw new Error("stage ids must be unique");
				for (const stage of params.stages) {
					if (!Number.isSafeInteger(stage.deadline_at))
						throw new Error(`deadline_at for stage ${stage.id} must be Unix seconds (integer), not milliseconds`);
					if (!isUnixSeconds(stage.deadline_at))
						throw new Error(
							`deadline_at for stage ${stage.id} must be Unix seconds (10-digit timestamp for current dates), not milliseconds, and no later than 2100-01-01T00:00:00Z`,
						);
				}
				const finalDue = Math.max(...params.stages.map(stage => stage.deadline_at));
				const quote = params.user_message ?? user?.text;
				if (params.user_message && (!user || !user.text.includes(params.user_message))) throw new Error("user_message must quote the latest real user message");
				const userTime = user && quote && quote.includes(deadlineSdk.formatLocalClock(finalDue * 1_000, timezone));
				const replacesUserTime = state?.userConstraint && userTime && user!.id !== state.userConstraint.messageId && user!.at >= state.userConstraint.recordedAt;
				if (state?.userConstraint && finalDue !== state.baselineDeadlineAt && !replacesUserTime) throw new Error("Only a newer user message setting a new time can replace the user deadline");
				const previous = !replacesUserTime && (state?.userConstraint || state?.goalId === goalId) ? state : null;
				const previousStages = new Map(previous?.stages.map(stage => [stage.id, stage] as const));
				const repairedStageIds = new Set<string>();
				for (const stage of params.stages) {
					const old = previousStages.get(stage.id);
					if (!old || old.deadlineAt === stage.deadline_at) continue;
					if (old.deadlineAt > MAX_REASONABLE_DEADLINE_SECONDS && old.deadlineAt === stage.deadline_at * 1_000) {
						repairedStageIds.add(stage.id);
						continue;
					}
					throw new Error(`cannot change deadline for existing stage ${stage.id} on the same goal`);
				}
				const stages = [
					...(previous?.stages.filter(stage => !stageIds.has(stage.id)) ?? []),
					...params.stages.map(stage => {
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
						: Math.max(...params.stages.map(stage => stage.deadline_at)));
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
					throw new Error("deliver requires an active schedule, stage_id, and delivered_artifact");
				const stage = state.stages.find(item => item.id === params.stage_id);
				if (!stage) throw new Error(`unknown stage: ${params.stage_id}`);
				stage.deliveredAt = Math.floor(Date.now() / 1000);
				stage.deliveredArtifact = params.delivered_artifact;
			} else if (params.action === "clear") {
				if (state?.userConstraint) {
					const user = deadlineSdk.latestDeadlineUserMessage(ctx.sessionManager.getBranch());
					if (!user || user.id === state.userConstraint.messageId || user.at < state.userConstraint.recordedAt || user.text.trim() !== "/deadline close") throw new Error("Exactly: ask the user to say /deadline close");
				}
				state = state ? { ...state, active: false, stages: [], baselineDeadlineAt: undefined } : null;
			}
			if (params.action !== "status") persist();
			updateUi(ctx);
			const hasInvalidTimestamp =
				state !== null &&
				(!isUnixSeconds(state.goalStartedAt) ||
					state.stages.some(stage => !isUnixSeconds(stage.deadlineAt)) ||
					(state.baselineDeadlineAt !== undefined && !isUnixSeconds(state.baselineDeadlineAt)));
			const text = state
				? (renderDeadlineReminder(state, Math.floor(Date.now() / 1000), readQuota()) ??
					(hasInvalidTimestamp
						? "Goal deadline timestamp is invalid; forecast is unknown. Correct the affected stage using Unix seconds."
						: "Goal deadline schedule has no pending stages."))
				: "No goal deadline schedule is active.";
			return { content: [{ type: "text", text }], details: { state, goal: activeGoal } };
		},
	});
}
