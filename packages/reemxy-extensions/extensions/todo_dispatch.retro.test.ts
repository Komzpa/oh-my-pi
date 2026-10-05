// @ts-nocheck -- copied Reemxy extension runtime is covered by hook-level behavior tests.
import { expect, setSystemTime, test } from "bun:test";
import { readGoalDeadline } from "./deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan, type TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch from "./todo_dispatch";

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
  const intervals: Array<() => void> = [];
  const notices: string[] = [];
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task"],
    appendEntry: (customType: string, data?: unknown) => branch.push({ type: "custom", customType, data }),
    sendMessage: (message: { content: string }) => notices.push(message.content),
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "retro-test", deadlineAt }) },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/retro-test",
    sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
    getAsyncJobSnapshot: () => ({ running: [], recent, nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 6,
    hasPendingMessages: () => false,
    setInterval: (fn: () => void) => { intervals.push(fn); return fn as unknown as ReturnType<typeof setInterval>; },
    clearInterval: () => undefined,
  } as unknown as ExtensionContext;
  const check = async (phases: TodoScheduleInput = state.plan) => {
    const result = (await handlers.get("tool_result")!({ toolName: "todo", toolCallId: "retro-check", isError: false, content: [{ type: "text", text: "schedule" }], details: { phases } }, ctx)) as { content: Array<{ text?: string }> };
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  const dispatch = async (name: string, agent = "retro-facilitator") => (await handlers.get("tool_call")!({ toolName: "task", toolCallId: `call-${name}`, input: { tasks: [{ name, agent, task: "facilitate" }] } }, ctx));
  const finish = async (agent = "retro-facilitator", isError = false) => (await handlers.get("tool_result")!({ toolName: "task", toolCallId: "retro-task", isError, details: { results: [{ agent, exitCode: 0, durationMs: 1000 }] } }, ctx));
  return { handlers, branch, ctx, check, finish, dispatch, setPlan: (next: TodoScheduleInput) => { state.plan = next; }, setJobs: (next: unknown[]) => { recent = next; }, intervals, notices };
}

test("a retro-facilitator that completes after a reload still records the completed-retro boundary", async () => {
  // A restart between dispatch and settlement used to forget the retro ran (the facilitator-name Set
  // was in-memory only), so `retrospective due` kept relisting the same workers. Grievances 551..669.
  setSystemTime(new Date(liveNow));
  try {
    const workers = [
      { id: "done-a", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
    ];
    const a = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    expect((await a.check())).toContain("retrospective due");
    (await a.dispatch("SprintRetro"));
    // Restart/reload: a new extension instance on the same session branch.
    const b = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers, liveNow - 1, a.branch);
    await b.handlers.get("session_branch")!({}, b.ctx);
    b.setJobs([...workers, { id: "SprintRetro", type: "task", status: "completed", label: "SprintRetro", startTime: liveNow - 1000, agentId: "SprintRetro" }]);
    const after = (await b.check());
    expect(after).not.toContain("retrospective due");
    expect(after).not.toContain("SprintRetro");
    expect(after).not.toContain("worker-a");
  } finally { setSystemTime(); }
});

test("a new worker finishing after the remembered retro re-opens the notice for its own cohort", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const workers = [
      { id: "done-a", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
    ];
    const a = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    expect((await a.check())).toContain("retrospective due");
    (await a.dispatch("SprintRetro"));
    const b = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers, liveNow - 1, a.branch);
    await b.handlers.get("session_branch")!({}, b.ctx);
    b.setJobs([...workers, { id: "SprintRetro", type: "task", status: "completed", label: "SprintRetro", startTime: liveNow - 1000, agentId: "SprintRetro" }]);
    expect((await b.check())).not.toContain("retrospective due");
    // A genuinely new worker finishes after the boundary: its window lists it, not the old cohort.
    // The deadline is already handled, so only a fresh goal-work window re-opens the notice.
    setSystemTime(new Date(liveNow + 3 * 60 * 60_000 + 60_000));
    b.setJobs([{ id: "done-c", type: "task", status: "completed", label: "Ship feature", startTime: liveNow + 3 * 60 * 60_000, agentId: "worker-c" }]);
    const again = (await b.check());
    expect(again).toContain("retrospective due");
    expect(again).toContain("worker-c");
    expect(again).not.toContain("worker-a");
  } finally { setSystemTime(); }
});

