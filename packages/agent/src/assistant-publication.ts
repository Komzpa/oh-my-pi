import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentBeforeAssistantMessage } from "./types";

/** Safe narrative used when the publication gate cannot approve a draft. */
export const ASSISTANT_GATE_REFUSAL = "Assistant response withheld because its delivery could not be approved.";
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const narrativeReplacedMessages = new WeakSet<AssistantMessage>();

export function isAssistantNarrativeReplaced(message: AssistantMessage): boolean {
	return narrativeReplacedMessages.has(message);
}

export function replaceAssistantNarrative(message: AssistantMessage, replacementText: string): void {
	const content: AssistantMessage["content"] = [];
	narrativeReplacedMessages.add(message);
	let addedReplacement = false;
	for (const block of message.content) {
		if (block.type === "toolCall" || block.type === "fallback" || block.type === "anthropicServerTool") {
			if (block.type === "toolCall") delete block.intent;
			content.push(block);
		} else if (replacementText && !addedReplacement) {
			content.push({ type: "text", text: replacementText });
			addedReplacement = true;
		}
	}
	if (replacementText && !addedReplacement) content.push({ type: "text", text: replacementText });
	message.content = content;
	// Opaque native history can replay the original prose even after content changes.
	delete message.providerPayload;
}

/** Preserve the callback's exact message identity through final public events. */
export async function admitAssistantMessage(
	message: AssistantMessage,
	gate: AgentBeforeAssistantMessage | undefined,
	signal: AbortSignal | undefined,
	abortReasonText: (signal: AbortSignal | undefined) => string,
): Promise<void> {
	if (!gate) return;
	const gateSignal = signal ?? NEVER_ABORTED_SIGNAL;
	let detachAbort: (() => void) | undefined;
	try {
		if (gateSignal.aborted) throw gateSignal.reason;
		const aborted = new Promise<never>((_resolve, reject) => {
			const onAbort = () => reject(gateSignal.reason);
			gateSignal.addEventListener("abort", onAbort, { once: true });
			detachAbort = () => gateSignal.removeEventListener("abort", onAbort);
		});
		const result = await Promise.race([gate(message, gateSignal), aborted]);
		if (gateSignal.aborted) throw gateSignal.reason;
		if (result !== undefined) {
			if (
				!result ||
				typeof result.replacementText !== "string" ||
				(result.settled !== undefined && result.settled !== true)
			) {
				throw new Error("Invalid assistant gate result");
			}
			replaceAssistantNarrative(message, result.replacementText);
		}
	} catch {
		replaceAssistantNarrative(message, ASSISTANT_GATE_REFUSAL);
		if (gateSignal.aborted) {
			message.stopReason = "aborted";
			message.errorMessage = abortReasonText(gateSignal);
			message.errorId = AIError.classify(gateSignal.reason) || AIError.create(AIError.Flag.Abort);
		}
	} finally {
		detachAbort?.();
	}
}
