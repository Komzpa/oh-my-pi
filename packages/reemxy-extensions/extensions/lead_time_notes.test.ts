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
	expect(sent[0]?.options).toEqual({ deliverAs: "nextTurn" });
	expect(await append(start + LEAD_NOTE_INTERVAL_MS)).toBe(true);
	expect(sent).toHaveLength(2);
});
