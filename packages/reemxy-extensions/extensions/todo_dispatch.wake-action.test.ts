// @ts-nocheck -- drives the registered dispatcher against disposable session state.
import { afterEach, expect, test, spyOn, vi } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { formatMeasuredPlanForecast } from "./todo_dispatch";
import syntheticPlan from "./fixtures/churndep-plan.json";
import { waitChainDemands } from "./lead_time_notes";
import { wakeDemand } from "./dispatch_wake";

afterEach(() => vi.restoreAllMocks());

test("returned findings demand reconciliation rather than automatic restaffing", () => {
  const phases = [{ name: "Geometry", tasks: [{ content: "Cooling route", status: "in_progress", schedule: {
    dependencies: [], owner: "Proof", executor: { workerId: "Proof", agentProfile: "researcher", startedAt: 1, finishedAt: 2, outcome: "completed" },
  } }] }];
  const demand = wakeDemand(phases, new Set(), Date.now());
  expect(demand.action).toContain("agent://Proof");
  expect(demand.action).toContain("Read the full worker output");
  expect(demand.action).toContain("retire a disproved approach as failed/superseded");
  expect(demand.action).toContain("retirement is not success");
  expect(demand.action).not.toContain("Dispatch a worker");
  // A live worker's actual question takes priority over old findings.
  expect(wakeDemand(phases, new Set(["Proof"]), Date.now(), undefined, undefined,
    [{ worker: "Proof", question: "Which existing renderer owns the route?" }]).action).toContain("Which existing renderer owns the route?");
});

async function harness(journal = [], chain = false, healthy = false, deadlineEnabled = true, onSend = undefined) {
  const hooks = new Map();
  const sent = [];
  const timers = [];
  const intervals = [];
  const tools = new Map();
  let requirement;
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
  const api = { registerSoftToolRequirementProvider: fn => { requirement = fn; }, typebox: { Type }, registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => hooks.set(name, fn), getActiveTools: () => ["todo", "task"],
    appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
    sendMessage: (message, options) => {
      const emission = { ...message, options };
      sent.push(emission);
      onSend?.(emission);
    },
    pi: { ...schedule, getLatestTodoPhasesFromEntries, readGoalDeadline: () => deadlineEnabled ? ({ goalId: "wake", deadlineAt: now - 6 * 3600000 }) : undefined, agentPauseGate: { paused: false } },
  };
  const ctx = { cwd: "/tmp/omp-wake-test", sessionManager: { getHeader: () => ({ id: "wake" }),
    getBranch: () => journal, getBranchMatching: predicate => journal.filter(predicate), getLatestBranchMatching: predicate => journal.findLast(predicate), getSessionFile: () => undefined },
    getTodoPhases: () => phases, getTodoSnapshot: () => phases,
    getAsyncJobSnapshot: () => jobs, getTaskMaxConcurrency: () => 6,
    getTodoPreviewConfig: () => ({ enabled: false, paths: [], openReviewPages: false }),
    isIdle: () => true, hasPendingMessages: () => false,
    setTimeout: fn => { timers.push(fn); return {}; }, clearTimer: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return {}; },
  };
  await todoDispatch(api);
  const wake = async () => { await hooks.get("agent_end")({}, ctx); await timers.pop()?.(); const message = sent.findLast(message => message.options?.triggerTurn); if (message) await hooks.get("message_start")({ message: { role: "custom", ...message } }, ctx); };
  return { hooks, ctx, sent, phases, jobs, journal, wake, tools, intervals, requirement: () => requirement };
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
  expect(resumed.sent.some(message => message.options?.triggerTurn)).toBe(false);
  const next = resumed.sent.findLast(message => message.details?.actionDemand);
  expect(next.content).toContain("ESCALATED");
  expect(next.content).toContain("PR 114 acceptance");
});

