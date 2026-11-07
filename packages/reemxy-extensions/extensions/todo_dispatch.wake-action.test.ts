// @ts-nocheck -- drives the registered dispatcher against disposable session state.
import { expect, test } from "bun:test";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch from "./todo_dispatch";

async function harness(journal = []) {
  const hooks = new Map();
  const sent = [];
  const timers = [];
  const now = Date.now();
  const phases = [{ name: "Ship", tasks: [{ content: "PR 114 acceptance", status: "pending", schedule: {
    dependencies: [], cumulativeReestimateCount: 4,
    estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "test", updatedAt: now },
  } }] }];
  const jobs = { running: [], recent: [], nonJobAgents: [] };
  const api = { on: (name, fn) => hooks.set(name, fn), getActiveTools: () => ["todo", "task"],
    appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
    sendMessage: (message, options) => sent.push({ ...message, options }),
    pi: { ...schedule, getLatestTodoPhasesFromEntries, readGoalDeadline: () => ({ goalId: "wake", deadlineAt: now - 6 * 3600000 }), agentPauseGate: { paused: false } },
  };
  const ctx = { cwd: "/tmp/omp-wake-test", sessionManager: { getHeader: () => ({ id: "wake" }),
    getBranch: () => journal, getBranchMatching: predicate => journal.filter(predicate), getLatestBranchMatching: predicate => journal.findLast(predicate), getSessionFile: () => undefined },
    getTodoPhases: () => phases, getTodoSnapshot: () => phases,
    getAsyncJobSnapshot: () => jobs, getTaskMaxConcurrency: () => 6,
    getTodoPreviewConfig: () => ({ enabled: false, paths: [], openReviewPages: false }),
    isIdle: () => true, hasPendingMessages: () => false,
    setTimeout: fn => { timers.push(fn); return {}; }, clearTimer: () => {},
  };
  await todoDispatch(api);
  const wake = async () => { await hooks.get("agent_end")({}, ctx); await timers.pop()?.(); const message = sent.findLast(message => message.options?.triggerTurn); if (message) await hooks.get("message_start")({ message: { role: "custom", ...message } }, ctx); };
  return { hooks, ctx, sent, phases, jobs, journal, wake };
}

test("no-event wake is silent, prose-only and re-estimate turns persist an escalating concrete action across reload", async () => {
  const h = await harness();
  await h.wake();
  const wake = h.sent.find(message => message.options?.triggerTurn);
  expect(wake?.details?.silentAssistant).toBe(true);
  await h.hooks.get("turn_end")({}, h.ctx);
  const first = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand");
  expect(first.data).toMatchObject({ misses: 1, toolCalls: 0, mutations: 0 });
  expect(first.data.action).toContain("PR 114 acceptance");
  await h.hooks.get("tool_call")({ toolName: "todo", input: { op: "schedule", updates: [] } }, h.ctx);
  h.phases[0].tasks[0].schedule.estimate.likelySeconds += 100;
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 2, mutations: 0 });
  const resumed = await harness(h.journal);
  await resumed.wake();
  const next = resumed.sent.find(message => message.options?.triggerTurn);
  expect(next.content).toContain("ESCALATED");
  expect(next.content).toContain("PR 114 acceptance");
});

test("successful dispatch counts as action, failed calls do not; a finished job allows a real update", async () => {
  const h = await harness();
  await h.wake();
  const call = { toolName: "task", input: { tasks: [{ name: "Acceptance", task: "PR 114 acceptance" }] } };
  await h.hooks.get("tool_result")({ ...call, isError: true, content: [] }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.misses).toBe(1);
  await h.hooks.get("tool_result")({ ...call, isError: false, content: [] }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 0, mutations: 1 });
  h.jobs.recent.push({ id: "Acceptance", label: "PR 114 acceptance", type: "task", status: "completed", startTime: Date.now() });
  // The plan ticker is independent of the alarm timer; a changed alarm re-arms the latter.
  h.phases[0].tasks[0].content = "PR 114 next acceptance";
  await h.wake();
  expect(h.sent.findLast(message => message.options?.triggerTurn)?.details?.silentAssistant).toBe(false);
});

test("CHURN cannot be satisfied by dispatching unrelated work; splitting its dependencies counts", async () => {
  const h = await harness();
  await h.wake();
  await h.hooks.get("tool_result")({ toolName: "task", input: { tasks: [{ name: "Unrelated", task: "Other work" }] }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 1, mutations: 0 });
  h.phases[0].tasks[0].schedule.dependencies.push("Small acceptance slice");
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 0, mutations: 1 });
});
