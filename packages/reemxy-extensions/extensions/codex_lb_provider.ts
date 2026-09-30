import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { Effort } from "@oh-my-pi/pi-ai";

export const CODEX_LB_ACCOUNT_MODEL_IDS = [
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6.1-sol",
] as const;

const effortThinking = (
	defaultLevel: Effort.Low | Effort.Medium | Effort.High,
	efforts: readonly Effort[] = [
		"low" as Effort.Low,
		"medium" as Effort.Medium,
		"high" as Effort.High,
		"xhigh" as Effort.XHigh,
		"max" as Effort.Max,
	],
) => ({
	mode: "effort" as const,
	efforts: [...efforts],
	defaultLevel,
});

const accountModel = (
	id: (typeof CODEX_LB_ACCOUNT_MODEL_IDS)[number],
	name: string,
	cost: ProviderModelConfig["cost"],
	defaultLevel: Effort.Low | Effort.Medium | Effort.High = "medium" as Effort.Medium,
	efforts?: readonly Effort[],
): ProviderModelConfig => ({
	id,
	name,
	reasoning: true,
	thinking: effortThinking(defaultLevel, efforts),
	input: ["text", "image"],
	cost,
	contextWindow: 272000,
	maxTokens: 128000,
});

export const CODEX_LB_MODELS: ProviderModelConfig[] = [
	accountModel(
		"gpt-5.5",
		"GPT-5.5",
		{ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		"medium" as Effort.Medium,
		["medium" as Effort.Medium, "high" as Effort.High, "xhigh" as Effort.XHigh, "max" as Effort.Max],
	),
	accountModel("gpt-5.6-luna", "GPT-5.6 Luna", { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }),
	accountModel(
		"gpt-5.6-sol",
		"GPT-5.6 Sol",
		{ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
		"low" as Effort.Low,
	),
	accountModel("gpt-5.6-terra", "GPT-5.6 Terra", { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 }),
	accountModel(
		"gpt-6-astra",
		"GPT-6 Astra",
		{ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		"high" as Effort.High,
		["medium" as Effort.Medium, "high" as Effort.High, "xhigh" as Effort.XHigh, "max" as Effort.Max],
	),
	accountModel("gpt-6-luna", "GPT-6 Luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }),
	accountModel("gpt-6.1-sol", "GPT-6.1 Sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }),
	{
		id: "Qwen3.8-27B",
		name: "Qwen3.8 27B (Hetzner, free, 10 req/min shared)",
		api: "openai-completions",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
	},
];

export const CODEX_LB_PROVIDER: ProviderConfig = {
	baseUrl: "http://127.0.0.1:2455/v1",
	api: "openai-completions",
	authHeader: true,
	apiKey:
		"! env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus secret-tool lookup service 'codex-lb omp on nucat.local' username omp",
	models: CODEX_LB_MODELS,
};

export default function codexLbProvider(pi: ExtensionAPI): void {
	pi.registerProvider("codex-lb", CODEX_LB_PROVIDER);
}
