// @ts-nocheck -- extension runtime fixtures follow the host's forecast contract.
import { expect, test } from "bun:test";
import { idleRedRowsRefusal } from "./todo_dispatch";
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
  expect(reason).toContain("abandon");
  expect(idleRedRowsRefusal(decision(rows, rows.map(row => ({ content: row.content, running: true }))))).toBeUndefined();
});

test("an ownerless clock and an unstaffed at-risk critical path refuse idle; pending healthy neighbours do not", () => {
  const clock = { content: adaptive, status: "in_progress", startedAt: 1 };
  expect(idleRedRowsRefusal(decision([clock]))).toContain(adaptive);
  const critical = { content: "Final full gate", status: "pending", critical: true };
  expect(idleRedRowsRefusal(decision([critical], [], true))).toContain(critical.content);
  expect(idleRedRowsRefusal(decision([critical]))).toBeUndefined();
  expect(idleRedRowsRefusal(decision([{ ...critical, critical: false }], [], true))).toBeUndefined();
  expect(idleRedRowsRefusal(decision([{ ...clock, status: "completed" }]))).toBeUndefined();
  expect(idleRedRowsRefusal(decision([{ ...clock, status: "blocked", overdue: true, waitsForUser: { question: "Approve?" } }]))).toBeUndefined();
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
