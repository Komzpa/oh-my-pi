import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../session/agent-session";
import type { SessionContext } from "../session/session-context";

/** Serializable presentation state. Capturing it never claims or consumes a journal. */
export interface InteractiveViewSnapshot {
	sessionId: string;
	sessionFile?: string;
	context: SessionContext;
	streamMessage: AgentMessage | null;
	pendingToolCallIds: string[];
	isStreaming: boolean;
	entryCount: number;
	compactionCount: number;
}

/** A view reads the current runtime, rather than reconstructing another AgentSession. */
export interface InteractiveViewSource {
	/** Cheap local revision probe; remote sources may omit it. */
	revision?(): number | Promise<number> | undefined;
	capture(options?: {
		collapseCompactedHistory?: boolean;
	}): InteractiveViewSnapshot | Promise<InteractiveViewSnapshot>;
}

export function createLocalInteractiveViewSource(
	session: Pick<
		AgentSession,
		"sessionId" | "sessionFile" | "buildTranscriptSessionContext" | "agent" | "isStreaming" | "sessionManager"
	>,
): InteractiveViewSource {
	return {
		revision: () => session.sessionManager.getEntries().length,
		capture(options) {
			return {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				context: session.buildTranscriptSessionContext({ ...options, keepInFlightToolCalls: session.isStreaming }),
				streamMessage: session.agent.state.streamMessage,
				pendingToolCallIds: [...session.agent.state.pendingToolCalls],
				isStreaming: session.isStreaming,
				entryCount: session.sessionManager.getEntries().length,
				compactionCount: session.sessionManager.getEntries().filter(entry => entry.type === "compaction").length,
			};
		},
	};
}

/** A checkpoint must never silently discard a late tool result from its old owner. */
export function assertInteractiveOwnerCanCheckpoint(
	session: Pick<
		AgentSession,
		"isStreaming" | "isCompacting" | "hasPostPromptWork" | "queuedMessageCount" | "hasPendingAsyncWork"
	>,
): void {
	if (
		session.isStreaming ||
		session.isCompacting ||
		session.hasPostPromptWork ||
		session.queuedMessageCount > 0 ||
		session.hasPendingAsyncWork()
	) {
		throw new Error("Runtime journal is still owned by active work; detach the view without checkpointing");
	}
}
