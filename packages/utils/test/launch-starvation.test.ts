import { afterEach, expect, test, vi } from "bun:test";
import { launchStep, runLaunchTrace } from "../src/launch-trace";
import * as logger from "../src/logger";
import { resetLoopPhaseWindow, takeLoopPhaseAttribution, withLoopPhase } from "../src/loop-phase";

afterEach(() => {
	vi.restoreAllMocks();
	resetLoopPhaseWindow();
});

// A parent timer is created outside all four launch scopes. It occupies the
// main thread before resolving each continuation; child spans themselves stay fast.
test("concurrent launch traces expose parent CPU bursts between fast child spans", async () => {
	// Keep the deliberate multi-second blocks out of the suite's shared loop.
	if (process.env.OMP_STARVATION_FIXTURE !== "1") {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, OMP_STARVATION_FIXTURE: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		console.log(stdout);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		return;
	}
	const logs = vi.spyOn(logger, "debug").mockImplementation(() => {});
	vi.spyOn(logger, "warn").mockImplementation(() => {});
	for (const blockMs of [0, 1000]) {
		const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		const started = performance.now();
		resetLoopPhaseWindow(started);
		const parent = (async () => {
			for (const gate of gates) {
				await Bun.sleep(200);
				withLoopPhase("fixture.parent.cpu", () => {
					const until = performance.now() + blockMs;
					while (performance.now() < until) {
						/* deliberate parent CPU burst */
					}
				});
				gate.resolve();
			}
		})();
		await Promise.all(
			Array.from({ length: 4 }, (_, id) =>
				runLaunchTrace({ id, blockMs }, () =>
					launchStep("sdkCreate", async () => {
						for (const gate of gates) {
							launchStep("before", () => 1);
							await gate.promise;
							launchStep("after", () => 2);
						}
					}),
				),
			),
		);
		await parent;
		const attribution = takeLoopPhaseAttribution();
		const summaries = logs.mock.calls.filter(call => call[1]?.blockMs === blockMs).map(call => call[1]);
		expect(summaries).toHaveLength(4);
		for (const summary of summaries) {
			const spans = summary?.spans as Array<{ name: string; wallMs: number }>;
			const gaps = summary?.boundaryGaps as Array<{ wallMs: number; before: string; after: string }>;
			const lag = summary?.loopLag as { samples: Array<{ driftMs: number }> };
			expect(spans.filter(span => span.name !== "sdkCreate").every(span => span.wallMs < 100)).toBe(true);
			expect(Number(summary?.boundaryGapMs) + Number(summary?.leafIntervalMs)).toBeCloseTo(
				Number(summary?.totalMs),
				5,
			);
			if (blockMs) {
				expect(Number(summary?.boundaryGapMs)).toBeGreaterThan(3500);
				expect(
					gaps.filter(gap => gap.wallMs >= 1000 && gap.before === "before:end" && gap.after === "after:start"),
				).toHaveLength(3);
				expect(lag.samples[0]?.driftMs).toBeGreaterThan(800);
			} else {
				expect(Number(summary?.totalMs)).toBeLessThan(1500);
				expect(lag.samples.every(sample => sample.driftMs < 500)).toBe(true);
			}
		}
		if (blockMs) expect(attribution).toMatchObject({ label: "fixture.parent.cpu", ms: expect.any(Number) });
		console.log(JSON.stringify({ fixture: "parent-starvation", blockMs, attribution, summaries }));
	}
}, 15000);
