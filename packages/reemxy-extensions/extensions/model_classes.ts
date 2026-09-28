/**
 * Capability classes for models, so policies name a class ("frontier may write outside the repository") instead of
 * listing model names that go stale with every release.
 *
 * - frontier: the strongest reasoning tier of each vendor (Claude Opus/Fable/Mythos, GPT Sol/Astra).
 * - standard: capable general workers (Claude Sonnet, GPT Luna/Terra, Kimi K3, DeepSeek Pro, Gemini Pro, GLM 5).
 * - light: small, fast or distilled models (Haiku, flash/mini/nano/lite variants, local and small open models).
 * - unclassified: no rule matched; policies treat it like light until a rule or setting classifies it.
 *
 * `reemxyModelClasses` (user or project settings) maps a model id or `*` glob to a class and wins over the rules.
 */
import { SettingsManager } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

export const MODEL_CLASSES = ["light", "standard", "frontier"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number] | "unclassified";

// First match wins, so size markers beat family names ("gpt-6-sol-mini" is light).
const RULES: Array<[RegExp, ModelClass]> = [
	[/(^|[-_.])(haiku|flash|flashx|mini|nano|lite|highspeed|small|tiny|micro|air)([-_.]|$)/, "light"],
	// Open weights sized in the id (`qwen3.8-27b`, `gemma4:12b`) and small hosted open models.
	[/(^|[-_.:])\d+(\.\d+)?b([-_.]|$)/, "light"],
	[/^(inkling|gemma|llama|gpt-oss)([-_.:\d]|$)/, "light"],
	[/^claude-(opus|fable|mythos)([-_.]|$)/, "frontier"],
	[/^gpt-\d+(\.\d+)?-(sol|astra)([-_.]|$)/, "frontier"],
	[/^claude-sonnet([-_.]|$)/, "standard"],
	[/^gpt-\d+(\.\d+)?-(luna|terra)([-_.]|$)/, "standard"],
	[/^(k3|kimi-k3|kimi-for-coding|kimi-k2(\.\d+)?)([-_.]|$)/, "standard"],
	[/^deepseek-v\d+(\.\d+)?-pro([-_.]|$)/, "standard"],
	[/^gemini-[\d.]+-pro([-_.]|$)/, "standard"],
	[/^glm-5([-_.]|$)/, "standard"],
	[/^qwen[\d.]+-max([-_.]|$)/, "standard"],
];

/** `codex-lb/gpt-6-sol:high` and `openrouter/openai/gpt-6-sol:batch` both normalize to `gpt-6-sol`. */
export function normalizeModelId(spec: string): string {
	const id = spec.slice(spec.lastIndexOf("/") + 1).toLowerCase();
	return id.replace(/:(minimal|low|medium|high|xhigh|max|batch|free|exacto|thinking|extended)$/, "");
}

function globMatch(pattern: string, id: string): boolean {
	const source = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${source}$`).test(id);
}

function configuredClasses(cwd: string | undefined): Array<[string, ModelClass]> {
	if (!cwd) return [];
	const settings = SettingsManager.create(cwd);
	const entries: Array<[string, ModelClass]> = [];
	for (const value of [settings.getProjectSettings().reemxyModelClasses, settings.getGlobalSettings().reemxyModelClasses]) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		for (const [pattern, cls] of Object.entries(value as Record<string, unknown>)) {
			if ((MODEL_CLASSES as readonly unknown[]).includes(cls)) entries.push([pattern, cls as ModelClass]);
		}
	}
	return entries;
}

export function modelClass(spec: string, cwd?: string): ModelClass {
	const id = normalizeModelId(spec);
	for (const [pattern, cls] of configuredClasses(cwd)) {
		if (globMatch(normalizeModelId(pattern), id)) return cls;
	}
	return RULES.find(([rule]) => rule.test(id))?.[1] ?? "unclassified";
}

/** True when `actual` is at least `required`; unclassified ranks below light. */
export function classAtLeast(actual: ModelClass, required: ModelClass): boolean {
	const rank = (cls: ModelClass) => (MODEL_CLASSES as readonly string[]).indexOf(cls);
	return rank(actual) >= rank(required);
}
