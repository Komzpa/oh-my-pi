import { describe, expect, test } from "bun:test";
import { getAgentPools } from "./agent_router";

const MIMO = ["xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.6-pro"];

/** Full ordered chain of a role: the (possibly shuffled) pool first, then the ordered fallbacks. */
function chain(agent: string): string[] {
	const config = getAgentPools()[agent];
	expect(config, agent).toBeDefined();
	return [...config!.pool, ...config!.fallbacks];
}

describe("agent pool policy (Darafei 2026-10-22)", () => {
	test("ui-coder opens on sol:high then sonnet and carries neither luna nor mimo", () => {
		const models = chain("ui-coder");
		expect(models.slice(0, 2)).toEqual(["codex-lb/gpt-6.1-sol:high", "anthropic/claude-sonnet-5-5"]);
		expect(models.some(spec => spec.startsWith("codex-lb/gpt-6-luna"))).toBe(false);
		expect(models.some(spec => spec.startsWith("xiaomi/"))).toBe(false);
	});

	test("git-pr-owner opens on haiku:low, sol:low, mercury-3:low and carries no luna", () => {
		const models = chain("git-pr-owner");
		expect(models.slice(0, 3)).toEqual([
			"anthropic/claude-haiku-5-5:low",
			"codex-lb/gpt-6.1-sol:low",
			"inception/mercury-3:low",
		]);
		expect(models.some(spec => spec.startsWith("codex-lb/gpt-6-luna"))).toBe(false);
	});

	test("coder is the bigger-task role: sol:medium then muse-spark:medium, no luna", () => {
		const models = chain("coder");
		expect(models.slice(0, 2)).toEqual([
			"codex-lb/gpt-6.1-sol:medium",
			"muse-code/muse-spark-1.3-contributor:medium",
		]);
		expect(models.some(spec => spec.startsWith("codex-lb/gpt-6-luna"))).toBe(false);
	});

	test("minor-coder has the exact small-fix pool with mimo at the tail", () => {
		expect(chain("minor-coder")).toEqual([
			"codex-lb/gpt-6-luna:low",
			"inception/mercury-3:low",
			"anthropic/claude-haiku-5-5:low",
			"openrouter/dots-studio/dots-3-note-preview:free",
			"codex-lb/gpt-6.1-sol:low",
			"xiaomi/mimo-v2.6-flash",
		]);
	});

	test("the head-first roles share load across a pool of two different providers", () => {
		const pairs: Record<string, string[]> = {
			"ui-coder": ["codex-lb/gpt-6.1-sol:high", "anthropic/claude-sonnet-5-5"],
			"git-pr-owner": ["anthropic/claude-haiku-5-5:low", "codex-lb/gpt-6.1-sol:low"],
			coder: ["codex-lb/gpt-6.1-sol:medium", "muse-code/muse-spark-1.3-contributor:medium"],
			"minor-coder": ["codex-lb/gpt-6-luna:low", "inception/mercury-3:low"],
		};
		const pools = getAgentPools();
		for (const [agent, pair] of Object.entries(pairs)) {
			expect(pools[agent]!.pool, agent).toEqual(pair);
			expect(new Set(pair.map(spec => spec.split("/")[0])).size, agent).toBe(2);
		}
	});

	test("xiaomi mimo is only ever the last-resort tail of a chain", () => {
		for (const agent of Object.keys(getAgentPools())) {
			const models = chain(agent);
			const firstMimo = models.findIndex(spec => MIMO.some(mimo => spec.startsWith(mimo)));
			if (firstMimo === -1) continue;
			// Everything from the first mimo entry on is mimo: nothing non-mimo follows it.
			for (const spec of models.slice(firstMimo)) {
				expect(MIMO.some(mimo => spec.startsWith(mimo)), `${agent}: ${spec}`).toBe(true);
			}
			expect(getAgentPools()[agent]!.pool.some(spec => spec.startsWith("xiaomi/")), agent).toBe(false);
		}
	});
});
