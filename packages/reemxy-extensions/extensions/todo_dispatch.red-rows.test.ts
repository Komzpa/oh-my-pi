// @ts-nocheck -- extension runtime fixtures follow the host's forecast contract.
import { expect, test } from "bun:test";
import storedRows from "./fixtures/settled-dc-rows.json";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { decideTodoDispatch, idleRedRowsRefusal } from "./todo_dispatch";
import { overduePreviewRows } from "./todo_preview";

const brag = "Brag video inventory";
const finance = "Finance manifest drift";
const adaptive = "Adaptive 60 MW: annotation leaders cross the hall";
function decision(rows, ownerRunStates = [], atRisk = false) {
  return { alarms: [], ownerRunStates, forecast: { rows, deadlineStatus: atRisk ? "at-risk" : "on-track" } };
}

test("an overdue Brag/Finance model label and attempt do not permit waiting on unrelated jobs", () => {
  const rows = [brag, finance].map(content => ({ content, status: "in_progress", owner: "worker", overdue: true, estimateRevision: 3 }));
  const reason = idleRedRowsRefusal(decision(rows, [{ content: "Other job", running: true }]));
  expect(reason).toContain(brag);
  expect(reason).toContain(finance);
  expect(reason).toContain("task");
  expect(reason).toContain("schedule");
  expect(reason).toContain("user");
  expect(reason).toContain("postDeadline:true");
  expect(idleRedRowsRefusal(decision(rows, rows.map(row => ({ content: row.content, running: true }))))).toContain("WAIT/STOP REFUSED");
});

test("an ownerless clock refuses idle; P95-only risk permits waiting", () => {
  const clock = { content: adaptive, status: "in_progress", startedAt: 1 };
  expect(idleRedRowsRefusal(decision([clock]))).toContain(adaptive);
  const critical = { content: "Final full gate", status: "pending", critical: true };
  expect(idleRedRowsRefusal(decision([critical], [], true))).toBeUndefined();
  expect(idleRedRowsRefusal(decision([critical]))).toBeUndefined();
  expect(idleRedRowsRefusal(decision([{ ...critical, critical: false }], [], true))).toBeUndefined();
  expect(idleRedRowsRefusal(decision([{ ...clock, status: "completed" }]))).toBeUndefined();
  expect(idleRedRowsRefusal(decision([{ ...clock, status: "blocked", overdue: true, waitsForUser: { question: "Approve?" } }]))).toContain("WAIT/STOP REFUSED");
});

test("15-minute preview gap refuses missing and unlanded identities once per row revision", () => {
  const now = 60 * 60_000;
  const rows = [brag, finance].map(content => ({ content, status: "in_progress", schedule: { firstRequirementAt: now - 16 * 60_000, estimateRevision: 1 } }));
  const phases = [{ name: "Delivery", tasks: rows }];
  const records = [{ task: finance, commit: "a".repeat(40) }];
  const config = { enabled: true, thresholdMinutes: 15, paths: [] };
  const stale = overduePreviewRows(phases, records, config, now);
  const notified = new Set();
  const healthy = decision([]);
  const first = idleRedRowsRefusal(healthy, stale, notified);
  expect(first).toContain(brag);
  expect(first).toContain(finance);
  expect(first).toContain("partial change");
  expect(first).toContain("deferUntil");
  expect(idleRedRowsRefusal(healthy, stale, notified)).toBeUndefined();
  rows[0].schedule.estimateRevision++;
  expect(idleRedRowsRefusal(healthy, stale, notified)).toContain(brag);
  expect(overduePreviewRows(phases, records, config, now - 2 * 60_000)).toEqual([]);
  const visible = rows.map(row => ({ task: row.content, commit: "a".repeat(40), visibleAt: now }));
  expect(idleRedRowsRefusal(healthy, overduePreviewRows(phases, visible, config, now))).toBeUndefined();
});

test("a missing commit can be deferred only until its recorded time; an expired or untimed reason is not visibility", () => {
  const now = Date.now();
  const row = { content: brag, status: "in_progress", schedule: { startedAt: now - 16 * 60_000 } };
  const phases = [{ name: "Delivery", tasks: [row] }];
  const config = { enabled: true, thresholdMinutes: 15, paths: [] };
  const record = { task: brag, commit: "", reason: { kind: "deferred", detail: "Preview maintenance", deferUntil: now + 60_000 } };
  expect(overduePreviewRows(phases, [record], config, now)).toEqual([]);
  expect(overduePreviewRows(phases, [record], config, now + 60_001)).toEqual([row]);
  delete record.reason.deferUntil;
  expect(overduePreviewRows(phases, [record], config, now)).toEqual([row]);
});

test("deadline slack uses the resource finish when expected finish is absent, and omits it without a due time", () => {
  const row = { content: adaptive, status: "in_progress", critical: true, resourceFinish: 120_000 };
  const d = decision([row]);
  d.forecast.deadlineStatus = "will-miss";
  d.forecast.deadlineAt = 60_000;
  d.forecast.now = 0;
  expect(idleRedRowsRefusal(d)).toContain("deadline slack -1m");
  delete d.forecast.deadlineAt;
  expect(idleRedRowsRefusal(d)).not.toContain("deadline slack");
});


test("DC settled executors need restaff or verification; running registry workers and a live job pid permit wait", () => {
  const phases = structuredClone(storedRows.phases);
  const rows = phases.flatMap(phase => phase.tasks);
  // Replay after restoring deferred scope to the active plan.
  rows.forEach(row => row.schedule.postDeadline = false);
  const now = Date.parse(storedRows.timestamp);
  const run = jobs => decideTodoDispatch({ phases, jobs, isMainSession: true, taskEnabled: true, now }, schedule);
  const d = run({ running: [], recent: [] });
  const reason = idleRedRowsRefusal(d);
  for (const row of rows) {
    expect(reason).toContain(JSON.stringify(row.content));
    const completed = row.schedule.executor.outcome === "completed";
    expect(reason).toContain(completed ? "verify the result and close" : "restaff with task");
  }
  const staffed = run({ running: rows.map(row => ({ id: row.schedule.executor.workerId, label: row.content, type: "task", status: "running" })), recent: [] });
  staffed.forecast.rows.forEach(row => row.overdue = false);
  expect(idleRedRowsRefusal(staffed)).toBeUndefined();
  rows.forEach(row => row.schedule.owner = `job:${process.pid}`);
  const external = run({ running: [], recent: [] });
  external.forecast.rows.forEach(row => row.overdue = false);
  expect(external.ownerRunStates.every(row => row.running)).toBe(true);
  expect(idleRedRowsRefusal(external)).toBeUndefined();
});

test("completed executor can hand off a visible user preview; review label alone still needs action", () => {
  const row = { content: adaptive, status: "in_progress", startedAt: 1, schedule: { review: "user", visibleAt: 1, reviewPage: "http://localhost:3000/review" } };
  const d = decision([row], [{ content: adaptive, running: false, outcome: "completed" }]);
  expect(idleRedRowsRefusal(d)).toBeUndefined();
  delete row.schedule.reviewPage;
  expect(idleRedRowsRefusal(d)).toContain("verify the result and close");
});
