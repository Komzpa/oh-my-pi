// @ts-nocheck -- exercises the extension through its registered runtime hooks.
import { expect, test } from "bun:test";
import { decideTodoDispatch, deliveredRowsClosed, OWNER_WAIT_REFUSAL, waitsOnOwner, acceptedSpeculativeMergeDemand, estimateFloorRefusal, firstDeliveryCutRequired, missedEtaRowsText, missingSpeculativeReview, SPRINT_STATE_ENTRY_TYPE, successfulDurationFloors, userUnblockAskDue, workerPastForecast } from "./todo_dispatch";
import todoDispatch from "./todo_dispatch";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatPlanForecast, formatTaskForecast, formatTaskForecastDisplay, forecastTodoPlan, getTodoPlanningIssues } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { readGoalDeadline } from "./deadlines";

const now = Date.now();

test("a newly assigned worker is not blamed for an earlier plan miss", () => {
  expect(workerPastForecast(now - 60_000, now - 5_000, now)).toBe(false);
  expect(workerPastForecast(now - 60_000, now - 120_000, now)).toBe(true);
  expect(workerPastForecast(now + 60_000, now - 120_000, now)).toBe(false);
  expect(workerPastForecast(now - 60_000, undefined, now)).toBe(true);
});

function estimateRow(content: string, overrides = {}) {
  return {
    content,
    status: "in_progress" as const,
    schedule: {
      owner: "RepairOne",
      dependencies: [],
      attemptHistory: [],
      executor: { workerId: "RepairOne", agentProfile: "coder", startedAt: now - 60_000 },
      estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium" as const, basis: "prior", updatedAt: now - 60_000 },
      startedAt: now - 60_000,
      ...overrides,
    },
  };
}

test("estimate floor refuses below the owner's successful p50 and accepts the floor", () => {
  const floors = successfulDurationFloors([
    JSON.stringify({ kind: "outcome", agent: "coder", status: "completed", durationMs: 120_000 }),
    JSON.stringify({ kind: "outcome", agent: "coder", status: "completed", durationMs: 180_000 }),
    JSON.stringify({ kind: "outcome", agent: "coder", status: "failed", durationMs: 999_000 }),
  ]);
  const row = estimateRow("Small implementation");
  const make = (likelySeconds: number) => [{ task: row.content, estimate: { likelySeconds } }];
  const refused = estimateFloorRefusal(make(120), forecastTodoPlan([{ name: "Work", tasks: [row] }], { now }).rows, floors, now);
  expect(refused).toContain("below 3m");
  expect(refused).toContain("coder profile p50");
  expect(estimateFloorRefusal(make(180), forecastTodoPlan([{ name: "Work", tasks: [row] }], { now }).rows, floors, now)).toBeUndefined();
});

test("evidence-based remaining work may be shorter than full-task profile median", () => {
  const floors = successfulDurationFloors([
    JSON.stringify({ kind: "outcome", agent: "coder", status: "completed", durationMs: 900_000 }),
  ]);
  const row = estimateRow("Finish facility panel", { startedAt: now - 18 * 60_000 });
  const rows = forecastTodoPlan([{ name: "Work", tasks: [row] }], { now }).rows;
  const update = { task: row.content, evidence: "Panel implemented; nine minutes remain to verify the mobile layout", estimate: { likelySeconds: 540, basis: "Measured remaining work" } };
  expect(estimateFloorRefusal([update], rows, floors, now)).toBeUndefined();
  expect(estimateFloorRefusal([{ ...update, evidence: undefined }], rows, floors, now)).toContain("below 15m");
  const earlyRow = estimateRow("Early panel", { startedAt: now - 4 * 60_000 });
  const early = forecastTodoPlan([{ name: "Work", tasks: [earlyRow] }], { now }).rows;
  expect(estimateFloorRefusal([{ ...update, task: earlyRow.content }], early, floors, now)).toContain("below 11m");
});

