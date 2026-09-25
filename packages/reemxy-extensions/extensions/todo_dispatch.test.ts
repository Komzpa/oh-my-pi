// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { readGoalDeadline } from "@oh-my-pi/pi-coding-agent/goals/deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import {
  formatPlanForecast,
  formatTaskForecast,
  forecastTodoPlan,
  type TodoScheduleInput,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch, { decideTodoDispatch, type DispatchInput } from "./todo_dispatch";

type Jobs = Pick<AsyncJobSnapshot, "running" | "recent" | "nonJobAgents">;
const now = Date.UTC(2026, 0, 1);
const phases: TodoScheduleInput = [
  {
    name: "Fixes",
    tasks: [
      { content: "Repair export", status: "in_progress" },
      { content: "Repair retrieval", status: "pending" },
    ],
  },
];
const emptyJobs: Jobs = { running: [], recent: [], nonJobAgents: [] };
const forecastApi = { forecastTodoPlan, formatPlanForecast, formatTaskForecast };
const extensionSdk = {
  ...forecastApi,
  readGoalDeadline,
  getLatestTodoPhasesFromEntries,
  agentPauseGate,
};
const base: DispatchInput = {
  phases,
  jobs: emptyJobs,
  isMainSession: true,
  taskEnabled: true,
  now,
  capacity: 0,
};
const scheduledPlan = (content = "Repair deadline risk"): TodoScheduleInput => [
  {
    name: "Fixes",
    tasks: [
      {
        content,
        status: "pending",
        schedule: {
          dependencies: [],
          estimate: {
            optimisticSeconds: 60,
            likelySeconds: 90,
            pessimisticSeconds: 120,
            confidence: "medium",
            basis: "small deterministic fixture",
            updatedAt: now - 1_000,
          },
        },
      },
    ],
  },
];
const due = { goalId: "goal-1", deadlineAt: now + 60 * 60_000 };
const decide = (overrides: Partial<DispatchInput> = {}) =>
  decideTodoDispatch({ ...base, ...overrides }, forecastApi);

