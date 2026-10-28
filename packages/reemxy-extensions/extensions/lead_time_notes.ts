import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

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
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
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
	if (!shouldAppendTimedNote(latestIdentity(ctx, customType), semanticKey, now, workOpen)) return false;
	await pi.sendMessage(
		{
			customType,
			content: `${localClock} · ${content}`,
			display: false,
			details: { semanticKey, emittedAt: now },
			attribution: "agent",
		},
		{ deliverAs: "nextTurn" },
	);
	return true;
}
