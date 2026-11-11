// @ts-nocheck -- copied Reemxy extension runtime is covered by hook-level behavior tests.
import { expect, setSystemTime, test } from "bun:test";
import { readGoalDeadline } from "./deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { sessionContextEntryMetadata, type SessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan, type TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch, { branchRetroReceiptIds, readPersistedSprintState, SPRINT_STATE_ENTRY_TYPE } from "./todo_dispatch";

function branchMock(getBranch: () => unknown[]) {
  return {
    getBranch,
    getBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) => getBranch().filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
    getLatestBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) => getBranch().findLast(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
  };
}

const sdk = { forecastTodoPlan, formatPlanForecast, formatTaskForecast, readGoalDeadline, getLatestTodoPhasesFromEntries };
const liveNow = Date.UTC(2026, 8, 26, 10, 0, 0);
const row = (content: string, status: string = "pending") => ({
  content,
  status,
  schedule: { dependencies: [], estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "retro fixture", updatedAt: liveNow } },
});

async function fixture(initial: TodoScheduleInput, jobs: unknown[], deadlineAt = liveNow - 1, sharedBranch?: unknown[]) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const branch: unknown[] = sharedBranch ?? [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: initial } } }];
  const state = { plan: initial };
  let recent = jobs;
  let running: unknown[] = [];
  const intervals: Array<() => void> = [];
  const notices: string[] = [];
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task"],
    appendEntry: (customType: string, data?: unknown) => branch.push({ type: "custom", customType, data }),
      sendMessage: (message: { customType?: string; content: string; details?: unknown; attribution?: string; display?: boolean }) => {
        notices.push(message.content);
        branch.push({ type: "custom_message", ...message, timestamp: new Date().toISOString() });
      },
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "retro-test", deadlineAt }) },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/retro-test",
    sessionManager: { getHeader: () => ({ id: "root" }), ...branchMock(() => branch) },
    getAsyncJobSnapshot: () => ({ running, recent, nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 6,
    hasPendingMessages: () => false,
    setInterval: (fn: () => void) => { intervals.push(fn); return fn as unknown as ReturnType<typeof setInterval>; },
    clearInterval: () => undefined,
  } as unknown as ExtensionContext;
  const check = async (phases: TodoScheduleInput = state.plan) => {
    const result = (await handlers.get("tool_result")!({ toolName: "todo", toolCallId: "retro-check", isError: false, content: [{ type: "text", text: "schedule" }], details: { phases } }, ctx)) as { content: Array<{ text?: string }> } | undefined;
    return result?.content.map((part) => part.text ?? "").join("\n") ?? "";
  };
  const dispatch = async (name: string, agent = "retro-facilitator") => (await handlers.get("tool_call")!({ toolName: "task", toolCallId: `call-${name}`, input: { tasks: [{ name, agent, task: "facilitate" }] } }, ctx));
  const finish = async (agent = "retro-facilitator", isError = false) => (await handlers.get("tool_result")!({ toolName: "task", toolCallId: "retro-task", isError, details: { results: [{ id: "retro-receipt", agent, exitCode: isError ? 1 : 0, durationMs: 1000 }] } }, ctx));
  const result = async (toolCallId: string, results: unknown) => (await handlers.get("tool_result")!({ toolName: "task", toolCallId, isError: false, details: { results } }, ctx));
  return { handlers, branch, ctx, check, finish, dispatch, result, setPlan: (next: TodoScheduleInput) => { state.plan = next; }, setJobs: (next: unknown[]) => { recent = next; }, setRunning: (next: unknown[]) => { running = next; }, intervals, notices };
}

