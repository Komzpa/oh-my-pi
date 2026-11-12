// @ts-nocheck -- exercises the extension through its registered runtime hooks.
import { expect, test, spyOn } from "bun:test";
import { speculativeTaskRows, decideTodoDispatch, deliveredRowsClosed, USER_WAIT_REFUSAL, waitsOnUser, acceptedSpeculativeMergeDemand, estimateFloorRefusal, firstDeliveryCutRequired, missedEtaRowsText, missingSpeculativeReview, SPRINT_STATE_ENTRY_TYPE, successfulDurationFloors, userUnblockAskDue, workerPastForecast } from "./todo_dispatch";
import todoDispatch from "./todo_dispatch";
import handoffReplay from "./fixtures/handoff-dc-refusals.json";
import speculativeReplay from "./fixtures/speculative-dc-replay.json";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatPlanForecast, formatTaskForecast, formatTaskForecastDisplay, forecastTodoPlan, getTodoPlanningIssues } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { readGoalDeadline } from "./deadlines";
import { sessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";

const now = Date.now();
const validEstimate = { optimisticSeconds: 600, likelySeconds: 1200, pessimisticSeconds: 2400, confidence: "medium" as const, basis: "Measured fixture", updatedAt: now };

test("task text does not claim a shorter row embedded in its canonical target", () => {
  const phases = [{ name: "Work", tasks: [
    { content: "Widget", status: "pending", schedule: { dependencies: [] } },
    { content: "Implement canonical Widget component", status: "pending", schedule: { dependencies: [], estimate: validEstimate } },
  ] }];
  const item = { name: "BuildComponent", agent: "coder", task: "Implement canonical Widget component using the existing tests." };
  expect(speculativeTaskRows(item, phases).map(row => row.content)).toEqual(["Implement canonical Widget component"]);
});

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
  // A running attempt's evidenced remaining time is accepted however early it is.
  expect(estimateFloorRefusal([{ ...update, task: earlyRow.content }], early, floors, now)).toBeUndefined();
  // Negative control: a new attempt (not yet started) is still floored even with evidence.
  const freshRow = { ...estimateRow("New panel attempt", { startedAt: undefined, executor: undefined }), status: "pending" };
  const fresh = forecastTodoPlan([{ name: "Work", tasks: [freshRow] }], { now }).rows;
  expect(estimateFloorRefusal([{ ...update, task: "New panel attempt" }], fresh, floors, now)).toContain("below 15m");
});

// Live DC 2026-11-05: "Refusing todo schedule for 'Locale-independent decimal parsing': likely 2m is
// below 27m; floor 27m ... previous attempt took 27m" while the row's worker ran its last step.
test("a remaining-time update on a running attempt with progress evidence is not floored", () => {
  const floors = successfulDurationFloors(Array.from({ length: 5 }, () => JSON.stringify({ kind: "outcome", agent: "coder", status: "completed", durationMs: 600_000 })));
  const content = "Locale-independent decimal parsing on input and paste (07)";
  const attemptHistory = [{ attemptId: "ParseDecimalsAnyLocale", durationMs: 27 * 60_000, terminalStatus: "failed" }];
  const running = estimateRow(content, { startedAt: now - 40 * 60_000, attemptHistory, executor: { workerId: "DoItemsOnConsolidated", agentProfile: "coder", startedAt: now - 40 * 60_000 } });
  const rows = forecastTodoPlan([{ name: "Work", tasks: [running] }], { now }).rows;
  const live = { task: content, owner: "DoItemsBrowserProof", evidence: "cb4b8269 tsc 0 lint 0 78 unit cases; browser proof inside row 41", estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 300, confidence: "medium", basis: "Code is committed at cb4b8269. The row closes on the proof row's receipt." } };
  expect(estimateFloorRefusal([live], rows, floors, now)).toBeUndefined();
  // Without progress evidence the same update is still floored.
  expect(estimateFloorRefusal([{ ...live, evidence: undefined }], rows, floors, now)).toContain("previous attempt took 27m");
  // A finished attempt can leave only verification work; its duration is not a lower bound on that remainder.
  const finished = estimateRow(content, { startedAt: now - 40 * 60_000, attemptHistory, executor: { workerId: "DoItemsOnConsolidated", agentProfile: "coder", startedAt: now - 40 * 60_000, finishedAt: now - 60_000, outcome: "failed" } });
  const retryRows = forecastTodoPlan([{ name: "Work", tasks: [finished] }], { now }).rows;
  expect(estimateFloorRefusal([live], retryRows, floors, now)).toBeUndefined();
  expect(estimateFloorRefusal([{ ...live, evidence: undefined }], retryRows, floors, now)).toContain("below 27m");
});