test("passive demand advice cannot schedule another turn or starve a queued peer", async () => {
  const mock = createMockModel({ handler: { content: ["ack"] } });
  const agent = new Agent({ initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] }, streamFn: mock.stream });
  await agent.prompt("current turn");
  const h = await harness();
  agent.followUp({ role: "user", content: "older IRC peer", timestamp: Date.now() });
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  const demands = h.sent.filter(message => message.customType === "todo-dispatch-action-required");
  expect(demands).toHaveLength(2);
  for (const message of demands) expect(message.options).toMatchObject({ deliverAs: "aside", triggerTurn: false, interruptWait: false });
  await agent.continue();
  expect(mock.calls.at(-1).context.messages.filter(message => message.role === "user").at(-1).content).toBe("older IRC peer");
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
  expect(resumed.sent.some(message => message.options?.triggerTurn)).toBe(false);
  expect(resumed.sent.findLast(message => message.details?.actionDemand)?.content).toContain("ESCALATED");
  expect(resumed.sent.findLast(message => message.details?.actionDemand)?.content).toContain("Collateral2");
  // A slot-only edge is removed by a real todo mutation, preserving the rest of the graph.
  resumed.phases[0].tasks[1].schedule.dependencies = [];
  await resumed.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, resumed.ctx);
  await resumed.hooks.get("turn_end")({}, resumed.ctx);
  expect(resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data).toMatchObject({ misses: 0, mutations: 1 });
});