test("retry uses the previous attempt's measured duration, not a multiplied estimate", () => {
  const floors = successfulDurationFloors([JSON.stringify({ kind: "outcome", agent: "coder", status: "completed", durationMs: 60_000 })]);
  const row = estimateRow("Redo implementation", { attemptHistory: [{ attemptId: "1", durationMs: 180_000 }] });
  const rows = forecastTodoPlan([{ name: "Work", tasks: [row] }], { now }).rows;
  const refusal = estimateFloorRefusal([{ task: row.content, estimate: { likelySeconds: 179 } }], rows, floors, now);
  expect(refusal).toContain("below 3m");
  expect(refusal).toContain("Redo implementation");
  expect(refusal).toContain('"op":"schedule"');
  expect(estimateFloorRefusal([{ task: row.content, estimate: { likelySeconds: 180 } }], rows, floors, now)).toBeUndefined();
});

test("an overdue first attempt does not manufacture a retry duration", () => {
  const floors = successfulDurationFloors([JSON.stringify({ kind: "outcome", agent: "coder", status: "completed", durationMs: 60_000 })]);
  const row = estimateRow("Overdue original attempt", { startedAt: now - 10 * 60_000, estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "prior", updatedAt: now - 10 * 60_000 } });
  const rows = forecastTodoPlan([{ name: "Work", tasks: [row] }], { now }).rows;
  expect(rows[0].overdue).toBe(true);
  expect(estimateFloorRefusal([{ task: row.content, evidence: "Remaining work measured", estimate: { likelySeconds: 180 } }], rows, floors, now)).toBeUndefined();
});

test("a schedule that only ratifies elapsed time is refused without evidence", () => {
  const floors = successfulDurationFloors([JSON.stringify({ kind: "outcome", agent: "coder", status: "completed", durationMs: 60_000 })]);
  const stale = now - 2_600 * 60_000;
  const row = estimateRow("Restore reader navigation", {
    startedAt: stale,
    estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "old", updatedAt: stale },
  });
  const rows = forecastTodoPlan([{ name: "Work", tasks: [row] }], { now }).rows;
  const refusal = estimateFloorRefusal([{ task: row.content, estimate: { likelySeconds: 2_596 * 60 } }], rows, floors, now);
  expect(refusal).toContain("only ratifies");
  expect(refusal).toContain("floor source");
  expect(estimateFloorRefusal([{ task: row.content, evidence: "New acceptance evidence", estimate: { likelySeconds: 2_596 * 60 } }], rows, floors, now)).toBeUndefined();
});

test("TODO forecast display shows user review and speculative dependency", () => {
  const phases = [{ name: "Work", tasks: [
    { ...estimateRow("Delivered UI"), status: "blocked" as const, schedule: { ...estimateRow("Delivered UI").schedule, review: "user" as const } },
    { ...estimateRow("Verify UI"), schedule: { ...estimateRow("Verify UI").schedule, speculativeOn: "Delivered UI" } },
  ] }];
  const rows = forecastTodoPlan(phases, { now }).rows;
  expect(formatTaskForecastDisplay(rows[0]!, now)).toContain("review: user");
  expect(formatTaskForecastDisplay(rows[1]!, now)).toContain("speculative on Delivered UI");
});

test("first handoff cut is required only when the earliest usable result misses 30 minutes or the user deadline", () => {
  const row = estimateRow("Ship the first visible slice") as never;
  const forecast = forecastTodoPlan([{ name: "Work", tasks: [row] }], { now }).rows[0]!;
  expect(firstDeliveryCutRequired([{ ...forecast, resourceFinish: now + 31 * 60_000 }], now, undefined, now)).toBeUndefined();
  expect(firstDeliveryCutRequired([{ ...forecast, schedule: { ...forecast.schedule, firstRequirementAt: now }, resourceFinish: now + 31 * 60_000 }], now, undefined, now)).toBe("Ship the first visible slice");
  expect(firstDeliveryCutRequired([{ ...forecast, schedule: { ...forecast.schedule, firstRequirementAt: now }, resourceFinish: now + 29 * 60_000 }], now, undefined, now)).toBeUndefined();
  expect(firstDeliveryCutRequired([{ ...forecast, schedule: { ...forecast.schedule, firstRequirementAt: now, firstDeliveredAt: now }, resourceFinish: now + 31 * 60_000 }], now, undefined, now)).toBeUndefined();
  expect(firstDeliveryCutRequired([{ ...forecast, schedule: { ...forecast.schedule, firstRequirementAt: now }, resourceFinish: now + 20 * 60_000 }], now, now + 10 * 60_000, now)).toBe("Ship the first visible slice");
});

