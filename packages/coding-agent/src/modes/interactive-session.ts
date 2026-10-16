import { untilAborted } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "../session/session-manager";
import type { AgentSessionDisposeOptions } from "../session/agent-session-types";
import type { AgentSession } from "../session/agent-session";

/**
 * Turn control and events used by the interactive session owner. This boundary
 * can outlive a terminal view; explicit owner disposal is separate from view detachment.
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
	/** Explicit owner termination; never called merely to release a view lease. */
	beginDispose(): void | Promise<void>;
	disposeSession(options?: AgentSessionDisposeOptions): Promise<void>;
	/** Release and seal the owner journal after restart admission and draft persistence. */
	checkpoint(): Promise<void>;
}

/** Bind calls to their runtime owner and read state live, never from a snapshot. */
export function createLocalInteractiveSessionConnection(
	session: Omit<
		InteractiveSessionConnection,
		"waitForSettled" | "saveDraft" | "consumeDraft" | "beginDispose" | "disposeSession" | "checkpoint"
	> & {
		sessionManager: Pick<SessionManager, "saveDraft" | "consumeDraft" | "close" | "seal">;
	} & Pick<AgentSession, "waitForIdle" | "settleAsyncWork" | "beginDispose" | "dispose">,
): InteractiveSessionConnection {
	return {
		beginDispose: () => session.beginDispose(),
		disposeSession: options => session.dispose(options),
		async checkpoint() {
			await session.sessionManager.close();
			session.sessionManager.seal();
		},
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