test("real chain dependencies can be rejected with a persisted per-link reason, changed graphs rearm review", async () => {
  const h = await harness([], true, false, false);
  await h.hooks.get("turn_start")({}, h.ctx);
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
  const resumed = await harness(h.journal, true, false, false);
  resumed.phases[0].tasks[0].schedule.progress = structuredClone(head.schedule.progress);
  await resumed.hooks.get("turn_start")({}, resumed.ctx);
  expect(resumed.sent.filter(message => message.content.includes("WAIT-CHAIN REVIEW"))).toEqual([]);
  expect(resumed.sent.some(message => message.options?.triggerTurn)).toBe(false);
  resumed.phases[0].tasks[4].schedule.dependencies.push("Labels");
  await resumed.hooks.get("turn_start")({}, resumed.ctx);
  expect(resumed.sent.findLast(message => message.customType === "todo-dispatch-action-required")?.content).toContain("WAIT-CHAIN REVIEW");
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

test("measured forecast needs no deadline and does not discharge an idle staffing demand", async () => {
  let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const h = await harness([], false, true, false);
  h.phases[0].tasks.push({ content: "Completed slice", status: "pending" });
  await h.hooks.get("turn_start")({}, h.ctx);
  const tool = h.tools.get("todo_dispatch_forecast");
  await expect(tool.execute("f", {}, undefined, undefined, h.ctx)).rejects.toThrow("No measured pace window");
  now += 60_000;
  h.phases[0].tasks[1].status = "completed";
  const result = await tool.execute("f", {}, undefined, undefined, h.ctx);
  expect(result.details.forecast).toMatchObject({ rowsPerHour: 60, completed: 1, open: 1, eta: now + 60_000 });
  expect(result.content[0].text).toContain("60.00 rows/h");
  expect(result.content[0].text).toContain("Remaining TODO rows: 1");
  expect(result.content[0].text).not.toContain(String(now));
  let receipt = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
  expect(receipt.recovery.forecast).toMatchObject({ rowsPerHour: 60, open: 1 });
  expect(receipt.recovery.pending).toBeUndefined();
  expect(receipt.recovery.satisfied).toBeUndefined();
  now += 600_000;
  await h.hooks.get("turn_start")({}, h.ctx);
  receipt = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
  const pending = structuredClone(receipt.recovery.pending);
  expect(pending.kind).toBe("idle");
  const resumed = await harness(h.journal, false, true, false);
  resumed.phases[0].tasks.push({ content: "Completed slice", status: "completed" });
  await resumed.tools.get("todo_dispatch_forecast").execute("f", {}, undefined, undefined, resumed.ctx);
  receipt = resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
  expect(receipt.recovery.forecast.from).toBe(now - 660_000);
  expect(receipt.recovery.pending).toEqual(pending);
  expect(receipt.recovery.satisfied).toBeUndefined();
});

test("measured forecast renders the captured window and next-day finish in the user's timezone", () => {
  const forecast = { at: 1794311619903, from: 1794306218667, completed: 5, rowsPerHour: 3.3325705449641525, open: 34, eta: 1794348348307.8 };
  const deadline = Date.parse("2026-11-10T18:00:00Z");
  const text = formatMeasuredPlanForecast(forecast, "Asia/Tbilisi", deadline);
  expect(text).toContain("At this pace: 2026-11-11 02:05:48 Asia/Tbilisi (10.2 h remaining)");
  expect(text).toContain("Completed TODO rows: 5 in 1.50 h (3.33 rows/h)");
  expect(text).toContain("from 2026-11-10 14:23:38 Asia/Tbilisi to 2026-11-10 15:53:39 Asia/Tbilisi");
  expect(text).toContain("Remaining TODO rows: 34");
  expect(text).toContain("Deadline: 2026-11-10 22:00:00 Asia/Tbilisi (after deadline)");
  expect(text).toContain("Throughput extrapolation");
  expect(text).not.toContain(String(forecast.at));
  const within = formatMeasuredPlanForecast(forecast, "UTC", forecast.eta);
  expect(within).toContain("2026-11-10 22:05:48 UTC");
  expect(within).toContain("within deadline");
  expect(formatMeasuredPlanForecast(forecast, "Asia/Tbilisi")).not.toContain("Deadline:");
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

test("minute scheduler retries a pending demand once per minute across reload without ignored turns", async () => {
  let now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now);
  const h = await harness([], true, false, false);
  await h.hooks.get("session_start")({}, h.ctx);
  const tick = h.intervals.find(interval => interval.ms === 60_000).fn;
  await tick();
  const wakes = () => h.sent.filter(message => message.options?.triggerTurn && message.details?.actionDemand);
  expect(wakes()).toHaveLength(1);
  await tick();
  expect(wakes()).toHaveLength(1);
  const resumed = await harness(h.journal, true, false, false);
  await resumed.hooks.get("session_start")({}, resumed.ctx);
  const resumedTick = resumed.intervals.find(interval => interval.ms === 60_000).fn;
  await resumedTick();
  expect(resumed.sent.filter(message => message.options?.triggerTurn && message.details?.actionDemand)).toHaveLength(0);
  now += 60_000;
  await resumedTick();
  expect(resumed.sent.filter(message => message.options?.triggerTurn && message.details?.actionDemand)).toHaveLength(1);
});

test("a busy lead keeps demand queued without spending its idle wake allowance", async () => {
  const h = await harness([], true);
  let idle = false;
  h.ctx.isIdle = () => idle;
  await h.hooks.get("session_start")({}, h.ctx);
  const tick = h.intervals.find(interval => interval.ms === 60_000).fn;
  await tick();
  expect(h.sent.some(message => message.options?.triggerTurn)).toBe(false);
  expect(h.journal.some(entry => entry.customType === "todo-dispatch-action-wake")).toBe(false);
  idle = true;
  await tick();
  expect(h.sent.filter(message => message.options?.triggerTurn && message.details?.actionDemand)).toHaveLength(1);
  // A different dependency graph is a new obligation and can wake immediately.
  h.phases[0].tasks[1].schedule.dependencies.push("Collateral2");
  await tick();
  const wakes = h.sent.filter(message => message.options?.triggerTurn && message.details?.actionDemand);
  expect(wakes).toHaveLength(2);
  expect(wakes[0].details.actionDemandKey).not.toBe(wakes[1].details.actionDemandKey);
});

function powerChain(h) {
  const estimate = h.phases[0].tasks[0].schedule.estimate;
  h.phases[0].tasks = [
    { content: "Power", status: "pending", schedule: { dependencies: ["Cooling"], cumulativeReestimateCount: 6, estimate } },
    { content: "Cooling", status: "pending", schedule: { dependencies: ["Commit"], estimate } },
    { content: "Commit", status: "in_progress", schedule: { dependencies: [], owner: "Writer", executor: { workerId: "Writer", startedAt: Date.now() }, estimate } },
  ];
  h.jobs.running.push({ id: "Writer", type: "task", status: "running", startTime: Date.now() });
}

test("dependency-held Power CHURN stays silent, then rearms and escalates after Cooling finishes", async () => {
  const h = await harness([], false, false, false);
  await h.hooks.get("turn_start")({}, h.ctx);
  h.sent.length = 0; h.journal.length = 0;
  powerChain(h);
  for (let i = 0; i < 3; i++) { await h.hooks.get("turn_start")({}, h.ctx); await h.hooks.get("turn_end")({}, h.ctx); }
  expect(h.sent.filter(m => m.details?.actionDemand || m.customType === "todo-dispatch-action-required")).toEqual([]);
  expect(h.journal.filter(e => e.customType === "todo-dispatch-action-demand" && e.data.misses > 0)).toEqual([]);
  expect(h.sent.some(m => m.content.includes("CHURN:"))).toBe(false);
  h.jobs.running = [];
  h.phases[0].tasks[2].status = "completed";
  await h.hooks.get("turn_end")({}, h.ctx);
  await h.hooks.get("turn_start")({}, h.ctx);
  const notices = h.sent.filter(m => m.customType === "todo-dependency-wait");
  expect(notices).toHaveLength(1);
  expect(notices[0].content).toContain("Power <- Cooling");
  expect(h.sent.findLast(m => m.customType === "todo-dispatch-action-required")?.content).toContain("Dispatch a worker for Cooling");
  await h.hooks.get("turn_start")({}, h.ctx);
  expect(h.sent.filter(m => m.customType === "todo-dependency-wait")).toHaveLength(1);
  h.phases[0].tasks[1].status = "completed";
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(e => e.customType === "todo-dispatch-action-demand").data.misses).toBe(1);
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.sent.findLast(m => m.customType === "todo-dispatch-action-required").content).toContain("ESCALATED");
  expect(h.sent.findLast(m => m.customType === "todo-dispatch-action-required").content).toContain("Resolve the acceptance failure on Power");
});

test("new dependency suspends an escalated CHURN counter, including after reload", async () => {
  const h = await harness([], false, false, false);
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(e => e.customType === "todo-dispatch-action-demand").data.misses).toBe(2);
  h.phases[0].tasks[0].schedule.dependencies = ["Commit"];
  h.phases[0].tasks.push({ content: "Commit", status: "in_progress", schedule: { owner: "Writer", dependencies: [] } });
  h.jobs.running.push({ id: "Writer", type: "task", status: "running" });
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(e => e.customType === "todo-dispatch-action-demand").data.misses).toBe(0);
  const resumed = await harness(h.journal, false, false, false);
  resumed.phases.splice(0, resumed.phases.length, ...structuredClone(h.phases));
  resumed.jobs.running.push(...structuredClone(h.jobs.running));
  await resumed.hooks.get("turn_start")({}, resumed.ctx);
  await resumed.hooks.get("turn_end")({}, resumed.ctx);
  expect(resumed.journal.findLast(e => e.customType === "todo-dispatch-action-demand").data.misses).toBe(0);
  expect(resumed.sent.filter(message => message.customType === "todo-dispatch-action-required")).toEqual([]);
  resumed.phases[0].tasks[1].status = "completed";
  resumed.jobs.running = [];
  await resumed.hooks.get("turn_start")({}, resumed.ctx);
  await resumed.hooks.get("turn_end")({}, resumed.ctx);
  expect(resumed.journal.findLast(e => e.customType === "todo-dispatch-action-demand").data.misses).toBe(1);
});

