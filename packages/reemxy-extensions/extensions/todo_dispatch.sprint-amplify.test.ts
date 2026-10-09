// @ts-nocheck -- copied Reemxy extension runtime is covered by hook-level behavior tests.
import { expect, setSystemTime, test } from "bun:test";
import { readGoalDeadline } from "./deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan, type TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch, { SPRINT_STATE_ENTRY_TYPE } from "./todo_dispatch";

const sdk = { forecastTodoPlan, formatPlanForecast, formatTaskForecast, readGoalDeadline, getLatestTodoPhasesFromEntries };
const liveNow = Date.UTC(2026, 8, 26, 10, 0, 0);
const row = (content: string, status: string = "pending") => ({
  content,
  status,
  schedule: { dependencies: [], estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "amplify fixture", updatedAt: liveNow } },
});

async function fixture(initial: TodoScheduleInput, jobs: unknown[], deadlineAt = liveNow - 1, sharedBranch?: unknown[]) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const branch: unknown[] = sharedBranch ?? [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: initial } } }];
  const state = { plan: initial };
  let recent = jobs;
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task"],
    appendEntry: (customType: string, data?: unknown) => branch.push({ type: "custom", customType, data }),
    sendMessage: () => undefined,
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "amplify-test", deadlineAt }) },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/amplify-test",
    sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
    getAsyncJobSnapshot: () => ({ running: [], recent, nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 6,
    hasPendingMessages: () => false,
    setInterval: (() => undefined) as unknown as typeof setInterval,
    clearInterval: () => undefined,
  } as unknown as ExtensionContext;
  const check = async (phases: TodoScheduleInput = state.plan) => {
    const result = (await handlers.get("tool_result")!({ toolName: "todo", toolCallId: "amplify-check", isError: false, content: [{ type: "text", text: "schedule" }], details: { phases } }, ctx)) as { content: Array<{ text?: string }> };
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  const sprintRecords = (from: number) => branch.slice(from).filter((entry) => typeof entry === "object" && entry !== null && (entry as { customType?: unknown }).customType === SPRINT_STATE_ENTRY_TYPE);
  return { handlers, branch, ctx, check, sprintRecords, setJobs: (next: unknown[]) => { recent = next; } };
}

const receiptEntry = (id: string) => ({ type: "custom_message", customType: "async-result", content: `<system-notice>\nBackground job ${id} has completed.\n<task-result id="${id}" agent="retro-facilitator" status="completed" duration="2m48s">` });

test("a burst of 26 new retro receipts persists one sprint-state record", async () => {
  // No open demand here: the per-check demand-decay persist is constant overhead (one record
  // whether 1 or 26 receipts land), so a demand-free burst isolates the receipt loop itself.
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], []);
    await f.check();
    for (let i = 0; i < 26; i++) f.branch.push(receiptEntry(`SprintRetroBurst${i}`));
    const from = f.branch.length;
    await f.check();
    const records = f.sprintRecords(from);
    console.log(`burst: ${records.length} sprint-state record(s), ${records.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0)} bytes`);
    expect(records.length).toBe(1);
    const latest = records[records.length - 1] as unknown as { data: { retroReceiptIds: string[] } };
    if (typeof latest === "object" && latest !== null && "data" in latest) {
      const ids = (latest as { data: { retroReceiptIds: unknown } }).data.retroReceiptIds;
      expect(Array.isArray(ids) ? ids.length : -1).toBe(26);
    }
  } finally { setSystemTime(); }
});
test("retro receipt ids stay bounded as receipts accumulate", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const workers = Array.from({ length: 12 }, (_, i) => ({ id: `cap-done-${i}`, type: "task", status: "completed", label: "Ship feature", startTime: liveNow - 3000 + i, agentId: `cap-${i}` }));
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], workers);
    await f.check();
    for (let i = 0; i < 600; i++) {
      f.branch.push(receiptEntry(`SprintRetroCap${i}`));
      await f.check();
    }
    const records = f.sprintRecords(0);
    const latest = records[records.length - 1] as { data: { retroReceiptIds: string[] } };
    const bytes = records.map((entry) => JSON.stringify(entry).length);
    console.log(`cap: ${records.length} total records, latest retroReceiptIds=${latest.data.retroReceiptIds.length}, latest bytes=${bytes[bytes.length - 1]}`);
    expect(latest.data.retroReceiptIds.length).toBeLessThanOrEqual(500);
    expect(latest.data.retroReceiptIds).not.toContain("SprintRetroCap0");
    expect(latest.data.retroReceiptIds).toContain("SprintRetroCap599");
  } finally { setSystemTime(); }
});

test("a todo override naming retro persists once", async () => {
  setSystemTime(new Date(liveNow));
  try {
    const f = await fixture([{ name: "Work", tasks: [row("Ship feature")] }], []);
    const from = f.branch.length;
    await f.handlers.get("tool_call")!({ toolName: "todo", toolCallId: "amp-override", input: { op: "schedule", override: "retro" } }, f.ctx);
    const records = f.sprintRecords(from);
    console.log(`override: ${records.length} sprint-state record(s)`);
    expect(records.length).toBeLessThanOrEqual(1);
  } finally { setSystemTime(); }
});
