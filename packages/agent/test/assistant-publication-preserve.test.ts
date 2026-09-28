import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { admitAssistantMessage, snapshotAssistantMessageForProviderReplay } from "../src/assistant-publication";
import { createAssistantMessage } from "./helpers";

function toolTurn(): AssistantMessage {
	return createAssistantMessage([
		{ type: "thinking", thinking: "provider continuation", thinkingSignature: "sig-v1" },
		{ type: "text", text: "unapproved narrative" },
		{ type: "redactedThinking", data: "opaque-provider-state" },
		{ type: "image", data: "source-image", mimeType: "image/png" },
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
	]);
}

describe("assistant publication replacement retention", () => {
	it("keeps images only when requested and provider thinking private for tool replay", async () => {
		const message = toolTurn();
		const providerPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", content: [{ type: "output_text", text: "unapproved narrative" }] }],
		};
		message.providerPayload = providerPayload;
		await admitAssistantMessage(
			message,
			async () => ({ replacementText: "requirements remain open", settled: true, preserveImages: true }),
			undefined,
			() => "aborted",
		);
		expect(message.content.map(block => block.type)).toEqual(["text", "image", "toolCall"]);
		expect(message.content[0]).toMatchObject({ text: "requirements remain open" });
		expect(message.content[1]).toMatchObject({ data: "source-image", mimeType: "image/png" });
		const providerReplay = snapshotAssistantMessageForProviderReplay(message);
		expect(providerReplay.content.map(block => block.type)).toEqual([
			"thinking",
			"redactedThinking",
			"text",
			"image",
			"toolCall",
		]);
		expect(providerReplay.content[0]).toMatchObject({
			thinking: "provider continuation",
			thinkingSignature: "sig-v1",
		});
		expect(providerReplay.providerPayload).toEqual(providerPayload);
		providerPayload.items[0]!.content[0]!.text = "mutated after admission";
		expect(snapshotAssistantMessageForProviderReplay(message).providerPayload).toEqual({
			type: "openaiResponsesHistory",
			items: [{ type: "message", content: [{ type: "output_text", text: "unapproved narrative" }] }],
		});

		const ordinaryReplacement = toolTurn();
		await admitAssistantMessage(
			ordinaryReplacement,
			async () => ({ replacementText: "safe narrative", settled: true }),
			undefined,
			() => "aborted",
		);
		expect(ordinaryReplacement.content.some(block => block.type === "image")).toBe(false);
		expect(
			ordinaryReplacement.content.some(block => block.type === "thinking" && block.thinkingSignature === "sig-v1"),
		).toBe(false);
		expect(snapshotAssistantMessageForProviderReplay(ordinaryReplacement).content[0]).toMatchObject({
			type: "thinking",
			thinkingSignature: "sig-v1",
		});
	});

	it("drops signed thinking when no retained tool call needs provider replay", async () => {
		const message = createAssistantMessage([
			{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig-v1" },
			{ type: "text", text: "unapproved narrative" },
		]);
		await admitAssistantMessage(
			message,
			async () => ({ replacementText: "safe narrative" }),
			undefined,
			() => "aborted",
		);
		expect(message.content).toEqual([{ type: "text", text: "safe narrative" }]);
	});
});
