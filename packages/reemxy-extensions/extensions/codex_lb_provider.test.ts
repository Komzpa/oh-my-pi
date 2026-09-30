import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import codexLbProvider, { CODEX_LB_ACCOUNT_MODEL_IDS, CODEX_LB_MODELS, CODEX_LB_PROVIDER } from "./codex_lb_provider";

describe("Reemxy codex-lb provider", () => {
	test("registers the current codex-lb OpenAI account model set", () => {
		expect(CODEX_LB_MODELS.map(model => model.id)).toEqual([...CODEX_LB_ACCOUNT_MODEL_IDS, "Qwen3.8-27B"]);
		expect(CODEX_LB_ACCOUNT_MODEL_IDS).toEqual([
			"gpt-5.5",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-6-astra",
			"gpt-6-luna",
			"gpt-6.1-sol",
		]);
	});

	test("keeps codex-lb on the local authenticated OpenAI-compatible endpoint", () => {
		expect(CODEX_LB_PROVIDER).toMatchObject({
			baseUrl: "http://127.0.0.1:2455/v1",
			api: "openai-completions",
			authHeader: true,
		});
		expect(CODEX_LB_PROVIDER.apiKey).toContain(
			"secret-tool lookup service 'codex-lb omp on nucat.local' username omp",
		);
	});

	test("registers codex-lb when the extension loads", () => {
		const calls: Array<[string, unknown]> = [];
		codexLbProvider({
			registerProvider: (name: string, config: unknown) => calls.push([name, config]),
		} as unknown as ExtensionAPI);
		expect(calls).toEqual([["codex-lb", CODEX_LB_PROVIDER]]);
	});
});
