// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import goalDeadlines, {
	derivePresence,
	REMINDER_MAX_CHARS,
	remainingPercent,
	renderDeadlineReminder,
	renderDeadlineUi,
	renderPresence,
} from "./goal_deadlines";
import {
	goalRef,
	readFocusedGoal,
	rehydrateActiveGoal,
	rehydrateDeadlineState,
	readGoalDeadline,
	resolveFocusedGoal,
	STATE_ENTRY,
	type DeadlineState,
} from "./deadlines";

const state: DeadlineState = {
	version: 1,
	goalId: "goal-1",
	goalStartedAt: 1_000,
	timezone: "Asia/Tbilisi",
	active: true,
	stages: [
		{ id: "draft", label: "Draft", expectedResult: "Usable draft", deadlineAt: 1_600 },
		{ id: "final", label: "Final", expectedResult: "Verified delivery", deadlineAt: 2_200 },
	],
};

describe("goal deadline reminders", () => {
	test("reports relative stage and final deadline progress", () => {
		const reminder = renderDeadlineReminder(state, 1_300);
		expect(reminder).toContain("Next=Draft");
		expect(reminder).toContain("0h05m (50%)");
		expect(reminder).toContain("Final=");
		expect(reminder).toContain("0h15m (75%)");
	});

	test("overdue work names missing artifact and continues", () => {
		const reminder = renderDeadlineReminder(state, 1_700);
		expect(reminder).toContain("overdue 0h01m (0%)");
		expect(reminder).toContain("Latest artifact=none recorded");
	});

	test("paused or exhausted schedules inject nothing", () => {
		expect(renderDeadlineReminder({ ...state, active: false }, 1_300)).toBeNull();
		expect(
			renderDeadlineReminder(
				{ ...state, stages: state.stages.map(stage => ({ ...stage, deliveredAt: 1_250 })) },
				1_300,
			),
		).toBeNull();
	});

	test("rehydrates latest durable session state after compaction", () => {
		const newer = { ...state, timezone: "UTC" };
		expect(
			rehydrateDeadlineState([
				{ type: "custom", customType: STATE_ENTRY, data: state },
				{ type: "compaction", summary: "bounded" },
				{ type: "custom", customType: STATE_ENTRY, data: newer },
			]),
		).toEqual(newer);
	});

	test("binds to the latest focused goal state", () => {
		expect(
			rehydrateActiveGoal([
				{
					type: "message",
					message: { details: { goal: { id: "older", createdAt: "2026-09-22T04:00:00Z", status: "active" } } },
				},
				{
					type: "custom",
					customType: "pi-goal-state",
					data: { goal: { id: "focused", createdAt: "2026-09-22T05:00:00Z", status: "active" } },
				},
			]),
		).toEqual({ id: "focused", createdAt: 1_790_053_200, status: "active" });
	});

	test("resolves session focus from the persistent goal pool", () => {
		expect(
			resolveFocusedGoal(
				[{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "focused" } }],
				[
					{ id: "other", createdAt: "2026-09-22T04:00:00Z", status: "active" },
					{ id: "focused", createdAt: "2026-09-22T05:00:00Z", status: "active" },
				],
			),
		).toEqual({ id: "focused", createdAt: 1_790_053_200, status: "active" });
	});

	test("reads only a matching active schedule and returns milliseconds", () => {
		const goal = { id: "goal-1", createdAt: 1_000_000, status: "active" };
		const active = [
			{ type: "mode_change", mode: "goal", data: { goal } },
			{ type: "custom", customType: STATE_ENTRY, data: state },
		];
		expect(readGoalDeadline(active)).toEqual({ goalId: "goal-1", deadlineAt: 2_200_000 });
		expect(
			readGoalDeadline([
				{ type: "mode_change", mode: "goal", data: { goal: { ...goal, status: "paused" } } },
				active[1],
			]),
		).toBeUndefined();
		expect(
			readGoalDeadline([
				{ type: "mode_change", mode: "goal", data: { goal: { ...goal, status: "complete" } } },
				active[1],
			]),
		).toBeUndefined();
		expect(
			readGoalDeadline([
				active[0],
				{ type: "custom", customType: STATE_ENTRY, data: { ...state, goalId: "other" } },
			]),
		).toBeUndefined();
		expect(
			readGoalDeadline([active[0], { type: "custom", customType: STATE_ENTRY, data: { ...state, active: false } }]),
		).toBeUndefined();
		expect(
			readGoalDeadline([
				active[0],
				{
					type: "custom",
					customType: STATE_ENTRY,
					data: { ...state, stages: state.stages.map(stage => ({ ...stage, deliveredAt: 1_200 })) },
				},
			]),
		).toBeUndefined();
		expect(readGoalDeadline([...active, { type: "mode_change", mode: "none" }])).toBeUndefined();
	});

	test("paused deadlines are displayable without granting active goal authority", () => {
		const paused = [
			{
				type: "mode_change",
				mode: "goal_paused",
				data: { goal: { id: "goal-1", createdAt: 1_000_000, status: "paused" } },
			},
			{ type: "custom", customType: STATE_ENTRY, data: state },
		];
		expect(readGoalDeadline(paused)).toBeUndefined();
		expect(readFocusedGoal(paused)).toBeNull();
		expect(readGoalDeadline(paused, undefined, { includePaused: true })).toEqual({
			goalId: "goal-1",
			deadlineAt: 2_200_000,
			paused: true,
		});
		expect(
			readGoalDeadline([...paused, { type: "mode_change", mode: "none" }], undefined, { includePaused: true }),
		).toBeUndefined();
		expect(
			readGoalDeadline(
				[...paused, { type: "custom", customType: STATE_ENTRY, data: { ...state, active: false } }],
				undefined,
				{ includePaused: true },
			),
		).toBeUndefined();
	});

	test("uses pi-goal-x pool only for explicit focus and honors native terminal mode", () => {
		const cwd = mkdtempSync(join(tmpdir(), "omp-deadline-reader-"));
		try {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(
				join(cwd, ".pi/.goals-pool-snapshot.json"),
				JSON.stringify({ goals: [{ id: "goal-1", createdAt: "1970-01-01T00:16:40Z", status: "active" }] }),
			);
			const entries: unknown[] = [
				{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "goal-1" } },
				{ type: "custom", customType: STATE_ENTRY, data: state },
			];
			expect(readGoalDeadline(entries, cwd)).toEqual({ goalId: "goal-1", deadlineAt: 2_200_000 });
			entries.push({ type: "mode_change", mode: "none" });
			expect(readGoalDeadline(entries, cwd)).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("surfaces deadlines in persistent UI text", () => {
		const lines = renderDeadlineUi(state, 1_300);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Deadline · Draft");
		expect(lines[0]).toContain("0h05m (50%)");
		expect(lines[1]).toContain("Expected: Usable draft");
		// An open TODO plan prints the due time in its header: the footer must not repeat it.
		const withTodo = renderDeadlineUi(state, 1_300, true);
		expect(withTodo).toHaveLength(1);
		expect(withTodo[0]).toContain("Goal · Draft → Usable draft");
		expect(withTodo[0]).not.toContain("0h05m");
	});

	test("bounds reminder and never converts quota to tokens", () => {
		const reminder = renderDeadlineReminder(
			{ ...state, stages: [{ ...state.stages[0]!, expectedResult: "x".repeat(2_000) }] },
			1_300,
			{
				provider: "codex-lb",
				remainingPercent: 26,
				status: "at_risk",
				sourceAsOf: "2026-09-22T05:09:25Z",
				recoveryAt: null,
			},
		);
		expect(reminder!.length).toBeLessThanOrEqual(REMINDER_MAX_CHARS);
		expect(reminder).toContain("now=26%");
		expect(reminder).not.toMatch(/26\s*tokens/i);
	});

	test("invalid or expired deadline intervals do not fabricate percentages", () => {
		expect(remainingPercent(1_000, 1_000, 900)).toBeNull();
		expect(remainingPercent(1_000, 1_600, 1_700)).toBe(0);
	});
});

describe("automatic presence", () => {
	const userEntry = (timestamp: number) => ({
		type: "message",
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: "I am here", timestamp },
	});
	const presenceState = (deadlineAt: number): DeadlineState => ({
		...state,
		goalStartedAt: deadlineAt - 7_200,
		baselineDeadlineAt: deadlineAt,
	});

	test("derives away at the silence and quiet-hour boundaries", () => {
		const now = Date.UTC(2026, 8, 25, 19, 0); // 23:00 Asia/Tbilisi
		expect(derivePresence([userEntry(now - 30 * 60_000)], null, now)).toBe("away");
		expect(derivePresence([userEntry(now - 15 * 60_000)], null, now)).toBe("away");
		expect(derivePresence([userEntry(now - 14 * 60_000)], null, now)).toBe("watching");
	});

	test("derives watching during working hours", () => {
		const now = Date.UTC(2026, 8, 25, 8, 0); // 12:00 Asia/Tbilisi
		expect(derivePresence([userEntry(now - 15 * 60_000)], presenceState(Math.floor(now / 1_000) + 7_200), now)).toBe(
			"watching",
		);
	});

	test("derives firefighting for a recent weekend at-risk deadline", () => {
		const now = Date.UTC(2026, 8, 26, 8, 0); // Saturday 12:00 Asia/Tbilisi
		expect(
			derivePresence([userEntry(now - 15 * 60_000)], presenceState(Math.floor(now / 1_000) + 60 * 60), now),
		).toBe("firefighting");
	});

	test("shows the promised deadline when away", () => {
		const now = Date.UTC(2026, 8, 25, 8, 0);
		const message = renderPresence(
			[userEntry(now - 30 * 60_000)],
			presenceState(Math.floor(now / 1_000) + 7_200),
			now,
		);
		expect(message).toContain("Darafei is: away");
		expect(message).toContain("Promised before he left: done by 14:00.");
	});

	test("context appends one combined automatic presence message", () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const activeGoal = { id: "goal-1", createdAt: 1_000, status: "active" as const };
		goalDeadlines({
			pi: { readFocusedGoal: () => activeGoal, rehydrateDeadlineState: () => null, STATE_ENTRY },
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
			registerTool: () => {},
			appendEntry: () => {},
			zod: z,
		} as unknown as ExtensionAPI);
		const now = Date.now();
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			sessionManager: { getBranch: () => [userEntry(now - 60_000)] },
		} as unknown as ExtensionContext;
		const result = handlers.get("context")?.(
			{ messages: [{ role: "user", content: "I am here", timestamp: now - 60_000 }] },
			ctx,
		) as { messages: Array<{ role: string; content: string }> };
		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]?.role).toBe("developer");
		expect(result.messages[1]?.content).toContain("Darafei is: watching");
		expect(result.messages[1]?.content).toContain("No deadline schedule is recorded.");
	});
});

