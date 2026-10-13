import type { Context, DeveloperMessage } from "@oh-my-pi/pi-ai";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { isSubagentElapsedNote } from "@oh-my-pi/pi-ai/utils/subagent-elapsed-note";
import { prompt } from "@oh-my-pi/pi-utils";
import subagentElapsedNoteTemplate from "../prompts/tools/subagent-elapsed-note.md" with { type: "text" };

export function withSubagentElapsedSignal(context: Context, elapsedSeconds: number): Context {
	const messages = context.messages.filter(message => !isSubagentElapsedNote(message));
	const note: DeveloperMessage = {
		role: "developer",
		content: prompt.render(subagentElapsedNoteTemplate, { elapsedSeconds }),
		synthetic: true,
		timestamp: Date.now(),
	};
	// Provider cache logic skips per-call context: the note changes every request.
	markPerCallContextMessage(note);
	return { ...context, messages: [...messages, note] };
}
