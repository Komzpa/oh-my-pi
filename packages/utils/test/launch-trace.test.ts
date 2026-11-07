import { afterEach, expect, spyOn, test, vi } from "bun:test";
import {
	finishLaunchTrace,
	launchMetric,
	launchStep,
	runLaunchTrace,
	takeLaunchPhaseCandidates,
} from "../src/launch-trace";
import * as logger from "../src/logger";
import { currentLoopPhase } from "../src/loop-phase";

afterEach(() => {
	vi.restoreAllMocks();
	takeLaunchPhaseCandidates(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
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

test("awaited extension work supplies bounded overlap candidates without claiming CPU attribution", async () => {
	capture();
	let now = 0;
	spyOn(performance, "now").mockImplementation(() => now);
	await runLaunchTrace({ id: "delayed" }, () =>
		launchStep("sdkCreate", () =>
			launchStep("extension.init:delayed", async () => {
				await Promise.resolve();
				now = 350;
				expect(currentLoopPhase()).toBeUndefined();
				expect(takeLaunchPhaseCandidates(250, 350)).toEqual(["extension.init:delayed", "sdkCreate"]);
			}),
		),
	);
	expect(takeLaunchPhaseCandidates(250, 350)).toEqual(["extension.init:delayed", "sdkCreate"]);
	expect(takeLaunchPhaseCandidates(350, 700)).toEqual([]);
});

test("a recursive child launched after parent readiness gets its own summary", async () => {
	const logs = capture();
	await runLaunchTrace({ id: "parent" }, async () => {
		launchStep("parent.init", () => 1);
		finishLaunchTrace();
		await runLaunchTrace({ id: "child" }, async () => {
			launchStep("child.init", () => 2);
		});
	});
	const summaries = logs.mock.calls.map(call => call[1]);
	expect(summaries.map(summary => summary?.id)).toEqual(["parent", "child"]);
	expect(summaries[1]?.spans).toEqual([expect.objectContaining({ name: "child.init" })]);
});

test("background completion cannot extend launch attribution beyond readiness", async () => {
	capture();
	let now = 0;
	spyOn(performance, "now").mockImplementation(() => now);
	const resume = Promise.withResolvers<void>();
	await runLaunchTrace({ id: "background" }, async () => {
		const background = launchStep("background.wait", () => resume.promise);
		now = 10;
		finishLaunchTrace();
		now = 100;
		resume.resolve();
		await background;
		expect(takeLaunchPhaseCandidates(20, 100)).toEqual([]);
	});
});

test("boundary accounting includes entry, repeated spans and tail without double counting nested wall time", async () => {
	const logs = capture();
	let now = 0;
	spyOn(performance, "now").mockImplementation(() => now);
	await runLaunchTrace({ id: "gaps" }, async () => {
		now = 10;
		await launchStep("sdkCreate", async () => {
			now = 30;
			launchStep("child", () => {
				now = 32;
			});
			now = 1032;
			launchStep("child", () => {
				now = 1034;
			});
			now = 1044;
		});
		now = 1054;
	});
	const summary = logs.mock.calls[0]?.[1];
	expect(summary?.spans).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "child", count: 2, startOffsetMs: 30, endOffsetMs: 1034, wallMs: 4 }),
		]),
	);
	expect(summary?.boundaryGaps).toEqual(
		expect.arrayContaining([
			{ startOffsetMs: 32, wallMs: 1000, before: "child:end", after: "child:start" },
			{ startOffsetMs: 0, wallMs: 10, before: "launch:start", after: "sdkCreate:start" },
			{ startOffsetMs: 1044, wallMs: 10, before: "sdkCreate:end", after: "launch:end" },
		]),
	);
	expect(summary?.boundaryGapMs).toBe(1050);
	expect(summary?.leafIntervalMs).toBe(4);
	expect(summary?.loopLag).toMatchObject({ count: 1, samples: [{ startOffsetMs: 100, driftMs: 954 }] });
});
