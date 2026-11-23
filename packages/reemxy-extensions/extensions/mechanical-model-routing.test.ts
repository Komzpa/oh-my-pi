import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import gateRunner from "./agents/gate-runner.md" with { type: "text" };
import gitOwner from "./agents/git-pr-owner.md" with { type: "text" };

const model = (provider: string, id: string) =>
	buildModel({
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://fixture.invalid",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
	});
const terra = model("codex-lb", "gpt-6.1-terra");
const luna = model("codex-lb", "gpt-6-luna");
const opus = model("anthropic", "claude-opus-5-5");

describe("mechanical worker routing", () => {
	for (const [name, content] of [
		["gate-runner", gateRunner],
		["git-pr-owner", gitOwner],
	]) {
		test(`${name} avoids the brrrr Opus pool and falls back to Luna when Terra is unavailable`, () => {
			const agent = parseAgent(name, content, "user");
			const patterns = agent.model ?? [];
			const settings = Settings.isolated({
				modelRoles: { free: "anthropic/claude-opus-5-5", fast: "anthropic/claude-opus-5-5" },
			});
			const picked = resolveModelOverride(patterns, { getAvailable: () => [opus, terra, luna] }, settings);
			expect(picked.model?.id).toBe(terra.id);
			expect(picked.thinkingLevel).toBe(Effort.Low);
			expect(resolveModelOverride(patterns, { getAvailable: () => [opus, luna] }, settings).model?.id).toBe(luna.id);
			expect(resolveModelOverride(patterns, { getAvailable: () => [opus] }, settings).model).toBeUndefined();
			// Non-mechanical work retains the configured pool.
			expect(resolveModelOverride(["@free"], { getAvailable: () => [opus, terra] }, settings).model?.id).toBe(
				opus.id,
			);
		});
	}
});
