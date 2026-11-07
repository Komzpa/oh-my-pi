// @ts-nocheck -- drives the registered dispatcher against disposable session state.
import { expect, test, spyOn } from "bun:test";
import { Type } from "@sinclair/typebox";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch from "./todo_dispatch";

async function harness(journal = [], chain = false, healthy = false, deadlineEnabled = true) {
  const hooks = new Map();
  const sent = [];
  const timers = [];
  const tools = new Map();
  const now = Date.now();
  const phases = [{ name: "Ship", tasks: [{ content: "PR 114 acceptance", status: "pending", schedule: {
    dependencies: [], cumulativeReestimateCount: healthy ? 0 : 4,
    estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "test", updatedAt: now },
  } }] }];
  if (chain) {
    phases[0].tasks[0].content = "Labels";
    for (const [content, dependency] of [["11 MW", "Labels"], ["Levels", "11 MW"], ["Collateral", "Levels"], ["Collateral2", "Collateral"]])
      phases[0].tasks.push({ content, status: "pending", schedule: { dependencies: [dependency], estimate: { ...phases[0].tasks[0].schedule.estimate } } });
  }
  const jobs = { running: [], recent: [], nonJobAgents: [] };
  const api = { typebox: { Type }, registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => hooks.set(name, fn), getActiveTools: () => ["todo", "task"],
    appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
    sendMessage: (message, options) => sent.push({ ...message, options }),
    pi: { ...schedule, getLatestTodoPhasesFromEntries, readGoalDeadline: () => deadlineEnabled ? ({ goalId: "wake", deadlineAt: now - 6 * 3600000 }) : undefined, agentPauseGate: { paused: false } },
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
  return { hooks, ctx, sent, phases, jobs, journal, wake, tools };
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


test("CHURN chain review persists every link, survives reload and rejects unrelated work or head retries", async () => {
  const h = await harness([], true);
  await h.wake();
  const first = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand");
  expect(first?.data.edges).toEqual([
    { task: "11 MW", dependency: "Labels" }, { task: "Collateral", dependency: "Levels" },
    { task: "Collateral2", dependency: "Collateral" }, { task: "Levels", dependency: "11 MW" },
  ]);
  await h.hooks.get("tool_result")({ toolName: "task", input: { tasks: [{ name: "Retry", task: "Labels" }] }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 1, mutations: 0 });
  h.phases[0].tasks[0].schedule.owner = "New owner";
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.misses).toBe(2);
  const resumed = await harness(h.journal, true);
  await resumed.wake();
  expect(resumed.sent.findLast(message => message.options?.triggerTurn)?.content).toContain("ESCALATED");
  expect(resumed.sent.findLast(message => message.options?.triggerTurn)?.content).toContain("Collateral2");
  // A slot-only edge is removed by a real todo mutation, preserving the rest of the graph.
  resumed.phases[0].tasks[1].schedule.dependencies = [];
  await resumed.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, resumed.ctx);
  await resumed.hooks.get("turn_end")({}, resumed.ctx);
  expect(resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 0, mutations: 1 });
});

test("real chain dependencies can be rejected with a persisted per-link reason, changed graphs rearm review", async () => {
  const h = await harness([], true);
  await h.wake();
  const head = h.phases[0].tasks[0];
  const persisted = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand");
  expect(persisted?.data.key).toMatch(/^chain:/);
  const key = persisted.data.key;
  head.schedule.progress = { at: Date.now(), evidence: `Dependency review ${key}:
11 MW <- Labels: consumes label ids
Levels <- 11 MW: consumes capacity
Collateral <- Levels: consumes levels
Collateral2 <- Collateral: consumes first collateral output` };
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  const receipt = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand");
  expect(receipt.data.rejection).toBe(head.schedule.progress.evidence);
  const resumed = await harness(h.journal, true);
  resumed.phases[0].tasks[0].schedule.progress = structuredClone(head.schedule.progress);
  await resumed.wake();
  expect(resumed.sent.findLast(message => message.options?.triggerTurn)?.content).not.toContain("WAIT-CHAIN REVIEW");
  resumed.phases[0].tasks[4].schedule.dependencies.push("Labels");
  await resumed.wake();
  expect(resumed.sent.findLast(message => message.options?.triggerTurn)?.content).toContain("WAIT-CHAIN REVIEW");
});


test("AUDIT-FAIL heads trigger chain review during ordinary turns; a lone head and healthy chains do not", async () => {
  const h = await harness([], true);
  const head = h.phases[0].tasks[0];
  head.schedule.cumulativeReestimateCount = 0;
  head.schedule.executor = { workerId: "AuditWorker", startedAt: 100, finishedAt: 200, outcome: "completed" };
  head.schedule.audit = { delivery: schedule.todoRowDeliveryKey(head.schedule), agent: "qa-auditor", verdict: "fail", findings: "wrong label ids" };
  await h.hooks.get("turn_start")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand")?.data.edges).toHaveLength(4);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.misses).toBe(1);
  const healthy = await harness([], true);
  healthy.phases[0].tasks[0].schedule.cumulativeReestimateCount = 0;
  await healthy.wake();
  expect(healthy.sent.findLast(message => message.options?.triggerTurn)?.content).not.toContain("WAIT-CHAIN REVIEW");
  const short = await harness([], true);
  short.phases[0].tasks.splice(1);
  await short.wake();
  expect(short.sent.findLast(message => message.options?.triggerTurn)?.content).not.toContain("WAIT-CHAIN REVIEW");
});

