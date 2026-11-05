import type { Agent } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import elapsedNoteTemplate from "../prompts/tools/subagent-elapsed-note.md" with { type: "text" };
import type { Message } from "@oh-my-pi/pi-ai";
import { isPersistedSubagentElapsedNote } from "@oh-my-pi/pi-ai/utils/subagent-elapsed-note";

export const SUBAGENT_ELAPSED_NOTE_CADENCE_MS = 5 * 60_000;

export interface SubagentElapsedSignalOptions {
	attemptStartedAt: number;
	lastNoteAt?: number;
	appendMessage: (message: Message) => void;
	now?: () => number;
}

/** Find this attempt's latest persisted checkpoint, ignoring earlier attempts. */
export function findLastPersistedSubagentElapsedNoteAt(
	messages: readonly Message[],
	attemptStartedAt: number,
): number | undefined {
	let lastNoteAt: number | undefined;
	for (const message of messages) {
		if (message.role !== "developer" || !isPersistedSubagentElapsedNote(message)) continue;
		if (typeof message.timestamp === "number" && message.timestamp >= attemptStartedAt)
			lastNoteAt = message.timestamp;
	}
	return lastNoteAt;
}

/** Persist elapsed-time notes for one worker attempt. */
export class SubagentElapsedSignal {
	#attemptStartedAt: number;
	#lastNoteAt: number | undefined;
	#appendMessage: (message: Message) => void;
	#now: () => number;

	constructor(options: SubagentElapsedSignalOptions) {
		this.#attemptStartedAt = options.attemptStartedAt;
		this.#lastNoteAt = options.lastNoteAt;
		this.#appendMessage = options.appendMessage;
		this.#now = options.now ?? Date.now;
	}

	/** Retain due checkpoints in the active tool loop as well as the persisted transcript. */
	attach(agent: Agent): void {
		agent.addBeforeModelCallHook((_signal, context) => {
			const note = this.appendIfDue();
			if (note) context.messages.push(note);
		});
	}

	/** Add the attempt's initial note, or keep the existing note when reviving it. */
	start(): void {
		if (this.#lastNoteAt !== undefined) return;
		this.#appendAt(this.#attemptStartedAt);
	}

	/** Add a note at a request boundary once five minutes have passed since the last note. */
	appendIfDue(): Message | undefined {
		const now = this.#now();
		if (this.#lastNoteAt !== undefined && now - this.#lastNoteAt < SUBAGENT_ELAPSED_NOTE_CADENCE_MS) return undefined;
		return this.#appendAt(now);
	}

	#appendAt(timestamp: number): Message {
		const elapsedMinutes = Math.floor(Math.max(0, timestamp - this.#attemptStartedAt) / 60_000);
		const date = new Date(timestamp);
		const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		const message: Message = {
			role: "developer",
			content: prompt.render(elapsedNoteTemplate, { time, elapsedMinutes }).trim(),
			timestamp,
		};
		this.#appendMessage(message);
		this.#lastNoteAt = timestamp;
		return message;
	}
}
