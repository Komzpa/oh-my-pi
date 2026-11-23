import { describe, expect, test } from "bun:test";
import { createStatusCoordinator } from "../native/status-coordinator.js";

function simulatedClock() {
	let now = 0;
	const timers: Array<{ at: number; callback: () => void; canceled: boolean }> = [];
	const coordinator = createStatusCoordinator({
		now: () => now,
		setTimer: (callback, delay) => {
			const timer = { at: now + delay, callback, canceled: false, unref: () => {} };
			timers.push(timer);
			return timer;
		},
		clearTimer: timer => {
			(timer as { canceled: boolean }).canceled = true;
		},
	});
	return {
		coordinator,
		now: () => now,
		async advance(ms: number) {
			now += ms;
			for (const timer of timers.filter(timer => !timer.canceled && timer.at <= now)) {
				timer.canceled = true;
				timer.callback();
			}
			for (let turn = 0; turn < 8; turn++) await Promise.resolve();
		},
	};
}

describe("status coordinator", () => {
	test("holds the 10-second cap across callers arriving every 500 ms for one minute", async () => {
		const clock = simulatedClock();
		const starts: number[] = [];
		const waiters: Promise<number>[] = [];
		for (let tick = 0; tick < 120; tick++) {
			const snapshot = `shape-${tick}`;
			const run = async () => {
				starts.push(clock.now());
				return tick;
			};
			waiters.push(clock.coordinator.request("worktree", snapshot, "same", run));
			waiters.push(clock.coordinator.request("worktree", snapshot, "same", run));
			await clock.advance(500);
		}
		expect(starts.length).toBeLessThanOrEqual(7);
		for (let slot = 0; slot < 120; slot++) await clock.advance(10_000);
		expect((await Promise.all(waiters)).length).toBe(240);
		expect(starts).toHaveLength(120);
		for (let index = 1; index < starts.length; index++) {
			expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(10_000);
		}
	});

	test("coalesces matching in-flight probes and caches their result", async () => {
		const { coordinator } = simulatedClock();
		let calls = 0;
		const run = async () => {
			calls++;
			return "clean";
		};
		const first = coordinator.request("worktree", "normal", "m1", run);
		const second = coordinator.request("worktree", "normal", "m1", run);
		expect(await Promise.all([first, second])).toEqual(["clean", "clean"]);
		expect(await coordinator.request("worktree", "normal", "m1", run)).toBe("clean");
		expect(calls).toBe(1);
	});

	test("expires a same-shape cache entry at ten seconds", async () => {
		const clock = simulatedClock();
		let calls = 0;
		const read = () => clock.coordinator.request("worktree", "normal", "m", async () => ++calls);
		expect(await read()).toBe(1);
		await clock.advance(9_999);
		expect(await read()).toBe(1);
		expect(calls).toBe(1);
		await clock.advance(1);
		expect(await read()).toBe(2);
		expect(calls).toBe(2);
	});

	test("fresh reads bypass TTL cache but still queue at the ten-second rate limit", async () => {
		const clock = simulatedClock();
		let calls = 0;
		const read = () => clock.coordinator.request("worktree", "normal", "m", async () => ++calls);
		expect(await read()).toBe(1);
		expect(await read()).toBe(1);
		const fresh = clock.coordinator.request("worktree", "normal", "m", async () => ++calls, undefined, true);
		expect(calls).toBe(1);
		await clock.advance(9_999);
		expect(calls).toBe(1);
		await clock.advance(1);
		expect(await fresh).toBe(2);
		expect(await read()).toBe(2);
		expect(calls).toBe(2);
	});

	test("keeps an isolated CLI alive until an incompatible queued read finishes", async () => {
		const moduleUrl = new URL("../native/status-coordinator.js", import.meta.url).href;
		const source = [
			`import { createStatusCoordinator } from ${JSON.stringify(moduleUrl)};`,
			"const coordinator = createStatusCoordinator({ intervalMs: 25 });",
			"let calls = 0;",
			"await coordinator.request('repo', 'normal', 'm', () => ++calls);",
			"await coordinator.request('repo', 'all', 'm', () => ++calls);",
			'console.log("finished=" + calls);',
		].join("\n");
		const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain("finished=2");
	});

	test("queues incompatible snapshots in order and preserves each result", async () => {
		const clock = simulatedClock();
		const calls: string[] = [];
		const first = clock.coordinator.request("worktree", "no", "m1", async () => {
			calls.push("no");
			return "tracked";
		});
		const second = clock.coordinator.request("worktree", "all", "m1", async () => {
			calls.push("all");
			return "everything";
		});
		expect(await first).toBe("tracked");
		await clock.advance(10_000);
		expect(await second).toBe("everything");
		expect(calls).toEqual(["no", "all"]);
	});

	test("metadata changes invalidate a cached result but still wait for the next slot", async () => {
		const clock = simulatedClock();
		let calls = 0;
		const first = await clock.coordinator.request("worktree", "normal", "index-1", async () => ++calls);
		const refreshed = clock.coordinator.request("worktree", "normal", "index-2", async () => ++calls);
		expect(first).toBe(1);
		await clock.advance(9_999);
		expect(calls).toBe(1);
		await clock.advance(1);
		expect(await refreshed).toBe(2);
	});

	test("explicit invalidation clears a success cache without resetting the slot", async () => {
		const clock = simulatedClock();
		let calls = 0;
		expect(await clock.coordinator.request("worktree", "normal", "m", async () => ++calls)).toBe(1);
		await clock.advance(0);
		clock.coordinator.invalidate("worktree");
		expect(clock.coordinator.epoch("worktree")).toBe(1);
		const refreshed = clock.coordinator.request("worktree", "normal", "m", async () => ++calls);
		await clock.advance(10_000);
		expect(await refreshed).toBe(2);
	});

	test("rate-limits failures and explicit invalidation without resetting the slot", async () => {
		const clock = simulatedClock();
		let calls = 0;
		const fail = async () => {
			calls++;
			throw new Error("probe failed");
		};
		await expect(clock.coordinator.request("worktree", "normal", "m1", fail)).rejects.toThrow("probe failed");
		const retry = clock.coordinator.request("worktree", "normal", "m1", async () => {
			calls++;
			return "fresh";
		});
		clock.coordinator.invalidate("worktree");
		expect(calls).toBe(1);
		await clock.advance(10_000);
		expect(await retry).toBe("fresh");
		expect(calls).toBe(2);
	});

	test("a request after invalidation never joins an older in-flight probe", async () => {
		const clock = simulatedClock();
		const pending = Promise.withResolvers<string>();
		const first = clock.coordinator.request("repo", "normal", "m", () => pending.promise);
		clock.coordinator.invalidate("repo");
		let calls = 0;
		const next = clock.coordinator.request("repo", "normal", "m", () => {
			calls++;
			return "new";
		});
		pending.resolve("old");
		expect(await first).toBe("old");
		await clock.advance(9_999);
		expect(calls).toBe(0);
		await clock.advance(1);
		expect(await next).toBe("new");
		expect(calls).toBe(1);
	});

	test("keeps linked worktrees on independent rate limits", async () => {
		const { coordinator } = simulatedClock();
		let calls = 0;
		const one = coordinator.request("root\0gitdir-one", "normal", "m", async () => ++calls);
		const two = coordinator.request("root\0gitdir-two", "normal", "m", async () => ++calls);
		expect(await Promise.all([one, two])).toEqual([1, 2]);
		expect(calls).toBe(2);
	});

	test("an aborted queued reader neither runs nor keeps a timer alive", async () => {
		const clock = simulatedClock();
		let calls = 0;
		await clock.coordinator.request("repo", "normal", "m", () => ++calls);
		const controller = new AbortController();
		const queued = clock.coordinator.request("repo", "all", "m", () => ++calls, controller.signal);
		controller.abort();
		await expect(queued).rejects.toMatchObject({ name: "AbortError" });
		await clock.advance(20_000);
		expect(calls).toBe(1);
		await expect(
			clock.coordinator.request("repo", "all", "m", () => ++calls, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(1);
	});

	test("aborting one waiter leaves the shared probe available to another", async () => {
		const { coordinator } = simulatedClock();
		const pending = Promise.withResolvers<string>();
		const run = () => pending.promise;
		const controller = new AbortController();
		const aborted = coordinator.request("worktree", "normal", "m", run, controller.signal);
		const remaining = coordinator.request("worktree", "normal", "m", run);
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		pending.resolve("shared");
		expect(await remaining).toBe("shared");
	});
});
