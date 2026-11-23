// @ts-nocheck -- extension event harness uses the public host boundary.
import { afterEach, expect, test, spyOn, mock } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as calibration from "@oh-my-pi/pi-coding-agent/tools/todo-plan-calibration";
import { forecastTodoLivePlan } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { TODO_PREDICTION_VERSION } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch from "./todo_dispatch";
import * as leadNotes from "./lead_time_notes";
import { readGoalDeadline } from "./deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { forecastTodoPlan, formatPlanForecast, formatTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
afterEach(() => { mock.restore(); });
let clock;
const now = 1_800_000_000_000;

test("lead idle event persists slip, churn and the exact blocked question without deleting old notes", async () => {
  clock = spyOn(Date, "now").mockReturnValue(now);
  const cwd = await mkdtemp(join(tmpdir(), "planfact-"));
  const plan = [{ name: "Ship", tasks: [{ content: "Publish", status: "blocked", blocker: "May I use /tmp/description.md as PR description?", schedule: { owner: "PushWorker", reestimateCount: 0, cumulativeReestimateCount: 3 } }] }];
  const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } }];
  const handlers = new Map();
  const sent = [];
  const api = {
    on: (event, handler) => handlers.set(event, handler), getActiveTools: () => ["task", "todo"],
    pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, getLatestTodoPhasesFromEntries, readGoalDeadline: () => ({ goalId: "goal", deadlineAt: now - 15 * 60_000 }) },
    appendEntry: () => {},
    sendMessage: (message, options) => { sent.push({ message, options }); branch.push({ type: "custom_message", ...message, timestamp: new Date(now).toISOString() }); },
  };
  let running = [];
  const ctx = { cwd, sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
    getAsyncJobSnapshot: () => ({ running, recent: [] }), getTaskMaxConcurrency: () => 4,
    isIdle: () => false, hasPendingMessages: () => false, setTimeout: () => ({}), clearTimer: () => {},
    getLastAssistantText: () => "Nothing new. Still waiting." };
  try {
    await todoDispatch(api);
    await handlers.get("agent_end")({}, ctx);
    const note = sent.find(item => item.message.customType === "todo-dispatch-time-note");
    expect(note.message.content).toContain("SLIPPED by 15m");
    expect(note.message.content).toContain("Current set: point unknown; empirical upper unavailable");
    expect(note.message.content).toContain("External gate: unknown; forecast conditional on unresolved work");
    expect(note.message.content).not.toContain("P(on time)");
    expect(note.message.content).toContain("PushWorker");
    expect(note.message.content).toContain("May I use /tmp/description.md as PR description?");
    expect(note.message.content).toContain("CHURN");
    expect(note.message.content).toContain("Change approach");
    expect(note.options.triggerTurn).toBe(false);
    expect(branch[0].message.toolName).toBe("todo");
    const old = note.message.content;
    plan[0].tasks[0].blocker = "May I publish the verified branch?";
    await handlers.get("agent_end")({}, ctx);
    expect(branch.some(entry => entry.content === old)).toBe(true);
    expect(sent.at(-1).message.content).toContain("May I publish the verified branch?");
    plan[0].tasks[0].status = "pending";
    delete plan[0].tasks[0].blocker;
    running = [{ id: "PushWorker", type: "task", status: "running", startTime: now, label: "Push the verified branch" }];
    const messages = [{ role: "toolResult", toolName: "ask", details: { pending: { id: "ask-1", questions: [{ id: "publish", question: "May I use the checked description?" }] } } }];
    spyOn(AgentRegistry.global(), "get").mockReturnValue({ session: { messages } });
    await handlers.get("agent_end")({}, ctx);
    expect(sent.at(-1).message.content).toContain("May I use the checked description?");
    const countBeforeAnswer = sent.length;
    messages.push({ role: "user", content: "Answer to ask-1 [publish]: yes" });
    await handlers.get("agent_end")({}, ctx);
    expect(sent.length).toBe(countBeforeAnswer);

  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("failed attempts demand a strategy change; on-time work has no urgency and closed rows have no churn", () => {
  const row = { content: "Browser proof", status: "pending", schedule: { attemptHistory: Array.from({ length: 3 }, () => ({ terminalStatus: "failed" })) } };
  const phases = [{ name: "Ship", tasks: [row] }];
  const note = leadNotes.renderPlanFactNote(phases, now, now + 60_000, [{ worker: "A", question: "Proceed?" }]);
  expect(note).toContain("3 failed attempts");
  expect(note).toContain("Do not retry");
  expect(note).not.toContain("URGENCY");
  row.status = "completed";
  expect(leadNotes.renderPlanFactNote(phases, now, now - 60_000)).toBe("");
});

// Without shared history the note reports 0 origins while todo reports calibrated coverage.
test("time note and todo forecast consume the same seeded cross-session calibration store", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "note-calibration-"));
  const store = new calibration.TodoPlanCalibrationStore(join(cwd, "history.jsonl"));
  try {
    for (let session = 0; session < 5; session++) for (let hour = 1; hour <= 4; hour++)
      await store.append({ members: ["row"], prediction: {
        sessionId: `s${session}`, originAt: hour * 3_600_000,
        rawP50Finish: hour * 3_600_000 + 60_000, actualFinish: hour * 3_600_000 + 7_200_000,
        upperFinish: hour * 3_600_000 + 8_000_000, observedAt: 100_000_000, predictionVersion: TODO_PREDICTION_VERSION, membershipFingerprint: "row",
      } });
    await store.refresh();
    spyOn(calibration, "getTodoPlanCalibrationStore").mockReturnValue(store);
    spyOn(Date, "now").mockReturnValue(200_000_000);
    const plan = [{ name: "Work", tasks: [{ content: "Implement", status: "pending", schedule: {
      dependencies: [], estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180,
        confidence: "medium", basis: "fixture", updatedAt: 200_000_000 },
    } }] }];
    const handlers = new Map(); const sent = [];
    await todoDispatch({ on: (name, fn) => handlers.set(name, fn), getActiveTools: () => ["task", "todo"],
      pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, getLatestTodoPhasesFromEntries, readGoalDeadline: () => undefined },
      appendEntry: () => {}, sendMessage: message => sent.push(message),
    });
    const ctx = { cwd, sessionManager: { getHeader: () => ({ id: "fresh" }), getBranch: () => [] },
      getTodoSnapshot: () => plan, getAsyncJobSnapshot: () => ({ running: [], recent: [] }), getTaskMaxConcurrency: () => 4,
      isIdle: () => false, hasPendingMessages: () => false, setTimeout: () => ({}), clearTimer: () => {},
    };
    await handlers.get("agent_end")({}, ctx);
    await handlers.get("turn_end")({}, ctx);
    const forecast = forecastTodoLivePlan(plan, [], { now: Date.now(), capacity: 4 });
    expect(forecast.calibrationOrigins).toBeGreaterThan(0);
    const coverage = forecast.calibrationCoverage;
    const note = sent.find(message => message.customType === "todo-dispatch-time-note").content;
    expect(note).toContain(`observed coverage ${coverage.covered}/${coverage.total}, ${forecast.calibrationSessions} sessions`);
    expect(note).not.toContain("0 origins, 0 sessions");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
