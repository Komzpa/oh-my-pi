// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
// State-machine test for every gate a main omp session meets at once: this extension's soft
// requirement (skips any call that does not satisfy it), its tool_call refusals, and omp's planning
// admission (refuses every non-read tool except todo/ask/hub/think/yield while a todo row lacks an
// estimate). Live 2026-09-25 each rule passed its own tests while together they left the model no
// legal move: the gate demanded task, then git commit, and skipped the todo call that admission
// needed first. Every reachable state below must leave the demanded action executable.
import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { readGoalDeadline } from "./deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import {
  formatPlanForecast,
  formatTaskForecast,
  forecastTodoPlan,
  type TodoScheduleInput,
} from "./todo-schedule";
import todoDispatch from "./todo_dispatch";

type Jobs = Pick<AsyncJobSnapshot, "running" | "recent" | "nonJobAgents">;
type Call = { name: string; arguments: Record<string, unknown> };
type Demand = { toolName?: string; satisfies?: (call: Call) => boolean } | undefined;

const sdk = { forecastTodoPlan, formatPlanForecast, formatTaskForecast, readGoalDeadline, getLatestTodoPhasesFromEntries, agentPauseGate };
// omp session-tools.ts PLANNING_CONTROL_TOOLS plus the read tier.
const ADMISSION_ALWAYS = new Set(["todo", "ask", "hub", "think", "yield", "read", "grep", "glob", "find"]);

const CALLS: Record<string, Call> = {
  todoSchedule: { name: "todo", arguments: { op: "schedule", updates: [{ task: "Row B", dependencies: [] }] } },
  todoDone: { name: "todo", arguments: { op: "done", task: "Row A" } },
  taskRow: { name: "task", arguments: { tasks: ["B", "C", "D"].map((r) => ({ name: `DoRow${r}`, agent: "coder", task: `Do Row ${r}` })) } },
  taskResume: { name: "task", arguments: { tasks: [{ name: "worker-a", agent: "coder", task: "Row A" }] } },
  taskMerge: { name: "task", arguments: { tasks: [{ name: "ResolvePaths", agent: "coder", task: "resolve the merge conflicts" }] } },
  taskCommit: { name: "task", arguments: { tasks: [{ name: "CommitResolvedHead", agent: "git-pr-owner", task: "commit the merge and push" }] } },
  gitCommit: { name: "bash", arguments: { command: "git commit --no-edit" } },
  gitPush: { name: "bash", arguments: { command: "git push" } },
  bashTest: { name: "bash", arguments: { command: "bun test" } },
  gitStage: { name: "bash", arguments: { command: "git add -- src/a.css e2e/b.spec.ts && git diff --cached --stat" } },
  chainedTest: { name: "bash", arguments: { command: "cat README.md && bun test" } },
  catLook: { name: "bash", arguments: { command: "cat scripts/a.sh" } },
  checksum: { name: "bash", arguments: { command: "sha256sum scripts/a.sh /tmp/a.sh" } },
  read: { name: "read", arguments: { path: "README.md" } },
  wait: { name: "wait", arguments: {} },
  complain: { name: "write", arguments: { path: "xd://report_issue", content: "task: gate keeps refusing" } },
  messageWorker: { name: "write", arguments: { path: "agent://RowBOwner", content: "use the pinned head" } },
};
const PROGRESS = ["todoSchedule", "todoDone", "taskRow", "taskResume", "taskCommit", "gitCommit", "gitPush", "bashTest"];

const cwdSlug = (cwd: string) =>
  cwd.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "cwd";

function repo(kind: "clean" | "conflicted" | "resolvedStale"): string {
  const cwd = mkdtempSync(join(tmpdir(), `gates-${kind}-`));
  const git = (...args: string[]) =>
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
  if (kind === "resolvedStale") {
    writeFileSync(join(cwd, "a.txt"), "both\n");
    git("add", "a.txt");
    const old = (Date.now() - 45 * 60_000) / 1000;
    utimesSync(join(cwd, ".git", "MERGE_HEAD"), old, old);
  }
  return cwd;
}

function plan(shape: "none" | "ready" | "chained" | "bigChained", now: number): unknown[] {
  if (shape === "none") return [];
  const row = (content: string, dependencies: string[], owner?: string) => ({
    content,
    status: owner ? ("in_progress" as const) : ("pending" as const),
    schedule: {
      dependencies,
      resources: [content],
      ...(owner ? { owner } : {}),
      estimate: { optimisticSeconds: 300, likelySeconds: 600, pessimisticSeconds: 900, confidence: "medium" as const, basis: "gates fixture", updatedAt: now - 60_000 },
    },
  });
  if (shape === "bigChained") {
    const rows = [row("Row 0", [], "worker-a")];
    for (let i = 1; i < 30; i += 1) rows.push(row(`Row ${i}`, [`Row ${i - 1}`]));
    return [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks: rows }] } } }];
  }
  const tasks = shape === "ready"
    ? [row("Row A", [], "worker-a"), row("Row B", []), row("Row C", []), row("Row D", [])]
    : [row("Row A", [], "worker-a"), row("Row B", ["Row A"]), row("Row C", ["Row B"]), row("Row D", ["Row C"]), row("Row E", ["Row D"])];
  const phases: TodoScheduleInput = [{ name: "Work", tasks }];
  return [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases } } }];
}

interface State {
  plan: "none" | "ready" | "chained" | "bigChained";
  git: "clean" | "conflicted" | "resolvedStale";
  admissionOpen: boolean; // false: omp refuses non-read tools until todo fixes estimates
  running: 0 | 1;
}

