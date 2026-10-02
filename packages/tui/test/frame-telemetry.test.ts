import { describe, expect, test } from "bun:test";
import { FrameTelemetry, parseFrameDropLogLine } from "../src/frame-telemetry";

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
		expect(telemetry.snapshot.lagMs).toBe(990);
		expect(telemetry.statusText).toBe("0fps p50 10ms p95 30ms max 30ms lag 990ms");
		expect(updates).toEqual(["0fps p50 10ms p95 10ms max 10ms lag 0ms", "0fps p50 10ms p95 30ms max 30ms lag 990ms"]);
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
		now = 400;
		telemetry.beginRender("provider");
		now = 420;
		telemetry.endRender("provider", true);

		expect(logged).toHaveLength(1);
		expect(logged[0]?.message).toBe("ui.frame-drop");
		expect(logged[0]?.context).toMatchObject({
			kind: "frame-gap",
			durationMs: 410,
			phase: "render:provider",
			lastInputAt: "2026-09-25T16:30:00.000Z",
			msSinceLastInput: 500,
			renderTarget: "provider",
			handling: "key",
			stack: "render:provider",
		});
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
