import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import type { SessionEntry } from "../session/session-entries";
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

export type LocalInteractiveViewSession = Pick<
	AgentSession,
	"sessionId" | "sessionFile" | "buildTranscriptSessionContext" | "agent" | "isStreaming" | "sessionManager"
>;

export interface InteractiveViewMetadataProvider {
	getEntryCount(): number;
	getCompactionCount(): number;
}

/** Adapt independent eager/selective managers here; view code never enumerates for counts. */
export function createInteractiveViewMetadataProvider(
	manager: Pick<SessionManager, "getEntries"> &
		Partial<{
			getEntryCount(): number;
			iterateEntries(type?: SessionEntry["type"]): Iterable<SessionEntry>;
		}>,
): InteractiveViewMetadataProvider {
	const count = manager.getEntryCount?.bind(manager);
	const iterate = manager.iterateEntries?.bind(manager);
	return {
		getEntryCount: count ?? (() => manager.getEntries().length),
		getCompactionCount: iterate
			? () => {
					let count = 0;
					for (const _entry of iterate("compaction")) count++;
					return count;
				}
			: () => manager.getEntries().filter(entry => entry.type === "compaction").length,
	};
}

/** Follow focused sessions while adapting each owner's capabilities only once. */
export function createInteractiveViewSourceRouter(
	getSession: () => LocalInteractiveViewSession,
	initial?: readonly [LocalInteractiveViewSession, InteractiveViewSource],
): InteractiveViewSource {
	const sources = new WeakMap<LocalInteractiveViewSession, InteractiveViewSource>();
	if (initial) sources.set(initial[0], initial[1]);
	const current = () => {
		const session = getSession();
		let source = sources.get(session);
		if (!source) {
			source = createLocalInteractiveViewSource(session);
			sources.set(session, source);
		}
		return source;
	};
	return { revision: () => current().revision?.(), capture: options => current().capture(options) };
}

export function createLocalInteractiveViewSource(
	session: LocalInteractiveViewSession,
	metadata: InteractiveViewMetadataProvider = createInteractiveViewMetadataProvider(session.sessionManager),
): InteractiveViewSource {
	return {
		revision: () => metadata.getEntryCount(),
		capture(options) {
			return {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				context: session.buildTranscriptSessionContext({ ...options, keepInFlightToolCalls: session.isStreaming }),
				streamMessage: session.agent.state.streamMessage,
				pendingToolCallIds: [...session.agent.state.pendingToolCalls],
				isStreaming: session.isStreaming,
				entryCount: metadata.getEntryCount(),
				compactionCount: metadata.getCompactionCount(),
			};
		},
	};
}

/** A checkpoint must never silently discard a late tool result from its old owner. */
export function assertInteractiveOwnerCanCheckpoint(
	session: Pick<
		AgentSession,
		| "isStreaming"
		| "isCompacting"
		| "hasPostPromptWork"
		| "queuedMessageCount"
		| "hasPendingAsyncWork"
		| "hasAdmittedSubmission"
	>,
): void {
	if (
		session.hasAdmittedSubmission ||
		session.isStreaming ||
		session.isCompacting ||
		session.hasPostPromptWork ||
		session.queuedMessageCount > 0 ||
		session.hasPendingAsyncWork()
	) {
		throw new Error("Runtime journal is still owned by active work; detach the view without checkpointing");
	}
}
