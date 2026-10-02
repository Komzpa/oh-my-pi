import { describe, expect, it } from "bun:test";
import { isInfraFailure, modelVendor, nextUntriedVendorModel } from "@oh-my-pi/pi-coding-agent/task/redispatch-vendor";

describe("modelVendor", () => {
	it.each([
		["codex-lb/gpt-6-luna", "openai"],
		["openrouter/openai/gpt-5.6:high", "openai"],
		["codex-lb/o4-mini", "openai"],
		["anthropic/claude-sonnet-4", "anthropic"],
		["openrouter/anthropic/claude-opus", "anthropic"],
		["openrouter/x-ai/grok-5", "xai"],
		["openrouter/meta/muse-1", "meta"],
		["openrouter/deepseek/deepseek-v4", "deepseek"],
		["xiaomi/mimo-v2", "xiaomi"],
		["openrouter/inception/mercury-3", "inception"],
		["openrouter/moonshot/kimi-k3", "moonshot"],
		["openrouter/qwen/Qwen3-Coder", "qwen"],
		["openrouter/google/gemma-4", "google"],
		["openrouter/nvidia/nemotron-ultra", "nvidia"],
		["openrouter/tm/inkling-2", "thinkingmachines"],
		["openrouter/rednote/dots-2", "dots"],
		["openrouter/poolside/laguna-1", "poolside"],
		["someprov/unknown-model", "someprov"],
	])("%s -> %s", (ref, vendor) => {
		expect(modelVendor(ref)).toBe(vendor);
	});
});

describe("nextUntriedVendorModel", () => {
	const chain = [
		"codex-lb/gpt-6-luna",
		"openrouter/openai/gpt-5.6",
		"anthropic/claude-sonnet-4",
		"openrouter/xai/grok-5",
	];
	it("skips every entry of a tried vendor, whatever the route", () => {
		expect(nextUntriedVendorModel(chain, ["codex-lb/gpt-6-luna"])).toBe("anthropic/claude-sonnet-4");
	});
	it("uses all tried attempts, not just the previous one", () => {
		expect(nextUntriedVendorModel(chain, ["codex-lb/gpt-6-luna", "anthropic/claude-sonnet-4"])).toBe(
			"openrouter/xai/grok-5",
		);
	});
	it("is exhausted once every vendor was tried", () => {
		expect(
			nextUntriedVendorModel(chain, ["codex-lb/gpt-6-luna", "anthropic/claude-sonnet-4", "openrouter/xai/grok-5"]),
		).toBeUndefined();
	});
});

describe("isInfraFailure", () => {
	it.each([
		"HTTP 402 payment required",
		"429 Too Many Requests",
		"usage limit reached",
		"quota exceeded",
		"harness restart",
	])("%s is infra", text => expect(isInfraFailure(text)).toBe(true));
	it.each(["model produced no report", "failed: aborted", undefined])("%s is model-attributable", text =>
		expect(isInfraFailure(text)).toBe(false),
	);
});