test("vetoes native and plugin goal completion until branch TODO work is closed", () => {
	let branch: unknown[] = [{ id: "native-branch" }];
	const reducerBranches: unknown[] = [];
	let phases = [
		{
			name: "Delivery",
			tasks: [
				{ content: "Repair export", status: "pending" },
				{ content: "Repair retrieval", status: "blocked" },
				{ content: "Retire unused flow", status: "abandoned" },
				{ content: "Run final review", status: "completed" },
			],
		},
	];
	const host: {
		getLatestTodoPhasesFromEntries?: (entries: unknown[]) => typeof phases;
	} = {
		getLatestTodoPhasesFromEntries: entries => {
			reducerBranches.push(entries);
			return phases;
		},
	};
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	goalDeadlines({
		pi: host,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		registerTool: () => {},
		appendEntry: () => {},
		zod: z,
	} as unknown as ExtensionAPI);
	const branchReads: unknown[] = [];
	const ctx = {
		sessionManager: {
			getBranch: () => {
				branchReads.push(branch);
				return branch;
			},
		},
	} as unknown as ExtensionContext;
	const toolCall = handlers.get("tool_call")!;
	const invoke = (toolName: string, input: Record<string, unknown>) => toolCall({ toolName, input }, ctx);

	const native = invoke("goal", { op: "complete" }) as { block?: boolean; reason?: string };
	expect(native.block).toBe(true);
	expect(native.reason).toContain("3 TODO tasks are unresolved");
	expect(native.reason).toContain("Repair export");
	expect(native.reason).toContain("Repair retrieval");
	expect(native.reason).toContain("1 abandoned");
	expect(reducerBranches[0]).toBe(branch);

	branch = [{ id: "plugin-branch" }];
	const plugin = invoke("update_goal", { status: "complete" }) as { block?: boolean; reason?: string };
	expect(plugin.block).toBe(true);
	expect(reducerBranches[1]).toBe(branch);

	phases = [
		{
			name: "Delivery",
			tasks: [
				{ content: "Repair export", status: "completed" },
				{ content: "Repair retrieval", status: "completed" },
			],
		},
	];
	expect(invoke("goal", { op: "complete" })).toBeUndefined();
	expect(invoke("update_goal", { status: "complete" })).toBeUndefined();
	expect(reducerBranches[2]).toBe(branch);
	expect(branchReads).toHaveLength(4);

	const callsBeforeUnrelated = branchReads.length;
	expect(invoke("goal", { op: "create" })).toBeUndefined();
	expect(invoke("update_goal", { status: "in_progress" })).toBeUndefined();
	expect(invoke("other_tool", { op: "complete" })).toBeUndefined();
	expect(branchReads).toHaveLength(callsBeforeUnrelated);

	host.getLatestTodoPhasesFromEntries = undefined;
	expect(invoke("goal", { op: "complete" })).toMatchObject({ block: true });
	expect(invoke("other_tool", { op: "complete" })).toBeUndefined();
	expect(branchReads).toHaveLength(callsBeforeUnrelated + 1);
});

