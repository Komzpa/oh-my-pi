import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage } from "../src/auth-storage";
import type { FetchImpl } from "../src/types";
import type { UsageFetchParams } from "../src/usage";
import { claudeUsageProvider } from "../src/usage/claude";

function sessions(): UsageFetchParams[] {
	const accountId = crypto.randomUUID();
	return Array.from({ length: 20 }, (_, i) => ({
		provider: "anthropic",
		credential: { type: "oauth", accountId, email: "shared@example.test", accessToken: `token-${i}` },
	}));
}

const payload = { five_hour: { utilization: 42 }, cedar_ember: { available: 0 } };

afterEach(() => vi.restoreAllMocks());

describe("Claude usage shared across sessions", () => {
	for (const status of [200, 429]) {
		it(`shares ${status} polls across 12 independent AuthStorage session instances`, async () => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const accountId = crypto.randomUUID();
			let requests = 0;
			const poll = () =>
				Promise.all(
					Array.from({ length: 12 }, async () => {
						// Distinct store and transport per session: only the provider can coalesce these.
						const storage = await AuthStorage.create(":memory:", {
							usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageProvider : undefined),
							usageFetch: (async (url: string | URL | Request) => {
								if (!String(url).endsWith("/usage")) return new Response(null, { status: 404 });
								requests++;
								return status === 200 ? Response.json(payload) : new Response(null, { status: 429 });
							}) as unknown as typeof globalThis.fetch,
						});
						try {
							await storage.credentials.set("anthropic", {
								type: "oauth",
								access: "test-access",
								refresh: "test-refresh",
								expires: now + 3_600_000,
								accountId,
								email: "sessions@example.test",
							});
							return await storage.usage.reports({ provider: "anthropic" });
						} finally {
							storage.close();
						}
					}),
				);
			const reports = await poll();
			expect(requests).toBe(1);
			expect(
				reports.every(rows => (status === 200 ? rows?.[0]?.limits[0]?.amount.used === 42 : rows?.length === 0)),
			).toBe(true);
			await poll();
			expect(requests).toBe(1);
			now += status === 200 ? 300_000 : 60_000;
			await poll();
			expect(requests).toBe(2);
		});
	}

	it("coalesces concurrent and sequential polls until the refresh interval expires", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const params = sessions();
		let requests = 0;
		let usageRequests = 0;
		const fetch = (async (url: string | URL | Request) => {
			requests++;
			if (String(url).endsWith("/usage")) usageRequests++;
			return Response.json(payload);
		}) as FetchImpl;
		const poll = () => Promise.all(params.map(p => claudeUsageProvider.fetchUsage(p, { fetch })));
		const reports = await poll();
		expect(reports.every(r => r?.limits[0]?.amount.used === 42)).toBe(true);
		const initial = requests;
		await poll();
		expect(requests).toBe(initial);
		// Count /usage independently of optional reset inventory/profile probes.
		expect(usageRequests).toBe(1);
		now += 300_000;
		await poll();
		expect(usageRequests).toBe(2);
	});

	it("shares Retry-After, exponential fallback and stale last-good data across fresh sessions", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const params = sessions();
		let limited = false;
		let retryAfter: string | undefined = "120";
		let requests = 0;
		const fetch = (async (url: string | URL | Request) => {
			if (!String(url).endsWith("/usage")) return Response.json({});
			requests++;
			return limited
				? new Response(null, { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} })
				: Response.json(payload);
		}) as FetchImpl;
		const poll = () => Promise.all(params.map(p => claudeUsageProvider.fetchUsage({ ...p }, { fetch })));
		const good = await poll();
		expect(requests).toBe(1);
		now += 300_000;
		limited = true;
		const stale = await poll();
		expect(requests).toBe(2);
		expect(stale[0]?.fetchedAt).toBe(good[0]?.fetchedAt);
		expect(stale[0]?.metadata?.stale).toBe(true);
		expect(stale[0]?.limits[0]?.amount.used).toBe(42);
		now += 119_999;
		await poll();
		expect(requests).toBe(2);
		now++;
		retryAfter = undefined;
		await poll();
		expect(requests).toBe(3);
		now += 119_999; // Second failure doubles the fallback to 120 seconds.
		await poll();
		expect(requests).toBe(3);
		now++;
		limited = false;
		const recovered = await poll();
		expect(requests).toBe(4);
		expect(recovered[0]?.metadata?.stale).not.toBe(true);
	});

	it("a confirmed reset clears shared pre-reset quota and backoff", async () => {
		const params = sessions()[0]!;
		let limited = true;
		let requests = 0;
		const fetch = (async (url: string | URL | Request) => {
			if (!String(url).endsWith("/usage")) return new Response(null, { status: 404 });
			requests++;
			return limited ? new Response(null, { status: 429 }) : Response.json(payload);
		}) as FetchImpl;
		await claudeUsageProvider.fetchUsage(params, { fetch });
		limited = false;
		await claudeUsageProvider.fetchUsage(params, { fetch });
		expect(requests).toBe(1);
		claudeUsageProvider.onReset?.(params);
		const report = await claudeUsageProvider.fetchUsage(params, { fetch });
		expect(requests).toBe(2);
		expect(report?.limits[0]?.amount.used).toBe(42);
	});

	it("cancelling one session leaves its peer's shared fetch running and reports cannot mutate the cache", async () => {
		const params = sessions()[0]!;
		const response = Promise.withResolvers<Response>();
		let requests = 0;
		const fetch = (async (url: string | URL | Request) => {
			if (!String(url).endsWith("/usage")) return new Response(null, { status: 404 });
			requests++;
			return response.promise;
		}) as FetchImpl;
		const controller = new AbortController();
		const first = claudeUsageProvider.fetchUsage({ ...params, signal: controller.signal }, { fetch });
		const peer = claudeUsageProvider.fetchUsage(params, { fetch });
		controller.abort();
		expect(await first).toBeNull();
		response.resolve(Response.json(payload));
		const report = await peer;
		expect(report?.limits[0]?.amount.used).toBe(42);
		report!.limits[0]!.amount.used = 99;
		const cached = await claudeUsageProvider.fetchUsage(params, { fetch });
		expect(cached?.limits[0]?.amount.used).toBe(42);
		expect(requests).toBe(1);
	});

	it("cold 429 polls issue one request per window and keep other accounts independent", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const params = sessions();
		let requests = 0;
		const fetch = (async () => {
			requests++;
			return new Response(null, { status: 429, headers: { "retry-after": new Date(now + 180_000).toUTCString() } });
		}) as FetchImpl;
		const poll = () => Promise.all(params.map(p => claudeUsageProvider.fetchUsage(p, { fetch })));
		expect((await poll()).every(r => r === null)).toBe(true);
		await poll();
		expect(requests).toBe(1);
		await claudeUsageProvider.fetchUsage(sessions()[0]!, { fetch });
		expect(requests).toBe(2);
		now += 179_000;
		await poll();
		expect(requests).toBe(2);
		now += 1000;
		await poll();
		expect(requests).toBe(3);
	});
});
