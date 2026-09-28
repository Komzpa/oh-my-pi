import { describe, expect, it } from "bun:test";
import {
	forecastTodoPlan,
	formatTaskForecast,
	formatTaskForecastDisplay,
	formatPlanForecastDisplay,
	parseUserWait,
	validateTodoDependencies,
	type TodoEstimate,
	type TodoScheduleInput,
	type TodoScheduleInputTask,
} from "../src/tools/todo-schedule";

function task(
	content: string,
	seconds: number,
	options: {
		dependencies?: string[];
		owner?: string;
		resources?: string[];
		status?: TodoScheduleInputTask["status"];
		updatedAt?: number;
		confidence?: TodoEstimate["confidence"];
		optimisticSeconds?: number;
		pessimisticSeconds?: number;
	} = {},
): TodoScheduleInputTask {
	const {
		dependencies = [],
		owner = `owner:${content}`,
		resources = [],
		status = "pending",
		updatedAt = NOW,
		confidence = "high",
		optimisticSeconds = seconds,
		pessimisticSeconds = seconds,
	} = options;
	return {
		content,
		status,
		schedule: {
			dependencies,
			owner,
			resources,
			estimate: {
				optimisticSeconds,
				likelySeconds: seconds,
				pessimisticSeconds,
				confidence,
				basis: "deterministic fixture",
				updatedAt,
			},
		},
	};
}

const NOW = 100_000;

function phases(...tasks: TodoScheduleInputTask[]): TodoScheduleInput {
	return [{ name: "work", tasks }];
}

it("shows worked minutes and current likely estimate in the TODO tree", () => {
	const now = NOW + 20 * 60_000;
	const active = task("active", 600, { status: "in_progress" });
	active.schedule!.startedAt = now - 7 * 60_000;
	active.schedule!.reestimateCount = 2;
	const done = task("done", 600, { status: "completed" });
	done.schedule!.startedAt = now - 9 * 60_000;
	done.schedule!.finishedAt = now - 5 * 60_000;
	const rows = forecastTodoPlan(phases(active, done, task("pending", 600)), { now }).rows;
	const shown = Object.fromEntries(rows.map(row => [row.content, formatTaskForecastDisplay(row, now)]));
	expect(shown.active).toContain("7m / 10m");
	expect(shown.active).not.toContain("reestimated");
	expect(shown.done).toContain("4m / 10m");
	expect(shown.pending).toContain("10m");
	expect(shown.pending).not.toContain(" / ");
});

it("keeps scheduling method details out of rendered TODO lines", () => {
	const now = Date.parse("2026-09-24T22:00:00Z");
	const item = task("Merge current main", 600, { status: "in_progress", owner: "Main" });
	item.schedule!.startedAt = now - 4 * 60_000;
	item.schedule!.reestimateCount = 5;
	const plan = forecastTodoPlan(phases(item), { now, deadlineAt: now - 9 * 60_000 });
	const lines = [formatPlanForecastDisplay(plan, now), formatTaskForecastDisplay(plan.rows[0]!, now, true)];
	expect(lines[0]).toStartWith("ETA ");
	expect(lines[0]).toContain("overdue 0h9m");
	expect(lines[1]).toContain(" · 4m / 10m · critical · reestimated 5×");
	expect(lines[1]).not.toContain("owner Main");
	for (const line of lines) expect(line).not.toMatch(/fixed-path|P95|CPM|ETA ETA|confidence|critical no/i);
});