test("missed ETA notice names every late row, owner, and overrun", () => {
  const rows = forecastTodoPlan([{ name: "Work", tasks: [estimateRow("Late A"), estimateRow("Late B")] }], { now }).rows;
  expect(missedEtaRowsText([
    { ...rows[0]!, overdue: true, owner: "OwnerA", resourceFinish: now - 17 * 60_000 },
    { ...rows[1]!, overdue: true, owner: "OwnerB", resourceFinish: now - 4 * 60_000 },
  ], now)).toContain('"Late A" OwnerA 17m over; "Late B" OwnerB 4m over');
});

function reviewPlan() {
  return [{ name: "Work", tasks: [
    { content: "Delivered UI", status: "blocked" as const, blocker: "waits for user: accept, redo, or drop", schedule: { owner: "Coder", review: "user" as const, dependencies: [], executor: { workerId: "Coder", startedAt: now } } },
    { content: "Verify UI", status: "pending" as const, schedule: { owner: "Verifier", dependencies: ["Delivered UI"] } },
    { content: "Independent docs", status: "pending" as const, schedule: { owner: "Docs", dependencies: [] } },
  ] }];
}

test("proof work proceeds only when marked speculative; independent work stays unblocked", () => {
  const phases = reviewPlan();
  expect(missingSpeculativeReview({ task: "Verify UI" }, phases)).toBe("Delivered UI");
  expect(missingSpeculativeReview({ task: "Independent docs" }, phases)).toBeUndefined();
  phases[0]!.tasks[1]!.schedule.speculativeOn = "Delivered UI";
  expect(missingSpeculativeReview({ task: "Verify UI" }, phases)).toBeUndefined();
  expect(forecastTodoPlan(phases, { now }).rows.find((row) => row.content === "Verify UI")?.ready).toBe(true);
});

test("explicit customer acceptance makes completed speculative results ready for delivery", async () => {
  const phases = reviewPlan();
  phases[0].tasks[1].status = "completed";
  phases[0].tasks[1].schedule.speculativeOn = "Delivered UI";
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  await recordReview(harness, "accepted");
  expect(acceptedSpeculativeMergeDemand(harness.phases())).toContain('NEXT ACTION: fast merge/publish "Verify UI"');
});

test("structured redo and drop preserve dependent work and attempt history", async () => {
  for (const verdict of ["redo", "drop"]) {
    const phases = reviewPlan();
    phases[0].tasks[1].schedule.speculativeOn = "Delivered UI";
    phases[0].tasks[1].schedule.attemptHistory = [{ attemptId: "1", terminalStatus: "completed", deliverablePaths: ["/tmp/kept-diff.patch"] }];
    const before = structuredClone(phases[0].tasks[1]);
    const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
    await recordReview(harness, verdict, "Move buttons to the left; preserve the output.");
    expect(harness.phases()[0].tasks[0].schedule.review).toBe(verdict);
    expect(harness.phases()[0].tasks[1].status).toBe(before.status);
    expect(harness.phases()[0].tasks[1].schedule.speculativeOn).toBe(before.schedule.speculativeOn);
    expect(harness.phases()[0].tasks[1].schedule.attemptHistory).toEqual(before.schedule.attemptHistory);
    expect(acceptedSpeculativeMergeDemand(harness.phases())).toBeUndefined();
  }
});

