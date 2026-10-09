import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGoalDeadline, readGoalFocusAuthority, STATE_ENTRY } from "../../src/goals/deadlines";

const roots: string[] = [];
const nativeGoal = { id: "native-box", objective: "box-model task", createdAt: 1_790_000_000_000, status: "active" };
const pluginGoal = { id: "plugin-pr", objective: "upstream PR", createdAt: 1_790_000_000_000, status: "paused" };

function cwdWithGoals(): string {
	const cwd = mkdtempSync(join(tmpdir(), "goal-focus-authority-"));
	roots.push(cwd);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi/.goals-pool-snapshot.json"), JSON.stringify({ goals: [nativeGoal, pluginGoal] }));
	return cwd;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readGoalFocusAuthority", () => {
	it("keeps an explicit native choice authoritative over newer passive plugin snapshots", () => {
		const authority = readGoalFocusAuthority(
			[
				{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "plugin-pr" } },
				{ type: "mode_change", mode: "goal", data: { goal: nativeGoal } },
				{ type: "custom", customType: "pi-goal-state", data: { goal: pluginGoal } },
				{ type: "message", message: { toolName: "update_goal", details: { goal: pluginGoal } } },
			],
			cwdWithGoals(),
		);
		expect(authority).toEqual({
			owner: "native",
			goal: { id: "native-box", createdAt: 1_790_000_000, status: "active" },
			explicit: true,
		});
	});

	it("allows a later explicit plugin focus, while native none masks an older plugin focus", () => {
		const cwd = cwdWithGoals();
		const pluginSelected = readGoalFocusAuthority(
			[
				{ type: "mode_change", mode: "goal", data: { goal: nativeGoal } },
				{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "plugin-pr" } },
			],
			cwd,
		);
		const nativeCleared = readGoalFocusAuthority(
			[
				{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "plugin-pr" } },
				{ type: "mode_change", mode: "none" },
			],
			cwd,
		);
		expect(pluginSelected).toEqual({
			owner: "plugin",
			goal: { id: "plugin-pr", createdAt: 1_790_000_000, status: "paused" },
			explicit: true,
		});
		expect(nativeCleared).toEqual({ owner: "native", goal: null, explicit: true });
	});

	it("does not adopt a shared-catalog goal without branch focus and retains legacy plugin-only state", () => {
		const cwd = cwdWithGoals();
		expect(readGoalFocusAuthority([], cwd)).toEqual({ owner: null, goal: null, explicit: false });
		expect(
			readGoalFocusAuthority([{ type: "custom", customType: "pi-goal-state", data: { goal: pluginGoal } }], cwd),
		).toEqual({
			owner: "plugin",
			goal: { id: "plugin-pr", createdAt: 1_790_000_000, status: "paused" },
			explicit: false,
		});
	});
	it("reads a valid 2026 deadline as Unix seconds and returns milliseconds", () => {
		const timestamp = 1_790_236_800;
		const result = readGoalDeadline(
			[
				{ type: "mode_change", mode: "goal", data: { goal: nativeGoal } },
				{
					type: "custom",
					customType: STATE_ENTRY,
					data: {
						version: 1,
						goalId: nativeGoal.id,
						goalStartedAt: 1_790_000_000,
						timezone: "Asia/Tbilisi",
						active: true,
						stages: [{ id: "ship", label: "Ship", expectedResult: "Shipped", deadlineAt: timestamp }],
						baselineDeadlineAt: timestamp,
					},
				},
			],
			cwdWithGoals(),
		);
		expect(result).toEqual({ goalId: nativeGoal.id, deadlineAt: timestamp * 1_000 });
	});
	it("fails closed for a persisted millisecond deadline instead of forecasting a distant future", () => {
		const entries = [
			{ type: "mode_change", mode: "goal", data: { goal: nativeGoal } },
			{
				type: "custom",
				customType: STATE_ENTRY,
				data: {
					version: 1,
					goalId: nativeGoal.id,
					goalStartedAt: 1_790_000_000,
					timezone: "Asia/Tbilisi",
					active: true,
					stages: [{ id: "ship", label: "Ship", expectedResult: "Shipped", deadlineAt: 1_790_236_800_000 }],
					baselineDeadlineAt: 1_790_236_800_000,
				},
			},
		];
		expect(readGoalDeadline(entries, cwdWithGoals())).toBeUndefined();
	});
});
