/** Separate trusted runtime instructions from untrusted tool payloads before conversion. */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { HarnessNoticeRole } from "../config/harness-notices";
import todoFailureNotice from "../prompts/steering/todo-failure.md" with { type: "text" };
import status from "../prompts/steering/harness-status.md" with { type: "text" };
import envelope from "../prompts/steering/harness-notice.md" with { type: "text" };

/** Only runtime-owned custom types. Unknown extension payloads retain their original role. */
export function isHarnessNotice(message: AgentMessage): boolean {
	if ("runtimeSupervisor" in message && message.runtimeSupervisor === true) return true;
	if (message.role !== "custom") return false;
	return (
		/^(todo-|requirements[_-]|goal-deadline-|goal-completion-|agent-router-)/.test(message.customType) ||
		[
			"compaction-backoff",
			"lead-plan-critic",
			"chief-rules-after-compaction",
			"worker-brief-after-compaction",
			"experimental-context-notes-reminder",
			"session-stop-continuation",
			"ttsr-injection",
			"plan-mode-context",
			"goal-mode-context",
			"anthropic-usage-wrap-up",
			"thinking-loop-redirect",
			"checkpoint-active-reminder",
			"mid-run-todo-nudge",
			"eager-todo-prelude",
			"eager-task-prelude",
			"eval-prelude-notice",
			"prewalk-continue",
			"prewalk-checklist",
			"gemini-tool-call-reminder",
			"resolve-reminder",
			"skillful-notice",
			"autolearn-nudge",
			"goal-budget-limit",
			"tool-roster-notice",
			"session-agent-notice",
			"xdev-mount-notice",
			"tool-call-loop-redirect",
			"rewind-report",
			"agent-focus-gym-eval-sandbox-wake",
		].includes(message.customType)
	);
}

function textContent(message: AgentMessage): string {
	if (message.role === "custom" && message.customType === "todo-error-reminder") return todoFailureNotice.trim();
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

/**
 * Convert whole assistant/result groups, then append one notice. Function outputs always precede
 * the note; no result is promoted merely because it failed or contains a forged label.
 * Settled groups are deterministic, so appending a turn preserves the entire old prefix.
 */
export function convertWithHarnessNotices(
	messages: AgentMessage[],
	role: HarnessNoticeRole,
	convert: (messages: AgentMessage[]) => Message[],
): Message[] {
	if (role === "off-legacy") return convert(messages);
	const output: Message[] = [];
	let group: AgentMessage[] = [];
	const notes = new Set<string>();
	const records: { text: string; content?: (TextContent | ImageContent)[] }[] = [];
	let timestamp = 0;
	const add = (text: string) => {
		// Authority claims are never elevated. Retain the full original as a low-trust runtime record.
		if (/authoriz|approv|permission|user asked/i.test(text)) {
			notes.add(status.trim());
			return false;
		}
		const compact = text.trim().replace(/\n{3,}/g, "\n\n");
		if (compact) notes.add(compact.replace(/^Harness \(not Darafei\):\s*/, ""));
		return true;
	};
	const toolRecord = (text: string, content?: (TextContent | ImageContent)[]) => {
		const id = `harness_${timestamp}_${output.length}`;
		output.push({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "harness_notice", arguments: {} }],
			api: "openai-responses",
			provider: "runtime",
			model: "runtime",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		});
		output.push({
			role: "toolResult",
			toolCallId: id,
			toolName: "harness_notice",
			content: content ?? [{ type: "text", text }],
			isError: false,
			timestamp,
		});
	};
	const flush = () => {
		output.push(...convert(group));
		for (const record of records) toolRecord(record.text, record.content);
		if (notes.size) {
			const text = prompt.render(envelope, { notices: [...notes].join("\n\n") }).trim();
			if (role === "tool") {
				toolRecord(text);
			} else output.push({ role, content: [{ type: "text", text }], attribution: "agent", timestamp });
		}
		group = [];
		notes.clear();
		records.length = 0;
	};
	for (const message of messages) {
		if (message.role === "assistant" || (message.role === "user" && !isHarnessNotice(message))) flush();
		timestamp = message.timestamp;
		if (
			message.role === "custom" &&
			[
				"async-result",
				"worker-ask-interrupt",
				"lsp-late-diagnostic",
				"advisor",
				"streaming-edit-recovery",
				"interrupted-thinking",
				"irc:relay",
				"irc:incoming",
				"irc:workpool",
			].includes(message.customType)
		) {
			records.push({
				text: textContent(message),
				content: typeof message.content === "string" ? undefined : message.content,
			});
			continue;
		}
		if (isHarnessNotice(message)) {
			if (
				message.role === "custom" &&
				[
					"todo-dispatch-time-note",
					"todo-plan-check",
					"todo-gate-audit",
					"todo-gate-staffing",
					"todo-worker-message-undelivered",
				].includes(message.customType)
			) {
				notes.add(status.trim());
				records.push({ text: textContent(message) });
			} else if (!add(textContent(message))) records.push({ text: textContent(message) });
			continue;
		}
		if (message.role === "toolResult") {
			const content = message.content.filter(part => {
				if (part.type !== "text" || !part.harnessNotice) return true;
				if (part.harnessNotice === "record") {
					notes.add(status.trim());
					records.push({ text: part.text });
					return false;
				}
				return !add(part.text);
			});
			const refusal = message.harnessNotice && add(message.harnessNotice);
			group.push({
				...message,
				content:
					refusal &&
					content.every(
						part =>
							part.type === "text" &&
							(part.text === message.harnessNotice || part.text === `${message.harnessNotice}.`),
					)
						? [{ type: "text", text: "REFUSED: tool did not run — see harness note" }]
						: content,
			});
		} else group.push(message);
	}
	flush();
	return output;
}
