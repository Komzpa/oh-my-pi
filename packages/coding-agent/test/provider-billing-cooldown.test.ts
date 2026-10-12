import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const sourceDir = path.join(import.meta.dir, "..", "src", "session");
const HOUR_MS = 60 * 60 * 1_000;

/**
 * Every step runs in a fresh Bun process so module state cannot carry a ban;
 * only the persisted router state directory connects process A and process B.
 */
async function runProcess(stateDir: string, body: string): Promise<unknown> {
	const script = `
import { logProviderTurnError } from ${JSON.stringify(path.join(sourceDir, "messages.ts"))};
import * as exhaustion from ${JSON.stringify(path.join(sourceDir, "provider-exhaustion.ts"))};
import { findRetryFallbackCandidates } from ${JSON.stringify(path.join(sourceDir, "retry-fallback-chains.ts"))};
const context = {
	chains: { default: ["deepseek/deepseek-v4-pro", "kimi-code/kimi-for-coding", "codex-lb/gpt-5.5"] },
	getModelRole: () => undefined,
	modelLookup: { find: () => ({}), hasProvider: () => true },
};
function pick() {
	const exclusions = [];
	const candidates = findRetryFallbackCandidates(context, "default", "openai/gpt-4o-mini", undefined, { exclusions });
	return { order: candidates.map(candidate => candidate.provider), exclusions };
}
const result = await (async () => { ${body} })();
console.log(JSON.stringify(result));
`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: { ...process.env, OMP_AGENT_ROUTER_STATE_DIR: stateDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`child exited ${exitCode}: ${stderr}`);
	const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
	console.log(JSON.stringify(result));
	return result;
}

describe("persisted provider billing cooldown", () => {
	let stateDir: TempDir;

	beforeEach(() => {
		stateDir = TempDir.createSync("@omp-provider-billing-");
	});

	afterEach(() => {
		stateDir.removeSync();
	});

	it("(a) skips deepseek 402 and kimi monthly-limit 403 in a fresh process with the reason", async () => {
		await runProcess(
			stateDir.path(),
			`logProviderTurnError({ stopReason: "error", provider: "deepseek", model: "deepseek-v4-pro", errorStatus: 402, errorMessage: "Insufficient Balance" });
			logProviderTurnError({ stopReason: "error", provider: "kimi-code", model: "kimi-for-coding", errorStatus: 403, errorMessage: "permission_error: You've reached your monthly usage limit for this billing cycle" });
			return true;`,
		);
		const picked = (await runProcess(stateDir.path(), "return pick();")) as {
			order: string[];
			exclusions: Array<{ provider: string; reason: string }>;
		};

		expect(picked.order).toEqual(["codex-lb"]);
		expect(picked.exclusions).toEqual([
			{
				provider: "deepseek",
				reason: expect.stringMatching(/^billing: 402 Insufficient Balance until \d{4}-\d\d-\d\dT/),
				until: expect.any(Number),
			},
			{
				provider: "kimi-code",
				reason: expect.stringMatching(/^billing: 403 .*monthly usage limit.* until \d{4}-/),
				until: expect.any(Number),
			},
		]);
	});

	it("(b) restores a provider after a mocked models probe or TTL expiry", async () => {
		await runProcess(
			stateDir.path(),
			`exhaustion.coolDownExhaustedProvider("deepseek", { reason: "402 Insufficient Balance" });
			exhaustion.coolDownExhaustedProvider("kimi-code", { reason: "403 monthly usage limit", now: Date.now() - ${7 * HOUR_MS} });
			const requested = [];
			const recovered = await exhaustion.probeExhaustedProvider("deepseek", {
				url: "https://deepseek.invalid/v1/models",
				fetchFn: async (url, init) => { requested.push({ url, method: init.method }); return { ok: true, status: 200 }; },
			});
			return { recovered, requested };`,
		);
		const picked = (await runProcess(stateDir.path(), "return pick();")) as {
			order: string[];
			exclusions: unknown[];
		};

		expect(picked).toEqual({ order: ["deepseek", "kimi-code", "codex-lb"], exclusions: [] });
	});

	it("(c) keeps rate limits short and plain 403 authentication errors unbanned", async () => {
		const result = await runProcess(
			stateDir.path(),
			`logProviderTurnError({ stopReason: "error", provider: "codex-lb", model: "gpt-5.5", errorStatus: 429, errorMessage: "429 rate_limit_error retry-after-ms=1000" });
			logProviderTurnError({ stopReason: "error", provider: "kimi-code", model: "kimi-for-coding", errorStatus: 403, errorMessage: "permission_error: invalid api key" });
			return { billing429: exhaustion.isProviderExhaustionError(429, "429 rate_limit_error"), auth403: exhaustion.isProviderExhaustionError(403, "permission_error: invalid api key"), ...pick() };`,
		);

		expect(result).toEqual({
			billing429: false,
			auth403: false,
			order: ["deepseek", "kimi-code", "codex-lb"],
			exclusions: [],
		});
	});
});