describe("todo schedule forecast", () => {
	it("keeps ETA fixed across observations and moves only reestimated dependent work", () => {
		const input = phases(task("parse", 60), task("publish", 30, { dependencies: ["parse"] }), task("neighbor", 120));
		const before = forecastTodoPlan(input, { now: NOW });
		const later = forecastTodoPlan(input, { now: NOW + 100_000 });
		expect(later.rows.map(row => [row.earliestStart, row.earliestFinish, row.resourceFinish])).toEqual(
			before.rows.map(row => [row.earliestStart, row.earliestFinish, row.resourceFinish]),
		);
		expect(later.rows.map(row => row.overdue)).toEqual([true, true, false]);
		input[0].tasks[0].schedule!.progress = { at: NOW + 100_000, evidence: "Parser artifact changed" };
		expect(forecastTodoPlan(input, { now: NOW + 100_000 }).resourceFinish).toBe(before.resourceFinish);
		input[0].tasks[0].schedule!.estimate!.updatedAt = NOW + 100_000;
		const revised = forecastTodoPlan(input, { now: NOW + 100_000 });
		expect(revised.rows.map(row => row.resourceFinish)).toEqual([NOW + 160_000, NOW + 190_000, NOW + 120_000]);
	});

	it("uses PERT expected duration for CPM forward/backward passes and resource ETA", () => {
		const plan = forecastTodoPlan(phases(task("asymmetric", 10, { optimisticSeconds: 2, pessimisticSeconds: 26 })), {
			now: NOW,
			deadlineAt: NOW + 20_000,
		});
		const [row] = plan.rows;

		expect([row.earliestStart, row.earliestFinish, row.latestStart, row.latestFinish]).toEqual([
			NOW,
			NOW + 68_000 / 6,
			NOW + 20_000 - 68_000 / 6,
			NOW + 20_000,
		]);
		expect(row.expectedResourceFinish).toBe(NOW + 68_000 / 6);
		expect(row.estimateMeanSeconds).toBe(68 / 6);
		expect(row.fixedPathExpectedSeconds).toBe(68 / 6);
		expect(row.fixedPathSigmaSeconds).toBe(4);
		expect(row.fixedPathP95Finish).toBeCloseTo(NOW + (68 / 6 + 1.6448536269514722 * 4) * 1_000, 6);
		expect(row.range).toEqual({ earliest: NOW + 2_000, latest: NOW + 26_000 });
	});

	it("sums independent task variances along the fixed critical chain", () => {
		const plan = forecastTodoPlan(
			phases(
				task("chain-a", 5, { optimisticSeconds: 2, pessimisticSeconds: 8 }),
				task("chain-b", 6, {
					dependencies: ["chain-a"],
					optimisticSeconds: 3,
					pessimisticSeconds: 15,
				}),
				task("chain-c", 4, {
					dependencies: ["chain-b"],
					optimisticSeconds: 1,
					pessimisticSeconds: 7,
				}),
			),
			{ now: NOW },
		);
		const last = plan.rows[2];

		expect(last.fixedPath).toEqual(["chain-a", "chain-b", "chain-c"]);
		expect(last.fixedPathExpectedSeconds).toBe(16);
		expect(last.fixedPathSigmaSeconds).toBeCloseTo(Math.sqrt(6), 10);
		expect(last.fixedPathSigmaSeconds).not.toBe(4);
		expect(last.fixedPathP95Finish).toBeCloseTo(NOW + (16 + 1.6448536269514722 * Math.sqrt(6)) * 1_000, 6);
		expect(plan.rows.map(row => row.totalFloatSeconds)).toEqual([0, 0, 0]);
		expect(plan.rows.map(row => row.critical)).toEqual([true, true, true]);
	});

	it("selects a mean-time path but reports the maximum row fixed-path P95 across a fork and merge", () => {
		const plan = forecastTodoPlan(
			phases(
				task("fork", 10),
				task("likely-path", 8, {
					dependencies: ["fork"],
					optimisticSeconds: 7,
					pessimisticSeconds: 9,
				}),
				task("volatile-path", 1, {
					dependencies: ["fork"],
					optimisticSeconds: 1,
					pessimisticSeconds: 37,
				}),
				task("merge", 2, { dependencies: ["likely-path", "volatile-path"] }),
			),
			{ now: NOW },
		);
		const likely = plan.rows.find(row => row.content === "likely-path")!;
		const volatile = plan.rows.find(row => row.content === "volatile-path")!;
		const merge = plan.rows.find(row => row.content === "merge")!;
		const maxRowP95 = Math.max(...plan.rows.map(row => row.fixedPathP95Finish ?? Number.NEGATIVE_INFINITY));

		expect(likely.fixedPath).toEqual(["fork", "likely-path"]);
		expect(likely.fixedPathExpectedSeconds).toBe(18);
		expect(likely.fixedPathSigmaSeconds).toBeCloseTo(1 / 3, 10);
		expect(volatile.fixedPath).toEqual(["fork", "volatile-path"]);
		expect(volatile.fixedPathSigmaSeconds).toBe(6);
		expect(volatile.totalFloatSeconds).toBe(1);
		expect(volatile.critical).toBe(false);
		expect(volatile.fixedPathP95Finish).toBeCloseTo(NOW + (17 + 1.6448536269514722 * 6) * 1_000, 6);
		expect(merge.fixedPath).toEqual(["fork", "likely-path", "merge"]);
		expect(merge.fixedPathExpectedSeconds).toBe(20);
		expect(merge.fixedPathSigmaSeconds).toBeCloseTo(1 / 3, 10);
		expect(merge.fixedPathP95Finish).toBeCloseTo(NOW + (20 + 1.6448536269514722 / 3) * 1_000, 6);
		if (merge.fixedPathP95Finish === undefined || volatile.fixedPathP95Finish === undefined) {
			throw new Error("Expected fixed-path P95 finishes");
		}
		expect(volatile.fixedPathP95Finish).toBeGreaterThan(merge.fixedPathP95Finish);
		expect(maxRowP95).toBe(volatile.fixedPathP95Finish);
		expect(plan.fixedPathP95Finish).toBe(maxRowP95);
		expect(plan.resourceFinish).toBe(maxRowP95);
	});

	it("resolves a tie between equal parallel predecessors to the one with the larger P95", () => {
		// Live 2026-09-25: equal-duration browser shards before a join marked the join and everything
		// after it "tied or unavailable", so the whole plan read (partial) with every estimate present.
		const plan = forecastTodoPlan(
			phases(
				task("build", 10),
				task("shard-a", 5, { dependencies: ["build"], optimisticSeconds: 4, pessimisticSeconds: 6 }),
				task("shard-b", 5, { dependencies: ["build"], optimisticSeconds: 2, pessimisticSeconds: 8 }),
				task("join", 2, { dependencies: ["shard-a", "shard-b"] }),
				task("release", 1, { dependencies: ["join"] }),
			),
			{ now: NOW },
		);
		const join = plan.rows.find(row => row.content === "join")!;
		const release = plan.rows.find(row => row.content === "release")!;
		expect(plan.rows.flatMap(row => row.issues ?? []).join("\n")).not.toContain("tied or unavailable");
		expect(join.fixedPath).toEqual(["build", "shard-b", "join"]);
		expect(join.fixedPathSigmaSeconds).toBe(1);
		expect(release.fixedPath).toEqual(["build", "shard-b", "join", "release"]);
		expect(plan.fixedPathP95Finish).toBeCloseTo(NOW + (18 + 1.6448536269514722) * 1_000, 6);
	});

	it("uses recorded start and completion times without inventing observation-time completion", () => {
		const running = task("running", 60, { status: "in_progress" });
		running.schedule!.startedAt = NOW + 30_000;
		const completed = task("finished", 20, { status: "completed" });
		completed.schedule!.finishedAt = NOW - 10_000;
		const input = phases(running, completed, { content: "legacy closed", status: "completed" });
		const plan = forecastTodoPlan(input, { now: NOW + 200_000 });
		expect(plan.rows.map(row => row.resourceFinish)).toEqual([NOW + 90_000, NOW - 10_000, undefined]);
		expect(plan.rows.map(row => row.overdue)).toEqual([true, false, false]);
		expect(plan.rows[2].finishedAt).toBeUndefined();
		expect(plan.rows[2].status).toBe("completed");
		expect([plan.rows[2].resourceFinish, plan.rows[2].expectedResourceFinish]).toEqual([undefined, undefined]);
	});

	it("computes CPM dates and float for a diamond dependency graph", () => {
		const plan = forecastTodoPlan(
			phases(
				task("A", 2),
				task("B", 3, { dependencies: ["A"] }),
				task("C", 2, { dependencies: ["A"] }),
				task("D", 4, { dependencies: ["B", "C"] }),
			),
			{ now: NOW, deadlineAt: NOW + 9_000 },
		);
		const [a, b, c, d] = plan.rows;

		expect([a.earliestStart, a.earliestFinish, a.latestStart, a.latestFinish]).toEqual([
			NOW,
			NOW + 2_000,
			NOW,
			NOW + 2_000,
		]);
		expect([b.earliestStart, b.earliestFinish, b.latestStart, b.latestFinish]).toEqual([
			NOW + 2_000,
			NOW + 5_000,
			NOW + 2_000,
			NOW + 5_000,
		]);
		expect([c.earliestStart, c.earliestFinish, c.latestStart, c.latestFinish]).toEqual([
			NOW + 2_000,
			NOW + 4_000,
			NOW + 3_000,
			NOW + 5_000,
		]);
		expect([d.earliestStart, d.earliestFinish, d.latestStart, d.latestFinish]).toEqual([
			NOW + 5_000,
			NOW + 9_000,
			NOW + 5_000,
			NOW + 9_000,
		]);
		expect([a.totalFloatSeconds, b.totalFloatSeconds, c.totalFloatSeconds, d.totalFloatSeconds]).toEqual([
			0, 0, 1, 0,
		]);
		expect([a.freeFloatSeconds, b.freeFloatSeconds, c.freeFloatSeconds, d.freeFloatSeconds]).toEqual([0, 0, 1, 0]);
		expect([a.critical, b.critical, c.critical, d.critical]).toEqual([true, true, false, true]);
		expect(plan.earliestFinish).toBe(NOW + 9_000);
	});

	it("retains negative CPM float and exposes a past deadline", () => {
		const plan = forecastTodoPlan(phases(task("late", 2)), { now: NOW, deadlineAt: NOW - 1_000 });
		const [row] = plan.rows;

		expect(row.totalFloatSeconds).toBe(-3);
		expect(row.latestStart).toBe(NOW - 3_000);
		expect(row.critical).toBe(true);
		expect(plan.deadlineMissed).toBe(true);
		expect(plan.deadlineStatus).toBe("overdue");
		expect(formatTaskForecast(row, NOW)).toContain("critical: yes");
	});

	it("serializes owners and resources with their controlling predecessor path", () => {
		const uncertain = { optimisticSeconds: 0, pessimisticSeconds: 180 };
		const plan = forecastTodoPlan(
			phases(
				task("owner-1", 75, { owner: "worker", ...uncertain }),
				task("owner-2", 75, { owner: "worker", ...uncertain }),
				task("resource-1", 75, { owner: "worker-c", resources: ["repo"], ...uncertain }),
				task("resource-2", 75, { owner: "worker-d", resources: ["repo"], ...uncertain }),
				task("free-1", 2, { owner: "worker-e", resources: [] }),
				task("free-2", 2, { owner: "worker-f", resources: [] }),
			),
			{ now: NOW, capacity: 20 },
		);
		const [owner1, owner2, resource1, resource2, free1, free2] = plan.rows;
		const serializedP95 = NOW + (160 + 1.6448536269514722 * 30 * Math.sqrt(2)) * 1_000;

		expect([owner1.resourceStart, owner2.resourceStart]).toEqual([NOW, NOW + 80_000]);
		expect([resource1.resourceStart, resource2.resourceStart]).toEqual([NOW, NOW + 80_000]);
		expect([owner2.expectedResourceFinish, resource2.expectedResourceFinish]).toEqual([NOW + 160_000, NOW + 160_000]);
		expect(owner2.fixedPath).toEqual(["owner-1", "owner-2"]);
		expect(owner2.fixedPathExpectedSeconds).toBe(160);
		expect(owner2.fixedPathSigmaSeconds).toBeCloseTo(30 * Math.sqrt(2), 10);
		expect(resource2.fixedPath).toEqual(["resource-1", "resource-2"]);
		expect(resource2.fixedPathExpectedSeconds).toBe(160);
		expect(resource2.fixedPathSigmaSeconds).toBeCloseTo(30 * Math.sqrt(2), 10);
		expect(owner2.resourceFinish).toBeCloseTo(serializedP95, 6);
		expect(resource2.resourceFinish).toBeCloseTo(serializedP95, 6);
		expect(plan.resourceFinish).toBeCloseTo(serializedP95, 6);
		expect([free1.resourceStart, free2.resourceStart]).toEqual([NOW, NOW]);
	});

	it("keeps cycle and unknown rows unresolved without erasing a disconnected known row", () => {
		const unknown: TodoScheduleInputTask = {
			content: "unknown metadata",
			status: "pending",
			schedule: { estimate: task("placeholder", 8).schedule!.estimate },
		};
		const plan = forecastTodoPlan(
			phases(
				task("cycle-a", 2, { dependencies: ["cycle-b"] }),
				task("cycle-b", 3, { dependencies: ["cycle-a"] }),
				task("downstream", 1, { dependencies: ["cycle-a"] }),
				unknown,
				task("independent", 3),
			),
			{ now: NOW },
		);
		const byName = new Map(plan.rows.map(row => [row.content, row]));

		expect(byName.get("cycle-a")?.confidence).toBe("unknown");
		expect(byName.get("cycle-b")?.issues.join(" ")).toContain("dependency cycle");
		expect(byName.get("downstream")?.confidence).toBe("unknown");
		expect(byName.get("unknown metadata")?.confidence).toBe("unknown");
		expect(byName.get("cycle-a")?.fixedPathP95Finish).toBeUndefined();
		expect(byName.get("cycle-b")?.fixedPathP95Finish).toBeUndefined();
		expect(byName.get("downstream")?.fixedPathP95Finish).toBeUndefined();
		expect(byName.get("independent")?.fixedPath).toEqual(["independent"]);
		expect(plan.fixedPathP95Finish).toBeUndefined();
		expect(byName.get("independent")?.earliestFinish).toBe(NOW + 3_000);
		expect(byName.get("independent")?.resourceFinish).toBe(NOW + 3_000);
		expect(byName.get("independent")?.criticalityKnown).toBe(true);
		expect(plan.earliestFinish).toBeUndefined();
		expect(plan.resourceFinish).toBeUndefined();
		expect(plan.range).toBeUndefined();
	});

	it("uses the original update/progress clock for staleness without counting elapsed time as work", () => {
		const now = 1_000_000;
		const updatedAt = now - 6 * 60_000;
		const input = phases(task("stale", 60, { updatedAt }));
		const plan = forecastTodoPlan(input, { now });
		const [row] = plan.rows;

		expect(row.stale).toBe(true);
		expect(row.estimateUpdatedAt).toBe(updatedAt);
		expect(input[0].tasks[0].schedule?.estimate?.updatedAt).toBe(updatedAt);
		expect(row.resourceFinish).toBe(updatedAt + 60_000);
		expect(row.overdue).toBe(true);
		expect(row.confidence).toBe("low");
		expect(formatTaskForecast(row, now, true)).toContain(
			`stale estimate (updated: ${new Date(updatedAt).toISOString()})`,
		);
	});
	it("ages estimates only after recorded dependency and resource eligibility", () => {
		const now = 1_000_000;
		const agedAt = now - 24 * 60 * 60_000;
		const waiting = phases(
			task("capture", 3_600, { status: "in_progress", updatedAt: agedAt }),
			task("preview", 60, { dependencies: ["capture"], updatedAt: agedAt }),
		);
		waiting[0].tasks[0].schedule!.startedAt = now - 60_000;
		const waitingRows = forecastTodoPlan(waiting, { now }).rows;
		expect(waitingRows[1].ready).toBe(false);
		expect(waitingRows[1].resourceStart).toBeGreaterThan(now);
		expect(waitingRows[1].stale).toBe(false);
		const resourceWait = phases(
			task("resource holder", 3_600, { owner: "shared", status: "in_progress", updatedAt: agedAt }),
			task("resource waiting", 60, { owner: "shared", updatedAt: now - 6 * 60_000 }),
		);
		resourceWait[0].tasks[0].schedule!.startedAt = now - 10 * 60_000;
		const waitingForResource = forecastTodoPlan(resourceWait, { now }).rows[1];
		expect(waitingForResource.ready).toBe(true);
		expect(waitingForResource.resourceStart).toBeGreaterThan(now);
		expect(waitingForResource.stale).toBe(false);
		expect(forecastTodoPlan(resourceWait, { now: now + 3_900_000 }).rows[1].stale).toBe(true);

		const blocked = phases(task("approval", 60, { status: "blocked", updatedAt: now + 1 }));
		const blockedRow = forecastTodoPlan(blocked, { now }).rows[0];
		expect(blockedRow.stale).toBe(false);
		expect(blockedRow.issues).toContain("Estimate timestamp is later than forecast as-of time: approval");

		const releasedAt = now - 2 * 60_000;
		const released = phases(
			task("capture", 60, { status: "completed", updatedAt: agedAt }),
			task("preview", 60, { dependencies: ["capture"], updatedAt: agedAt }),
		);
		released[0].tasks[0].schedule!.finishedAt = releasedAt;
		const first = forecastTodoPlan(released, { now }).rows[1];
		const redrawn = forecastTodoPlan(released, { now }).rows[1];
		expect(first.ready).toBe(true);
		expect(first.stale).toBe(false);
		expect(redrawn.stale).toBe(false);
		expect(forecastTodoPlan(released, { now: releasedAt + 6 * 60_000 }).rows[1].stale).toBe(true);

		const independent = forecastTodoPlan(phases(task("independent", 60, { updatedAt: now - 6 * 60_000 })), { now });
		expect(independent.rows[0].stale).toBe(true);
	});

	it("honors concurrency above twenty, unlimited capacity, and serial capacity", () => {
		const input = phases(...Array.from({ length: 21 }, (_, index) => task(`independent-${index}`, 1)));
		const capacity32 = forecastTodoPlan(input, { now: NOW, capacity: 32 });
		const unlimited = forecastTodoPlan(input, { now: NOW, capacity: 0 });
		const serial = forecastTodoPlan(input, { now: NOW, capacity: 1 });

		expect(capacity32.rows.every(row => row.resourceStart === NOW)).toBe(true);
		expect(unlimited.rows.every(row => row.resourceStart === NOW)).toBe(true);
		expect([capacity32.earliestFinish, unlimited.earliestFinish, serial.earliestFinish]).toEqual([
			NOW + 1_000,
			NOW + 1_000,
			NOW + 1_000,
		]);
		expect([
			capacity32.expectedResourceFinish,
			unlimited.expectedResourceFinish,
			serial.expectedResourceFinish,
		]).toEqual([NOW + 1_000, NOW + 1_000, NOW + 21_000]);
		expect(capacity32.rows.filter(row => row.expectedResourceFinish === NOW + 1_000)).toHaveLength(21);
		expect(unlimited.rows.filter(row => row.expectedResourceFinish === NOW + 1_000)).toHaveLength(21);
		expect(serial.rows.map(row => row.expectedResourceFinish)).toEqual(
			Array.from({ length: 21 }, (_, index) => NOW + (index + 1) * 1_000),
		);
		expect(serial.rows.map(row => row.resourceStart)).toEqual(
			Array.from({ length: 21 }, (_, index) => NOW + index * 1_000),
		);
		expect([capacity32.resourceFinish, unlimited.resourceFinish, serial.resourceFinish]).toEqual([
			NOW + 1_000,
			NOW + 1_000,
			NOW + 21_000,
		]);
	});

	it("rejects missing, self, duplicate, cyclic, and abandoned prerequisite references", () => {
		const issues = validateTodoDependencies(
			phases(
				task("missing", 1, { dependencies: ["absent"] }),
				task("self", 1, { dependencies: ["self"] }),
				task("cycle-x", 1, { dependencies: ["cycle-y"] }),
				task("cycle-y", 1, { dependencies: ["cycle-x"] }),
				task("duplicate", 1),
				task("duplicate", 1),
				task("ambiguous", 1, { dependencies: ["duplicate"] }),
				{ content: "abandoned", status: "abandoned" },
				task("artifact", 1, { dependencies: ["abandoned"] }),
			),
		);
		const codes = new Set(issues.map(issue => issue.code));

		expect(codes).toContain("missing-dependency");
		expect(codes).toContain("self-dependency");
		expect(codes).toContain("duplicate-task");
		expect(codes).toContain("ambiguous-dependency");
		expect(codes).toContain("dependency-cycle");
		expect(codes).toContain("abandoned-dependency");
	});
	it("uses the project-wide natural finish for disconnected CPM paths", () => {
		const plan = forecastTodoPlan(phases(task("short", 30), task("long", 90)), { now: NOW });
		const [short, long] = plan.rows;

		expect(short.totalFloatSeconds).toBe(60);
		expect(short.critical).toBe(false);
		expect(long.totalFloatSeconds).toBe(0);
		expect(long.critical).toBe(true);
	});

	it("does not label a partial known finish on-track while required work is unknown", () => {
		const unknown: TodoScheduleInputTask = {
			content: "unknown row",
			status: "pending",
			schedule: { dependencies: [], owner: "worker", resources: [] },
		};
		const input = phases(task("known task", 30), unknown, task("blocked work", 15, { status: "blocked" }));
		const generous = forecastTodoPlan(input, { now: NOW, deadlineAt: NOW + 60_000 });
		const tight = forecastTodoPlan(input, { now: NOW, deadlineAt: NOW + 20_000 });

		expect(generous.resourceFinish).toBeUndefined();
		expect(generous.earliestFinish).toBeUndefined();
		expect(generous.knownWorkFinish).toBe(NOW + 30_000);
		expect(generous.unresolvedCount).toBe(2);
		expect(generous.deadlineStatus).toBe("unknown");
		expect(tight.deadlineStatus).toBe("at-risk");
		expect(generous.rows[1].estimateRequired).toBe(true);
		expect(generous.rows[2].estimateRequired).toBe(false);
		expect(generous.rows[1].resourceFinish).toBeUndefined();
	});

	it("reports malformed schedule metadata without crashing or erasing a healthy neighbor", () => {
		const badResources = task("bad resources", 1);
		badResources.schedule!.resources = "not-an-array" as unknown as string[];
		const badOwner = task("bad owner", 1);
		badOwner.schedule!.owner = 7 as unknown as string;
		const badBasis = task("bad basis", 1);
		badBasis.schedule!.estimate!.basis = 7 as unknown as string;
		const plan = forecastTodoPlan(phases(badResources, badOwner, badBasis, task("healthy", 1)), { now: NOW });
		const byName = new Map(plan.rows.map(row => [row.content, row]));

		expect(byName.get("bad resources")?.confidence).toBe("unknown");
		expect(byName.get("bad resources")?.issues.join(" ")).toContain("Resources must be a list");
		expect(byName.get("bad owner")?.confidence).toBe("unknown");
		expect(byName.get("bad basis")?.confidence).toBe("unknown");
		expect(byName.get("healthy")?.earliestFinish).toBe(NOW + 1_000);
		expect(byName.get("healthy")?.resourceStart).toBe(NOW);
		expect(plan.earliestFinish).toBeUndefined();
		expect(plan.resourceFinish).toBeUndefined();
	});

	// The blocker form `waits for user: <question> proposal: <answer and why>` marks a row only the
	// user can unblock. The host HUD renders it as `waits for you: … · proposal: …` instead of the
	// ordinary `needs unblock: …`. Extensions render through this same module.
	it("parses a user-wait blocker into question and proposal, and leaves an ordinary blocker alone", () => {
		expect(parseUserWait(undefined)).toBeUndefined();
		expect(parseUserWait("waiting on infra ticket")).toBeUndefined();
		expect(parseUserWait("waits for user: ship on Friday? proposal: yes, ship Friday; fix is verified.")).toEqual({
			question: "ship on Friday?",
			proposal: "yes, ship Friday; fix is verified.",
		});
		expect(parseUserWait("waits for the user: pick a vendor")).toEqual({ question: "pick a vendor" });
	});

	it("renders a user-wait blocker as 'waits for you', not 'needs unblock'", () => {
		const release = task("release", 60, { status: "blocked" });
		release.blocker = "waits for user: ship on Friday? proposal: yes, ship Friday; fix is verified.";
		const row = forecastTodoPlan(phases(release), { now: NOW }).rows[0]!;

		expect(row.waitsForUser).toEqual({
			question: "ship on Friday?",
			proposal: "yes, ship Friday; fix is verified.",
		});
		const compact = formatTaskForecast(row, NOW);
		const expanded = formatTaskForecastDisplay(row, NOW, true);
		expect(compact).toContain("waits for you: ship on Friday? · proposal: yes, ship Friday; fix is verified.");
		expect(compact).not.toContain("needs unblock");
		expect(expanded).toContain("waits for you: ship on Friday? · proposal: yes, ship Friday; fix is verified.");
		expect(expanded).not.toContain("needs unblock");
	});

	it("renders a user-wait blocker without a proposal as 'no proposal yet', still not 'needs unblock'", () => {
		const procure = task("procure", 60, { status: "blocked" });
		procure.blocker = "waits for user: pick a vendor";
		const row = forecastTodoPlan(phases(procure), { now: NOW }).rows[0]!;

		expect(formatTaskForecast(row, NOW)).toContain("waits for you: pick a vendor · no proposal yet");
		expect(formatTaskForecast(row, NOW)).not.toContain("needs unblock");
	});

	it("keeps an ordinary blocked reason as 'needs unblock' when it is not a user wait", () => {
		const deploy = task("deploy", 60, { status: "blocked" });
		deploy.blocker = "waiting on infra ticket";
		const row = forecastTodoPlan(phases(deploy), { now: NOW }).rows[0]!;
		expect(row.waitsForUser).toBeUndefined();
		expect(formatTaskForecast(row, NOW)).toContain("needs unblock: waiting on infra ticket");
		expect(formatTaskForecastDisplay(row, NOW, true)).toContain("needs unblock: waiting on infra ticket");
	});

	it("renders 'on proposal' for a row that proceeds on a parked user-wait proposal", () => {
		const plan = forecastTodoPlan(phases(task("draft doc", 60)), { now: NOW });
		const row = { ...plan.rows[0]!, onProposal: ["pick a vendor"] };
		expect(formatTaskForecast(row, NOW)).toContain("on proposal: pick a vendor");
		expect(formatTaskForecastDisplay(row, NOW)).toContain("on proposal");
	});
});
