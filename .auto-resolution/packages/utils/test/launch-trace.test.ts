import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { finishLaunchTrace, launchMetric, launchStep, runLaunchTrace } from "../src/launch-trace";
import * as logger from "../src/logger";
import { currentLoopPhase } from "../src/loop-phase";

afterEach(() => {
	vi.restoreAllMocks();
});
function capture() {
	return spyOn(logger, "debug").mockImplementation(() => {});
}

test("overlapping launches retain their own nested timing and never label another task's wait", async () => {
	const logs = capture();
	const a = Promise.withResolvers<void>();
	const b = Promise.withResolvers<void>();
	const first = runLaunchTrace({ id: "a" }, () =>
		launchStep("a.wait", async () => {
			expect(currentLoopPhase()).toBe("a.wait");
			a.resolve();
			await b.promise;
			launchStep("a.finish", () => expect(currentLoopPhase()).toBe("a.finish"));
		}),
	);
	await a.promise;
	expect(currentLoopPhase()).toBeUndefined();
	await runLaunchTrace({ id: "b" }, async () => {
		launchStep("b.work", () => launchMetric("count", 3));
		b.resolve();
	});
	await first;
	const summaries = logs.mock.calls.map(call => call[1]);
	expect(summaries).toHaveLength(2);
	const firstSummary = summaries.find(value => value?.id === "a");
	expect(firstSummary?.spans).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "a.wait" }),
			expect.objectContaining({ name: "a.finish" }),
		]),
	);
	expect(firstSummary?.spans).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "b.work" })]));
	expect(currentLoopPhase()).toBeUndefined();
});

test("failure preserves the error while timing output and identifiers stay bounded", async () => {
	const logs = capture();
	const failure = new Error("fixture failure");
	await expect(
		runLaunchTrace({ id: "x".repeat(1000) }, async () => {
			for (let i = 0; i < 280; i++) launchStep(`step${i}`, () => i * 2);
			await launchStep("failure", async () => {
				throw failure;
			});
		}),
	).rejects.toBe(failure);
	expect(logs.mock.calls).toHaveLength(1);
	const summary = logs.mock.calls[0]?.[1];
	expect(summary?.failed).toBe(true);
	expect(summary?.id).toHaveLength(160);
	expect(summary?.spans).toHaveLength(256);
	expect(summary?.overflow).toBe(25);
});

test("outside a launch trace steps do not emit timing or leak phase across waits", async () => {
	const logs = capture();
	await launchStep("unrelated", async () => {
		await Bun.sleep(1);
		expect(currentLoopPhase()).toBeUndefined();
		launchMetric("ignored", 2);
	});
	expect(logs.mock.calls).toHaveLength(0);
});

test("existing logger.time spans remain visible after startup recording ends", async () => {
	const logs = capture();
	logger.endTiming();
	await runLaunchTrace({ id: "logger" }, async () => {
		await logger.time("discovery.wait", async () => {
			await Bun.sleep(1);
		});
	});
	expect(logs.mock.calls[0]?.[1]?.spans).toEqual([
		expect.objectContaining({ name: "discovery.wait", wallMs: expect.any(Number) }),
	]);
});

test("readiness emits once and nested SDK traces share the launch identity", async () => {
	const logs = capture();
	let now = 0;
	spyOn(performance, "now").mockImplementation(() => now);
	await runLaunchTrace({ id: "outer" }, async () => {
		await runLaunchTrace({ id: "sdk" }, async () => {
			launchStep("init", () => {
				now += 10;
			});
		});
		finishLaunchTrace();
		now += 9000;
		launchStep("task", () => {
			now += 100;
		});
		finishLaunchTrace();
	});
	expect(logs.mock.calls).toHaveLength(1);
	expect(logs.mock.calls[0]?.[1]).toMatchObject({ id: "outer", totalMs: 10, failed: false, unit: "ms" });
	expect(logs.mock.calls[0]?.[1]?.spans).toEqual([expect.objectContaining({ name: "init", count: 1 })]);
});

test("slow warnings retain late bottlenecks beyond the name cap and aggregate repeated work", async () => {
	const logs = capture();
	const warns = spyOn(logger, "warn").mockImplementation(() => {});
	let now = 0;
	spyOn(performance, "now").mockImplementation(() => now);
	await runLaunchTrace({ id: "slow" }, async () => {
		for (let i = 0; i < 256; i++)
			launchStep(`short${i}`, () => {
				now += 1;
			});
		launchStep("late", () => {
			now += 2500;
		});
		launchStep("late", () => {
			now += 100;
		});
		launchStep("second", () => {
			now += 300;
		});
		launchStep("third", () => {
			now += 200;
		});
	});
	expect(warns.mock.calls).toHaveLength(1);
	expect(warns.mock.calls[0]?.[1]?.top).toEqual([
		expect.objectContaining({ name: "late", count: 2, wallMs: 2600, syncPrefixMs: 2600 }),
		expect.objectContaining({ name: "second", wallMs: 300 }),
		expect.objectContaining({ name: "third", wallMs: 200 }),
	]);
	expect(logs.mock.calls[0]?.[1]?.spans).toHaveLength(256);
	expect(logs.mock.calls[0]?.[1]?.overflow).toBe(3);
});
