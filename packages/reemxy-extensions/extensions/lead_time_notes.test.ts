import { expect, test } from "bun:test";
import { appendTimedNote, LEAD_NOTE_INTERVAL_MS } from "./lead_time_notes";

test("lead reminders append once, stay quiet between turns, then repeat after five minutes", async () => {
	const branch: unknown[] = [];
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const ctx = { sessionManager: { getBranch: () => branch } } as never;
	const pi = {
		sendMessage: async (message: Record<string, unknown>, options: Record<string, unknown>) => {
			sent.push({ message, options });
			branch.push({
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				details: message.details,
				timestamp: new Date().toISOString(),
			});
		},
	} as never;
	const start = Date.UTC(2026, 9, 28, 14, 5);
	const append = (now: number) => appendTimedNote(pi, ctx, "lead-note", "goal due 13:10 MISSED", "goal:13:10", "14:05", true, now);

	expect(await append(start)).toBe(true);
	expect(await append(start + 1_000)).toBe(false);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.message).toMatchObject({
		customType: "lead-note",
		content: "14:05 · goal due 13:10 MISSED",
		display: false,
		attribution: "agent",
	});
	expect(sent[0]?.options).toEqual({ deliverAs: "aside", triggerTurn: false, interruptWait: false, supersedes: "lead-note" });
	expect(await append(start + LEAD_NOTE_INTERVAL_MS)).toBe(true);
	expect(sent).toHaveLength(2);
});


test("large plan identities do not duplicate the plan in persisted note details", async () => {
	let sent: { details?: { semanticKey: string } } | undefined;
	const pi = { sendMessage: async (message: typeof sent) => { sent = message; } } as never;
	const ctx = { sessionManager: { getBranch: () => [] } } as never;
	await appendTimedNote(pi, ctx, "todo-dispatch-time-note", "30 open, 5 running", "plan row with blocker".repeat(6000), "03:14", true);
	expect(sent?.details?.semanticKey.length).toBeLessThanOrEqual(16);
});

test("a busy note check selects note metadata without hydrating 300k unrelated notices", async () => {
	let examined = 0;
	const entry = { type: "custom_message", customType: "lead-note", details: { semanticKey: Bun.hash("same").toString(16), emittedAt: 1000 }, timestamp: "2026-11-06T00:00:00Z" };
	const ctx = { sessionManager: {
		getBranch: () => { throw new Error("hydrated complete journal"); },
		*iterateBranchMatchingNewestFirst(predicate: (metadata: { type: string; customType?: string }) => boolean) {
			for (let i = 0; i < 300_000; i++) if (predicate({ type: "custom_message", customType: "unrelated-notice" })) throw new Error("hydrated unrelated notice");
			examined++;
			if (predicate(entry)) yield entry;
		},
	} } as never;
	const pi = { sendMessage: () => { throw new Error("duplicated unchanged note"); } } as never;
	for (let i = 0; i < 20; i++) expect(await appendTimedNote(pi, ctx, "lead-note", "same", "same", "12:30", true, 2000)).toBe(false);
	expect(examined).toBe(20);
});
