import { readFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_ENTRY = "reemxy-goal-deadlines";
const MAX_UNIX_SECONDS = 253_402_300_799;

function isUnixSeconds(value: number): boolean {
	return Number.isSafeInteger(value) && value <= MAX_UNIX_SECONDS;
}

export interface DeadlineStage {
	id: string;
	label: string;
	expectedResult: string;
	deadlineAt: number;
	deliveredAt?: number;
	deliveredArtifact?: string;
}

export interface DeadlineState {
	version: 1;
	goalId: string;
	goalStartedAt: number;
	timezone: string;
	active: boolean;
	stages: DeadlineStage[];
	initialQuota?: QuotaSnapshot;
	baselineDeadlineAt?: number;
	/** User authority is durable even without goal focus; due time stays in baselineDeadlineAt. */
	userConstraint?: { messageId: string; quote: string; recordedAt: number; statusSentAt?: number };
}

export interface QuotaSnapshot {
	provider: string;
	remainingPercent: number | null;
	status: string;
	sourceAsOf: string | null;
	recoveryAt: string | null;
}

export interface ActiveGoalRef {
	id: string;
	createdAt: number;
	status: string;
}

export function goalRef(value: unknown): ActiveGoalRef | null {
	if (!value || typeof value !== "object") return null;
	const goal = value as { id?: unknown; createdAt?: unknown; status?: unknown };
	if (typeof goal.id !== "string" || typeof goal.status !== "string") return null;
	const createdAt =
		typeof goal.createdAt === "number"
			? Math.floor(goal.createdAt / 1000)
			: typeof goal.createdAt === "string"
				? Math.floor(Date.parse(goal.createdAt) / 1000)
				: NaN;
	return Number.isFinite(createdAt) ? { id: goal.id, createdAt, status: goal.status } : null;
}

export type GoalResolution = ActiveGoalRef | null | undefined;

export interface GoalFocusAuthority {
	owner: "native" | "plugin" | null;
	goal: ActiveGoalRef | null;
	explicit: boolean;
}

function resolveGoalFocusAuthority(
	entries: readonly unknown[],
	readGoals: () => readonly unknown[],
): GoalFocusAuthority {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as {
			type?: unknown;
			mode?: unknown;
			customType?: unknown;
			data?: { goal?: unknown; focusedGoalId?: unknown };
		};
		if (
			entry?.type === "mode_change" &&
			(entry.mode === "goal" || entry.mode === "goal_paused" || entry.mode === "none")
		) {
			return {
				owner: "native",
				goal: entry.mode === "none" ? null : goalRef(entry.data?.goal),
				explicit: true,
			};
		}
		if (entry?.type === "custom" && entry.customType === "pi-goal-focus") {
			const id = typeof entry.data?.focusedGoalId === "string" ? entry.data.focusedGoalId : null;
			let goal: ActiveGoalRef | null = null;
			if (id !== null) {
				for (const candidate of readGoals()) {
					const ref = goalRef(candidate);
					if (ref?.id === id) {
						goal = ref;
						break;
					}
				}
			}
			return { owner: "plugin", goal, explicit: true };
		}
	}
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: { goal?: unknown } };
		if (entry?.type === "custom" && entry.customType === "pi-goal-state") {
			const goal = goalRef(entry.data?.goal);
			return goal ? { owner: "plugin", goal, explicit: false } : { owner: null, goal: null, explicit: false };
		}
	}
	return { owner: null, goal: null, explicit: false };
}

export function readGoalFocusAuthority(entries: readonly unknown[], cwd?: string): GoalFocusAuthority {
	return resolveGoalFocusAuthority(entries, () => readGoalPool(cwd));
}

function resolveLifecycleGoal(entries: readonly unknown[], readGoals: () => readonly unknown[]): GoalResolution {
	const authority = resolveGoalFocusAuthority(entries, readGoals);
	return authority.owner === null ? undefined : authority.goal;
}

export function lifecycleGoal(entries: readonly unknown[], goals: readonly unknown[]): GoalResolution {
	return resolveLifecycleGoal(entries, () => goals);
}

export function rehydrateActiveGoal(entries: readonly unknown[]): ActiveGoalRef | null {
	const goal = lifecycleGoal(entries, []);
	return goal?.status === "active" ? goal : null;
}

export function resolveFocusedGoal(entries: readonly unknown[], goals: readonly unknown[]): GoalResolution {
	const goal = lifecycleGoal(entries, goals);
	if (goal === undefined) return undefined;
	return goal?.status === "active" ? goal : null;
}