test("synthetic chain: an hour of blocked CHURN cannot accrue demands; releasing prerequisites reactivates recovery", async () => {
  let now = Date.parse(syntheticPlan.asOf);
  spyOn(Date, "now").mockImplementation(() => now);
  const h = await harness([], true, false, false);
  await h.hooks.get("turn_start")({}, h.ctx);
  h.phases.splice(0, h.phases.length, ...structuredClone(syntheticPlan.phases));
  const rows = h.phases.flatMap(p => p.tasks);
  const power = rows.find(r => r.content === "Row A");
  const cooling = rows.find(r => r.content === power.schedule.dependencies[0]);
  const commit = rows.find(r => r.content === cooling.schedule.dependencies[0]);
  h.jobs.running.push({ id: commit.schedule.executor.workerId, type: "task", status: "running", startTime: commit.schedule.executor.startedAt });
  h.sent.length = 0; h.journal.length = 0;
  for (let minute = 0; minute < 60; minute++) {
    now += 60000;
    await h.hooks.get("turn_end")({}, h.ctx);
  }
  const demands = h.journal.filter(e => e.customType === "todo-dispatch-action-demand" && e.data.misses > 0);
  const powerDemands = demands.filter(e => e.data.action.startsWith(`Split or cut scope on ${power.content}`) || e.data.action.startsWith(`WAIT-CHAIN REVIEW: ${power.content} `));
  expect(powerDemands).toHaveLength(0);
  // Retain recovery on the root; completing it must expose Cooling, then Power.
  expect(h.jobs.running[0].id).toBe(commit.schedule.executor.workerId);
  commit.status = "completed"; h.jobs.running = [];
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(e => e.customType === "todo-dispatch-action-demand").data.action).toContain(cooling.content);
  cooling.status = "completed";
  // Other blocked CHURN rows remain waiting; the original Power acceptance becomes actionable.
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(e => e.customType === "todo-dispatch-action-demand").data.action).toStartWith(`Resolve the acceptance failure on ${power.content}`);
});