describe("todo dispatch supervisor", () => {
  test("alarms once per accepted estimate revision", () => {
    const plan = scheduledPlan();
    const first = decide({ phases: plan, deadline: due, now: now + 120_000 });
    expect(first.forecast?.rows[0]?.overdue).toBe(true);
    plan[0].tasks[0].schedule!.progress = { at: now + 121_000, evidence: "New artifact exists" };
    const evidenceOnly = decide({
      phases: plan,
      deadline: due,
      now: now + 122_000,
      lastWakeKey: first.rawWakeKey,
    });
    expect(evidenceOnly.wakeKey).toBeNull();
    plan[0].tasks[0].schedule!.estimateRevision = 3;
    plan[0].tasks[0].schedule!.reestimateCount = 2;
    const repeat = decide({
      phases: plan,
      deadline: due,
      now: now + 122_000,
      lastWakeKey: first.rawWakeKey,
    });
    expect(repeat.wakeKey).not.toBeNull();
    expect(repeat.forecast?.rows[0]?.reestimateCount).toBe(2);
  });

  test("nudges an idle root once each overdue minute without a new estimate", () => {
    const plan = scheduledPlan("Recover worker output");
    const first = decide({ phases: plan, deadline: due, now: now + 120_000 });
    expect(first.wakeKey).not.toBeNull();
    const sameMinute = decide({ phases: plan, deadline: due, now: now + 120_500, lastWakeKey: first.rawWakeKey });
    expect(sameMinute.wakeKey).toBeNull();
    const nextMinute = decide({ phases: plan, deadline: due, now: now + 180_000, lastWakeKey: first.rawWakeKey });
    expect(nextMinute.wakeKey).not.toBeNull();
    const noGoalDeadline = decide({ phases: plan, now: now + 120_000 });
    expect(noGoalDeadline.wakeKey).toBeNull();
    expect(noGoalDeadline.nextCheckMs).toBeNull();
    expect(
      decide({ phases: plan, now: now + 120_500, lastWakeKey: noGoalDeadline.rawWakeKey }).wakeKey,
    ).toBeNull();
    expect(
      decide({ phases: plan, now: now + 180_000, lastWakeKey: noGoalDeadline.rawWakeKey }).wakeKey,
    ).toBeNull();
    expect(decide({ phases: plan, deadline: { ...due, paused: true }, now: now + 120_000 }).wakeKey).toBeNull();

    const normalAlarm = decide({ phases: scheduledPlan("Not late"), deadline: due });
    expect(normalAlarm.wakeKey).not.toBeNull();
    expect(normalAlarm.alarms.some((alarm) => alarm.startsWith("overdue-todo-minute:"))).toBe(false);
    expect(decide({ phases: scheduledPlan("Not late"), deadline: due, now: now + 60_000, lastWakeKey: normalAlarm.rawWakeKey }).wakeKey).toBeNull();
  });

  test("fixed deadline risk calls for path diagnosis and conditional model escalation only", () => {
    const plan = scheduledPlan("Finish before fixed due");
    const decision = decide({ phases: plan, deadline: { ...due, deadlineAt: now + 30_000 } });
    expect(decision.alarms.some((alarm) => alarm.startsWith("deadline-risk-"))).toBe(true);
    expect(decision.alarms.some((alarm) => alarm.startsWith("overdue-todo-minute:"))).toBe(false);
    const sameMinute = decide({ phases: plan, deadline: { ...due, deadlineAt: now + 30_000 }, now: now + 500, lastWakeKey: decision.rawWakeKey });
    expect(sameMinute.wakeKey).toBeNull();
    const nextMinute = decide({ phases: plan, deadline: { ...due, deadlineAt: now + 30_000 }, now: now + 60_000, lastWakeKey: decision.rawWakeKey });
    expect(nextMinute.wakeKey).not.toBeNull();
    expect(decision.rawWakeKey).not.toBeNull();
  });

  test("accepted reestimate is not evidence of an earlier missed ETA", () => {
    const plan = scheduledPlan("Integrate then verify");
    plan[0].tasks[0].schedule!.estimateRevision = 2;
    plan[0].tasks[0].schedule!.reestimateCount = 1;
    plan[0].tasks[0].schedule!.progress = { at: now, evidence: "Code ready; build, installation, launch, and final readback pending" };
    const fixedDue = now + 100_000;
    const sdk = {
      ...forecastApi,
      forecastTodoPlan: (...args: Parameters<typeof forecastTodoPlan>) => {
        const forecast = forecastTodoPlan(...args);
        return { ...forecast, rows: forecast.rows.map(row => ({ ...row, overdue: args[1].now > fixedDue, reestimateCount: plan[0].tasks[0].schedule!.reestimateCount, estimateRevision: plan[0].tasks[0].schedule!.estimateRevision })) };
      },
    };
    const input = { ...base, phases: plan, deadline: due };
    const onTime = decideTodoDispatch({ ...input, now }, sdk);
    expect(onTime.forecast?.rows[0]?.overdue).toBe(false);
    expect(onTime.forecast?.rows[0]?.reestimateCount).toBe(1);

    const overdue = decideTodoDispatch({ ...input, now: now + 120_000 }, sdk);
    expect(overdue.forecast?.rows[0]?.overdue).toBe(true);
    expect(overdue.forecast?.rows[0]?.reestimateCount).toBe(1);
  });

  test("whole-plan missing estimates include blocked rows and deduplicate until plan changes", () => {
    const plan: TodoScheduleInput = [
      {
        name: "Work",
        tasks: [
          { content: "Inspect bounded input", status: "in_progress" },
          { content: "Prepare independent artifact", status: "pending" },
          { content: "Await access approval", status: "blocked", blocker: "external approval" },
          { content: "Previous completed work", status: "completed" },
          { content: "Abandoned experiment", status: "abandoned" },
        ],
      },
    ];
    const first = decide({ phases: plan, deadline: due });
    expect(first.forecast?.planningIssues?.filter((issue) => issue.code === "missing-estimate").map((issue) => issue.task).sort()).toEqual([
      "Await access approval",
      "Inspect bounded input",
      "Prepare independent artifact",
    ]);
    expect(first.wakeKey).not.toBeNull();
    plan[0].tasks[0].schedule = { progress: { at: now + 1000, evidence: "Input inspected" } };
    expect(
      decide({ phases: plan, deadline: due, lastWakeKey: first.rawWakeKey }).wakeKey,
    ).toBeNull();
    const direct = decide({ phases: plan, deadline: undefined });
    expect(direct.alarms).toEqual(first.alarms);
    expect(direct.wakeKey).toBeNull();
    plan[0].tasks[0].schedule = { ...scheduledPlan()[0].tasks[0].schedule, owner: "Inspector" };
    const estimated = decide({ phases: plan, deadline: due, lastWakeKey: first.rawWakeKey });
    expect(estimated.forecast?.planningIssues?.filter((issue) => issue.code === "missing-estimate").map((issue) => issue.task).sort()).toEqual([
      "Await access approval",
      "Prepare independent artifact",
    ]);
    expect(estimated.wakeKey).not.toBeNull();
  });

  test("canonical planning issues require decomposition beyond one hour", () => {
    const plan: TodoScheduleInput = [
      {
        name: "Long task",
        tasks: [
          {
            content: "Bounded repair",
            status: "pending",
            schedule: {
              dependencies: [],
              estimate: {
                optimisticSeconds: 3_000,
                likelySeconds: 3_600,
                pessimisticSeconds: 3_601,
                confidence: "medium",
                basis: "evidence-backed fixture",
                updatedAt: now,
              },
            },
          },
        ],
      },
    ];
    const result = decide({ phases: plan });
    expect(result.forecast?.planningIssues?.some((issue) => issue.code === "task-too-large" && issue.task === "Bounded repair")).toBe(true);
  });

  test("paused deadline remains observable without wake or timer authority", () => {
    const plan = scheduledPlan();
    plan[0].tasks.push({ content: "External unknown", status: "blocked", blocker: "approval" });
    const deadline = { goalId: "goal-1", deadlineAt: now + 10_000, paused: true };
    const result = decide({ phases: plan, deadline });
    expect(result.forecast?.deadlineAt).toBe(deadline.deadlineAt);
    expect(result.forecast?.resourceFinish).toBeUndefined();
    expect(result.forecast?.knownWorkFinish).toBeGreaterThan(deadline.deadlineAt);
    expect(result.wakeKey).toBeNull();
    expect(result.nextCheckMs).toBeNull();
  });

  test("keeps all 25 rows visible and preserves the explicit tail beyond the 64-row bound", () => {
    const plan: TodoScheduleInput = [
      {
        name: "Independent files",
        tasks: Array.from({ length: 25 }, (_, n) => ({
          content: `Fix isolated surface ${n + 1}`,
          status: "pending" as const,
        })),
      },
    ];
    const decision = decide({ phases: plan });
    for (const n of [1, 16, 17, 25]) expect(decision.prompt).toContain(`Fix isolated surface ${n}`);
    expect(decision.prompt).toContain("#25 [pending]");

    const longPlan: TodoScheduleInput = [
      {
        name: "Long tail",
        tasks: Array.from({ length: 65 }, (_, n) => ({
          content: `Tail surface ${n + 1}`,
          status: "pending" as const,
        })),
      },
    ];
    const bounded = decide({ phases: longPlan });
    expect(bounded.prompt).toContain("Tail surface 25");
    expect(bounded.prompt).toContain("Tail surface 64");
    expect(bounded.prompt).toContain("Tail surface 65");
    expect(bounded.prompt).toContain("tail=1");
  });

  test("recalculates CPM late-start and fixed-deadline risk without changing the static plan key", () => {
    const plan = scheduledPlan();
    const first = decide({ phases: plan, deadline: due });
    const latestStart = first.forecast?.rows[0]?.latestStart;
    if (latestStart === undefined) throw new Error("forecast did not produce a CPM latest start");
    const late = decide({ phases: plan, deadline: due, now: latestStart + 1 });
    expect(late.key).toBe(first.key);
    expect(late.alarms.some((alarm) => alarm.startsWith("late-start:"))).toBe(true);
    expect(late.prompt).toContain("late-start:");

    const overdue = decide({ phases: plan, deadline: due, now: due.deadlineAt + 1 });
    expect(overdue.key).toBe(first.key);
    expect(overdue.alarms).toContain(`deadline-overdue:${due.deadlineAt}`);
  });

  test("reuses static serialization but injects a fresh forecast on every request", () => {
    const first = decide();
    const second = decide({
      now: now + 1_000,
      cachedStatic: { key: first.key!, text: first.staticPrompt! },
    });
    expect(second.key).toBe(first.key);
    expect(second.staticPrompt).toBe(first.staticPrompt);
    expect(second.prompt).toContain(new Date(now + 1_000).toISOString());
    expect(second.prompt).not.toBe(first.prompt);
  });

  test("signals failed task children for exact-worker recovery, not unrelated failed jobs", () => {
    const failedTask: Jobs["recent"][number] = {
      id: "task-failed-7",
      type: "task",
      status: "failed",
      label: "Write export",
      startTime: now,
      agentId: "ExportWriter",
    };
    const failedBash: Jobs["recent"][number] = {
      id: "bash-failed-2",
      type: "bash",
      status: "failed",
      label: "unrelated command",
      startTime: now,
    };
    const decision = decide({
      jobs: { running: [], recent: [failedTask, failedBash] },
      deadline: due,
    });
    expect(decision.prompt).toContain("task-failed-7");
    expect(decision.prompt).toContain("ExportWriter");
    expect(decision.alarms).toContain("failed-child:task-failed-7:failed");
    expect(decision.alarms.some((alarm) => alarm.startsWith("failed-child:bash-failed-2:"))).toBe(
      false,
    );
  });

  test("inactive goals and child sessions suppress wakes; active children do not block independent candidates", () => {
    const plan = scheduledPlan("Independent ready change");
    const active = decide({ phases: plan, deadline: due });
    expect(active.wakeKey).not.toBeNull();
    const alreadyWoken = decide({ phases: plan, deadline: due, lastWakeKey: active.rawWakeKey });
    expect(alreadyWoken.rawWakeKey).toBe(active.rawWakeKey);
    expect(alreadyWoken.wakeKey).toBeNull();

    // readGoalDeadline maps paused/completed/cleared lifecycle states to no active deadline.
    expect(decide({ phases: plan, deadline: undefined }).wakeKey).toBeNull();
    expect(decide({ phases: plan, deadline: due, isMainSession: false }).wakeKey).toBeNull();
    expect(decide({ phases: plan, deadline: due, taskEnabled: false }).wakeKey).toBeNull();
    expect(
      decide({
        phases: [{ name: "Done", tasks: [{ content: "Finished", status: "completed" }] }],
        deadline: due,
      }).wakeKey,
    ).toBeNull();

    const runningChild: Jobs["running"][number] = {
      id: "child-active",
      type: "task",
      status: "running",
      label: "Other isolated work",
      startTime: now,
      agentId: "OtherWorker",
    };
    expect(
      decide({ phases: plan, deadline: due, jobs: { running: [runningChild], recent: [], nonJobAgents: [] } })
        .wakeKey,
    ).not.toBeNull();
  });

  test("blocked-only plans produce a recovery action and one changed-plan wake", () => {
    const blocked: TodoScheduleInput = [
      {
        name: "Gate",
        tasks: [
          {
            content: "Publish review",
            status: "blocked",
            blocker: "await integrated build",
          },
        ],
      },
    ];
    const first = decide({ phases: blocked, deadline: due });
    expect(first.alarms).toContain(
      `blocked-recovery:${JSON.stringify("Publish review")}:${JSON.stringify("await integrated build")}`,
    );
    expect(first.wakeKey).not.toBeNull();
    expect(
      decide({ phases: blocked, deadline: due, lastWakeKey: first.rawWakeKey }).wakeKey,
    ).toBeNull();
    blocked[0].tasks[0].blocker = "build result needs inspection";
    expect(
      decide({ phases: blocked, deadline: due, lastWakeKey: first.rawWakeKey }).wakeKey,
    ).not.toBeNull();
    expect(
      decide({ phases: blocked, deadline: { ...due, paused: true } }).wakeKey,
    ).toBeNull();

    const missingSnapshot = decide({ jobs: null });
    const readyWithoutSnapshot = decide({ phases: scheduledPlan(), jobs: null, deadline: due });
    expect(missingSnapshot.staffingSnapshotComplete).toBe(false);
    expect(readyWithoutSnapshot.staffingSnapshotComplete).toBe(false);
    expect(readyWithoutSnapshot.dispatchableReady).toEqual([]);
    expect(readyWithoutSnapshot.prompt).toMatch(/FAIL CLOSED/);
  });
  test("ready ownership requires an exact live task id or live non-job id", () => {
    const readyPlan = (owner?: string): TodoScheduleInput => [
      {
        name: "Ready",
        tasks: [
          {
            content: "Safe independent change",
            status: "pending",
            schedule: {
              ...(owner ? { owner } : {}),
              dependencies: [],
              estimate: {
                optimisticSeconds: 60,
                likelySeconds: 90,
                pessimisticSeconds: 120,
                confidence: "medium",
                basis: "dispatch regression",
                updatedAt: now,
              },
            },
          },
        ],
      },
    ];
    const taskJob: Jobs["running"][number] = {
      id: "ExactWorker",
      type: "task",
      status: "running",
      label: "Unrelated label",
      startTime: now,
    };
    const unknownCapacity = decide({ phases: readyPlan(), jobs: emptyJobs, capacity: undefined });
    expect(unknownCapacity.capacity).toBeUndefined();
    expect(unknownCapacity.prompt).toMatch(/FAIL CLOSED: Task capacity is unknown/);
    expect(decide({ phases: readyPlan("Main") }).readyCandidates[0]?.ownership).toBe("unverified");
    expect(
      decide({ phases: readyPlan("ExactWorker"), jobs: { running: [taskJob], recent: [] } })
        .readyCandidates[0]?.ownership,
    ).toBe("live-owned");
    const knownRunningOwner = decide({
      phases: readyPlan("ExactWorker"),
      jobs: { running: [taskJob], recent: [] },
      deadline: due,
    });
    expect(knownRunningOwner.readyCandidates[0]?.ownership).toBe("live-owned");
    expect(
      decide({
        phases: readyPlan("LinkedWorker"),
        jobs: { running: [{ ...taskJob, id: "job-17", agentId: "LinkedWorker" }], recent: [] },
      }).readyCandidates[0]?.ownership,
    ).toBe("live-owned");
    expect(
      decide({
        phases: readyPlan("RosterWorker"),
        jobs: { running: [], recent: [], nonJobAgents: [{ id: "RosterWorker", live: true }] },
      }).readyCandidates[0]?.ownership,
    ).toBe("idle-live-owner");
    const activeRestored = decide({
      phases: readyPlan("RestoredWorker"),
      jobs: { running: [], recent: [], nonJobAgents: [{ id: "RestoredWorker", live: true }] },
      persistedChildren: [{ id: "RestoredWorker", owner: "job-restored-worker", live: true }],
    });
    expect(activeRestored.readyCandidates[0]?.ownership).toBe("live-owned");
    expect(activeRestored.activeTaskCount).toBe(1);
    expect(
      decide({
        phases: readyPlan("job-restored-worker"),
        jobs: { running: [], recent: [], nonJobAgents: [{ id: "RestoredWorker", live: true }] },
        persistedChildren: [{ id: "RestoredWorker", owner: "job-restored-worker", live: true }],
      }).readyCandidates[0]?.ownership,
    ).toBe("live-owned");
    expect(
      decide({
        phases: readyPlan("RestoredWorker"),
        jobs: { running: [], recent: [], nonJobAgents: [{ id: "RestoredWorker", live: true }] },
        persistedChildren: [{ id: "RestoredWorker", owner: "job-restored-worker", live: true }],
        idleResumeAttempts: new Set(["RestoredWorker"]),
      }).readyCandidates[0]?.ownership,
    ).toBe("idle-live-owner");
    expect(
      decide({
        phases: readyPlan("RosterWorker"),
        jobs: { running: [], recent: [], nonJobAgents: [{ id: "RosterWorker", live: false }] },
      }).readyCandidates[0]?.ownership,
    ).toBe("unverified");
    expect(
      decide({
        phases: readyPlan("display label only"),
        jobs: { running: [taskJob], recent: [] },
      }).readyCandidates[0]?.ownership,
    ).toBe("unverified");
  });
  test("each ready unstaffed row asks for a worker while blocked and dependency-waiting rows stay out", () => {
    const schedule = (dependencies: string[], owner?: string) => ({
      ...(owner ? { owner } : {}),
      dependencies,
      estimate: {
        optimisticSeconds: 60,
        likelySeconds: 90,
        pessimisticSeconds: 120,
        confidence: "medium" as const,
        basis: "worker dispatch regression",
        updatedAt: now,
      },
    });
    const plan: TodoScheduleInput = [
      {
        name: "Dispatch",
        tasks: [
          { content: "Ready one", status: "pending", schedule: schedule([]) },
          { content: "Ready two", status: "pending", schedule: schedule([], "Main") },
          {
            content: "Await ready one",
            status: "pending",
            schedule: schedule(["Ready one"]),
          },
          {
            content: "Await approval",
            status: "blocked",
            blocker: "approval required",
            schedule: schedule([]),
          },
        ],
      },
    ];
    const input = { phases: plan, jobs: emptyJobs, deadline: due };
    const first = decide(input);
    expect(first.readyCandidates.map((row) => row.content)).toEqual(["Ready one", "Ready two"]);
    expect(first.readyCandidates.every((row) => row.ownership !== "live-owned")).toBe(true);
    expect(first.dispatchableReady.map((row) => row.content)).toEqual(["Ready one", "Ready two"]);
    expect(first.forecast?.rows.find((row) => row.content === "Await ready one")?.ready).toBe(false);
    expect(first.rawWakeKey).not.toBeNull();
    expect(decide({ ...input, lastWakeKey: first.rawWakeKey }).wakeKey).toBeNull();
  });
  test("settled child reopens its unfinished ready row without displacing live or blocked work", () => {
    const schedule = (dependencies: string[], owner?: string) => ({
      ...(owner ? { owner } : {}),
      dependencies,
      resources: [],
      estimate: {
        optimisticSeconds: 60,
        likelySeconds: 90,
        pessimisticSeconds: 120,
        confidence: "medium" as const,
        basis: "completed worker supervisor regression",
        updatedAt: now,
      },
    });
    const plan: TodoScheduleInput = [{
      name: "Concurrent repairs",
      tasks: [
        { content: "Unfinished export", status: "pending", schedule: schedule([], "ExitingWorker") },
        { content: "Active retrieval", status: "in_progress", schedule: schedule([], "ActiveWorker") },
        { content: "Independent UI", status: "pending", schedule: schedule([]) },
        { content: "Integrate export", status: "pending", schedule: schedule(["Unfinished export"]) },
        { content: "Publish gate", status: "blocked", blocker: "await review", schedule: schedule([]) },
      ],
    }];
    const exiting: Jobs["running"][number] = {
      id: "job-export", type: "task", status: "running", label: "Export writer", startTime: now, agentId: "ExitingWorker",
    };
    const active: Jobs["running"][number] = {
      id: "job-retrieval", type: "task", status: "running", label: "Retrieval writer", startTime: now, agentId: "ActiveWorker",
    };
    const before = decide({ phases: plan, jobs: { running: [exiting, active], recent: [], nonJobAgents: [] }, deadline: due });
    expect(before.readyCandidates.map(({ content, ownership }) => [content, ownership])).toEqual([
      ["Unfinished export", "live-owned"],
      ["Active retrieval", "live-owned"],
      ["Independent UI", "unassigned"],
    ]);

    const after = decide({
      phases: plan,
      jobs: { running: [active], recent: [{ ...exiting, status: "completed" }], nonJobAgents: [] },
      deadline: due,
      lastWakeKey: before.rawWakeKey,
    });
    expect(after.readyCandidates.map(({ content, ownership }) => [content, ownership])).toEqual([
      ["Unfinished export", "unverified"],
      ["Active retrieval", "live-owned"],
      ["Independent UI", "unassigned"],
    ]);
    expect(after.wakeKey).not.toBeNull();
    expect(after.dispatchableReady.map((row) => row.content)).toEqual([
      "Unfinished export",
      "Independent UI",
    ]);
    expect(after.forecast?.rows.find((row) => row.content === "Integrate export")?.ready).toBe(false);
  });

  test("runtime Task capacity changes independent-row starts, finish, and wake revision", () => {
    const task = (content: string) => ({
      content,
      status: "pending" as const,
      schedule: {
        dependencies: [],
        resources: [],
        estimate: {
          optimisticSeconds: 60,
          likelySeconds: 90,
          pessimisticSeconds: 120,
          confidence: "medium" as const,
          basis: "live capacity regression",
          updatedAt: now,
        },
      },
    });
    const plan: TodoScheduleInput = [
      { name: "Independent work", tasks: [task("Capacity one"), task("Capacity two")] },
    ];
    const input = { phases: plan, jobs: emptyJobs, deadline: due };
    const serial = decide({ ...input, capacity: 1 });
    const parallel = decide({ ...input, capacity: 2, lastWakeKey: serial.rawWakeKey });
    const unlimited = decide({ ...input, capacity: 0, lastWakeKey: serial.rawWakeKey });
    const serialStart = serial.forecast?.rows.find((row) => row.content === "Capacity two")?.resourceStart;
    const parallelStart = parallel.forecast?.rows.find((row) => row.content === "Capacity two")?.resourceStart;
    const unlimitedStart = unlimited.forecast?.rows.find((row) => row.content === "Capacity two")?.resourceStart;
    const serialFinish = serial.forecast?.resourceFinish;
    const parallelFinish = parallel.forecast?.resourceFinish;
    const unlimitedFinish = unlimited.forecast?.resourceFinish;
    if (
      serialStart === undefined ||
      parallelStart === undefined ||
      unlimitedStart === undefined ||
      serialFinish === undefined ||
      parallelFinish === undefined ||
      unlimitedFinish === undefined
    )
      throw new Error("resource forecast omitted independent task timing");
    expect(serialStart).toBeGreaterThan(parallelStart);
    expect(unlimitedStart).toBe(parallelStart);
    expect(serialFinish).toBeGreaterThan(parallelFinish);
    expect(unlimitedFinish).toBe(parallelFinish);
    expect(serial.key).not.toBe(parallel.key);
    expect(parallel.key).not.toBe(unlimited.key);
    expect(serial.rawWakeKey).not.toBe(parallel.rawWakeKey);
    expect(parallel.rawWakeKey).not.toBe(unlimited.rawWakeKey);
    expect(parallel.wakeKey).not.toBeNull();
    expect(unlimited.wakeKey).not.toBeNull();
  });

  test("a completed-looking task job in the running snapshot does not prove live ownership", () => {
    const staleJob = {
      id: "StaleWorker",
      type: "task" as const,
      status: "completed" as const,
      label: "StaleWorker",
      startTime: now,
    };
    const plan = scheduledPlan("Stale assignment");
    plan[0].tasks[0].schedule!.owner = "StaleWorker";
    expect(
      decide({
        phases: plan,
        jobs: { running: [staleJob], recent: [], nonJobAgents: [] },
      }).readyCandidates[0]?.ownership,
    ).toBe("unverified");
  });
  test("independent ready rows require distinct live owners while a dependency chain may reuse one", () => {
    const schedule = (dependencies: string[], owner: string) => ({
      owner,
      dependencies,
      estimate: {
        optimisticSeconds: 60,
        likelySeconds: 90,
        pessimisticSeconds: 120,
        confidence: "medium" as const,
        basis: "worker identity regression",
        updatedAt: now,
      },
    });
    const jobs: Jobs = {
      running: [],
      recent: [],
      nonJobAgents: [{ id: "SharedWorker", live: true }],
    };
    const independent: TodoScheduleInput = [
      {
        name: "Independent",
        tasks: [
          { content: "Independent one", status: "pending", schedule: schedule([], "SharedWorker") },
          { content: "Independent two", status: "pending", schedule: schedule([], "SharedWorker") },
        ],
      },
    ];
    const independentDecision = decide({ phases: independent, jobs, deadline: due });
    expect(independentDecision.readyCandidates.map((row) => row.ownership)).toEqual([
      "idle-live-owner",
      "idle-live-owner",
    ]);
    expect(independentDecision.dispatchableReady.map((row) => row.content)).toEqual([
      "Independent one",
    ]);
    expect(
      independentDecision.forecast?.rows.find((row) => row.content === "Independent two")?.resourceStart,
    ).toBeGreaterThan(now);
    const exactWorkers = (first: string, second: string): TodoScheduleInput => [
      {
        name: "Actual Task IDs",
        tasks: [
          { content: "Actual worker one", status: "pending", schedule: schedule([], first) },
          { content: "Actual worker two", status: "pending", schedule: schedule([], second) },
        ],
      },
    ];
    const actualJobs: Jobs = {
      running: [
        { id: "task-job-one", type: "task", status: "running", label: "one", startTime: now },
        { id: "task-job-two", type: "task", status: "running", label: "two", startTime: now },
      ],
      recent: [],
      nonJobAgents: [],
    };
    const distinctJobDecision = decide({
      phases: exactWorkers("task-job-one", "task-job-two"),
      jobs: actualJobs,
      deadline: due,
    });
    expect(distinctJobDecision.readyCandidates.map((row) => row.ownership)).toEqual([
      "live-owned",
      "live-owned",
    ]);
    const duplicateJobDecision = decide({
      phases: exactWorkers("task-job-one", "task-job-one"),
      jobs: actualJobs,
      deadline: due,
    });
    expect(duplicateJobDecision.readyCandidates.map((row) => row.ownership)).toEqual([
      "live-owned",
      "shared-live-owner",
    ]);
    expect(duplicateJobDecision.dispatchableReady).toEqual([]);


    const aliasedJob: Jobs["running"][number] = {
      id: "job-17",
      type: "task",
      status: "running",
      label: "description is not identity",
      startTime: now,
      agentId: "SharedWorker",
    };
    const aliases: TodoScheduleInput = [
      {
        name: "Alias identity",
        tasks: [
          { content: "Job ID owner", status: "pending", schedule: schedule([], "job-17") },
          { content: "Agent ID owner", status: "pending", schedule: schedule([], "SharedWorker") },
        ],
      },
    ];
    const aliasDecision = decide({
      phases: aliases,
      jobs: { running: [aliasedJob], recent: [], nonJobAgents: [] },
      deadline: due,
    });
    expect(aliasDecision.readyCandidates.map((row) => row.ownership)).toEqual([
      "live-owned",
      "shared-live-owner",
    ]);

    const collidingIds: Jobs["running"] = [
      { ...aliasedJob, id: "SharedWorker", agentId: "OtherWorker" },
      { ...aliasedJob, id: "job-18", agentId: "SharedWorker" },
    ];
    const collisionPlan: TodoScheduleInput = [
      {
        name: "ID namespace collision",
        tasks: [
          { content: "Worker identity one", status: "pending", schedule: schedule([], "SharedWorker") },
          { content: "Worker identity two", status: "pending", schedule: schedule([], "OtherWorker") },
        ],
      },
    ];
    expect(
      decide({
        phases: collisionPlan,
        jobs: { running: collidingIds, recent: [], nonJobAgents: [] },
        deadline: due,
      }).readyCandidates.map((row) => row.ownership),
    ).toEqual(["live-owned", "live-owned"]);

    const chain: TodoScheduleInput = [
      {
        name: "Sequential",
        tasks: [
          { content: "First in chain", status: "pending", schedule: schedule([], "SharedWorker") },
          {
            content: "Second in chain",
            status: "pending",
            schedule: schedule(["First in chain"], "SharedWorker"),
          },
        ],
      },
    ];
    const chainDecision = decide({ phases: chain, jobs, deadline: due });
    expect(chainDecision.readyCandidates.map((row) => row.content)).toEqual(["First in chain"]);
    expect(chainDecision.readyCandidates[0]?.ownership).toBe("idle-live-owner");
    expect(chainDecision.alarms).not.toContain(
      `ownerless-ready:${JSON.stringify("Second in chain")}`,
    );
    expect(
      chainDecision.forecast?.rows.find((row) => row.content === "Second in chain")?.resourceStart,
    ).toBeGreaterThan(now);
  });


  test("ready tail rows and unrelated active jobs do not suppress candidates", () => {
    const plan: TodoScheduleInput = [
      {
        name: "Parallel work",
        tasks: Array.from({ length: 65 }, (_, index) => ({
          content: `Disjoint change ${index + 1}`,
          status: "pending" as const,
          schedule: {
            dependencies: [],
            resources: [`file-${index + 1}`],
            estimate: {
              optimisticSeconds: 60,
              likelySeconds: 90,
              pessimisticSeconds: 120,
              confidence: "medium" as const,
              basis: "independent fixture",
              updatedAt: now,
            },
          },
        })),
      },
    ];
    const unrelated: Jobs["running"][number] = {
      id: "UnrelatedWorker",
      type: "task",
      status: "running",
      label: "Different owner",
      startTime: now,
    };
    const decision = decide({ phases: plan, jobs: { running: [unrelated], recent: [] } });
    expect(decision.readyCandidates).toHaveLength(65);
    expect(decision.readyCandidates[64]?.content).toBe("Disjoint change 65");
    expect(decision.alarms).toContain(`ownerless-ready:${JSON.stringify("Disjoint change 65")}`);
  });

  test("restored owners are resumed once and unowned or dependency-waiting rows are not duplicated", () => {
    const task = (content: string, owner?: string, dependencies: string[] = []) => ({
      content,
      status: "pending" as const,
      schedule: {
        ...(owner ? { owner } : {}),
        dependencies,
        estimate: {
          optimisticSeconds: 30,
          likelySeconds: 60,
          pessimisticSeconds: 90,
          confidence: "high" as const,
          basis: "restart roster fixture",
          updatedAt: now,
        },
      },
    });
    const plan: TodoScheduleInput = [{
      name: "Recovered work",
      tasks: [
        task("Parked row", "agent-parked-a"),
        task("Fresh disjoint row", "fresh-worker-a"),
        task("Predecessor", "predecessor-worker"),
        task("Dependency waiting", "waiting-worker", ["Predecessor"]),
        task("Unowned after restart"),
      ],
    }];
    const decision = decide({
      phases: plan,
      jobs: emptyJobs,
      restoredChildren: [
        { id: "agent-parked-a", owner: "job-parked-a", live: true },
        { id: "agent-parked-b", owner: "job-parked-b", live: true },
      ],
      deadline: due,
      capacity: 3,
      dispatchGateAvailable: true,
    });
    expect(decision.readyCandidates.find((row) => row.content === "Parked row")?.ownership).toBe("restored-owner");
    // A restored owner is not running after startup: its row is staffed again under that owner's name.
    expect(decision.dispatchableReady?.map((row) => row.content)).toEqual([
      "Parked row",
      "Fresh disjoint row",
      "Predecessor",
    ]);
    expect(decision.forecast?.rows.find((row) => row.content === "Dependency waiting")?.ready).toBe(false);
    expect(decision.prompt).toContain("task item whose name is the owner");
    expect(decision.prompt).toContain("fresh-dispatch only ready rows disjoint");
  });

});

