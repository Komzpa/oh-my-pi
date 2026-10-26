import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import contextNotesDescription from "../prompts/tools/context-notes.md" with { type: "text" };
import contextNotesTextDescription from "../prompts/tools/context-notes-text.md" with { type: "text" };
import newContextDescription from "../prompts/tools/new-context.md" with { type: "text" };
import {
	CONTEXT_NOTES_ENTRY_TYPE,
	type ContextNotesEntry,
	getContextNotes,
	MAX_CONTEXT_NOTES_BYTES,
} from "../session/context-notes";
import { cfgCompactionExperimentalContextManagement } from "../session/context-settings";
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

const contextNotesSchema = type({
	action: type
		.enumerated("read", "replace", "clear")
		.describe(
			'Required operation. "read" returns the latest notebook and never changes it, even if text is also supplied. "replace" replaces the entire notebook with text (required, nonempty). "clear" is the only way to clear the notebook. Examples: {action: "read"}, {action: "replace", text: "..."}, {action: "clear"}.',
		),
	"text?": type("string").describe(prompt.render(contextNotesTextDescription, { maxBytes: MAX_CONTEXT_NOTES_BYTES })),
});

const newContextSchema = type({});

export type ContextNotesParams = typeof contextNotesSchema.infer;
export type NewContextParams = typeof newContextSchema.infer;

export interface ContextNotesToolDetails {
	entryId?: string;
	text: string;
	bytes?: number;
}

export interface NewContextToolDetails {
	requested: true;
}

type ExperimentalContextSessionManager = NonNullable<ToolSession["sessionManager"]>;

function resolveExperimentalContextSession(session: ToolSession): ExperimentalContextSessionManager | undefined {
	if (cfgCompactionExperimentalContextManagement.get(session.settings) !== true || session.isDisposed?.()) {
		return undefined;
	}
	const manager = session.sessionManager;
	const ownerId = session.getSessionId?.();
	if (!manager || !ownerId || manager.getSessionId?.() !== ownerId) return undefined;
	return manager;
}

/**
 * Resolves the live session journal only when experimental context management is enabled and
 * owned by this ToolSession. The identity comparison prevents advisor tools from writing the
 * parent agent's notebook or resolving its raw history.
 */
export function getExperimentalContextSession(session: ToolSession): ExperimentalContextSessionManager {
	const manager = resolveExperimentalContextSession(session);
	if (manager) return manager;
	if (cfgCompactionExperimentalContextManagement.get(session.settings) !== true) {
		throw new ToolError("Experimental context management is disabled.");
	}
	if (session.isDisposed?.()) {
		throw new ToolError("Experimental context management is unavailable because this session is disposed.");
	}
	throw new ToolError("Experimental context management is unavailable for this session.");
}

function createIfSupported<T extends ContextNotesTool | NewContextTool>(
	session: ToolSession,
	ToolClass: new (session: ToolSession) => T,
): T | null {
	return resolveExperimentalContextSession(session) ? new ToolClass(session) : null;
}

/** Reads or replaces the current branch's durable experimental notebook. */
export class ContextNotesTool implements AgentTool<typeof contextNotesSchema, ContextNotesToolDetails> {
	readonly name = "context_notes";
	readonly approval = (args: unknown): ToolApprovalDecision =>
		args !== null && typeof args === "object" && "action" in args && args.action === "read" ? "read" : "write";
	readonly label = "Context Notes";
	readonly description = contextNotesDescription;
	readonly parameters = contextNotesSchema;
	// Strict-mode providers mark every property required, which would force a
	// `text` value on read/clear calls. Stay non-strict so `text` stays optional;
	// the required `action` enum — never text presence or emptiness — selects
	// the operation, so a read can never be mistaken for a clear.
	readonly strict = false;
	readonly loadMode = "essential" as const;
	readonly summary = "Read or replace persistent experimental context notes";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ContextNotesTool | null {
		return createIfSupported(session, ContextNotesTool);
	}