test("slipped row cannot demand dispatch through unfinished dependencies while the root is staffed", async () => {
  const h = await harness([], false, true, false);
  powerChain(h);
  h.phases[0].tasks[0].schedule.cumulativeReestimateCount = 0;
  expect(wakeDemand(h.phases, new Set(["Writer"]), Date.now(), Date.now() - 60000)).toBeUndefined();
  h.phases[0].tasks[2].status = "completed";
  h.phases[0].tasks[1].status = "completed";
  const demand = wakeDemand(h.phases, new Set(), Date.now(), Date.now() - 60000);
  expect(demand.action).toContain("Dispatch a worker for Power");
});

for (const broken of ["missing", "cyclic"]) {
  test(`staffed prerequisite stays silent while its ${broken} sibling gets an executable repair notice`, async () => {
    const h = await harness([], false, false, false);
    await h.wake();
    h.sent.length = 0; h.journal.length = 0;
    powerChain(h);
    h.phases[0].tasks[0].schedule.dependencies.push("Broken prerequisite");
    if (broken === "cyclic") h.phases[0].tasks.push({
      content: "Broken prerequisite", status: "pending", schedule: { dependencies: ["Power"] },
    });
    await h.hooks.get("turn_start")({}, h.ctx);
    await h.hooks.get("turn_end")({}, h.ctx);
    const notices = h.sent.filter(m => m.customType === "todo-dependency-wait" && m.details?.row === "Power");
    expect(notices).toHaveLength(1);
    expect(notices[0].details.paths).toEqual([
      broken === "missing" ? "Power <- Broken prerequisite" : "Power <- Broken prerequisite <- Power",
    ]);
    expect(notices[0].content).toContain("use todo");
    expect(notices[0].content).toContain("repair a missing/cyclic dependency");
    expect(notices[0].content).not.toContain("Cooling");
    expect(notices[0].content).not.toContain("Commit");
    await h.hooks.get("turn_start")({}, h.ctx);
    await h.hooks.get("turn_end")({}, h.ctx);
    expect(h.sent.filter(m => m.customType === "todo-dependency-wait" && m.details?.row === "Power")).toHaveLength(1);
  });
}


test("deleted idle demand no longer blocks wait after reload", async () => {
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const h = await harness([], false, true, false);
    await h.hooks.get("turn_start")({}, h.ctx);
    now += 600000;
    await h.hooks.get("turn_start")({}, h.ctx);
    expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.recovery.pending.kind).toBe("idle");
    h.phases[0].tasks[0].status = "completed";
    h.phases[0].tasks.push({ content: "Another task", status: "pending", schedule: { dependencies: [] } });
    await h.hooks.get("turn_start")({}, h.ctx);
    const receipt = h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
    expect(receipt.recovery.pending?.row).not.toBe("PR 114 acceptance");
    h.jobs.running.push({ id: "LiveWorker", label: "Another task", type: "task", status: "running", startTime: now });
    const result = await h.hooks.get("tool_call")({ toolName: "wait", input: {} }, h.ctx);
    expect(result?.block).not.toBe(true);
  } finally { clock.mockRestore(); }
});

