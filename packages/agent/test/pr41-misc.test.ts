import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { replaceAssistantNarrative, snapshotAssistantMessageForProviderReplay } from "../src/assistant-publication";
import { createAssistantMessage } from "./helpers";

describe("pr41-misc: private thinking retention", () => {
	it("keeps signed provider replay private while publishing only the replacement and tool call", () => {
		const message = createAssistantMessage([
			{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig-v1", itemId: "item-1" },
			{ type: "text", text: "unapproved narrative" },
			{ type: "redactedThinking", data: "opaque-provider-state" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		]);
		message.providerPayload = {
			type: "openaiResponsesHistory",
			items: [{ type: "message", content: [{ type: "output_text", text: "unapproved narrative" }] }],
		};

		replaceAssistantNarrative(message, "safe replacement");

		expect(message.content).toEqual([
			{ type: "text", text: "safe replacement" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		]);
		const replay: AssistantMessage = snapshotAssistantMessageForProviderReplay(message);
		expect(replay.content[0]).toMatchObject({
			type: "thinking",
			thinking: "private reasoning",
			thinkingSignature: "sig-v1",
			itemId: "item-1",
		});
		expect(replay.content.map(block => block.type)).toEqual(["thinking", "redactedThinking", "text", "toolCall"]);
		expect(replay.content[1]).toEqual({ type: "redactedThinking", data: "opaque-provider-state" });
		expect(replay.providerPayload).toMatchObject({
			type: "openaiResponsesHistory",
			items: [{ content: [{ text: "unapproved narrative" }] }],
		});
	});
});