test("attempt two is held until its first result is handed off, then replays the customer's correction", async () => {
  const phases = [{ name: "Work", tasks: [{
    content: "Implement header navigation",
    status: "pending",
    schedule: { owner: "NavWorker", dependencies: [], attemptHistory: [{ attemptId: "1", terminalStatus: "completed" }] },
  }] }];
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const beforeHandoff = { tasks: [{ agent: "Coder", task: "Implement header navigation" }] };
  const refused = await harness.handlers.get("tool_call")!({ toolName: "task", input: beforeHandoff }, harness.ctx) as { reason?: string };
  expect(refused.reason).toContain("Hand attempt 1's result to the user first");
  harness.phases()[0].tasks[0].schedule.review = "user";
  harness.phases()[0].tasks[0].status = "blocked";
  await recordReview(harness, "redo", "redo Implement header navigation with the buttons left aligned", "Implement header navigation");
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("redo");
  const afterVerdict = { tasks: [{ agent: "Coder", task: "Implement header navigation" }] };
  const allowed = await harness.handlers.get("tool_call")!({ toolName: "task", input: afterVerdict }, harness.ctx) as { reason?: string } | undefined;
  expect(allowed?.reason).toBeUndefined();
  expect(afterVerdict.tasks[0].task).toContain("USER CORRECTION TO HONOR: redo Implement header navigation with the buttons left aligned");
});

test("user accept resolves review and demands fast publication of the dependent work", async () => {
  const phases = reviewPlan();
  phases[0]!.tasks[1]!.schedule.speculativeOn = "Delivered UI";
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  await recordReview(harness, "accepted");
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("accepted");
  expect(harness.sent.some((message) => String(message.content).includes("NEXT ACTION: fast merge/publish"))).toBe(true);
});

async function reviewHookHarness(initialPhases: unknown, jobs: unknown, branchEntries: unknown[] = [], finalText = "The worker finished.") {
  let phases = initialPhases;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: Array<Record<string, unknown>> = [];
  const sdk = { forecastTodoPlan, formatPlanForecast, formatTaskForecast, getTodoPlanningIssues, getLatestTodoPhasesFromEntries, readGoalDeadline };
  const api = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "write", "wait"],
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: (customType, data) => branchEntries.push({ type: "custom", customType, data }),
    sendMessage: (message: Record<string, unknown>) => sent.push(message),
    pi: { ...sdk, agentPauseGate: { paused: false } },
  };
  await todoDispatch(api as never);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getHeader: () => ({ id: "customer-review-test" }),
      getBranch: () => branchEntries,
      getBranchMatching: () => branchEntries,
      getLatestBranchMatching: () => undefined,
      getSessionFile: () => undefined,
    },
    getTodoPhases: () => structuredClone(phases),
    setTodoPhases: (next: unknown) => { phases = next; },
    updateTodoSchedule: (task, patch) => {
      const row = phases.flatMap(phase => phase.tasks).find(row => row.content === task);
      if (!row) return false;
      row.schedule = { ...row.schedule, ...structuredClone(patch) };
      return true;
    },
    getAsyncJobSnapshot: () => jobs,
    getTaskMaxConcurrency: () => 20,
    getLastAssistantText: () => finalText,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
    setInterval: () => ({}),
    clearInterval: () => undefined,
  };
  return { handlers, sent, phases: () => phases, ctx };
}

test("completed worker result becomes review:user and turn_end persists a user handoff", async () => {
  const harness = await reviewHookHarness(
    [{ name: "Work", tasks: [{ content: "Implement header navigation", status: "in_progress", schedule: { owner: "NavWorker", dependencies: [], startedAt: now - 5_000 } }] }],
    { running: [], recent: [{ id: "NavWorker", agentId: "NavWorker", type: "task", status: "completed", label: "Implement header navigation" }], nonJobAgents: [] },
  );
  await harness.handlers.get("tool_result")!({ toolName: "task", toolCallId: "done", isError: false, details: { results: [{ id: "NavWorker", status: "completed", output: "Implemented the header controls.\n\nUpdated src/reader-header.ts and commit abcdef123456." }] } }, harness.ctx);
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("user");
  expect(harness.sent.some((message) => message.display === true && String(message.content).includes("Changed: Updated src/reader-header.ts and commit abcdef123456."))).toBe(true);
  expect(harness.sent.some((message) => String(message.content).includes("Look at src/reader-header.ts, abcdef123456"))).toBe(true);
  await harness.handlers.get("turn_end")!({ toolResults: [] }, harness.ctx);
  expect(harness.sent.some((message) => String(message.content).startsWith("Handoff required:"))).toBe(true);
});

