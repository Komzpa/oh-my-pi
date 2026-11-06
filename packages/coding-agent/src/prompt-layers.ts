import type { Message, Tool } from "@oh-my-pi/pi-ai";
import { dateCwdReminderPrefix } from "./session/date-cwd-reminder";
import type { PromptLayerIndex } from "./system-prompt";

/** Diagnostic text coordinates, not provider token positions. Tools are a separate wire channel. */
export function measurePromptLayers(
	systemPrompt: readonly string[],
	index: PromptLayerIndex | undefined,
	messages: readonly Message[] = [],
	tools: readonly Tool[] = [],
) {
	const system = systemPrompt.join("\n\n");
	// Custom/extension overrides can replace generated blocks. Never claim their old boundaries.
	if (!index || index.project !== system.length) return { unindexed: true };
	const firstUser = messages.findIndex(message => message.role === "user");
	const first = messages[firstUser];
	const reminder = first ? dateCwdReminderPrefix(first) : undefined;
	const dynamic = JSON.stringify(messages.slice(0, firstUser < 0 ? messages.length : firstUser)) + (reminder ?? "");
	const tail = messages.slice(firstUser < 0 ? messages.length : firstUser);
	if (reminder && first.role === "user") {
		tail[0] = {
			...first,
			content: typeof first.content === "string" ? first.content.slice(reminder.length + 2) : first.content.slice(1),
		};
	}
	const turns = JSON.stringify(tail);
	const text = system + dynamic + turns;
	let start = 0;
	const layers = Object.entries({ ...index, dynamic: system.length + dynamic.length, turns: text.length }).map(
		([layer, end]) => {
			const content = text.slice(start, end);
			const result = {
				layer,
				end,
				chars: end - start,
				estimatedTokens: Math.ceil(content.length / 4),
				sha256: Bun.SHA256.hash(content, "hex"),
			};
			start = end;
			return result;
		},
	);
	const schemas = JSON.stringify(tools);
	return {
		coordinate:
			"UTF-16 chars: system.join(\\n\\n) + JSON(pre-user messages) + reminder + JSON(turns without reminder)",
		tokenEstimate: "ceil(chars/4)",
		layers,
		tools: {
			chars: schemas.length,
			estimatedTokens: Math.ceil(schemas.length / 4),
			sha256: Bun.SHA256.hash(schemas, "hex"),
		},
	};
}