// Fresh extension per (state, call) so hook side effects (refusal counters, demand bookkeeping) never leak.
async function outcome(state: State, cwd: string, call: Call | null, strictDemand = false, sessionId = "gates-root") {
  const now = Date.now();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let provider: ((ctx: ExtensionContext) => unknown) | undefined;
  let enforced: ((ctx: ExtensionContext) => unknown) | undefined;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    // omp gets the registered function (it must return nothing: demands are advice); the demand
    // itself is read through its `demand` property.
    registerSoftToolRequirementProvider: (p: ((ctx: ExtensionContext) => unknown) & { demand?: (ctx: ExtensionContext) => unknown }) => { enforced = p; provider = p.demand ?? p; },
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const jobs: Jobs = state.running
    ? { running: [{ id: "worker-a", type: "task", status: "running", label: "Row A", startTime: now, agentId: "worker-a" } as never], recent: [], nonJobAgents: [{ id: "worker-a", live: true }] }
    : { running: [], recent: [], nonJobAgents: [] };
  const branch = plan(state.plan, now);
  await todoDispatch(api);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: sessionId }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => jobs,
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    const demand = provider?.(ctx) as Demand;
    if (!call) {
      const handed = enforced?.(ctx);
      const note = handlers.get("context")!({ messages: [] }, ctx) as { messages?: Array<{ content: string }> } | undefined;
      return { demand, handed, note: note?.messages?.at(-1)?.content ?? "" };
    }
    const satisfies = strictDemand && demand?.toolName ? (c: Call) => c.name === demand.toolName : demand?.satisfies ?? ((c: Call) => c.name === demand?.toolName);
    // omp skips calls only for a demand handed to it; strictDemand simulates the old enforcement.
    const skipped = strictDemand && Boolean(demand?.toolName) && !satisfies(call);
    const refusedByHook = Boolean((handlers.get("tool_call")!({ toolName: call.name, toolCallId: "c", input: call.arguments }, ctx) as { block?: boolean } | undefined)?.block);
    const refusedByAdmission = !state.admissionOpen && !ADMISSION_ALWAYS.has(call.name);
    return { demand, satisfied: Boolean(demand?.toolName) && satisfies(call), executed: !skipped && !refusedByHook && !refusedByAdmission };
  } finally {
    handlers.get("session_shutdown")?.({}, { getAsyncJobSnapshot: () => jobs } as unknown as ExtensionContext);
  }
}

const STATES: State[] = [];
for (const p of ["none", "ready", "chained"] as const)
  for (const g of ["clean", "conflicted", "resolvedStale"] as const)
    for (const admissionOpen of [true, false])
      for (const running of [0, 1] as const) STATES.push({ plan: p, git: g, admissionOpen, running });

const demandsSeen = new Map<string, number>();
async function violations(strictDemand: boolean) {
  const repos = { clean: repo("clean"), conflicted: repo("conflicted"), resolvedStale: repo("resolvedStale") };
  const found: string[] = [];
  const wasPaused = agentPauseGate.paused;
  if (wasPaused) agentPauseGate.resume();
  try {
    for (const state of STATES) {
      const label = JSON.stringify(state);
      const results = new Map<string, { executed: boolean; satisfied: boolean; demand: Demand }>();
      for (const [name, call] of Object.entries(CALLS)) {
        const r = await outcome(state, repos[state.git], call, strictDemand);
        results.set(name, { executed: Boolean(r.executed), satisfied: Boolean(r.satisfied), demand: r.demand });
      }
      const demand = results.get("read")!.demand;
      demandsSeen.set(demand?.toolName ?? "none", (demandsSeen.get(demand?.toolName ?? "none") ?? 0) + 1);
      // The plain check: which calls this state bans, and whether the demanded one is among the allowed.
      const allowed = [...results].filter(([, r]) => r.executed).map(([name]) => name);
      const banned = [...results].filter(([, r]) => !r.executed).map(([name]) => name);
      if (demand?.toolName && !allowed.some((name) => CALLS[name]!.name === demand.toolName && results.get(name)!.satisfied) && state.admissionOpen)
        found.push(`${label}: demanded ${demand.toolName} is banned (banned: ${banned.join(", ")})`);
      // 1. Never stuck: some progress call runs.
      if (!PROGRESS.some((name) => results.get(name)!.executed)) found.push(`${label}: no progress call executes`);
      // 2. A demand can always be met by a call that actually runs.
      //    While admission waits for todo, invariant 3 covers progress: advice skips nothing.
      if (demand?.toolName && (state.admissionOpen || strictDemand) && ![...results.values()].some((r) => r.satisfied && r.executed))
        found.push(`${label}: demand for ${demand.toolName} cannot be met`);
      // 0. The chief of staff owns the plan: todo is never banned, in any state.
      for (const name of ["todoSchedule", "todoDone", "read"]) if (!results.get(name)!.executed) found.push(`${label}: ${name} banned`);
      // 0b. The model can always complain about the harness (omp auto-QA device); admission is omp's side.
      if (state.admissionOpen && !results.get("complain")!.executed) found.push(`${label}: complaint banned`);
      // 0c. Messaging a running worker (write agent://…) is the chief's job, never skipped by a demand.
      if (state.admissionOpen && !results.get("messageWorker")!.executed) found.push(`${label}: messageWorker banned`);
      // 0d. Git mutation is the git-pr-owner worker's: the chief staging files is worker work like bun test.
      if (results.get("gitStage")!.executed !== results.get("bashTest")!.executed) found.push(`${label}: chief git add treated unlike worker work`);
      // 0e. A read-only prefix does not smuggle worker work: a chain runs only where its worst part runs.
      if (results.get("chainedTest")!.executed !== results.get("bashTest")!.executed) found.push(`${label}: chained bun test treated unlike bun test`);
      // 0g. A checksum is a quick look like cat (autoqa #77: sha256sum of two scripts refused as lead work).
      if (results.get("checksum")!.executed !== results.get("catLook")!.executed) found.push(`${label}: checksum refused`);
      // 0f. A todo demand never skips a worker staffed onto planned rows.
      if (demand?.toolName === "todo" && (state.plan === "ready" || state.plan === "chained") && !results.get("taskRow")!.satisfied)
        found.push(`${label}: todo demand skips a task for planned rows`);
      // 3. Admission closed: todo, the only way to reopen it, always runs.
      if (!state.admissionOpen && !results.get("todoSchedule")!.executed) found.push(`${label}: todo schedule blocked while admission waits for it`);
      // 4. Admission open and a resolved merge: the commit itself runs.
      if (state.admissionOpen && state.git === "resolvedStale" && !results.get("taskCommit")!.executed)
        found.push(`${label}: git-pr-owner worker for the merge commit blocked`);
      // 5. Open merge: a second merge worker never runs while one is running is covered in the unit
      //    test; here only: a merge worker is never the only thing the model may do.
    }
  } finally {
    for (const cwd of Object.values(repos)) rmSync(cwd, { recursive: true, force: true });
  }
  return found;
}

test("every reachable gate state leaves the demanded action executable and never deadlocks", async () => {
  expect(await violations(false)).toEqual([]);
  // Not vacuous: the sweep reaches every kind of demand the gate can make.
  expect(demandsSeen.get("task") ?? 0).toBeGreaterThan(0);
  expect(demandsSeen.get("todo") ?? 0).toBeGreaterThan(0);
}, 60_000);

test("negative control: a demand that accepts only its own tool deadlocks against planning admission", async () => {
  const found = await violations(true);
  expect(found.some((line) => line.includes("todo schedule blocked while admission waits for it"))).toBe(true);
}, 60_000);