function validState(value: unknown): value is DeadlineState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<DeadlineState>;
	return (
		state.version === 1 &&
		typeof state.goalId === "string" &&
		Number.isFinite(state.goalStartedAt) &&
		typeof state.timezone === "string" &&
		typeof state.active === "boolean" &&
		Array.isArray(state.stages) &&
		(state.baselineDeadlineAt === undefined || Number.isFinite(state.baselineDeadlineAt)) &&
		state.stages.every(
			stage =>
				Boolean(stage) &&
				typeof stage.id === "string" &&
				typeof stage.label === "string" &&
				typeof stage.expectedResult === "string" &&
				Number.isFinite(stage.deadlineAt),
		)
	);
}

export function resolveTimeZone(timeZone?: string): string {
	const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const candidate = timeZone || localTimeZone;
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format();
		return candidate;
	} catch {
		return localTimeZone;
	}
}

export function formatLocalTimestamp(value: number, timeZone?: string): string {
	if (!Number.isFinite(value)) return "unknown";
	const zone = resolveTimeZone(timeZone);
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(value));
	const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
	return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second} ${zone}`;
}

export function formatLocalClock(value: number, timeZone?: string): string {
	if (!Number.isFinite(value)) return "unknown";
	const zone = resolveTimeZone(timeZone);
	return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

export function rehydrateDeadlineState(entries: readonly unknown[]): DeadlineState | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as {
			type?: unknown;
			customType?: unknown;
			data?: unknown;
			message?: { toolName?: unknown; details?: { state?: unknown } };
		};
		if (entry?.type === "custom" && entry.customType === STATE_ENTRY)
			return validState(entry.data) ? entry.data : null;
		if (entry?.type === "message" && entry.message?.toolName === "goal_deadline") {
			const candidate = entry.message.details?.state;
			return validState(candidate) ? candidate : null;
		}
	}
	return null;
}

export function isUserDeadlineMissed(state: DeadlineState | null, now = Date.now() / 1_000): boolean {
	return Boolean(state?.active && state.userConstraint && state.baselineDeadlineAt !== undefined && now >= state.baselineDeadlineAt);
}

export function latestDeadlineUserMessage(entries: readonly unknown[]): { id: string; text: string; at: number } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as {
			id?: string;
			type?: string;
			timestamp?: string | number;
			message?: { role?: string; content?: string | Array<{ type: string; text?: string }>; attribution?: string; synthetic?: boolean; timestamp?: number };
		};
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "user" || message.synthetic || (message.attribution && message.attribution !== "user")) continue;
		const timestamp = entry.timestamp ?? message.timestamp;
		const at = typeof timestamp === "number" ? timestamp : Date.parse(timestamp ?? "");
		const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
		if (Number.isFinite(at)) return { id: entry.id ?? String(at), text, at: Math.floor(at / 1_000) };
	}
	return undefined;
}

function readGoalPool(cwd?: string): readonly unknown[] {
	try {
		const value = JSON.parse(readFileSync(join(cwd ?? process.cwd(), ".pi/.goals-pool-snapshot.json"), "utf8")) as {
			goals?: unknown;
		};
		return Array.isArray(value.goals) ? value.goals : [];
	} catch {
		return [];
	}
}

export function readFocusedGoal(entries: readonly unknown[], cwd?: string): GoalResolution {
	const goal = resolveLifecycleGoal(entries, () => readGoalPool(cwd));
	if (goal === undefined) return undefined;
	return goal?.status === "active" ? goal : null;
}

export function readGoalDeadline(
	entries: readonly unknown[],
	cwd?: string,
	options: { includePaused?: boolean } = {},
): { goalId: string; deadlineAt: number; timezone: string; paused?: boolean } | undefined {
	const state = rehydrateDeadlineState(entries);
	if (state?.active && state.userConstraint && state.baselineDeadlineAt !== undefined && isUnixSeconds(state.baselineDeadlineAt))
		return { goalId: state.goalId, deadlineAt: state.baselineDeadlineAt * 1_000, timezone: resolveTimeZone(state.timezone) };
	const goal = resolveLifecycleGoal(entries, () => readGoalPool(cwd));
	if (!goal || (goal.status !== "active" && !(options.includePaused && goal.status === "paused"))) return undefined;
	if (!state?.active || state.goalId !== goal.id || state.stages.length === 0) return undefined;
	if (state.stages.every(stage => stage.deliveredAt !== undefined)) return undefined;
	if (
		!isUnixSeconds(state.goalStartedAt) ||
		state.stages.some(stage => !isUnixSeconds(stage.deadlineAt)) ||
		(state.baselineDeadlineAt !== undefined && !isUnixSeconds(state.baselineDeadlineAt))
	)
		return undefined;
	const deadlineAt = state.baselineDeadlineAt ?? Math.max(...state.stages.map(stage => stage.deadlineAt));
	return Number.isFinite(deadlineAt)
		? { goalId: goal.id, deadlineAt: deadlineAt * 1_000, timezone: resolveTimeZone(state.timezone), ...(goal.status === "paused" ? { paused: true } : {}) }
		: undefined;
}
