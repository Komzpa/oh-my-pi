import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { finalize } from "@oh-my-pi/pi-ai/error/finalize";
import { OpenAIHttpError } from "@oh-my-pi/pi-ai/error/classes";
import { classifyProviderFailure, type ProviderUnavailableClass } from "../src/session/provider-exhaustion";

const fixtures: TempDir[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.removeSync();
});

async function run(stateDir: string, body: string): Promise<unknown> {
	const source = path.resolve(import.meta.dir, "../src/session/provider-exhaustion.ts");
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
import * as state from ${JSON.stringify(source)};
import { providersCommand } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/session/providers-command.ts"))};
import { BUILTIN_SESSION_SLASH_COMMANDS } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/slash-commands/builtin-session.ts"))};
import { TurnRecovery } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/session/turn-recovery.ts"))};
import { ModelRegistry } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/config/model-registry.ts"))};
import { AuthStorage } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/session/auth-storage.ts"))};
import * as streams from "@oh-my-pi/pi-ai/stream";
import { spyOn } from "bun:test";
const output = await (async () => { ${body} })();
process.stdout.write(JSON.stringify(output));
`,
		],
		{
			env: { ...process.env, PI_TEST_RUNTIME: "", PI_CODING_AGENT_DIR: stateDir, XDG_STATE_HOME: "" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0) throw new Error(`fixture exited ${exit}: ${stderr}`);
	return JSON.parse(stdout);
}

function fixture(): string {
	const directory = TempDir.createSync("omp-availability-state-");
	fixtures.push(directory);
	return directory.path();
}

describe("provider availability evidence", () => {
	it("distinguishes quota, balance, entitlement and auth from machine fields", () => {
		expect(classifyProviderFailure({ status: 429, code: "quota_exceeded" })).toBe("quota");
		expect(
			classifyProviderFailure({
				status: 402,
				body: { error: { code: "insufficient_balance", message: "Insufficient Balance" } },
			}),
		).toBe("balance");
		expect(
			classifyProviderFailure({
				status: 402,
				body: '{"error":{"type":"billing_error","code":"billing_not_configured"}}',
			}),
		).toBe("entitlement");
		expect(classifyProviderFailure({ status: 404, catalogModel: true })).toBe("entitlement");
		expect(classifyProviderFailure({ code: "invalid_grant" })).toBe("auth");
		expect(classifyProviderFailure({ code: "missing_api_key" })).toBe("auth");
		// Neither missing catalog membership nor intimidating prose disables a provider.
		expect(classifyProviderFailure({ status: 404 })).toBeUndefined();
		expect(classifyProviderFailure({ discoveryFailure: true })).toBe("discovery");
		expect(
			classifyProviderFailure({ status: 429, body: "quota_exceeded Insufficient Balance invalid_grant" }),
		).toBeUndefined();
		expect(classifyProviderFailure({ status: 429, code: "rate_limit_exceeded" })).toBeUndefined();
	});

	it("replays November 4 captured responses through error finalization and availability", async () => {
		// omp.2026-11-04.1547436.log:19620, :4331, :19528;
		// omp.2026-11-04.3069605.log:13. Auth is the owner's missing-key scenario.
		const cases: { status: number; type: string; param?: string; expected: ProviderUnavailableClass }[] = [
			{ status: 402, type: "personal-team-blocked:spending-limit", expected: "quota" },
			{ status: 402, type: "insufficient_balance_error", expected: "balance" },
			{ status: 402, type: "billing_error", param: "billing_not_configured", expected: "entitlement" },
			{ status: 404, type: "invalid_request_error", param: "model_not_found", expected: "entitlement" },
			{ status: 401, type: "authentication_error", expected: "auth" },
		];
		for (const replay of cases) {
			const response = {
				status: replay.status,
				headers: new Headers(),
				bodyJson: { error: { type: replay.type, param: replay.param } },
				bodyText: JSON.stringify({ error: { type: replay.type, param: replay.param } }),
			};
			const result = await finalize(new OpenAIHttpError("opaque provider failure", response));
			expect(
				classifyProviderFailure({
					status: result.status,
					type: result.errorType,
					code: result.errorCode,
					catalogModel: true,
				}),
			).toBe(replay.expected);
		}
	});

	it("shares evidence across processes and keeps balance unavailable after an hour", async () => {
		const directory = fixture();
		await run(
			directory,
			`
state.recordProviderFailure("deepseek", { status: 402, code: "insufficient_balance" }, 1000);
state.recordProviderFailure("deepseek", { status: 402, code: "insufficient_balance" }, 2000);
return null;`,
		);
		const result = await run(directory, `return state.providerExhaustionRecord("deepseek", 3602001);`);
		expect(result).toMatchObject({
			class: "balance",
			firstSeen: 1000,
			lastSeen: 2000,
			failedCallCount: 2,
			status: 402,
			code: "insufficient_balance",
		});
	});

	it("clears known quota reset and expires unknown quota after a bounded TTL", async () => {
		const result = await run(
			fixture(),
			`
state.recordProviderFailure("known", { code: "quota_exceeded", resetAt: 3000 }, 1000);
state.recordProviderFailure("unknown", { code: "quota_exceeded" }, 1000);
return [state.isProviderExhausted("known", 3000), state.isProviderExhausted("unknown", 99999999)];`,
		);
		expect(result).toEqual([false, false]);
	});

	it("keeps billing excluded past reported reset until a successful probe, without banning transient failures", async () => {
		const directory = fixture();
		await run(
			directory,
			`
state.recordProviderFailure("abliteration", { status: 402, type: "billing_error", code: "insufficient_credits", resetAt: 5000 }, 1000);
state.recordProviderFailure("transient", { status: 503 }, 1000);
state.recordProviderFailure("images", { status: 400, type: "media_error", code: "media_count_exceeded" }, 1000);
return null;`,
		);
		expect(
			await run(
				directory,
				`return [state.isProviderExhausted("abliteration", 4999), state.isProviderExhausted("transient", 1001), state.isProviderExhausted("images", 1001)];`,
			),
		).toEqual([true, false, false]);
		expect(await run(directory, `return state.isProviderExhausted("abliteration", 5000);`)).toBe(true);
		expect(
			await run(
				directory,
				`
let probes = 0;
await state.probeUnavailableProviders(async () => { probes++; return { available: false }; }, { now: 3601000 });
const blocked = state.isProviderExhausted("abliteration", 3601000);
const record = state.listProviderCooldowns()[0];
const next = record.nextProbeAt;
if (record.until !== next) throw new Error("Billing retry deadline ignores probe backoff");
await state.probeUnavailableProviders(async () => { probes++; return { available: true }; }, { now: next - 1 });
const stillBlocked = state.isProviderExhausted("abliteration", next - 1);
await state.probeUnavailableProviders(async () => { probes++; return { available: true }; }, { now: next });
return { probes, blocked, stillBlocked, recovered: !state.isProviderExhausted("abliteration", next) };`,
			),
		).toEqual({ probes: 2, blocked: true, stillBlocked: true, recovered: true });
	});

	it("deduplicates unavailable/recovered notices and recovers every process by probe", async () => {
		const directory = fixture();
		const result = await run(
			directory,
			`
const notices = [];
state.subscribeProviderTransitions(event => notices.push(event));
state.recordProviderFailure("muse", { status: 402, type: "billing_error" }, 1000);
state.recordProviderFailure("muse", { status: 404, catalogModel: true }, 2000);
await state.probeUnavailableProviders(async () => ({ available: true }), { now: 302000 });
await state.probeUnavailableProviders(async () => ({ available: true }), { now: 303000 });
return notices;`,
		);
		expect(result).toMatchObject([
			{ provider: "muse", available: false, class: "entitlement", since: 1000, failedCallCount: 1 },
			{ provider: "muse", available: true, class: "entitlement", since: 1000, failedCallCount: 2 },
		]);
		expect(await run(directory, `return state.isProviderExhausted("muse");`)).toBe(false);
	});

	it("queues notices before subscription and atomically claims them across processes", async () => {
		const directory = fixture();
		await run(
			directory,
			`state.recordProviderFailure("muse", { status: 402, code: "billing_not_configured" }, 1000); return null;`,
		);
		const claims = await Promise.all([
			run(directory, `return state.claimProviderTransitions();`),
			run(directory, `return state.claimProviderTransitions();`),
		]);
		const events = claims.flat() as Array<{ id: string; available: boolean; provider: string }>;
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ provider: "muse", available: false });
		await run(
			directory,
			`await state.probeUnavailableProviders(async () => ({ available: true }), { now: 301000 }); return null;`,
		);
		const recovery = await run(directory, `return state.claimProviderTransitions();`);
		expect(recovery).toMatchObject([{ provider: "muse", available: true, failedCallCount: 1 }]);
		expect(await run(directory, `return state.claimProviderTransitions();`)).toEqual([]);
	});

	it("leases a probe once and rejects stale recovery after a newer failed call", async () => {
		const result = await run(
			fixture(),
			`
state.recordProviderFailure("muse", { status: 402 }, 1000);
const gate = Promise.withResolvers();
const started = Promise.withResolvers();
let calls = 0;
const first = state.probeUnavailableProviders(async () => { calls++; started.resolve(); await gate.promise; return { available: true }; }, { now: 301000, owner: "first" });
await started.promise;
await state.probeUnavailableProviders(async () => { calls++; return { available: true }; }, { now: 301000, owner: "second" });
state.recordProviderFailure("muse", { status: 402 }, 301001);
gate.resolve();
await first;
return { calls, record: state.providerExhaustionRecord("muse", 301002) };`,
		);
		expect(result).toMatchObject({
			calls: 1,
			record: { class: "balance", failedCallCount: 2, lastSeen: 301001 },
		});
	});

	it("operator commands use real registry inference for immediate recovery and keep failed providers", async () => {
		const result = await run(
			fixture(),
			`
const auth = await AuthStorage.create(":memory:");
await auth.credentials.set("openai", { type: "api_key", key: "fixture" });
const registry = new ModelRegistry(auth);
state.recordProviderFailure("openai", { code: "quota_exceeded" });
const inference = spyOn(streams, "completeSimple").mockResolvedValue({ stopReason: "error" });
const slash = BUILTIN_SESSION_SLASH_COMMANDS.find(command => command.name === "providers");
let failed;
await slash.handle({ args: "probe openai" }, { session: { modelRegistry: registry }, output: text => { failed = text; } });
const attempts = state.listProviderCooldowns()[0].probeAttempts;
inference.mockResolvedValue({ stopReason: "stop" });
const success = await providersCommand(["probe", "--all"], async () => registry);
const remaining = state.listProviderCooldowns();
state.recordProviderFailure("muse", { status: 402 });
const listed = await providersCommand([], async () => { throw new Error("listing initialized auth"); });
const cli = Bun.spawn([process.execPath, ${JSON.stringify(path.resolve(import.meta.dir, "../src/cli.ts"))}, "providers", "clear", "muse"], { stdout: "pipe", stderr: "pipe" });
const cleared = (await new Response(cli.stdout).text()).trim();
if (await cli.exited !== 0) throw new Error(await new Response(cli.stderr).text());
const empty = state.listProviderCooldowns();
const calls = inference.mock.calls.length;
registry.stopAvailabilityMonitoring(); auth.close();
return { failed, attempts, success, remaining, listed, cleared, empty, calls };`,
		);
		expect(result).toMatchObject({
			failed: "openai: still unavailable; cooldown retained.",
			attempts: 1,
			success: "openai: available; cooldown cleared.",
			remaining: [],
			empty: [],
			calls: 2,
		});
		expect((result as { listed: string }).listed).toContain("muse\tbalance");
		expect((result as { cleared: string }).cleared).toContain("availability was not probed");
	});

	it("manual probe bypasses the Codex reset timer but preserves unrelated providers and failed backoff", async () => {
		const directory = fixture();
		const result = await run(
			directory,
			`
state.recordProviderFailure("codex-lb", { code: "quota_exceeded", resetAt: 9999999 }, 1000);
state.recordProviderFailure("muse", { status: 402 }, 1000);
let calls = 0;
await state.probeUnavailableProviders(async () => { calls++; return { available: false }; }, { force: true, provider: "codex-lb", now: 2000 });
const failed = state.listProviderCooldowns().find(row => row.provider === "codex-lb");
await state.probeUnavailableProviders(async () => { calls++; return { available: true }; }, { force: true, provider: "CODEX-LB", now: 2001 });
return { calls, failed, remaining: state.listProviderCooldowns().map(row => row.provider) };`,
		);
		expect(result).toMatchObject({
			calls: 2,
			failed: { probeAttempts: 1, nextProbeAt: 602000 },
			remaining: ["muse"],
		});
		expect(await run(directory, `return state.isProviderExhausted("codex-lb", 2002);`)).toBe(false);
	});

	it("explicit clear invalidates a leased result and stale revisions cannot clear a newer failure", async () => {
		const result = await run(
			fixture(),
			`
state.recordProviderFailure("codex-lb", { code: "quota_exceeded" }, 1000);
const revision = state.listProviderCooldowns()[0].revision;
const gate = Promise.withResolvers();
const started = Promise.withResolvers();
let calls = 0;
const probe = state.probeUnavailableProviders(async () => { calls++; started.resolve(); await gate.promise; return { available: false }; }, { force: true, now: 2000 });
await started.promise;
await state.probeUnavailableProviders(async () => { calls++; return { available: true }; }, { force: true, now: 2001 });
const cleared = state.clearProviderCooldown("CODEX-LB");
gate.resolve();
await probe;
const empty = state.listProviderCooldowns();
state.recordProviderFailure("codex-lb", { code: "quota_exceeded" }, 3000);
return { calls, cleared, empty, stale: state.clearProviderCooldown("codex-lb", revision), remaining: state.listProviderCooldowns().length };`,
		);
		expect(result).toEqual({ calls: 1, cleared: true, empty: [], stale: false, remaining: 1 });
	});

	it("successful inference clears quota and entitlement immediately but preserves auth and discovery", async () => {
		const directory = fixture();
		await run(
			directory,
			`
state.recordProviderFailure("codex-lb", { code: "quota_exceeded" });
state.recordProviderFailure("muse", { code: "billing_not_configured" });
state.recordProviderFailure("auth", { status: 401 });
state.recordProviderFailure("catalog", { discoveryFailure: true });
const recovery = new TurnRecovery({}, { deferFallbackChainValidation: true });
await recovery.recordProviderAvailabilityOutcome({ provider: "codex-lb", stopReason: "aborted" });
const abortedRetained = state.isProviderExhausted("codex-lb");
if (!abortedRetained) throw new Error("aborted call cleared quota");
for (const provider of ["codex-lb", "muse", "auth", "catalog"]) await recovery.recordProviderAvailabilityOutcome({ provider, stopReason: "toolUse" });
return null;`,
		);
		expect(await run(directory, `return state.listProviderCooldowns().map(row => row.provider);`)).toEqual([
			"auth",
			"catalog",
		]);
	});

	it("backs failed probes off and never uses time or a probe to clear auth", async () => {
		const result = await run(
			fixture(),
			`
state.recordProviderFailure("muse", { status: 402 }, 1000);
state.recordProviderFailure("anthropic", { code: "invalid_grant", credentialVersion: "old" }, 1000);
let calls = 0;
await state.probeUnavailableProviders(async () => { calls++; return { available: false }; }, { now: 301000 });
await state.probeUnavailableProviders(async () => { calls++; return { available: true }; }, { now: 302000 });
const nextProbeAt = state.providerExhaustionRecord("muse", 302000).nextProbeAt;
state.clearProviderAuthOnCredentialChange("anthropic", "old");
const unchanged = state.isProviderExhausted("anthropic", 999999999);
state.clearProviderAuthOnCredentialChange("anthropic", "new");
return { calls, nextProbeAt, unchanged, recovered: !state.isProviderExhausted("anthropic") };`,
		);
		expect(result).toEqual({ calls: 1, nextProbeAt: 901000, unchanged: true, recovered: true });
	});
});

describe("provider quota retry hint", () => {
	const quota = { status: 429, code: "usage_limit_reached" };
	const body = (message: string) => JSON.stringify({ error: { code: "usage_limit_reached", message } });

	it("waits for the hint in the structured message, the Retry-After value, or an explicit reset; five minutes without one", async () => {
		const result = await run(
			fixture(),
			`
const untils = {};
const take = (name, provider, evidence, at = 10000) => {
	state.recordProviderFailure(provider, evidence, at);
	untils[name] = state.listProviderCooldowns().find(row => row.provider === provider).until - at;
};
take("message", "a", { status: 429, body: ${JSON.stringify(body("Rate limit exceeded. Try again in 300s"))} });
take("seconds", "b", { status: 429, body: ${JSON.stringify(body("Rate limit exceeded. Try again in 45 seconds"))} });
take("retryAfter", "c", { ...${JSON.stringify(quota)}, retryAfterMs: 90000 });
take("none", "d", { ...${JSON.stringify(quota)} });
take("capped", "e", { ...${JSON.stringify(quota)}, retryAfterMs: 3 * 3600 * 1000 });
take("explicit", "f", { ...${JSON.stringify(quota)}, retryAfterMs: 90000, resetAt: 10000 + 120000 });
return untils;`,
		);
		expect(result).toEqual({
			message: 300_000,
			seconds: 45_000,
			retryAfter: 90_000,
			none: 300_000,
			capped: 3_600_000,
			explicit: 120_000,
		});
	});

	it("a quota record is gone exactly when its until has passed, and exclusion reports that until", async () => {
		const result = await run(
			fixture(),
			`
state.recordProviderFailure("a", { status: 429, code: "usage_limit_reached", retryAfterMs: 300000 }, 1000);
const before = state.providerExhaustionRecord("a", 300999)?.until;
const at = state.providerExhaustionRecord("a", 301000);
const after = state.listProviderCooldowns().length;
return { before, at: at?.until ?? null, after };`,
		);
		expect(result).toEqual({ before: 301000, at: null, after: 0 });
	});

	it("a probe that moved until earlier is honored by expiry", async () => {
		const result = await run(
			fixture(),
			`
state.recordProviderFailure("a", { status: 429, code: "usage_limit_reached" }, 1000);
await state.probeUnavailableProviders(async () => ({ available: false }), { now: 301000 });
const record = state.listProviderCooldowns()[0];
return { until: record.until, gone: state.providerExhaustionRecord("a", record.until) === undefined };`,
		);
		expect(result).toEqual({ until: 301000 + 600000, gone: true });
	});

	it("the session turn path passes the hint of the error message and a later successful call clears it", async () => {
		const directory = fixture();
		const result = await run(
			directory,
			`
const recovery = new TurnRecovery({ modelRegistry: { providerCredentialVersion: () => undefined, find: () => undefined }, model: () => undefined }, { deferFallbackChainValidation: true });
const before = Date.now();
await recovery.recordProviderAvailabilityOutcome({ provider: "proxy", model: "m", stopReason: "error", errorStatus: 429, errorCode: "usage_limit_reached", errorMessage: "Rate limit exceeded. Try again in 300s" });
const record = state.listProviderCooldowns()[0];
const wait = record.until - record.recordedAt;
await recovery.recordProviderAvailabilityOutcome({ provider: "proxy", model: "m", stopReason: "stop" });
return { wait, cleared: state.listProviderCooldowns().length === 0 };`,
		);
		expect(result).toEqual({ wait: 300_000, cleared: true });
	});

	it("keeps balance, entitlement and auth recovery rules", async () => {
		const result = await run(
			fixture(),
			`
state.recordProviderFailure("bal", { status: 402, retryAfterMs: 1000 }, 1000);
state.recordProviderFailure("ent", { code: "billing_not_configured", retryAfterMs: 1000 }, 1000);
state.recordProviderFailure("auth", { status: 401, retryAfterMs: 1000 }, 1000);
const rows = Object.fromEntries(state.listProviderCooldowns().map(row => [row.provider, row.until - 1000]));
const alive = ["bal", "ent", "auth"].map(name => state.providerExhaustionRecord(name, 99999999) !== undefined);
let probes = 0;
await state.probeUnavailableProviders(async () => { probes++; return { available: false }; }, { now: 301000 });
const afterFailedProbe = state.listProviderCooldowns().map(row => [row.provider, row.failedCallCount]);
return { rows, alive, probes, afterFailedProbe };`,
		);
		expect(result).toMatchObject({
			rows: { bal: 300_000, ent: 300_000 },
			alive: [true, true, true],
			probes: 2,
			afterFailedProbe: [
				["bal", 1],
				["ent", 1],
				["auth", 1],
			],
		});
	});
});
