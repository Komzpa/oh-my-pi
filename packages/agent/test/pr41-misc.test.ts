/**
 * PR #41 misc fixes: assistant publication narrative replacement must keep
 * provider-signed thinking and redacted-thinking blocks (providers require
 * them verbatim on replay) while still dropping unsigned reasoning prose.
 */
import { describe, expect, it } from "bun:test";
import { replaceAssistantNarrative } from "@oh-my-pi/pi-agent-core/assistant-publication";
import { createAssistantMessage } from "./helpers";

describe("pr41-misc: replaceAssistantNarrative", () => {
	it("keeps signed thinking and redacted-thinking blocks, drops unsigned thinking", () => {
		const message = createAssistantMessage([
			{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "sig-v1", itemId: "rs_1" },
			{ type: "text", text: "unsafe prose to drop" },
			{ type: "redactedThinking", data: "opaque-signature-blob" },
			{ type: "thinking", thinking: "unsigned reasoning to drop" },
		]);
		replaceAssistantNarrative(message, "approved narrative");
		expect(message.content.map(block => block.type)).toEqual(["thinking", "text", "redactedThinking"]);
		const signed = message.content[0];
		if (signed.type !== "thinking") throw new Error("expected thinking block");
		expect(signed.thinking).toBe("signed reasoning");
		expect(signed.thinkingSignature).toBe("sig-v1");
		expect(signed.itemId).toBe("rs_1");
		const redacted = message.content[2];
		if (redacted.type !== "redactedThinking") throw new Error("expected redactedThinking block");
		expect(redacted.data).toBe("opaque-signature-blob");
		const text = message.content[1];
		if (text.type !== "text") throw new Error("expected text block");
		expect(text.text).toBe("approved narrative");
		expect(
			message.content.some(block => block.type === "thinking" && block.thinking === "unsigned reasoning to drop"),
		).toBe(false);
	});
});