test("native lifecycle preserves the original deadline without reviving stale goal focus", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "omp-deadline-"));
	try {
		const now = 1_790_200_000;
		const branch: unknown[] = [{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "stale" } }];
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi/.goals-pool-snapshot.json"),
			JSON.stringify({ goals: [{ id: "stale", createdAt: "2026-09-22T05:00:00Z", status: "active" }] }),
		);
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		let deadlineTool:
			| {
					execute: (
						...args: unknown[]
					) => Promise<{ content: Array<{ type: string; text: string }>; details: { state: DeadlineState } }>;
			  }
			| undefined;
		let goalState: GoalModeState | undefined;
		let status: string | undefined;
		goalDeadlines({
			pi: { goalRef, readFocusedGoal, rehydrateDeadlineState, STATE_ENTRY },
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
			registerTool: (tool: typeof deadlineTool) => {
				deadlineTool = tool;
			},
			appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
			zod: z,
			_goalCore: { state: { goal: { id: "stale", createdAt: "2026-09-22T05:00:00Z", status: "active" } } },
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				setStatus: (_key: string, value: string | undefined) => {
					status = value;
				},
				setWidget: () => {},
			},
			sessionManager: { getBranch: () => branch },
		} as unknown as ExtensionContext;
		const runtime = new GoalRuntime({
			getState: () => goalState,
			setState: value => {
				goalState = value;
			},
			getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
			now: () => now * 1000,
			persist: (mode, data) => {
				branch.push({ type: "mode_change", mode, data });
			},
			emit: async event => {
				await handlers.get(event.type)?.(event, ctx);
			},
			sendHiddenMessage: async () => {},
		});
		const request = async () =>
			(await handlers.get("context")?.({ messages: [] }, ctx)) as
				| { messages?: Array<{ role: string; content: string }> }
				| undefined;
		await runtime.createGoal({ objective: "Finish by the original deadline" });
		await expect(
			deadlineTool!.execute(
				"set",
				{
					action: "set",
					stages: [
						{ id: "ship", label: "Ship", expected_result: "Verified render", deadline_at: (now - 60) * 1_000 },
					],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/Unix seconds.*not milliseconds/);
		const schedule = await deadlineTool!.execute(
			"set",
			{
				action: "set",
				timezone: "Asia/Tbilisi",
				stages: [
					{ id: "ship", label: "Ship", expected_result: "Verified render", deadline_at: now - 60 },
					{ id: "draft", label: "Draft", expected_result: "Usable draft", deadline_at: now - 120 },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(schedule.details.state.goalId).toBe(goalState!.goal.id);
		expect(schedule.details.state.stages[0]?.deadlineAt).toBe(now - 60);
		expect(readGoalDeadline(branch, cwd)).toEqual({ goalId: goalState!.goal.id, deadlineAt: (now - 60) * 1000 });
		const corruptedDraft: DeadlineState = {
			...schedule.details.state,
			stages: schedule.details.state.stages.map(stage =>
				stage.id === "draft" ? { ...stage, deadlineAt: stage.deadlineAt * 1_000 } : stage,
			),
		};
		branch.push({ type: "custom", customType: STATE_ENTRY, data: corruptedDraft });
		handlers.get("session_start")?.({}, ctx);
		expect(await request()).toBeUndefined();
		const invalidStatus = await deadlineTool!.execute("status", { action: "status" }, undefined, undefined, ctx);
		expect(invalidStatus.content[0]?.text).toContain("forecast is unknown");
		const repaired = await deadlineTool!.execute(
			"set",
			{
				action: "set",
				stages: [
					{ id: "draft", label: "Draft corrected", expected_result: "Usable draft", deadline_at: now - 120 },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(repaired.details.state.stages.find(stage => stage.id === "draft")?.deadlineAt).toBe(now - 120);
		expect(repaired.details.state.stages.find(stage => stage.id === "ship")?.deadlineAt).toBe(now - 60);
		expect(repaired.details.state.baselineDeadlineAt).toBe(now - 60);
		expect(repaired.details.state.timezone).toBe("Asia/Tbilisi");
		const corruptedFinal: DeadlineState = {
			...repaired.details.state,
			stages: repaired.details.state.stages.map(stage =>
				stage.id === "ship" ? { ...stage, deadlineAt: stage.deadlineAt * 1_000 } : stage,
			),
			baselineDeadlineAt: (repaired.details.state.baselineDeadlineAt ?? 0) * 1_000,
		};
		branch.push({ type: "custom", customType: STATE_ENTRY, data: corruptedFinal });
		handlers.get("session_start")?.({}, ctx);
		const repairedFinal = await deadlineTool!.execute(
			"set",
			{
				action: "set",
				stages: [
					{ id: "ship", label: "Ship corrected", expected_result: "Verified render", deadline_at: now - 60 },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(repairedFinal.details.state.baselineDeadlineAt).toBe(now - 60);
		expect(repairedFinal.details.state.stages.find(stage => stage.id === "draft")?.deadlineAt).toBe(now - 120);
		await deadlineTool!.execute(
			"deliver",
			{ action: "deliver", stage_id: "draft", delivered_artifact: "Usable draft" },
			undefined,
			undefined,
			ctx,
		);
		await expect(
			deadlineTool!.execute(
				"set",
				{
					action: "set",
					stages: [{ id: "ship", label: "Ship", expected_result: "Verified render", deadline_at: now + 3_600 }],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("cannot change deadline for existing stage ship");
		const updated = await deadlineTool!.execute(
			"set",
			{
				action: "set",
				stages: [
					{ id: "ship", label: "Ship refined", expected_result: "Verified render", deadline_at: now - 60 },
					{ id: "draft", label: "Draft refined", expected_result: "Usable draft", deadline_at: now - 120 },
					{ id: "review", label: "Review", expected_result: "Review note", deadline_at: now - 90 },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(updated.details.state.baselineDeadlineAt).toBe(now - 60);
		expect(updated.details.state.stages.find(stage => stage.id === "draft")?.deliveredArtifact).toBe("Usable draft");
		expect(readGoalDeadline(branch, cwd)).toEqual({ goalId: goalState!.goal.id, deadlineAt: (now - 60) * 1000 });
		const due = new Date((now - 60) * 1000).toISOString();
		for (let step = 0; step < 2; step++) {
			const result = await request();
			expect(result?.messages?.at(-1)).toMatchObject({ role: "developer" });
			expect(result?.messages?.at(-1)?.content).toContain(due);
		}
		await runtime.pauseGoal();
		expect(status).toBeUndefined();
		expect(await request()).toBeUndefined();
		expect(readGoalDeadline(branch, cwd)).toBeUndefined();
		await runtime.resumeGoal();
		expect((await request())?.messages?.at(-1)?.content).toContain(due);
		expect(readGoalDeadline(branch, cwd)).toEqual({ goalId: goalState!.goal.id, deadlineAt: (now - 60) * 1000 });
		const cleared = await deadlineTool!.execute("clear", { action: "clear" }, undefined, undefined, ctx);
		expect(cleared.details.state.baselineDeadlineAt).toBeUndefined();
		expect(cleared.details.state.stages).toEqual([]);
		expect(await request()).toBeUndefined();
		expect(readGoalDeadline(branch, cwd)).toBeUndefined();
		handlers.get("session_start")?.({}, ctx);
		expect(await request()).toBeUndefined();
		const restored = await deadlineTool!.execute(
			"set",
			{
				action: "set",
				stages: [{ id: "ship", label: "Ship", expected_result: "Verified render", deadline_at: now - 60 }],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(restored.details.state.baselineDeadlineAt).toBe(now - 60);
		expect(readGoalDeadline(branch, cwd)).toEqual({ goalId: goalState!.goal.id, deadlineAt: (now - 60) * 1000 });
		await runtime.completeGoalFromTool();
		expect(await request()).toBeUndefined();
		await runtime.createGoal({ objective: "Different goal" });
		expect((await request())?.messages?.at(-1)?.content).not.toContain(due);
		await runtime.dropGoal();
		expect(status).toBeUndefined();
		branch.push({
			type: "message",
			message: {
				toolName: "goal_deadline",
				details: { goal: { id: "stale", createdAt: "2026-09-22T05:00:00Z", status: "active" } },
			},
		});
		expect(await request()).toBeUndefined();
		expect(readGoalDeadline(branch, cwd)).toBeUndefined();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("names deadline_at seconds and rejects implausible future seconds", async () => {
	let deadlineTool:
		| {
				description: string;
				parameters: z.ZodTypeAny;
				execute: (...args: unknown[]) => Promise<{ details: { state: DeadlineState | null } }>;
		  }
		| undefined;
	goalDeadlines({
		pi: {
			goalRef,
			readFocusedGoal: () => ({ id: "focused-goal", createdAt: 1_000, status: "active" }),
			rehydrateDeadlineState: () => null,
			STATE_ENTRY,
		},
		on: () => {},
		registerTool: (tool: typeof deadlineTool) => {
			deadlineTool = tool;
		},
		appendEntry: () => {},
		zod: z,
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: "/tmp",
		hasUI: false,
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;

	expect(deadlineTool!.description).toContain("deadline_at is a Unix timestamp in seconds, not milliseconds");
	const stageSchema = (
		deadlineTool!.parameters as z.ZodObject<{
			stages: z.ZodOptional<z.ZodArray<z.ZodObject<{ deadline_at: z.ZodTypeAny }>>>;
		}>
	).shape.stages.unwrap().element.shape;
	expect(stageSchema.deadline_at.description).toContain("Unix timestamp in seconds");
	await expect(
		deadlineTool!.execute(
			"set",
			{
				action: "set",
				stages: [{ id: "future", label: "Future", expected_result: "Rejected", deadline_at: 4_102_444_801 }],
			},
			undefined,
			undefined,
			ctx,
		),
	).rejects.toThrow(/Unix seconds.*no later than 2100-01-01T00:00:00Z/);
});

test("clear lets an explicit set replace a corrupted immutable final deadline", async () => {
	const branch: unknown[] = [];
	const corrupted: DeadlineState = {
		version: 1,
		goalId: "focused-goal",
		goalStartedAt: 1_000,
		timezone: "Asia/Tbilisi",
		active: true,
		stages: [{ id: "bad-final", label: "Bad final", expectedResult: "Wrong unit", deadlineAt: 1_790_236_800_000 }],
		baselineDeadlineAt: 1_790_236_800_000,
	};
	let deadlineTool:
		| { execute: (...args: unknown[]) => Promise<{ details: { state: DeadlineState | null } }> }
		| undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	goalDeadlines({
		pi: {
			goalRef,
			readFocusedGoal: () => ({ id: "focused-goal", createdAt: 1_000, status: "active" }),
			rehydrateDeadlineState,
			STATE_ENTRY,
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		registerTool: (tool: typeof deadlineTool) => {
			deadlineTool = tool;
		},
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		zod: z,
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: "/tmp",
		hasUI: false,
		sessionManager: { getBranch: () => [{ type: "custom", customType: STATE_ENTRY, data: corrupted }, ...branch] },
	} as unknown as ExtensionContext;
	handlers.get("session_start")?.({}, ctx);

	const cleared = await deadlineTool!.execute("clear", { action: "clear" }, undefined, undefined, ctx);
	expect(cleared.details.state?.stages).toEqual([]);
	expect(cleared.details.state?.baselineDeadlineAt).toBeUndefined();
	const replaced = await deadlineTool!.execute(
		"set",
		{
			action: "set",
			stages: [
				{ id: "correct-final", label: "Correct final", expected_result: "Corrected", deadline_at: 1_790_236_800 },
			],
		},
		undefined,
		undefined,
		ctx,
	);
	expect(replaced.details.state?.stages).toEqual([
		{ id: "correct-final", label: "Correct final", expectedResult: "Corrected", deadlineAt: 1_790_236_800 },
	]);
	expect(replaced.details.state?.active).toBe(true);
	expect(replaced.details.state?.baselineDeadlineAt).toBe(1_790_236_800);
});

test("requires explicit goal metadata when setting a deadline without focus", async () => {
	const invoke = async (
		focusedGoal: { id: string; createdAt: number; status: "active" } | null,
		metadata: { goal_id?: string; goal_started_at?: number; timezone?: string } = {},
	) => {
		let deadlineTool:
			| { execute: (...args: unknown[]) => Promise<{ details: { state: DeadlineState | null } }> }
			| undefined;
		goalDeadlines({
			pi: {
				goalRef,
				readFocusedGoal: () => focusedGoal,
				rehydrateDeadlineState: () => null,
				STATE_ENTRY,
			},
			on: () => {},
			registerTool: (tool: typeof deadlineTool) => {
				deadlineTool = tool;
			},
			appendEntry: () => {},
			zod: z,
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			sessionManager: { getBranch: () => [] },
		} as unknown as ExtensionContext;
		return deadlineTool!.execute(
			"set",
			{
				action: "set",
				...metadata,
				stages: [{ id: "deliver", label: "Deliver", expected_result: "Verified output", deadline_at: 2_000 }],
			},
			undefined,
			undefined,
			ctx,
		);
	};

	await expect(invoke(null)).rejects.toThrow(
		/no focused goal is available.*pass goal_id, goal_started_at, and timezone explicitly/,
	);
	await expect(invoke(null, { goal_id: "manual-goal", goal_started_at: 1_000 })).rejects.toThrow(
		/no focused goal is available.*pass goal_id, goal_started_at, and timezone explicitly/,
	);
	const focused = await invoke({ id: "focused-goal", createdAt: 1_000, status: "active" });
	expect(focused.details.state).toMatchObject({ goalId: "focused-goal", goalStartedAt: 1_000, active: true });
	expect(typeof focused.details.state?.timezone).toBe("string");
});
