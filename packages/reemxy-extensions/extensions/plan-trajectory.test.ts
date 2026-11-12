import { describe, expect, test } from "bun:test";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import fixture from "./fixtures/plan-critic-dc.json";
import {
	analyzeTrajectory,
	buildTrajectoryDigest,
	compactTrajectoryDigest,
	trajectoryTriggers,
} from "./plan-trajectory";

function dc() {
	return buildTrajectoryDigest(fixture.entries, fixture.phases as TodoScheduleInput, Date.parse(fixture.now));
}
describe("plan trajectory", () => {
	test("real DC tail exposes deadline slip and the Labels dependency chain", () => {
		const digest = dc();
		const verdict = analyzeTrajectory(digest);
		expect(verdict.converging).toBe(false);
		expect(trajectoryTriggers(digest)).toContain("SLIP");
		expect(trajectoryTriggers(digest)).toContain("CHURN");
		expect(verdict.criticalPathBlocker).toBe("Facility labels after rotation: leaders cross the building");
		expect(verdict.rowsToSplit).toContain(verdict.criticalPathBlocker!);
		expect(digest.rows.find(r => r.row.startsWith("11 MW Adaptive"))!.dependencies).toContain(
			verdict.criticalPathBlocker!,
		);
	});
	test("declining open work with fresh estimates produces no intervention", () => {
		const now = 10_000_000;
		const phases: TodoScheduleInput = [
			{
				name: "work",
				tasks: [
					{
						content: "Deliver preview",
						status: "in_progress",
						schedule: {
							firstRequirementAt: now - 1000,
							dependencies: [],
							estimate: {
								optimisticSeconds: 60,
								likelySeconds: 120,
								pessimisticSeconds: 240,
								confidence: "high",
								basis: "measured",
								updatedAt: now,
							},
						},
					},
				],
			},
		];
		const d = buildTrajectoryDigest([], phases, now);
		d.samples = [
			{ at: now - 100 * 60_000, open: 4, active: 2, ready: 0 },
			{ at: now, open: 1, active: 1, ready: 0 },
		];
		expect(analyzeTrajectory(d)).toEqual({
			converging: true,
			criticalPathBlocker: null,
			falseDependencies: [],
			rowsToSplit: [],
			rowsToCut: [],
			rowsToEscalate: [],
			actions: [],
		});
	});
	test("bounded UTF-8 output retains original deadline and newest deadline with omission disclosure", () => {
		const d = dc();
		const baseline = d.deadlines[0];
		const latest = d.deadlines.at(-1);
		d.rows = Array.from({ length: 500 }, (_, i) => ({ ...d.rows[0]!, row: `${i} ${"Ж".repeat(2000)}` }));
		const serialized = compactTrajectoryDigest(d);
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(12288);
		const parsed = JSON.parse(serialized);
		expect(parsed.omittedRows).toBeGreaterThan(0);
		expect(parsed.deadlines[0]).toEqual(baseline);
		expect(parsed.deadlines.at(-1)).toEqual(latest);
	});
	test("note port preserves midnight rollover and STALL with active workers", () => {
		const now = Date.parse("2026-11-07T22:00:00Z");
		const d = buildTrajectoryDigest(
			[
				{
					customType: "goal-deadline-time-note",
					timestamp: "2026-11-07T19:50:00Z",
					content: "deadline 00:30 on track",
				},
			],
			[],
			now,
		);
		expect(d.deadlines[0]!.due).toBe(Date.parse("2026-11-07T20:30:00Z"));
		d.samples = [
			{ at: now - 100 * 60_000, open: 3, active: 2, ready: 0 },
			{ at: now, open: 3, active: 2, ready: 0 },
		];
		expect(trajectoryTriggers(d)).toContain("STALL");
	});
});
