// @ts-nocheck -- copied Reemxy extension runtime is covered by hook-level behavior tests.
import { expect, setSystemTime, test } from "bun:test";
import { readGoalDeadline } from "./deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan, type TodoScheduleInput } from "./todo-schedule";
import todoDispatch from "./todo_dispatch";

const sdk = { forecastTodoPlan, formatPlanForecast, formatTaskForecast, readGoalDeadline, getLatestTodoPhasesFromEntries };
const liveNow = Date.UTC(2026, 8, 26, 10, 0, 0);
const row = (content: string, status: string = "pending") => ({
  content,
  status,
  schedule: { dependencies: [], estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "retro fixture", updatedAt: liveNow } },
});

async function fixture(initial: TodoScheduleInput, jobs: unknown[]) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const branch: unknown[] = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: initial } } }];
  let plan = initial;
  let deadlineAt = liveNow - 1;
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
  const check = (phases: TodoScheduleInput = plan) => {
    const result = handlers.get("tool_result")!({ toolName: "todo", toolCallId: "retro-check", isError: false, content: [{ type: "text", text: "schedule" }], details: { phases } }, ctx) as { content: Array<{ text?: string }> };
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  const dispatch = (name: string, agent = "retro-facilitator") => handlers.get("tool_call")!({ toolName: "task", toolCallId: `call-${name}`, input: { tasks: [{ name, agent, task: "facilitate" }] } }, ctx);
  const finish = (agent = "retro-facilitator", isError = false) => handlers.get("tool_result")!({ toolName: "task", toolCallId: "retro-task", isError, details: { results: [{ agent, exitCode: 0, durationMs: 1000 }] } }, ctx);
  return { handlers, branch, ctx, check, finish, dispatch, setPlan: (next: TodoScheduleInput) => { plan = next; }, setJobs: (next: unknown[]) => { recent = next; }, intervals, notices };
}

test("successful retro-facilitator settlement clears stale due on the next PLAN CHECK", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [
      { id: "done-a", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
      { id: "done-b", type: "task", status: "completed", label: "Review feature", startTime: liveNow - 2000, agentId: "worker-b" },
    ]);
    expect(f.check()).toContain("retrospective due (deadline passed)");
    f.finish();
    const after = f.check();
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
    const notice = f.check();
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
    const repeated = [f.check(), f.check(), f.check()].filter((text) => text.includes("retrospective due"));
    expect(repeated).toHaveLength(1);
    f.setPlan([{ name: "Work", tasks: [row("Ship feature"), row("New delivery window")] }]);
    f.setJobs([{ id: "new-done", type: "task", status: "completed", label: "New delivery window", startTime: liveNow + 1, agentId: "worker-b" }]);
    const afterNewWindow = f.check();
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
    expect(f.check()).toContain("retrospective due");
    f.dispatch("SprintRetro");
    f.setJobs([...workers, { id: "SprintRetro", type: "task", status: "completed", label: "SprintRetro", startTime: liveNow - 1000, agentId: "SprintRetro" }]);
    const after = f.check();
    expect(after).not.toContain("retrospective due");
    expect(after).not.toContain("SprintRetro");
  } finally { setSystemTime(); }
});

test("an async retro-facilitator that failed does not clear the due notice", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const workers = [
      { id: "done-a", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "worker-a" },
    ];
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    f.check();
    f.dispatch("SprintRetro");
    f.setJobs([...workers, { id: "SprintRetro", type: "task", status: "failed", label: "SprintRetro", startTime: liveNow - 1000, agentId: "SprintRetro" }]);
    // The trigger is unchanged, so the once-per-trigger notice stays quiet; the state must still be due.
    f.setJobs([...workers, { id: "SprintRetro", type: "task", status: "failed", label: "SprintRetro", startTime: liveNow - 1000, agentId: "SprintRetro" },
      { id: "done-b", type: "task", status: "completed", label: "More work", startTime: liveNow - 500, agentId: "worker-b" }]);
    expect(f.check()).toContain("retrospective due");
  } finally { setSystemTime(); }
});

test("workers that failed on provider errors are not retro participants", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], [
      { id: "done", type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000, agentId: "completed-worker" },
      { id: "quota", type: "task", status: "failed", label: "RetraceExporterEstimateGap", startTime: liveNow - 2000, agentId: "quota-worker" },
    ]);
    const notice = f.check();
    expect(notice).toContain("completed-worker");
    expect(notice).not.toContain("quota-worker");
  } finally { setSystemTime(); }
});
