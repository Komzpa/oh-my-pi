import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as dirs from "@oh-my-pi/pi-utils";
import { FrameTelemetry, parseFrameDropLogLine, readRecentFrameDrops } from "../src/frame-telemetry";

describe("FrameTelemetry", () => {
	test("computes rolling render timing and lag for the status line", () => {
		let now = 0;
		const updates: string[] = [];
		const telemetry = new FrameTelemetry({
			now: () => now,
			thresholdMs: 10_000,
			loggerWarn: () => {},
		});
		telemetry.onStatusTextChange(text => updates.push(text));

		telemetry.beginRender("provider");
		now = 10;
		telemetry.endRender("provider", true);

		now = 1_000;
		telemetry.beginRender("provider");
		now = 1_030;
		telemetry.endRender("provider", true);

		expect(telemetry.snapshot.fps).toBe(0.4);
		expect(telemetry.snapshot.p50Ms).toBe(10);
		expect(telemetry.snapshot.p95Ms).toBe(30);
		expect(telemetry.snapshot.maxMs).toBe(30);
		expect(telemetry.snapshot.lagMs).toBe(0);
		expect(telemetry.statusText).toBe("0fps p50 10ms p95 30ms max 30ms lag 0ms");
		expect(updates).toEqual(["0fps p50 10ms p95 10ms max 10ms lag 0ms", "0fps p50 10ms p95 30ms max 30ms lag 0ms"]);
	});
	test("idle gap without input reports zero lag", () => {
		let now = 0;
		const telemetry = new FrameTelemetry({
			now: () => now,
			thresholdMs: 10_000,
			loggerWarn: () => {},
		});
		telemetry.beginRender("provider");
		now = 10;
		telemetry.endRender("provider", true);
		now = 8_010;
		telemetry.beginRender("provider");
		now = 8_020;
		telemetry.endRender("provider", true);
		expect(telemetry.snapshot.lagMs).toBe(0);
		expect(telemetry.statusText).toContain("lag 0ms");
	});

	test("lag measures input-to-paint latency", () => {
		let now = 0;
		const telemetry = new FrameTelemetry({
			now: () => now,
			thresholdMs: 10_000,
			loggerWarn: () => {},
		});
		now = 1_000;
		telemetry.recordInput("key");
		telemetry.beginRender("provider");
		now = 1_120;
		telemetry.endRender("provider", true);
		expect(telemetry.snapshot.lagMs).toBe(120);
	});

	test("lag is measured from the earliest unpainted input", () => {
		let now = 0;
		const telemetry = new FrameTelemetry({
			now: () => now,
			thresholdMs: 10_000,
			loggerWarn: () => {},
		});
		now = 1_000;
		telemetry.recordInput("key");
		now = 1_050;
		telemetry.recordInput("key");
		telemetry.beginRender("provider");
		now = 1_200;
		telemetry.endRender("provider", true);
		expect(telemetry.snapshot.lagMs).toBe(200);
	});

	test("logs a structured frame gap with last-input context", () => {
		let now = 0;
		let dateNow = Date.UTC(2026, 8, 25, 16, 30, 0);
		const logged: Array<{ message: string; context?: Record<string, unknown> }> = [];
		const telemetry = new FrameTelemetry({
			now: () => now,
			dateNow: () => dateNow,
			thresholdMs: 250,
			loggerWarn: (message, context) => logged.push({ message, context }),
		});

		telemetry.recordInput("key");
		telemetry.beginRender("provider");
		now = 10;
		telemetry.endRender("provider", true);

		dateNow += 500;
		now = 20;
		telemetry.recordRenderRequest();
		now = 400;
		telemetry.beginRender("provider");
		now = 420;
		telemetry.endRender("provider", true);

		expect(logged).toHaveLength(1);
		expect(logged[0]?.message).toBe("ui.frame-drop");
		expect(logged[0]?.context).toMatchObject({
			kind: "frame-gap",
			durationMs: 400,
			phase: "render:provider",
			lastInputAt: "2026-09-25T16:30:00.000Z",
			msSinceLastInput: 500,
			renderTarget: "provider",
			handling: "key",
			stack: "render:provider",
		});
	});
});