test("deadline escalation permits waiting on a live owned job without clearing recovery", async () => {
  const h = await harness([], false, true);
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.misses).toBeGreaterThanOrEqual(2);
  const waiting = { toolName: "wait", input: {} };
  expect((await h.hooks.get("tool_call")(waiting, h.ctx))?.block).toBe(true);
  h.jobs.running.push({ id: "ShortlistCleanup", type: "task", status: "running", queued: false });
  const liveResult = await h.hooks.get("tool_call")(waiting, h.ctx);
  expect(liveResult?.block).not.toBe(true);
  expect(h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.recovery.pending.kind).toBe("deadline");
  h.jobs.running[0].status = "completed";
  expect((await h.hooks.get("tool_call")(waiting, h.ctx))?.block).toBe(true);
});

test("delivered CHURN chain permits waiting for its active audit, then rearms on audit failure", async () => {
  const h = await harness([], true, false, false);
  const head = h.phases[0].tasks[0];
  head.status = "in_progress";
  head.schedule.executor = { workerId: "DeliveryWriter", startedAt: 100, finishedAt: 200, outcome: "completed" };
  head.schedule.resources = [`git:/tmp/acceptance@${"a".repeat(40)}`];
  head.schedule.audit = { delivery: schedule.todoRowDeliveryKey(head.schedule), agent: "qa-auditor", verdict: "pending", repoPath: "/tmp/acceptance", head: "a".repeat(40), workerId: "ActiveVerifier" };
  h.jobs.running.push({ id: "ActiveVerifier", type: "task", status: "running", startTime: Date.now() });
  for (let i = 0; i < 3; i++) {
    await h.hooks.get("turn_start")({}, h.ctx);
    await h.hooks.get("turn_end")({}, h.ctx);
  }
  const waitResult = await h.hooks.get("tool_call")({ toolName: "wait", input: {} }, h.ctx);
  expect(waitResult?.reason).toBeUndefined();
  expect(h.sent.filter(m => m.customType === "todo-dispatch-action-required")).toEqual([]);
  expect(wakeDemand(h.phases, new Set(["ActiveVerifier"]), Date.now())).toBeUndefined();
  head.schedule.audit.verdict = "fail";
  head.schedule.audit.findings = "Delivered output fails acceptance";
  h.jobs.running = [];
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(h.journal.findLast(e => e.customType === "todo-dispatch-action-demand").data.action).toContain("WAIT-CHAIN REVIEW");
});


test("schedule refusal survives audit progress replacement and reload, then exposes idle staffing", async () => {
  let now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now);
  const h = await harness([], true, false, false);
  await h.hooks.get("turn_start")({}, h.ctx);
  now += 600000;
  await h.hooks.get("turn_start")({}, h.ctx);
  const chain = waitChainDemands(h.phases)[0];
  const evidence = `Dependency review ${chain.key}:\n${chain.edges.map(edge => `${edge.task} <- ${edge.dependency}: consumes required output`).join("\n")}`;
  // Replay successful todo schedule, then the audit receipt that owns its evidence.
  const entries = [{ type: "custom", customType: "user_todo_edit", data: { phases: structuredClone(h.phases) } },
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { edit: { v: 1, kind: "op", op: "schedule", at: now, params: { op: "schedule", updates: [{ task: chain.row, evidence }] } } } } }];
  let phases = getLatestTodoPhasesFromEntries(entries);
  expect(phases[0].tasks[0].schedule.progress.evidence).toBe(evidence);
  entries.push({ type: "custom", customType: "user_todo_edit", data: { edit: { v: 1, kind: "schedule_patch", at: now + 1, task: chain.row, patch: {
    audit: { delivery: "delivery", verdict: "inconclusive", agent: "qa-auditor", evidence },
    progress: { at: now + 1, evidence: "Audit assignment needs repository reconciliation" },
  } } } });
  phases = getLatestTodoPhasesFromEntries(entries);
  h.phases.splice(0, h.phases.length, ...phases);
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  const resumed = await harness(h.journal, true, false, false);
  resumed.phases.splice(0, resumed.phases.length, ...getLatestTodoPhasesFromEntries(entries));
  await resumed.hooks.get("turn_start")({}, resumed.ctx);
  const next = resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
  expect(next.key).not.toContain(chain.key);
  expect(next.recovery.pending.kind).toBe("idle");
  expect(next.action).toContain("Staff it");
  resumed.phases[0].tasks[4].schedule.dependencies.push("Labels");
  await resumed.hooks.get("turn_start")({}, resumed.ctx);
  expect(resumed.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data.action).toContain("WAIT-CHAIN REVIEW");
});


