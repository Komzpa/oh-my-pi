import type { Context } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import subagentElapsedNoteTemplate from "../prompts/tools/subagent-elapsed-note.md" with { type: "text" };

const SUBAGENT_ELAPSED_NOTE = /^elapsed \d+s \/ 900s$/;

export function withSubagentElapsedSignal(context: Context, elapsedSeconds: number): Context {
	const messages = context.messages.filter(
		message =>
			message.role !== "developer" ||
			!message.synthetic ||
			typeof message.content !== "string" ||
			!SUBAGENT_ELAPSED_NOTE.test(message.content),
	);
	return {
		...context,
		messages: [
			...messages,
			{
				role: "developer",
				content: prompt.render(subagentElapsedNoteTemplate, { elapsedSeconds }),
				synthetic: true,
				timestamp: Date.now(),
			},
		],
	};
}
