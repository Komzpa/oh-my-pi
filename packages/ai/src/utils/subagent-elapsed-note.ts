import type { Message } from "../types";

const LEGACY_SUBAGENT_ELAPSED_NOTE =
	/^elapsed \d+s\. Informational only: no deadline or time budget\. Continue until the assigned work is done\.$/;
const PERSISTED_SUBAGENT_ELAPSED_NOTE =
	/^\d{2}:\d{2} · elapsed \d+m in this attempt\. Your role's time budget applies: past it, stop at the next checkable point and return what is done with its receipt\.$/;

/**
 * True for either the legacy transient note or the persisted elapsed note.
 */
export function isSubagentElapsedNote(message: Message | null | undefined): boolean {
	return (
		message?.role === "developer" &&
		typeof message.content === "string" &&
		(LEGACY_SUBAGENT_ELAPSED_NOTE.test(message.content) || PERSISTED_SUBAGENT_ELAPSED_NOTE.test(message.content))
	);
}

/** True only for the old per-request scaffold that providers must continue to ignore. */
export function isLegacySubagentElapsedNote(message: Message | null | undefined): boolean {
	return (
		message?.role === "developer" &&
		message.synthetic === true &&
		typeof message.content === "string" &&
		LEGACY_SUBAGENT_ELAPSED_NOTE.test(message.content)
	);
}

/**
 * Persisted checkpoints are ordinary history, emitted at most once per five minutes.
 * Keep them in provider chains: replaying to remove checkpoints would discard warm
 * continuation state, while these notes intentionally remain in the transcript.
 */
export function isPersistedSubagentElapsedNote(message: Message | null | undefined): boolean {
	return (
		message?.role === "developer" &&
		typeof message.content === "string" &&
		PERSISTED_SUBAGENT_ELAPSED_NOTE.test(message.content)
	);
}