test("first context after restart reconciles persisted parked children when the live snapshot is empty", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const branch: unknown[] = [
    {
      type: "custom",
      customType: "todo-dispatch-roster",
      data: {
        version: 1,
        children: [
          { id: "agent-parked-a", owner: "job-parked-a", live: true },
          { id: "agent-parked-b", owner: "job-parked-b", live: true },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "todo", details: { phases } },
    },
  ];
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    getActiveTools: () => ["task"],
    pi: extensionSdk,
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/no-native-active-goal-fixture",
    sessionManager: {
      getHeader: () => ({ id: "root" }),
      getBranch: () => branch,
    },
    getAsyncJobSnapshot: () => emptyJobs,
  } as unknown as ExtensionContext;
  handlers.get("session_start")!({}, ctx);
  const result = (await handlers.get("context")!({ messages: [] }, ctx)) as
    | { messages: Array<{ content: string }> }
    | undefined;
  const prompt = result?.messages[0]?.content ?? "";
  expect(prompt).toContain("job-parked-a");
  expect(prompt).toContain("agent-parked-a");
  expect(prompt).toContain("job-parked-b");
  expect(prompt).toContain("agent-parked-b");
  expect(prompt).toContain("parked/restored");
  expect(prompt).toContain("exact resume");
  expect(prompt).toContain("empty live snapshot is not nothing-to-reconcile");
});
test("first-context 13-row dispatch becomes observation-only when paused", async () => {
  const liveNow = Date.now();
  let paused = false;
  const plan: TodoScheduleInput = [
    {
      name: "Overdue copied fixture",
      tasks: Array.from({ length: 13 }, (_, index) => ({
        content: `Overdue row ${index + 1}`,
        status: "pending" as const,
        schedule: {
          dependencies: [],
          estimate: {
            optimisticSeconds: 30,
            likelySeconds: 60,
            pessimisticSeconds: 90,
            confidence: "high" as const,
            basis: "copied first-context fixture",
            updatedAt: liveNow - 120_000,
          },
        },
      })),
    },
  ];
  const branch: unknown[] = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } },
  ];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    getActiveTools: () => ["task"],
    registerSoftToolRequirementProvider: () => undefined,
    pi: {
      ...extensionSdk,
      readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow - 60_000, paused }),
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/no-native-active-goal-fixture",
    sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
    getAsyncJobSnapshot: () => emptyJobs,
    getTaskMaxConcurrency: () => 13,
  } as unknown as ExtensionContext;
  const request = async () =>
    (await handlers.get("context")!({ messages: [] }, ctx)) as
      | { messages: Array<{ content: string }> }
      | undefined;
  handlers.get("session_start")!({}, ctx);
  const activePrompt = (await request())?.messages[0]?.content ?? "";
  expect(activePrompt).toContain("#13 [pending] \"Overdue row 13\"");
  expect(activePrompt).toContain("immediately start distinct live workers");
  expect(activePrompt).toContain("fresh-dispatch only ready rows disjoint");

  paused = true;
  handlers.get("session_start")!({}, ctx);
  const pausedPrompt = (await request())?.messages[0]?.content ?? "";
  expect(pausedPrompt).toContain("Paused goal: observation only");
  expect(pausedPrompt).toContain("exact Task/non-job worker roster");
  expect(pausedPrompt).toContain("#13 [pending] \"Overdue row 13\"");
  expect(pausedPrompt).not.toContain("immediately start distinct live workers");
  expect(pausedPrompt).not.toContain("fresh-dispatch");
});

