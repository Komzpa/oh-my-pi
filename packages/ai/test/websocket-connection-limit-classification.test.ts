import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";

const WEBSOCKET_LIMIT =
	"Error: websocket_connection_limit_reached: Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.";

describe("Codex websocket connection lifetime cap", () => {
	it("is a transient transport error, not a usage limit", () => {
		expect(AIError.matchesUsageLimitText(WEBSOCKET_LIMIT)).toBe(false);
		expect(AIError.isUsageLimitOutcome(undefined, WEBSOCKET_LIMIT)).toBe(false);
		const id = AIError.classify(new Error(WEBSOCKET_LIMIT));
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(false);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("keeps genuine usage-limit errors classified as usage limits", () => {
		const usage = "usage_limit_reached: The usage limit has been reached";
		expect(AIError.matchesUsageLimitText(usage)).toBe(true);
		expect(AIError.is(AIError.classify(new Error(usage)), AIError.Flag.UsageLimit)).toBe(true);
	});
});
