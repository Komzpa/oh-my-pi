// @ts-nocheck -- combinatorial no-deadlock proof for todo_dispatch gates: drives the real
// extension through the hook harness (same shape as todo_dispatch.gates.test.ts) across the full
// 2^9 cross product of refusal-trigger setups, plus the real decideGateCall union and the real
// todo.override path (both committed in 71e6512ce2 on this branch, cherry-picked from
// SkillRulesAsGates-2 3f021de843). No model: every refusal below comes from the live tool_call
// hook, every remedy is re-invoked against it, every state mutation is re-probed through it.
// Finish-delay is advisory since 85ef65c11b, so it is outside the refusal matrix.
//
// The nine bits and their real setups (bit i of the mask arms trigger i):
//  0 planning-admission -- omp-side admission flag closed (the extension never sees estimates;
//    omp refuses every non-read tool except todo/ask/hub/think/yield/grep/glob/find).
//  1 chief-worker-work  -- 5 open rows, <=3 running: understaffed, so `bash bun test` is refused.
//    OFF (coupled to nothing): 64 filler running jobs push runningTasks past capacity.
//  2 planning-failure-name -- call-level: offending probe names the worker "FixAuth" ("Fix" is a
//    banned segment); remedy renames to "AuthOptionPicker".
//  3 git-owner-checkout -- running git-pr-owner LandDocs owns ctx.cwd; a second git-pr-owner
//    task for the same checkout is refused. Remedy: a different worktree, or (loop) LandDocs
//    completes and the same-checkout call is re-probed admitted.
//  4 git-owner-batch -- call-level: one task call with two git-pr-owner items for one checkout.
//    Remedy: two single-item calls. (With bit 3 armed the batch probe first hits the checkout
//    refusal; the loop clears checkout before verifying the split, which is the real order.)
//  5 idle-wait -- ready rows with no distinct running worker: `wait` is refused. OFF: every row
//    is staffed (owned + running), which also staffs chief off -- the only coupled pair; every
//    mask still drives a real state and the receipt reports measured refusal sets.
//  6 settled-worker-write -- completed worker-old owned Row A, live owner is running worker-new:
//    `write agent://worker-old` is rerouted. Remedy: write agent://worker-new.
//  7 resolved-merge-work -- resolvedStale repo (MERGE_HEAD aged 45min, nothing unmerged): merge
//    work without "commit" is refused. OFF: clean repo. Remedy: a commit task (admitted).
//  8 merge-fanout -- running MergeResolver owns the merge: a second merge worker is refused.
//    Remedy: MergeResolver completes, the single merge call is re-probed admitted.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { readGoalDeadline } from "./deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
  formatPlanForecast,
  formatTaskForecast,
  forecastTodoPlan,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch, { decideGateCall, parseTodoOverride } from "./todo_dispatch";

const sdk = { forecastTodoPlan, formatPlanForecast, formatTaskForecast, readGoalDeadline, getLatestTodoPhasesFromEntries, agentPauseGate };
// omp session-tools.ts PLANNING_CONTROL_TOOLS plus the read tier (mirrors gates.test.ts).
const ADMISSION_ALWAYS = new Set(["todo", "ask", "hub", "think", "yield", "read", "grep", "glob", "find"]);

const N = 9;
const BIT = {
  admission: 0,
  chief: 1,
  badName: 2,
  checkout: 3,
  batch: 4,
  idle: 5,
  settled: 6,
  merge: 7,
  fanout: 8,
};

// ---------------------------------------------------------------- fixtures ---
function makeRepo(kind) {
  const cwd = mkdtempSync(join(tmpdir(), `liveness-${kind}-`));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git("add", "a.txt");
  git("commit", "-qm", "base");
  if (kind === "clean") return cwd;
  git("checkout", "-qb", "side");
  writeFileSync(join(cwd, "a.txt"), "side\n");
  git("commit", "-qam", "side");
  git("checkout", "-q", "main");
  writeFileSync(join(cwd, "a.txt"), "main\n");
  git("commit", "-qam", "main");
  try { git("merge", "side"); } catch {}
  writeFileSync(join(cwd, "a.txt"), "both\n");
  git("add", "a.txt");
  const old = (Date.now() - 45 * 60_000) / 1000;
  utimesSync(join(cwd, ".git", "MERGE_HEAD"), old, old);
  return cwd;
}