const workers = [
  { id: "done-a", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
];
const stateOf = (f) => f.branch.findLast(entry => entry.customType === SPRINT_STATE_ENTRY_TYPE)?.data;

// These used to create unsolicited retrospective notices and, after enough ticks,
// prevent the lead from dispatching ordinary product work.
test.each(["deadline", "correction", "reopened row", "repeated failure", "redispatch", "missed ETA", "updater rejection", "gate rejection", "failed todo update", "empty result", "substituted result"])("%s never demands an unsolicited retrospective", async (incident) => {
  setSystemTime(new Date(liveNow));
  try {
    const initial = [{ name: "Work", tasks: [row("Ship feature", incident === "reopened row" ? "completed" : "pending")] }];
    const f = await fixture(initial, workers, incident === "deadline" ? liveNow - 1 : liveNow + 24 * 60 * 60_000);
    await f.check();
    if (incident === "correction") await f.handlers.get("input")!({ source: "interactive", text: "не то, переделай" }, f.ctx);
    if (incident === "reopened row") f.setPlan([{ name: "Work", tasks: [row("Ship feature")] }]);
    if (incident === "repeated failure") f.setJobs([...workers, ...[1, 2].map(i => ({ id: `failed-${i}`, type: "task", status: "failed", label: "Ship feature", agentId: `failed-worker-${i}` }))]);
    if (incident === "redispatch") f.setPlan([{ name: "Work", tasks: [{ ...row("Ship feature", "in_progress"), schedule: { ...row("Ship feature").schedule, owner: "Fix-3", attemptHistory: [{ workerName: "Fix" }, { workerName: "Fix-2" }] } }] }]);
    if (incident === "missed ETA") f.setPlan([{ name: "Work", tasks: [{ ...row("Ship feature", "in_progress"), schedule: { ...row("Ship feature").schedule, startedAt: liveNow - 200_000, estimate: { ...row("Ship feature").schedule.estimate, updatedAt: liveNow - 200_000 } } }] }]);
    if (incident === "updater rejection") f.setJobs([...workers, { id: "InstallCandidate", type: "task", status: "completed", label: "Install candidate", result: { installExit: 1, status: "blocked" } }]);
    if (incident === "gate rejection" || incident === "failed todo update") await f.handlers.get("tool_result")!({ toolName: incident === "gate rejection" ? "bash" : "todo", toolCallId: "failed-call", isError: true, content: [{ type: "text", text: incident === "gate rejection" ? "Blocked: chief-no-bash requires a worker" : "Invalid todo update" }] }, f.ctx);
    if (incident === "empty result" || incident === "substituted result") {
      await f.dispatch("ShipFeature", "coder");
      await f.result("call-ShipFeature", incident === "empty result" ? [] : [{ agent: "someone-else", exitCode: 0 }]);
    }
    for (let tick = 0; tick < 4; tick++) expect(await f.check()).not.toContain("retrospective due");
    await f.handlers.get("turn_end")!({ toolResults: [] }, f.ctx);
    expect(JSON.stringify(f.notices)).not.toContain("retrospective due");
    expect(stateOf(f).retroDueReason).toBeNull();
    expect(stateOf(f).ignoredDemands.retro).toBeUndefined();
  } finally { setSystemTime(); }
});

test("reload retires automatic demand state while preserving explicit retro history and other enforcement", () => {
  const state = readPersistedSprintState([{ customType: SPRINT_STATE_ENTRY_TYPE, data: {
    version: 1, correctionPending: true, retroDueReason: "repeated failure", retroDueDeadlineAt: liveNow,
    retroDueDeliveryKey: "old-delivery", retroDueNotifiedKey: "old-notice", ignoredDemands: { retro: 6, "todo-link": 3 },
    retroFacilitatorJobs: ["RequestedRetro"], retroReceiptIds: ["prior-receipt"], retroCoveredIds: ["worker-a"], lastRetroAt: liveNow - 1,
  } }]);
  expect(state.retroDueReason).toBeNull();
  expect(state.correctionPending).toBe(false);
  expect(state.retroDueDeadlineAt).toBeUndefined();
  expect(state.retroDueDeliveryKey).toBeUndefined();
  expect(state.retroDueNotifiedKey).toBeUndefined();
  expect(state.ignoredDemands).toEqual({ "todo-link": 3 });
  expect(state.retroFacilitatorJobs).toEqual(["RequestedRetro"]);
  expect(state.retroReceiptIds).toEqual(["prior-receipt"]);
  expect(state.retroCoveredIds).toEqual(["worker-a"]);
  expect(state.lastRetroAt).toBe(liveNow - 1);
});

test("explicit facilitator result records its receipt and covered workers once", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [...workers,
      { id: "abort", type: "task", status: "cancelled", agentId: "aborted-worker" },
      { id: "quota", type: "task", status: "failed", agentId: "quota-worker" },
    ]);
    await f.check();
    await f.dispatch("RequestedRetro");
    expect(stateOf(f).retroFacilitatorJobs).toEqual(["RequestedRetro"]);
    await f.finish();
    const finished = stateOf(f);
    expect(finished.lastRetroAt).toBe(liveNow);
    expect(finished.retroReceiptIds).toEqual(["retro-receipt"]);
    expect(finished.retroCoveredIds).toEqual(["worker-a"]);
    expect(finished.retroFacilitatorJobs).toEqual([]);
    expect(finished.workerFinishes.map(worker => worker.id)).toEqual(["worker-a"]);
    await f.finish();
    expect(stateOf(f).retroReceiptIds).toEqual(["retro-receipt"]);
  } finally { setSystemTime(); }
});

