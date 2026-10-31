import { expect, it } from "bun:test";
import { isPersistedSubagentElapsedNote } from "@oh-my-pi/pi-ai/utils/subagent-elapsed-note";
import {
	findLastPersistedSubagentElapsedNoteAt,
	SubagentElapsedSignal,
	SUBAGENT_ELAPSED_NOTE_CADENCE_MS,
} from "@oh-my-pi/pi-coding-agent/task/subagent-elapsed-signal";
import type { Message } from "@oh-my-pi/pi-ai";

function localTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

it("persists an ordinary zero-minute note when an attempt starts", () => {
	const messages: Message[] = [];
	const startedAt = new Date(2026, 9, 28, 8, 0).getTime();
	const signal = new SubagentElapsedSignal({
		attemptStartedAt: startedAt,
		appendMessage: message => messages.push(message),
	});

	signal.start();

	expect(messages).toHaveLength(1);
	expect(messages[0]).toMatchObject({
		role: "developer",
		timestamp: startedAt,
		content: `${localTime(startedAt)} · elapsed 0m in this attempt. Your role's time budget applies: past it, stop at the next checkable point and return what is done with its receipt.`,
	});
	expect("synthetic" in messages[0]!).toBe(false);
	expect(isPersistedSubagentElapsedNote(messages[0])).toBe(true);
});

it("keeps the history unchanged before five minutes and persists at the next due request boundary", () => {
	const messages: Message[] = [];
	const startedAt = new Date(2026, 9, 28, 8, 0).getTime();
	let now = startedAt;
	const signal = new SubagentElapsedSignal({
		attemptStartedAt: startedAt,
		appendMessage: message => messages.push(message),
		now: () => now,
	});
	signal.start();
	now += SUBAGENT_ELAPSED_NOTE_CADENCE_MS - 1;
	signal.appendIfDue();
	expect(messages).toHaveLength(1);

	now += 1;
	signal.appendIfDue();
	expect(messages).toHaveLength(2);
	expect(messages[1]?.content).toContain("elapsed 5m in this attempt");
});

it("starts a redispatched attempt at zero even when its assignment is days old", () => {
	const messages: Message[] = [];
	const originalAssignmentStart = new Date(2026, 9, 20, 8, 0).getTime();
	const attemptStartedAt = new Date(2026, 9, 28, 8, 0).getTime();
	const signal = new SubagentElapsedSignal({ attemptStartedAt, appendMessage: message => messages.push(message) });

	signal.start();

	expect(attemptStartedAt - originalAssignmentStart).toBeGreaterThan(7 * 24 * 60 * 60_000);
	expect(messages[0]?.content).toContain("elapsed 0m in this attempt");
});

it("revives the same attempt from its last persisted note and continues the clock", () => {
	const messages: Message[] = [];
	const attemptStartedAt = new Date(2026, 9, 28, 8, 0).getTime();
	const lastNoteAt = attemptStartedAt + 5 * 60_000;
	const previousAttemptNoteAt = attemptStartedAt - 8 * 24 * 60 * 60_000;
	const note = (timestamp: number, elapsedMinutes: number): Message => ({
		role: "developer",
		content: `${localTime(timestamp)} · elapsed ${elapsedMinutes}m in this attempt. Your role's time budget applies: past it, stop at the next checkable point and return what is done with its receipt.`,
		timestamp,
	});
	const transcript = [note(previousAttemptNoteAt, 192), note(lastNoteAt, 5)];
	expect(findLastPersistedSubagentElapsedNoteAt(transcript, attemptStartedAt)).toBe(lastNoteAt);
	let now = attemptStartedAt + 9 * 60_000;
	const signal = new SubagentElapsedSignal({
		attemptStartedAt,
		lastNoteAt,
		appendMessage: message => messages.push(message),
		now: () => now,
	});

	signal.start();
	signal.appendIfDue();
	expect(messages).toHaveLength(0);

	now = attemptStartedAt + 10 * 60_000;
	signal.appendIfDue();
	expect(messages).toHaveLength(1);
	expect(messages[0]?.content).toContain("elapsed 10m in this attempt");
});