test("omp is never handed a demand to enforce: no call is skipped, the demand is advice in context", async () => {
  const cwd = repo("resolvedStale");
  try {
    for (const plan of ["ready", "chained", "bigChained"] as const) {
      const r = (await outcome({ plan, git: "clean", admissionOpen: true, running: 0 }, cwd, null)) as { demand?: Demand; handed?: unknown; note: string };
      expect(r.demand?.toolName).toBeTruthy();
      expect(r.handed).toBeUndefined();
      expect(r.note).toContain("NEXT STEP (advice; no call is skipped or refused for it)");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("kill switch stops demands and refusals but the model still sees its plan and role", async () => {
  const id = `gates-switch-${process.pid}`;
  const off = join(homedir(), ".local", "state", "omp-todo-dispatch", `${id}.off`);
  const cwd = repo("resolvedStale");
  const state: State = { plan: "ready", git: "resolvedStale", admissionOpen: true, running: 0 };
  try {
    expect((await outcome(state, cwd, null, false, id)).demand?.toolName).toBeTruthy(); // baseline: gate demands something
    mkdirSync(join(homedir(), ".local", "state", "omp-todo-dispatch"), { recursive: true });
    writeFileSync(off, "");
    const r = await outcome(state, cwd, null, false, id);
    expect(r.demand?.toolName).toBeUndefined();
    expect(r.note).toContain("chief of staff");
    expect((await outcome(state, cwd, CALLS.bashTest!, false, id)).executed).toBe(true);
  } finally {
    rmSync(off, { force: true });
    rmSync(join(homedir(), ".local", "state", "omp-todo-dispatch", `${id}.gate.jsonl`), { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("a replan over a plan already bigger than the worker slots prunes rows instead of appending more", async () => {
  const cwd = repo("clean");
  try {
    const big = (await outcome({ plan: "bigChained", git: "clean", admissionOpen: true, running: 1 }, cwd, null)) as { demand?: { toolName?: string; reminder?: Array<{ content: string }> } };
    const text = big.demand?.reminder?.[0]?.content ?? "";
    expect(big.demand?.toolName).toBe("todo");
    expect(text).toContain("more than the 20 worker slots");
    expect(text).toContain("skill://chief-of-staff");
    expect(text).not.toContain("chained behind");
    // Neighbour: a small chained plan is still told to split rows.
    const small = (await outcome({ plan: "chained", git: "clean", admissionOpen: true, running: 1 }, cwd, null)) as { demand?: { reminder?: Array<{ content: string }> } };
    expect(small.demand?.reminder?.[0]?.content ?? "").toContain("chained behind");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("the runbook every gate points to covers each situation the gates measure", async () => {
  const runbook = await Bun.file(join(import.meta.dir, "../../skills/chief-of-staff/SKILL.md")).text();
  for (const needle of ["isolated: true", "name: chief-of-staff", "whole-plan estimates", "git-pr-owner", "one worker for all conflicted files", "`drop`", "owner:", "Do not append rows", "plan-doctor", "`scribe`", "xd://report_issue", "does not change the plan"])
    expect(runbook).toContain(needle);
});

test("a dispatch demand is met only by a task call that staffs a planned row", async () => {
  const cwd = repo("clean");
  try {
    const state: State = { plan: "ready", git: "clean", admissionOpen: true, running: 1 };
    const { demand } = (await outcome(state, cwd, null)) as { demand?: { toolName?: string; satisfies?: (c: Call) => boolean } };
    expect(demand?.toolName).toBe("task");
    expect(demand?.satisfies?.(CALLS.taskRow!)).toBe(true);
    // A single planned row is staffing: a demand must never skip useful planned work.
    expect(demand?.satisfies?.({ name: "task", arguments: { tasks: [{ name: "CommitRowB", agent: "git-pr-owner", task: "Do Row B" }] } })).toBe(true);
    expect(demand?.satisfies?.({ name: "task", arguments: { tasks: [{ name: "PreviewOwner", agent: "task", task: "capture a provisional preview" }] } })).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("task calls refuse planning-failure worker names but allow verb-first neighbours", async () => {
  const cwd = repo("clean");
  const now = Date.now();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-name-refusal" }), getBranch: () => plan("ready", now), getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  const call = (name: string) => handlers.get("tool_call")!({
    toolName: "task",
    toolCallId: `name-${name}`,
    input: { tasks: [{ name, agent: "coder", task: "Row B" }] },
  }, ctx) as { block?: boolean; reason?: string } | undefined;
  try {
    const blocked: Record<string, string> = {
      BuildOwner: "Owner",
      BuildIntegrator: "Integrator",
      BuildCoordinator: "Coordinator",
      RepairExport: "Repair",
      RecoveryExport: "Recovery",
      RestoreExport: "Restore",
      FixExport: "Fix",
      FixupExport: "Fixup",
      BuildV2: "V2",
      BuildV12: "V12",
      CancelExport: "Cancel",
      CheckOracle: "Oracle",
      FixtureArtifact1: "Fixture",
      MergedShardOne: "Shard",
      ResolveConflict: "Conflict",
      MergeBranches: "Merge",
      OmpX: "Omp",
      PushFinalBranch: "Final",
      RecordFinalVideo: "Final",
    };
    for (const [name, word] of Object.entries(blocked)) {
      const refusal = call(name);
      expect(refusal?.block, name).toBe(true);
      expect(refusal?.reason, name).toContain(word);
      expect(refusal?.reason, name).toContain("skill step 8");
    }
    for (const name of ["CommitFinanceCues", "FitMinimapHeading", "ScanAllDrives", "CompactionTrace", "PromptRoutingAudit", "Worker-2", "OwnershipTrace", "Prefix", "Compile", "Remerge", "FinalizeNothing"]) {
      expect(call(name)?.block, name).not.toBe(true);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("task calls allow re-staffing a legacy row whose owner already has the blocked name", async () => {
  const cwd = repo("clean");
  const now = Date.now();
  const branch = plan("ready", now) as Array<{ message: { details: { phases: TodoScheduleInput } } }>;
  branch[0]!.message.details.phases[0]!.tasks[1]!.schedule!.owner = "LegacyRepairOwner";
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-name-legacy" }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    const result = handlers.get("tool_call")!({
      toolName: "task",
      toolCallId: "legacy-owner",
      input: { tasks: [{ name: "LegacyRepairOwner", agent: "coder", task: "Row B" }] },
    }, ctx) as { block?: boolean } | undefined;
    expect(result?.block).not.toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("every todo result in the main session ends with the plan's problems", async () => {
  const cwd = repo("clean");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const now = Date.now();
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("ready", now);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-check" }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({ running: [{ id: "stray", type: "task", status: "running", label: "x", startTime: now } as never], recent: [], nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    const out = handlers.get("tool_result")!({ toolName: "todo", toolCallId: "t", input: {}, content: [{ type: "text", text: "done" }], isError: false }, ctx) as { content: Array<{ text: string }> };
    const text = out.content.at(-1)!.text;
    expect(text).toContain("PLAN CHECK");
    expect(text).toContain("own no row: stray");
    // Row A names worker-a, which runs nowhere: it is named for an exact resume.
    expect(text).toContain("owner that is not running");
    expect(text).toContain("(owner worker-a)");
    expect(text).toContain("have no worker");
    expect(text).toContain("skill://chief-of-staff");
    // The check reads the plan this very todo call produced, not the branch before it.
    const linked = plan("ready", now) as Array<{ message: { details: { phases: Array<{ tasks: Array<{ schedule: { owner?: string } }> }> } } }>;
    linked[0]!.message.details.phases[0]!.tasks[1]!.schedule.owner = "stray";
    const after = handlers.get("tool_result")!({ toolName: "todo", toolCallId: "t2", input: {}, content: [], details: linked[0]!.message.details, isError: false }, ctx) as { content: Array<{ text: string }> };
    expect(after.content.at(-1)!.text).not.toContain("own no row");
    // Rows omp cannot forecast (the header's "unresolved") are named with the reason; forecastable ones are not.
    expect(after.content.at(-1)!.text).not.toContain("no forecast");
    const unestimated = plan("ready", now) as Array<{ message: { details: { phases: Array<{ tasks: Array<{ schedule: { estimate?: unknown } }> }> } } }>;
    delete unestimated[0]!.message.details.phases[0]!.tasks[3]!.schedule.estimate;
    const gap = handlers.get("tool_result")!({ toolName: "todo", toolCallId: "t3", input: {}, content: [], details: unestimated[0]!.message.details, isError: false }, ctx) as { content: Array<{ text: string }> };
    expect(gap.content.at(-1)!.text).toContain("1 row(s) have no forecast");
    expect(gap.content.at(-1)!.text).toContain("\"Row D\" (Estimate is unknown");
    // Row A's owner worker-a runs nowhere and never reported: it is not an unread result.
    expect(gap.content.at(-1)!.text).not.toContain("came back and their rows are still open");
    // Once worker-a has completed, its open row is an unread result that comes first.
    const settledCtx = { ...ctx, getAsyncJobSnapshot: () => ({ running: [], recent: [{ id: "worker-a", agentId: "worker-a", type: "task", status: "completed", label: "Row A", startTime: now } as never], nonJobAgents: [] }) } as unknown as ExtensionContext;
    const settledOut = handlers.get("tool_result")!({ toolName: "todo", toolCallId: "t5", input: {}, content: [], isError: false }, settledCtx) as { content: Array<{ text: string }> };
    expect(settledOut.content.at(-1)!.text).toContain('1 worker result(s) came back and their rows are still open: "Row A"');
    // Negative control: a call that leaves the finish where it was says nothing about it.
    expect(gap.content.at(-1)!.text).not.toContain("moved the finish");
    // A call that makes the chain longer is told so, with the size of the delay.
    const longer = plan("ready", now) as Array<{ message: { details: { phases: Array<{ tasks: Array<{ schedule: { estimate?: { optimisticSeconds: number; likelySeconds: number; pessimisticSeconds: number } } }> }> } } }>;
    for (const task of longer[0]!.message.details.phases[0]!.tasks) task.schedule.estimate = { ...task.schedule.estimate!, optimisticSeconds: 3600, likelySeconds: 5400, pessimisticSeconds: 7200 };
    const later = handlers.get("tool_result")!({ toolName: "todo", toolCallId: "t4", input: {}, content: [], details: longer[0]!.message.details, isError: false }, ctx) as { content: Array<{ text: string }> };
    expect(later.content.at(-1)!.text).toMatch(/this change moved the finish \d+ min later/);
    // The notice is not advisory-only: the next task/wait call is refused, while todo and reads
    // stay executable so the chief can undo it or justify the user-requested added work.
    for (let i = 0; i < 3; i += 1) {
      const refused = handlers.get("tool_call")!({ toolName: "task", toolCallId: `late-task-${i}`, input: CALLS.taskRow!.arguments }, ctx) as { block?: boolean; reason?: string };
      expect(refused?.block).toBe(true);
      expect(refused?.reason).toContain("this change moved the finish");
      expect(refused?.reason).toContain("undo it, or say in your next todo call which user request the added work serves (evidence field)");
    }
    // At most three refusals for this plan revision.
    expect(handlers.get("tool_call")!({ toolName: "task", toolCallId: "late-task-4", input: CALLS.taskRow!.arguments }, ctx)).toBeUndefined();
    // Negative controls: reads and todo are not banned by the finish regression gate.
    expect(handlers.get("tool_call")!({ toolName: "read", toolCallId: "late-read", input: CALLS.read!.arguments }, ctx)).toBeUndefined();
    expect(handlers.get("tool_call")!({ toolName: "todo", toolCallId: "late-todo", input: { op: "drop", task: "tidy row" } }, ctx)).toBeUndefined();
    // A todo call with a structural evidence field clears the refusal.
    expect(handlers.get("tool_call")!({ toolName: "todo", toolCallId: "late-evidence", input: { op: "append", task: "extra work", evidence: "user asked for this added row" } }, ctx)).toBeUndefined();
    expect(handlers.get("tool_call")!({ toolName: "task", toolCallId: "late-task-cleared", input: CALLS.taskRow!.arguments }, ctx)).toBeUndefined();
    // Neighbour: the task result handler still ignores todo-unrelated tools.
    expect(handlers.get("tool_result")!({ toolName: "read", toolCallId: "r", input: {}, content: [], isError: false }, ctx)).toBeUndefined();
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("main-session plan snapshots feed plan-doctor from dispatcher-owned state files", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-plan-snapshot-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  writeFileSync(join(sessions, "main", "worker-done.jsonl"), "{}\n");
  const now = Date.now();
  const sessionId = `gates-snapshot-${process.pid}`;
  const snapshotDir = join(homedir(), ".local", "state", "omp-todo-dispatch", "plan");
  const byCwd = join(snapshotDir, `${cwdSlug(cwd)}.md`);
  const bySession = join(snapshotDir, `${sessionId}.md`);
  rmSync(byCwd, { force: true });
  rmSync(bySession, { force: true });
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("chained", now);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: sessionId }), getBranch: () => branch, getSessionFile: () => sessionFile },
    getAsyncJobSnapshot: () => ({
      running: [{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A", startTime: now } as never],
      recent: [{ id: "worker-done", agentId: "worker-done", type: "task", status: "completed", label: "Cut 2", startTime: now - 60_000 } as never],
      nonJobAgents: [{ id: "worker-a", live: true }],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    handlers.get("context")!({ messages: [] }, ctx);
    const fromCwd = readFileSync(byCwd, "utf8");
    const fromSession = readFileSync(bySession, "utf8");
    expect(fromCwd).toBe(fromSession);
    expect(fromCwd).toContain(`# OMP Plan Snapshot`);
    expect(fromCwd).toContain(`Snapshot paths: ${byCwd} and ${bySession}`);
    expect(fromCwd).toContain("CWD slug rule: absolute cwd, replace every non [A-Za-z0-9._-] with -, collapse repeated -, trim leading/trailing -, take first 120 chars, fallback cwd");
    expect(fromCwd).toContain("Goal: goal-1");
    expect(fromCwd).toContain("Recent ETA samples");
    expect(fromCwd).toContain("| Row A | in_progress | 300/600/900s | [] | worker-a | yes |");
    expect(fromCwd).toContain("| Row B | pending | 300/600/900s | Row A |  | no |");
    expect(fromCwd).toContain("consumes output from");
    expect(fromCwd).toContain("worker-done | completed |");
    expect(fromCwd).toContain(join(sessions, "main", "worker-done.jsonl"));
    // The task-call hook refreshes the same file immediately before spawning plan-doctor.
    rmSync(byCwd, { force: true });
    handlers.get("tool_call")!({ toolName: "task", toolCallId: "doctor", input: { tasks: [{ agent: "plan-doctor", task: "repair the plan" }] } }, ctx);
    expect(readFileSync(byCwd, "utf8")).toContain("Read by plan-doctor first");
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(byCwd, { force: true });
    rmSync(bySession, { force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("a plan with problems is reported once per problem list, and again after ten minutes", async () => {
  const cwd = repo("clean");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const now = Date.now();
  const sent: Array<{ content: string; deliverAs?: string }> = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }, options?: { deliverAs?: string }) => { sent.push({ content: message.content, deliverAs: options?.deliverAs }); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  let branch = plan("ready", now);
  let idle = false;
  let running: unknown[] = [];
  let tick: (() => void) | undefined;
  let interval = 0;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-ticker" }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({ running, recent: [], nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    setInterval: (callback: () => void, ms: number) => { tick = callback; interval = ms; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    handlers.get("session_start")!({}, ctx);
    expect(interval).toBe(60_000);
    tick!();
    tick!();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.deliverAs).toBe("aside");
    expect(sent[0]!.content).toContain("have no worker");
    idle = true;
    tick!();
    expect(sent).toHaveLength(1);
    // A changed problem list is news and goes out once.
    branch = plan("chained", now);
    running = [{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A" }];
    tick!();
    tick!();
    expect(sent).toHaveLength(2);
    // Nothing ready and slots free: the check names the unchaining step, not only pruning.
    expect(sent[1]!.content).toContain("no row is ready");
    expect(sent[1]!.content).toContain("skill step 7");
    // Waiting critical rows come one per line with what each waits on, and each needs its own answer.
    expect(sent[1]!.content).toContain('Waiting rows on the chain that sets the ETA, in order:\n- "Row B" (waits on "Row A")\n- "Row C" (waits on "Row B")');
    expect(sent[1]!.content).toContain("a row with no such part gets one line saying why");
    expect(sent[1]!.content).toContain("not only the next one");
    // Every link is questioned: a shared checkout or browser is a resource to copy, not a dependency.
    expect(sent[1]!.content).toContain("that thing is the contended resource: give each row its own copy");
    // Negative control: a chain of real dependencies gets no resource-queue paragraph.
    expect(sent[1]!.content).not.toContain("A resource queue on this chain");
    expect(sent[1]!.content).toContain('- "Row D" (waits on "Row C")\n- "Row E" (waits on "Row D")');
    // The running critical row is being worked on and is not in the split list.
    expect(sent[1]!.content).not.toContain('- "Row A"');
    // The same problems still standing ten minutes later are said again (03:05-03:35 went unsaid).
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      tick!();
      expect(sent).toHaveLength(3);
      tick!();
      expect(sent).toHaveLength(3);
    } finally {
      Date.now = realNow;
    }
    // Negative control: a plan without problems sends nothing.
    branch = plan("none", now);
    tick!();
    expect(sent).toHaveLength(3);
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK names a worker whose session file went quiet, and only that one", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-activity-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  writeFileSync(join(sessions, "main", "worker-a.jsonl"), "{}\n");
  writeFileSync(join(sessions, "main", "worker-b.jsonl"), "{}\n");
  const old = (Date.now() - 20 * 60_000) / 1000;
  utimesSync(join(sessions, "main", "worker-a.jsonl"), old, old);
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const now = Date.now();
  const sent: string[] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("chained", now);
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-activity" }), getBranch: () => branch, getSessionFile: () => sessionFile },
    getAsyncJobSnapshot: () => ({
      running: [
        { id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A", startTime: now - 30 * 60_000 },
        { id: "worker-b", agentId: "worker-b", type: "task", status: "running", label: "side", startTime: now - 30 * 60_000 },
      ],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    handlers.get("session_start")!({}, ctx);
    tick!();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("1 running worker(s) silent: worker-a (last activity 20 min ago)");
    expect(sent[0]).toContain("do not read their history");
    // The active worker is not named as silent.
    expect(sent[0]).not.toContain("worker-b (last activity");
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK reports a compacted running worker once with a done/left split action", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-compacted-worker-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  const liveNow = Date.now();
  const compactedAt = liveNow - 2 * 60_000;
  const compactedClock = new Date(compactedAt).toISOString().slice(11, 16);
  const workerFile = join(sessions, "main", "worker-a.jsonl");
  writeFileSync(
    workerFile,
    `${JSON.stringify({
      type: "compaction",
      id: "compaction-a",
      parentId: "entry-before-compaction",
      timestamp: new Date(compactedAt).toISOString(),
      summary: "Worker context compacted",
      firstKeptEntryId: "entry-after-compaction",
      tokensBefore: 120_000,
    })}\n`,
  );
  const lastActivity = (liveNow - 60_000) / 1000;
  utimesSync(workerFile, lastActivity, lastActivity);
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> = {};
  const sent: string[] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers[event] = handler;
    },
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => {
      sent.push(message.content);
    },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("ready", liveNow) as Array<{ message: { details: { phases: TodoScheduleInput } } }>;
  branch[0]!.message.details.phases[0]!.tasks.splice(1);
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: {
      getHeader: () => ({ id: "gates-compacted-worker" }),
      getBranch: () => branch,
      getSessionFile: () => sessionFile,
    },
    getAsyncJobSnapshot: () => ({
      running: [
        {
          id: "worker-a",
          agentId: "worker-a",
          type: "task",
          status: "running",
          label: "Row A",
          startTime: liveNow - 8 * 60_000,
        },
      ],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 1,
    isIdle: () => true,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => {
      tick = callback;
      return {};
    },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    handlers.session_start!({}, ctx);
    tick!();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("PLAN CHECK:");
    expect(sent[0]).toContain("worker-a");
    expect(sent[0]).toContain(`compacted at ${compactedClock}`);
    expect(sent[0]).toContain("write agent://worker-a");
    expect(sent[0]).toContain("done/left");
    expect(sent[0]).toContain("then split");
    tick!();
    expect(sent).toHaveLength(1);
  } finally {
    handlers.session_shutdown?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK asks only workers running longer than fifteen minutes for a done/left split", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-worker-runtime-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  const liveNow = Date.now();
  for (const id of ["worker-a", "worker-b"]) {
    const workerFile = join(sessions, "main", `${id}.jsonl`);
    writeFileSync(workerFile, "{}\n");
    const lastActivity = (liveNow - 60_000) / 1000;
    utimesSync(workerFile, lastActivity, lastActivity);
  }
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> = {};
  const sent: string[] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers[event] = handler;
    },
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => {
      sent.push(message.content);
    },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("ready", liveNow) as Array<{ message: { details: { phases: TodoScheduleInput } } }>;
  const tasks = branch[0]!.message.details.phases[0]!.tasks;
  tasks.splice(3);
  tasks[1]!.status = "in_progress";
  tasks[1]!.schedule!.owner = "worker-b";
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: {
      getHeader: () => ({ id: "gates-worker-runtime" }),
      getBranch: () => branch,
      getSessionFile: () => sessionFile,
    },
    getAsyncJobSnapshot: () => ({
      running: [
        {
          id: "worker-a",
          agentId: "worker-a",
          type: "task",
          status: "running",
          label: "Row A",
          startTime: liveNow - (sent.length ? 16 : 14) * 60_000,
        },
        {
          id: "worker-b",
          agentId: "worker-b",
          type: "task",
          status: "running",
          label: "Row B",
          startTime: liveNow - 10 * 60_000,
        },
      ],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 3,
    isIdle: () => true,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => {
      tick = callback;
      return {};
    },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    handlers.session_start!({}, ctx);
    tick!();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Row C");
    expect(sent[0]).not.toContain("done/left");
    tick!();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("worker-a");
    expect(sent[1]).toContain("16 min");
    expect(sent[1]).toContain("write agent://worker-a");
    expect(sent[1]).toContain("done/left");
    expect(sent[1]).toContain("then split");
    expect(sent[1]).not.toContain("write agent://worker-b");
    tick!();
    expect(sent).toHaveLength(2);
  } finally {
    handlers.session_shutdown?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK has the harness ask an overdue worker once instead of telling chief to inspect it", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-overdue-worker-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  writeFileSync(join(sessions, "main", "worker-a.jsonl"), "{}\n");
  const liveNow = Date.now();
  const old = (liveNow - 20 * 60_000) / 1000;
  utimesSync(join(sessions, "main", "worker-a.jsonl"), old, old);
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const sent: string[] = [];
  const nudges: Array<{ id: string; content: string }> = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("chained", liveNow - 60 * 60_000);
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-overdue-worker" }), getBranch: () => branch, getSessionFile: () => sessionFile },
    getAsyncJobSnapshot: () => ({
      running: [{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A", startTime: liveNow - 30 * 60_000 }],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sendAgentMessage: async (id: string, content: string) => {
      nudges.push({ id, content });
      return { delivered: true, text: `sent to ${id}` };
    },
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  const realNow = Date.now;
  Date.now = () => liveNow;
  try {
    handlers.get("session_start")!({}, ctx);
    tick!();
    await Promise.resolve();
    tick!();
    await Promise.resolve();
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({ id: "worker-a" });
    expect(nudges[0]!.content).toContain("your row Row A is past its P95 at");
    expect(nudges[0]!.content).toContain("reply with current artifact/path, first failing proof, or what you wait on");
    expect(sent[0]).toContain("overdue check-in sent to worker-a");
    expect(sent[0]).not.toContain("write agent://<id> asking what it waits on");
  } finally {
    Date.now = realNow;
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK falls back when worker message delivery returns false", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-overdue-worker-false-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  writeFileSync(join(sessions, "main", "worker-a.jsonl"), "{}\n");
  const liveNow = Date.now();
  const old = (liveNow - 20 * 60_000) / 1000;
  utimesSync(join(sessions, "main", "worker-a.jsonl"), old, old);
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const sent: string[] = [];
  const deliveries: Array<{ id: string; content: string }> = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("chained", liveNow - 60 * 60_000);
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-overdue-worker-false" }), getBranch: () => branch, getSessionFile: () => sessionFile },
    getAsyncJobSnapshot: () => ({
      running: [{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A", startTime: liveNow - 30 * 60_000 }],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sendAgentMessage: async (id: string, content: string) => {
      deliveries.push({ id, content });
      return { delivered: false, text: "no peer route" };
    },
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  const realNow = Date.now;
  Date.now = () => liveNow;
  try {
    handlers.get("session_start")!({}, ctx);
    tick!();
    await Promise.resolve();
    await Promise.resolve();
    expect(deliveries).toHaveLength(1);
    expect(sent.some((line) => line.includes("overdue check-in not delivered to worker-a: no peer route"))).toBe(true);
    expect(sent.some((line) => line.includes("chief must write agent://worker-a manually"))).toBe(true);
  } finally {
    Date.now = realNow;
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK keeps the manual fallback when worker messaging is absent", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-overdue-worker-absent-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  writeFileSync(join(sessions, "main", "worker-a.jsonl"), "{}\n");
  const liveNow = Date.now();
  const old = (liveNow - 20 * 60_000) / 1000;
  utimesSync(join(sessions, "main", "worker-a.jsonl"), old, old);
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const sent: string[] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("chained", liveNow - 60 * 60_000);
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-overdue-worker-absent" }), getBranch: () => branch, getSessionFile: () => sessionFile },
    getAsyncJobSnapshot: () => ({
      running: [{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A", startTime: liveNow - 30 * 60_000 }],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  const realNow = Date.now;
  Date.now = () => liveNow;
  try {
    handlers.get("session_start")!({}, ctx);
    tick!();
    expect(sent[0]).toContain("overdue check-in blocked for worker-a");
    expect(sent[0]).toContain("omp core exposes no worker-message API to extensions");
    expect(sent[0]).toContain("chief must write agent://worker-a manually");
  } finally {
    Date.now = realNow;
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK does not ask a worker before its own P95", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-not-overdue-worker-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  writeFileSync(join(sessions, "main", "worker-a.jsonl"), "{}\n");
  const liveNow = Date.now();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const nudges: Array<{ id: string; content: string }> = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("chained", liveNow);
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-not-overdue-worker" }), getBranch: () => branch, getSessionFile: () => sessionFile },
    getAsyncJobSnapshot: () => ({
      running: [{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A", startTime: liveNow }],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sendAgentMessage: async (id: string, content: string) => {
      nudges.push({ id, content });
      return { delivered: true, text: `sent to ${id}` };
    },
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  const realNow = Date.now;
  Date.now = () => liveNow;
  try {
    handlers.get("session_start")!({}, ctx);
    tick!();
    await Promise.resolve();
    expect(nudges).toHaveLength(0);
  } finally {
    Date.now = realNow;
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK includes compact running-worker status from session tool events", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-worker-digest-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  writeFileSync(join(sessions, "main", "worker-a.jsonl"), [
    JSON.stringify({
      type: "message",
      timestamp: new Date(Date.now() - 90_000).toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "edit", arguments: { path: "src/alpha.ts" } },
          { type: "toolCall", name: "bash", arguments: { command: "git add -- src/beta.ts", cwd: cwd } },
        ],
      },
    }),
    "",
  ].join("\n"));
  const workerOld = (Date.now() - 90_000) / 1000;
  utimesSync(join(sessions, "main", "worker-a.jsonl"), workerOld, workerOld);
  writeFileSync(join(sessions, "main", "settled-worker.jsonl"), [
    JSON.stringify({
      type: "message",
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "edit", arguments: { path: "src/settled.ts" } }],
      },
    }),
    "",
  ].join("\n"));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const liveNow = Date.now();
  const sent: string[] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("ready", liveNow);
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-worker-digest" }), getBranch: () => branch, getSessionFile: () => sessionFile },
    getAsyncJobSnapshot: () => ({
      running: [{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A", startTime: liveNow - 5 * 60_000 }],
      recent: [{ id: "settled-worker", type: "task", status: "completed", label: "Settled", startTime: liveNow - 10 * 60_000 }],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    handlers.get("session_start")!({}, ctx);
    tick!();
    const text = sent[0]!;
    expect(text).toContain("Worker status:");
    expect(text).toContain('worker-a row="Row A"');
    expect(text).toContain("last=bash git add -- src/beta.ts");
    expect(text).toContain("age=2 min");
    expect(text).toContain("wrote=src/alpha.ts,src/beta.ts");
    expect(text).toContain("P95=");
    expect(text).not.toContain("settled-worker");
    expect(text).not.toContain("src/settled.ts");
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK warns both live workers and chief once when worker writes overlap", async () => {
  const cwd = repo("clean");
  const sessions = mkdtempSync(join(tmpdir(), "gates-worker-overlap-"));
  const sessionFile = join(sessions, "main.jsonl");
  mkdirSync(join(sessions, "main"));
  const workerLog = (path: string) => [
    JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "edit", arguments: { path } }],
      },
    }),
    "",
  ].join("\n");
  writeFileSync(join(sessions, "main", "worker-a.jsonl"), workerLog("src/shared.ts"));
  writeFileSync(join(sessions, "main", "worker-b.jsonl"), workerLog("src/shared.ts"));
  writeFileSync(join(sessions, "main", "settled-worker.jsonl"), workerLog("src/shared.ts"));
  const liveNow = Date.now();
  const branch = plan("ready", liveNow) as Array<{ message: { details: { phases: TodoScheduleInput } } }>;
  branch[0]!.message.details.phases[0]!.tasks[1]!.status = "in_progress";
  branch[0]!.message.details.phases[0]!.tasks[1]!.schedule!.owner = "worker-b";
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const sent: string[] = [];
  const nudges: Array<{ id: string; content: string }> = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-worker-overlap" }), getBranch: () => branch, getSessionFile: () => sessionFile },
    getAsyncJobSnapshot: () => ({
      running: [
        { id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Row A", startTime: liveNow - 5 * 60_000 },
        { id: "worker-b", agentId: "worker-b", type: "task", status: "running", label: "Row B", startTime: liveNow - 5 * 60_000 },
      ],
      recent: [{ id: "settled-worker", type: "task", status: "completed", label: "Settled", startTime: liveNow - 10 * 60_000 }],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sendAgentMessage: async (id: string, content: string) => {
      nudges.push({ id, content });
      return { delivered: true, text: `sent to ${id}` };
    },
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    handlers.get("session_start")!({}, ctx);
    tick!();
    await Promise.resolve();
    tick!();
    await Promise.resolve();
    expect(nudges).toHaveLength(2);
    expect(nudges.map((nudge) => nudge.id).sort()).toEqual(["worker-a", "worker-b"]);
    expect(nudges[0]!.content).toContain("file overlap on src/shared.ts");
    expect(nudges[0]!.content).toContain("other live owner");
    expect(sent[0]).toContain("file overlap: src/shared.ts written by worker-a and worker-b");
    expect(sent[0]).not.toContain("settled-worker");
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 60_000);

test("write to a settled worker names and redirects to the row's current live owner", async () => {
  const cwd = repo("clean");
  const liveNow = Date.now();
  const branch = plan("ready", liveNow) as Array<{ message: { details: { phases: TodoScheduleInput } } }>;
  branch[0]!.message.details.phases[0]!.tasks[0]!.schedule!.owner = "worker-new";
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const redirected: Array<{ id: string; content: string }> = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait", "write"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-current-owner" }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({
      running: [{ id: "worker-new", agentId: "worker-new", type: "task", status: "running", label: "Row A", startTime: liveNow }],
      recent: [{ id: "worker-old", agentId: "worker-old", type: "task", status: "completed", label: "Row A", startTime: liveNow - 60_000 }],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    sendAgentMessage: async (id: string, content: string) => {
      redirected.push({ id, content });
      return { delivered: true, text: `sent to ${id}` };
    },
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    const stale = handlers.get("tool_call")!({
      toolName: "write",
      toolCallId: "write-old",
      input: { path: "agent://worker-old", content: "what is current proof?" },
    }, ctx) as { block?: boolean; reason?: string } | undefined;
    expect(stale?.block).toBe(true);
    expect(stale?.reason).toContain("worker-old is settled");
    expect(stale?.reason).toContain('row "Row A" current live owner is worker-new');
    expect(stale?.reason).toContain("redirect requested");
    await Promise.resolve();
    expect(redirected).toEqual([{ id: "worker-new", content: "what is current proof?" }]);
    // Negative control: addressing the current live owner is allowed.
    expect(handlers.get("tool_call")!({
      toolName: "write",
      toolCallId: "write-current",
      input: { path: "agent://worker-new", content: "continue" },
    }, ctx)).toBeUndefined();
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("refuses a second git-pr-owner on the same checkout while allowing another worktree", async () => {
  const cwd = repo("clean");
  const other = repo("clean");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const liveNow = Date.now();
  const branch: unknown[] = [{
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo",
      details: {
        phases: [{
          name: "Git",
          tasks: [{
            content: "Land caption mirror",
            status: "in_progress",
            schedule: {
              owner: "LandV3CaptionMirror",
              resources: [cwd],
              dependencies: [],
              estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 300, confidence: "high", basis: "landing row", updatedAt: liveNow },
            },
          }],
        }],
      },
    },
  }];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-git-pr-owner-lock" }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({
      running: [{
        id: "LandV3CaptionMirror",
        agentId: "LandV3CaptionMirror",
        type: "task",
        status: "running",
        agentProfile: "git-pr-owner",
        label: "Land caption mirror",
        startTime: liveNow,
      } as never],
      recent: [],
      nonJobAgents: [],
    }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    const same = handlers.get("tool_call")!({
      toolName: "task",
      toolCallId: "same-checkout",
      input: { tasks: [{ name: "LandCueTimingSha", agent: "git-pr-owner", task: `Land cue timing fix in ${cwd}` }] },
    }, ctx) as { block?: boolean; reason?: string } | undefined;
    expect(same?.block).toBe(true);
    expect(same?.reason).toContain(`checkout ${cwd}`);
    expect(same?.reason).toContain("already has live git-pr-owner LandV3CaptionMirror");

    const different = handlers.get("tool_call")!({
      toolName: "task",
      toolCallId: "other-checkout",
      input: { tasks: [{ name: "LandRiskEdgeSha", agent: "git-pr-owner", task: `Land risk edge fix in ${other}` }] },
    }, ctx);
    expect(different).toBeUndefined();
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
}, 60_000);

test("GIT FACTS names commits since previous chief turn and running git jobs", async () => {
  const cwd = repo("clean");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const liveNow = Date.now();
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: liveNow + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const branch = plan("ready", liveNow);
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-git-facts" }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => false,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  const context = () => (handlers.get("context")!({ messages: [] }, ctx) as { messages?: Array<{ content: string }> } | undefined)?.messages?.at(-1)?.content ?? "";
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    handlers.get("session_start")!({}, ctx);
    expect(context()).not.toContain("commits since previous chief turn");
    writeFileSync(join(cwd, "b.txt"), "next\n");
    git("add", "b.txt");
    git("commit", "-qm", "landed subject");
    const head = git("rev-parse", "--short=10", "HEAD").trim();
    child = spawn("bash", ["-lc", "exec -a git-hook-test sleep 20"], { cwd, stdio: "ignore" });
    const text = context();
    expect(text).toContain("commits since previous chief turn");
    expect(text).toContain(`${head} landed subject`);
    expect(text).toContain("running git job");
    expect(text).toContain("git-hook-test");
  } finally {
    child?.kill();
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("PLAN CHECK says when the finish recedes with the clock, not before 45 minutes of it", async () => {
  const cwd = repo("clean");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const now = Date.now();
  const sent: string[] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 6 * 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  let branch = plan("chained", now);
  let sessionId = "gates-receding";
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: sessionId }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  const realNow = Date.now;
  const at = (offsetMin: number) => { Date.now = () => realNow() + offsetMin * 60_000; tick!(); };
  try {
    handlers.get("session_start")!({}, ctx);
    at(0);
    // Negative control: a plan whose finish holds still is not receding, however long it runs.
    at(50);
    expect(sent.some((text) => text.includes("recedes with the clock"))).toBe(false);
    // Another session starts its own samples. The chief re-plans the same rows from "now" each
    // time: the finish moves with the clock.
    // Twenty minutes of that is not yet a trend.
    sessionId = "gates-receding-2";
    branch = plan("chained", realNow() + 60 * 60_000);
    at(60);
    branch = plan("chained", realNow() + 80 * 60_000);
    at(80);
    expect(sent.some((text) => text.includes("recedes with the clock"))).toBe(false);
    branch = plan("chained", realNow() + 110 * 60_000);
    at(110);
    const last = sent.at(-1)!;
    expect(last).toContain("the finish recedes with the clock");
    expect(last).toContain("Find all remaining defects in one pass");
    expect(last).not.toContain("plan-doctor");
    // Twenty minutes later the finish still recedes: the check hands the plan to plan-doctor.
    branch = plan("chained", realNow() + 135 * 60_000);
    at(135);
    const escalated = sent.at(-1)!;
    expect(escalated).toContain("Run `task` with agent `plan-doctor` now");
    expect(escalated).toContain("samples, now → finish:");
  } finally {
    Date.now = realNow;
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("the waiting list is the chain that sets the ETA and names a shared resource as a queue, not a dependency", async () => {
  const cwd = repo("clean");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const now = Date.now();
  const sent: string[] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
    pi: { ...sdk, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
    registerSoftToolRequirementProvider: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
  } as unknown as ExtensionAPI;
  await todoDispatch(api);
  const row = (content: string, dependencies: string[], resources: string[], owner?: string) => ({
    content,
    status: owner ? ("in_progress" as const) : ("pending" as const),
    schedule: {
      dependencies,
      resources,
      ...(owner ? { owner } : {}),
      estimate: { optimisticSeconds: 300, likelySeconds: 600, pessimisticSeconds: 900, confidence: "medium" as const, basis: "gates fixture", updatedAt: now - 60_000 },
    },
  });
  // Three shards after the build; shards one and three hold the same browser slot.
  const tasks = [
    row("Build", [], ["build"], "worker-a"),
    row("Shard one", ["Build"], ["slot-a"]),
    row("Shard two", ["Build"], ["slot-b"]),
    row("Shard three", ["Build"], ["slot-a"]),
    row("Join", ["Shard one", "Shard two", "Shard three"], ["join"]),
  ];
  const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } } }];
  let tick: (() => void) | undefined;
  const ctx = {
    cwd,
    sessionManager: { getHeader: () => ({ id: "gates-chain" }), getBranch: () => branch, getSessionFile: () => undefined },
    getAsyncJobSnapshot: () => ({ running: [{ id: "worker-a", agentId: "worker-a", type: "task", status: "running", label: "Build" }], recent: [], nonJobAgents: [] }),
    getTaskMaxConcurrency: () => 20,
    isIdle: () => true,
    hasPendingMessages: () => false,
    setTimeout: () => ({}),
    setInterval: (callback: () => void) => { tick = callback; return {}; },
    clearTimer: () => undefined,
  } as unknown as ExtensionContext;
  try {
    handlers.get("session_start")!({}, ctx);
    tick!();
    expect(sent).toHaveLength(1);
    const text = sent[0]!;
    expect(text).toContain('- "Shard three" (queued behind "Shard one": both hold resource "slot-a"; not a dependency)');
    expect(text).toContain('- "Join" (waits on "Shard three")');
    expect(text).toContain("A resource queue on this chain is a limit you set");
    // Shard two has slack behind the slot queue, so it is not on the chain.
    expect(text).not.toContain('- "Shard two"');
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
