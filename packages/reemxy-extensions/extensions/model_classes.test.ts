import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_POOLS } from "./agent_router";
import { classAtLeast, modelClass, normalizeModelId } from "./model_classes";

describe("model classes", () => {
	test("classifies vendor tiers regardless of provider prefix and effort suffix", () => {
		const expected: Record<string, string> = {
			"anthropic/claude-opus-5-5:high": "frontier",
			"claude-fable-5-1": "frontier",
			"claude-mythos-5": "frontier",
			"codex-lb/gpt-6-sol:medium": "frontier",
			"codex-lb/gpt-6-astra:xhigh": "frontier",
			"openrouter/openai/gpt-5.6-sol:batch": "frontier",
			"claude-bridge/claude-sonnet-5": "standard",
			"codex-lb/gpt-6-luna:low": "standard",
			"gpt-5.6-terra": "standard",
			"kimi-code/k3:high": "standard",
			"deepseek/deepseek-v4-pro:high": "standard",
			"openrouter/google/gemini-3.1-pro-preview": "standard",
			"anthropic/claude-haiku-4-5:low": "light",
			"kimi-code/kimi-for-coding-highspeed:medium": "light",
			"deepseek/deepseek-v4-flash:high": "light",
			"openai/gpt-6-sol-mini": "light",
			"codex-lb/Qwen3.8-27B": "light",
			"gemma4:12b": "light",
			"openrouter/thinkingmachines/inkling:free": "light",
			"some-new-model": "unclassified",
		};
		for (const [spec, cls] of Object.entries(expected)) expect([spec, modelClass(spec)]).toEqual([spec, cls]);
		expect(normalizeModelId("openrouter/thinkingmachines/inkling:free")).toBe("inkling");
	});

	test("orders classes with unclassified below light", () => {
		expect(classAtLeast("frontier", "frontier")).toBe(true);
		expect(classAtLeast("standard", "frontier")).toBe(false);
		expect(classAtLeast("unclassified", "light")).toBe(false);
	});

	test("every router pool and agent profile model has a class", () => {
		const specs = new Set(Object.values(AGENT_POOLS).flatMap(config => [...config.pool, ...config.fallbacks]));
		const agents = join(import.meta.dir, "agents");
		for (const file of readdirSync(agents).filter(name => name.endsWith(".md"))) {
			const line = /^model:\s*(.+)$/m.exec(readFileSync(join(agents, file), "utf8"))?.[1];
			for (const spec of line?.split(",") ?? []) specs.add(spec.trim());
		}
		expect([...specs].filter(spec => modelClass(spec) === "unclassified")).toEqual([]);
	});
});