test("review reminder remains persisted without classifying assistant prose", async () => {
  const phases = [{ name: "Work", tasks: [{ content: "Implement header navigation", status: "blocked", blocker: "waits for user: accept, redo, or drop", schedule: { review: "user", dependencies: [] } }] }];
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] }, [], "Changed Implement header navigation. Look at src/reader-header.ts. Accept, redo, or drop?");
  await harness.handlers.get("turn_end")!({ toolResults: [] }, harness.ctx);
  expect(harness.sent.filter((message) => String(message.content).startsWith("Handoff required:"))).toHaveLength(1);
  await harness.handlers.get("turn_end")!({ toolResults: [] }, harness.ctx);
  expect(harness.sent.filter((message) => String(message.content).startsWith("Handoff required:"))).toHaveLength(1);
});

test("blocked user-unblock row is asked, and a recent persisted ask suppresses demand", async () => {
  const phases = [{ name: "Proof", tasks: [{ content: "Show the screenshot", status: "blocked", blocker: "waits for user: provide the visible screenshot", schedule: { dependencies: [] } }] }];
  const asked = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  await asked.handlers.get("turn_end")!({ toolResults: [] }, asked.ctx);
  expect(asked.sent.some((message) => String(message.content).includes("Ask the user now: Show the screenshot — provide the visible screenshot"))).toBe(true);
  const recent = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] }, [
    { type: "custom_message", customType: "todo-user-unblock", details: { row: "Show the screenshot", at: Date.now() } },
  ]);
  await recent.handlers.get("turn_end")!({ toolResults: [] }, recent.ctx);
  expect(recent.sent.some((message) => String(message.content).includes("Ask the user now: Show the screenshot"))).toBe(false);
  // Asked once per row: no timer re-asks it, however long it has been; only a later user message does.
  expect(userUnblockAskDue(Date.now() - 14 * 60_000, undefined)).toBe(false);
  expect(userUnblockAskDue(Date.now() - 15 * 60_000, undefined)).toBe(false);
  expect(userUnblockAskDue(Date.now() - 60 * 60_000, Date.now() - 61 * 60_000)).toBe(false);
  expect(userUnblockAskDue(Date.now() - 60 * 60_000, Date.now() - 1_000)).toBe(true);
  expect(userUnblockAskDue(undefined, undefined)).toBe(true);
});

test("missed ETA names every late owner, admits its rescheduled sibling task, and expires when no rows remain late", async () => {
  const startedAt = now - 60 * 60_000;
  const phases = [{ name: "Work", tasks: [
    { content: "Restore reader navigation", status: "in_progress", schedule: { owner: "NavWorker", dependencies: [], startedAt, estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "old", updatedAt: startedAt } } },
    { content: "Unrelated docs", status: "pending", schedule: { dependencies: [], estimate: { optimisticSeconds: 300, likelySeconds: 600, pessimisticSeconds: 900, confidence: "medium", basis: "docs", updatedAt: now } } },
  ] }];
  expect(forecastTodoPlan(phases as never, { now }).rows.find((row) => row.content === "Restore reader navigation")?.overdue).toBe(true);
  const branch = [{ type: "custom", customType: SPRINT_STATE_ENTRY_TYPE, data: { version: 1, ignoredDemands: { "missed-eta": 3 } } }];
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] }, branch);
  await harness.handlers.get("session_start")!({}, harness.ctx);
  const schedule = { op: "schedule", updates: [{ task: "Restore reader navigation", evidence: "One hour elapsed; 30 minutes of measured work remains", estimate: { optimisticSeconds: 900, likelySeconds: 1800, pessimisticSeconds: 2700, confidence: "low", basis: "measured remainder" } }] };
  expect(await harness.handlers.get("tool_call")!({ toolName: "todo", input: schedule }, harness.ctx)).toBeUndefined();
  harness.phases()[0].tasks[0].schedule.estimate = { ...schedule.updates[0].estimate, updatedAt: Date.now() };
  await harness.handlers.get("tool_result")!({ toolName: "todo", input: schedule, isError: false, details: { op: "schedule" } }, harness.ctx);
  await harness.handlers.get("message_start")!({ message: { role: "toolResult" } }, harness.ctx);
  const lateTask = { tasks: [{ agent: "Coder", task: "Restore reader navigation" }] };
  expect(await harness.handlers.get("tool_call")!({ toolName: "task", input: lateTask }, harness.ctx)).toBeUndefined();

  const noLate = await reviewHookHarness([{ name: "Work", tasks: [{ ...estimateRow("Fresh row"), status: "pending" }] }], { running: [], recent: [], nonJobAgents: [] }, branch);
  await noLate.handlers.get("session_start")!({}, noLate.ctx);
  expect(await noLate.handlers.get("tool_call")!({ toolName: "task", input: { tasks: [{ agent: "Coder", task: "Fresh row" }] } }, noLate.ctx)).toBeUndefined();
});