test("successful retro-facilitator settlement clears stale due on the next PLAN CHECK", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [
      { id: "done-a", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
      { id: "done-b", type: "task", status: "completed", label: "Review feature", startTime: liveNow - 2000, agentId: "worker-b" },
    ]);
    expect((await f.check())).toContain("retrospective due (deadline passed)");
    (await f.finish());
    const after = (await f.check());
    expect(after).not.toContain("retrospective due");
    expect(after).not.toContain("worker-a");
    expect(after).not.toContain("worker-b");
  } finally { setSystemTime(); }
});

test("aborted worker is excluded while completed worker remains a retro participant", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [
      { id: "done", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "completed-worker" },
      { id: "abort", type: "task", status: "cancelled", label: "ShapeHamburgerRailToggle", startTime: liveNow - 2000, agentId: "aborted-worker" },
    ]);
    const notice = (await f.check());
    expect(notice).toContain("completed-worker");
    expect(notice).not.toContain("aborted-worker");
    expect(notice).not.toContain("ShapeHamburgerRailToggle");
  } finally { setSystemTime(); }
});

test("unchanged skipped retro trigger notifies once until a genuinely new window", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [
      { id: "done", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
    ]);
    // A real PLAN CHECK is the trigger; leave the due work unresolved, as when the suggested
    // retrospective was skipped. Repeated checks must not resend the same trigger notice; the
    // embedded PLAN CHECK text in the todo tool_result is the real notice channel, not sendMessage.
    const repeated = [(await f.check()), (await f.check()), (await f.check())].filter((text) => text.includes("retrospective due"));
    expect(repeated).toHaveLength(1);
    f.setPlan([{ name: "Work", tasks: [row("Ship feature"), row("New delivery window")] }]);
    f.setJobs([{ id: "new-done", type: "task", status: "completed", label: "New delivery window", startTime: liveNow + 1, agentId: "worker-b" }]);
    const afterNewWindow = (await f.check());
    expect(afterNewWindow).toContain("retrospective due");
    expect(afterNewWindow).toContain("worker-b");
  } finally { setSystemTime(); }
});

test("an async retro-facilitator that settles through wait clears the due notice", async () => {
  // Live 2026-09-25..26: 627 "retrospective due" notices; the facilitator finished as an async job,
  // no task tool_result carried details.results, and the notice came back 4 s later.
  setSystemTime(new Date(liveNow));
  try {
    const workers = [
      { id: "done-a", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
    ];
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    expect((await f.check())).toContain("retrospective due");
    (await f.dispatch("SprintRetro"));
    f.setJobs([...workers, { id: "SprintRetro", type: "task", status: "completed", label: "SprintRetro", startTime: liveNow - 1000, agentId: "SprintRetro" }]);
    const after = (await f.check());
    expect(after).not.toContain("retrospective due");
    expect(after).not.toContain("SprintRetro");
  } finally { setSystemTime(); }
});
test("an async background retro receipt clears the demand and never relists covered workers", async () => {
  // Live pts4 2026-10-04..05: SynthesizeRetro0057 completed as a background job (an async-result
  // branch entry, no task tool_result, never in the job snapshot), so finishRetro never ran and
  // `retrospective due` kept relisting the same 12 workers (commit 5e8b4752).
  setSystemTime(new Date(liveNow));
  try {
    const workers = Array.from({ length: 12 }, (_, i) => ({ id: `orig-done-${i}`, type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000 + i, agentId: `orig-${i}` }));
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    const due = await f.check();
    expect(due).toContain("retrospective due");
    expect(due).toContain("orig-0");
    f.branch.push({ type: "custom_message", customType: "async-result", content: '<system-notice>\nBackground job SprintRetro0057 has completed.\n<task-result id="SprintRetro0057" agent="retro-facilitator" status="completed" duration="2m48s">' });
    const after = await f.check();
    expect(after).not.toContain("retrospective due");
    expect(after).not.toContain("orig-0");
    // Restoring the persisted state (restart) must not resurrect the demand.
    const g = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers, liveNow - 1, f.branch);
    await g.handlers.get("session_branch")!({}, g.ctx);
    expect(await g.check()).not.toContain("retrospective due");
    // Twelve genuinely new workers re-open the notice for their own cohort only.
    setSystemTime(new Date(liveNow + 3 * 60 * 60_000 + 60_000));
    g.setJobs(Array.from({ length: 12 }, (_, i) => ({ id: `fresh-done-${i}`, type: "task", status: "completed", label: "Ship feature", startTime: liveNow + 3 * 60 * 60_000 + i, agentId: `fresh-${i}` })));
    const again = await g.check();
    expect(again).toContain("retrospective due");
    expect(again).toContain("fresh-0");
    expect(again).not.toContain("orig-0");
  } finally { setSystemTime(); }
});

