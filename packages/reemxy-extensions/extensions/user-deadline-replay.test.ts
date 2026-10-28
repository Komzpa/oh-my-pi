// @ts-nocheck -- extension event consumers are exercised through the runtime API.
import { afterEach, expect, test, vi } from "bun:test";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { readGoalDeadline as nativeReadGoalDeadline } from "@oh-my-pi/pi-coding-agent/goals/deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { sessionContextEntryMetadata, type SessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { forecastTodoPlan, formatPlanForecast, formatTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import goalDeadlines from "./goal_deadlines";
import todoDispatch from "./todo_dispatch";
import * as deadlines from "./deadlines";
import replay from "./fixtures/user-deadline-replay.json";

function branchMock(getBranch: () => unknown[]) {
  return {
    getBranch,
    getBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) => getBranch().filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
    getLatestBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) => getBranch().findLast(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
  };
}

afterEach(() => vi.restoreAllMocks());

function deadlineHarness(withDeadlineInput = true) {
	let now = Date.parse(replay.recordedAt);
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const branch: unknown[] = withDeadlineInput ? [structuredClone(replay.userEntry)] : [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let tool;
	const api = {
		pi: deadlines,
		on: (name, handler) => handlers.set(name, handler),
		zod: z,
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		registerTool: value => { tool = value; },
	} as unknown as ExtensionAPI;
	goalDeadlines(api);
	const ctx = { cwd: import.meta.dir, hasUI: false, sessionManager: branchMock(() => branch) } as unknown as ExtensionContext;
	handlers.get("session_start")!({}, ctx);
	return {
		branch, handlers, ctx,
		setNow: (value: string) => { now = Date.parse(value); },
		call: (params: unknown) => tool.execute("deadline-replay", params, undefined, undefined, ctx),
		context: () => handlers.get("context")!({ messages: [] }, ctx).messages.at(-1).content,
		gate: (toolName: string, input: unknown) => handlers.get("tool_call")!({ toolName, input }, ctx),
		user: (id: string, text: string, attribution = "user") => branch.push({ type: "message", id, timestamp: new Date(now).toISOString(), message: { role: "user", attribution, content: text } }),
	};
}

test("transcript replay persists without focus, wraps at 23:00, and survives rewritten notes and compaction", async () => {
	const h = deadlineHarness();
	const saved = await h.call(replay.set);
	expect(saved.details.goal).toBeNull();
	expect(saved.details.state.userConstraint.messageId).toBe(replay.userEntry.id);
	expect(h.branch.some(entry => entry.customType === deadlines.STATE_ENTRY)).toBe(true);
	expect(deadlines.readGoalDeadline(h.branch)?.deadlineAt).toBe(Date.parse(replay.dueAt));
	expect(nativeReadGoalDeadline(h.branch)?.deadlineAt).toBe(Date.parse(replay.dueAt));
	expect(h.context()).not.toContain("MISSED");
	expect(h.gate("todo", { op: "append", items: ["New row"] })).toBeUndefined();
	h.setNow(replay.dueAt);
	expect(h.context()).toContain("MISSED by 0m");
	expect(h.context()).toContain("deadline 23:00");
	expect(h.context()).toContain("Remaining: Verified delivery");
	const missed = h.gate("todo", { op: "append", items: ["New row"] });
	expect(missed).toMatchObject({ block: true });
	expect(missed.reason).toContain("Only add or delegate work that serves an open requested TODO row");
	expect(missed.reason.split("\n", 1)[0].length).toBeLessThanOrEqual(100);
	expect(h.gate("todo", { op: "init", list: [{ phase: "New scope", items: ["New row"] }] })).toMatchObject({ block: true });
	expect(h.gate("task", { tasks: [{ name: "NewWorker", agent: "coder", task: "New row" }] })).toMatchObject({ block: true });
	expect(h.gate("todo", { op: "schedule", updates: [{ task: "Existing row", content: "Corrected row" }] })).toBeUndefined();
	h.setNow(replay.notesRewrittenAt);
	h.branch.push({ type: "custom", customType: "experimental-context-notes", data: { text: "New notes with no deadline." } }, { type: "compaction", summary: "No deadline mentioned." });
	h.handlers.get("session_compact")!({}, h.ctx);
	expect(h.context()).toContain("MISSED by 129m");
	h.handlers.get("session_start")!({}, h.ctx);
	expect(h.context()).toContain("MISSED by 129m");
});

test("no-deadline negative control keeps context and todo/task behavior unchanged", () => {
	const h = deadlineHarness(false);
	h.setNow(replay.notesRewrittenAt);
	expect(h.context()).toContain("deadline not set");
	expect(h.context()).not.toContain("WRAP-UP MODE");
	expect(h.gate("todo", { op: "append", items: ["New row"] })).toBeUndefined();
	expect(h.gate("task", { name: "NewWorker", agent: "coder", task: "New row" })).toBeUndefined();
});

test("assistant status promises and synthetic user messages cannot extend or clear a missed deadline", async () => {
	const h = deadlineHarness();
	await h.call(replay.set);
	h.setNow(replay.notesRewrittenAt);
	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "New status time 23:45" }] } });
	const later = { ...replay.set, stages: [{ ...replay.set.stages[0], deadline_at: replay.set.stages[0].deadline_at + 2_700 }] };
	await expect(h.call(later)).rejects.toThrow("The quoted user message does not authorize changing the recorded deadline");
	await expect(h.call({ action: "clear" })).rejects.toThrow("user_message must quote a newer real user message");
	h.user("synthetic", "New deadline 23:45", "agent");
	await expect(h.call({ ...later, user_message: "New deadline 23:45" })).rejects.toThrow("latest real user message");
	expect(h.context()).toMatch(/MISSED by \d+m/);
});