describe("FrameTelemetry idle handling", () => {
	test("first frame after an idle period is not a frame drop", () => {
		let now = 0;
		const logged: string[] = [];
		const telemetry = new FrameTelemetry({ now: () => now, thresholdMs: 250, loggerWarn: m => logged.push(m) });
		telemetry.beginRender("provider");
		now = 10;
		telemetry.endRender("provider", true);
		now = 60_000;
		telemetry.recordInput("key");
		telemetry.beginRender("provider");
		now = 60_020;
		telemetry.endRender("provider", true);
		expect(logged).toEqual([]);
	});

	test("a render request that waits past the threshold is a frame drop", () => {
		let now = 0;
		const logged: Array<Record<string, unknown> | undefined> = [];
		const telemetry = new FrameTelemetry({ now: () => now, thresholdMs: 250, loggerWarn: (_m, c) => logged.push(c) });
		telemetry.recordRenderRequest();
		now = 300;
		telemetry.beginRender("provider");
		now = 310;
		telemetry.endRender("provider", true);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({ kind: "frame-gap", durationMs: 310 });
	});

	test("status decays to 0fps after rendering stops and the meter does not sustain itself", () => {
		let now = 0;
		const updates: string[] = [];
		const telemetry = new FrameTelemetry({ now: () => now, thresholdMs: 10_000, loggerWarn: () => {} });
		const render = (ms: number) => {
			telemetry.beginRender("provider");
			now += ms;
			telemetry.endRender("provider", true);
		};
		// Mimic the interactive-mode listener: a text change requests a render.
		const off = telemetry.onStatusTextChange(text => {
			updates.push(text);
			telemetry.recordRenderRequest();
		});
		telemetry.recordRenderRequest();
		render(10);
		expect(telemetry.snapshot.p50Ms).toBe(10);

		now += 6_000;
		telemetry.refresh();
		expect(telemetry.statusText).toBe("0fps p50 0ms p95 0ms max 0ms lag 0ms");
		const count = updates.length;
		// The listener-requested repaint is the meter's own; it must not become a sample.
		render(3);
		now += 6_000;
		telemetry.refresh();
		telemetry.refresh();
		expect(telemetry.snapshot.fps).toBe(0);
		expect(telemetry.statusText).toBe("0fps p50 0ms p95 0ms max 0ms lag 0ms");
		expect(updates.length).toBe(count);
		off();
	});

	test("a 30s loop block with input during it shows as lag and is held, then decays", () => {
		let now = 0;
		const telemetry = new FrameTelemetry({ now: () => now, loggerWarn: () => {} });
		telemetry.beginRender("provider");
		now = 5;
		telemetry.endRender("provider", true);
		// Loop blocked 30s; the key typed meanwhile is only processed after the block ends.
		now = 30_005;
		telemetry.logLoopBlock(30_000, 29_000, "render:provider");
		telemetry.recordInput("key");
		telemetry.beginRender("provider");
		now += 4;
		telemetry.endRender("provider", true);
		expect(telemetry.snapshot.lagMs).toBeGreaterThanOrEqual(30_000);
		expect(telemetry.statusText).toContain("lag 30.0s");
		// Still visible well after the 5s sample window, until the hold period ends.
		now += 59_000;
		telemetry.refresh();
		expect(telemetry.statusText).toContain("lag 30.0s");
		now += 2_000;
		telemetry.refresh();
		expect(telemetry.snapshot.lagMs).toBe(0);
		expect(telemetry.statusText).toContain("lag 0ms");
	});

	test("a long frame gap also feeds the displayed lag", () => {
		let now = 0;
		const telemetry = new FrameTelemetry({ now: () => now, thresholdMs: 250, loggerWarn: () => {} });
		telemetry.recordRenderRequest();
		now = 12_000;
		telemetry.beginRender("provider");
		telemetry.endRender("provider", true);
		expect(telemetry.snapshot.lagMs).toBe(12_000);
		now += 20_000;
		telemetry.refresh();
		expect(telemetry.snapshot.lagMs).toBe(12_000);
	});

	test("idle without a stall keeps lag at 0ms", () => {
		let now = 0;
		const telemetry = new FrameTelemetry({ now: () => now, loggerWarn: () => {} });
		for (let i = 0; i < 5; i++) {
			now += 20_000;
			telemetry.refresh();
		}
		expect(telemetry.snapshot.lagMs).toBe(0);
		expect(telemetry.statusText).toContain("lag 0ms");
	});

	test("refresh timer stops when the last listener unsubscribes", () => {
		const telemetry = new FrameTelemetry({ loggerWarn: () => {} });
		const off = telemetry.onStatusTextChange(() => {});
		off();
		expect(() => telemetry.refresh()).not.toThrow();
	});
});