test("twelve new workers with no retro still demand one", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const workers = Array.from({ length: 12 }, (_, i) => ({ id: `solo-done-${i}`, type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000 + i, agentId: `solo-${i}` }));
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    const due = await f.check();
    expect(due).toContain("retrospective due");
    expect(due).toContain("solo-0");
  } finally { setSystemTime(); }
});

test("an async retro-facilitator that failed does not clear the due notice", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const workers = [
      { id: "done-a", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
    ];
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    (await f.check());
    (await f.dispatch("SprintRetro"));
    f.setJobs([...workers, { id: "SprintRetro", type: "task", status: "failed", label: "SprintRetro", startTime: liveNow - 1000, agentId: "SprintRetro" }]);
    // The trigger is unchanged, so the once-per-trigger notice stays quiet; the state must still be due.
    f.setJobs([...workers, { id: "SprintRetro", type: "task", status: "failed", label: "SprintRetro", startTime: liveNow - 1000, agentId: "SprintRetro" },
      { id: "done-b", type: "task", status: "completed", label: "More work", startTime: liveNow - 500, agentId: "worker-b" }]);
    expect((await f.check())).toContain("retrospective due");
  } finally { setSystemTime(); }
});

test("workers that failed on provider errors are not retro participants", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [
      { id: "done", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "completed-worker" },
      { id: "quota", type: "task", status: "failed", label: "RetraceExporterEstimateGap", startTime: liveNow - 2000, agentId: "quota-worker" },
    ]);
    const notice = (await f.check());
    expect(notice).toContain("completed-worker");
    expect(notice).not.toContain("quota-worker");
  } finally { setSystemTime(); }
});

test.each([
  ["так. давай объясняй на чём всё блядь застряло", false],
  ["не только X", false],
  ["э блядь мы блеклистили ж этого линга", false],
  ["я же просил не трогать", true],
  ["не то, переделай", true],
  ["это худший вариант", false],
  ["не тактичный ответ и поопять", false],
  ["НЕ ТАК, исправь", true],
  ["опять сломалось", true],
])("user correction retro classification: %s", async (text, due) => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [
      { id: "done", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 1000, agentId: "worker-a" },
    ], liveNow + 60_000);
    await f.handlers.get("input")!({ type: "input", source: "interactive", text }, f.ctx);
    const notice = await f.check();
    if (due) expect(notice).toContain("retrospective due (user correction)");
    else expect(notice).not.toContain("retrospective due");
  } finally { setSystemTime(); }
});

test.each([
  [{ type: "input", source: "interactive", text: "продолжай", images: [{ type: "image", data: "я же просил", mimeType: "image/png" }] }, false],
  [{ type: "input", source: "extension", text: "я же просил не трогать" }, false],
  [{ type: "input", source: "rpc", text: "я же просил не трогать" }, true],
])("user correction retro uses only user text: %j", async (event, due) => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [
      { id: "done", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 1000, agentId: "worker-a" },
    ], liveNow + 60_000);
    await f.handlers.get("input")!(event, f.ctx);
    const notice = await f.check();
    if (due) expect(notice).toContain("retrospective due (user correction)");
    else expect(notice).not.toContain("retrospective due");
  } finally { setSystemTime(); }
});