test("an explicit async facilitator settles after reload using its dispatched identity", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const plan = [{ name: "Work", tasks: [row("Ship feature")] }];
    const a = await fixture(plan, workers);
    await a.check();
    await a.dispatch("RequestedRetro");
    const b = await fixture(plan, workers, liveNow - 1, a.branch);
    await b.handlers.get("session_branch")!({}, b.ctx);
    b.setJobs([...workers, { id: "async-retro-job", type: "task", status: "completed", label: "RequestedRetro", startTime: liveNow - 1000, agentId: "RequestedRetro" }]);
    await b.check();
    expect(stateOf(b).lastRetroAt).toBe(liveNow);
    expect(stateOf(b).retroCoveredIds).toEqual(["worker-a"]);
    expect(stateOf(b).retroFacilitatorJobs).toEqual([]);
    setSystemTime(new Date(liveNow + 1_000));
    await b.check();
    expect(stateOf(b).lastRetroAt).toBe(liveNow);
  } finally { setSystemTime(); }
});

test.each(["failed", "unrelated"])("a %s job never completes an explicit facilitator", async (kind) => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    await f.check();
    await f.dispatch("RequestedRetro");
    f.setJobs([...workers, { id: "other-job", type: "task", status: kind === "failed" ? "failed" : "completed", label: kind === "failed" ? "RequestedRetro" : "SomeOtherWork", agentId: kind === "failed" ? "RequestedRetro" : "SomeOtherWork" }]);
    await f.check();
    expect(stateOf(f).lastRetroAt).toBeNull();
    expect(stateOf(f).retroFacilitatorJobs).toEqual(["RequestedRetro"]);
  } finally { setSystemTime(); }
});

test("an explicit background facilitator receipt settles once across reload", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const plan = [{ name: "Work", tasks: [row("Ship feature")] }];
    const f = await fixture(plan, workers);
    await f.check();
    f.branch.push({ type: "custom_message", customType: "async-result", content: '<task-result id="requested-retro" agent="retro-facilitator" status="completed">done</task-result>' });
    await f.check();
    expect(stateOf(f).retroReceiptIds).toEqual(["requested-retro"]);
    expect(stateOf(f).retroCoveredIds).toEqual(["worker-a"]);
    const g = await fixture(plan, workers, liveNow - 1, f.branch);
    await g.handlers.get("session_branch")!({}, g.ctx);
    setSystemTime(new Date(liveNow + 1_000));
    await g.check();
    expect(stateOf(g).lastRetroAt).toBe(liveNow);
    expect(stateOf(g).retroReceiptIds).toEqual(["requested-retro"]);
  } finally { setSystemTime(); }
});

test("task settlement preserves worker feedback without scheduling a retro", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], []);
    const job = { id: "install-hook", type: "task", status: "completed", label: "Install candidate", startTime: liveNow - 3000, agentId: "installer", result: { install_exit: 1 } };
    await f.result("install-call", [job]);
    expect(stateOf(f).seenJobIds).toEqual([job.id]);
    expect(stateOf(f).workerFinishes).toEqual([{ jobId: job.id, id: "installer", at: job.startTime, row: job.label }]);
    f.setJobs([job]);
    await f.check();
    expect(stateOf(f).workerFinishes).toHaveLength(1);
    expect(stateOf(f).retroDueReason).toBeNull();
  } finally { setSystemTime(); }
});

test("periodic retro receipt lookup uses the indexed 500-entry tail", () => {
  const history = Array.from({ length: 300_000 }, () => ({ type: "custom", customType: "unrelated" }));
  history.push({ type: "custom_message", content: '<task-result id="retro-1" agent="retro-facilitator" status="completed">done</task-result>' });
  let visited = 0;
  const ctx = { sessionManager: {
    getBranch: () => { throw new Error("periodic receipt lookup decoded the whole branch"); },
    getBranchMatching: () => { throw new Error("periodic receipt lookup walked the whole branch"); },
    getBranchTailMatching: (limit, predicate) => history.slice(-limit).filter(entry => { visited++; return predicate(sessionContextEntryMetadata(entry)); }),
  } } as unknown as ExtensionContext;
  for (let turn = 0; turn < 10; turn++) expect(branchRetroReceiptIds(ctx)).toEqual(["retro-1"]);
  expect(visited).toBe(5_000);
});