test("agent_end and shutdown persist child IDs for an empty-snapshot restart", async () => {
  const branch: unknown[] = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases } } },
  ];
  const firstJob = {
    id: "job-parked-a",
    type: "task" as const,
    status: "running" as const,
    label: "parked child A",
    startTime: now,
    agentId: "agent-parked-a",
  };
  const secondJob = {
    ...firstJob,
    id: "job-parked-b",
    label: "parked child B",
    agentId: "agent-parked-b",
  };
  let jobs: Jobs = {
    running: [firstJob],
    recent: [],
    nonJobAgents: [{ id: "agent-parked-a", live: true }],
  };
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    getActiveTools: () => ["task"],
    appendEntry: (customType: string, data?: unknown) => {
      branch.push({ type: "custom", customType, data });
    },
    pi: extensionSdk,
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/no-native-active-goal-fixture",
    sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
    getAsyncJobSnapshot: () => jobs,
  } as unknown as ExtensionContext;
  handlers.get("agent_end")!({}, ctx);
  jobs = {
    running: [secondJob],
    recent: [],
    nonJobAgents: [{ id: "agent-parked-b", live: true }],
  };
  handlers.get("session_shutdown")!({}, ctx);
  const saved = [...branch].reverse().find((entry) =>
    typeof entry === "object" && entry !== null &&
    "customType" in entry && entry.customType === "todo-dispatch-roster",
  );
  expect(saved).toMatchObject({
    data: {
      version: 1,
      children: [
        { id: "agent-parked-a", owner: "job-parked-a", live: true },
        { id: "agent-parked-b", owner: "job-parked-b", live: true },
      ],
    },
  });

  const resumedHandlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      resumedHandlers.set(event, handler),
    getActiveTools: () => ["task"],
    pi: extensionSdk,
  } as unknown as ExtensionAPI);
  const resumedCtx = { ...ctx, getAsyncJobSnapshot: () => emptyJobs } as ExtensionContext;
  resumedHandlers.get("session_start")!({}, resumedCtx);
  const response = (await resumedHandlers.get("context")!({ messages: [] }, resumedCtx)) as
    | { messages: Array<{ content: string }> }
    | undefined;
  const prompt = response?.messages[0]?.content ?? "";
  expect(prompt).toContain("agent-parked-a");
  expect(prompt).toContain("job-parked-a");
  expect(prompt).toContain("agent-parked-b");
  expect(prompt).toContain("job-parked-b");
  expect(prompt).toContain("empty live snapshot is not nothing-to-reconcile");
});


test("an unchanged open plan remains in context on each request and clears on completion", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let plan = phases;
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    getActiveTools: () => ["task"],
    pi: extensionSdk,
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/no-native-active-goal-fixture",
    sessionManager: {
      getHeader: () => ({ id: "root" }),
      getBranch: () => [
        {
          type: "message",
          message: { role: "toolResult", toolName: "todo", details: { phases: plan } },
        },
      ],
    },
    getAsyncJobSnapshot: () => emptyJobs,
  } as unknown as ExtensionContext;
  const request = async () =>
    (await handlers.get("context")!({ messages: [] }, ctx)) as
      | { messages: Array<{ content: string }> }
      | undefined;
  const first = await request();
  const second = await request();
  expect(first?.messages[0]?.content).toContain("Repair retrieval");
  expect(second?.messages[0]?.content).toContain("Repair retrieval");
  plan = phases.map((phase) => ({
    ...phase,
    tasks: phase.tasks.map((task) => ({ ...task, status: "completed" as const })),
  }));
  // The plan text clears; the main session keeps only its chief-of-staff role.
  const done = await request();
  expect(done?.messages[0]?.content).not.toContain("Repair retrieval");
  expect(done?.messages[0]?.content).toContain("ROLE: You are the chief of staff");
});