test("negated review words do not authorize publication or abandon dependent work", async () => {
  const phases = reviewPlan();
  phases[0].tasks[1].schedule.speculativeOn = "Delivered UI";
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  await harness.handlers.get("message_start")({ message: {
    role: "user", content: "Do not accept Delivered UI. Keep implementing while I look.", timestamp: Date.now(),
  } }, harness.ctx);
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("user");
  expect(harness.phases()[0].tasks[1].status).toBe("pending");
});

test("handed-off attempt can continue speculatively while the customer is absent", async () => {
  const phases = reviewPlan();
  phases[0].tasks[0].schedule.speculativeOn = "Delivered UI";
  phases[0].tasks[0].schedule.attemptHistory = [{ attemptId: "1", terminalStatus: "completed" }];
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const call = { tasks: [{ agent: "Coder", task: "Delivered UI" }] };
  const result = await harness.handlers.get("tool_call")({ toolName: "task", input: call }, harness.ctx);
  expect(result?.block).not.toBe(true);
  expect(call.tasks[0].task).toContain("SPECULATIVE");
});

async function recordReview(harness, verdict, evidence = "Customer decision recorded from the conversation", task = "Delivered UI") {
  const session = {
    cwd: process.cwd(), hasUI: false, getSessionFile: () => null,
    settings: Settings.isolated({}),
    getTodoPhases: () => harness.phases(),
    setTodoPhases: (phases) => harness.ctx.setTodoPhases(phases),
    persistTodoPhases: () => undefined,
  };
  const input = { op: "schedule", updates: [{ task, review: verdict, evidence }] };
  const result = await new TodoTool(session as never).execute("record-review", input);
  expect(result.isError).not.toBe(true);
  await harness.handlers.get("tool_result")({ toolName: "todo", input, ...result }, harness.ctx);
}


test("a fast older request cannot mask a late first slice for a newer requirement", () => {
  const forecast = forecastTodoPlan([{ name: "Work", tasks: [estimateRow("New requirement")] }], { now }).rows[0];
  const older = { ...forecast, content: "Older requirement", schedule: { ...forecast.schedule, firstRequirementAt: now - 60_000 }, resourceFinish: now + 5 * 60_000 };
  const newer = { ...forecast, schedule: { ...forecast.schedule, firstRequirementAt: now }, resourceFinish: now + 31 * 60_000 };
  expect(firstDeliveryCutRequired([older, newer], now, undefined, now)).toBe("New requirement");
  expect(firstDeliveryCutRequired([{ ...newer, schedule: { ...newer.schedule, firstDeliveredAt: now } }, newer], now, undefined, now)).toBeUndefined();
});


test("a blocked row whose exact question reached the customer does not demand another ask", async () => {
  const phases = [{ name: "Proof", tasks: [{ content: "Show the screenshot", status: "blocked", blocker: "waits for user: provide the visible screenshot", schedule: { dependencies: [] } }] }];
  const entries = [];
  const asked = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] }, entries, "Show the screenshot — provide the visible screenshot");
  await asked.handlers.get("turn_end")({}, asked.ctx);
  expect(asked.sent.some(message => String(message.content).includes("Ask the user now:"))).toBe(false);
  const resumed = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] }, entries);
  await resumed.handlers.get("turn_end")({}, resumed.ctx);
  expect(resumed.sent.some(message => String(message.content).includes("Ask the user now:"))).toBe(false);
});


