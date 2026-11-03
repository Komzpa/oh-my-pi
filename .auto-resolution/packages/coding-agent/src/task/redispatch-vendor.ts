/**
 * Re-dispatch routing: a retry after a model-attributable failure or a rejected
 * completion must change model AND vendor. The vendor is the model maker, not the
 * route, so `codex-lb/gpt-6` and `openrouter/openai/gpt-5` are the same vendor.
 */

const EFFORT_SUFFIXES = new Set(["off", "auto", "inherit", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Model-id prefix to maker. The first match wins; anything else is attributed to its provider. */
const VENDOR_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
	[/^(gpt|o\d|chatgpt|codex)/i, "openai"],
	[/^claude/i, "anthropic"],
	[/^grok/i, "xai"],
	[/^muse/i, "meta"],
	[/^deepseek/i, "deepseek"],
	[/^mimo/i, "xiaomi"],
	[/^mercury/i, "inception"],
	[/^(kimi|k\d)/i, "moonshot"],
	[/^qwen/i, "qwen"],
	[/^gemma/i, "google"],
	[/^nemotron/i, "nvidia"],
	[/^inkling/i, "thinkingmachines"],
	[/^dots/i, "dots"],
	[/^laguna/i, "poolside"],
];

/** Strip a trailing `:effort` selector suffix. */
function stripEffort(ref: string): string {
	const colon = ref.lastIndexOf(":");
	return colon > 0 && EFFORT_SUFFIXES.has(ref.slice(colon + 1)) ? ref.slice(0, colon) : ref;
}

/** Maker of a `provider/model[:effort]` (or bare model) reference. */
export function modelVendor(ref: string): string {
	const bare = stripEffort(ref.trim());
	const slash = bare.indexOf("/");
	const provider = slash > 0 ? bare.slice(0, slash) : "";
	const id = slash > 0 ? bare.slice(slash + 1) : bare;
	const leaf = id.slice(id.lastIndexOf("/") + 1);
	for (const [pattern, vendor] of VENDOR_PREFIXES) if (pattern.test(leaf)) return vendor;
	return (provider || leaf).toLowerCase();
}

const INFRA_FAILURE =
	/harness|restart|billing|payment|\b402\b|rate[ _-]?limit|usage[ _-]?limit|quota|\b429\b|exhaust|overload|\b50[234]\b|capacity|credential|unauthori[sz]ed|\b40[13]\b|ECONN|ETIMEDOUT|fetch failed|socket hang|network/i;

/** True when a failed attempt's error says the infrastructure failed, not the model. */
export function isInfraFailure(error: string | undefined): boolean {
	return error !== undefined && INFRA_FAILURE.test(error);
}

/** First chain entry whose vendor is absent from `triedModels`; undefined when every vendor was tried. */
export function nextUntriedVendorModel(chain: readonly string[], triedModels: Iterable<string>): string | undefined {
	const tried = new Set<string>();
	for (const model of triedModels) tried.add(modelVendor(model));
	return chain.find(entry => !tried.has(modelVendor(entry)));
}
