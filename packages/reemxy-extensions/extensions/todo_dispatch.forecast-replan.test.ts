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
			cwd: import.meta.dir,
			sessionManager: {
				getHeader: () => ({ id: "forecast-replan-test" }),
				getBranch: () => branch,
				getBranchMatching: predicate => branch.filter(entry => predicate(sessionContextEntryMetadata(entry))),
				getLatestBranchMatching: predicate => branch.findLast(entry => predicate(sessionContextEntryMetadata(entry))),
			},
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
			getTaskMaxConcurrency: () => 2,
			hasPendingMessages: () => false,
			isIdle: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		await handlers.get("context")?.({ messages: [] }, ctx);
		return { branch, ctx, provider };
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

test("a user delivery deadline after P95 creates a cut-to-fit replan demand", async () => {
	const now = Date.now();
	const demand = await demandFor([{ content: "Ship the package", status: "pending", schedule: { dependencies: [], resources: ["package"], estimate: estimate(now, 1_800) } }], now + 600_000);
	expect(demand?.soft).toBe(true);
	expect(demand?.reminder[0].content).toContain("after the delivery deadline");
	expect(demand?.reminder[0].content).toContain("Cut the plan to what can ship");
	expect(demand?.reminder[0].content).toContain("Ship the package");
});

test("a row past its canonical ETA creates a mandatory forecast replan", async () => {
	const now = Date.now();
	const demand = await demandFor([{ content: "Finish the running check", status: "in_progress", startedAt: now - 3_600_000, schedule: { dependencies: [], resources: ["check"], estimate: estimate(now - 3_600_000, 60) } }]);
	expect(demand?.soft).toBe(true);
	expect(demand?.reminder[0].content).toContain("plan P95 passed");
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

test("new estimates answer the forecast replan and keep the automatic deadline on the revised finish", async () => {
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
	expect(state.baselineDeadlineAt * 1_000).toBeGreaterThan(Date.now());
});