test("pending review does not turn unrelated publication words into a blanket gate", async () => {
  const phases = reviewPlan();
  phases[0].tasks[1].schedule.speculativeOn = "Delivered UI";
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const result = await harness.handlers.get("tool_call")({ toolName: "task", input: { tasks: [{ agent: "Docs", task: "Independent docs: document the deploy command" }] } }, harness.ctx);
  expect(result?.block).not.toBe(true);
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("user");
});


test("acceptance does not demand publishing a worker that has not produced its speculative result", async () => {
  const phases = reviewPlan();
  phases[0].tasks[1].schedule.speculativeOn = "Delivered UI";
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  await recordReview(harness, "accepted");
  expect(acceptedSpeculativeMergeDemand(harness.phases())).toBeUndefined();
});


const LIVE_BLOCKER = "Awaiting Darafei's verdicts on the round-2 compare page";
function ownerWaitPlan() {
  return [{ name: "Work", tasks: [
    { content: "Compare page", status: "in_progress", schedule: { owner: "user-review", dependencies: [] } },
    { content: "Other row", status: "in_progress", schedule: { owner: "Coder", dependencies: [] } },
  ] }];
}

test("a todo block waiting on the owner is refused with the action-first text; the live shape included", async () => {
  const harness = await reviewHookHarness(ownerWaitPlan(), { running: [], recent: [], nonJobAgents: [] });
  const call = (input) => harness.handlers.get("tool_call")({ toolName: "todo", input }, harness.ctx);
  const live = await call({ op: "block", task: "Compare page", reason: LIVE_BLOCKER });
  expect(live?.block).toBe(true);
  expect(live.reason).toBe(OWNER_WAIT_REFUSAL);
  expect(live.reason).toStartWith("Proceed on your default; Darafei is never a dependency.");
  // The owner label alone is enough, whatever the reason says.
  expect((await call({ op: "block", task: "Compare page", reason: "round 2 is ready" }))?.block).toBe(true);
  // Neighbour: an ordinary external blocker is untouched.
  expect((await call({ op: "block", task: "Other row", reason: "CI queue is full" }))?.block).not.toBe(true);
});

test("a missionCritical row may wait on the owner, now or after being marked", async () => {
  const harness = await reviewHookHarness(ownerWaitPlan(), { running: [], recent: [], nonJobAgents: [] });
  const call = (input) => harness.handlers.get("tool_call")({ toolName: "todo", input }, harness.ctx);
  expect((await call({ op: "block", task: "Compare page", reason: LIVE_BLOCKER, missionCritical: "needs his hands: 2FA code" }))?.block).not.toBe(true);
  expect((await call({ op: "block", task: "Compare page", reason: LIVE_BLOCKER }))?.block).not.toBe(true);
  expect((await call({ op: "block", task: "Compare page", reason: LIVE_BLOCKER, missionCritical: "   " }))?.block).not.toBe(true);
  const blank = await reviewHookHarness(ownerWaitPlan(), { running: [], recent: [], nonJobAgents: [] });
  expect((await blank.handlers.get("tool_call")({ toolName: "todo", input: { op: "block", task: "Compare page", reason: LIVE_BLOCKER, missionCritical: "  " } }, blank.ctx))?.block).toBe(true);
});

test("a schedule update keeping an owner-blocked row blocked is refused unless missionCritical", async () => {
  const phases = ownerWaitPlan();
  phases[0].tasks[0].status = "blocked";
  phases[0].tasks[0].blocker = LIVE_BLOCKER;
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const call = (input) => harness.handlers.get("tool_call")({ toolName: "todo", input }, harness.ctx);
  expect((await call({ op: "schedule", updates: [{ task: "Compare page", evidence: "still waiting" }] }))?.block).toBe(true);
  expect((await call({ op: "schedule", updates: [{ task: "Other row", evidence: "fine" }] }))?.block).not.toBe(true);
  expect((await call({ op: "schedule", updates: [{ task: "Compare page", evidence: "irreversible publish", missionCritical: "public post, irreversible" }] }))?.block).not.toBe(true);
  expect(waitsOnOwner("Coder", "waiting for Darafei's reply")).toBe(true);
  expect(waitsOnOwner("Coder", "waiting for the CI reply")).toBe(false);
});

