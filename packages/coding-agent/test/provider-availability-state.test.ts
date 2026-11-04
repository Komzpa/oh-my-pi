import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { finalize } from "@oh-my-pi/pi-ai/error/finalize";
import { OpenAIHttpError } from "@oh-my-pi/pi-ai/error/classes";
import { classifyProviderFailure } from "../src/session/provider-exhaustion";

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
		const cases = [
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
		const result = await run(directory, `return state.providerExhaustionRecord("deepseek", 3600001);`);
		expect(result).toMatchObject({
			class: "balance",
			firstSeen: 1000,
			lastSeen: 2000,
			failedCallCount: 2,
			status: 402,
			code: "insufficient_balance",
		});
	});

	it("clears known quota reset but retains unknown quota until a successful probe", async () => {
		const result = await run(
			fixture(),
			`
state.recordProviderFailure("known", { code: "quota_exceeded", resetAt: 3000 }, 1000);
state.recordProviderFailure("unknown", { code: "quota_exceeded" }, 1000);
return [state.isProviderExhausted("known", 3000), state.isProviderExhausted("unknown", 99999999)];`,
		);
		expect(result).toEqual([false, true]);
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