test("reads preserve no-action recovery and ignored wakes back off, with one visible notice per key across reload", async () => {
  let now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now);
  const h = await harness([], true, false, false);
  await h.hooks.get("session_start")({}, h.ctx);
  now += 600000;
  await h.hooks.get("turn_start")({}, h.ctx);
  const tick = h.intervals.find(interval => interval.ms === 60_000).fn;
  const receipt = () => h.journal.findLast(entry => entry.customType === "todo-dispatch-action-demand").data;
  for (const [index, delay] of [60000, 120000, 240000, 480000, 900000, 900000].entries()) {
    await h.hooks.get("turn_start")({}, h.ctx);
    await h.hooks.get("tool_call")({ toolName: "read", input: { path: "notes" } }, h.ctx);
    await h.hooks.get("tool_result")({ toolName: "read", input: {}, content: [], isError: false }, h.ctx);
    if (index >= 3) {
      const requirement = h.requirement()(h.ctx);
      expect(requirement.escalationToolChoice).toBe("required");
      expect(requirement.satisfies({ name: "read" })).toBe(true);
      expect(requirement.toolName).toBe("task");
    }
    await h.hooks.get("turn_end")({}, h.ctx);
    expect(receipt().noToolMisses).toBe(index + 1);
    expect(receipt().retryAt - now).toBe(delay);
    const count = h.sent.filter(m => m.options?.triggerTurn).length;
    now += delay - 1;
    await tick();
    expect(h.sent.filter(m => m.options?.triggerTurn)).toHaveLength(count);
    now += 1;
    await tick();
    expect(h.sent.filter(m => m.options?.triggerTurn)).toHaveLength(count + 1);
    await tick();
    expect(h.sent.filter(m => m.options?.triggerTurn)).toHaveLength(count + 1);
  }
  const notices = h.sent.filter(m => m.customType === "todo-dispatch-ignored");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ display: true });
  expect(notices[0].content).toContain(receipt().key);
  const resumed = await harness(h.journal, true, false, false);
  await resumed.hooks.get("turn_start")({}, resumed.ctx);
  await resumed.hooks.get("turn_end")({}, resumed.ctx);
  expect(resumed.sent.filter(m => m.customType === "todo-dispatch-ignored")).toHaveLength(0);
  await h.hooks.get("input")({ source: "user", text: "continue" }, h.ctx);
  expect(receipt()).toMatchObject({ misses: 0, noToolMisses: 0, retryAt: undefined });
  const beforeHumanWake = h.sent.filter(m => m.options?.triggerTurn).length;
  await tick();
  expect(h.sent.filter(m => m.options?.triggerTurn)).toHaveLength(beforeHumanWake + 1);
  // A changed graph has a fresh demand and no inherited delay.
  h.phases[0].tasks[4].schedule.dependencies.push("Labels");
  await tick();
  await h.hooks.get("turn_start")({}, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(receipt()).toMatchObject({ misses: 1, noToolMisses: 1 });
  // A real edge removal is counted and clears retry state.
  h.phases[0].tasks[4].schedule.dependencies.pop();
  await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, content: [], isError: false }, h.ctx);
  await h.hooks.get("turn_end")({}, h.ctx);
  expect(receipt()).toMatchObject({ misses: 0, noToolMisses: 0, mutations: 1, retryAt: undefined });
});