describe("parseFrameDropLogLine", () => {
	test("accepts structured ui.frame-drop log entries", () => {
		const line = JSON.stringify({
			timestamp: "2026-09-25T16:30:01.000Z",
			pid: 1234,
			message: "ui.frame-drop",
			kind: "loop-block",
			durationMs: 3_100,
			cpuMs: 2_900,
			phase: "render:provider",
			lastInputAt: "2026-09-25T16:30:00.000Z",
			msSinceLastInput: 1_000,
			renderTarget: "provider",
			handling: "key",
			stack: "render:provider > render:provider-frame",
		});

		expect(parseFrameDropLogLine(line, "omp.2026-09-25.1234.log")).toEqual({
			timestamp: "2026-09-25T16:30:01.000Z",
			pid: 1234,
			kind: "loop-block",
			durationMs: 3_100,
			cpuMs: 2_900,
			phase: "render:provider",
			lastInputAt: "2026-09-25T16:30:00.000Z",
			msSinceLastInput: 1_000,
			renderTarget: "provider",
			handling: "key",
			stack: "render:provider > render:provider-frame",
			file: "omp.2026-09-25.1234.log",
		});
	});

	test("rejects unrelated log lines", () => {
		expect(parseFrameDropLogLine(JSON.stringify({ message: "ui.loop-blocked" }))).toBeNull();
		expect(parseFrameDropLogLine("not json")).toBeNull();
	});
});

describe("unchanged frame completion", () => {
	test("unchanged frame ends pending work without counting a painted frame", () => {
		let now = 0;
		const events: unknown[] = [];
		const t = new FrameTelemetry({ now: () => now, thresholdMs: 250, loggerWarn: (_m, c) => events.push(c) });
		t.recordRenderRequest();
		t.beginRender("alt");
		now = 10;
		t.endRender("alt", false, true);
		expect(t.snapshot.fps).toBe(0);
		now = 30000;
		t.recordRenderRequest();
		t.beginRender("alt");
		now = 30010;
		t.endRender("alt", true);
		expect(events).toEqual([]);
	});
	test("deferred frames retain the pending delay", () => {
		let now = 0;
		const events: unknown[] = [];
		const t = new FrameTelemetry({ now: () => now, thresholdMs: 250, loggerWarn: (_m, c) => events.push(c) });
		t.recordRenderRequest();
		t.beginRender("provider");
		now = 10;
		t.endRender("provider", false);
		now = 30000;
		t.beginRender("provider");
		now = 30010;
		t.endRender("provider", true);
		expect(events).toEqual([expect.objectContaining({ kind: "frame-gap", durationMs: 30010 })]);
	});
});

test("recent drops skip stale rotated files before parsing their records", async () => {
	const dir = dirs.TempDir.createSync("frame-drop-files-");
	const spy = vi.spyOn(dirs, "getLogsDir").mockReturnValue(dir.path());
	try {
		const record = JSON.stringify({
			timestamp: new Date().toISOString(),
			message: "ui.frame-drop",
			durationMs: 300,
			phase: "recent",
		});
		const stale = dir.join("omp.2026-10-25.1.log.1");
		await Bun.write(stale, record.replace("recent", "stale"));
		await fs.utimes(stale, new Date(0), new Date(0));
		await Bun.write(dir.join("omp.2026-10-25.1.log"), record);
		expect((await readRecentFrameDrops(1)).map(row => row.phase)).toEqual(["recent"]);
	} finally {
		spy.mockRestore();
		dir.removeSync();
	}
});