const estimate = (now) => ({ optimisticSeconds: 300, likelySeconds: 600, pessimisticSeconds: 900, confidence: "medium", basis: "liveness fixture", updatedAt: now - 60_000 });

const NAMES = ["Row A", "Row B", "Row C", "Row D", "Row E"];
function buildBranch(now, staffed) {
  const tasks = NAMES.map((content, i) => {
    const owner = i === 0 ? "worker-new" : staffed ? `staff-${content.slice(-1)}` : undefined;
    return {
      content,
      status: owner ? "in_progress" : "pending",
      schedule: { dependencies: [], resources: [content], ...(owner ? { owner } : {}), estimate: estimate(now) },
    };
  });
  return [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } } }];
}

function buildJobs(now, mask, staffed) {
  const running = [
    { id: "worker-new", agentId: "worker-new", type: "task", status: "running", label: "Row A", startTime: now },
  ];
  if (mask & (1 << BIT.checkout))
    running.push({ id: "LandDocs", agentId: "LandDocs", agent: "git-pr-owner", type: "task", status: "running", label: "Land docs", startTime: now });
  if (mask & (1 << BIT.fanout))
    running.push({ id: "MergeResolver", agentId: "MergeResolver", type: "task", status: "running", label: "resolve the merge conflicts", startTime: now });
  if (staffed)
    for (const content of NAMES.slice(1))
      running.push({ id: `staff-${content.slice(-1)}`, agentId: `staff-${content.slice(-1)}`, type: "task", status: "running", label: content, startTime: now });
  if (!(mask & (1 << BIT.chief)))
    for (let i = 0; i < 64; i += 1)
      running.push({ id: `Filler${i}`, agentId: `Filler${i}`, type: "task", status: "running", label: `Filler ${i}`, startTime: now });
  const recent = mask & (1 << BIT.settled)
    ? [{ id: "worker-old", agentId: "worker-old", type: "task", status: "completed", label: "Row A", startTime: now - 60_000 }]
    : [];
  return { running, recent, nonJobAgents: [] };
}

