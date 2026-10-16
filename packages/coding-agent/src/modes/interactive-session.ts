import { untilAborted } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "../session/session-manager";
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
	/** Draft sidecar belongs to the runtime writer, even when the terminal is remote. */
	saveDraft(text: string): Promise<void>;
	consumeDraft(): Promise<string | null>;
}

/** Bind calls to their runtime owner and read state live, never from a snapshot. */
export function createLocalInteractiveSessionConnection(
	session: Omit<InteractiveSessionConnection, "waitForSettled" | "saveDraft" | "consumeDraft"> & {
		sessionManager: Pick<SessionManager, "saveDraft" | "consumeDraft">;
	} & Pick<AgentSession, "waitForIdle" | "settleAsyncWork">,
): InteractiveSessionConnection {
	return {
		saveDraft: text => session.sessionManager.saveDraft(text),
		consumeDraft: () => session.sessionManager.consumeDraft(),
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