test("todo schedule result plan check uses the just-returned phases", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const stale: TodoScheduleInput = [{
    name: "Release",
    tasks: [{ content: "Commit focused Finance release repairs after polish", status: "pending" }],
  }];
  const scheduled: TodoScheduleInput = [{
    name: "Release",
    tasks: [{
      content: "Commit focused Finance release repairs after polish",
      status: "pending",
      schedule: {
        owner: "MergeCommitPushOwner-3",
        dependencies: [],
        estimate: {
          optimisticSeconds: 120,
          likelySeconds: 360,
          pessimisticSeconds: 1200,
          confidence: "medium",
          basis: "live git-pr-owner is already running",
          updatedAt: Date.now(),
        },
      },
    }],
  }];
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    getActiveTools: () => ["task"],
    pi: extensionSdk,
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/no-native-active-goal-fixture",
    sessionManager: {
      getHeader: () => ({ id: "root" }),
      getBranch: () => [{
        type: "message",
        message: { role: "toolResult", toolName: "todo", details: { phases: stale } },
      }],
    },
    getAsyncJobSnapshot: () => ({
      running: [{
        id: "MergeCommitPushOwner-3",
        type: "task" as const,
        status: "running" as const,
        label: "MergeCommitPushOwner-3",
        startTime: Date.now(),
      }],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
  } as unknown as ExtensionContext;
  const result = handlers.get("tool_result")!({
    toolName: "todo",
    toolCallId: "todo-schedule",
    isError: false,
    content: [{ type: "text", text: "schedule: 1 row(s) changed." }],
    details: { phases: scheduled },
  }, ctx) as { content: Array<{ text?: string }> };
  const text = result.content.map((part) => part.text ?? "").join("\n");
  expect(text).toContain("PLAN CHECK: no problems.");
  expect(text).not.toContain("missing estimates");
  expect(text).not.toContain("own no row");
  expect(text).not.toContain("have no worker");
});

test("PLAN CHECK advises executor planning only for three unseen rows and clears when a worker has finished one", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let plan: TodoScheduleInput = [{
    name: "Planning",
    tasks: ["Alpha preview", "Beta preview"].map((content) => ({
      content,
      status: "pending" as const,
      schedule: {
        dependencies: [],
        estimate: {
          optimisticSeconds: 60,
          likelySeconds: 120,
          pessimisticSeconds: 180,
          confidence: "medium" as const,
          basis: "planning fixture",
          updatedAt: now,
        },
      },
    })),
  }];
  let jobs: Jobs = emptyJobs;
  const branch: unknown[] = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } }];
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    getActiveTools: () => ["task"],
    appendEntry: (customType: string, data?: unknown) => branch.push({ type: "custom", customType, data }),
    pi: extensionSdk,
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/planning-round-fixture",
    sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
    getAsyncJobSnapshot: () => jobs,
    getTaskMaxConcurrency: () => 6,
  } as unknown as ExtensionContext;
  const check = (phases: TodoScheduleInput) => {
    const result = handlers.get("tool_result")!({
      toolName: "todo",
      toolCallId: "todo-plan",
      isError: false,
      content: [{ type: "text", text: "schedule: changed" }],
      details: { phases },
    }, ctx) as { content: Array<{ text?: string }> };
    return result.content.map((part) => part.text ?? "").join("\n");
  };

  expect(check(plan)).not.toContain("planning round due");
  plan = [{
    ...plan[0]!,
    tasks: [
      ...plan[0]!.tasks,
      {
        ...plan[0]!.tasks[0]!,
        content: "Gamma preview",
      },
    ],
  }];
  branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
  const dueCheck = check(plan);
  expect(dueCheck).toContain('planning round due: 3 rows no executor has looked at: "Alpha preview", "Beta preview", "Gamma preview" (skill://chief-of-staff Planning)');
  expect(check(plan)).not.toContain("planning round due");

  jobs = {
    running: [],
    recent: [{ id: "worker-alpha", type: "task", status: "completed", label: "Finished Alpha preview with receipt", startTime: now }],
    nonJobAgents: [],
  };
  expect(check(plan)).not.toContain("planning round due");
});

test("PLAN CHECK advises retrospectives for sprint triggers and clears after retro-facilitator finishes", async () => {
  const liveNow = Date.UTC(2026, 8, 25, 10, 0, 0);
  setSystemTime(new Date(liveNow));
  const row = (content: string, status: "pending" | "completed" = "pending") => ({
    content,
    status,
    schedule: {
      dependencies: [],
      estimate: {
        optimisticSeconds: 60,
        likelySeconds: 120,
        pessimisticSeconds: 180,
        confidence: "medium" as const,
        basis: "retro fixture",
        updatedAt: liveNow,
      },
    },
  });
  let plan: TodoScheduleInput = [{ name: "Retro", tasks: [row("Ship result")] }];
  let deadlineAt = liveNow + 60_000;
  const jobs: Jobs = {
    running: [],
    recent: [
      { id: "worker-a-1", type: "task", status: "completed", label: "Ship result", startTime: liveNow - 3_000, agentId: "worker-a" },
      { id: "worker-b-1", type: "task", status: "completed", label: "Review result", startTime: liveNow - 2_000, agentId: "worker-b" },
      { id: "worker-a-2", type: "task", status: "completed", label: "Polish result", startTime: liveNow - 1_000, agentId: "worker-a" },
    ],
    nonJobAgents: [],
  };
  const branch: unknown[] = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } }];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  await todoDispatch({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    getActiveTools: () => ["task"],
    appendEntry: (customType: string, data?: unknown) => branch.push({ type: "custom", customType, data }),
    pi: { ...extensionSdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt }) },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: "/tmp/retro-fixture",
    sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
    getAsyncJobSnapshot: () => jobs,
    getTaskMaxConcurrency: () => 6,
  } as unknown as ExtensionContext;
  const check = (phases: TodoScheduleInput = plan) => {
    const result = handlers.get("tool_result")!({
      toolName: "todo",
      toolCallId: "todo-retro",
      isError: false,
      content: [{ type: "text", text: "schedule: changed" }],
      details: { phases },
    }, ctx) as { content: Array<{ text?: string }> };
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  const finishRetro = () => {
    handlers.get("tool_result")!({
      toolName: "task",
      toolCallId: "retro-task",
      isError: false,
      details: { results: [{ agent: "retro-facilitator", exitCode: 0, durationMs: 1000 }] },
    }, ctx);
  };
  try {
    expect(check()).not.toContain("retrospective due");

    deadlineAt = liveNow - 1;
    const overdue = check();
    expect(overdue).toContain("retrospective due (deadline passed): ask the 2 workers who finished since");
    expect(overdue).toContain("worker-a, worker-b");
    expect(overdue).toContain("through agent://, then retro-facilitator (skill://chief-of-staff Retrospective)");
    finishRetro();
    expect(check()).not.toContain("retrospective due");

    handlers.get("input")!({ source: "user", content: "опять не то, я же просил иначе" }, ctx);
    expect(check()).toContain("retrospective due (user correction)");
    finishRetro();

    plan = [{ name: "Retro", tasks: [row("Closed one", "completed"), row("Closed two", "completed"), row("Closed three", "completed")] }];
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    expect(check()).toContain("retrospective due (goal delivered)");
    finishRetro();
    plan = [{ name: "Retro", tasks: [row("Closed one"), row("Closed two"), row("Closed three")] }];
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    expect(check()).toContain("retrospective due (3 reopened rows)");
    finishRetro();

    plan = [{ name: "Retro", tasks: [row("Final close", "completed")] }];
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    expect(check()).toContain("retrospective due (goal delivered)");
    finishRetro();

    plan = [{ name: "Retro", tasks: [row("Long work")] }];
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    check();
    setSystemTime(new Date(liveNow + 3 * 60 * 60_000 + 1));
    expect(check()).toContain("retrospective due (3h goal work)");
  } finally {
    setSystemTime();
  }
});