test("dependent dispatch must succeed in an isolated worktree and have no unfinished logical dependency", async () => {
  const h = await harness([], true);
  await h.wake();
  const call = { toolName: "task", input: { tasks: [{ name: "Capacity", task: "11 MW", isolated: true }] }, content: [] };
  await h.hooks.get("tool_result")({ ...call, isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ mutations: 0, misses: 1 });
  h.phases[0].tasks[0].status = "completed";
  await h.hooks.get("tool_result")({ ...call, isError: true }, h.ctx);
  // A failed call cannot claim the dependent was dispatched. A non-isolated dispatch cannot either.
  await h.hooks.get("tool_result")({ ...call, input: { ...call.input, tasks: [{ ...call.input.tasks[0], isolated: false }] }, isError: false }, h.ctx);
  await h.hooks.get("tool_result")({ ...call, isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ mutations: 1, misses: 0 });
});


test("MISSED demand survives prose, estimate inflation, unrelated dispatch and reload until observed staffing", async () => {
  const h = await harness([], false, true);
  await h.hooks.get("turn_start")({}, h.ctx);
  const first = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand");
  expect(first?.data.recovery?.pending?.kind).toBe("deadline");
  const call = { toolName: "task", input: { tasks: [{ name: "Other", task: "Unrelated" }] }, content: [], isError: false };
  await h.hooks.get("tool_result")(call, h.ctx);
  h.phases[0].tasks[0].schedule.estimate.likelySeconds += 1000;
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 1, mutations: 0 });
  const resumed = await harness(h.journal, false, true);
  await resumed.hooks.get("turn_start")({}, resumed.ctx);
  await resumed.hooks.get("turn_end")({}, resumed.ctx);
  expect(resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.misses).toBe(2);
  const refused = await resumed.hooks.get("tool_call")({ toolName: "wait", input: {} }, resumed.ctx);
  expect(refused?.block).toBe(true);
  const row = resumed.phases[0].tasks[0];
  row.schedule.owner = "NewWorker";
  await resumed.hooks.get("tool_result")({ ...call, toolName: "todo" }, resumed.ctx);
  expect(resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.recovery.pending.kind).toBe("deadline");
  row.schedule.executor = { workerId: "NewWorker", startedAt: Date.now() };
  resumed.jobs.running.push({ id: "NewWorker", label: "Delivery", startTime: Date.now(), type: "task", status: "running" });
  await resumed.hooks.get("tool_result")(call, resumed.ctx);
  expect(resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 0, mutations: 1, recovery: { pending: undefined } });
});

test("MISSED demand accepts a scope cut but a failed tool cannot satisfy it", async () => {
  const h = await harness([], false, true);
  await h.hooks.get("turn_start")({}, h.ctx);
  h.phases[0].tasks[0].status = "abandoned";
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "update" }, content: [], isError: true }, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.recovery.pending.kind).toBe("deadline");
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "update" }, content: [], isError: false }, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.mutations).toBe(1);
});


test("only a fresh recorded owner question on an open demand row satisfies deadline escalation", async () => {
  const h = await harness([], false, true);
  await h.hooks.get("turn_start")({}, h.ctx);
  const at = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.recovery.pending.at;
  const call = { toolName: "plan_critic_action", input: {}, content: [], isError: false };
  for (const [row, timestamp] of [["Unrelated", at + 1], [h.phases[0].tasks[0].content, at - 1]]) {
    h.journal.push({ type: "custom_message", customType: "lead-plan-critic-question", details: { row, at: timestamp } });
    await h.hooks.get("tool_result")(call, h.ctx);
    expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.recovery.pending.kind).toBe("deadline");
  }
  h.journal.push({ type: "custom_message", customType: "lead-plan-critic-question", details: { row: h.phases[0].tasks[0].content, at: at + 1 } });
  await h.hooks.get("tool_result")(call, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ mutations: 1, recovery: { pending: undefined } });
});

test("forecast tool persists measured pace and ETA; a zero-pace call leaves demand pending", async () => {
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const h = await harness([], false, true);
    h.phases[0].tasks.push({ content: "Other delivery", status: "pending" });
    await h.hooks.get("turn_start")({}, h.ctx);
    const tool = h.tools.get("todo_dispatch_forecast");
    now += 3600000;
    await expect(tool.execute("f", {}, undefined, undefined, h.ctx)).rejects.toThrow("zero rows/hour");
    h.phases[0].tasks[1].status = "completed";
    await tool.execute("f", {}, undefined, undefined, h.ctx);
    const receipt = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
    expect(receipt.recovery.forecast).toMatchObject({ rowsPerHour: 1, completed: 1, open: 1, eta: now + 3600000 });
    expect(receipt.recovery.pending).toBeUndefined();
  } finally { clock.mockRestore(); }
});


test("ready-row idle age survives reload and clears only for staffing or that row's recorded hold", async () => {
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const h = await harness([], false, true, false);
    await h.hooks.get("turn_start")({}, h.ctx);
    now += 600000;
    const resumed = await harness(h.journal, false, true, false);
    await resumed.hooks.get("turn_start")({}, resumed.ctx);
    let receipt = resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
    expect(receipt.recovery.pending.kind).toBe("idle");
    await resumed.hooks.get("tool_result")({ toolName: "task", input: { tasks: [{ name: "Other", task: "Unrelated" }] }, content: [], isError: false }, resumed.ctx);
    await resumed.hooks.get("turn_end")({}, resumed.ctx);
    expect(resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.misses).toBe(1);
    resumed.phases[0].tasks[0].status = "blocked";
    resumed.phases[0].tasks[0].blocker = "Waiting for owner-approved access";
    await resumed.hooks.get("tool_result")({ toolName: "todo", input: { op: "block" }, content: [], isError: false }, resumed.ctx);
    receipt = resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
    expect(receipt.recovery.pending).toBeUndefined(); expect(receipt.mutations).toBe(1);
  } finally { clock.mockRestore(); }
});
