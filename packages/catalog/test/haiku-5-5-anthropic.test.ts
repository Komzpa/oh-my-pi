import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";

function anthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

describe("claude-haiku-5-5 on the direct anthropic route", () => {
	test("resolves adaptive thinking with medium effort and no forced tool choice", () => {
		const model = anthropicModel("claude-haiku-5-5");
		expect(model.thinking?.mode).toBe("anthropic-adaptive");
		expect(model.thinking?.efforts).toContain(Effort.Medium);
		expect(model.compat.supportsForcedToolChoice).toBe(false);
	});

	test("claude-haiku-4-5 keeps budget thinking", () => {
		const model = anthropicModel("claude-haiku-4-5");
		expect(model.thinking?.mode).toBe("budget");
	});
});
