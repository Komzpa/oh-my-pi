import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";

function usage(fields: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): Usage {
	return {
		...fields,
		totalTokens: fields.input + fields.output + fields.cacheRead + fields.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

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
	test("resolves adaptive thinking with medium effort and keeps forced tool choice", () => {
		const model = anthropicModel("claude-haiku-5-5");
		expect(model.thinking?.mode).toBe("anthropic-adaptive");
		expect(model.thinking?.efforts).toContain(Effort.Medium);
		expect(model.compat.supportsForcedToolChoice).toBe(true);
	});

	test("claude-haiku-4-5 keeps budget thinking", () => {
		const model = anthropicModel("claude-haiku-4-5");
		expect(model.thinking?.mode).toBe("budget");
	});
});

describe("claude-haiku-5-5 long-context tier on the direct anthropic route", () => {
	const haiku = getBundledModel("anthropic", "claude-haiku-5-5");

	test("publishes the >100K tier at the official rates", () => {
		expect(haiku.cost.longContext).toEqual({
			inputThreshold: 100000,
			input: 0.5,
			output: 2.5,
			cacheRead: 0.05,
			cacheWrite: 0.625,
		});
	});

	test("bills exactly 100000 prompt tokens at base rates", () => {
		const u = usage({ input: 100000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
		calculateCost(haiku, u);
		expect(u.cost.input).toBeCloseTo(0.1 * 0.1, 10);
		expect(u.cost.output).toBeCloseTo(0.5, 10);
	});

	test("bills 100001 prompt tokens at the long-context input and output rates", () => {
		const u = usage({ input: 100001, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
		calculateCost(haiku, u);
		expect(u.cost.input).toBeCloseTo((0.5 * 100001) / 1e6, 10);
		expect(u.cost.output).toBeCloseTo(2.5, 10);
	});

	test("cache-read and cache-write switch at the same 100K boundary", () => {
		const atBoundary = usage({ input: 0, output: 0, cacheRead: 100000, cacheWrite: 0 });
		calculateCost(haiku, atBoundary);
		expect(atBoundary.cost.cacheRead).toBeCloseTo(0.01 * 0.1, 10);

		const over = usage({ input: 0, output: 0, cacheRead: 100001, cacheWrite: 1_000_000 });
		calculateCost(haiku, over);
		expect(over.cost.cacheRead).toBeCloseTo((0.05 * 100001) / 1e6, 10);
		expect(over.cost.cacheWrite).toBeCloseTo(0.625, 10);
	});
});
