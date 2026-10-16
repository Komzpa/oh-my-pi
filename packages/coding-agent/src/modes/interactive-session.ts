import type { AgentSession } from "../session/agent-session";

/**
 * Turn control and events used by the interactive session owner. This boundary
 * can outlive a terminal view; it does not own or dispose the underlying runtime.
 * Other UI controllers still use the concrete local session until migrated.
 */
export interface InteractiveSessionConnection extends Pick<
	AgentSession,
	"prompt" | "abort" | "subscribe" | "isStreaming" | "isCompacting" | "hasPostPromptWork"
> {}

/** Bind calls to their runtime owner and read state live, never from a snapshot. */
export function createLocalInteractiveSessionConnection(
	session: InteractiveSessionConnection,
): InteractiveSessionConnection {
	return {
		prompt: (...args) => session.prompt(...args),
		abort: (...args) => session.abort(...args),
		subscribe: (...args) => session.subscribe(...args),
		get isStreaming() {
			return session.isStreaming;
		},
		get isCompacting() {
			return session.isCompacting;
		},
		get hasPostPromptWork() {
			return session.hasPostPromptWork;
		},
	};
}
