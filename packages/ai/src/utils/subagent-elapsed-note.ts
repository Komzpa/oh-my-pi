import type { Message } from "../types";

const SUBAGENT_ELAPSED_NOTE = /^elapsed \d+s \/ 900s$/;

/**
 * True for the provider-only advisory developer message the task executor
 * appends to a subagent's context on every request (`elapsed Ns / 900s`).
 *
 * It is scaffolding, not conversation: providers must not treat it as the
 * active turn, as a retained-history message, or as part of a cache/chain
 * baseline. This is the single definition every provider and the producer share.
 */
export function isSubagentElapsedNote(message: Message | null | undefined): boolean {
	return (
		message?.role === "developer" &&
		message.synthetic === true &&
		typeof message.content === "string" &&
		SUBAGENT_ELAPSED_NOTE.test(message.content)
	);
}