test("final artifact audit remainder is accepted after the implementation worker finishes", () => {
  const floors = successfulDurationFloors([JSON.stringify({ kind: "outcome", agent: "task", status: "completed", durationMs: 494_000 })]);
  const row = estimateRow("Remove proven disposable branches and checkouts", {
    startedAt: now - 120 * 60_000,
    executor: { workerId: "ReconcileCompletedCleanup", agentProfile: "task", startedAt: now - 600_000, finishedAt: now - 237_000, outcome: "completed" },
  });
  const rows = forecastTodoPlan([{ name: "Work", tasks: [row] }], { now }).rows;
  const update = { task: row.content, owner: "AuditCompletedCleanupManifest", evidence: "Implementation and 811-root reconciliation delivered; only manifest-bound QA remains", estimate: { optimisticSeconds: 120, likelySeconds: 300, pessimisticSeconds: 600, confidence: "high", basis: "Verify frozen hashes 60s, coverage 120s, verdict 120s" } };
  expect(estimateFloorRefusal([update], rows, floors, now)).toBeUndefined();
  expect(estimateFloorRefusal([{ ...update, evidence: undefined }], rows, floors, now)).toContain("below 9m");
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
	return [
		{
			name: "Work",
			tasks: [
				{
					content: "Delivered UI",
					status: "blocked" as const,
					blocker: "waits for user: accept, redo, or drop",
					schedule: {
						owner: "Coder",
						review: "user" as const,
						firstDeliveredAt: now,
						reviewSummary: "UI delivered",
						dependencies: [],
						estimate: validEstimate,
						executor: {
							workerId: "Coder",
							startedAt: now,
							finishedAt: now + 1,
							outcome: "completed",
							gitCommits: ["abcdef123456"],
						},
						audit: {
							agent: "qa-auditor",
							verdict: "pass",
							delivery: JSON.stringify(["Coder", now, now + 1]),
							startedAt: now,
							at: now + 2,
						},
					},
				},
				{
					content: "Verify UI",
					status: "pending" as const,
					schedule: { owner: "Verifier", dependencies: ["Delivered UI"], estimate: validEstimate },
				},
				{ content: "Independent docs", status: "pending" as const, schedule: { owner: "Docs", dependencies: [], estimate: validEstimate } },
			],
		},
	];
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

test("verified child checkpoint remains publishable while sibling acceptance is blocked", () => {
  const phases = [{ name: "Delivery", tasks: [
    { content: "Parent delivery", status: "blocked", blocker: "acceptance remains open", schedule: { review: "user", dependencies: [] } },
    { content: "Verified child slice", status: "completed", schedule: {
      review: "accepted",
      speculativeOn: "Parent delivery",
      dependencies: [],
      attemptHistory: [{ terminalStatus: "completed", gitCommits: ["abcdef123456"] }],
    } },
    { content: "Sibling acceptance", status: "blocked", blocker: "awaiting separate acceptance", schedule: { review: "user", dependencies: [] } },
  ] }];

  expect(acceptedSpeculativeMergeDemand(phases)).toBe('user accepted "Verified child slice"; NEXT ACTION: fast merge/publish "Verified child slice"');
  expect(phases[0].tasks[0].status).toBe("blocked");
  expect(phases[0].tasks[2].status).toBe("blocked");
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
    expect(harness.phases()[0].tasks[1].schedule.speculativeOn).toBe(verdict === "drop" ? undefined : before.schedule.speculativeOn);
    expect(harness.phases()[0].tasks[1].schedule.attemptHistory).toEqual(before.schedule.attemptHistory);
    expect(acceptedSpeculativeMergeDemand(harness.phases())).toBeUndefined();
  }
});

test("attempt two dispatches speculatively with a queued handoff, then honors correction", async () => {
  const phases = [{ name: "Work", tasks: [{
    content: "Implement header navigation",
    status: "pending",
    schedule: { decision: "owner", owner: "NavWorker", dependencies: [], estimate: validEstimate, attemptHistory: [{ attemptId: "1", terminalStatus: "completed", finalReportParagraph: "Navigation delivered; await owner review" }] },
  }] }];
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const beforeHandoff = { tasks: [{ agent: "Coder", task: "Implement header navigation" }] };
  const refused = await harness.handlers.get("tool_call")!({ toolName: "task", input: beforeHandoff }, harness.ctx) as { reason?: string };
  expect(refused?.block).not.toBe(true);
  expect(harness.phases()[0].tasks[0].schedule.reviewPagePending).toBe(true);
  expect(harness.phases()[0].tasks[0].schedule.speculativeOn).toBe("Implement header navigation");
  harness.phases()[0].tasks[0].schedule.review = "user";
  harness.phases()[0].tasks[0].status = "blocked";
  await recordReview(harness, "redo", "redo Implement header navigation with the buttons left aligned", "Implement header navigation");
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("redo");
  const afterVerdict = { tasks: [{ agent: "Coder", task: "Implement header navigation" }] };
  const allowed = await harness.handlers.get("tool_call")!({ toolName: "task", input: afterVerdict }, harness.ctx) as { reason?: string } | undefined;
  expect(allowed?.reason).toBeUndefined();
  expect(allowed.input.tasks[0].task).toContain("USER CORRECTION TO HONOR: redo Implement header navigation with the buttons left aligned");
});

test("user accept resolves review and demands fast publication of the dependent work", async () => {
  const phases = reviewPlan();
  phases[0]!.tasks[1]!.schedule.speculativeOn = "Delivered UI";
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  await recordReview(harness, "accepted");
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("accepted");
  expect(harness.sent.some((message) => String(message.content).includes("NEXT ACTION: fast merge/publish"))).toBe(true);
});

async function reviewHookHarness(initialPhases: unknown, jobs: unknown, branchEntries: unknown[] = [], finalText = "The worker finished.", options = {}) {
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
  await todoDispatch(api as never, options);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getHeader: () => ({ id: "customer-review-test" }),
      getBranch: () => branchEntries,
      getBranchMatching: (predicate) => branchEntries.filter(entry => predicate(sessionContextEntryMetadata(entry))),
      getLatestBranchMatching: (predicate) => branchEntries.findLast(entry => predicate(sessionContextEntryMetadata(entry))),
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

test("completed worker result without a page requests publication before user handoff", async () => {
  const harness = await reviewHookHarness(
    [{ name: "Work", tasks: [{ content: "Implement header navigation", status: "in_progress", schedule: { decision: "owner", owner: "NavWorker", dependencies: [], startedAt: now - 5_000 } }] }],
    { running: [], recent: [{ id: "NavWorker", agentId: "NavWorker", type: "task", status: "completed", label: "Implement header navigation" }], nonJobAgents: [] },
  );
  await harness.handlers.get("tool_result")!({ toolName: "task", toolCallId: "done", isError: false, details: { results: [{ id: "NavWorker", status: "completed", output: "Implemented the header controls.\n\nUpdated src/reader-header.ts and commit abcdef123456." }] } }, harness.ctx);
  expect(harness.phases()[0].tasks[0].schedule.review).toBe("user");
  expect(harness.sent.some((message) => message.display === true && String(message.content).includes("Handoff pending"))).toBe(true);
  expect(harness.sent.some((message) => String(message.content).includes("Delivered to you:"))).toBe(false);
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
	phases[0].tasks[0].schedule.attemptHistory = [{ attemptId: "1", terminalStatus: "completed", finalReportParagraph: "Delivered UI; owner review pending" }];
	const harness = await reviewHookHarness(phases, {
		running: [
			{ id: "Docs", agentId: "Docs", type: "task", status: "running", label: "Independent docs", startTime: now },
		],
		recent: [],
		nonJobAgents: [],
	});
	const call = { tasks: [{ agent: "Coder", task: "Delivered UI" }] };
	const result = await harness.handlers.get("tool_call")({ toolName: "task", input: call }, harness.ctx);
	expect(result?.block).not.toBe(true);
	expect(result.input.tasks[0].task).toContain("SPECULATIVE");
	expect(harness.phases()[0].tasks[0].schedule.speculativeOn).toBe("Delivered UI");
});

async function recordReview(
	harness,
	verdict,
	evidence = "Customer decision recorded from the conversation",
	task = "Delivered UI",
) {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated({}),
		getTodoPhases: () => harness.phases(),
		setTodoPhases: phases => harness.ctx.setTodoPhases(phases),
		persistTodoPhases: () => undefined,
	};
	const input = { op: "schedule", updates: [{ task, review: verdict, evidence }] };
	const result = await new TodoTool(session as never).execute("record-review", input);
	expect(result.isError).not.toBe(true);
	const hook = await harness.handlers.get("tool_result")({ toolName: "todo", input, ...result }, harness.ctx);
	return { result, hook };
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


const LIVE_BLOCKER = "Awaiting the user's verdicts on the round-2 compare page";
function userWaitPlan() {
  return [{ name: "Work", tasks: [
    { content: "Compare page", status: "in_progress", schedule: { owner: "user-review", dependencies: [] } },
    { content: "Other row", status: "in_progress", schedule: { owner: "Coder", dependencies: [] } },
  ] }];
}

test("a todo block waiting on the user is refused with the action-first text; the live shape included", async () => {
  const harness = await reviewHookHarness(userWaitPlan(), { running: [], recent: [], nonJobAgents: [] });
  const call = (input) => harness.handlers.get("tool_call")({ toolName: "todo", input }, harness.ctx);
  const live = await call({ op: "block", task: "Compare page", reason: LIVE_BLOCKER });
  expect(live?.block).toBe(true);
  expect(live.reason).toBe(USER_WAIT_REFUSAL);
  expect(live.reason).toStartWith("Deliver the unresolved owner question through review-questions-page and ask");
  // The user-review label alone is enough, whatever the reason says.
  expect((await call({ op: "block", task: "Compare page", reason: "round 2 is ready" }))?.block).toBe(true);
  // Neighbour: an ordinary external blocker is untouched.
  expect((await call({ op: "block", task: "Other row", reason: "CI queue is full" }))?.block).not.toBe(true);
});

test("a missionCritical row may wait on the user, now or after being marked", async () => {
  const harness = await reviewHookHarness(userWaitPlan(), { running: [], recent: [], nonJobAgents: [] });
  const call = (input) => harness.handlers.get("tool_call")({ toolName: "todo", input }, harness.ctx);
  expect((await call({ op: "block", task: "Compare page", reason: LIVE_BLOCKER, missionCritical: "needs their hands: 2FA code" }))?.block).not.toBe(true);
  expect((await call({ op: "block", task: "Compare page", reason: LIVE_BLOCKER }))?.block).not.toBe(true);
  expect((await call({ op: "block", task: "Compare page", reason: LIVE_BLOCKER, missionCritical: "   " }))?.block).not.toBe(true);
  const blank = await reviewHookHarness(userWaitPlan(), { running: [], recent: [], nonJobAgents: [] });
  expect((await blank.handlers.get("tool_call")({ toolName: "todo", input: { op: "block", task: "Compare page", reason: LIVE_BLOCKER, missionCritical: "  " } }, blank.ctx))?.block).toBe(true);
});

test("a schedule update keeping an owner-blocked row blocked is refused unless missionCritical", async () => {
  const phases = userWaitPlan();
  phases[0].tasks[0].status = "blocked";
  phases[0].tasks[0].blocker = LIVE_BLOCKER;
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const call = (input) => harness.handlers.get("tool_call")({ toolName: "todo", input }, harness.ctx);
  expect((await call({ op: "schedule", updates: [{ task: "Compare page", evidence: "still waiting" }] }))?.block).toBe(true);
  expect((await call({ op: "schedule", updates: [{ task: "Other row", evidence: "fine" }] }))?.block).not.toBe(true);
  expect((await call({ op: "schedule", updates: [{ task: "Compare page", evidence: "irreversible publish", missionCritical: "public post, irreversible" }] }))?.block).not.toBe(true);
  expect(waitsOnUser("Coder", "waiting for the user's reply")).toBe(true);
  expect(waitsOnUser("Coder", "waiting for the CI reply")).toBe(false);
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
  // Neighbour: a redo verdict is not closed any more; the row reopens with their words.
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
	delete phases[0].tasks[0].blocker;
	const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
	await harness.handlers.get("turn_end")({ toolResults: [] }, harness.ctx);
	const handoff = harness.sent.find(message => String(message.content).startsWith("Handoff required:"));
	expect(handoff).toBeUndefined();
	expect(harness.sent.filter(message => String(message.content).includes("Ask the user now: Delivered UI"))).toEqual([]);
	const result = await harness.handlers.get("tool_result")(
		{ toolName: "todo", toolCallId: "x", isError: false, details: { op: "schedule" }, content: [] },
		harness.ctx,
	);
	expect(JSON.stringify(result ?? "")).not.toContain("ask accept / redo / drop");
});


test("the user-unblock ask is not repeated after 15 or 60 minutes, and one user message re-asks it once", async () => {
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


test("accepted review closes in the schedule result and remains closed after replay", async () => {
  const phases = reviewPlan();
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const { result } = await recordReview(harness, "accepted");
  expect(harness.phases()[0].tasks[0].status).toBe("completed");
  expect(result.details.completedTasks).toContainEqual({ phase: phases[0].name, content: "Delivered UI" });
  const replayed = getLatestTodoPhasesFromEntries([
    { type: "custom", customType: "user_todo_edit", data: { phases } },
    { type: "message", message: { role: "toolResult", toolName: "todo", details: JSON.parse(JSON.stringify(result.details)) } },
  ]);
  expect(replayed[0].tasks[0].status).toBe("completed");
});

// Live DC 2026-11-05 21:45: Guide Hall, Facility 2D, Main deploy, Plan click and Camera sat at
// "accepted by user, closing blocked: Re-audit R182 ..." while the qa-auditor model was out of budget.
const LIVE_AUDIT_REFUSAL = 'Re-audit R182 (+2 more below); then retry done. Linked requirements need a fresh qa-auditor pass bound to each row artifact: R182 ("Guide Hall"): no qa-auditor pass bound to the current artifact.';

test("the user's Accept closes the row even when the requirement re-audit refuses done", async () => {
  for (const task of ["Guide Hall", "Facility 2D", "Main deploy", "Plan click", "Camera"]) {
    const phases = reviewPlan();
    phases[0].tasks.splice(1);
    phases[0].tasks[0].content = task;
    const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
    const execute = TodoTool.prototype.execute;
    const spy = spyOn(TodoTool.prototype, "execute").mockImplementation(function (...args) {
      if (args[1].op === "done") return Promise.resolve({ isError: true, content: [{ type: "text", text: LIVE_AUDIT_REFUSAL }] });
      return execute.apply(this, args);
    });
    try {
      const { result, hook } = await recordReview(harness, "accepted", undefined, task);
      const row = harness.phases()[0].tasks[0];
      expect(row.status).toBe("completed");
      expect(row.blocker).toBeUndefined();
      expect(row.schedule.review).toBe("accepted");
      expect(row.schedule.reviewClosingBlocked).toBeUndefined();
      expect(row.schedule.acceptedAuditFollowUp).toBe(LIVE_AUDIT_REFUSAL);
      expect(result.details.completedTasks).toContainEqual({ phase: phases[0].name, content: task });
      expect(result.content[0].text).not.toContain("closing blocked");
      expect(result.content[0].text).toContain(`${JSON.stringify(task)}: accepted by user, closed; background requirement audit still open (never blocks this row)`);
      expect(hook?.content?.map(part => part.text).join("\n") ?? "").not.toContain("close it");
      const replayed = getLatestTodoPhasesFromEntries([
        { type: "custom", customType: "user_todo_edit", data: { phases } },
        { type: "message", message: { role: "toolResult", toolName: "todo", details: JSON.parse(JSON.stringify(result.details)) } },
      ]);
      expect(replayed[0].tasks[0].status).toBe("completed");
      expect(replayed[0].tasks[0].schedule.acceptedAuditFollowUp).toBe(LIVE_AUDIT_REFUSAL);
    } finally { spy.mockRestore(); }
  }
});

test("negative control: a delivered row without the user's Accept still waits for review", async () => {
  const phases = reviewPlan();
  phases[0].tasks.splice(1);
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const row = harness.phases()[0].tasks[0];
  expect(row.status).toBe("blocked");
  expect(row.schedule.review).toBe("user");
  expect(row.schedule.acceptedAuditFollowUp).toBeUndefined();
});

test("a stuck accepted row from an old build names the one call that closes it", async () => {
  const phases = reviewPlan();
  phases[0].tasks.splice(1);
  Object.assign(phases[0].tasks[0], { content: "Camera", status: "blocked", blocker: LIVE_AUDIT_REFUSAL });
  Object.assign(phases[0].tasks[0].schedule, { review: "accepted", reviewClosingBlocked: LIVE_AUDIT_REFUSAL });
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const execute = TodoTool.prototype.execute;
  const spy = spyOn(TodoTool.prototype, "execute").mockImplementation(function (...args) {
    if (args[1].op === "done") return Promise.resolve({ isError: true, content: [{ type: "text", text: LIVE_AUDIT_REFUSAL }] });
    return execute.apply(this, args);
  });
  try {
    await recordReview(harness, "accepted", undefined, "Camera");
    expect(harness.phases()[0].tasks[0].status).toBe("completed");
  } finally { spy.mockRestore(); }
});

test("redo reopens a completed row and sends the user's actual note as the next brief", async () => {
  const phases = reviewPlan();
  phases[0].tasks[0].status = "completed";
  phases[0].tasks[0].schedule.finishedAt = now;
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  const note = "Move the buttons to the left";
  await recordReview(harness, "redo", note);
  const row = harness.phases()[0].tasks[0];
  expect(row.status).toBe("in_progress");
  expect(row.schedule.finishedAt).toBeUndefined();
  const input = { tasks: [{ agent: "Coder", task: "Delivered UI" }] };
  const result = await harness.handlers.get("tool_call")({ toolName: "task", input }, harness.ctx);
  expect(result.input.tasks[0].task).toContain(`USER CORRECTION TO HONOR: ${note}`);
});

test("drop abandons the reviewed row and releases its dependants", async () => {
  const phases = reviewPlan();
  const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
  await recordReview(harness, "drop", "Do not ship this UI");
  expect(harness.phases()[0].tasks[0].status).toBe("abandoned");
  expect(harness.phases()[0].tasks[1].schedule.dependencies).not.toContain("Delivered UI");
});


test("customer verdicts pass admission on a user-review wait while ordinary wait edits stay refused", async () => {
  for (const review of ["accepted", "redo", "drop"]) {
    const phases = reviewPlan();
    phases[0].tasks[0].schedule.owner = "user-review";
    phases[0].tasks[0].blocker = "waits for user: accept, redo, or drop";
    const harness = await reviewHookHarness(phases, { running: [], recent: [], nonJobAgents: [] });
    const input = { op: "schedule", updates: [{ task: "Delivered UI", review, evidence: "User correction" }] };
    const verdict = await harness.handlers.get("tool_call")({ toolName: "todo", input }, harness.ctx);
    expect(verdict?.block).not.toBe(true);
    const ordinary = await harness.handlers.get("tool_call")({ toolName: "todo", input: { op: "schedule", updates: [{ task: "Delivered UI", evidence: "Still waiting" }] } }, harness.ctx);
    expect(ordinary).toEqual({ block: true, reason: USER_WAIT_REFUSAL });
  }
});

// Captured DC calls 73631–73694, 2026-11-05T05:25–05:26Z, against c532dce8c.

test("DC audit dispatch survives all five refused calls and the intervening remedies", async () => {
	for (const capture of speculativeReplay) {
		const targets = new Set(capture.input.tasks.flatMap(item => speculativeTaskRows(item, capture.phases).map(row => row.content)));
		// One worker may own several rows; a settled audit target cannot also be synthesized as live through its sibling.
		const targetOwners = new Set(capture.phases.flatMap(phase => phase.tasks).filter(row => targets.has(row.content)).flatMap(row => [row.schedule?.owner, row.schedule?.executor?.workerId]).filter(Boolean));
		const running = capture.phases
			.flatMap(phase => phase.tasks)
			.filter(row => row.schedule?.owner && !targets.has(row.content) && !targetOwners.has(row.schedule.owner))
			.map(row => ({
				id: row.schedule.owner,
				agentId: row.schedule.owner,
				type: "task",
				status: "running",
				label: row.content,
				startTime: now,
			}));
		const phases = structuredClone(capture.phases);
        for (const row of phases.flatMap(phase => phase.tasks)) {
          row.schedule = { ...row.schedule, dependencies: row.schedule?.dependencies ?? [], estimate: row.schedule?.estimate ?? validEstimate };
          if (targets.has(row.content)) row.schedule.progress = { evidence: "Replay fixture: previous delivery needs verification" };
        }
        const harness = await reviewHookHarness(phases, { running, recent: [], nonJobAgents: [] });
		const result = await harness.handlers.get("tool_call")(
			{ toolName: "task", input: structuredClone(capture.input) },
			harness.ctx,
		);
		expect(result?.block).not.toBe(true);
		for (const item of capture.input.tasks) expect(missingSpeculativeReview(item, capture.phases)).toBeUndefined();
	}
});

test("coder marks each bound row speculative automatically", async () => {
	const phases = reviewPlan();
	const call = { name: "Verifier", agent: "coder", task: "Delivered UI and Verify UI" };
	expect(missingSpeculativeReview(call, phases)).toBe("Delivered UI");
	const harness = await reviewHookHarness(phases, {
		running: [
			{ id: "Docs", agentId: "Docs", type: "task", status: "running", label: "Independent docs", startTime: now },
		],
		recent: [],
		nonJobAgents: [],
	});
	const dispatch = () =>
		harness.handlers.get("tool_call")({ toolName: "task", input: { tasks: [{ name: "Verifier", agent: "coder", task: "Verify UI" }] } }, harness.ctx);
	expect((await dispatch())?.block).not.toBe(true);
	expect(harness.phases()[0].tasks[1].schedule.speculativeOn).toBe("Delivered UI");
	expect((await dispatch())?.block).not.toBe(true);
	expect(missingSpeculativeReview({ task: "Verify UI" }, harness.phases())).toBeUndefined();
	delete harness.phases()[0].tasks[1].schedule.speculativeOn;
	harness.phases()[0].tasks[0].status = "completed";
	expect(missingSpeculativeReview(call, harness.phases())).toBeUndefined();
});

test("structured row binding ignores other titles in a multi-row brief", () => {
  const phases = reviewPlan();
  const item = { agent: "coder", previewIntegration: { task: "Independent docs", kind: "refresh" }, task: "Verify UI depends on Delivered UI; Independent docs is this assignment" };
  expect(missingSpeculativeReview(item, phases)).toBeUndefined();
  delete item.previewIntegration;
  item.task = "Verify UI";
  expect(missingSpeculativeReview(item, phases)).toBe("Delivered UI");
  for (const agent of ["qa-auditor", "reviewer", "gate-runner"]) expect(missingSpeculativeReview({ ...item, agent }, phases)).toBeUndefined();
});


test("a coder multi-row brief cannot hide an unaccepted dependency behind the first row", () => {
  const phases = reviewPlan();
  expect(missingSpeculativeReview({ agent: "coder", task: "Independent docs and Verify UI" }, phases)).toBe("Delivered UI");
  phases[0].tasks[1].schedule.speculativeOn = "Delivered UI";
  expect(missingSpeculativeReview({ agent: "coder", task: "Independent docs and Verify UI" }, phases)).toBeUndefined();
});

// DC session 01a1921c, 2026-11-05 16:16–16:35Z: exact refused calls and available row snapshots.
test("DC handoff refusals admit product workers without a review-page round trip", async () => {
  for (const capture of handoffReplay) {
    const harness = await reviewHookHarness([{ name: "Work", tasks: [capture.row] }], { running: [], recent: [], nonJobAgents: [] });
    const result = await harness.handlers.get("tool_call")({ toolName: "task", input: structuredClone(capture.call) }, harness.ctx);
    expect(result?.block).not.toBe(true);
  }
});

test("aborted and failed workers need receipt findings before retry, without demanding handoff", async () => {
  for (const terminalStatus of ["aborted", "failed"]) {
    const row = { content: "Move closer frames a single rack large enough (12)", status: "pending", schedule: {
      dependencies: [], estimate: validEstimate, attemptHistory: [{ attemptId: "FrameSingleRackOnMoveCloser:1793895220647", terminalStatus,
        deliverablePaths: ["/home/kom/.omp/agent/sessions/dc/FrameSingleRackOnMoveCloser.md"] }],
    } };
    const harness = await reviewHookHarness([{ name: "Work", tasks: [row] }], { running: [], recent: [], nonJobAgents: [] });
    const dispatch = () => harness.handlers.get("tool_call")({ toolName: "task", input: { tasks: [{ agent: "ui-coder", task: row.content }] } }, harness.ctx);
    expect((await dispatch())?.reason).toContain("no previous attempt findings");
    row.schedule.attemptHistory[0].finalReportParagraph = "Camera fix exists; screenshot oracle remains open";
    expect((await dispatch())?.block).not.toBe(true);
    expect(harness.phases()[0].tasks[0].schedule.review).toBeUndefined();
    expect(harness.phases()[0].tasks[0].schedule.reviewPagePending).toBeUndefined();
  }
});

test("renamed rack work retains its predecessor's handoff and does not taint independent resources", async () => {
  const old = { content: "Move closer frames a single rack large enough (12)", status: "abandoned", schedule: {
    resources: ["/dc/tmp/do-12-rack-zoom"], review: "user", reviewPagePending: true, firstDeliveredAt: now - 16 * 60_000,
    attemptHistory: [{ attemptId: "one", terminalStatus: "completed" }],
  } };
  const renamed = { content: "Rack close-up: Move closer fills 40% of view (12)", status: "pending", schedule: { dependencies: [], estimate: validEstimate, resources: [...old.schedule.resources] } };
  const independent = { content: "Site posture moves to Inputs", status: "pending", schedule: { dependencies: [], estimate: validEstimate, resources: ["/dc/tmp/site-posture"] } };
  const harness = await reviewHookHarness([{ name: "Work", tasks: [old, renamed, independent] }], { running: [], recent: [], nonJobAgents: [] });
  const input = { tasks: [{ agent: "ui-coder", task: renamed.content }, { agent: "ui-coder", task: independent.content }] };
  expect((await harness.handlers.get("tool_call")({ toolName: "task", input }, harness.ctx))?.block).not.toBe(true);
  expect(harness.phases()[0].tasks[1].schedule.reviewPagePending).toBe(true);
  expect(harness.phases()[0].tasks[1].schedule.firstDeliveredAt).toBe(old.schedule.firstDeliveredAt);
  expect(harness.phases()[0].tasks[0].schedule.attemptHistory).toEqual(old.schedule.attemptHistory);
  expect(harness.phases()[0].tasks[2].schedule.review).toBeUndefined();
  expect(harness.sent.some(message => String(message.content).includes(old.content))).toBe(true);
  const wait = await harness.handlers.get("tool_call")({ toolName: "wait", input: {} }, harness.ctx);
  expect(wait?.block).toBe(true);
  expect(wait?.reason).toContain("Handoff pending");
});

test("published user-review row dispatches a speculative redo", async () => {
  const row = { content: "Delivered UI", status: "pending", schedule: { review: "user", reviewPage: "http://127.0.0.1:8767/review/batch/", dependencies: [], estimate: validEstimate } };
  const harness = await reviewHookHarness([{ name: "Work", tasks: [row] }], { running: [], recent: [], nonJobAgents: [] });
  harness.ctx.getTodoPreviewConfig = () => ({ enabled: false, paths: [], thresholdMinutes: 15, openReviewPages: false });
  const input = { tasks: [{ agent: "coder", task: row.content }] };
  const result = await harness.handlers.get("tool_call")({ toolName: "task", input }, harness.ctx);
  expect(result?.block).not.toBe(true);
  expect(result.input.tasks[0].task).toContain("SPECULATIVE");
  expect(harness.phases()[0].tasks[0].schedule.speculativeOn).toBe(row.content);
});


test("runtime completion queues one delivery critic before the batch and clean releases it", async () => {
  const deferred = Promise.withResolvers();
  const records = [];
  const row = { content: "Rack tiles fit panel height at 1568, no scrollbar", status: "completed", schedule: {
    decision: "owner", owner: "RackInputHeight-2", executor: { workerId: "RackInputHeight-2", startedAt: now - 5000, finishedAt: now, outcome: "completed",
    gitCommits: [{ commit: "a".repeat(40), repoPath: "/project" }] }, dependencies: [] } };
  const harness = await reviewHookHarness([{ name: "Final handoff", tasks: [row] }], { running: [], recent: [] }, [], "", { deliveryCriticRecord: async (_row, verdict) => { records.push(verdict); } });
  let spawns = 0;
  harness.ctx.runDeliveryCritic = () => { spawns++; return deferred.promise; };
  const event = { toolName: "task", toolCallId: "rack-done", details: { results: [{ id: "RackInputHeight-2", status: "completed", output: "Rack controls delivered" }] } };
  await harness.handlers.get("tool_result")(event, harness.ctx);
  await harness.handlers.get("tool_result")(event, harness.ctx);
  expect(spawns).toBe(1);
  expect(harness.phases()[0].tasks[0].schedule.review).toBeUndefined();
  expect(harness.phases()[0].tasks[0].schedule.handoffPending).toBe(false);
  expect(harness.sent.some(message => String(message.content).startsWith("Handoff required:"))).toBe(false);
  deferred.resolve({ details: { results: [{ output: JSON.stringify({ verdict: "clean", findings: [] }) }] } });
  await deferred.promise; await Bun.sleep(0);
  expect(harness.phases()[0].tasks[0].schedule.handoffPending).toBe(true);
  expect(records).toEqual([{ verdict: "clean", findings: [] }]);
});

for (const answered of [false, true]) test(`restaffing does not request review for ${answered ? "answered product content" : "an owner-specified cosmetic fix"}`, async () => {
 const row = { content: "Power source rows: remove red frame", status: "pending", schedule: { owner: "FrameWorker", dependencies: [], attemptHistory: [{ attemptId: "1", terminalStatus: "completed", finalReportParagraph: "Navigation delivered; await owner review" }], ...(answered ? { decision: "owner", reviewAnswers: ["page/card/hash/accept"] } : {}) } };
 const h = await reviewHookHarness([{ name: "Work", tasks: [row] }], { running: [], recent: [], nonJobAgents: [] });
 await h.handlers.get("tool_call")({ toolName: "task", input: { tasks: [{ agent: "Coder", task: row.content }] } }, h.ctx);
 expect(h.phases()[0].tasks[0].schedule.review).toBeUndefined();
 expect(h.phases()[0].tasks[0].schedule.reviewPagePending).toBeUndefined();
});

for (const answered of [false, true]) test(`worker completion without critic does not ask about ${answered ? "answered product content" : "an owner-specified cosmetic fix"}`, async () => {
  const row = { content: "Power source rows: remove red frame", status: "in_progress", schedule: { owner: "FrameWorker", dependencies: [], ...(answered ? { decision: "owner", reviewAnswers: ["page/card/hash/accept"] } : {}) } };
  const h = await reviewHookHarness([{ name: "Work", tasks: [row] }], { running: [], recent: [{ id: "FrameWorker", agentId: "FrameWorker", type: "task", status: "completed" }], nonJobAgents: [] });
  await h.handlers.get("tool_result")({ toolName: "task", toolCallId: "frame-done", isError: false, details: { results: [{ id: "FrameWorker", status: "completed", output: "Inspected screenshot; frame removed." }] } }, h.ctx);
  expect(h.phases()[0].tasks[0].schedule.review).toBeUndefined();
  expect(h.sent.some(message => message.customType === "todo-user-review")).toBe(false);
});
