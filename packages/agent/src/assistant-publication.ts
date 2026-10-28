import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

type AssistantPublicationGateResult = { replacementText: string; settled?: true; preserveImages?: true };
type AssistantPublicationGate = (
	message: AssistantMessage,
	signal: AbortSignal,
) => void | AssistantPublicationGateResult | Promise<void | AssistantPublicationGateResult>;

const settledAssistantMessages = new WeakSet<AssistantMessage>();

export function markAssistantPublicationSettled(message: AssistantMessage): void {
	settledAssistantMessages.add(message);
}

export function isAssistantPublicationSettled(message: AssistantMessage): boolean {
	return settledAssistantMessages.has(message);
}

const gates = new WeakMap<object, AssistantPublicationGate>();
const gateProviders = new WeakMap<object, () => AssistantPublicationGate | undefined>();
const providerReplayState = new WeakMap<
	AssistantMessage,
	{ thinking: AssistantMessage["content"]; providerPayload?: AssistantMessage["providerPayload"] }
>();

/** Internal bridge for coding-agent; intentionally not re-exported from the SDK entry point. */
export function setAssistantPublicationGate(owner: object, gate: AssistantPublicationGate | undefined): void {
	gateProviders.delete(owner);
	if (gate) gates.set(owner, gate);
	else gates.delete(owner);
}

/** Internal bridge for owners whose gate may change during an active agent loop. */
export function setAssistantPublicationGateProvider(
	owner: object,
	provider: (() => AssistantPublicationGate | undefined) | undefined,
): void {
	gates.delete(owner);
	if (provider) gateProviders.set(owner, provider);
	else gateProviders.delete(owner);
}

export function getAssistantPublicationGate(owner: object): AssistantPublicationGate | undefined {
	return gateProviders.get(owner)?.() ?? gates.get(owner);
}

/** Build a provider-only copy for replay; the admitted message stays redacted. */
export function snapshotAssistantMessageForProviderReplay(message: AssistantMessage): AssistantMessage {
	const state = providerReplayState.get(message);
	if (!state || state.thinking.length === 0) return message;
	return {
		...message,
		content: [...state.thinking.map(block => ({ ...block })), ...message.content.map(block => ({ ...block }))],
		...(state.providerPayload !== undefined ? { providerPayload: state.providerPayload } : {}),
	};
}

/** Carry private continuation state across detached lifecycle/history snapshots. */
export function copyAssistantProviderReplayState(from: AssistantMessage, to: AssistantMessage): void {
	if (settledAssistantMessages.has(from)) settledAssistantMessages.add(to);
	if (narrativeReplacedMessages.has(from)) narrativeReplacedMessages.add(to);
	const state = providerReplayState.get(from);
	if (!state) return;
	providerReplayState.set(to, {
		thinking: state.thinking.map(block => ({ ...block })),
		...(state.providerPayload !== undefined ? { providerPayload: structuredClone(state.providerPayload) } : {}),
	});
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const narrativeReplacedMessages = new WeakSet<AssistantMessage>();

/** Safe narrative used when the publication gate cannot approve a draft. */
export const ASSISTANT_GATE_REFUSAL = "Assistant response withheld because its delivery could not be approved.";

/** Safe narrative used when a turn was aborted (restart or steer) before its draft was delivered; nothing was refused. */
export function assistantAbortedDraftText(reason?: string): string {
	const detail = reason?.trim();
	return `Response interrupted before delivery${detail ? ` (${detail})` : ""}; the draft was not sent.`;
}

export const ASSISTANT_ABORTED_DRAFT = assistantAbortedDraftText();

export function isAssistantNarrativeReplaced(message: AssistantMessage): boolean {
	return narrativeReplacedMessages.has(message);
}

export function replaceAssistantNarrative(
	message: AssistantMessage,
	replacementText: string,
	options: { preserveImages?: true } = {},
): void {
	const content: AssistantMessage["content"] = [];
	const keepProviderThinking = message.content.some(block => block.type === "toolCall");
	const providerThinking = keepProviderThinking
		? message.content.filter(block => block.type === "thinking" || block.type === "redactedThinking")
		: [];
	if (providerThinking.length > 0) {
		providerReplayState.set(message, {
			thinking: providerThinking.map(block => ({ ...block })),
			...(message.providerPayload !== undefined
				? { providerPayload: structuredClone(message.providerPayload) }
				: {}),
		});
	} else {
		providerReplayState.delete(message);
	}
	narrativeReplacedMessages.add(message);
	let addedReplacement = false;
	for (const block of message.content) {
		if (
			block.type === "toolCall" ||
			block.type === "fallback" ||
			block.type === "anthropicServerTool" ||
			(options.preserveImages === true && block.type === "image")
		) {
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

/** Admit the draft before detached lifecycle/history snapshots become public. */
export async function admitAssistantMessage(
	message: AssistantMessage,
	gate: AssistantPublicationGate | undefined,
	signal: AbortSignal | undefined,
	abortReasonText: (signal: AbortSignal | undefined) => string,
): Promise<void> {
	if (!gate) return;
	const gateSignal = signal ?? NEVER_ABORTED_SIGNAL;
	let detachAbort: (() => void) | undefined;
	try {
		if (gateSignal.aborted) throw gateSignal.reason;
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(gateSignal.reason);
		gateSignal.addEventListener("abort", onAbort, { once: true });
		detachAbort = () => gateSignal.removeEventListener("abort", onAbort);
		const result = await Promise.race([gate(message, gateSignal), aborted.promise]);
		if (gateSignal.aborted) throw gateSignal.reason;
		if (result !== undefined) {
			if (
				!result ||
				typeof result.replacementText !== "string" ||
				(result.settled !== undefined && result.settled !== true) ||
				(result.preserveImages !== undefined && result.preserveImages !== true)
			) {
				throw new Error("Invalid assistant gate result");
			}
			replaceAssistantNarrative(message, result.replacementText, { preserveImages: result.preserveImages });
			if (result.settled) markAssistantPublicationSettled(message);
		}
	} catch {
		replaceAssistantNarrative(
			message,
			gateSignal.aborted ? assistantAbortedDraftText(abortReasonText(gateSignal)) : ASSISTANT_GATE_REFUSAL,
		);
		if (gateSignal.aborted) {
			message.stopReason = "aborted";
			message.errorMessage = abortReasonText(gateSignal);
			message.errorId = AIError.classify(gateSignal.reason) || AIError.create(AIError.Flag.Abort);
		}
	} finally {
		detachAbort?.();
	}
}