test("a delivered review:user row is closed for the HUD blocked count, dispatch and plan-check", async () => {
  const phases = reviewPlan();
  expect(phases[0].tasks[0].status).toBe("blocked");
  const closed = deliveredRowsClosed(phases);
  expect(closed[0].tasks[0].status).toBe("completed");
  expect(phases[0].tasks[0].status).toBe("blocked");
  const decide = (input) => decideTodoDispatch({ phases: input, jobs: { running: [], recent: [], nonJobAgents: [] }, isMainSession: true, taskEnabled: true, now, capacity: 4, dispatchGateAvailable: true }, { forecastTodoPlan, formatPlanForecast, formatTaskForecast });
  expect(decide(phases).staticPrompt).toContain("blocked=1");
  expect(decide(closed).staticPrompt).toContain("blocked=0");
  // Neighbour: a redo verdict is not closed any more; the row reopens with his words.
  const redo = reviewPlan();
  redo[0].tasks[0].schedule.review = "redo";
  redo[0].tasks[0].status = "pending";
  expect(deliveredRowsClosed(redo)[0].tasks[0].status).toBe("pending");
  const harness = await reviewHookHarness(reviewPlan(), { running: [], recent: [], nonJobAgents: [] });
  await recordReview(harness, "redo", "Not like this: the header must stay sticky");
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("redo");
  expect(harness.sent.some((message) => String(message.content).includes("Customer requested a change to Delivered UI: Not like this: the header must stay sticky"))).toBe(true);
});

test("the delivery notice is information, not a question, and the plan-check no longer demands a verdict", async () => {
  const phases = reviewPlan();
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  await harness.handlers.get("turn_end")({ toolResults: [] }, harness.ctx);
  const handoff = harness.sent.find((message) => String(message.content).startsWith("Handoff required:"));
  expect(String(handoff.content)).not.toContain("Accept, redo, or drop?");
  const result = await harness.handlers.get("tool_result")({ toolName: "todo", toolCallId: "x", isError: false, details: { op: "schedule" }, content: [] }, harness.ctx);
  expect(JSON.stringify(result ?? "")).not.toContain("ask accept / redo / drop");
});


test("the owner-unblock ask is not repeated after 15 or 60 minutes, and one user message re-asks it once", async () => {
  const phases = [{ name: "Proof", tasks: [{ content: "Show the screenshot", status: "blocked", blocker: "waits for user: provide the visible screenshot", schedule: { dependencies: [] } }] }];
  const entries = [];
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] }, entries);
    const asks = () => harness.sent.filter((message) => message.customType === "todo-user-unblock").length;
    await harness.handlers.get("turn_end")({ toolResults: [] }, harness.ctx);
    expect(asks()).toBe(1);
    // The ask reached the branch as a message; a rebuilt harness (restart) sees it.
    entries.push({ type: "custom_message", customType: "todo-user-unblock", details: { row: "Show the screenshot", at: clock } });
    for (const minutes of [15, 60]) {
      clock += minutes * 60_000;
      await harness.handlers.get("turn_end")({ toolResults: [] }, harness.ctx);
      expect(asks()).toBe(1);
    }
    clock += 1_000;
    await harness.handlers.get("message_start")({ message: { role: "user", content: [{ type: "text", text: "continue" }] } }, harness.ctx);
    clock += 1_000;
    await harness.handlers.get("turn_end")({ toolResults: [] }, harness.ctx);
    expect(asks()).toBe(2);
    entries.push({ type: "custom_message", customType: "todo-user-unblock", details: { row: "Show the screenshot", at: clock } });
    clock += 60 * 60_000;
    await harness.handlers.get("turn_end")({ toolResults: [] }, harness.ctx);
    expect(asks()).toBe(2);
  } finally {
    Date.now = realNow;
  }
});