// ------------------------------------------------------- per-mask driver ---
async function driveMask(mask, repos) {
  const now = Date.now();
  const idleOff = !(mask & (1 << BIT.idle));
  const branch = buildBranch(now, idleOff);
  const jobs = buildJobs(now, mask, idleOff);
  const cwd = mask & (1 << BIT.merge) ? repos.resolvedStale : repos.clean;
  const st = { admissionOpen: !(mask & (1 << BIT.admission)), branch, jobs, cwd };
  const handlers = new Map();
  const api = {
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait", "write"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  };
  await todoDispatch(api);
  const ctx = {
    cwd: st.cwd,
    sessionManager: { getHeader: () => ({ id: `liveness-${mask}` }), getBranch: () => st.branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => st.jobs,
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  };
  // cwd is fixed per mask; ctx.cwd stays in sync through st.
  Object.defineProperty(ctx, "cwd", { get: () => st.cwd, configurable: true });
  let seq = 0;
  const rawCall = async (name, input) =>
    await handlers.get("tool_call")({ toolName: name, toolCallId: `c${mask}-${seq += 1}`, input }, ctx);
  const call = async (name, input = {}) => {
    const out = await rawCall(name, input);
    const refusedByHook = out?.block === true;
    const refusedByAdmission = !st.admissionOpen && !ADMISSION_ALWAYS.has(name);
    return { admitted: !refusedByHook && !refusedByAdmission, reason: out?.reason, hookBlocked: refusedByHook, admissionBlocked: refusedByAdmission };
  };
  const shutdown = () => handlers.get("session_shutdown")?.({}, ctx);
  return { st, ctx, call, shutdown, now };
}

const TODO_FIX = { op: "schedule", updates: [{ task: "Row B", dependencies: [] }] };

// ------------------------------------------------------- the matrix ---
const seenActive = new Set();
const seenInactive = new Set();
const deadlockFindings = [];
let measuredSignatures = new Set();

async function runMask(mask, repos, otherRepo) {
  const d = await driveMask(mask, repos);
  const label = `mask=${mask.toString(2).padStart(N, "0")}`;
  const activeNow = [];
  try {
    // (a) todo and read are always admitted, in every real state.
    const todo = await d.call("todo", TODO_FIX);
    expect(todo.admitted, `${label}: todo admitted`).toBe(true);
    const read = await d.call("read", { path: "README.md" });
    expect(read.admitted, `${label}: read admitted`).toBe(true);

    let steps = 0;
    // Staffing a row the way dispatch does: the row names its owner and the worker runs.
    // Owned-and-running rows leave dispatchableReady, so this really clears chief/idle gates.
    const staff = (contents) => {
      const tasks = d.st.branch[0].message.details.phases[0].tasks;
      for (const content of contents) {
        const t = tasks.find((t) => t.content === content);
        const id = `staff-${content.slice(-1)}`;
        if (t && !t.schedule.owner) { t.schedule.owner = id; t.status = "in_progress"; }
        if (!d.st.jobs.running.some((j) => (j.agentId ?? j.id) === id))
          d.st.jobs = { ...d.st.jobs, running: [...d.st.jobs.running, { id, agentId: id, type: "task", status: "running", label: content, startTime: Date.now() }] };
      }
    };
    const note = (id, wasActive) => {
      (wasActive ? seenActive : seenInactive).add(id);
      if (wasActive) activeNow.push(id);
    };

    // 0. planning-admission: anything outside the always set is refused omp-side; the todo
    // call reopens it (models the estimate fix; omp re-admits after todo).
    {
      const probe = await d.call("bash", { command: "bun test" });
      const isActive = probe.admissionBlocked;
      note("planning-admission", isActive);
      if (isActive) {
        // The hook may also refuse the same probe (e.g. chief); admission is the omp-side
        // layer, and the todo call below must pass both.
        const fix = await d.call("todo", TODO_FIX);
        expect(fix.admitted, `${label}: todo reopens admission`).toBe(true);
        d.st.admissionOpen = true;
        steps += 1;
      } else {
        d.st.admissionOpen = false;
        const remedy = await d.call("todo", TODO_FIX);
        expect(remedy.admitted, `${label}: todo remedies admission`).toBe(true);
        d.st.admissionOpen = true;
        steps += 1;
      }
    }
    // 2. planning-failure-name (call-level: the bit arms the offending probe itself).
    if (!(mask & (1 << BIT.badName))) note("planning-failure-name", false);
    else {
      const probe = await d.call("task", { tasks: [{ name: "FixAuth", agent: "coder", task: "Do Row B" }] });
      const isActive = probe.hookBlocked && /planning-failure word/.test(probe.reason ?? "");
      note("planning-failure-name", isActive);
      if (isActive) {
        expect(probe.reason, `${label}: refusal names the rename remedy`).toContain("semantic noun");
        const remedy = await d.call("task", { tasks: [{ name: "AuthOptionPicker", agent: "coder", task: "Do Row B" }] });
        if (!remedy.admitted) deadlockFindings.push({ combination: `${label}+rename`, refusal: remedy.reason ?? "(admission)" });
        expect(remedy.admitted, `${label}: renamed worker admitted (got: ${remedy.reason})`).toBe(true);
        steps += 1;
      }
    }
    // 3. git-owner-checkout.
    {
      const probe = await d.call("task", { tasks: [{ name: "LandDocs", agent: "git-pr-owner", task: "Land the API docs" }] });
      const isActive = probe.hookBlocked && /already has live git-pr-owner/.test(probe.reason ?? "");
      note("git-owner-checkout", isActive);
      if (isActive) {
        expect(probe.reason, `${label}: refusal names the worktree remedy`).toContain("different worktree");
        const elsewhere = await d.call("task", { tasks: [{ name: "LandDocs", agent: "git-pr-owner", task: "Land the API docs", cwd: otherRepo }] });
        if (!elsewhere.admitted) deadlockFindings.push({ combination: `${label}+other-worktree`, refusal: elsewhere.reason ?? "(admission)" });
        expect(elsewhere.admitted, `${label}: different worktree admitted (got: ${elsewhere.reason})`).toBe(true);
        // Applying the wait half of the remedy for real: LandDocs settles, same checkout frees.
        const done = d.st.jobs.running.filter((j) => j.id !== "LandDocs");
        d.st.jobs = { ...d.st.jobs, running: done, recent: [...d.st.jobs.recent, { id: "LandDocs", agentId: "LandDocs", agent: "git-pr-owner", type: "task", status: "completed", label: "Land docs", startTime: d.now - 60_000 }] };
        const again = await d.call("task", { tasks: [{ name: "LandDocs", agent: "git-pr-owner", task: "Land the API docs" }] });
        expect(again.admitted, `${label}: settled checkout frees the same-checkout call (got: ${again.reason})`).toBe(true);
        steps += 1;
      }
    }
    // 4. git-owner-batch (call-level: the bit arms the offending probe itself).
    if (!(mask & (1 << BIT.batch))) note("git-owner-batch", false);
    else {
      const batch = (suffix) => ({ tasks: [{ name: `Land${suffix}A`, agent: "git-pr-owner", task: "Land the API docs" }, { name: `Land${suffix}B`, agent: "git-pr-owner", task: "Land the API docs" }] });
      const probe = await d.call("task", batch("X"));
      const isActive = probe.hookBlocked && /one checkout gets one git-pr-owner/.test(probe.reason ?? "");
      note("git-owner-batch", isActive);
      if (isActive) {
        for (const suffix of ["A", "B"]) {
          const single = await d.call("task", { tasks: [{ name: `LandSolo${suffix}`, agent: "git-pr-owner", task: "Land the API docs" }] });
          if (!single.admitted) deadlockFindings.push({ combination: `${label}+split-${suffix}`, refusal: single.reason ?? "(admission)" });
          expect(single.admitted, `${label}: split single owner admitted (got: ${single.reason})`).toBe(true);
        }
        steps += 1;
      }
    }
    // 6. settled-worker-write.
    {
      const probe = await d.call("write", { path: "agent://worker-old", content: "ping" });
      const isActive = probe.hookBlocked && /is settled/.test(probe.reason ?? "");
      note("settled-worker-write", isActive);
      if (isActive) {
        expect(probe.reason, `${label}: refusal names the live owner`).toContain("worker-new");
        const remedy = await d.call("write", { path: "agent://worker-new", content: "ping" });
        if (!remedy.admitted) deadlockFindings.push({ combination: `${label}+live-owner`, refusal: remedy.reason ?? "(admission)" });
        expect(remedy.admitted, `${label}: live owner write admitted (got: ${remedy.reason})`).toBe(true);
        steps += 1;
      }
    }
    // 1. chief-worker-work.
    {
      const probe = await d.call("bash", { command: "bun test" });
      const isActive = probe.hookBlocked && /chief of staff/.test(probe.reason ?? "");
      note("chief-worker-work", isActive);
      if (isActive) {
        expect(probe.reason, `${label}: refusal names dispatch`).toContain("Ready rows");
        staff(["Row B", "Row C", "Row D"]);
        const again = await d.call("bash", { command: "bun test" });
        expect(again.admitted, `${label}: staffing clears the chief refusal (got: ${again.reason})`).toBe(true);
        steps += 1;
      }
    }
    // 5. idle-wait.
    {
      const probe = await d.call("wait", {});
      const isActive = probe.hookBlocked && /Stop waiting/.test(probe.reason ?? "");
      note("idle-wait", isActive);
      if (isActive) {
        expect(probe.reason, `${label}: refusal names dispatch`).toContain("Ready rows");
        staff(NAMES.slice(1));
        const again = await d.call("wait", {});
        expect(again.admitted, `${label}: staffing every ready row clears idle-wait (got: ${again.reason})`).toBe(true);
        steps += 1;
      }
    }
    // 9. merge-fanout (before resolved-merge: the commit remedy needs the merger gone).
    {
      const probe = await d.call("task", { tasks: [{ name: "ResolvePaths", agent: "coder", task: "commit the resolved merge paths" }] });
      const isActive = probe.hookBlocked && /one merge gets one worker/.test(probe.reason ?? "");
      note("merge-fanout", isActive);
      if (isActive) {
        d.st.jobs = { ...d.st.jobs, running: d.st.jobs.running.filter((j) => j.id !== "MergeResolver") };
        const again = await d.call("task", { tasks: [{ name: "ResolvePaths", agent: "coder", task: "commit the resolved merge paths" }] });
        expect(again.admitted, `${label}: one merge worker admitted once the first settles (got: ${again.reason})`).toBe(true);
        steps += 1;
      }
    }
    // 8. resolved-merge-work.
    {
      const probe = await d.call("task", { tasks: [{ name: "ResolvePaths", agent: "coder", task: "resolve the merge conflicts" }] });
      const isActive = probe.hookBlocked && /needs a commit, not more merge work/.test(probe.reason ?? "");
      note("resolved-merge-work", isActive);
      if (isActive) {
        const remedy = await d.call("task", { tasks: [{ name: "CommitResolvedHead", agent: "coder", task: "commit the merge and push" }] });
        if (!remedy.admitted) deadlockFindings.push({ combination: `${label}+commit-merge`, refusal: remedy.reason ?? "(admission)" });
        expect(remedy.admitted, `${label}: commit task admitted (got: ${remedy.reason})`).toBe(true);
        steps += 1;
      }
    }

    measuredSignatures.add(activeNow.sort().join("+") || "empty");
  } finally {
    d.shutdown();
  }
}

// ------------------------------------------------------- union + override ---
async function armMissedEtaEscalation(repos) {
  // Stale estimates put every row past its finish for real, so three ignored PLAN CHECKs
  // escalate missed-eta through the live trackDemands path (a retro line dedupes after its
  // first notice and can only re-fire when new workers finish, so it cannot escalate alone).
  const now = Date.now();
  const stale = { optimisticSeconds: 60, likelySeconds: 300, pessimisticSeconds: 600, confidence: "medium", basis: "liveness fixture", updatedAt: now - 3_600_000 };
  const handlers = new Map();
  const api = {
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait", "write"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  };
  await todoDispatch(api);
  const tasks = NAMES.map((content) => ({ content, status: "in_progress", schedule: { dependencies: [], resources: [content], owner: `w-${content.slice(-1)}`, estimate: stale } }));
  const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } } }];
  const jobs = {
    running: NAMES.map((content) => ({ id: `w-${content.slice(-1)}`, agentId: `w-${content.slice(-1)}`, type: "task", status: "running", label: content, startTime: now - 3_600_000 })),
    recent: [],
    nonJobAgents: [],
  };
  const ctx = {
    cwd: repos.clean,
    sessionManager: { getHeader: () => ({ id: "liveness-union" }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => jobs,
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  };
  let seq = 0;
  const call = async (name, input = {}) => {
    const out = await handlers.get("tool_call")({ toolName: name, toolCallId: `u-${seq += 1}`, input }, ctx);
    return { admitted: !(out?.block === true), reason: out?.reason };
  };
  // Three ignored PLAN CHECKs escalate the overdue demand through the real hook path.
  for (let i = 0; i < 3; i += 1)
    await handlers.get("tool_result")({ toolName: "todo", toolCallId: `ur-${i}`, isError: false, content: [], details: undefined }, ctx);
  return { call, shutdown: () => handlers.get("session_shutdown")?.({}, ctx) };
}

// ------------------------------------------------------- tests ---
const startedAt = Date.now();
let repos = null;
let otherRepo = null;

async function withRepos(fn, lo, hi) {
  const wasPaused = agentPauseGate.paused;
  if (wasPaused) agentPauseGate.resume();
  try {
    for (let mask = lo; mask < hi; mask += 1) await fn(mask);
  } finally {
    if (wasPaused) agentPauseGate.pause();
  }
}

for (const [lo, hi] of [[0, 256], [256, 512]]) {
  test(`real gates, masks ${lo}-${hi - 1}: todo/read admitted, every refusal names an admitted remedy`, async () => {
    if (!repos) {
      repos = { clean: makeRepo("clean"), resolvedStale: makeRepo("resolvedStale") };
      otherRepo = makeRepo("clean");
    }
    await withRepos((mask) => runMask(mask, repos, otherRepo), lo, hi);
  }, 180_000);
}

test("matrix close-out: 512 real states driven, every trigger varied, no deadlock", async () => {
  expect(2 ** N).toBe(512);
  const all = ["planning-admission", "chief-worker-work", "planning-failure-name", "git-owner-checkout", "git-owner-batch", "idle-wait", "settled-worker-write", "resolved-merge-work", "merge-fanout"];
  for (const id of all) {
    expect(seenActive.has(id), `trigger measured active at least once: ${id}`).toBe(true);
    expect(seenInactive.has(id), `trigger measured inactive at least once: ${id}`).toBe(true);
  }
  expect(deadlockFindings, `deadlock findings: ${JSON.stringify(deadlockFindings, null, 2)}`).toEqual([]);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  console.log(`liveness: 512 states, ${measuredSignatures.size} distinct refusal sets, ${secs}s`);
  for (const cwd of [repos?.clean, repos?.resolvedStale, otherRepo]) if (cwd) rmSync(cwd, { recursive: true, force: true });
}, 180_000);

test("union decision (missed-eta escalation): refused state still admits the union of remedies", async () => {
  const u = await armMissedEtaEscalation(repos ??= { clean: makeRepo("clean"), resolvedStale: makeRepo("clean") });
  try {
    const bash = await u.call("bash", { command: "bun test" });
    expect(bash.admitted, "escalated missed-eta refuses the unrelated call").toBe(false);
    expect(bash.reason ?? "", "refusal names every remedy gate").toContain("missed-eta (remedy:");
    const verdict = decideGateCall({ name: "bash", arguments: { command: "bun test" } }, [
      { id: "missed-eta", remedy: "re-estimate with a todo call", satisfies: (c) => c.name === "todo" },
    ]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.remedyGateIds).toEqual(["missed-eta"]);
    // The union of remedies is admitted: todo, and the read tier.
    expect((await u.call("todo", TODO_FIX)).admitted, "todo remedy admitted").toBe(true);
    expect((await u.call("read", { path: "README.md" })).admitted, "read tier admitted").toBe(true);
  } finally {
    u.shutdown();
  }
}, 60_000);

test("override (missed-eta escalation): an explicit reasoned todo.override passes", async () => {
  const u = await armMissedEtaEscalation(repos ??= { clean: makeRepo("clean"), resolvedStale: makeRepo("clean") });
  try {
    const before = await u.call("bash", { command: "bun test" });
    expect(before.admitted, "escalation armed").toBe(false);
    expect(parseTodoOverride({ override: "missed-eta: chief accepts responsibility" })).toBe("missed-eta");
    const over = await u.call("todo", { op: "schedule", updates: [], override: "missed-eta: chief accepts responsibility" });
    expect(over.admitted, "override todo admitted").toBe(true);
    const after = await u.call("bash", { command: "bun test" });
    expect(after.admitted, `override suppresses the named gate (got: ${after.reason})`).toBe(true);
  } finally {
    u.shutdown();
  }
}, 60_000);

test("decideGateCall: allowed implies a satisfied remedy; refused names every gate", () => {
  const gates = [
    { id: "planning-issues", remedy: "fix estimates with todo", satisfies: (c) => c.name === "todo" },
    { id: "chief-no-bash", remedy: "dispatch a worker with task", satisfies: (c) => c.name === "task" },
    { id: "idle-wait", remedy: "dispatch a worker with task", satisfies: (c) => c.name === "task" },
  ];
  const calls = [
    { name: "read", arguments: {} },
    { name: "todo", arguments: { op: "schedule" } },
    { name: "task", arguments: { tasks: [] } },
    { name: "bash", arguments: { command: "bun test" } },
    { name: "wait", arguments: {} },
  ];
  for (let mask = 0; mask < 2 ** gates.length; mask += 1) {
    const subset = gates.filter((_, i) => mask & (1 << i));
    for (const c of calls) {
      const v = decideGateCall(c, subset);
      if (v.allowed) {
        if (subset.length > 0)
          expect(subset.some((g) => { try { return g.satisfies(c); } catch { return false; } }) || c.name === "todo" || c.name === "read" || c.name === "write",
            `allowed call has a satisfied remedy: gates=[${subset.map((g) => g.id)}] call=${c.name}`).toBe(true);
      } else {
        expect(v.remedyGateIds).toEqual(subset.map((g) => g.id));
        for (const g of subset) expect(v.reason ?? "").toContain(g.id);
      }
    }
  }
}, 60_000);
