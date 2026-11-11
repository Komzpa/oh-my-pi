// @ts-nocheck -- runtime integration contract for the extension's registered soft demand.
import { afterEach, expect, test, vi } from "bun:test";
import { z } from "zod";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { sessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { forecastTodoPlan, formatPlanForecast, formatTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import todoDispatch from "./todo_dispatch";
import { readGoalDeadline, STATE_ENTRY } from "./deadlines";

afterEach(() => vi.restoreAllMocks());

async function demandHarness(tasks: unknown[], deadlineAt?: number, autoDeadlineAt?: number) {
	const now = Date.now();
	const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Plan", tasks }] } } }];
	if (deadlineAt !== undefined) branch.push({ type: "custom", customType: STATE_ENTRY, data: { version: 1, goalId: "goal-1", goalStartedAt: Math.floor(now / 1_000), timezone: "UTC", active: true, stages: [{ id: "deliver", label: "Deliver", expectedResult: "Ship the package", deadlineAt: Math.floor(deadlineAt / 1_000) }], baselineDeadlineAt: Math.floor(deadlineAt / 1_000), userConstraint: { messageId: "user-1", quote: "ship by the deadline", recordedAt: Math.floor(now / 1_000) } } });
	if (autoDeadlineAt !== undefined) branch.push({ type: "custom", customType: STATE_ENTRY, data: { version: 1, goalId: "auto-todo-plan", goalStartedAt: Math.floor(now / 1_000), timezone: "UTC", active: true, auto: true, autoPlanKey: "previous-plan", stages: [{ id: "auto-plan-forecast", label: "Finish the TODO plan", expectedResult: "Complete the current TODO plan", deadlineAt: Math.floor(autoDeadlineAt / 1_000) }], baselineDeadlineAt: Math.floor(autoDeadlineAt / 1_000) } });
	if (deadlineAt !== undefined) expect(readGoalDeadline(branch)).toBeDefined();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let provider;
	const api = {
		on: (name, handler) => handlers.set(name, handler),
		getActiveTools: () => ["task", "todo", "read", "wait"],
		pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, readGoalDeadline, getLatestTodoPhasesFromEntries, agentPauseGate, getActiveTools: () => ["task", "todo", "read", "wait"] },
		zod: z,
		registerSoftToolRequirementProvider: value => { provider = value.demand ?? value; },
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const wasPaused = agentPauseGate.paused;
	if (wasPaused) agentPauseGate.resume();
	try {
		await todoDispatch(api);
		const ctx = {
			// This harness exercises forecasts without a checkout or unpushed-work debt.
			cwd: `${import.meta.dir}/forecast-without-checkout`,
			sessionManager: {
				getHeader: () => ({ id: "forecast-replan-test" }),
				getBranch: () => branch,
				getBranchMatching: predicate => branch.filter(entry => predicate(sessionContextEntryMetadata(entry))),
				getLatestBranchMatching: predicate => branch.findLast(entry => predicate(sessionContextEntryMetadata(entry))),
			},
			getTodoPhases: () => branch.find(entry => entry.type === "message")?.message?.details?.phases ?? [],
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
			getTaskMaxConcurrency: () => 2,
			hasPendingMessages: () => false,
			isIdle: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		await handlers.get("context")?.({ messages: [] }, ctx);
		return { branch, ctx, provider, handlers };
	} finally {
		if (wasPaused) agentPauseGate.pause();
	}
}

async function demandFor(tasks: unknown[], deadlineAt?: number, autoDeadlineAt?: number) {
	const h = await demandHarness(tasks, deadlineAt, autoDeadlineAt);
	return h.provider(h.ctx);
}

const estimate = (now: number, likelySeconds: number) => ({ optimisticSeconds: likelySeconds, likelySeconds, pessimisticSeconds: likelySeconds, confidence: "medium", basis: "fixture", updatedAt: now });

test("an unresolved requested row creates a named mandatory forecast replan", async () => {
	const demand = await demandFor([{ content: "Estimate the release note", status: "pending", schedule: {} }]);
	expect(demand?.soft).toBe(true);
	expect(demand?.toolName).toBe("todo");
	expect(demand?.reminder[0].content).toContain("Estimate the release note");
	expect(demand?.reminder[0].content).toContain("no usable estimate");
});

test("an undelivered user wait demands a concrete forecast repair; delivered review is not debt", async () => {
	const now = Date.now();
	const schedule = { dependencies: [], resources: ["models"], estimate: estimate(now, 600), review: "user" };
	const task = { content: "Find better transformer models", status: "blocked", blocker: "Awaiting Darafei: Do/Leave on selection", schedule };
	const demand = await demandFor([task]);
	expect(demand?.reminder[0].content).toContain(task.content);
	expect(demand?.reminder[0].content).toContain('"op":"unblock"');
	expect(demand?.reminder[0].content).toContain('"op":"schedule"');
	expect(demand?.reminder[0].content).toContain('"op":"drop"');
	const h = await demandHarness([task]);
	const call = (toolName, input) => h.handlers.get("tool_call")({ toolName, input, toolCallId: "call" }, h.ctx);
	const refusal = await call("task", { tasks: [{ name: "Other", task: "unrelated work" }] });
	const sameRow = await call("task", { tasks: [{ name: "Held", task: task.content }] });
	expect(sameRow?.block).toBe(true);
	expect(sameRow.reason).toContain(task.content);
	expect((await call("read", { path: "README.md" }))?.block).not.toBe(true);
	expect((await call("todo", { op: "unblock", task: task.content }))?.block).not.toBe(true);
	const delivered = { ...task, schedule: { ...schedule, firstDeliveredAt: now, reviewSummary: "Model comparison delivered" } };
	expect(await demandFor([delivered])).toBeUndefined();
});

test("an unrelated held row permits both layers of deadline administration and independent ready work", async () => {
	const now = Date.now();
	const held = { content: "Cooling source approval", status: "blocked", blocker: "Awaiting Darafei: approve cooling source", schedule: { dependencies: [], resources: ["/fixture/cooling"], review: "user", estimate: estimate(now, 600) } };
	const ready = { content: "Inspect roof geometry", status: "pending", schedule: { dependencies: [], resources: ["/fixture/roof"], estimate: estimate(now, 600) } };
	const dependent = { content: "Apply cooling layout", status: "pending", schedule: { dependencies: [held.content], resources: ["/fixture/cooling"], estimate: estimate(now, 600) } };
	const h = await demandHarness([held, ready, dependent], now + 3600_000);
	const call = (toolName, input) => h.handlers.get("tool_call")({ toolName, input, toolCallId: "administration" }, h.ctx);
	expect((await call("write", { path: "xd://goal_deadline", content: JSON.stringify({ action: "status" }) }))?.block).not.toBe(true);
	expect((await call("goal_deadline", { action: "status" }))?.block).not.toBe(true);
	expect((await call("goal_deadline", { action: "set", user_message: "move the deadline to 2026-11-11 12:00" }))?.block).not.toBe(true);
	expect((await call("task", { tasks: [{ name: "Roof", task: ready.content, resources: ready.schedule.resources }] }))?.block).not.toBe(true);
	expect((await call("task", { tasks: [{ name: "Cooling", task: dependent.content, resources: dependent.schedule.resources }] }))?.block).toBe(true);
	expect(h.branch[0].message.details.phases[0].tasks[0]).toEqual(held);
});

test("a valid late whole-plan forecast permits delivery without estimate padding or a scope-cut question", async () => {
	const now = Date.now();
	const tasks = [{ content: "Ship the package", status: "pending", schedule: { dependencies: [], resources: ["package"], estimate: estimate(now, 1_800) } }];
	const deadline = now + 600_000;
	const h = await demandHarness(tasks, deadline);
	for (let pass = 0; pass < 3; pass++) {
		const demand = h.provider(h.ctx);
		expect(demand?.toolName).toBe("task");
		expect(demand?.id).not.toContain("todo-forecast-replan");
	}
	const state = h.branch.filter(entry => entry.customType === STATE_ENTRY).at(-1).data;
	expect(state.baselineDeadlineAt).toBe(Math.floor(deadline / 1_000));
	const plan = forecastTodoPlan([{ name: "Plan", tasks }], { now, deadlineAt: deadline, capacity: 2 });
	expect(plan.deadlineStatus).toBe("will-miss");
	expect(tasks[0].schedule.estimate.likelySeconds).toBe(1_800);
});

test("a row past its canonical ETA creates a mandatory forecast replan", async () => {
	const now = Date.now();
	const demand = await demandFor([{ content: "Finish the running check", status: "in_progress", startedAt: now - 3_600_000, schedule: { dependencies: [], resources: ["check"], estimate: estimate(now - 3_600_000, 60) } }]);
	expect(demand?.soft).toBe(true);
	expect(demand?.reminder[0].content).toContain("passed its own ETA");
	expect(demand?.reminder[0].content).toContain("Finish the running check");
});

test("a passed automatic forecast deadline creates a mandatory replan and reports the miss", async () => {
	const now = Date.now();
	const demand = await demandFor([{ content: "Ship the package", status: "pending", schedule: { dependencies: [], resources: ["package"], estimate: estimate(now, 1_800) } }], undefined, now - 60_000);
	expect(demand?.soft).toBe(true);
	expect(demand?.reminder[0].content).toContain("automatic TODO forecast deadline");
	expect(demand?.reminder[0].content).toContain("Forecast missed 1 time(s), last by");
	expect(demand?.reminder[0].content).toContain("Ship the package");
});

test("new estimates answer the forecast replan without moving the anchored automatic deadline", async () => {
	const now = Date.now();
	const task = { content: "Ship the package", status: "pending", schedule: { dependencies: [], resources: ["package"], estimate: estimate(now - 1_000, 1_800) } };
	const h = await demandHarness([task], undefined, now - 60_000);
	expect(h.provider(h.ctx)?.soft).toBe(true);
	const current = h.branch[0].message.details.phases[0].tasks[0];
	current.schedule.estimate = estimate(Date.now(), 2_400);
	const afterReplan = h.provider(h.ctx);
	expect(afterReplan?.id).not.toContain("todo-forecast-replan");
	expect(afterReplan?.toolName).toBe("task");
	const state = h.branch.filter(entry => entry.customType === STATE_ENTRY).at(-1).data;
	expect(state.auto).toBe(true);
	expect(state.baselineDeadlineAt).toBe(Math.floor((now - 60_000) / 1_000));
	expect(state.stages[0].deadlineAt).toBe(state.baselineDeadlineAt);
});

test("a real future user deadline supersedes the earlier automatic miss without hiding row ETA debt", async () => {
	const now = Date.now();
	const task = { content: "Ship the package", status: "pending", schedule: { dependencies: [], resources: ["package"], estimate: estimate(now, 1_800) } };
	const h = await demandHarness([task], undefined, now - 60_000);
	expect(h.provider(h.ctx)?.reminder[0].content).toContain("automatic TODO forecast deadline");
	h.branch.push({ type: "custom", customType: STATE_ENTRY, data: {
		version: 1, goalId: "user-delivery", goalStartedAt: Math.floor(now / 1_000), timezone: "UTC", active: true,
		stages: [{ id: "deliver", label: "Deliver", expectedResult: "Ship the package", deadlineAt: Math.floor((now + 6 * 3_600_000) / 1_000) }],
		baselineDeadlineAt: Math.floor((now + 6 * 3_600_000) / 1_000),
		userConstraint: { messageId: "user-new", quote: "set deadline to 22:00", recordedAt: Math.floor(now / 1_000) },
	} });
	expect(h.provider(h.ctx)?.id).not.toContain("todo-forecast-replan");
	const current = h.branch[0].message.details.phases[0].tasks[0];
	current.schedule.estimate = undefined;
	expect(h.provider(h.ctx)?.reminder[0].content).toContain("no usable estimate");
});
