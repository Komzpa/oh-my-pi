import { untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";

/**
 * Turn control and events used by the interactive session owner. This boundary
 * can outlive a terminal view; it does not own or dispose the underlying runtime.
 * Other UI controllers still use the concrete local session until migrated.
 */
export interface InteractiveSessionConnection extends Pick<
	AgentSession,
	| "prompt"
	| "abort"
	| "subscribe"
	| "isStreaming"
	| "isCompacting"
	| "hasPostPromptWork"
	| "queuedMessageCount"
	| "hasPendingAsyncWork"
> {
	/** Observe owner quiescence without cancelling its work when the view goes away. */
	waitForSettled(signal?: AbortSignal): Promise<void>;
}

/** Bind calls to their runtime owner and read state live, never from a snapshot. */
export function createLocalInteractiveSessionConnection(
	session: Omit<InteractiveSessionConnection, "waitForSettled"> &
		Pick<AgentSession, "waitForIdle" | "settleAsyncWork">,
): InteractiveSessionConnection {
	return {
		prompt: (...args) => session.prompt(...args),
		abort: (...args) => session.abort(...args),
		subscribe: (...args) => session.subscribe(...args),
		async waitForSettled(signal) {
			await untilAborted(signal, async () => {
				while (true) {
					await session.waitForIdle();
					signal?.throwIfAborted();
					if (!session.hasPendingAsyncWork()) return;
					await session.settleAsyncWork();
					signal?.throwIfAborted();
				}
			});
		},
		hasPendingAsyncWork: () => session.hasPendingAsyncWork(),
		get queuedMessageCount() {
			return session.queuedMessageCount;
		},
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
