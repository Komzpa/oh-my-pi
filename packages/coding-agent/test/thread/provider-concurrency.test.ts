import { afterEach, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { getProviderSemaphore } from "../../src/task/provider-concurrency";
import type { ThreadService } from "../../src/thread/services";
import { THREAD_SERVICES } from "../../src/thread/services/index";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { ProviderProbe } from "../fixtures/provider-concurrency-hook";

const workers: SubagentWorker[] = [];
const endRuns: Array<() => void> = [];
afterEach(() => {
	for (const end of endRuns.splice(0)) end();
	for (const worker of workers.splice(0)) worker.terminate();
});

function bounded<T>(promise: Promise<T>, timeoutMs = 2000, stage = "provider operation"): Promise<T> {
	return Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`Provider probe timed out during ${stage}`);
		}),
	]);
}

async function host(): Promise<{ worker: SubagentWorker; probe: ProviderProbe }> {
	const { promise, resolve } = Promise.withResolvers<ProviderProbe>();
	const report: ThreadService = { name: "provider-probe", globals: () => ({ ready: resolve }) };
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/provider-concurrency-worker.ts", import.meta.url),
		services: [...THREAD_SERVICES, report],
	});
	workers.push(worker);
	endRuns.push(worker.beginRun());
	// Loading the production service graph competes with other CI test processes.
	// Keep the limiter-operation deadline separate from worker initialization.
	await bounded(worker.ready, 30_000, "worker initialization");
	return { worker, probe: await bounded(promise, 30_000, "probe registration") };
}

function settings(limit: number): Settings {
	return Settings.isolated({ "providers.ollama-cloud.maxConcurrency": limit });
}

async function blocked(probe: ProviderProbe, id: string): Promise<void> {
	// This RPC follows start on the same port: the provider wrapper has begun waiting.
	expect((await probe.state()).attempted).toContain(id);
	await Bun.sleep(40);
	expect((await probe.state()).admitted).not.toContain(id);
}

function start(probe: ProviderProbe, id: string, limit = 1, signal?: AbortSignal): Promise<void> {
	const pending = probe.start(id, "ollama-cloud", limit, signal);
	pending.catch(() => {}); // A terminating worker rejects its pending RPC, observed by the test below.
	return pending;
}

test("one thread shares provider slots between settings instances", async () => {
	const first = getProviderSemaphore(settings(1), "ollama-cloud")!;
	const second = getProviderSemaphore(settings(1), "ollama-cloud")!;
	await first.acquire();
	let admitted = false;
	const waiting = second.acquire().then(() => {
		admitted = true;
	});
	try {
		await Bun.sleep(20);
		expect(admitted).toBe(false);
	} finally {
		first.release();
	}
	await bounded(waiting);
	second.release();
});

test("shares one cap across main and multiple production subagent hosts", async () => {
	const a = await host();
	const b = await host();
	const main = getProviderSemaphore(settings(1), "ollama-cloud")!;
	await main.acquire();
	const first = start(a.probe, "first");
	const second = start(b.probe, "second");
	try {
		await blocked(a.probe, "first");
		await blocked(b.probe, "second");
	} finally {
		main.release();
	}
	// Each host's request may reach main first; drain whichever the provider admitted.
	const winner = await bounded(Promise.race([first.then(() => a), second.then(() => b)]));
	const other = winner === a ? b : a;
	const firstId = winner === a ? "first" : "second";
	const otherId = winner === a ? "second" : "first";
	await blocked(other.probe, otherId);
	await winner.probe.finish(firstId);
	await bounded(Promise.all([first, second]));
	await other.probe.finish(otherId);
});

test("provider throw and stream error release the shared slot", async () => {
	const a = await host();
	const b = await host();
	await expect(a.probe.start("throws", "ollama-cloud", 1, undefined, true)).rejects.toThrow("provider rejected");
	await bounded(start(b.probe, "stream-error"));
	const waiting = start(a.probe, "after-error");
	await blocked(a.probe, "after-error");
	await b.probe.finish("stream-error", true);
	await bounded(waiting);
	await a.probe.finish("after-error");
});

test("cancels queued acquisition without leaking a slot", async () => {
	const a = await host();
	const b = await host();
	await bounded(start(a.probe, "held"));
	const cancel = new AbortController();
	const waiting = start(b.probe, "cancelled", 1, cancel.signal);
	await blocked(b.probe, "cancelled");
	cancel.abort(new Error("cancel queued request"));
	const outcome = await bounded(
		waiting.then(
			() => "unexpected admission",
			error => String(error),
		),
	);
	expect(outcome).toContain("cancel queued request");
	await a.probe.finish("held");
	await bounded(start(b.probe, "after-cancel"));
	await b.probe.finish("after-cancel");
});

test("active cancellation releases once even when the abandoned stream later settles", async () => {
	const a = await host();
	const b = await host();
	const cancel = new AbortController();
	await bounded(start(a.probe, "cancel-active", 1, cancel.signal));
	const waiting = start(b.probe, "next");
	await blocked(b.probe, "next");
	cancel.abort();
	await bounded(waiting); // The first stream has deliberately not settled.
	const third = start(a.probe, "third");
	await a.probe.finish("cancel-active", true);
	await blocked(a.probe, "third"); // Late completion must not release next's lease.
	await b.probe.finish("next");
	await bounded(third);
	await a.probe.finish("third");
});

test("worker death reclaims held leases and removes queued acquisitions", async () => {
	const a = await host();
	const b = await host();
	const c = await host();
	await bounded(start(a.probe, "dead-owner"));
	const waiting = start(b.probe, "survivor");
	await blocked(b.probe, "survivor");
	await a.probe.crash();
	await bounded(waiting);
	const orphan = start(c.probe, "dead-waiter");
	await blocked(c.probe, "dead-waiter");
	c.worker.terminate("test waiter death");
	const outcome = await bounded(
		orphan.then(
			() => "unexpected admission",
			error => String(error),
		),
	);
	expect(outcome).toContain("test waiter death");
	await b.probe.finish("survivor");
	const main = getProviderSemaphore(settings(1), "ollama-cloud")!;
	await bounded(main.acquire());
	main.release();
});

test("an independent provider proceeds while ollama slots are occupied", async () => {
	const a = await host();
	const b = await host();
	await bounded(start(a.probe, "ollama-held"));
	await bounded(b.probe.start("independent", "openai", 1));
	const waiting = start(b.probe, "ollama-waiting");
	await blocked(b.probe, "ollama-waiting");
	await b.probe.finish("independent");
	await blocked(b.probe, "ollama-waiting");
	await a.probe.finish("ollama-held");
	await bounded(waiting);
	await b.probe.finish("ollama-waiting");
});

test("unlimited work remains counted when another worker lowers the cap", async () => {
	const a = await host();
	const b = await host();
	await bounded(start(a.probe, "unlimited-a", 0));
	await bounded(start(a.probe, "unlimited-b", 0));
	const waiting = start(b.probe, "finite", 1);
	await blocked(b.probe, "finite");
	await a.probe.finish("unlimited-a");
	await blocked(b.probe, "finite");
	await a.probe.finish("unlimited-b");
	await bounded(waiting);
	await b.probe.finish("finite");
});

test("raising the cap from a worker admits queued requests without replacing counters", async () => {
	const a = await host();
	const b = await host();
	await bounded(start(a.probe, "held"));
	const waiting = start(b.probe, "raised");
	await blocked(b.probe, "raised");
	await b.probe.resize(2);
	await bounded(waiting);
	await a.probe.finish("held");
	await b.probe.finish("raised");
});