	async execute(
		_id: string,
		params: ContextNotesParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ContextNotesToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ContextNotesToolDetails>> {
		const manager = getExperimentalContextSession(this.session);
		throwIfAborted(signal);
		const action: unknown = params.action;
		if (action !== "read" && action !== "replace" && action !== "clear") {
			throw new ToolError(
				'Context notes were not changed; the existing notebook is unchanged. context_notes requires action: "read", "replace", or "clear" — for example context_notes({i: "Reading current notebook", action: "read"}), context_notes({i: "Saving notebook", action: "replace", text: "..."}), or context_notes({i: "Clearing notebook", action: "clear"}). There is no default operation: omitted text no longer means read and empty text no longer clears.',
			);
		}
		if (action === "read") {
			// Read never mutates, whatever placeholder text a model may also send.
			const notes = getContextNotes(manager.getBranch());
			return {
				content: [{ type: "text", text: notes?.text ?? "No context notes are stored for this session branch." }],
				details: notes ? { entryId: notes.entryId, text: notes.text } : { entryId: undefined, text: "" },
			};
		}

		let text: string;
		if (action === "clear") {
			text = "";
		} else {
			if (typeof params.text !== "string" || params.text.length === 0) {
				throw new ToolError(
					'Context notes were not saved; the existing notebook is unchanged. action: "replace" requires a nonempty text replacement. To read without changing anything use action: "read"; to clear the notebook use action: "clear" — empty text never clears.',
				);
			}
			text = params.text;
		}

		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > MAX_CONTEXT_NOTES_BYTES) {
			const excess = bytes - MAX_CONTEXT_NOTES_BYTES;
			throw new ToolError(
				`Context notes were not saved; the existing notebook is unchanged. The replacement is ${bytes} UTF-8 bytes, ${excess} bytes over the limit of ${MAX_CONTEXT_NOTES_BYTES} UTF-8 bytes. Read the current notebook with context_notes({i: "Reading current notebook", action: "read"}), recover any dropped detail from history://current/full, then retry with action: "replace" and a compact replacement that removes superseded entries and references history entry IDs instead of copying raw content. Do not finish the checkpoint until a replacement save succeeds.`,
			);
		}

		const ownerId = this.session.getSessionId?.();
		const branchLeafId = manager.getBranch().at(-1)?.id;
		await manager.ensureOnDisk();
		throwIfAborted(signal);
		const currentManager = getExperimentalContextSession(this.session);
		if (
			currentManager !== manager ||
			this.session.isDisposed?.() ||
			!ownerId ||
			this.session.getSessionId?.() !== ownerId ||
			manager.getSessionId?.() !== ownerId ||
			manager.getBranch().at(-1)?.id !== branchLeafId
		) {
			throw new ToolError("Experimental context notes were not saved because the session branch changed.");
		}

		const data: ContextNotesEntry = { version: 1, text };
		const entryId = manager.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, data);
		await manager.flush();
		return {
			content: [{ type: "text", text: action === "clear" ? "Context notes cleared." : "Context notes saved." }],
			details: { entryId, text, bytes },
		};
	}
}

/** Requests a fresh context window; the owning lifecycle consumes this turn-local signal. */
export class NewContextTool implements AgentTool<typeof newContextSchema, NewContextToolDetails> {
	readonly name = "new_context";
	readonly approval = "write" as const;
	readonly label = "New Context";
	readonly description = newContextDescription;
	readonly parameters = newContextSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Request a fresh context window";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): NewContextTool | null {
		return createIfSupported(session, NewContextTool);
	}

	async execute(
		_id: string,
		_params: NewContextParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<NewContextToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<NewContextToolDetails>> {
		getExperimentalContextSession(this.session);
		throwIfAborted(signal);
		return {
			content: [{ type: "text", text: "New context window requested." }],
			details: { requested: true },
		};
	}
}
