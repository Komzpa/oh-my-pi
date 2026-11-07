import { prompt } from "@oh-my-pi/pi-utils";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import planfactNote from "./planfact-note.md" with { type: "text" };
import { selectBranchNewestFirst } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

export const LEAD_NOTE_MAX_CHARS = 8192;
export const LEAD_NOTE_INTERVAL_MS = 5 * 60_000;

type TimedNoteMessage = Extract<SessionEntry, { type: "custom_message" }>;
type TimedNoteIdentity = { semanticKey: string; timestamp: number };
type TimedNotePi = Pick<ExtensionAPI, "sendMessage">;
type TimedNoteContext = Pick<ExtensionContext, "sessionManager">;

function readIdentity(entry: TimedNoteMessage): TimedNoteIdentity | undefined {
	const details = entry.details;
	if (!details || typeof details !== "object" || !("semanticKey" in details) || typeof details.semanticKey !== "string") return undefined;
	const timestamp = "emittedAt" in details && typeof details.emittedAt === "number" ? details.emittedAt : Date.parse(entry.timestamp);
	return Number.isFinite(timestamp) ? { semanticKey: details.semanticKey, timestamp } : undefined;
}

function latestIdentity(ctx: TimedNoteContext, customType: string): TimedNoteIdentity | undefined {
	for (const entry of selectBranchNewestFirst(ctx.sessionManager, metadata => metadata.type === "custom_message" && (metadata.customType === undefined || metadata.customType === customType))) {
		if (entry?.type !== "custom_message" || entry.customType !== customType) continue;
		return readIdentity(entry);
	}
	return undefined;
}

export function shouldAppendTimedNote(
	previous: TimedNoteIdentity | undefined,
	semanticKey: string,
	now: number,
	workOpen: boolean,
): boolean {
	if (!previous || previous.semanticKey !== semanticKey) return true;
	return workOpen && now - previous.timestamp >= LEAD_NOTE_INTERVAL_MS;
}

export async function appendTimedNote(
	pi: TimedNotePi,
	ctx: TimedNoteContext,
	customType: string,
	content: string,
	semanticKey: string,
	localClock: string,
	workOpen: boolean,
	now = Date.now(),
): Promise<boolean> {
	if (!content.trim()) return false;
	const identity = Bun.hash(semanticKey).toString(16);
	if (!shouldAppendTimedNote(latestIdentity(ctx, customType), identity, now, workOpen)) return false;
	const delivery = { deliverAs: "steer" as const, triggerTurn: false, interruptWait: false, supersedes: customType };
	await pi.sendMessage(
		{
			customType,
			content: `${localClock} · ${content}`.slice(0, LEAD_NOTE_MAX_CHARS),
			display: false,
			details: { semanticKey: identity, emittedAt: now },
			attribution: "agent",
		},
		delivery,
	);
	return true;
}

export function renderPlanFactNote(
	phases: TodoScheduleInput,
	now: number,
	deadlineAt: number | undefined,
	questions: Array<{ worker: string; question: string }> = [],
	forecastFinish?: number,
): string {
	const open = phases.flatMap(phase => phase.tasks).filter(row => row.status !== "completed" && row.status !== "abandoned");
	const churn = open.flatMap(row => {
		const failures = row.schedule?.attemptHistory?.filter(attempt => attempt.terminalStatus !== "completed" || attempt.rejectionReason).length ?? 0;
		const reestimates = row.schedule?.cumulativeReestimateCount ?? row.schedule?.reestimateCount ?? 0;
		return failures >= 3 || reestimates >= 3 ? [{ row: row.content.slice(0, 180), failures, reestimates }] : [];
	}).slice(0, 8);
	const slip = deadlineAt === undefined || !open.length ? 0 : Math.max(now, forecastFinish ?? 0) - deadlineAt;
	return prompt.render(planfactNote, {
		churn, slipped: slip > 0, slipMinutes: Math.ceil(slip / 60_000),
		questions: questions.slice(0, 4).map(item => ({ worker: item.worker.slice(0, 80), question: item.question.slice(0, 400) })),
	}).trim();
}