test("a newer real user time replaces the constraint and clears wrap-up", async () => {
	const h = deadlineHarness();
	await h.call(replay.set);
	h.setNow(replay.dueAt);
	h.user("replacement", "New deadline: 00:45");
	const replaced = await h.call({ ...replay.set, user_message: "New deadline: 00:45", stages: [{ ...replay.set.stages[0], deadline_at: replay.set.stages[0].deadline_at + 6_300 }] });
	expect(replaced.details.state.userConstraint.messageId).toBe("replacement");
	expect(h.context()).not.toContain("WRAP-UP MODE");
	expect(h.context()).toContain("deadline 00:45");
	expect(h.gate("task", { name: "AllowedWorker", task: "Delivery" })).toBeUndefined();
});

test("after a miss unrelated work stays blocked until the user changes the constraint", async () => {
	const h = deadlineHarness();
	await h.call(replay.set);
	h.setNow(replay.dueAt);
	h.user("correction", "Correct the existing item: show its real verification state");
	expect(h.gate("todo", { op: "append", items: ["New row"] })).toMatchObject({ block: true });
	expect(h.gate("task", { name: "NewWorker", task: "New row" })).toMatchObject({ block: true });
	await expect(h.call({ action: "clear", user_message: "drop the deadline" })).rejects.toThrow("user_message must quote a newer real user message");
	h.user("reset", "сбрось дедлайн, работаем дальше");
	await expect(h.call({ action: "clear", user_message: "drop the deadline" })).rejects.toThrow("user_message must quote a newer real user message");
	await h.call({ action: "clear", user_message: "сбрось дедлайн" });
	expect(h.context()).not.toContain("MISSED");
	expect(h.gate("todo", { op: "append", items: ["New row"] })).toBeUndefined();
	expect(h.gate("task", { name: "NewWorker", task: "New row" })).toBeUndefined();
});

test("delivering stages and dropping focus do not close the user's deadline", async () => {
	const h = deadlineHarness();
	await h.call(replay.set);
	await h.call({ action: "deliver", stage_id: "ship", delivered_artifact: "Verified partial delivery" });
	h.branch.push({ type: "mode_change", mode: "none" });
	h.setNow(replay.dueAt);
	expect(h.context()).toContain("MISSED");
	expect(nativeReadGoalDeadline(h.branch)?.deadlineAt).toBe(Date.parse(replay.dueAt));
	h.user("close", "/deadline close");
	await h.call({ action: "clear", user_message: "/deadline close" });
	expect(h.context()).not.toContain("MISSED");
	expect(nativeReadGoalDeadline(h.branch)).toBeUndefined();
});

test("only a user-visible final records the single wrap-up status receipt", async () => {
	const h = deadlineHarness();
	await h.call(replay.set);
	h.setNow(replay.dueAt);
	const end = h.handlers.get("message_end")!;
	end({ message: { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text: "Checking" }] } }, h.ctx);
	expect(h.context()).toContain("Send one honest status message");
	end({ message: { role: "assistant", content: [{ type: "text", text: "Verified partial delivery; the final review is unfinished." }] } }, h.ctx);
	expect(h.context()).toContain("status was already sent");
	h.handlers.get("session_compact")!({}, h.ctx);
	expect(h.context()).toContain("status was already sent");
});

test("real staffing consumer yields its demands and worker gate to missed-deadline wrap-up", async () => {
	const previousLane = process.env.OMP_LANE_UNIT;
	delete process.env.OMP_LANE_UNIT;
	const h = deadlineHarness();
	await h.call(replay.set);
	h.setNow(replay.dueAt);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let provider;
	try {
		await todoDispatch({
			on: (name, handler) => handlers.set(name, handler),
			getActiveTools: () => ["task", "todo", "bash", "wait"],
			pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, getLatestTodoPhasesFromEntries, agentPauseGate, readGoalDeadline: deadlines.readGoalDeadline },
			registerSoftToolRequirementProvider: value => { provider = value; },
			appendEntry: () => {},
			sendMessage: () => {},
		} as unknown as ExtensionAPI);
		const ctx = { ...h.ctx, getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }), hasPendingMessages: () => false, getTaskMaxConcurrency: () => 20, sessionManager: { getHeader: () => ({ id: "deadline-replay" }), ...branchMock(() => h.branch), getSessionFile: () => undefined } } as unknown as ExtensionContext;
		expect(provider.demand(ctx)).toBeUndefined();
		expect(await handlers.get("context")!({ messages: [] }, ctx)).toBeUndefined();
		expect(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git status" } }, ctx)).toBeUndefined();
		// Wrap-up still requires an answer to the human before waiting.
		expect((await handlers.get("tool_call")!({ toolName: "wait", input: {} }, ctx))?.block).toBe(true);
		h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "The deadline passed; final verification is unfinished." }] } });
		expect(await handlers.get("tool_call")!({ toolName: "wait", input: {} }, ctx)).toBeUndefined();
	} finally {
		if (previousLane === undefined) delete process.env.OMP_LANE_UNIT;
		else process.env.OMP_LANE_UNIT = previousLane;
	}
});