test("idle lifecycle wakes once per active plan/alarm and suppresses paused or child sessions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "todo-dispatch-supervisor-"));
  const goalPool = join(cwd, ".pi", ".goals-pool-snapshot.json");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const liveNow = Date.now();
  const deadlineSeconds = Math.floor((liveNow + 60 * 60_000) / 1000);
  writeFileSync(
    goalPool,
    JSON.stringify({ goals: [{ id: "goal-1", status: "active", createdAt: liveNow }] }),
  );
  const plan: TodoScheduleInput = [
    {
      name: "Fixes",
      tasks: [
        {
          content: "Recover isolated task",
          status: "pending",
          schedule: {
            dependencies: [],
            estimate: {
              optimisticSeconds: 30,
              likelySeconds: 60,
              pessimisticSeconds: 90,
              confidence: "high",
              basis: "fixture",
              updatedAt: liveNow,
            },
          },
        },
      ],
    },
  ];
  const branch: unknown[] = [
    { type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "goal-1" } },
    {
      type: "custom",
      customType: "reemxy-goal-deadlines",
      data: {
        version: 1,
        goalId: "goal-1",
        goalStartedAt: Math.floor(liveNow / 1000),
        timezone: "UTC",
        active: true,
        baselineDeadlineAt: deadlineSeconds,
        stages: [
          {
            id: "stage-1",
            label: "Finish task",
            expectedResult: "verified artifact",
            deadlineAt: deadlineSeconds,
          },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "todo", details: { phases: plan } },
    },
  ];
  let header: { id: string; parentSession?: string } = { id: "root" };
  let idle = true;
  let pending = false;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const sent: unknown[][] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler),
    getActiveTools: () => ["task"],
    pi: extensionSdk,
    appendEntry: () => undefined,
    sendMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => header, getBranch: () => branch },
    getAsyncJobSnapshot: () => emptyJobs,
    getTaskMaxConcurrency: () => 2,
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    setTimeout: (callback: (...args: unknown[]) => void, delay = 0) => {
      const timer = { callback: () => callback(), delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      const timer = handle as (typeof timers)[number];
      timer.cancelled = true;
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  } as unknown as ExtensionContext;
  const fireNext = () => timers.shift()?.callback();
  const agentEnd = () => handlers.get("agent_end")!({}, ctx);
  const wasPaused = agentPauseGate.paused;
  if (wasPaused) agentPauseGate.resume();
  let pausedHere = false;
  try {
    agentEnd();
    expect(timers[0]?.delay).toBe(0);
    expect(agentPauseGate.pause()).toBe(true);
    pausedHere = true;
    fireNext();
    expect(sent).toHaveLength(0);
    agentPauseGate.resume();
    pausedHere = false;
    agentEnd();
    expect(timers[0]?.delay).toBe(0);
    fireNext();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toMatchObject({
      customType: "agent-focus-gym-eval-sandbox-wake",
      display: false,
    });
    expect(sent[0]?.[1]).toMatchObject({ deliverAs: "aside" });
    handlers.get("agent_start")!({}, ctx);
    agentEnd();
    expect(timers[0]?.delay).toBe(30_000);
    fireNext();
    expect(sent).toHaveLength(1);

    pending = true;
    agentEnd();
    expect(timers).toHaveLength(0);
    pending = false;
    idle = false;
    agentEnd();
    expect(timers).toHaveLength(0);
    idle = true;

    branch.push({
      type: "mode_change",
      mode: "goal_paused",
      data: { goal: { id: "goal-1", status: "paused", createdAt: liveNow } },
    });
    agentEnd();
    expect(timers).toHaveLength(0);

    branch.pop();

    branch.push({
      type: "mode_change",
      mode: "goal",
      data: { goal: { id: "goal-1", status: "complete", createdAt: liveNow } },
    });
    agentEnd();
    expect(timers).toHaveLength(0);

    branch.pop();
    branch.push({ type: "mode_change", mode: "none" });
    agentEnd();
    expect(timers).toHaveLength(0);

    branch.pop();
    header = { id: "child", parentSession: "root" };
    agentEnd();
    expect(timers).toHaveLength(0);
    expect(sent).toHaveLength(1);
    header = { id: "root" };
    setSystemTime(new Date(liveNow + 120_000));
    agentEnd();
    expect(timers[0]?.delay).toBe(0);
    fireNext();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.[1]).toMatchObject({ deliverAs: "aside" });
    agentEnd();
    expect(timers[0]?.delay).toBeGreaterThan(0);
    setSystemTime(new Date(liveNow + 180_000));
    agentEnd();
    expect(timers[0]?.delay).toBe(0);
    fireNext();
    expect(sent).toHaveLength(3);
    expect(sent[2]?.[1]).toMatchObject({ deliverAs: "aside" });
  } finally {
    setSystemTime();
    if (pausedHere) agentPauseGate.resume();
    if (wasPaused && !agentPauseGate.paused) agentPauseGate.pause();
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("overdue follow-through re-arms by minute and dispatches only actionable, reconciled Task work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "todo-dispatch-overdue-live-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const liveNow = now + 120_000;
  const deadlineAt = liveNow - 60_000;
  const makeTask = (content: string, dependencies: string[] = [], resources: string[] = []) => ({
    content,
    status: "pending" as const,
    schedule: {
      dependencies,
      resources,
      estimate: {
        optimisticSeconds: 30,
        likelySeconds: 60,
        pessimisticSeconds: 90,
        confidence: "high" as const,
        basis: "overdue liveness fixture",
        updatedAt: now - 60_000,
      },
    },
  });
  let plan: TodoScheduleInput = [
    { name: "Overdue fixes", tasks: [makeTask("Repair export", [], ["export.ts"]), makeTask("Repair retrieval", [], ["retrieval.ts"])] },
  ];
  const revisionPlan = scheduledPlan("Revision with executable work");
  const overdueDeadline = { ...due, deadlineAt: now - 60_000 };
  const firstRevision = decide({ phases: revisionPlan, deadline: overdueDeadline, capacity: 2, now: now + 120_000 });
  expect(firstRevision.dispatchableReady?.map((row) => row.content)).toEqual(["Revision with executable work"]);
  revisionPlan[0]!.tasks[0]!.schedule!.estimateRevision = 2;
  const revisedActionable = decide({
    phases: revisionPlan,
    deadline: overdueDeadline,
    capacity: 2,
    now: now + 120_000,
    lastWakeKey: firstRevision.rawWakeKey,
  });
  expect(revisedActionable.wakeKey).not.toBeNull();
  expect(revisedActionable.dispatchableReady?.map((row) => row.content)).toEqual(["Revision with executable work"]);
  const branch: unknown[] = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } },
  ];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let activeTools = ["task"];
  let capacity: number | undefined = 2;
  let jobs: Jobs = emptyJobs;
  let pending = false;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const sent: unknown[][] = [];
  let requirementProvider: ((ctx: ExtensionContext) => unknown) | undefined;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => activeTools,
    pi: {
      ...extensionSdk,
      readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt }),
    },
    registerSoftToolRequirementProvider: (provider: ((ctx: ExtensionContext) => unknown) & { demand?: (ctx: ExtensionContext) => unknown }) => { requirementProvider = provider.demand ?? provider; },
    appendEntry: () => undefined,
    sendMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  const wasPaused = agentPauseGate.paused;
  if (wasPaused) agentPauseGate.resume();
  try {
    await todoDispatch(api);
    const ctx = {
      cwd,
      sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
      getAsyncJobSnapshot: () => jobs,
      getTaskMaxConcurrency: () => capacity,
      isIdle: () => true,
      hasPendingMessages: () => pending,
      setTimeout: (callback: (...args: unknown[]) => void, delay = 0) => {
        const timer = { callback: () => callback(), delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle: unknown) => {
        const index = timers.indexOf(handle as (typeof timers)[number]);
        if (index >= 0) timers.splice(index, 1);
      },
    } as unknown as ExtensionContext;
    const fireNext = () => timers.shift()?.callback();
    const requirement = () => requirementProvider?.(ctx) as { toolName?: string } | undefined;
    setSystemTime(new Date(liveNow));

    handlers.get("agent_end")!({}, ctx);
    expect(timers[0]?.delay).toBe(0);
    fireNext();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toMatchObject({ customType: "agent-focus-gym-eval-sandbox-wake" });
    expect(requirement()?.toolName).toBe("task");

    // Waiting with nothing launched cannot deliver anything: refuse it and name the ready rows.
    const refused = handlers.get("tool_call")!({ toolName: "wait", toolCallId: "call-wait" }, ctx) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain("Stop waiting");
    expect(refused?.reason).toContain("Repair export");
    expect(refused?.reason).toContain("past the deadline");
    // One order at a time: ready rows mean the task tool next, not a replan in the same breath.
    expect(refused?.reason).toContain("skill://chief-of-staff");
    expect(refused?.reason).not.toContain("todo tool");

    // A real Task result must reconcile to an exact live owner before another batch is offered.
    const firstJob = { id: "task-export", type: "task" as const, status: "running" as const, label: "export worker", startTime: liveNow, agentId: "worker-export" };
    handlers.get("tool_call")!({ toolName: "task", toolCallId: "call-export" }, ctx);
    jobs = { running: [firstJob], recent: [], nonJobAgents: [{ id: "worker-export", live: true }] };
    handlers.get("tool_result")!({ toolName: "task", toolCallId: "call-export", isError: false }, ctx);
    plan = [{ ...plan[0]!, tasks: [{ ...plan[0]!.tasks[0]!, schedule: { ...plan[0]!.tasks[0]!.schedule!, owner: "worker-export" } }, plan[0]!.tasks[1]!] }];
    // Late plan, one worker, another independent row idle: waiting is refused until the plan fans out.
    const late = handlers.get("tool_call")!({ toolName: "wait", toolCallId: "call-wait-2" }, ctx) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(late?.block).toBe(true);
    expect(late?.reason).toContain("Repair retrieval");
    expect(late?.reason).toContain("skill://chief-of-staff");
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    handlers.get("agent_end")!({}, ctx);
    expect(requirement()?.toolName).toBe("task");

    // The unowned second row remains actionable, so a new minute/revision may re-arm follow-through.
    setSystemTime(new Date(liveNow + 60_000));
    handlers.get("agent_end")!({}, ctx);
    expect(timers[0]?.delay).toBe(0);
    fireNext();
    expect(sent).toHaveLength(2);

    const secondJob = { id: "task-retrieval", type: "task" as const, status: "running" as const, label: "retrieval worker", startTime: liveNow, agentId: "worker-retrieval" };
    handlers.get("tool_call")!({ toolName: "task", toolCallId: "call-retrieval" }, ctx);
    jobs = { running: [firstJob, secondJob], recent: [], nonJobAgents: [{ id: "worker-export", live: true }, { id: "worker-retrieval", live: true }] };
    handlers.get("tool_result")!({ toolName: "task", toolCallId: "call-retrieval", isError: false }, ctx);
    plan = [{ ...plan[0]!, tasks: plan[0]!.tasks.map((task, index) => ({ ...task, schedule: { ...task.schedule!, owner: index === 0 ? "worker-export" : "worker-retrieval" } })) }];
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    handlers.get("agent_end")!({}, ctx);
    expect(requirement()).toBeUndefined();
    expect(timers[0]?.delay).toBeGreaterThan(0);
    // Every open row staffed: waiting for the workers is legitimate.
    expect(handlers.get("tool_call")!({ toolName: "wait", toolCallId: "call-wait-staffed" }, ctx)).toBeUndefined();

    // Once both rows have exact live owners, recurring overdue minutes do not create a paid loop.
    setSystemTime(new Date(liveNow + 120_000));
    fireNext();
    expect(sent).toHaveLength(2);

    // Fail closed under live user intent, pause, unavailable tool/capacity, dependency wait,
    // and resource contention; none can manufacture another Task requirement.
    pending = true;
    handlers.get("agent_end")!({}, ctx);
    expect(timers).toHaveLength(0);
    pending = false;
    expect(agentPauseGate.pause()).toBe(true);
    handlers.get("agent_end")!({}, ctx);
    expect(timers).toHaveLength(0);
    agentPauseGate.resume();
    activeTools = [];
    expect(requirement()).toBeUndefined();
    activeTools = ["task"];
    capacity = undefined;
    expect(requirement()).toBeUndefined();
    capacity = 2;
    plan = [{ name: "Blocked", tasks: [makeTask("Needs predecessor", ["Missing predecessor"], ["blocked.ts"])] }];
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    expect(requirement()).toBeUndefined();
    plan = [{ name: "Approval gated", tasks: [{ ...makeTask("Await human approval"), status: "blocked" as const, blocker: "human approval required" }] }];
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    expect(requirement()).toBeUndefined();
    const resourceOwner = { id: "resource-owner", type: "task" as const, status: "running" as const, label: "resource owner", startTime: liveNow, agentId: "resource-owner" };
    jobs = { running: [resourceOwner], recent: [], nonJobAgents: [{ id: "resource-owner", live: true }] };
    plan = [{ name: "Resource wait", tasks: [
      { ...makeTask("Hold shared resource", [], ["shared.ts"]), status: "in_progress" as const, schedule: { ...makeTask("Hold shared resource", [], ["shared.ts"]).schedule!, owner: "resource-owner" } },
      makeTask("Wait for shared resource", [], ["shared.ts"]),
    ] }];
    const contention = decide({
      phases: plan,
      jobs,
      deadline: { goalId: "goal-1", deadlineAt },
      capacity,
      now: liveNow,
    });
    expect(resourceOwner.startTime).toBe(liveNow);
    expect(plan[0]!.tasks[0]!.schedule?.startedAt).toBeUndefined();
    expect(
      contention.forecast?.rows.find((row) => row.content === "Wait for shared resource")?.resourceStart,
    ).toBeLessThanOrEqual(liveNow);
    expect(contention.dispatchableReady?.map((row) => row.content)).toEqual([]);
    expect(requirement()).toBeUndefined();
  } finally {
    setSystemTime();
    if (!wasPaused && agentPauseGate.paused) agentPauseGate.resume();
    handlers.get("session_shutdown")?.({}, { getAsyncJobSnapshot: () => emptyJobs } as unknown as ExtensionContext);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a plan that leaves worker slots empty while rows idle is sent back to replanning, at most three times per revision", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "todo-dispatch-late-chain-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const liveNow = now + 120_000;
  const row = (content: string, dependencies: string[], owner?: string) => ({
    content,
    status: owner ? ("in_progress" as const) : ("pending" as const),
    schedule: {
      dependencies,
      resources: [],
      ...(owner ? { owner } : {}),
      estimate: {
        optimisticSeconds: 300,
        likelySeconds: 600,
        pessimisticSeconds: 900,
        confidence: "medium" as const,
        basis: "late chain fixture",
        updatedAt: now - 60_000,
      },
    },
  });
  const plan: TodoScheduleInput = [{ name: "Release", tasks: [
    row("Merge main into PR branch", [], "worker-merge"),
    row("Replay checkpoint", ["Merge main into PR branch"]),
    row("Pin capture bundle", ["Replay checkpoint"]),
    row("Publish PR checkpoint", ["Pin capture bundle"]),
    row("Record PR receipt", ["Publish PR checkpoint"]),
    row("Announce PR checkpoint", ["Record PR receipt"]),
  ] }];
  const branch: unknown[] = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } },
  ];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let requirementProvider: ((ctx: ExtensionContext) => unknown) | undefined;
  let deadlineAt = liveNow - 60_000;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo"],
    pi: { ...extensionSdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt }) },
    registerSoftToolRequirementProvider: (provider: ((ctx: ExtensionContext) => unknown) & { demand?: (ctx: ExtensionContext) => unknown }) => { requirementProvider = provider.demand ?? provider; },
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const worker = { id: "task-merge", type: "task" as const, status: "running" as const, label: "merge", startTime: liveNow, agentId: "worker-merge" };
  let taskCap = 16;
  const jobs: Jobs = { running: [worker], recent: [], nonJobAgents: [{ id: "worker-merge", live: true }] };
  try {
    await todoDispatch(api);
    const ctx = {
      cwd,
      sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
      getAsyncJobSnapshot: () => jobs,
      getTaskMaxConcurrency: () => taskCap,
      isIdle: () => false,
      hasPendingMessages: () => false,
      setTimeout: () => ({}),
      clearTimer: () => undefined,
    } as unknown as ExtensionContext;
    setSystemTime(new Date(liveNow));
    // Right after a restart, before any wait: the first model choice must be a todo rewrite.
    const wasPaused = agentPauseGate.paused;
    if (wasPaused) agentPauseGate.resume();
    const demand = requirementProvider?.(ctx) as { toolName?: string; id?: string; reminder?: Array<{ content: string }> } | undefined;
    expect(demand?.toolName).toBe("todo");
    expect(demand?.reminder?.[0]?.content).toContain("MANDATORY REPLAN");
    expect(demand?.reminder?.[0]?.content).toContain("5 open row(s) sit idle");
    // Until todo is called the same demand stays in force.
    expect((requirementProvider?.(ctx) as { id?: string }).id).toBe(demand?.id);
    // A todo call that changes nothing structural is not a replan: demanded again, and told so.
    handlers.get("tool_call")!({ toolName: "todo", toolCallId: "t" }, ctx);
    const again = requirementProvider?.(ctx) as { id?: string; reminder?: Array<{ content: string }> } | undefined;
    expect(again?.id).not.toBe(demand?.id);
    expect(again?.reminder?.[0]?.content).toContain("that is not a replan");
    // Decomposing a row answers the demand; a still-chained plan is asked once more without the rebuke.
    plan[0]!.tasks.push(row("Pin capture bundle: hash inputs", ["Replay checkpoint"]));
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    handlers.get("tool_call")!({ toolName: "todo", toolCallId: "t2" }, ctx);
    const third = requirementProvider?.(ctx) as { reminder?: Array<{ content: string }> } | undefined;
    expect(third?.reminder?.[0]?.content).toContain("MANDATORY REPLAN");
    expect(third?.reminder?.[0]?.content).not.toContain("that is not a replan");
    // At most five forced todo turns per episode.
    for (let i = 0; i < 2; i += 1) {
      handlers.get("tool_call")!({ toolName: "todo", toolCallId: `t${i + 3}` }, ctx);
      expect(requirementProvider?.(ctx)).toBeDefined();
    }
    handlers.get("tool_call")!({ toolName: "todo", toolCallId: "t9" }, ctx);
    // Five rewrites did not unchain it: the plan-doctor is demanded once, then the gate stops.
    const doctor = requirementProvider?.(ctx) as { toolName?: string; reminder?: Array<{ content: string }>; satisfies?: (call: unknown) => boolean } | undefined;
    expect(doctor?.toolName).toBe("task");
    expect(doctor?.reminder?.[0]?.content).toContain('agent "plan-doctor"');
    expect(doctor?.satisfies?.({ name: "task", arguments: { tasks: [{ agent: "plan-doctor" }] } })).toBe(true);
    expect(doctor?.satisfies?.({ name: "task", arguments: { tasks: [{ agent: "coder" }] } })).toBe(false);
    expect(requirementProvider?.(ctx)).toBeUndefined();
    plan[0]!.tasks.pop();
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    const wait = () => handlers.get("tool_call")!({ toolName: "wait", toolCallId: "w" }, ctx) as { block?: boolean; reason?: string } | undefined;
    const first = wait();
    expect(first?.block).toBe(true);
    // Nothing ready: the todo tool, named as a tool, with the ops to use; a backlog file does not count.
    expect(first?.reason).toContain("skill://chief-of-staff");
    expect(first?.reason).toContain("skill://chief-of-staff");
    expect(first?.reason).toContain("5 open row(s) sit idle");
    expect(wait()?.block).toBe(true);
    expect(wait()?.block).toBe(true);
    // Unchanged plan after three refusals: stop refusing rather than loop.
    expect(wait()).toBeUndefined();
    expect(first?.reason).toContain("past the deadline");
    // On time is no excuse: a new plan revision that still chains the backlog is refused again.
    deadlineAt = liveNow + 30 * 24 * 3_600_000;
    plan[0]!.tasks.push(row("Run visual sweep", ["Publish PR checkpoint"]));
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    const onTime = wait();
    expect(onTime?.block).toBe(true);
    expect(onTime?.reason).toContain("6 open row(s) sit idle");
    expect(onTime?.reason).not.toContain("deadline");
    // Negative control: once every worker slot the machine allows is busy, the rest may wait.
    taskCap = 2;
    jobs.running.push({ ...worker, id: "task-sweep", agentId: "worker-sweep" });
    plan[0]!.tasks.push(row("Archive capture", ["Run visual sweep"]));
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    expect(wait()).toBeUndefined();
    expect(requirementProvider?.(ctx)).toBeUndefined();
    // Live shape after the 2026-09-24 restart: no worker runs, one row is ready and the rest chain
    // behind it. Staffing the ready row comes first (a todo demand forces todo and cuts off task:
    // live 2026-09-25 21:52); the replan follows once it runs.
    taskCap = 16;
    jobs.running.length = 0;
    jobs.nonJobAgents = [];
    plan[0]!.tasks[0] = row("Merge main into PR branch", []);
    branch[0] = { type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } };
    const chained = requirementProvider?.(ctx) as { toolName?: string; reminder?: Array<{ content: string }> } | undefined;
    expect(chained?.toolName).toBe("task");
    expect(chained?.reminder?.[0]?.content).toContain("Merge main into PR branch");
  } finally {
    setSystemTime();
    handlers.get("session_shutdown")?.({}, { getAsyncJobSnapshot: () => emptyJobs } as unknown as ExtensionContext);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the main session is chief of staff: worker tools are refused while worker slots sit empty", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "todo-dispatch-chief-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const liveNow = now + 120_000;
  const row = (content: string, dependencies: string[], owner?: string) => ({
    content,
    status: owner ? ("in_progress" as const) : ("pending" as const),
    schedule: {
      dependencies,
      resources: [],
      ...(owner ? { owner } : {}),
      estimate: { optimisticSeconds: 300, likelySeconds: 600, pessimisticSeconds: 900, confidence: "medium" as const, basis: "chief fixture", updatedAt: now - 60_000 },
    },
  });
  const plan: TodoScheduleInput = [{ name: "Release", tasks: [
    row("Merge main", [], "worker-merge"),
    row("Replay", ["Merge main"]),
    row("Pin bundle", ["Replay"]),
    row("Publish", ["Pin bundle"]),
  ] }];
  const branch: unknown[] = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } }];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let taskCap = 16;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo"],
    pi: { ...extensionSdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const worker = { id: "task-merge", type: "task" as const, status: "running" as const, label: "merge", startTime: liveNow, agentId: "worker-merge" };
  const jobs: Jobs = { running: [worker], recent: [], nonJobAgents: [{ id: "worker-merge", live: true }] };
  let header: { id: string; parentSession?: string } = { id: "root" };
  try {
    await todoDispatch(api);
    const ctx = {
      cwd,
      sessionManager: { getHeader: () => header, getBranch: () => branch },
      getAsyncJobSnapshot: () => jobs,
      getTaskMaxConcurrency: () => taskCap,
      isIdle: () => false,
      hasPendingMessages: () => false,
      setTimeout: () => ({}),
      clearTimer: () => undefined,
    } as unknown as ExtensionContext;
    setSystemTime(new Date(liveNow));
    if (agentPauseGate.paused) agentPauseGate.resume();
    const call = (toolName: string, input: unknown) =>
      handlers.get("tool_call")!({ toolName, toolCallId: toolName, input }, ctx) as { block?: boolean; reason?: string } | undefined;
    // The role reaches every request, including autonomous continuations with no user prompt.
    const roleOf = () => {
      const out = handlers.get("context")!({ type: "context", messages: [] }, ctx) as { messages?: Array<{ content: string }> } | undefined;
      return out?.messages?.at(-1)?.content ?? "";
    };
    expect(roleOf()).toContain("ROLE: You are the chief of staff");
    expect(roleOf()).toContain("ROLE: You are the chief of staff");
    expect(roleOf()).toContain("skill://chief-of-staff");
    const refused = call("bash", { command: "bun test" });
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain("1 of 16 possible workers");
    expect(call("bash", { command: "git status --short" })).toBeUndefined();
    expect(call("read", { path: "src/a.ts" })).toBeUndefined();
    expect(call("write", { path: "agent://worker-merge", content: "go on" })).toBeUndefined();
    const codeEdit = call("edit", { path: "src/a.ts" });
    expect(codeEdit?.block).toBe(true);
    expect(codeEdit?.reason).not.toContain("scribe");
    expect(call("eval", {})?.block).toBe(true);
    // A backlog document edit is pointed at the scribe worker.
    call("task", {});
    const docEdit = call("edit", { path: "docs/backlog.md" });
    expect(docEdit?.block).toBe(true);
    expect(docEdit?.reason).toContain("skill://chief-of-staff");
    call("bash", { command: "bun test" });
    call("bash", { command: "bun test" });
    // It insisted three times: the fourth goes through; a task call re-arms the gate.
    expect(call("bash", { command: "bun test" })).toBeUndefined();
    call("task", {});
    expect(call("bash", { command: "bun test" })?.block).toBe(true);
    // Every slot busy: the main session may do the work itself.
    taskCap = 1;
    expect(call("bash", { command: "bun test" })).toBeUndefined();
    // Subagents are workers, not chiefs.
    taskCap = 16;
    header = { id: "child", parentSession: "root" };
    expect(call("bash", { command: "bun test" })).toBeUndefined();
    expect(roleOf()).not.toContain("chief of staff");
  } finally {
    setSystemTime();
    handlers.get("session_shutdown")?.({}, { getAsyncJobSnapshot: () => emptyJobs } as unknown as ExtensionContext);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a worker started but never linked to a row does not silence dispatch for the rest of a goal run", async () => {
  // Live 2026-09-24 23:26: dispatchable 3, running 1, parked 20, and no task requirement at all,
  // because the gate waited for agent_end (a goal run rarely ends) while an unlinked worker ran.
  const cwd = mkdtempSync(join(tmpdir(), "todo-dispatch-unlinked-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const liveNow = now + 120_000;
  const row = (content: string) => ({
    content,
    status: "pending" as const,
    schedule: {
      dependencies: [],
      resources: [content],
      estimate: { optimisticSeconds: 300, likelySeconds: 600, pessimisticSeconds: 900, confidence: "medium" as const, basis: "unlinked fixture", updatedAt: now - 60_000 },
    },
  });
  const plan: TodoScheduleInput = [{ name: "Release", tasks: [row("Write parser"), row("Fix flaky test"), row("Update docs")] }];
  const branch: unknown[] = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } }];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let requirementProvider: ((ctx: ExtensionContext) => unknown) | undefined;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo"],
    pi: { ...extensionSdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow - 60_000 }) },
    registerSoftToolRequirementProvider: (provider: ((ctx: ExtensionContext) => unknown) & { demand?: (ctx: ExtensionContext) => unknown }) => { requirementProvider = provider.demand ?? provider; },
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  let jobs: Jobs = { running: [], recent: [], nonJobAgents: [] };
  let queued = false;
  try {
    await todoDispatch(api);
    const ctx = {
      cwd,
      sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => branch },
      getAsyncJobSnapshot: () => jobs,
      getTaskMaxConcurrency: () => 16,
      isIdle: () => false,
      hasPendingMessages: () => queued,
      setTimeout: () => ({}),
      clearTimer: () => undefined,
    } as unknown as ExtensionContext;
    setSystemTime(new Date(liveNow));
    if (agentPauseGate.paused) agentPauseGate.resume();
    const provide = () => requirementProvider?.(ctx) as { toolName?: string; reminder?: Array<{ content: string }> } | undefined;
    // Queued worker results and IRC notices do not switch the gate off; a message the user typed does, once.
    queued = true;
    expect(provide()?.toolName).toBe("task");
    handlers.get("input")!({ type: "input", text: "look at the chart", source: "interactive" }, ctx);
    expect(provide()).toBeUndefined();
    expect(provide()?.toolName).toBe("task");
    queued = false;
    // The model starts one worker and never writes its ID into the plan; no agent_end follows.
    handlers.get("tool_call")!({ toolName: "task", toolCallId: "call-capture" }, ctx);
    jobs = { running: [{ id: "task-capture", type: "task", status: "running", label: "capture", startTime: liveNow, agentId: "ProvisionalRecoveryOwner" }], recent: [], nonJobAgents: [{ id: "ProvisionalRecoveryOwner", live: true }] };
    handlers.get("tool_result")!({ toolName: "task", toolCallId: "call-capture", isError: false }, ctx);
    // One request of grace to link it, then the gate asks for the link instead of going quiet.
    expect(provide()).toBeUndefined();
    const link = provide();
    expect(link?.toolName).toBe("todo");
    expect(link?.reminder?.[0]?.content).toContain("ProvisionalRecoveryOwner");
    // The model answers with todo but still does not link: the other ready rows are dispatched anyway.
    handlers.get("tool_call")!({ toolName: "todo", toolCallId: "call-todo" }, ctx);
    expect(provide()?.toolName).toBe("task");
  } finally {
    setSystemTime();
    handlers.get("session_shutdown")?.({}, { getAsyncJobSnapshot: () => emptyJobs } as unknown as ExtensionContext);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a resolved merge left open is committed first, and a merge gets one worker, not one per file", async () => {
  // Live 2026-09-24: a resolved merge sat uncommitted for two hours behind feature rows while per-file
  // conflict workers, an integrator, an audit and an oracle ran; nothing was pushed for a day.
  const { execFileSync } = await import("node:child_process");
  const { utimesSync } = await import("node:fs");
  const cwd = mkdtempSync(join(tmpdir(), "todo-dispatch-merge-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git("add", "a.txt"); git("commit", "-qm", "base");
  git("checkout", "-qb", "side"); writeFileSync(join(cwd, "a.txt"), "side\n"); git("commit", "-qam", "side");
  git("checkout", "-q", "main"); writeFileSync(join(cwd, "a.txt"), "main\n"); git("commit", "-qam", "main");
  try { git("merge", "side"); } catch {}
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let requirementProvider: ((ctx: ExtensionContext) => unknown) | undefined;
  let jobs: Jobs = emptyJobs;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo"],
    pi: extensionSdk,
    registerSoftToolRequirementProvider: (provider: ((ctx: ExtensionContext) => unknown) & { demand?: (ctx: ExtensionContext) => unknown }) => { requirementProvider = provider.demand ?? provider; },
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  if (agentPauseGate.paused) agentPauseGate.resume();
  try {
    await todoDispatch(api);
    const ctx = {
      cwd,
      sessionManager: { getHeader: () => ({ id: "root" }), getBranch: () => [], getSessionFile: () => undefined },
      getAsyncJobSnapshot: () => jobs,
      getTaskMaxConcurrency: () => 20,
      isIdle: () => true,
      hasPendingMessages: () => false,
      setTimeout: () => ({}),
      clearTimer: () => undefined,
    } as unknown as ExtensionContext;
    const call = (toolName: string, input: unknown) =>
      handlers.get("tool_call")!({ toolName, toolCallId: toolName, input }, ctx) as { block?: boolean; reason?: string } | undefined;
    const context = () => (handlers.get("context")!({ type: "context", messages: [] }, ctx) as { messages: Array<{ content: string }> }).messages.at(-1)!.content;
    // Conflicts open: one worker for the whole merge; a per-file batch and a second merge worker are refused.
    expect(context()).toContain("1 unresolved path(s)");
    const batch = call("task", { tasks: [{ name: "ResolvePathA", task: "resolve merge conflict in a.txt" }, { name: "ResolvePathB", task: "resolve merge conflict in b.txt" }] });
    expect(batch?.block).toBe(true);
    expect(batch?.reason).toContain("one merge gets one worker");
    expect(call("task", { tasks: [{ name: "ResolveAllPaths", task: "resolve every merge conflict" }] })).toBeUndefined();
    jobs = { running: [{ id: "ResolveAllPaths", type: "task", status: "running", label: "resolve every merge conflict", startTime: Date.now() } as never], recent: [], nonJobAgents: [] };
    expect(call("task", { tasks: [{ name: "AuditResolvedHead", task: "audit the merge" }] })?.reason).toContain("already has its worker");
    expect(call("task", { tasks: [{ name: "Docs", task: "update the changelog" }] })).toBeUndefined();
    // Resolved and older than the threshold: the next call must be git commit; more merge work is refused.
    jobs = emptyJobs;
    writeFileSync(join(cwd, "a.txt"), "both\n"); git("add", "a.txt");
    const old = (Date.now() - 45 * 60_000) / 1000;
    utimesSync(join(cwd, ".git", "MERGE_HEAD"), old, old);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const realNow = Date.now;
    Date.now = () => realNow() + 20_000; // past the git-state cache
    try {
      const requirement = requirementProvider!(ctx) as { toolName: string; reminder: Array<{ content: string }>; satisfies: (call: unknown) => boolean };
      expect(requirement.toolName).toBe("task");
      expect(requirement.reminder[0]!.content).toContain("skill://chief-of-staff");
      expect(requirement.satisfies({ name: "bash", arguments: { command: "git commit --no-edit" } })).toBe(true);
      expect(requirement.satisfies({ name: "bash", arguments: { command: "git add ." } })).toBe(false);
      expect(requirement.satisfies({ name: "task", arguments: { tasks: [{ task: "Commit the merge and push the branch" }] } })).toBe(true);
      expect(call("task", { tasks: [{ name: "CommitResolvedHead", task: "Commit the merge and push the branch" }] })).toBeUndefined();
      expect(context()).toContain("one git-pr-owner worker");
      expect(call("task", { tasks: [{ name: "VerifyResolvedHead", task: "verify the merge" }] })?.reason).toContain("skill://chief-of-staff");
      expect(call("todo", { op: "append", items: [{ content: "Review merge index" }] })?.block).toBe(true);
      expect(call("todo", { op: "done", task: "Resolve merge" })).toBeUndefined();
      git("commit", "-q", "--no-edit");
      Date.now = () => realNow() + 40_000;
      expect(requirementProvider!(ctx)).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  } finally {
    handlers.get("session_shutdown")?.({}, { getAsyncJobSnapshot: () => emptyJobs } as unknown as ExtensionContext);
    rmSync(cwd, { recursive: true, force: true });
  }
});
