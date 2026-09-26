// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { availableParallelism } from "node:os";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { TodoPlanForecast, TodoPlanningIssue, TodoScheduleInput, TodoTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import * as forecastFallback from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { lifecycleGoal, readGoalDeadline } from "./deadlines";

type DispatchForecastApi = Pick<
  ExtensionAPI["pi"],
  "forecastTodoPlan" | "formatPlanForecast" | "formatTaskForecast"
> & {
  getTodoPlanningIssues?: (phases: TodoScheduleInput) => TodoPlanningIssue[];
};

type Jobs = Pick<AsyncJobSnapshot, "running" | "recent" | "nonJobAgents">;
type PersistedChild = { id: string; owner: string | null; live: boolean };
type SprintWorkerFinish = { jobId: string; id: string; at: number; row: string };
type SprintState = {
  version: 1;
  seenRows: string[];
  lastPlanningSetKey: string | null;
  lastRetroAt: number | null;
  goalWorkStartedAt: number | null;
  rowStatuses: Record<string, string>;
  reopenedRows: string[];
  workerFinishes: SprintWorkerFinish[];
  seenJobIds: string[];
  correctionPending: boolean;
  retroDueReason: string | null;
  retroDueDeadlineAt?: number;
  retroDueDeliveryKey?: string;
  retroDueNotifiedKey?: string;
  handledDeadlineAt?: number;
  handledDeliveryKey?: string;
};
type TaskRow = TodoScheduleInput[number]["tasks"][number];
type SnapshotRow = { number: number; phase: string; task: TaskRow };
type AgentMessageDelivery = { delivered: boolean; text: string };
type WorkerCompactionCursor = { path: string; offset: number; pending: string; buffer: Buffer; at?: number };
type AgentMessageContext = ExtensionContext & {
  sendAgentMessage?: (to: string, message: string) => Promise<AgentMessageDelivery>;
};
type SoftToolRequirement = {
  soft: true;
  id: string;
  toolName: "task";
  reminder: Array<{ role: "developer"; content: string; timestamp: number }>;
  satisfies?: (toolCall: { name: string; arguments?: Record<string, unknown> }) => boolean;
};

type SoftToolRequirementRegistrar = {
  registerSoftToolRequirementProvider?: (
    provider: (ctx: ExtensionContext) => SoftToolRequirement | undefined,
  ) => void;
};

const MAX_ROWS = 64;
const MAX_LABEL = 120;
const MAX_IDLE_RECHECK_MS = 30_000;
const MAX_TASK_DISPATCH = 20;
const ROSTER_ENTRY_TYPE = "todo-dispatch-roster";
const SPRINT_STATE_ENTRY_TYPE = "todo-dispatch-sprint-state";
// A merge whose conflicts are all resolved is one `git commit` away. Seen live: a planner kept a
// resolved merge open for hours behind feature rows and gates while main moved on, and spawned a
// fresh round of merge workers for every move. Past these ages the gate demands commit, then push.
export const STALE_MERGE_MS = 30 * 60_000;
export const STALE_PUSH_MS = 60 * 60_000;
// No word boundary: worker names are CamelCase ("E2EMergeOwner").
const MERGE_WORK = /merg|conflict|rebas|cherry-pick/i;
const GIT_COMMIT = /\bgit\b[^;&|\n]*\b(commit|merge\s+--continue)\b/;
const GIT_PUSH = /\bgit\b[^;&|\n]*\bpush\b/;
const WORKER_NAME_GUIDANCE: Record<string, string> = {
  Owner: '"A worker\'s name says the result its row produces, verb first"',
  Integrator: '"Never name a worker after a role or a lock it holds"',
  Coordinator: '"Never name a worker after a role or a lock it holds"',
  Repair: '"Reopen it (`in_progress`), put the failing evidence into its task, and send it back to its owner"',
  Recovery: '"Reopen it (`in_progress`), put the failing evidence into its task, and send it back to its owner"',
  Restore: '"Reopen it (`in_progress`), put the failing evidence into its task, and send it back to its owner"',
  Fix: '"Reopen it (`in_progress`), put the failing evidence into its task, and send it back to its owner"',
  Fixup: '"Reopen it (`in_progress`), put the failing evidence into its task, and send it back to its owner"',
  V: '"V2, Cancel: like `Repair`, a first version was thrown away or abandoned. Reopen the row; dropping work is `todo` op `drop`, never a worker"',
  Cancel: '"V2, Cancel: like `Repair`, a first version was thrown away or abandoned. Reopen the row; dropping work is `todo` op `drop`, never a worker"',
  Oracle: '"Oracle, Fixture: a worker building a checker or a test rig instead of the deliverable"',
  Fixture: '"Oracle, Fixture: a worker building a checker or a test rig instead of the deliverable"',
  Shard: '"Shard: one suite split across workers"',
  Conflict: '"Conflict, Merge: parallel writers on the same files, then workers to untangle them"',
  Merge: '"Conflict, Merge: parallel writers on the same files, then workers to untangle them"',
  Omp: '"Omp: the session is working on its own harness. A harness defect is `report_issue`"',
  Final: '"Nothing is `final`: the user still reviews it, so an artefact and its worker carry a version, never `Final`"',
};
const WORKER_NAME_ACTION: Record<string, string> = {
  Owner: "Name the worker by result, verb-first.",
  Integrator: "Name the worker by result, verb-first.",
  Coordinator: "Name the worker by result, verb-first.",
  Repair: "Reopen the failed row and send it back to its owner; drop abandoned work with todo.",
  Recovery: "Reopen the failed row and send it back to its owner; drop abandoned work with todo.",
  Restore: "Reopen the failed row and send it back to its owner; drop abandoned work with todo.",
  Fix: "Reopen the failed row and send it back to its owner; drop abandoned work with todo.",
  Fixup: "Reopen the failed row and send it back to its owner; drop abandoned work with todo.",
  V: "Reopen the failed row and send it back to its owner; drop abandoned work with todo.",
  Cancel: "Reopen the failed row and send it back to its owner; drop abandoned work with todo.",
  Oracle: "The check is part of the changing row, run by gate-runner.",
  Fixture: "The check is part of the changing row, run by gate-runner.",
  Shard: "One gate-runner runs the whole suite.",
  Conflict: "Use step 8a before start; one git-pr-owner row per finished branch.",
  Merge: "Use step 8a before start; one git-pr-owner row per finished branch.",
  Omp: "Use report_issue; omp changes go through the fork and updater.",
  Final: "Name the result and give the artefact a version (content sha or rN), never final.",
};
export interface GitIntegrationState {
  mergeHead?: string;
  mergeAgeMs?: number;
  unmerged?: number;
  head?: string;
  unpushed?: number;
  oldestUnpushedAgeMs?: number;
}
export function readGitIntegrationState(cwd: string, now: number): GitIntegrationState | null {
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return out.status === 0 ? out.stdout.trim() : null;
  };
  const head = git("rev-parse", "HEAD");
  if (!head) return null;
  const state: GitIntegrationState = { head };
  const mergePath = git("rev-parse", "--git-path", "MERGE_HEAD");
  if (mergePath) {
    try {
      const stat = statSync(isAbsolute(mergePath) ? mergePath : join(cwd, mergePath));
      state.mergeHead = git("rev-parse", "--short", "MERGE_HEAD") ?? "MERGE_HEAD";
      state.mergeAgeMs = now - stat.mtimeMs;
      const unmerged = git("diff", "--name-only", "--diff-filter=U");
      state.unmerged = unmerged ? new Set(unmerged.split("\n").filter(Boolean)).size : 0;
    } catch {}
  }
  const unpushed = git("log", "--format=%ct", "@{upstream}..HEAD");
  if (unpushed !== null) {
    const times = unpushed.split("\n").filter(Boolean).map(Number);
    state.unpushed = times.length;
    if (times.length) state.oldestUnpushedAgeMs = now - Math.min(...times) * 1000;
  }
  return state;
}

function readGitLogSince(cwd: string, previousHead: string) {
  const out = spawnSync("git", ["log", "--abbrev=10", "--format=%h %s", `${previousHead}..HEAD`], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return out.status === 0 ? out.stdout.trim().split("\n").filter(Boolean) : [];
}

function readRunningGitJobs(cwd: string) {
  const gitJob = /\b(git|pre-commit|husky|hook|git-[^\s]+)\b/i;
  try {
    return readdirSync("/proc")
      .filter((pid) => /^\d+$/.test(pid))
      .flatMap((pid) => {
        try {
          const procCwd = readlinkSync(join("/proc", pid, "cwd"));
          if (procCwd !== cwd && !procCwd.startsWith(`${cwd}/`)) return [];
          const cmd = readFileSync(join("/proc", pid, "cmdline"), "utf8").replace(/\0/g, " ").trim();
          if (!cmd || !gitJob.test(cmd)) return [];
          return [`${pid} ${shorten(cmd, 80)}`];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function taskItems(input: unknown): Array<Record<string, unknown>> {
  const raw = (input as { tasks?: unknown } | undefined)?.tasks ?? input;
  return (Array.isArray(raw) ? raw : [raw]).filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
}

const CHECKOUT_FIELD = /^(cwd|checkout|worktree|repo|repository|path|targetPath|targetCheckout)$/i;
const ABSOLUTE_PATH = /\/(?:home|srv|tmp|var|mnt|workspaces|Users)\/[^\s"'`),;]+/g;

function normalizeCheckoutKey(value: string) {
  const trimmed = value.trim().replace(/[),.;:'"`]+$/g, "").replace(/\/+$/g, "");
  if (!trimmed) return null;
  return trimmed.startsWith("/") ? `path:${trimmed}` : `name:${trimmed}`;
}

function displayCheckoutKey(key: string) {
  return key.replace(/^(path|name):/, "");
}

function checkoutKeyFromTaskItem(item: Record<string, unknown>, fallbackCwd: string) {
  const direct: string[] = [];
  const visit = (value: unknown, key = "") => {
    if (typeof value === "string") {
      if (CHECKOUT_FIELD.test(key)) direct.push(value);
      return;
    }
    if (Array.isArray(value)) {
      if (key === "resources") for (const entry of value) if (typeof entry === "string") direct.push(entry);
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value === "object" && value !== null)
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  visit(item);
  const explicit = direct.map((value) => normalizeCheckoutKey(value)).find((key): key is string => Boolean(key));
  if (explicit) return explicit;

  const text = JSON.stringify(item);
  const path = text.match(ABSOLUTE_PATH)?.map((value) => normalizeCheckoutKey(value)).find((key): key is string => Boolean(key));
  return path ?? normalizeCheckoutKey(fallbackCwd)!;
}

function checkoutKeyFromResources(resources: unknown, fallbackCwd: string) {
  if (Array.isArray(resources))
    for (const resource of resources)
      if (typeof resource === "string") {
        const key = normalizeCheckoutKey(resource);
        if (key) return key;
      }
  return normalizeCheckoutKey(fallbackCwd)!;
}

function isGitPrOwnerItem(item: Record<string, unknown>) {
  return item.agent === "git-pr-owner";
}

function isLikelyGitPrOwnerJob(job: { id: string; agentId?: string; label?: string; agent?: unknown; agentProfile?: unknown; profile?: unknown }) {
  if (job.agent === "git-pr-owner" || job.agentProfile === "git-pr-owner" || job.profile === "git-pr-owner") return true;
  return /\bgit-pr-owner\b|GitOwner|(?:^|[-_\s])(Land|Commit|Push|CherryPick)\b/i.test(`${job.id} ${job.agentId ?? ""} ${job.label ?? ""}`);
}

function workerNameSegments(name: string) {
  const stripped = name.replace(/(?:-\d+)+$/, "");
  return stripped.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g) ?? [stripped];
}

function planningFailureWorkerWord(name: string): string | null {
  const segments = workerNameSegments(name);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (/^V\d+$/.test(segment)) return segment;
    if (segment === "V" && /^\d+$/.test(segments[index + 1] ?? "")) return `${segment}${segments[index + 1]}`;
    if (Object.prototype.hasOwnProperty.call(WORKER_NAME_GUIDANCE, segment)) return segment;
  }
  return null;
}

function readPersistedChildren(branch: unknown[]): PersistedChild[] {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { customType?: unknown; data?: unknown };
    if (candidate.customType !== ROSTER_ENTRY_TYPE) continue;
    if (typeof candidate.data !== "object" || candidate.data === null) return [];
    const data = candidate.data as { version?: unknown; children?: unknown };
    if (data.version !== 1 || !Array.isArray(data.children)) return [];
    const children = data.children.flatMap((child): PersistedChild[] => {
      if (typeof child !== "object" || child === null) return [];
      const item = child as { id?: unknown; owner?: unknown; live?: unknown };
      return typeof item.id === "string" &&
        (typeof item.owner === "string" || item.owner === null) &&
        typeof item.live === "boolean"
        ? [{ id: item.id, owner: item.owner, live: item.live }]
        : [];
    });
    return [...new Map(children.map((child) => [child.id, child])).values()];
  }
  return [];
}

function blankSprintState(): SprintState {
  return {
    version: 1,
    seenRows: [],
    lastPlanningSetKey: null,
    lastRetroAt: null,
    goalWorkStartedAt: null,
    rowStatuses: {},
    reopenedRows: [],
    workerFinishes: [],
    seenJobIds: [],
    correctionPending: false,
    retroDueReason: null,
  };
}

function readPersistedSprintState(branch: unknown[]): SprintState {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { customType?: unknown; data?: unknown };
    if (candidate.customType !== SPRINT_STATE_ENTRY_TYPE) continue;
    if (typeof candidate.data !== "object" || candidate.data === null) return blankSprintState();
    const data = candidate.data as Partial<SprintState>;
    if (data.version !== 1) return blankSprintState();
    return {
      version: 1,
      seenRows: Array.isArray(data.seenRows) ? data.seenRows.filter((item): item is string => typeof item === "string") : [],
      lastPlanningSetKey: typeof data.lastPlanningSetKey === "string" ? data.lastPlanningSetKey : null,
      lastRetroAt: typeof data.lastRetroAt === "number" ? data.lastRetroAt : null,
      goalWorkStartedAt: typeof data.goalWorkStartedAt === "number" ? data.goalWorkStartedAt : null,
      rowStatuses: typeof data.rowStatuses === "object" && data.rowStatuses !== null ? Object.fromEntries(
        Object.entries(data.rowStatuses).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ) : {},
      reopenedRows: Array.isArray(data.reopenedRows) ? data.reopenedRows.filter((item): item is string => typeof item === "string") : [],
      workerFinishes: Array.isArray(data.workerFinishes)
        ? data.workerFinishes.flatMap((item): SprintWorkerFinish[] => {
            if (typeof item !== "object" || item === null) return [];
            const row = item as Partial<SprintWorkerFinish>;
            return typeof row.jobId === "string" && typeof row.id === "string" && typeof row.at === "number" && typeof row.row === "string"
              ? [{ jobId: row.jobId, id: row.id, at: row.at, row: row.row }]
              : [];
          })
        : [],
      seenJobIds: Array.isArray(data.seenJobIds) ? data.seenJobIds.filter((item): item is string => typeof item === "string") : [],
      correctionPending: data.correctionPending === true,
      retroDueReason: typeof data.retroDueReason === "string" ? data.retroDueReason : null,
      ...(typeof data.retroDueDeadlineAt === "number" ? { retroDueDeadlineAt: data.retroDueDeadlineAt } : {}),
      ...(typeof data.retroDueDeliveryKey === "string" ? { retroDueDeliveryKey: data.retroDueDeliveryKey } : {}),
      ...(typeof data.retroDueNotifiedKey === "string" ? { retroDueNotifiedKey: data.retroDueNotifiedKey } : {}),
      ...(typeof data.handledDeadlineAt === "number" ? { handledDeadlineAt: data.handledDeadlineAt } : {}),
      ...(typeof data.handledDeliveryKey === "string" ? { handledDeliveryKey: data.handledDeliveryKey } : {}),
    };
  }
  return blankSprintState();
}

function mergePersistedChildren(
  previous: PersistedChild[],
  jobs: Jobs | null,
): PersistedChild[] {
  if (jobs === null) return previous;
  const settledIds = new Set(
    jobs.recent
      .filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled")
      .flatMap((job) => job.agentId ? [job.id, job.agentId] : [job.id]),
  );
  const children = new Map(
    previous
      .filter((child) => !settledIds.has(child.id) && !(child.owner && settledIds.has(child.owner)))
      .map((child) => [child.id, child]),
  );
  for (const agent of jobs.nonJobAgents ?? []) {
    children.set(agent.id, { id: agent.id, owner: children.get(agent.id)?.owner ?? null, live: agent.live });
  }
  for (const job of jobs.running) {
    if (job.status !== "running") continue;
    const id = job.agentId ?? job.id;
    children.set(id, { id, owner: job.agentId ? job.id : null, live: true });
  }
  return [...children.values()];
}

function restoredChildren(
  previous: PersistedChild[],
  jobs: Jobs | null,
): PersistedChild[] {
  if (jobs === null) return previous;
  const activeIds = new Set([
    ...jobs.running.filter((job) => job.status === "running").flatMap((job) =>
      job.agentId ? [job.id, job.agentId] : [job.id],
    ),
    ...(jobs.nonJobAgents ?? []).filter((agent) => agent.live).map((agent) => agent.id),
  ]);
  const settledIds = new Set(
    jobs.recent
      .filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled")
      .flatMap((job) => job.agentId ? [job.id, job.agentId] : [job.id]),
  );
  return previous.filter((child) =>
    !activeIds.has(child.id) && !(child.owner && activeIds.has(child.owner)) &&
    !settledIds.has(child.id) && !(child.owner && settledIds.has(child.owner)),
  );
}
const shorten = (text: string, max = MAX_LABEL) => text.replace(/\s+/g, " ").trim().slice(0, max);
function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  if (typeof value === "object" && value !== null)
    return Object.values(value as Record<string, unknown>).some((item) => containsExactString(item, expected));
  return false;
}

function hasEvidenceField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasEvidenceField(item));
  if (typeof value !== "object" || value === null) return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "evidence" && typeof item === "string" && item.trim()) return true;
    if (hasEvidenceField(item)) return true;
  }
  return false;
}

function isPlanDoctorTaskInput(value: unknown): boolean {
  if (typeof value === "string") return value === "plan-doctor";
  if (Array.isArray(value)) return value.some((item) => isPlanDoctorTaskInput(item));
  if (typeof value === "object" && value !== null)
    return Object.values(value as Record<string, unknown>).some((item) => isPlanDoctorTaskInput(item));
  return false;
}

function cwdSnapshotSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "cwd";
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface DispatchInput {
  phases: TodoScheduleInput;
  jobs: Jobs | null;
  restoredChildren?: PersistedChild[];
  persistedChildren?: PersistedChild[];
  isMainSession: boolean;
  taskEnabled: boolean;
  now: number;
  /** Current Task worker cap when exposed by the host; 0 means Unlimited. */
  capacity?: number;
  /** Whether the host can enforce a Task call before another turn. */
  dispatchGateAvailable?: boolean;
  deadline?: { goalId: string; deadlineAt: number; paused?: boolean };
  goalPaused?: boolean;
  lastWakeKey?: string | null;
  cachedStatic?: { key: string; text: string } | null;
  idleResumeAttempts?: ReadonlySet<string>;
}

export interface DispatchDecision {
  key: string | null;
  staticPrompt: string | null;
  prompt: string | null;
  forecast: TodoPlanForecast | null;
  alarms: string[];
  rawWakeKey: string | null;
  wakeKey: string | null;
  nextCheckMs: number | null;
  readyCandidates: Array<{
    content: string;
    owner: string | null;
    ownership: "unassigned" | "unverified" | "live-owned" | "shared-live-owner" | "idle-live-owner" | "restored-owner";
  }>;
  dispatchableReady?: Array<DispatchDecision["readyCandidates"][number]>;
  todoOwnerIds?: string[];
  ownerRunStates?: Array<{ content: string; owner: string | null; running: boolean }>;
  deadline?: DispatchInput["deadline"];
  capacity?: number;
  activeTaskCount?: number;
  goalPaused?: boolean;
  staffingSnapshotComplete?: boolean;
  taskEnabled?: boolean;
}

function staticKey(
  phases: TodoScheduleInput,
  jobs: Jobs | null,
  deadline: DispatchInput["deadline"],
  capacity: number | undefined,
  goalPaused: boolean,
  restored: PersistedChild[],
  persisted: PersistedChild[],
): string {
  const tasks = phases.map((phase) => [
    phase.name,
    phase.tasks.map((task) => [
      task.content,
      task.status,
      task.blocker ?? null,
      task.schedule ?? null,
    ]),
  ]);
  const jobKey =
    jobs === null
      ? null
      : [jobs.running, jobs.recent.filter((job) => job.type === "task")].map((group) =>
          group
            .map((job) => [job.id, job.type, job.status, job.label, job.agentId ?? null, job.startTime])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        );
  const nonJobAgents = jobs?.nonJobAgents
    ?.map(({ id, live }) => [id, live])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const restoredKey = restored.map(({ id, owner, live }) => [id, owner, live])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const persistedKey = persisted.map(({ id, owner, live }) => [id, owner, live])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([tasks, jobKey, nonJobAgents ?? null, restoredKey, persistedKey, deadline ?? null, capacity ?? null, goalPaused]);
}

function safeTimestamp(value: unknown): string {
  const date = new Date(value as number);
  return typeof value === "number" && Number.isFinite(value) && Number.isFinite(date.getTime())
    ? date.toISOString()
    : "unknown";
}

function safeText(value: unknown, max = MAX_LABEL): string {
  return typeof value === "string" ? shorten(value, max) : "unknown";
}
function isOpenRowStatus(status: string): boolean {
  return status === "pending" || status === "in_progress";
}
function isNonClosedRowStatus(status: string): boolean {
  return status === "pending" || status === "in_progress" || status === "blocked";
}
function sprintSetKey(rows: string[]): string {
  return JSON.stringify([...rows].sort());
}
function rowDeliveryKey(tasks: TaskRow[]): string {
  return sprintSetKey(tasks.map((task) => task.content));
}
function isCorrectionInput(event: unknown): boolean {
  const source = (event as { source?: unknown } | undefined)?.source;
  if (source === "extension") return false;
  const text = JSON.stringify(event ?? "").toLowerCase();
  return /ху|бляд|сука|не то|не так|опять|я же просил/i.test(text);
}
function isRetroFacilitatorTaskResult(event: unknown): boolean {
  const details = (event as { details?: unknown } | undefined)?.details;
  if (!details || typeof details !== "object") return false;
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return false;
  return results.some((result) =>
    typeof result === "object" && result !== null &&
    (result as { agent?: unknown }).agent === "retro-facilitator"
  );
}
function taskDetails(task: TaskRow): string {
  const schedule = task.schedule && typeof task.schedule === "object" ? task.schedule : undefined;
  if (!schedule) return "schedule=missing";
  const estimate = schedule.estimate
    ? `${schedule.estimate.optimisticSeconds}/${schedule.estimate.likelySeconds}/${schedule.estimate.pessimisticSeconds}s ${safeText(schedule.estimate.confidence)}; basis=${safeText(schedule.estimate.basis, 80)}; updated=${safeTimestamp(schedule.estimate.updatedAt)}`
    : "MISSING estimate";
  const dependencies = Array.isArray(schedule.dependencies)
    ? JSON.stringify(schedule.dependencies)
    : "unknown";
  const resources = Array.isArray(schedule.resources) ? JSON.stringify(schedule.resources) : "unknown";
  const progress = schedule.progress
    ? `${safeTimestamp(schedule.progress.at)}:${safeText(schedule.progress.evidence, 120)}`
    : "none";
  return `owner=${JSON.stringify(schedule.owner ?? null)}; dependencies=${dependencies}; resources=${resources}; O/L/P=${estimate}; progress=${progress}`;
}

function buildStaticPrompt(
  rows: SnapshotRow[],
  jobs: Jobs | null,
  deadline: DispatchInput["deadline"],
  capacity: number | undefined,
  goalPaused: boolean,
  restored: PersistedChild[],
): string {
  const snapshotRows = rows.slice(0, MAX_ROWS);
  const snapshotLines: string[] = [];
  let lastPhase: string | undefined;
  for (const { number, phase, task } of snapshotRows) {
    if (phase !== lastPhase) snapshotLines.push(`${JSON.stringify(phase)}:`);
    lastPhase = phase;
    const blocker = task.status === "blocked" ? `; blocker=${JSON.stringify(task.blocker ?? "not recorded")}` : "";
    const closed = task.status === "completed" || task.status === "abandoned";
    snapshotLines.push(`  #${number} [${task.status}] ${JSON.stringify(task.content)}${blocker}${closed ? "" : `; ${taskDetails(task)}`}`);
  }
  if (rows.length > MAX_ROWS)
    snapshotLines.push(`… ${rows.length - MAX_ROWS} rows beyond the ${MAX_ROWS}-row bound; inspect native todo.view before deciding on the tail`);

  const running = jobs?.running ?? [];
  const recentTasks = jobs?.recent.filter((job) => job.type === "task") ?? [];
  const jobLines = (list: typeof running) =>
    list.map((job) =>
      `- ${JSON.stringify(job.id)} ${job.status} agent=${JSON.stringify(job.agentId ?? null)} label=${JSON.stringify(shorten(job.label))}`,
    );
  const runningLines = jobLines(running);
  const recentLines = jobLines(recentTasks).slice(0, MAX_ROWS);
  if (recentTasks.length > MAX_ROWS) recentLines.push(`- ${recentTasks.length - MAX_ROWS} more recent task jobs; inspect live hub jobs`);
  const agents = jobs?.nonJobAgents;
  const agentLines = agents?.map(({ id, live }) => `${JSON.stringify(id)}=${live}`) ?? [];
  const restoredLines = restored.map(({ id, owner, live }) =>
    `- id=${JSON.stringify(id)} owner=${JSON.stringify(owner)} last-known-live=${live}`,
  );
  const openCount = rows.filter(({ task }) => task.status === "pending" || task.status === "in_progress").length;
  const blockedCount = rows.filter(({ task }) => task.status === "blocked").length;
  return [
    "[TODO supervisor; advisory, not a user request]",
    `TODO rows ${snapshotRows.length}/${rows.length}; open=${openCount}; blocked=${blockedCount}; tail=${Math.max(0, rows.length - snapshotRows.length)}; Task cap=${capacity === undefined ? "unknown" : capacity === 0 ? "unlimited" : capacity}. Rows follow canonical order:`,
    ...(snapshotLines.length ? snapshotLines : ["- none"]),
    "Owner labels and bare live non-job roster entries are not active staffing proof: count exact IDs in running task jobs, or a live roster entry that matches a persisted task-child owner. Idle live agents may be re-staffed but do not count as staffed. Do not dispatch blocked or dependency-waiting rows. Main coordinates staffed work; if Task dispatch is unavailable, main may do bounded safe work directly rather than leave the deliverable untouched.",
    goalPaused
      ? "Paused goal: observation only; require evidence-based current O/L/P plus confidence for every nonclosed row, the full remaining scope, and exact Task/non-job worker roster. Do not start Task jobs or perform autonomous goal work."
      : "Schedule every pending/in-progress/blocked row before work: evidence-based O/L/P plus confidence, explicit dependencies ([] only if proven independent), owner and exclusive resources when known; inspect/ask on unknowns, split pessimistic work >1h, and recover blockers safely. Once recorded, do not repeat planning without a new fact; move to the next deliverable-producing action.",
    `Fixed native deadline: ${deadline ? `${JSON.stringify(deadline.goalId)} at ${safeTimestamp(deadline.deadlineAt)} (immutable${goalPaused ? "; paused: observation only, no autonomous goal work" : ""})` : goalPaused ? "paused goal; deadline unavailable through host API (observation only, no autonomous goal work)" : "none"}.`,
    `Running task jobs (${running.length}; session-owned):`,
    ...(jobs === null ? ["- snapshot unavailable; inspect live hub state"] : runningLines.length ? runningLines : ["- none"]),
    `Recent task jobs (${recentTasks.length}; reconcile exact settlements):`,
    ...(jobs === null ? ["- snapshot unavailable"] : recentLines.length ? recentLines : ["- none"]),
    agents === undefined ? "Non-job roster unavailable; inspect live hub before dispatch." : `Live non-job roster: ${agentLines.join(", ") || "none"}`,
    `Parked/restored child roster (${restored.length}; persisted last-known IDs, not proof of liveness):`,
    ...(restoredLines.length ? restoredLines : ["- none"]),
    goalPaused
      ? "Paused observation only: reconcile every running job, live non-job agent, and parked/restored child against TODO ownership with exact IDs; do not resume or start jobs. An empty live snapshot is not nothing-to-reconcile."
      : "Reconcile every running job, live non-job agent, and parked/restored child against TODO ownership before another batch. Require an exact resume of idle owners; fresh-dispatch only ready rows disjoint from all roster-owned work. An empty live snapshot is not nothing-to-reconcile.",
  ].join("\n");
}

function compactForecastRow(row: TodoTaskForecast): string {
  return [
    `ready=${row.ready ? "yes" : "no"}`,
    row.awaitingPrerequisite ? `await=${JSON.stringify(row.awaitingPrerequisite)}` : undefined,
    `CPM=${safeTimestamp(row.earliestStart)}/${safeTimestamp(row.earliestFinish)}/${safeTimestamp(row.latestStart)}/${safeTimestamp(row.latestFinish)}`,
    `float=${Number.isFinite(row.totalFloatSeconds) ? `${Math.round(row.totalFloatSeconds!)}s` : "?"}/${Number.isFinite(row.freeFloatSeconds) ? `${Math.round(row.freeFloatSeconds!)}s` : "?"}`,
    `resource=${safeTimestamp(row.resourceStart)}..${safeTimestamp(row.resourceFinish)}; expected=${safeTimestamp(row.expectedResourceFinish)}`,
    `PERT=${Number.isFinite(row.fixedPathExpectedSeconds) ? `${Math.round(row.fixedPathExpectedSeconds!)}s` : "?"}/${Number.isFinite(row.fixedPathSigmaSeconds) ? `${Math.round(row.fixedPathSigmaSeconds!)}s` : "?"}; P95=${safeTimestamp(row.fixedPathP95Finish ?? row.resourceFinish)}`,
    `critical=${row.criticalityKnown === false ? "unknown" : row.critical ? "yes" : "no"}`,
    row.overdue ? `MISSED-ETA revision=${row.estimateRevision}; reestimates=${row.reestimateCount}` : undefined,
    row.stale ? "STALE" : undefined,
  ].filter((part): part is string => part !== undefined).join(" ");
}

function displayClock(now: number): string {
  return safeTimestamp(now);
}

function nextCheckDelay(plan: TodoPlanForecast, now: number, deadlineAt: number): number {
  const upcoming = plan.rows
    .flatMap((row) => [row.latestStart, row.resourceFinish])
    .filter((at): at is number => Number.isFinite(at) && at! > now);
  if (Number.isFinite(deadlineAt) && deadlineAt > now) upcoming.push(deadlineAt);
  return Math.max(
    1,
    Math.min(MAX_IDLE_RECHECK_MS, ...upcoming.map((at) => at - now), MAX_IDLE_RECHECK_MS),
  );
}

export function decideTodoDispatch(
  input: DispatchInput,
  sdk: DispatchForecastApi,
): DispatchDecision {
  const { phases, jobs, isMainSession, taskEnabled, now, deadline, lastWakeKey } = input;
  const goalPaused = input.goalPaused === true || deadline?.paused === true;
  const capacity =
    typeof input.capacity === "number" &&
    Number.isFinite(input.capacity) &&
    Number.isInteger(input.capacity) &&
    input.capacity >= 0
      ? input.capacity
      : undefined;
  if (!isMainSession) {
    return {
      key: null,
      staticPrompt: null,
      prompt: null,
      forecast: null,
      alarms: [],
      rawWakeKey: null,
      wakeKey: null,
      nextCheckMs: null,
      readyCandidates: [],
    };
  }
  const open = phases.flatMap((phase) =>
    phase.tasks
      .filter((task) => task.status === "pending" || task.status === "in_progress")
      .map((task) => ({ phase: phase.name, task })),
  );
  const blocked = phases.flatMap((phase) =>
    phase.tasks
      .filter((task) => task.status === "blocked")
      .map((task) => ({ phase: phase.name, task })),
  );
  const obligated = [...open, ...blocked];
  if (obligated.length === 0) {
    return {
      key: null,
      staticPrompt: null,
      prompt: null,
      forecast: null,
      alarms: [],
      rawWakeKey: null,
      wakeKey: null,
      nextCheckMs: null,
      readyCandidates: [],
    };
  }

  const key = staticKey(phases, jobs, deadline, capacity, goalPaused, input.restoredChildren ?? [], input.persistedChildren ?? []);
  let staticPrompt = input.cachedStatic?.key === key ? input.cachedStatic.text : undefined;
  if (staticPrompt === undefined) {
    const snapshotRows: SnapshotRow[] = [];
    for (const phase of phases)
      for (const task of phase.tasks)
        snapshotRows.push({ number: snapshotRows.length + 1, phase: phase.name, task });
    staticPrompt = buildStaticPrompt(snapshotRows, jobs, deadline, capacity, goalPaused, input.restoredChildren ?? []);
  }
  const forecast = sdk.forecastTodoPlan(phases, {
    now,
    deadlineAt: deadline?.deadlineAt,
    ...(capacity === undefined ? {} : { capacity }),
  });
  const planningIssues =
    forecast.planningIssues ?? sdk.getTodoPlanningIssues?.(phases) ?? [];
  const obligatedContent = new Set(obligated.map(({ task }) => task.content));
  const forecastRows = forecast.rows
    .filter((row) => obligatedContent.has(row.content))
    .slice(0, MAX_ROWS);
  const forecastLines = forecastRows.map((row) =>
    `- [${row.status}] ${JSON.stringify(shorten(row.content))}: ${compactForecastRow(row)}`,
  );
  if (obligated.length > MAX_ROWS)
    forecastLines.push(`- … ${obligated.length - MAX_ROWS} more nonclosed rows; inspect native todo.view`);
  const missing = planningIssues
    .filter((issue) => issue.code === "missing-estimate")
    .map((issue) => issue.task);
  const stale = forecast.rows
    .filter((row) => obligatedContent.has(row.content) && row.stale)
    .map((row) => row.content);
  const openContent = new Set(open.map(({ task }) => task.content));
  const activeTaskJobs =
    jobs?.running.filter((job) => job.type === "task" && job.status === "running") ?? [];
  const nonJobAgents = jobs?.nonJobAgents;
  const persistedTaskChildren = input.persistedChildren ?? [];
  const livePersistedChildForOwner = (owner: string | null) => {
    if (owner === null) return undefined;
    const child = persistedTaskChildren.find((candidate) =>
      candidate.live && candidate.owner !== null && (candidate.id === owner || candidate.owner === owner)
    );
    if (!child) return undefined;
    if (
      input.idleResumeAttempts?.has(owner) ||
      input.idleResumeAttempts?.has(child.id) ||
      (child.owner !== null && input.idleResumeAttempts?.has(child.owner))
    )
      return undefined;
    return nonJobAgents?.some((agent) => agent.id === child.id && agent.live === true) ? child : undefined;
  };
  const runningTaskWorkerIds = new Set(
    activeTaskJobs.map((job) => job.agentId ?? job.id),
  );
  const activeRestoredTaskIds = new Set(
    open.flatMap(({ task }) => {
      const owner = typeof task.schedule?.owner === "string" ? task.schedule.owner : null;
      const child = livePersistedChildForOwner(owner);
      return child && !runningTaskWorkerIds.has(child.id) ? [child.id] : [];
    }),
  );
  const ownerHasActiveTask = (owner: string | null) =>
    owner !== null && (
      activeTaskJobs.some((job) => job.id === owner || job.agentId === owner) ||
      livePersistedChildForOwner(owner) !== undefined
    );
  const ownerRunStates = open.map(({ task }) => {
    const owner = typeof task.schedule?.owner === "string" ? task.schedule.owner : null;
    return { content: task.content, owner, running: ownerHasActiveTask(owner) };
  });
  const openTasksByContent = new Map(open.map(({ task }) => [task.content, task]));
  const liveResourceHolders = open
    .filter(({ task }) => {
      const owner = task.schedule?.owner;
      return task.status === "in_progress" && typeof owner === "string" && ownerHasActiveTask(owner);
    })
    .map(({ task }) => task);
  const claimedLiveWorkerIds = new Set<string>();
  const readyCandidates = forecast.rows
    .filter((row) => openContent.has(row.content) && row.ready)
    .map((row) => {
      const owner = typeof row.owner === "string" ? row.owner : null;
      const registryAgent = owner === null || owner.toLowerCase() === "main"
        ? undefined
        : nonJobAgents?.find((agent) => agent.id === owner && agent.live === true);
      const activeRestoredChild = livePersistedChildForOwner(owner);
      const restoredOwner = owner === null
        ? undefined
        : input.restoredChildren?.find((child) => child.id === owner || child.owner === owner);
      const jobByAgentId = owner === null
        ? undefined
        : activeTaskJobs.find((active) => active.agentId === owner);
      const jobById = owner === null
        ? undefined
        : activeTaskJobs.find((active) => active.id === owner);
      const liveWorkerId =
        jobByAgentId?.agentId || (jobById ? jobById.agentId || jobById.id : undefined) ||
        activeRestoredChild?.id;
      const sharedLiveOwner = liveWorkerId !== undefined && claimedLiveWorkerIds.has(liveWorkerId);
      if (liveWorkerId !== undefined && !sharedLiveOwner) claimedLiveWorkerIds.add(liveWorkerId);
      const ownership = sharedLiveOwner
        ? "shared-live-owner" as const
        : liveWorkerId !== undefined
          ? "live-owned" as const
          : registryAgent !== undefined
            ? "idle-live-owner" as const
            : restoredOwner !== undefined
              ? "restored-owner" as const
              : owner === null
                ? "unassigned" as const
                : "unverified" as const;
      return { content: row.content, owner, ownership };
    });
  const ownerlessReady = readyCandidates.filter((row) => row.ownership !== "live-owned");
  const resourceExecutableContents = new Set(
    forecast.rows
      .filter((row) => row.ready && typeof row.resourceStart === "number" && row.resourceStart <= now)
      .filter((row) => {
        const task = openTasksByContent.get(row.content);
        if (!task) return false;
        return !liveResourceHolders.some((holder) => {
          if (holder.content === task.content) return false;
          const candidateOwner = task.schedule?.owner;
          const holderOwner = holder.schedule?.owner;
          const candidateRestoredChild = typeof candidateOwner === "string"
            ? livePersistedChildForOwner(candidateOwner)
            : undefined;
          const holderRestoredChild = typeof holderOwner === "string"
            ? livePersistedChildForOwner(holderOwner)
            : undefined;
          const sameLiveOwner =
            typeof candidateOwner === "string" && typeof holderOwner === "string" &&
            (activeTaskJobs.some((job) =>
                (job.id === candidateOwner || job.agentId === candidateOwner) &&
                (job.id === holderOwner || job.agentId === holderOwner),
              ) ||
              (candidateRestoredChild !== undefined && holderRestoredChild !== undefined &&
                candidateRestoredChild.id === holderRestoredChild.id));
          const candidateResources = task.schedule?.resources;
          const holderResources = holder.schedule?.resources;
          const sharedResource =
            Array.isArray(candidateResources) && Array.isArray(holderResources) &&
            candidateResources.some((resource) => holderResources.includes(resource));
          return sameLiveOwner || sharedResource;
        });
      })
      .map((row) => row.content),
  );
  const staffingSnapshotComplete = jobs !== null && nonJobAgents !== undefined;
  const dispatchableReady = ownerlessReady.filter(
    (candidate) =>
      staffingSnapshotComplete &&
      // A restored owner that is not running after startup is dead (omp --resume brings nobody back):
      // its row is staffed again under the owner's name (live 21:48: 0 of 20 ran while two such rows waited).
      resourceExecutableContents.has(candidate.content) &&
      !(candidate.ownership === "idle-live-owner" && candidate.owner !== null && input.idleResumeAttempts?.has(candidate.owner)) &&
      !(candidate.owner === null && (input.restoredChildren?.length ?? 0) > 0),
  );
  const actionableReadyContents = new Set(
    staffingSnapshotComplete && taskEnabled && !goalPaused && capacity !== undefined &&
      (capacity === 0 || activeTaskJobs.length < capacity)
      ? dispatchableReady.map((row) => row.content)
      : [],
  );
  const executableReady = forecast.rows.some(
    (row) => actionableReadyContents.has(row.content) && row.ready &&
      typeof row.resourceStart === "number" && row.resourceStart <= now,
  );
  const dependencyUnready = forecast.rows.filter(
    (row) => openContent.has(row.content) && !row.ready,
  );
  const idleOwnerRows = ownerlessReady.filter((row) => row.ownership === "idle-live-owner");
  const restoredOwnerRows = ownerlessReady.filter((row) => row.ownership === "restored-owner");
  const resumeOwners = [...new Set([
    ...idleOwnerRows.map((row) => row.owner),
    ...restoredOwnerRows.map((row) => row.owner),
  ].filter((owner): owner is string => owner !== null))];
  const dispatchDirective =
    !taskEnabled
      ? "FAIL CLOSED: the Task tool is inactive; do not dispatch or claim these rows are staffed. Continue bounded safe work directly on the active deliverable."
      : goalPaused
        ? "FAIL CLOSED: the active goal is paused; observe only and do not dispatch autonomous work."
        : input.dispatchGateAvailable === false
          ? "FAIL CLOSED: native Task dispatch gate is unavailable; do not dispatch or claim rows are staffed. Continue bounded safe work directly on the active deliverable without duplicating a live worker."
          : readyCandidates.length === 0
            ? "No open row is dependency-ready; resolve the real blocker/dependency wait before dispatch."
            : ownerlessReady.length === 0
              ? "Every dependency-ready row has an exact running task-job match; do not duplicate them."
              : capacity === undefined
                ? "FAIL CLOSED: Task capacity is unknown; inspect live hub limits before dispatching."
                : !staffingSnapshotComplete
                  ? "FAIL CLOSED: live roster/job snapshot is incomplete; reconcile exact IDs before dispatching."
                  : capacity > 0 && activeTaskJobs.length >= capacity
                    ? "FAIL CLOSED: the Task capacity is full; wait for an actual slot before dispatching."
                    : dispatchableReady.length === 0 && restoredOwnerRows.length > 0
                      ? `RECONCILE: exact-resume parked/restored owner(s) ${resumeOwners.map((owner) => JSON.stringify(owner)).join(", ")} before reusing their rows. Fresh-dispatch only ready rows disjoint from them.`
                      : dispatchableReady.length === 0 && (input.restoredChildren?.length ?? 0) > 0
                        ? "RECONCILE: parked/restored child ownership is not linked to a TODO owner; do not dispatch unowned ready rows until the exact roster is reconciled."
                        : dispatchableReady.length === 0
                          ? "FAIL CLOSED: no unstaffed ready row has a conflict-free current resource start; inspect resource ownership before dispatching."
                          : `First reconcile any just-settled task worker using action 2. For each exact idle or parked/restored owner${resumeOwners.length ? ` (${resumeOwners.map((owner) => JSON.stringify(owner)).join(", ")})` : ""}, re-staff with a task item whose name is the owner and whose task is the row's exact title plus what to return. A bare agent:// message is not staffing. Then immediately start distinct live workers for as many unstaffed ready rows as the actual Task cap (0 means Unlimited) and canonical resource forecast allow; queue remaining rows and dispatch as capacity/resources free. Reuse one ID only on a strict dependency chain scheduled sequentially. Main coordinates staffed work, and owns integration and delivery.`;
  const readyFacts = readyCandidates.map((row) => [row.content, row.owner, row.ownership]);
  const failedTasks =
    jobs?.recent.filter(
      (job) => job.type === "task" && (job.status === "failed" || job.status === "cancelled"),
    ) ?? [];
  const alarmSet = new Set<string>();
  for (const issue of planningIssues)
    alarmSet.add(`${issue.code}:${JSON.stringify(issue.task)}`);
  for (const { task } of blocked)
    alarmSet.add(`blocked-recovery:${JSON.stringify(task.content)}:${JSON.stringify(task.blocker ?? null)}`);
  for (const row of ownerlessReady) alarmSet.add(`ownerless-ready:${JSON.stringify(row.content)}`);
  for (const job of failedTasks) alarmSet.add(`failed-child:${job.id}:${job.status}`);
  for (const row of forecast.rows) {
    if (!obligatedContent.has(row.content)) continue;
    if (row.overdue)
      alarmSet.add(`missed-eta:${JSON.stringify(row.content)}:${row.estimateRevision}`);
    if (row.latestStart !== undefined && now >= row.latestStart)
      alarmSet.add(`late-start:${JSON.stringify(row.content)}:${row.latestStart}`);
    if (row.stale)
      alarmSet.add(
        `stale-estimate:${JSON.stringify(row.content)}:${row.estimateUpdatedAt ?? null}`,
      );
  }
  const missed = forecast.rows.filter((row) => openContent.has(row.content) && row.overdue);
  const executableMissed = forecast.rows.filter(
    (row) => actionableReadyContents.has(row.content) && row.ready && row.overdue &&
      typeof row.resourceStart === "number" && row.resourceStart <= now,
  );
  const overdueMinute = Math.floor(now / 60_000);
  if (executableMissed.length > 0) alarmSet.add(`overdue-todo-minute:${overdueMinute}`);
  if (
    deadline &&
    open.length > 0 &&
    forecast.earliestFinish !== undefined &&
    forecast.earliestFinish > deadline.deadlineAt
  ) {
    alarmSet.add(`deadline-risk-cpm:${deadline.deadlineAt}`);
  }
  if (
    deadline &&
    open.length > 0 &&
    forecast.resourceFinish !== undefined &&
    forecast.resourceFinish > deadline.deadlineAt
  ) {
    alarmSet.add(`deadline-risk-resource:${deadline.deadlineAt}`);
  }
  if (deadline && forecast.knownWorkFinish !== undefined && forecast.knownWorkFinish > deadline.deadlineAt)
    alarmSet.add(`deadline-risk-known-work:${deadline.deadlineAt}`);
  if (deadline && open.length > 0 && now >= deadline.deadlineAt)
    alarmSet.add(`deadline-overdue:${deadline.deadlineAt}`);
  const deadlineRisk = [...alarmSet].some((alarm) => alarm.startsWith("deadline-risk-") || alarm.startsWith("deadline-overdue:"));
  if (deadlineRisk && executableReady) alarmSet.add(`deadline-risk-minute:${overdueMinute}`);
  const alarms = [...alarmSet].sort();
  // Evidence-only edits and redraws must not wake again for the same estimate revision.
  const alarmRevision = phases.flatMap((phase) =>
    phase.tasks.map((task) => [
      task.content,
      task.status,
      task.schedule?.estimateRevision ?? task.schedule?.estimate?.updatedAt ?? null,
      task.schedule?.dependencies,
      task.schedule?.owner,
      task.schedule?.resources,
      task.blocker ?? null,
    ]),
  );
  const planNeedsDiagnosis = planningIssues.length > 0 || blocked.length > 0;
  const rawWakeKey =
    taskEnabled && deadline !== undefined && !goalPaused &&
    (executableMissed.length > 0 || planNeedsDiagnosis || (alarms.length > 0 && executableReady))
      ? JSON.stringify([deadline, capacity ?? null, alarmRevision, alarms, readyFacts])
      : null;
  const wakeKey = rawWakeKey !== null && rawWakeKey !== lastWakeKey ? rawWakeKey : null;
  const planSummary = sdk.formatPlanForecast(forecast, now);
  const forecastIssues = forecast.issues
    .slice(0, MAX_ROWS)
    .map((issue) => `- ${JSON.stringify(issue)}`);
  if (forecast.issues.length > MAX_ROWS)
    forecastIssues.push(`- … ${forecast.issues.length - MAX_ROWS} more forecast issues`);
  const planningIssueLines = planningIssues
    .slice(0, MAX_ROWS)
    .map((issue) => `- [${issue.code}] ${JSON.stringify(shorten(issue.task))}: ${issue.message}`);
  if (planningIssues.length > MAX_ROWS)
    planningIssueLines.push(`- … ${planningIssues.length - MAX_ROWS} more canonical planning issues`);
  const corrections = missed
    .slice(0, MAX_ROWS)
    .map((row) => `- ${JSON.stringify(shorten(row.content))}: revision=${row.estimateRevision}; reestimates=${row.reestimateCount}`);
  const prompt = [
    ...(!goalPaused && deadlineRisk
      ? ["DELIVERY FIRST: the fixed deadline is at risk. Name the exact missing user-visible artifact and its current version; take the shortest safe action that creates or updates it now. Do not re-read the same plan, reforecast, or rerun broad checks without a changed artifact or a specific new diagnostic question. Reconcile workers only to unblock real work; report the remaining gap without moving the deadline or silently shrinking scope. No automatic paid/model escalation."]
      : []),
    staticPrompt,
    `Now=${displayClock(now)}; ETA anchored to recorded estimates/real starts, not redraw time.`,
    `Whole-plan CPM/resource/P95: ${planSummary}. Shared predecessors and resource assumptions bound confidence; this is not an optimum.`,
    `Planning issues (${planningIssues.length}):`,
    ...(planningIssueLines.length ? planningIssueLines : ["- none"]),
    `Forecast issues (${forecast.issues.length}):`,
    ...(forecastIssues.length ? forecastIssues : ["- none"]),
    `Nonclosed row timing (${forecastRows.length}/${obligated.length}; CPM ES/EF/LS/LF, float, resource, PERT):`,
    ...(forecastLines.length ? forecastLines : ["- none"]),
    `Missing estimates (${missing.length}): ${missing.length ? missing.slice(0, MAX_ROWS).map((content) => JSON.stringify(shorten(content))).join(", ") : "none"}; stale (${stale.length}): ${stale.length ? stale.slice(0, MAX_ROWS).map((content) => JSON.stringify(shorten(content))).join(", ") : "none"}`,
    `Ready rows needing distinct live workers (${ownerlessReady.length}/${readyCandidates.length}): ${ownerlessReady.length ? ownerlessReady.slice(0, MAX_ROWS).map((row) => `${JSON.stringify(shorten(row.content))} [${row.ownership}; owner=${JSON.stringify(row.owner)}]`).join(", ") : "none"}`,
    `Dependency-waiting rows (${dependencyUnready.length}; do not dispatch): ${dependencyUnready.length ? dependencyUnready.slice(0, MAX_ROWS).map((row) => `${JSON.stringify(shorten(row.content))}${row.awaitingPrerequisite ? ` [awaiting ${JSON.stringify(shorten(row.awaitingPrerequisite))}]` : ""}`).join(", ") : "none"}`,
    `Dispatch: ${dispatchDirective}`,
    `Alarm facts: ${alarms.length ? alarms.join("; ") : "none"}`,
    ...(corrections.length ? ["MISSED ETA: inspect exact worker/artifact and failed assumption, then schedule evidence-based remaining O/L/P with a falsifiable checkpoint; reestimation does not erase prior misses.", ...corrections] : []),
    "Do not infer staffing from labels or close TODOs from lifecycle/estimates. Verify exact live IDs; preserve user queue/pause and approval gates. Resolve blocked prerequisites safely, split only independently executable work, and retain all parent criteria.",
  ].join("\n");
  return {
    key,
    staticPrompt,
    prompt,
    forecast,
    alarms,
    rawWakeKey,
    wakeKey,
    nextCheckMs:
      !taskEnabled || deadline === undefined || goalPaused
        ? null
        : Math.min(
            nextCheckDelay(forecast, now, deadline.deadlineAt),
            executableMissed.length > 0
              ? Math.max(1, Math.min(MAX_IDLE_RECHECK_MS, (overdueMinute + 1) * 60_000 - now))
              : MAX_IDLE_RECHECK_MS,
          ),
    todoOwnerIds: phases.flatMap((phase) =>
      phase.tasks.flatMap((task) => typeof task.schedule?.owner === "string" ? [task.schedule.owner] : []),
    ),
    ownerRunStates,
    openStructure: phases.flatMap((phase) =>
      phase.tasks
        .filter((task) => task.status === "pending" || task.status === "in_progress")
        .map((task) => [task.content, (task.schedule?.dependencies ?? []).map(String)] as [string, string[]]),
    ),
    readyCandidates,
    deadline,
    dispatchableReady,
    capacity,
    activeTaskCount: activeTaskJobs.length + activeRestoredTaskIds.size,
    staffingSnapshotComplete,
    taskEnabled,
    goalPaused,
  };

}
export default async function todoDispatch(pi: ExtensionAPI): Promise<void> {
  const host = pi.pi;
  const hostSdk = host as DispatchForecastApi | undefined;
  // The host engine module is the fallback for hosts whose extension SDK predates forecast exports.
  const sourceFallback = hostSdk?.forecastTodoPlan ? undefined : forecastFallback;
  const sdk = {
    forecastTodoPlan: hostSdk?.forecastTodoPlan ?? sourceFallback!.forecastTodoPlan,
    formatPlanForecast: hostSdk?.formatPlanForecast ?? sourceFallback!.formatPlanForecast,
    formatTaskForecast: hostSdk?.formatTaskForecast ?? sourceFallback!.formatTaskForecast,
    getTodoPlanningIssues:
      hostSdk?.getTodoPlanningIssues ?? sourceFallback?.getTodoPlanningIssues,
    readGoalDeadline: hostSdk?.readGoalDeadline ?? readGoalDeadline,
    getLatestTodoPhasesFromEntries: host.getLatestTodoPhasesFromEntries,
  };
  // The pause switch is host-owned. Never import a second module instance of its singleton.
  const pauseGate = host?.agentPauseGate;
  // Legacy hosts can render advice, but cannot safely schedule autonomous wakes until upgraded.
  let cachedStatic: { key: string; text: string } | null = null;
  let cachedDecision: { key: string; decision: DispatchDecision } | null = null;
  let lastWakeKey: string | null = null;
  let persistedChildren: PersistedChild[] = [];
  let sprintState: SprintState = blankSprintState();
  let persistedSprintStateJson = JSON.stringify(sprintState);
  let dispatchGateBaseline: Map<string, string> | null = null;
  const taskCallBaselines = new Map<string, Map<string, string>>();
  // Names of dispatched retro-facilitator workers: an async facilitator settles through `wait`, and
  // the job snapshot carries no agent type, so the dispatch input is the only place to learn it.
  const retroFacilitatorJobs = new Set<string>();
  let pendingTaskReconciliation: {
    baseline: Map<string, string>;
    workers: Array<{ id: string; agentId?: string }>;
    unknown: boolean;
    turnEnded: boolean;
    // Provider requests seen since the task result, and whether the model was told to link workers.
    // A goal run rarely reaches agent_end, so waiting for the turn to end silenced dispatch for hours.
    checks: number;
    linkDemanded: boolean;
    linkAnswered: boolean;
  } | null = null;
  let pendingIdleResumeOwner: string | null = null;
  const idleResumeAttempts = new Set<string>();
  const workerCompactionCursors = new Map<string, WorkerCompactionCursor>();
  const workerSizingNoticed = new Set<string>();
  let pendingSizingNoticeIds: string[] = [];
  let idleTimer: Timer | null = null;
  let timerContext: ExtensionContext | null = null;
  const clearIdleTimer = () => {
    if (idleTimer && timerContext) timerContext.clearTimer(idleTimer);
    idleTimer = null;
    timerContext = null;
  };
  const reset = () => {
    clearIdleTimer();
    cachedStatic = null;
    cachedDecision = null;
    lastWakeKey = null;
    dispatchGateBaseline = null;
    pendingTaskReconciliation = null;
    pendingIdleResumeOwner = null;
    idleResumeAttempts.clear();
    workerCompactionCursors.clear();
    workerSizingNoticed.clear();
    pendingSizingNoticeIds = [];
    pendingReplan = null;
  };
  const persistSprintState = () => {
    const json = JSON.stringify(sprintState);
    if (json === persistedSprintStateJson) return;
    persistedSprintStateJson = json;
    pi.appendEntry(SPRINT_STATE_ENTRY_TYPE, sprintState);
  };
  const addSeenRow = (content: string) => {
    if (sprintState.seenRows.includes(content)) return;
    sprintState = { ...sprintState, seenRows: [...sprintState.seenRows, content] };
  };
  const setRetroDue = (reason: string, meta: { deadlineAt?: number; deliveryKey?: string } = {}) => {
    if (sprintState.retroDueReason) return;
    sprintState = {
      ...sprintState,
      retroDueReason: reason,
      correctionPending: reason === "user correction" ? false : sprintState.correctionPending,
      ...(meta.deadlineAt === undefined ? { retroDueDeadlineAt: undefined } : { retroDueDeadlineAt: meta.deadlineAt }),
      ...(meta.deliveryKey === undefined ? { retroDueDeliveryKey: undefined } : { retroDueDeliveryKey: meta.deliveryKey }),
    };
  };
  const touchSprintState = (ctx: ExtensionContext, phases: TodoScheduleInput, jobs: Jobs | null, now: number, deadline: DispatchInput["deadline"]) => {
    const tasks = phases.flatMap((phase) => phase.tasks);
    const open = tasks.filter((task) => isOpenRowStatus(task.status));
    const nonClosed = tasks.filter((task) => isNonClosedRowStatus(task.status));
    const previousHadOpen = Object.values(sprintState.rowStatuses).some(isNonClosedRowStatus);
    const nextStatuses = Object.fromEntries(tasks.map((task) => [task.content, task.status]));
    for (const task of tasks) {
      const previous = sprintState.rowStatuses[task.content];
      if ((previous === "completed" || previous === "abandoned") && isNonClosedRowStatus(task.status) && !sprintState.reopenedRows.includes(task.content)) {
        sprintState = { ...sprintState, reopenedRows: [...sprintState.reopenedRows, task.content] };
      }
    }
    for (const task of open) {
      if (task.status === "in_progress" && typeof task.schedule?.owner === "string") addSeenRow(task.content);
      const taskJobs = [...(jobs?.running ?? []), ...(jobs?.recent ?? [])].filter((job) => job.type === "task");
      if (taskJobs.some((job) => typeof job.label === "string" && job.label.includes(task.content))) addSeenRow(task.content);
    }
    let facilitatorSettled = false;
    for (const job of jobs?.recent ?? []) {
      if (job.type !== "task" || !["completed", "failed", "cancelled"].includes(job.status)) continue;
      if (sprintState.seenJobIds.includes(job.id)) continue;
      const id = job.agentId ?? job.id;
      const at = typeof job.startTime === "number" ? job.startTime : now;
      const facilitator = [job.agentId, job.label, job.id].some((name) => typeof name === "string" && retroFacilitatorJobs.has(name));
      if (facilitator && job.status === "completed") facilitatorSettled = true;
      // Only a worker that finished is a retro participant: a cancelled one did no work, and a
      // failed one is usually a provider refusal (429/402), which would make a quota outage itself
      // look like a sprint worth a retrospective.
      sprintState = {
        ...sprintState,
        seenJobIds: [...sprintState.seenJobIds, job.id],
        ...(job.status !== "completed" || facilitator
          ? {}
          : { workerFinishes: [...sprintState.workerFinishes, { jobId: job.id, id, at, row: typeof job.label === "string" ? job.label : "" }] }),
      };
    }
    if (facilitatorSettled) finishRetro();
    if (open.length > 0 && sprintState.goalWorkStartedAt === null) {
      // Only finishes since the last retro start the next goal-work window; older ones were covered.
      const sinceRetro = sprintState.workerFinishes.filter((finish) => sprintState.lastRetroAt === null || finish.at >= sprintState.lastRetroAt);
      const knownWorkerAt = sinceRetro.length ? Math.min(...sinceRetro.map((finish) => finish.at)) : now;
      sprintState = { ...sprintState, goalWorkStartedAt: Math.min(now, knownWorkerAt) };
    }
    if (sprintState.correctionPending) setRetroDue("user correction");
    if (sprintState.reopenedRows.length >= 3) setRetroDue("3 reopened rows");
    if (
      deadline &&
      nonClosed.length > 0 &&
      now >= deadline.deadlineAt &&
      sprintState.handledDeadlineAt !== deadline.deadlineAt
    )
      setRetroDue("deadline passed", { deadlineAt: deadline.deadlineAt });
    const deliveryKey = nonClosed.length === 0 && tasks.length > 0 ? rowDeliveryKey(tasks) : undefined;
    if (
      previousHadOpen &&
      deliveryKey &&
      sprintState.handledDeliveryKey !== deliveryKey
    )
      setRetroDue("goal delivered", { deliveryKey });
    const retroStart = sprintState.lastRetroAt ?? sprintState.goalWorkStartedAt;
    if (open.length > 0 && retroStart !== null && now - retroStart >= 3 * 60 * 60_000)
      setRetroDue("3h goal work");
    sprintState = { ...sprintState, rowStatuses: nextStatuses };
    persistSprintState();
  };
  const finishRetro = () => {
    const handledDeadlineAt = sprintState.retroDueReason === "deadline passed" ? sprintState.retroDueDeadlineAt : sprintState.handledDeadlineAt;
    const handledDeliveryKey = sprintState.retroDueReason === "goal delivered" ? sprintState.retroDueDeliveryKey : sprintState.handledDeliveryKey;
    sprintState = {
      ...sprintState,
      lastRetroAt: Date.now(),
      goalWorkStartedAt: null,
      correctionPending: false,
      retroDueReason: null,
      retroDueDeadlineAt: undefined,
      retroDueDeliveryKey: undefined,
      retroDueNotifiedKey: undefined,
      reopenedRows: [],
      ...(handledDeadlineAt === undefined ? {} : { handledDeadlineAt }),
      ...(handledDeliveryKey === undefined ? {} : { handledDeliveryKey }),
    };
    persistSprintState();
  };
  const persistRoster = (ctx: ExtensionContext) => {
    const jobs = ctx.getAsyncJobSnapshot();
    if (jobs === null) return;
    const next = mergePersistedChildren(persistedChildren, jobs);
    if (JSON.stringify(next) === JSON.stringify(persistedChildren)) return;
    persistedChildren = next;
    pi.appendEntry(ROSTER_ENTRY_TYPE, { version: 1, children: next });
  };
  let armPlanTicker: (ctx: ExtensionContext) => void = () => {};
  let disarmPlanTicker = () => {};
  let writeCurrentPlanSnapshot: (ctx: ExtensionContext, decision: ReturnType<typeof decideTodoDispatch>, now: number) => void = () => {};
  const load = (ctx: ExtensionContext) => {
    reset();
    persistedChildren = readPersistedChildren(ctx.sessionManager.getBranch());
    sprintState = readPersistedSprintState(ctx.sessionManager.getBranch());
    persistedSprintStateJson = JSON.stringify(sprintState);
    armPlanTicker(ctx);
  };
  pi.on("session_start", (_event, ctx) => load(ctx));
  pi.on("session_switch", (_event, ctx) => load(ctx));
  pi.on("session_branch", (_event, ctx) => load(ctx));
  pi.on("session_tree", (_event, ctx) => load(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    persistRoster(ctx);
    persistSprintState();
    reset();
    disarmPlanTicker();
  });
  pi.on("agent_start", clearIdleTimer);

  const currentDecision = (ctx: ExtensionContext, now = Date.now(), pending: unknown[] = [], refreshSnapshot = false) => {
    // `pending`: entries not yet on the branch, such as the todo result a tool_result hook is amending.
    const branch = pending.length ? [...ctx.sessionManager.getBranch(), ...pending] : ctx.sessionManager.getBranch();
    const header = ctx.sessionManager.getHeader();
    const goalPaused = lifecycleGoal(branch, [])?.status === "paused";
    const deadline = sdk.readGoalDeadline(branch, ctx.cwd, { includePaused: true });
    const taskMaxConcurrency = ctx.getTaskMaxConcurrency?.();
    const capacity =
      typeof taskMaxConcurrency === "number" &&
      Number.isFinite(taskMaxConcurrency) &&
      Number.isInteger(taskMaxConcurrency) &&
      taskMaxConcurrency >= 0
        ? taskMaxConcurrency
        : undefined;
    const jobs = ctx.getAsyncJobSnapshot();
    const phases = sdk.getLatestTodoPhasesFromEntries(branch);
    const restored = restoredChildren(persistedChildren, jobs);
    const key = `${staticKey(phases, jobs, deadline, capacity, goalPaused, restored, persistedChildren)}:${Math.floor(now / 60_000)}`;
    if (pending.length === 0 && cachedDecision?.key === key) {
      if (refreshSnapshot) writeCurrentPlanSnapshot(ctx, cachedDecision.decision, now);
      return cachedDecision.decision;
    }
    const decision = decideTodoDispatch(
      {
        phases,
        jobs,
        persistedChildren,
        restoredChildren: restored,
        isMainSession: header !== null && !header.parentSession,
        capacity,
        taskEnabled: pi.getActiveTools().includes("task"),
        now,
        deadline,
        goalPaused,
        dispatchGateAvailable: nativeGateRegistered,
        lastWakeKey,
        cachedStatic,
        idleResumeAttempts,
      },
      sdk,
    );
    cachedStatic = decision.key && decision.staticPrompt ? { key: decision.key, text: decision.staticPrompt } : null;
    if (pending.length === 0 && decision.key) cachedDecision = { key, decision };
    writeCurrentPlanSnapshot(ctx, decision, now);
    return decision;
  };
  // A worker whose row is on the critical path gets /fast; the harness sets it from the plan, not
  // the model (user 2026-09-24: "If a worker's task is on the critical path, it gets /fast").
  // Needs omp's ctx.setSubagentFastMode (fork PR #8); older builds skip this silently.
  const fastByWorker = new Map<string, boolean>();
  const syncCriticalFast = (ctx: ExtensionContext, decision: ReturnType<typeof currentDecision>) => {
    const setFast = (ctx as { setSubagentFastMode?: (id: string, enabled: boolean) => unknown }).setSubagentFastMode;
    if (typeof setFast !== "function" || !decision.forecast) return;
    const running = ctx.getAsyncJobSnapshot()?.running.filter((job) => job.type === "task" && job.status === "running") ?? [];
    const want = new Map<string, boolean>();
    for (const row of decision.forecast.rows ?? []) {
      if (row.status !== "in_progress" && row.status !== "pending") continue;
      if (typeof row.owner !== "string") continue;
      const job = running.find((active) => active.id === row.owner || active.agentId === row.owner);
      if (!job) continue;
      const id = job.agentId || job.id;
      want.set(id, (want.get(id) ?? false) || row.critical === true);
    }
    for (const [id, enabled] of want) {
      if (fastByWorker.get(id) === enabled) continue;
      try {
        setFast.call(ctx, id, enabled);
        fastByWorker.set(id, enabled);
      } catch {
        // Not our child or already gone: leave it; the next request retries if it is still listed.
      }
    }
    for (const id of [...fastByWorker.keys()]) if (!want.has(id)) fastByWorker.delete(id);
  };
  // `wait` with nothing launched only burns the deadline: a dev server or an idle peer is not a
  // worker whose result will arrive. A plan that parks its backlog behind one worker is a bad plan,
  // not a reason to wait: refuse and send the model back to replanning.
  // Replan demands. Closing rows, starting rows or adding dependencies is not a replan: only new
  // rows (decomposition) or dropped dependencies answer a demand. At most MAX_REPLAN_DEMANDS forced
  // todo turns per episode, so an honest chain cannot trap the model in a todo loop.
  type Structure = Array<[string, string[]]>;
  let pendingReplan: { structure: Structure; demands: number; answered: number; ignored: boolean; doctorAsked?: boolean } | null = null;
  const MAX_REPLAN_DEMANDS = 5;
  const PLAN_DOCTOR_COOLDOWN_MS = 60 * 60_000;
  let lastPlanDoctorAt = -Infinity;
  const unlockedSince = (before: Structure, after: Structure) => {
    const old = new Map(before.map(([content, deps]) => [content, new Set(deps)]));
    return after.some(([content, deps]) => {
      const prior = old.get(content);
      if (!prior) return true;
      return deps.length < prior.size && deps.every((dep) => prior.has(dep));
    });
  };
  let lateWaitRefusalKey: string | null = null;
  // The machine can run about one worker per CPU (capped by the Task limit when one is set). While
  // open rows sit idle and fewer workers run than that, the plan must find parallel work; only a
  // backlog beyond capacity may be postponed.
  const workerCapacity = (ctx: ExtensionContext) => {
    const cap = ctx.getTaskMaxConcurrency?.() ?? 0;
    // Same rule as omp task/worker-capacity (not imported: an extension must load on an omp built before that module).
    return cap > 0 ? Math.min(cap, availableParallelism()) : availableParallelism();
  };
  const understaffed = (ctx: ExtensionContext, runningTasks: number, parked: number) =>
    parked >= 2 && runningTasks < workerCapacity(ctx);
  const blockIdleWait = (ctx: ExtensionContext) => {
    if (pauseGate?.paused) return;
    const jobs = ctx.getAsyncJobSnapshot();
    if (!jobs) return;
    const running = jobs.running.filter((job) => job.status === "running");
    const runningTasks = running.filter((job) => job.type === "task");
    const liveAgents = (jobs.nonJobAgents ?? []).filter((agent) => agent.live);
    const idle = running.length === 0 && liveAgents.length === 0;
    const decision = currentDecision(ctx);
    if (!decision.key || !decision.forecast) return;
    const rows = decision.forecast.rows ?? [];
    const readyRows = decision.dispatchableReady ?? [];
    const ready = readyRows.map((row) => {
      const ownerState = row.ownership === "shared-live-owner"
        ? "running for another row, not separately staffed"
        : row.owner === null ? "unassigned" : "not running";
      return `${JSON.stringify(shorten(row.content))} [owner=${JSON.stringify(row.owner)}; ${ownerState}]`;
    });
    const overdue = decision.alarms?.some((alarm) => alarm.startsWith("deadline-overdue:") || alarm.startsWith("overdue-todo-minute:"));
    const late = overdue || decision.alarms?.some((alarm) => alarm.startsWith("deadline-risk-"));
    const open = rows.filter((row) => row.status === "pending" || row.status === "in_progress");
    // One next action, naming the exact tool. Seen live: "write the rows into the todo plan" sent the
    // model to edit a backlog file in the repo, and "start workers … replan …" in one breath gave it two orders at once.
    const next = ready.length
      ? `Ready rows needing a distinct running worker: ${ready.slice(0, MAX_TASK_DISPATCH).join(", ")}. If a running worker already does one of these rows but differs from its recorded owner, set that row's schedule.owner via todo schedule to that worker; otherwise start one worker for the row (skill://chief-of-staff).`
      : replanInstruction(ctx, open, workerCapacity(ctx));
    if (idle) {
      return {
        block: true,
        reason: [
          "Stop waiting: nothing is running, so nothing will arrive.",
          overdue ? "You are past the deadline." : undefined,
          next,
        ].filter(Boolean).join(" "),
      };
    }
    // Something is running. Main waiting on a few workers while the backlog sits idle is a bad plan
    // whether or not the deadline has slipped yet: rows chained behind the running work = replan.
    const parked = open.length - runningTasks.length;
    const shortfall = runningTasks.length > 0 && understaffed(ctx, runningTasks.length, parked);
    if (runningTasks.length === 0 || (ready.length === 0 && !shortfall)) {
      lateWaitRefusalKey = null;
      return;
    }
    // The first refusal records the lead's answer for this exact revision. Repeating it only burns
    // CPU and turns an advisory gate into a 61-message loop; a changed revision earns one new answer.
    if (lateWaitRefusalKey === decision.key) return;
    lateWaitRefusalKey = decision.key;
    return {
      block: true,
      reason: [
        ready.length > 0 && !shortfall
          ? `Stop waiting: ready work lacks a distinct running worker${overdue ? ", and you are past the deadline" : late ? ", and you are about to miss the deadline" : ""}.`
          : `Stop waiting: ${runningTasks.length} of ${workerCapacity(ctx)} possible worker(s) run while ${parked} open row(s) sit idle${overdue ? ", and you are past the deadline" : late ? ", and you are about to miss the deadline" : ""}.`,
        next,
        activityLine(ctx, runningTasks),
      ].filter(Boolean).join(" "),
    };
  };
  // Chief of staff: the main session plans, dispatches and integrates. While worker slots are free
  // and rows sit idle, it does not run tests, builds or edits itself; those go to workers. Quick
  // read-only looks (read, grep, find, git status/log/show/diff, ls) stay allowed for integration.
  // Seen live 2026-09-24: lint, unit, browser, visual, performance and capture gates of one merge
  // candidate were chained one after another, so the ETA was their sum instead of the longest one.
  // One idempotent runbook instead of per-case orders: every gate and refusal states the measured
  // situation and points here (user 2026-09-25: "одну идемпотентную доку … её в любой ситуации тыкай").
  const PLAN_CHECK_CLEAN = "PLAN CHECK: no problems.";
  const PLAN_TICK_MS = 60_000;
  const PLAN_REPEAT_MS = 10 * 60_000;
  const ORDER = "Put things in order: run the pass of skill://chief-of-staff now (read it first if it is not in your context).";
  const PARALLEL_GATES = "Checks of the same candidate (lint, unit, build, browser, visual, accessibility, performance, video capture) depend on that candidate only, never on each other: give each its own row that depends on the candidate row, run them side by side, and split a long suite into shards on separate workers. Resolving a merge is one row and one worker for all conflicted files; commit it the moment no path is unresolved, and run the checks on that commit.";
  // Enough rows already (parked >= free slots): adding more only grows the idle pile (live 00:40:
  // 173 rows, 65 idle, the chief kept appending). Then the replan prunes and unchains instead.
  const pruneInstruction = (parked: number, capacity: number) =>
    `The plan holds ${parked} idle rows, more than the ${capacity} worker slots. ${ORDER}`;
  // Waiting critical rows go out as a list, one per line with what each waits on, and each needs its
  // own answer: as one run-on sentence the chief waved all of them off at once with "every row
  // genuinely consumes unfinished output" (live 2026-09-25 06:50, user: "там надо списком").
  // The list is the one chain that sets the ETA (the finishing row's fixed path), and each link says
  // what it is: a dependency, or a queue on a resource both rows hold. Mixing dependency-only
  // criticality with the resource-aware chain listed all three E2E shards as critical and shard three
  // "waiting on" shard one, which was a shared browser slot the chief had assigned (live 2026-09-25,
  // user: "шард 3 зависит от 1 - это дичь").
  const criticalChainLines = (ctx: ExtensionContext, rows: TodoTaskForecast[], mode: "chief" | "snapshot" = "chief") => {
    const finish = (row: TodoTaskForecast) => row.fixedPathP95Finish ?? row.resourceFinish ?? Number.NEGATIVE_INFINITY;
    const last = rows.reduce<TodoTaskForecast | undefined>((best, row) => (best === undefined || finish(row) > finish(best) ? row : best), undefined);
    const chain = last?.fixedPath?.length ? last.fixedPath : undefined;
    const byContent = new Map(rows.map((row) => [row.content, row]));
    const schedule = new Map<string, { dependencies: string[]; resources: string[] }>();
    try {
      for (const phase of sdk.getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch()))
        for (const task of phase.tasks)
          schedule.set(task.content, { dependencies: task.schedule?.dependencies ?? [], resources: task.schedule?.resources ?? [] });
    } catch {}
    const link = (content: string, previous: string | undefined) => {
      if (!previous) return "";
      const own = schedule.get(content);
      if (!own || own.dependencies.includes(previous))
        return mode === "snapshot"
          ? ` (consumes output from ${JSON.stringify(shorten(previous))})`
          : ` (waits on ${JSON.stringify(shorten(previous))})`;
      const shared = own.resources.filter((resource) => schedule.get(previous)?.resources.includes(resource));
      return shared.length
        ? mode === "snapshot"
          ? ` (queued behind ${JSON.stringify(shorten(previous))}: both hold shared resource ${shared.map((resource) => JSON.stringify(resource)).join(", ")}; not a dependency)`
          : ` (queued behind ${JSON.stringify(shorten(previous))}: both hold resource ${shared.map((resource) => JSON.stringify(resource)).join(", ")}; not a dependency)`
        : mode === "snapshot"
          ? ` (after ${JSON.stringify(shorten(previous))}: link type unknown)`
          : ` (after ${JSON.stringify(shorten(previous))})`;
    };
    if (!chain)
      return rows
        .filter((row) => row.critical && row.status === "pending")
        .sort((a, b) => (a.earliestStart ?? 0) - (b.earliestStart ?? 0))
        .slice(0, 12)
        .map((row) => `\n- ${JSON.stringify(shorten(row.content))}${link(row.content, row.awaitingPrerequisite ?? row.fixedPath?.at(-2))}`)
        .join("");
    return chain
      .map((content, index) => ({ content, previous: chain[index - 1], row: byContent.get(content) }))
      .filter((item) => item.row?.status === "pending")
      .slice(0, 12)
      .map((item) => `\n- ${JSON.stringify(shorten(item.content))}${link(item.content, item.previous)}`)
      .join("");
  };
  const criticalWaitList = (ctx: ExtensionContext, rows: TodoTaskForecast[]) => criticalChainLines(ctx, rows, "chief");
  const finishSamples: Array<{ at: number; finish: number }> = [];
  const DRIFT_WINDOW_MS = 45 * 60_000;
  let finishSession: string | undefined;
  let recedingSince: number | undefined;
  const planFinish = (list: TodoTaskForecast[]) =>
    Math.max(
      ...list
        .filter((row) => row.status === "pending" || row.status === "in_progress")
        .map((row) => row.fixedPathP95Finish ?? row.resourceFinish ?? Number.NEGATIVE_INFINITY),
    );
  const recordFinishSample = (ctx: ExtensionContext, open: TodoTaskForecast[], now: number) => {
    const session = ctx.sessionManager.getHeader()?.id;
    if (session !== finishSession) { finishSamples.length = 0; finishSession = session; recedingSince = undefined; }
    const finish = planFinish(open);
    if (!Number.isFinite(finish)) return null;
    const last = finishSamples.at(-1);
    if (!last || now - last.at >= 5 * 60_000) finishSamples.push({ at: now, finish });
    while (finishSamples.length && now - finishSamples[0]!.at > 3 * DRIFT_WINDOW_MS) finishSamples.shift();
    return finish;
  };
  const planSnapshotPaths = (ctx: ExtensionContext) => {
    const dir = join(homedir(), ".local", "state", "omp-todo-dispatch", "plan");
    const session = ctx.sessionManager.getHeader()?.id ?? "unknown";
    return {
      dir,
      byCwd: join(dir, `${cwdSnapshotSlug(ctx.cwd)}.md`),
      bySession: join(dir, `${session.replace(/[\\/]/g, "-")}.md`),
    };
  };
  const workerReceiptPath = (ctx: ExtensionContext, id: string) => {
    const file = ctx.sessionManager.getSessionFile?.();
    return file ? join(file.replace(/\.jsonl$/, ""), `${id}.jsonl`) : "unknown";
  };
  writeCurrentPlanSnapshot = (ctx, decision, now) => {
    if (!decision.key || !decision.forecast || !isMain(ctx)) return;
    const rows = decision.forecast.rows ?? [];
    const open = rows.filter((row) => row.status === "pending" || row.status === "in_progress");
    const currentFinish = recordFinishSample(ctx, open, now);
    const phaseRows = sdk.getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch())
      .flatMap((phase) => phase.tasks.map((task) => [task.content, task] as const));
    const taskByContent = new Map(phaseRows);
    const runByContent = new Map((decision.ownerRunStates ?? []).map((row) => [row.content, row]));
    const jobs = ctx.getAsyncJobSnapshot();
    const receipts = (jobs?.recent ?? [])
      .filter((job) => job.type === "task")
      .slice(-12)
      .map((job) => {
        const id = job.agentId ?? job.id;
        return `| ${markdownCell(id)} | ${markdownCell(job.status)} | ${markdownCell(workerReceiptPath(ctx, id))} |`;
      });
    const { byCwd, bySession, dir } = planSnapshotPaths(ctx);
    const rowLines = open.map((row) => {
      const task = taskByContent.get(row.content);
      const estimate = task?.schedule?.estimate;
      const olp = estimate
        ? `${estimate.optimisticSeconds}/${estimate.likelySeconds}/${estimate.pessimisticSeconds}s`
        : "missing";
      const deps = task?.schedule?.dependencies?.length ? task.schedule.dependencies.join(", ") : "[]";
      const owner = typeof row.owner === "string" ? row.owner : typeof task?.schedule?.owner === "string" ? task.schedule.owner : "";
      const runs = runByContent.get(row.content)?.running ? "yes" : "no";
      const resources = task?.schedule?.resources?.length ? task.schedule.resources.join(", ") : "[]";
      const p95 = safeTimestamp(row.fixedPathP95Finish ?? row.resourceFinish);
      const critical = row.criticalityKnown === false ? "unknown" : row.critical ? "yes" : "no";
      return `| ${markdownCell(row.content)} | ${row.status} | ${olp} | ${markdownCell(deps)} | ${markdownCell(owner)} | ${runs} | ${markdownCell(resources)} | ${p95} | ${critical} |`;
    });
    const sampleLines = finishSamples.length
      ? finishSamples.map((sample) => `- ${safeTimestamp(sample.at)} -> ${safeTimestamp(sample.finish)}`)
      : ["- none"];
    const text = [
      "# OMP Plan Snapshot",
      "",
      "Read by plan-doctor first. This file is written by tools/omp/todo_dispatch.ts from the dispatcher forecast.",
      `Snapshot paths: ${byCwd} and ${bySession}`,
      "CWD slug rule: absolute cwd, replace every non [A-Za-z0-9._-] with -, collapse repeated -, trim leading/trailing -, take first 120 chars, fallback cwd",
      `Written: ${safeTimestamp(now)}`,
      `CWD: ${ctx.cwd}`,
      `Session: ${ctx.sessionManager.getHeader()?.id ?? "unknown"}`,
      "",
      "## Goal And Deadline",
      `Goal: ${decision.deadline?.goalId ?? "none"}`,
      `Deadline: ${decision.deadline ? safeTimestamp(decision.deadline.deadlineAt) : "none"}`,
      "",
      "## ETA",
      `Current ETA/P95 finish: ${currentFinish === null ? "unknown" : safeTimestamp(currentFinish)}`,
      "Recent ETA samples:",
      ...sampleLines,
      "",
      "## Open Rows",
      "| title | status | O/L/P | deps | owner | runs | resources | P95 finish | critical |",
      "|---|---|---:|---|---|---|---|---|---|",
      ...(rowLines.length ? rowLines : ["| none | | | | | | | | |"]),
      "",
      "## ETA Chain",
      criticalChainLines(ctx, open, "snapshot") || "- no pending ETA chain",
      "",
      "## Last Worker Receipts",
      "| id | outcome | path |",
      "|---|---|---|",
      ...(receipts.length ? receipts : ["| none | | |"]),
      "",
    ].join("\n");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(byCwd, text);
      writeFileSync(bySession, text);
    } catch {}
  };
  // Any row on the chain shortens it when split, not only the next one (user 2026-09-25: "сплитать
  // то что на критическом пути - не обязательно ближайшее декомпозировать").
  // A link often records contention, not consumption: rows chained because they would share one
  // checkout, browser or port (user 2026-09-25: "ну так блядь выдели им разные чекауты-ворктри??",
  // after the chief serialized a click fix and an audit on one checkout).
  const WHY_EACH_LINK = "For each link ask why the row waits. If it consumes the other row's output, the link is real. If the two rows only use the same thing (the checkout, a browser, a port, a test database, and so on), that thing is the contended resource: give each row its own copy and drop the link. For the checkout, a small edit to files nobody else touches (a config value, one function, …) goes into it live, and overlapping edits get isolated: true, a worktree whose branch is rebased, merged and pushed as soon as its row finishes.";
  const SPLIT_EACH = "Every row in this chain moves the finish when split, not only the next one; the last rows of a chain (documentation, verification, delivery, …) usually hold the most work that can be prepared now. For each row name the part that can be done now without that result (fixtures, the check that will verify it, drafted text, reading the target, and so on), append it as its own row and dispatch it; a row with no such part gets one line saying why";
  // user 2026-09-25 on three E2E shards split over two "browser slots": "чего он как будто у нас
  // браузеров мало, запусти больше браузеров и не еби мозг".
  const RESOURCE_QUEUE = "A resource queue on this chain is a limit you set, not one the machine has: anything that can be started, copied or allocated again (browsers, ports, worktrees, databases, …) is not scarce here. Give the queued row its own copy and remove the shared resource. Keep a shared resource only for a thing that physically exists once, and prove that by a measurement, not an assumption.";
  const replanInstruction = (ctx: ExtensionContext, open: TodoTaskForecast[], capacity: number) => {
    const list = criticalWaitList(ctx, open);
    return list
      ? `Idle rows are chained behind the running work, with ${capacity} worker slots. Waiting is not the step here. Waiting rows on the chain that sets the ETA, in order:${list}\n${list.includes("queued behind") ? `${RESOURCE_QUEUE}\n` : ""}${WHY_EACH_LINK}\n${SPLIT_EACH} (skill step 7). ${ORDER}`
      : `Idle rows are chained behind the running work, with ${capacity} worker slots. Waiting is not the step here: split the waiting rows into the part that needs the running result and the part that can start now, and dispatch that part (skill step 7). ${ORDER}`;
  };
  const CHIEF_OF_STAFF = `ROLE: You are the chief of staff for this session, not a worker; your runbook is skill://chief-of-staff. ${ORDER}`;
  const READ_ONLY_BASH = /^\s*(git\s+(status|log|show|diff|rev-parse|branch|remote|ls-files|ls-remote|merge-base)\b|grep\b|rg\b|ls\b|cat\b|head\b|tail\b|wc\b|pwd\b|echo\b|stat\b|test\b|\[\s|sha256sum\b|sha1sum\b|md5sum\b|readlink\b|realpath\b|file\b)/;
  // Git mutation (add, commit, push, merge) is the git-pr-owner worker's job, never the chief's
  // (user 2026-09-25: "чего чиф оф стафф гит дрочит, у него же писарь есть и гитарь?").
  // A chain is read-only only when every part is: `cat x && bun test` is not.
  const isChiefBash = (command: string) =>
    command.split(/&&|\|\||;|\|/).every((part) => !part.trim() || READ_ONLY_BASH.test(part));
  const WRITE_EXEMPT_PATH = /^(agent|xd|proc|history|artifact):\/\//;
  let chiefRefusals = 0;
  const MAX_CHIEF_REFUSALS = 3;
  const isMain = (ctx: ExtensionContext) => {
    const header = ctx.sessionManager.getHeader();
    return header !== null && !header.parentSession;
  };
  // Work a worker should do: shell that is neither a quick look nor commit/push, file edits, eval.
  // Messages to workers (write agent://…), reads, todo, task and complaints are the chief's own job.
  const isWorkerWork = (toolName: string, rawInput: unknown) => {
    const input = (rawInput ?? {}) as { command?: unknown; path?: unknown; file_path?: unknown };
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
    return (toolName === "bash" && !(typeof input.command === "string" && isChiefBash(input.command))) ||
      ((toolName === "edit" || toolName === "write") && !(path !== undefined && WRITE_EXEMPT_PATH.test(path))) ||
      toolName === "eval";
  };
  const rerouteSettledWorkerWrite = (event: { toolName: string; input?: unknown }, ctx: ExtensionContext) => {
    if (event.toolName !== "write" || !isMain(ctx)) return;
    const input = (event.input ?? {}) as { path?: unknown; content?: unknown };
    if (typeof input.path !== "string" || !input.path.startsWith("agent://")) return;
    const addressed = input.path.slice("agent://".length).split(/[/?#]/)[0];
    if (!addressed) return;
    const jobs = ctx.getAsyncJobSnapshot();
    if (!jobs) return;
    if (jobs.running.some((job) => job.id === addressed || job.agentId === addressed)) return;
    const settled = jobs.recent.find((job) =>
      job.type === "task" &&
      (job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
      (job.id === addressed || job.agentId === addressed)
    );
    if (!settled) return;
    const phases = sdk.getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch());
    const row = phases
      .flatMap((phase) => phase.tasks)
      .find((task) =>
        task.content === settled.label &&
        typeof task.schedule?.owner === "string" &&
        task.schedule.owner !== addressed &&
        jobs.running.some((job) => job.id === task.schedule?.owner || job.agentId === task.schedule?.owner)
      );
    const currentOwner = typeof row?.schedule?.owner === "string" ? row.schedule.owner : undefined;
    if (!row || !currentOwner) return;
    const content = typeof input.content === "string" ? input.content : JSON.stringify(input.content ?? "");
    void sendWorkerSteering(ctx, currentOwner, content).then((result) => {
      if (!result.delivered) reportWorkerSteeringFailure(ctx, currentOwner, result, "redirect failed; chief must write agent://" + currentOwner + " manually");
    });
    return {
      block: true,
      reason: `${addressed} is settled; row ${JSON.stringify(shorten(row.content))} current live owner is ${currentOwner}; redirect requested.`,
    };
  };
  const blockWorkerWork = (event: { toolName: string; input?: unknown }, ctx: ExtensionContext) => {
    if (pauseGate?.paused || !isMain(ctx) || !pi.getActiveTools().includes("task")) return;
    const input = (event.input ?? {}) as { command?: unknown; path?: unknown };
    if (!isWorkerWork(event.toolName, event.input)) return;
    const decision = currentDecision(ctx);
    if (!decision.key || !decision.forecast || decision.goalPaused || !decision.staffingSnapshotComplete) return;
    const jobs = ctx.getAsyncJobSnapshot();
    const runningTasks = (jobs?.running ?? []).filter((job) => job.type === "task" && job.status === "running").length;
    const open = (decision.forecast.rows ?? []).filter((row) => row.status === "pending" || row.status === "in_progress");
    const parked = open.length - runningTasks;
    if (!understaffed(ctx, runningTasks, parked)) return;
    if (chiefRefusals >= MAX_CHIEF_REFUSALS) return; // it insists three times in a row: let it through
    chiefRefusals += 1;
    gateTrace(ctx, `chief-refused-${event.toolName}`, { runningTasks, parked });
    const ready = (decision.dispatchableReady ?? []).map((row) => JSON.stringify(shorten(row.content)));
    return {
      block: true,
      reason: [
        `You are chief of staff: ${runningTasks} of ${workerCapacity(ctx)} possible workers run while ${parked} open row(s) sit idle, so do not run ${event.toolName} work yourself.`,
        ready.length ? `Ready rows without a worker: ${ready.slice(0, MAX_TASK_DISPATCH).join(", ")}.` : undefined,
        ORDER,
        "Read-only looks (read, grep, find, git status/log/show/diff) stay allowed.",
        // Seen live 2026-09-25: the chief ran pgrep on its stalled git worker's hook, which is the worker's job.
        "A worker that seems stuck is asked, not investigated by you: read its history://<id> tail, write agent://<id> asking what it waits on, and if it cannot answer send a scout or give its row to a new worker.",
      ].filter(Boolean).join(" "),
    };
  };
  const isExistingOwnerName = (ctx: ExtensionContext, name: string) => {
    try {
      return sdk.getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch())
        .some((phase) => phase.tasks.some((task) => task.schedule?.owner === name));
    } catch {
      return false;
    }
  };
  const refusePlanningFailureWorkerName = (event: { toolName: string; input?: unknown }, ctx: ExtensionContext) => {
    if (event.toolName !== "task" || !isMain(ctx)) return;
    for (const item of taskItems(event.input)) {
      if (typeof item.name !== "string" || isExistingOwnerName(ctx, item.name)) continue;
      const word = planningFailureWorkerWord(item.name);
      if (!word) continue;
      const group = /^V\d+$/.test(word) ? "V" : word;
      gateTrace(ctx, "planning-failure-worker-name-refused", { name: item.name, word });
      return {
        block: true,
        reason: `Worker name ${JSON.stringify(item.name)} contains planning-failure word ${JSON.stringify(word)}. ${WORKER_NAME_ACTION[group] ?? WORKER_NAME_ACTION.Owner} (skill step 8: ${WORKER_NAME_GUIDANCE[group] ?? WORKER_NAME_GUIDANCE.Owner}).`,
      };
    }
  };
  const refuseConcurrentGitPrOwner = (event: { toolName: string; input?: unknown }, ctx: ExtensionContext) => {
    if (event.toolName !== "task" || !isMain(ctx)) return;
    const gitItems = taskItems(event.input).filter(isGitPrOwnerItem);
    if (!gitItems.length) return;
    const phases = sdk.getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch());
    const taskByOwner = new Map<string, TaskRow>();
    for (const phase of phases)
      for (const task of phase.tasks)
        if (typeof task.schedule?.owner === "string") taskByOwner.set(task.schedule.owner, task);
    const running = (ctx.getAsyncJobSnapshot()?.running ?? [])
      .filter((job) => job.type === "task" && job.status === "running")
      .flatMap((job) => {
        const candidate = job as typeof job & { agent?: unknown; agentProfile?: unknown; profile?: unknown };
        if (!isLikelyGitPrOwnerJob(candidate)) return [];
        const owner = job.agentId ?? job.id;
        const row = taskByOwner.get(owner) ?? taskByOwner.get(job.id);
        const key = row ? checkoutKeyFromResources(row.schedule?.resources, ctx.cwd) : checkoutKeyFromTaskItem({ name: owner, task: job.label ?? "" }, ctx.cwd);
        return [{ owner, key }];
      });
    const claimed = new Map<string, string>();
    for (const item of gitItems) {
      const key = checkoutKeyFromTaskItem(item, ctx.cwd);
      const conflict = running.find((worker) => worker.key === key);
      if (conflict) {
        gateTrace(ctx, "git-pr-owner-checkout-refused", { checkout: displayCheckoutKey(key), running: conflict.owner });
        return {
          block: true,
          reason: `checkout ${displayCheckoutKey(key)} already has live git-pr-owner ${conflict.owner}; do not start a second git-pr-owner on the same checkout. Use a different worktree for parallel git ownership, or wait for the running one.`,
        };
      }
      const previous = claimed.get(key);
      if (previous) {
        gateTrace(ctx, "git-pr-owner-batch-checkout-refused", { checkout: displayCheckoutKey(key), first: previous, second: item.name });
        return {
          block: true,
          reason: `checkout ${displayCheckoutKey(key)} is targeted by multiple git-pr-owner task items in this batch (${previous}, ${String(item.name ?? "unnamed")}); one checkout gets one git-pr-owner.`,
        };
      }
      claimed.set(key, String(item.name ?? "unnamed"));
    }
  };
  // The backlog parked behind the running work with nothing dispatchable is a planning defect. Make
  // the next model choice a todo rewrite, before any other tool, instead of hoping for a wait call.
  // Why the replan gate stayed silent, one line per change of reason, so a live session can be
  // diagnosed from ~/.local/state/omp-todo-dispatch/<session>.gate.jsonl without a debugger.
  let lastGateReason = "";
  const gateTrace = (ctx: ExtensionContext, reason: string, detail: Record<string, unknown> = {}) => {
    if (reason === lastGateReason) return;
    lastGateReason = reason;
    try {
      const dir = join(homedir(), ".local", "state", "omp-todo-dispatch");
      mkdirSync(dir, { recursive: true });
      const session = ctx.sessionManager?.getHeader?.()?.id ?? "unknown";
      appendFileSync(join(dir, `${session}.gate.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, reason, ...detail })}\n`);
    } catch {}
  };
  const replanRequirement = (ctx: ExtensionContext, decision: ReturnType<typeof currentDecision>, now: number) => {
    if (!decision.key || !decision.forecast) return gateTrace(ctx, "no-plan");
    if (!decision.staffingSnapshotComplete) return gateTrace(ctx, "staffing-snapshot-incomplete");
    if (decision.goalPaused) return gateTrace(ctx, "goal-paused");
    if (!pi.getActiveTools().includes("todo")) return gateTrace(ctx, "todo-tool-inactive");
    const jobs = ctx.getAsyncJobSnapshot();
    const runningTasks = (jobs?.running ?? []).filter((job) => job.type === "task" && job.status === "running").length;
    const open = (decision.forecast.rows ?? []).filter((row) => row.status === "pending" || row.status === "in_progress");
    const parked = open.length - runningTasks;
    // Starting every ready row must still fill the free slots; one ready row beside 19 chained ones
    // (seen live: 0 of 20 running) is a chain to split, not a staffed plan.
    const dispatchable = (decision.dispatchableReady ?? []).length;
    const fillable = Math.min(workerCapacity(ctx), open.length);
    // Staffing ready rows comes before any replan: a replan demand is met by a todo call, which let
    // the chief append rows while two ready rows sat without a worker.
    if (!understaffed(ctx, runningTasks, parked) || dispatchable > 0 || runningTasks + dispatchable >= fillable || parked - dispatchable < 2) {
      pendingReplan = null;
      return gateTrace(ctx, "staffed-or-dispatchable", { dispatchable, runningTasks, parked, capacity: workerCapacity(ctx) });
    }
    const structure = decision.openStructure ?? [];
    if (!pendingReplan) {
      pendingReplan = { structure, demands: 1, answered: 0, ignored: false };
    } else if (pendingReplan.answered >= pendingReplan.demands) {
      // todo was called for the current demand: judge what it changed, then demand again if still chained.
      if (pendingReplan.demands >= MAX_REPLAN_DEMANDS) {
        // Five forced rewrites did not unchain the plan: hand it to the plan-doctor profile once.
        // It runs on a strong (partly per-token) model, so at most once an hour per session.
        if (pendingReplan.doctorAsked || now - lastPlanDoctorAt < PLAN_DOCTOR_COOLDOWN_MS)
          return gateTrace(ctx, "demands-exhausted", { runningTasks, parked });
        pendingReplan.doctorAsked = true;
        lastPlanDoctorAt = now;
        gateTrace(ctx, "plan-doctor-demand", { runningTasks, parked });
        return {
          soft: true as const,
          id: `todo-plan-doctor:${decision.key}`,
          toolName: "task",
          satisfies: (toolCall: { name: string; arguments?: unknown }) =>
            toolCall.name === "task" && containsExactString(toolCall.arguments, "plan-doctor"),
          reminder: [{
            role: "developer" as const,
            content: `PLAN DOCTOR: ${MAX_REPLAN_DEMANDS} replans left ${runningTasks} of ${workerCapacity(ctx)} workers running while ${parked} rows sit idle; the runbook's last resort (task with agent "plan-doctor") applies. ${ORDER}`,
            timestamp: now,
          }],
        };
      }
      pendingReplan.ignored = !unlockedSince(pendingReplan.structure, structure);
      pendingReplan.structure = structure;
      pendingReplan.demands += 1;
    }
    const ignored = pendingReplan.ignored;
    gateTrace(ctx, `demand-${pendingReplan.demands}`, { runningTasks, parked, ignored });
    const overdue = decision.alarms?.some((alarm) => alarm.startsWith("deadline-overdue:") || alarm.startsWith("overdue-todo-minute:"));
    return {
      soft: true as const,
      id: `todo-replan:${decision.key}:${pendingReplan.demands}`,
      toolName: "todo",
      // Staffing a planned row also raises the running count; a replan demand must not skip it
      // (seen live: a git-pr-owner commit worker for a planned row was skipped twice).
      satisfies: (toolCall: { name: string; arguments?: unknown }) =>
        toolCall.name === "todo" ||
        (toolCall.name === "task" && open.some((row) => JSON.stringify(toolCall.arguments ?? {}).includes(JSON.stringify(row.content).slice(1, -1)))),
      reminder: [{
        role: "developer" as const,
        content: [
          `MANDATORY REPLAN: ${runningTasks} of ${workerCapacity(ctx)} possible worker(s) run while ${parked} open row(s) sit idle${overdue ? " and you are past the deadline" : ""}.`,
          ignored ? "Your last todo call did not make any row ready; that is not a replan." : undefined,
          `${parked >= workerCapacity(ctx) ? pruneInstruction(parked, workerCapacity(ctx)) : replanInstruction(ctx, open, workerCapacity(ctx))}`,
        ].filter(Boolean).join(" "),
        timestamp: now,
      }],
    };
  };
  let userInputs = 0;
  let userInputsSeen = 0;
  pi.on("input", (event) => {
    if (event.source !== "extension") userInputs += 1;
    if (isCorrectionInput(event)) sprintState = { ...sprintState, correctionPending: true };
  });
  let gitStateCache: { cwd: string; at: number; state: GitIntegrationState | null } | null = null;
  const lastChiefHead = new Map<string, string>();
  const gitState = (ctx: ExtensionContext, now: number, force = false) => {
    if (force || !gitStateCache || gitStateCache.cwd !== ctx.cwd || now - gitStateCache.at > 15_000)
      gitStateCache = { cwd: ctx.cwd, at: now, state: readGitIntegrationState(ctx.cwd, now) };
    return gitStateCache.state;
  };
  const resolvedMerge = (state: GitIntegrationState | null) =>
    state?.mergeHead !== undefined && state.unmerged === 0 && (state.mergeAgeMs ?? 0) >= STALE_MERGE_MS ? state : null;
  const integrationRequirement = (ctx: ExtensionContext, goalActive: boolean, now: number) => {
    const state = gitState(ctx, now);
    const merge = resolvedMerge(state);
    if (merge) {
      const minutes = Math.round((merge.mergeAgeMs ?? 0) / 60_000);
      gateTrace(ctx, "merge-commit-demand", { mergeHead: merge.mergeHead, minutes });
      return {
        soft: true as const,
        id: `todo-merge-commit:${merge.mergeHead}`,
        toolName: "task" as const,
        satisfies: (toolCall: { name: string; arguments?: Record<string, unknown> }) =>
          (toolCall.name === "bash" && typeof toolCall.arguments?.command === "string" && GIT_COMMIT.test(toolCall.arguments.command)) ||
          (toolCall.name === "task" && /\bcommit/i.test(JSON.stringify(toolCall.arguments ?? {}))),
        reminder: [{
          role: "developer" as const,
          content: `MERGE READY: the merge of ${merge.mergeHead} has been open for ${minutes} minutes with no unresolved paths. ${ORDER}`,
          timestamp: now,
        }],
      };
    }
    if (goalActive && state && !state.mergeHead && (state.unpushed ?? 0) > 0 && (state.oldestUnpushedAgeMs ?? 0) >= STALE_PUSH_MS) {
      const minutes = Math.round((state.oldestUnpushedAgeMs ?? 0) / 60_000);
      gateTrace(ctx, "push-demand", { unpushed: state.unpushed, minutes });
      return {
        soft: true as const,
        id: `todo-push:${state.head}`,
        toolName: "task" as const,
        satisfies: (toolCall: { name: string; arguments?: Record<string, unknown> }) =>
          (toolCall.name === "bash" && typeof toolCall.arguments?.command === "string" && GIT_PUSH.test(toolCall.arguments.command)) ||
          (toolCall.name === "task" && /\bpush/i.test(JSON.stringify(toolCall.arguments ?? {}))),
        reminder: [{
          role: "developer" as const,
          content: `UNPUSHED WORK: ${state.unpushed} commit(s) on this branch, the oldest ${minutes} minutes old, exist only in this checkout. ${ORDER}`,
          timestamp: now,
        }],
      };
    }
    return null;
  };
  // What a lead with the whole history would notice and a model after a context rollover cannot:
  // how long git work has been left open and how many merge workers this session already spent.
  // A worker's own session file (<session dir>/<worker>.jsonl) is written on every step, so its
  // mtime is the worker's last activity. The chief learns who went silent from here instead of
  // reading every worker's history tail (live 2026-09-25: 56 of 150 chief calls were history reads).
  const SILENT_MS = 15 * 60_000;
  const LIKELY_GRACE_MS = 5 * 60_000;
  const workerActivity = (
    ctx: ExtensionContext,
    running: Array<{ id: string; agentId?: string; startTime?: number }>,
    now: number,
  ) => {
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    const dir = sessionFile?.replace(/\.jsonl$/, "");
    return running.map(job => {
      const name = job.agentId ?? job.id;
      let lastAt: number | undefined;
      let path: string | undefined;
      let size: number | undefined;
      if (dir)
        for (const candidate of new Set([job.agentId, job.id].filter((x): x is string => !!x))) {
          try {
            const candidatePath = join(dir, `${candidate}.jsonl`);
            const stat = statSync(candidatePath);
            if (lastAt === undefined || stat.mtimeMs > lastAt) {
              lastAt = stat.mtimeMs;
              path = candidatePath;
              size = stat.size;
            }
          } catch {}
        }
      const since = lastAt ?? job.startTime;
      return {
        name,
        lastAt,
        ageMs: since === undefined ? undefined : now - since,
        known: dir !== undefined,
        path,
        size,
      };
    });
  };
  const workerSessionPath = (ctx: ExtensionContext, id: string) => {
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    const dir = sessionFile?.replace(/\.jsonl$/, "");
    return dir ? join(dir, `${id}.jsonl`) : null;
  };
  // Read each child's appended session events once, including a preexisting compaction on first observation.
  const workerCompactionAt = (worker: { name: string; path?: string; size?: number }): number | undefined => {
    if (!worker.path || worker.size === undefined) return undefined;
    let cursor = workerCompactionCursors.get(worker.name);
    if (!cursor || cursor.path !== worker.path || cursor.offset > worker.size) {
      cursor = { path: worker.path, offset: 0, pending: "", buffer: Buffer.allocUnsafe(64 * 1024) };
      workerCompactionCursors.set(worker.name, cursor);
    }
    if (cursor.offset === worker.size) return cursor.at;
    let fd: number | undefined;
    try {
      fd = openSync(worker.path, "r");
      while (cursor.offset < worker.size) {
        const count = readSync(
          fd,
          cursor.buffer,
          0,
          Math.min(cursor.buffer.length, worker.size - cursor.offset),
          cursor.offset,
        );
        if (count <= 0) break;
        cursor.offset += count;
        let start = 0;
        for (let index = 0; index < count; index++) {
          if (cursor.buffer[index] !== 10) continue;
          const line = cursor.pending + cursor.buffer.toString("utf8", start, index);
          cursor.pending = "";
          start = index + 1;
          if (!line.includes("compaction")) continue;
          try {
            const entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
            if (entry.type !== "compaction" || typeof entry.timestamp !== "string") continue;
            const at = Date.parse(entry.timestamp);
            if (Number.isFinite(at)) cursor.at = at;
          } catch {}
        }
        if (start < count) cursor.pending += cursor.buffer.toString("utf8", start, count);
      }
    } catch {
      workerCompactionCursors.delete(worker.name);
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return cursor.at;
  };
  const readTail = (path: string, max = 256 * 1024) => {
    const stat = statSync(path);
    const size = Math.min(max, stat.size);
    const buffer = Buffer.alloc(size);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf8");
  };
  const toolTarget = (toolName: string, args: Record<string, unknown>) => {
    const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
    if (path) return path;
    if (toolName === "bash" && typeof args.command === "string") return shorten(args.command, 80);
    if (typeof args.pattern === "string") return shorten(args.pattern, 80);
    return "";
  };
  const pathsFromGitAdd = (command: string) => {
    const match = command.match(/\bgit\s+add\s+(?:--\s+)?(.+)$/);
    if (!match) return [];
    return match[1]!
      .split(/\s+/)
      .filter((path) => path && !path.startsWith("-") && !path.includes("="));
  };
  const isWritablePath = (path: string) => !/^[a-z]+:\/\//i.test(path);
  const workerTrace = (ctx: ExtensionContext, id: string) => {
    const path = workerSessionPath(ctx, id);
    if (!path) return { lastTool: "none", wrote: [] as string[] };
    const wrote: string[] = [];
    let lastTool = "none";
    const rememberPath = (candidate: unknown) => {
      if (typeof candidate !== "string" || !isWritablePath(candidate)) return;
      if (!wrote.includes(candidate)) wrote.push(candidate);
    };
    const observeTool = (name: unknown, rawArgs: unknown) => {
      if (typeof name !== "string") return;
      const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
      const target = toolTarget(name, args);
      lastTool = target ? `${name} ${target}` : name;
      if (name === "edit" || name === "write") rememberPath(args.path ?? args.file_path);
      if (name === "bash" && typeof args.command === "string")
        for (const file of pathsFromGitAdd(args.command)) rememberPath(file);
    };
    try {
      for (const line of readTail(path).split("\n")) {
        if (!line.trim()) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        if (typeof entry !== "object" || entry === null) continue;
        const custom = entry as { customType?: unknown; data?: unknown };
        if (custom.customType === "tool_execution_start" && custom.data && typeof custom.data === "object") {
          const data = custom.data as { toolName?: unknown; args?: unknown };
          observeTool(data.toolName, data.args);
        }
        const message = (entry as { message?: unknown }).message;
        if (!message || typeof message !== "object") continue;
        const msg = message as { role?: unknown; toolName?: unknown; content?: unknown };
        if (msg.role === "toolResult") observeTool(msg.toolName, {});
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          if (typeof part !== "object" || part === null) continue;
          const item = part as { type?: unknown; name?: unknown; arguments?: unknown };
          if (item.type === "toolCall") observeTool(item.name, item.arguments);
        }
      }
    } catch {}
    return { lastTool, wrote: wrote.slice(-4) };
  };
  const silentWorkers = (activity: ReturnType<typeof workerActivity>) =>
    activity.filter((worker) => worker.known && worker.ageMs !== undefined && worker.ageMs >= SILENT_MS);
  const minutes = (ms: number | undefined) => `${Math.round((ms ?? 0) / 60_000)} min`;
  const hhmm = (at: number) => {
    const date = new Date(at);
    return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  };
  const overdueWorkerEpisodes = new Map<string, string>();
  const workerOverlapEpisodes = new Set<string>();
  const missingWorkerMessageApi = "omp core exposes no worker-message API to extensions";
  const sendWorkerSteering = async (ctx: ExtensionContext, id: string, content: string): Promise<AgentMessageDelivery> => {
    const fn = (ctx as AgentMessageContext).sendAgentMessage;
    if (typeof fn !== "function") return { delivered: false, text: missingWorkerMessageApi };
    try {
      const result = await fn.call(ctx, id, content);
      return {
        delivered: result?.delivered === true,
        text: typeof result?.text === "string" && result.text ? result.text : (result?.delivered ? "Message delivered." : "Message delivery failed."),
      };
    } catch (error) {
      return { delivered: false, text: error instanceof Error ? error.message : String(error) };
    }
  };
  const reportWorkerSteeringFailure = (ctx: ExtensionContext, id: string, result: AgentMessageDelivery, fallback: string) => {
    gateTrace(ctx, "worker-message-undelivered", { id, text: result.text });
    pi.sendMessage(
      {
        customType: "todo-worker-message-undelivered",
        content: `PLAN CHECK: overdue check-in not delivered to ${id}: ${result.text}; ${fallback}.`,
        display: false,
        attribution: "agent",
      },
      { deliverAs: "aside" },
    );
  };
  const overdueWorkerCheckins = (
    ctx: ExtensionContext,
    open: TodoTaskForecast[],
    running: Array<{ id: string; agentId?: string; startTime?: number }>,
    activity: ReturnType<typeof workerActivity>,
    now: number,
  ) => {
    const activityByName = new Map(activity.map((worker) => [worker.name, worker]));
    return running.flatMap((job) => {
      const id = job.agentId ?? job.id;
      const row = open.find((candidate) => candidate.owner === job.id || candidate.owner === job.agentId);
      const p95 = row?.fixedPathP95Finish ?? (
        typeof row?.expectedResourceFinish === "number" ? row.expectedResourceFinish + LIKELY_GRACE_MS : row?.resourceFinish
      );
      if (!row || typeof p95 !== "number" || !Number.isFinite(p95) || now < p95) {
        overdueWorkerEpisodes.delete(id);
        return [];
      }
      const episode = `${row.content}\0${p95}`;
      const alreadyAsked = overdueWorkerEpisodes.get(id) === episode;
      const activityText = activityByName.get(id)?.ageMs !== undefined
        ? `last activity ${minutes(activityByName.get(id)!.ageMs)} ago`
        : "last activity unknown";
      if (alreadyAsked)
        return [{ id, row: row.content, sent: true, repeated: true, activityText }];
      const content = `your row ${shorten(row.content)} is past its P95 at ${hhmm(p95)}; reply with current artifact/path, first failing proof, or what you wait on`;
      const canSend = typeof (ctx as AgentMessageContext).sendAgentMessage === "function";
      if (canSend) {
        void sendWorkerSteering(ctx, id, content).then((result) => {
          if (!result.delivered) reportWorkerSteeringFailure(ctx, id, result, `chief must write agent://${id} manually`);
        });
      }
      overdueWorkerEpisodes.set(id, episode);
      return [{ id, row: row.content, sent: canSend, repeated: false, activityText, text: canSend ? undefined : missingWorkerMessageApi }];
    });
  };
  // Told with every refused wait, so a refused wait does not turn into reading worker histories.
  const activityLine = (ctx: ExtensionContext, running: Array<{ id: string; agentId?: string; startTime?: number }>) => {
    const activity = workerActivity(ctx, running, Date.now()).filter((worker) => worker.lastAt !== undefined);
    return activity.length
      ? `Worker activity (their session files): ${activity.slice(0, 8).map((worker) => `${worker.name} ${minutes(worker.ageMs)} ago`).join(", ")}. Reading a worker's history is not this step: results arrive by themselves, and PLAN CHECK names a worker once it is silent for ${minutes(SILENT_MS)}.`
      : "";
  };
  const integrationFacts = (ctx: ExtensionContext, now: number) => {
    const state = gitState(ctx, now, true);
    const lines: string[] = [];
    const sessionId = ctx.sessionManager.getHeader?.()?.id ?? "unknown";
    const headKey = `${ctx.cwd}\0${sessionId}`;
    const previousHead = lastChiefHead.get(headKey);
    if (state?.head) {
      if (previousHead && previousHead !== state.head) {
        const commits = readGitLogSince(ctx.cwd, previousHead);
        if (commits.length)
          lines.push(`commits since previous chief turn (${commits.length}): ${commits.slice(0, 5).join(", ")}${commits.length > 5 ? `, … ${commits.length - 5} more` : ""}`);
      }
      lastChiefHead.set(headKey, state.head);
    }
    const runningGit = readRunningGitJobs(ctx.cwd);
    if (runningGit.length)
      lines.push(`running git job(s): ${runningGit.slice(0, 5).join(", ")}${runningGit.length > 5 ? `, … ${runningGit.length - 5} more` : ""}`);
    if (state?.mergeHead)
      lines.push(`merge of ${state.mergeHead} open for ${Math.round((state.mergeAgeMs ?? 0) / 60_000)} min, ${state.unmerged ?? "?"} unresolved path(s)${state.unmerged === 0 ? ": it needs only its commit (one git-pr-owner worker)" : ""}`);
    if ((state?.unpushed ?? 0) > 0)
      lines.push(`${state!.unpushed} commit(s) not pushed, the oldest ${Math.round((state!.oldestUnpushedAgeMs ?? 0) / 60_000)} min old`);
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (sessionFile && (state?.mergeHead || lines.length)) {
      try {
        const dir = sessionFile.replace(/\.jsonl$/, "");
        const workers = readdirSync(dir).filter((name) => name.endsWith(".jsonl") && MERGE_WORK.test(name));
        const recent = workers.filter((name) => now - statSync(join(dir, name)).mtimeMs < 24 * 3_600_000);
        if (workers.length) lines.push(`${workers.length} merge/conflict/rebase worker(s) spawned in this session, ${recent.length} active in the last 24 h`);
      } catch {}
    }
    return lines.length ? `GIT FACTS (measured now; your context may have lost the history): ${lines.join("; ")}.` : "";
  };
  let activeDemand: string | null = null;
  // Operator kill switch that needs no restart: touch ~/.local/state/omp-todo-dispatch/off (all
  // sessions) or <session-id>.off. Every demand and refusal of this extension stands down; the context
  // note (chief role, plan forecast, git facts) keeps coming because it cannot block anything.
  const gateSwitchedOff = (ctx: ExtensionContext) => {
    const dir = join(homedir(), ".local", "state", "omp-todo-dispatch");
    const session = ctx.sessionManager?.getHeader?.()?.id;
    try { statSync(join(dir, "off")); return true; } catch {}
    if (session) try { statSync(join(dir, `${session}.off`)); return true; } catch {}
    return false;
  };
  let nativeGateRegistered = false;
  const softRequirementApi = pi as unknown as SoftToolRequirementRegistrar;
  if (softRequirementApi.registerSoftToolRequirementProvider && pauseGate) {
    // The skipped-call text omp shows the model says only "the pending action"; the reminder
    // reaches just the forced request. Keep the live demand in every request's context instead.
    const demandProvider = (ctx: ExtensionContext) => {
      if (gateSwitchedOff(ctx)) return gateTrace(ctx, "switched-off");
      dispatchGateBaseline = null;
      pendingIdleResumeOwner = null;
      if (pauseGate.paused) return gateTrace(ctx, "pause-gate");
      // Yield only to a message the user typed since the last request. hasPendingMessages() also
      // counts worker results, IRC and reminders, which a busy goal session always has queued:
      // live after the 23:35 restart that kept every requirement off.
      const userQueued = ctx.hasPendingMessages() && userInputs > userInputsSeen;
      userInputsSeen = userInputs;
      if (userQueued) return gateTrace(ctx, "pending-user-message");
      const now = Date.now();
      const decision = currentDecision(ctx, now);
      if (isMain(ctx)) syncCriticalFast(ctx, decision);
      if (isMain(ctx)) {
        const integration = integrationRequirement(ctx, Boolean(decision.key) && !decision.goalPaused, now);
        if (integration) return integration;
      }
      const replan = replanRequirement(ctx, decision, now);
      if (replan) return replan;
      if (
        !decision.key ||
        !decision.forecast ||
        !decision.deadline ||
        decision.deadline.paused ||
        decision.goalPaused ||
        decision.capacity === undefined ||
        !decision.staffingSnapshotComplete
      )
        return gateTrace(ctx, "dispatch-no-schedule", {
          deadline: Boolean(decision.deadline), deadlinePaused: decision.deadline?.paused === true,
          goalPaused: decision.goalPaused === true, capacity: decision.capacity ?? null,
          snapshot: decision.staffingSnapshotComplete === true,
        });
      if (pendingTaskReconciliation) {
        const pending = pendingTaskReconciliation;
        pending.checks += 1;
        // One request after the task result is the model's chance to link; then the gate acts.
        const settled = pending.turnEnded || pending.checks >= 2;
        const jobs = ctx.getAsyncJobSnapshot();
        const taskJobs = [...(jobs?.recent ?? []), ...(jobs?.running ?? [])]
          .filter((job) => job.type === "task");
        const discovered = taskJobs
          .filter((job) => !pending.baseline.has(job.id) ||
            (pending.baseline.get(job.id) !== "running" && job.status === "running"))
          .map((job) => ({ id: job.id, ...(job.agentId ? { agentId: job.agentId } : {}) }));
        pending.workers = [...new Map(
          [...pending.workers, ...discovered].map((worker) => [worker.id, worker]),
        ).values()];
        pending.unknown = pending.workers.length === 0;
        if (pending.unknown) {
          if (!settled) return gateTrace(ctx, "dispatch-reconciling-unknown");
          pendingTaskReconciliation = null;
        } else {
          const owners = new Set(decision.todoOwnerIds ?? []);
          const activeWorkers = jobs?.running.filter(
            (job) => job.type === "task" && job.status === "running",
          ) ?? [];
          const unlinkedWorkers = pending.workers.filter(
            (worker) => !owners.has(worker.id) && (!worker.agentId || !owners.has(worker.agentId)),
          );
          const hasActiveUnlinkedWorker = unlinkedWorkers.some((worker) =>
            activeWorkers.some((job) =>
              job.id === worker.id || job.agentId === worker.id ||
              (worker.agentId !== undefined && (job.id === worker.agentId || job.agentId === worker.agentId)),
            ),
          );
          if (!settled) return gateTrace(ctx, "dispatch-reconciling");
          if (hasActiveUnlinkedWorker && !pending.linkAnswered) {
            // Ask once to write the new worker IDs into the rows they do, instead of going silent
            // while the worker runs. After one todo call the gate dispatches the remaining ready rows.
            pending.linkDemanded = true;
            const ids = unlinkedWorkers.map((worker) => worker.agentId ?? worker.id);
            gateTrace(ctx, "dispatch-link-demand", { ids });
            return {
              soft: true as const,
              id: `todo-link:${decision.key}:${ids.join(",")}`,
              toolName: "todo",
              reminder: [{
                role: "developer" as const,
                content: `LINK WORKERS: worker(s) ${ids.map((id) => JSON.stringify(id)).join(", ")} run but no todo row names them as owner. ${ORDER}`,
                timestamp: now,
              }],
            };
          }
          pendingTaskReconciliation = null;
        }
      }
      const dispatchable = decision.dispatchableReady ?? [];
      const available = decision.capacity === 0
        ? dispatchable.length
        : Math.max(0, decision.capacity - (decision.activeTaskCount ?? 0));
      if (available <= 0) return gateTrace(ctx, "dispatch-no-slot", { capacity: decision.capacity, active: decision.activeTaskCount ?? 0 });
      const idleResumeCandidate = dispatchable.find(
        (row) => row.ownership === "idle-live-owner" && row.owner !== null && !idleResumeAttempts.has(row.owner),
      );
      const eligible = dispatchable.filter(
        (row) => row.ownership !== "idle-live-owner" || row.owner === null || !idleResumeAttempts.has(row.owner),
      );
      const rows = idleResumeCandidate
        ? [idleResumeCandidate]
        : eligible.slice(0, Math.min(available, MAX_TASK_DISPATCH));
      if (rows.length === 0) return gateTrace(ctx, "dispatch-nothing-ready", { dispatchable: dispatchable.length });
      gateTrace(ctx, "dispatch-demand", { rows: rows.length });
      const idleResumeOwner = idleResumeCandidate?.owner ?? null;
      pendingIdleResumeOwner = idleResumeOwner;
      const rowList = rows.map((row) => JSON.stringify(row.content)).join(", ");
      const snapshot = ctx.getAsyncJobSnapshot();
      dispatchGateBaseline = new Map(
        [...(snapshot?.recent ?? []), ...(snapshot?.running ?? [])]
          .filter((job) => job.type === "task")
          .map((job) => [job.id, job.status]),
      );
      return {
        soft: true,
        id: `todo-dispatch:${decision.key}:${rowList}`,
        toolName: "task",
        // Any todo call passes: omp refuses task until every row has an estimate, which only todo can
        // set, so refusing todo here deadlocks (live 00:12: todo schedule skipped, task refused, loop).
        // The demand comes back on the next request if rows are still ready and idle.
        // A task call counts only when it staffs a planned row (its exact title appears in the call);
        // live 01:01 the chief answered 16 ready rows with one unplanned worker, again and again.
        satisfies: (toolCall) =>
          toolCall.name === "todo" ||
          (toolCall.name === "task" &&
            (idleResumeOwner
              ? containsExactString(toolCall.arguments, idleResumeOwner)
              // One planned row is enough: demanding a batch of three skipped a single git-pr-owner
              // worker three times and aborted the turn (live 01:3x). Batching is the runbook's job.
              : rows.some((row) =>
                  JSON.stringify(toolCall.arguments ?? {}).includes(JSON.stringify(row.content).slice(1, -1)) ||
                  (row.owner !== null && containsExactString(toolCall.arguments, row.owner))))),
        reminder: [{
          role: "developer",
          content: idleResumeOwner
            ? `MANDATORY TODO RESUME: row ${rowList} is owned by idle worker ${JSON.stringify(idleResumeOwner)}. Re-staff with a task item whose name is the owner and whose task is the row's exact title plus what to return. A bare agent:// message is not staffing. ${ORDER}`
            : `MANDATORY TODO DISPATCH: ${rows.length} ready row(s) have no running worker: ${rows.map((row) => `${JSON.stringify(row.content)}${row.owner ? ` (owner ${row.owner} is not running: name the item ${row.owner})` : ""}`).join(", ")}. Staff them in one task call, one item per row carrying the row's exact title. ${ORDER}`,
          timestamp: now,
        }],
      };
    };
    // Demands are advice, never enforcement. omp enforces a soft requirement by skipping every
    // other call, then allowing only the required tool, then aborting the turn after three forced
    // requests; each demand therefore cut the chief's other hands (live 2026-09-25: a replan demand
    // allowed only todo while the chief tried to staff workers). The demand text rides in every
    // request's context instead and the chief picks the tool.
    const adviseOnly = (ctx: ExtensionContext) => {
      const demand = demandProvider(ctx) as { reminder?: Array<{ content: string }> } | undefined | void;
      activeDemand = demand?.reminder?.[0]?.content ?? null;
      return undefined;
    };
    softRequirementApi.registerSoftToolRequirementProvider(Object.assign(adviseOnly, { demand: demandProvider }));
    nativeGateRegistered = true;
  }

  let pendingFinishDelay: {
    notice: string;
    allowedFinish: number;
    key: string | null;
    refusalKey: string | null;
    refusals: number;
  } | null = null;
  const MAX_FINISH_DELAY_REFUSALS = 3;
  const finishDelayRefusal = (toolName: string, ctx: ExtensionContext) => {
    if (!pendingFinishDelay || !isMain(ctx) || (toolName !== "task" && toolName !== "wait")) return;
    const decision = currentDecision(ctx);
    if (pendingFinishDelay.refusalKey !== decision.key) {
      pendingFinishDelay.refusalKey = decision.key;
      pendingFinishDelay.refusals = 0;
    }
    if (pendingFinishDelay.refusals >= MAX_FINISH_DELAY_REFUSALS) return;
    pendingFinishDelay.refusals += 1;
    gateTrace(ctx, "finish-delay-refused", { toolName, minutes: Math.round((Date.now() - pendingFinishDelay.allowedFinish) / 60_000) });
    return {
      block: true,
      reason: `${pendingFinishDelay.notice}. undo it, or say in your next todo call which user request the added work serves (evidence field)`,
    };
  };

  pi.on("before_subagent_spawn", (event, ctx) => {
    if (event.agent !== "plan-doctor") return;
    const decision = currentDecision(ctx, Date.now(), [], true);
    const paths = planSnapshotPaths(ctx);
    return decision.key
      ? { note: `plan snapshot refreshed: ${paths.byCwd}` }
      : { note: `plan snapshot unavailable: no current main-session plan` };
  });

  pi.on("tool_call", (event, ctx) => {
    if (gateSwitchedOff(ctx)) return;
    const badWorkerName = refusePlanningFailureWorkerName(event as { toolName: string; input?: unknown }, ctx);
    if (badWorkerName) return badWorkerName;
    const gitOwnerConflict = refuseConcurrentGitPrOwner(event as { toolName: string; input?: unknown }, ctx);
    if (gitOwnerConflict) return gitOwnerConflict;
    if (event.toolName === "task" && isPlanDoctorTaskInput(event.input)) currentDecision(ctx, Date.now(), [], true);
    if (event.toolName === "todo" && pendingFinishDelay && hasEvidenceField(event.input)) pendingFinishDelay = null;
    const finishDelay = finishDelayRefusal(event.toolName, ctx);
    if (finishDelay) return finishDelay;
    if (event.toolName === "wait") return blockIdleWait(ctx);
    if (event.toolName === "task") chiefRefusals = 0;
    const rerouted = rerouteSettledWorkerWrite(event as { toolName: string; input?: unknown }, ctx);
    if (rerouted) return rerouted;
    const chief = blockWorkerWork(event as { toolName: string; input?: unknown }, ctx);
    if (chief) return chief;
    if ((event.toolName === "task" || event.toolName === "todo") && isMain(ctx) && !pauseGate?.paused) {
      const text = JSON.stringify(event.input ?? {});
      const adds = event.toolName === "task" || /"op"\s*:\s*"(append|init)"/.test(text);
      // A worker told to commit (and push) the merge is the right move, not more merge work.
      const merge = adds && MERGE_WORK.test(text) && !/\bcommit/i.test(text) ? resolvedMerge(gitState(ctx, Date.now())) : null;
      const open = event.toolName === "task" && MERGE_WORK.test(text) ? gitState(ctx, Date.now()) : null;
      if (open?.mergeHead && !merge) {
        const items = ((event.input as { tasks?: unknown[] } | undefined)?.tasks ?? [event.input]).filter((item) => MERGE_WORK.test(JSON.stringify(item ?? {})));
        const running = (ctx.getAsyncJobSnapshot()?.running ?? []).filter((job) => job.type === "task" && job.status === "running" && MERGE_WORK.test(`${job.id} ${job.label ?? ""} ${job.agentId ?? ""}`));
        if (items.length > 1 || running.length > 0) {
          gateTrace(ctx, "merge-fanout-refused", { items: items.length, running: running.map((job) => job.id) });
          return {
            block: true,
            reason: running.length
              ? `Merge ${open.mergeHead} already has its worker (${running.map((job) => job.id).join(", ")}); one merge gets one worker. ${ORDER}`
              : `This batch splits merge ${open.mergeHead} across ${items.length} workers; one merge gets one worker. ${ORDER}`,
          };
        }
      }
      if (merge) {
        gateTrace(ctx, `merge-work-refused-${event.toolName}`, { mergeHead: merge.mergeHead });
        return {
          block: true,
          reason: `The merge of ${merge.mergeHead} has no unresolved paths; it needs a commit, not more merge work. ${ORDER}`,
        };
      }
    }
    if (event.toolName === "todo" && pendingReplan) pendingReplan.answered = pendingReplan.demands;
    if (event.toolName === "todo" && pendingTaskReconciliation?.linkDemanded) pendingTaskReconciliation.linkAnswered = true;
    if (event.toolName === "task")
      for (const item of taskItems(event.input))
        if (item.agent === "retro-facilitator" && typeof item.name === "string") retroFacilitatorJobs.add(item.name);
    if (event.toolName !== "task" || !dispatchGateBaseline) return;
    if (pendingIdleResumeOwner) idleResumeAttempts.add(pendingIdleResumeOwner);
    taskCallBaselines.set(event.toolCallId, new Map(dispatchGateBaseline));
  });
  // Every todo result ends with what is still wrong with the plan, so the chief sees the problems
  // where it looks instead of in a gate it may never hit (user 2026-09-25: "тулы выдавали
  // список ошибок в плане или хотя бы говорили что они там есть и напоминали как смотреть").
  // The finish that recedes with the clock: every attempt finds the next defect and each estimate
  // assumes the next attempt succeeds (live 2026-09-25: the ETA stayed "now + 2.5-3 h" from 05:23 to
  // 10:40 while eight fix rows were appended one at a time). Samples live for the session only.
  const recedingFinish = (ctx: ExtensionContext, open: TodoTaskForecast[], now: number): string => {
    const finish = recordFinishSample(ctx, open, now);
    if (finish === null) return "";
    const first = finishSamples[0];
    if (!first || now - first.at < DRIFT_WINDOW_MS) return "";
    // Receding: the finish moved later by at least 80% of the time that passed, so work is being
    // found about as fast as it is done.
    if (finish - first.finish < 0.8 * (now - first.at)) { recedingSince = undefined; return ""; }
    recedingSince ??= now;
    const history = finishSamples.filter((_, i, all) => i === 0 || i === all.length - 1 || i % 3 === 0).map((sample) => `${safeTimestamp(sample.at)} → ${safeTimestamp(sample.finish)}`).join(", ");
    // Twenty minutes after the first report the numbers have not changed the plan: a second look
    // with no execution duties decides, and the chief applies it (user 2026-09-25: "давай 1 2 3").
    if (now - recedingSince >= 20 * 60_000)
      return `the finish has receded with the clock for ${minutes(now - first.at)} and ${minutes(now - recedingSince)} after this was first reported (samples, now → finish: ${history}). Run \`task\` with agent \`plan-doctor\` now: give it the goal, these samples, the open rows with dependencies, owners and receipts, and ask one question: what makes the finish later and which plan change shortens it. Apply its plan in one \`todo\` call; do not add rows of your own before it answers`;
    return `the finish recedes with the clock: ${minutes(now - first.at)} ago it was ${safeTimestamp(first.finish)}, now ${safeTimestamp(finish)}. Work is being found as fast as it is done, one defect per attempt. Find all remaining defects in one pass (run the whole check once with failures collected instead of stopping at the first), fix them as parallel rows, and take every check that does not consume the stuck output off the chain`;
  };
  const planCheck = (ctx: ExtensionContext, pending: unknown[] = []): string | null => {
    pendingSizingNoticeIds = [];
    const now = Date.now();
    const decision = currentDecision(ctx, now, pending);
    const phasesNow = sdk.getLatestTodoPhasesFromEntries([...ctx.sessionManager.getBranch(), ...pending] as never);
    touchSprintState(ctx, phasesNow, ctx.getAsyncJobSnapshot(), now, decision.deadline);
    const retroAdvice = () => {
      if (!sprintState.retroDueReason) return "";
      const since = sprintState.lastRetroAt ?? sprintState.goalWorkStartedAt ?? now;
      const finishes = sprintState.workerFinishes.filter((finish) => sprintState.lastRetroAt === null || finish.at >= sprintState.lastRetroAt);
      const counts = new Map<string, { count: number; firstAt: number }>();
      for (const finish of finishes) {
        const previous = counts.get(finish.id);
        counts.set(finish.id, {
          count: (previous?.count ?? 0) + 1,
          firstAt: Math.min(previous?.firstAt ?? finish.at, finish.at),
        });
      }
      const workerIds = [...counts.entries()]
        .sort((left, right) => right[1].count - left[1].count || left[1].firstAt - right[1].firstAt || left[0].localeCompare(right[0]))
        .slice(0, 12)
        .map(([id]) => id);
      const notifyKey = `${sprintState.retroDueReason}|${sprintState.retroDueDeadlineAt ?? ""}|${sprintState.retroDueDeliveryKey ?? ""}|${workerIds.join(",")}`;
      if (sprintState.retroDueNotifiedKey === notifyKey) return "";
      sprintState = { ...sprintState, retroDueNotifiedKey: notifyKey };
      persistSprintState();
      return `retrospective due (${sprintState.retroDueReason}): ask the ${workerIds.length} workers who finished since ${safeTimestamp(since)} through agent://, then retro-facilitator (skill://chief-of-staff Retrospective): ${workerIds.join(", ") || "none"}`;
    };
    const retroLine = retroAdvice();
    if (!decision.forecast)
      return retroLine
        ? `PLAN CHECK: 1 problem(s). (1) ${retroLine}. Fix them with the pass of skill://chief-of-staff.`
        : null;
    const rows = decision.forecast.rows ?? [];
    const open = rows.filter((row) => row.status === "pending" || row.status === "in_progress");
    // A todo call is judged by the finish it produces (live 2026-09-25: 13:24 -> 13:44 while the
    // chief added workers, each correction inserting another serial row mid-chain).
    let laterBy = 0;
    let finishDelayNotice = "";
    let previousFinish = Number.POSITIVE_INFINITY;
    const currentFinish = planFinish(open);
    if (pendingFinishDelay && Number.isFinite(currentFinish) && currentFinish <= pendingFinishDelay.allowedFinish)
      pendingFinishDelay = null;
    if (pending.length) {
      const before = currentDecision(ctx, now).forecast?.rows ?? [];
      previousFinish = planFinish(before);
      const delta = currentFinish - previousFinish;
      if (Number.isFinite(delta)) laterBy = delta;
    }
    if (laterBy >= 5 * 60_000) {
      finishDelayNotice = `this change moved the finish ${minutes(laterBy)} later. Unless it adds work the user asked for, undo it: a row on the chain that only makes the process tidier (an integration, a checkpoint, a gate, …) lengthens it (skill step 6)`;
      pendingFinishDelay = {
        notice: finishDelayNotice,
        allowedFinish: previousFinish,
        key: decision.key,
        refusalKey: null,
        refusals: 0,
      };
    }
    const names = (list: Array<{ content: string }>) =>
      list.slice(0, 6).map((row) => JSON.stringify(shorten(row.content))).join(", ") + (list.length > 6 ? `, … ${list.length - 6} more` : "");
    const running = (ctx.getAsyncJobSnapshot()?.running ?? []).filter((job) => job.type === "task" && job.status === "running");
    const owners = new Set(decision.todoOwnerIds ?? []);
    const unlinked = running.filter((job) => !owners.has(job.id) && !(job.agentId && owners.has(job.agentId)));
    const missing = (decision.forecast.planningIssues ?? []).length;
    const overdue = open.filter((row) => row.overdue);
    const ready = decision.dispatchableReady ?? [];
    const idle = open.length - running.length;
    // A row naming an owner that runs nowhere looks staffed in the HUD and is not (user 2026-09-25:
    // "Owner not running - run it!!!!"): name each one so it is resumed by its exact name.
    // The HUD's "N unresolved": open rows omp cannot forecast. Nobody but the chief can fix them.
    const unresolved = open.filter((row) => (row as { fixedPathP95Finish?: number }).fixedPathP95Finish === undefined);
    const why = (row: unknown) => ((row as { issues?: string[] }).issues ?? [])[0];
    const deadOwners = (decision.readyCandidates ?? []).filter((row) => row.owner && row.ownership !== "live-owned" && row.ownership !== "shared-live-owner");
    // Few workers and no ready row: the rows wait on running work, which only the chief can unchain
    // (live 2026-09-25 03:35: 1 of 20 workers ran for half an hour and nothing said so).
    const capacity = workerCapacity(ctx);
    const waitingCritical = criticalWaitList(ctx, open);
    const understaffed = running.length < capacity && ready.length === 0 && open.length > running.length;
    const activity = workerActivity(ctx, running, now);
    const activeJobIds = new Set(running.map((job) => job.id));
    for (const id of workerSizingNoticed) if (!activeJobIds.has(id)) workerSizingNoticed.delete(id);
    const activeWorkerNames = new Set(activity.map((worker) => worker.name));
    for (const name of workerCompactionCursors.keys()) if (!activeWorkerNames.has(name)) workerCompactionCursors.delete(name);
    const checkins = overdueWorkerCheckins(ctx, open, running, activity, now);
    const checkedIn = new Set(checkins.map((worker) => worker.id));
    const silent = silentWorkers(activity).filter((worker) => !checkedIn.has(worker.name));
    const activityByName = new Map(activity.map((worker) => [worker.name, worker]));
    const workerInfos = running.flatMap((job) => {
      const id = job.agentId ?? job.id;
      const row = open.find((candidate) => candidate.owner === job.id || candidate.owner === job.agentId);
      if (!row) return [];
      const p95 = row.fixedPathP95Finish ?? row.resourceFinish;
      const p95Text = typeof p95 === "number" && Number.isFinite(p95)
        ? now >= p95 ? `past ${minutes(now - p95)} (P95 ${hhmm(p95)})` : `due ${hhmm(p95)}`
        : "unknown";
      const trace = workerTrace(ctx, id);
      const age = activityByName.get(id)?.ageMs;
      return [{ id, row, trace, age, p95Text }];
    });
    const workerRows = workerInfos.map(({ id, row, trace, age, p95Text }) => {
      const wrote = trace.wrote.length ? trace.wrote.join(",") : "none";
      return `${id} row=${JSON.stringify(shorten(row.content))} last=${trace.lastTool} age=${minutes(age)} wrote=${wrote} P95=${p95Text}`;
    });
    const workerStatus = workerRows.length
      ? `Worker status: ${workerRows.slice(0, 8).join(" | ")}${workerRows.length > 8 ? ` | … ${workerRows.length - 8} more` : ""}`
      : "";
    const sizing = running.flatMap(job => {
      if (workerSizingNoticed.has(job.id)) return [];
      const id = job.agentId ?? job.id;
      const observed = activityByName.get(id);
      const compactedAt = observed ? workerCompactionAt(observed) : undefined;
      if (compactedAt !== undefined) return [{ id, jobId: job.id, fact: `compacted at ${hhmm(compactedAt)}` }];
      if (typeof job.startTime === "number" && now - job.startTime > SILENT_MS)
        return [{ id, jobId: job.id, fact: `running ${minutes(now - job.startTime)}` }];
      return [];
    });
    pendingSizingNoticeIds = sizing.map(worker => worker.jobId);
    const runningByContent = new Map((decision.ownerRunStates ?? []).map((row) => [row.content, row.running]));
    const unseenPlanningRows = phasesNow
      .flatMap((phase) => phase.tasks)
      .filter((task) => isOpenRowStatus(task.status) && runningByContent.get(task.content) !== true && !sprintState.seenRows.includes(task.content))
      .map((task) => task.content);
    let planningAdvice = "";
    if (unseenPlanningRows.length >= 3) {
      const key = sprintSetKey(unseenPlanningRows);
      if (sprintState.lastPlanningSetKey !== key) {
        sprintState = { ...sprintState, lastPlanningSetKey: key };
        persistSprintState();
        planningAdvice = `planning round due: ${unseenPlanningRows.length} rows no executor has looked at: ${unseenPlanningRows.slice(0, 6).map((row) => JSON.stringify(shorten(row))).join(", ")}${unseenPlanningRows.length > 6 ? `, … ${unseenPlanningRows.length - 6} more` : ""} (skill://chief-of-staff Planning)`;
      }
    } else if (sprintState.lastPlanningSetKey !== null) {
      sprintState = { ...sprintState, lastPlanningSetKey: null };
      persistSprintState();
    }
    const writersByPath = new Map<string, string[]>();
    for (const info of workerInfos)
      for (const path of info.trace.wrote)
        writersByPath.set(path, [...(writersByPath.get(path) ?? []), info.id]);
    const overlapWarnings: string[] = [];
    for (const [path, writers] of writersByPath) {
      const unique = [...new Set(writers)].sort();
      if (unique.length < 2) continue;
      for (let left = 0; left < unique.length; left += 1) {
        for (let right = left + 1; right < unique.length; right += 1) {
          const a = unique[left]!;
          const b = unique[right]!;
          const key = `${path}\0${a}\0${b}`;
          if (workerOverlapEpisodes.has(key)) continue;
          workerOverlapEpisodes.add(key);
          const canSend = typeof (ctx as AgentMessageContext).sendAgentMessage === "function";
          if (canSend) {
            void sendWorkerSteering(ctx, a, `file overlap on ${path}: other live owner ${b} has also written it; coordinate ownership and report who owns the next edit`).then((result) => {
              if (!result.delivered) reportWorkerSteeringFailure(ctx, a, result, `chief must write agent://${a} manually`);
            });
            void sendWorkerSteering(ctx, b, `file overlap on ${path}: other live owner ${a} has also written it; coordinate ownership and report who owns the next edit`).then((result) => {
              if (!result.delivered) reportWorkerSteeringFailure(ctx, b, result, `chief must write agent://${b} manually`);
            });
          }
          overlapWarnings.push(`file overlap: ${path} written by ${a} and ${b}${canSend ? "; both workers notified" : "; worker-message API missing for at least one notice"}`);
        }
      }
    }
    // A result that came back is read the turn it arrives (live 2026-09-25 11:14: two preflight
    // results sat unread while the chief added integration rows).
    const settled = (ctx.getAsyncJobSnapshot()?.recent ?? []).filter((job) => job.type === "task" && job.status === "completed");
    const ownerOf = new Map<string, string>();
    try {
      for (const phase of sdk.getLatestTodoPhasesFromEntries([...ctx.sessionManager.getBranch(), ...pending] as never))
        for (const task of phase.tasks) if (typeof task.schedule?.owner === "string") ownerOf.set(task.content, task.schedule.owner);
    } catch {}
    const unread = open.filter((row) => {
      const owner = ownerOf.get(row.content);
      return owner && !running.some((job) => job.id === owner || job.agentId === owner) && settled.some((job) => job.id === owner || job.agentId === owner);
    });
    const receding = recedingFinish(ctx, open, now);
    const problems = [
      planningAdvice,
      retroLine,
      unread.length ? `${unread.length} worker result(s) came back and their rows are still open: ${names(unread)}. Read each receipt now and close the row or send it back with the reason, before any other plan change (skill step 4)` : "",
      finishDelayNotice,
      receding,
      checkins.length ? `${checkins.length} overdue worker check-in(s): ${checkins.slice(0, 6).map((worker) => worker.sent ? `overdue check-in ${worker.repeated ? "already " : ""}sent to ${worker.id} for ${JSON.stringify(shorten(worker.row))}; ${worker.activityText}` : `overdue check-in blocked for ${worker.id}: ${worker.text ?? missingWorkerMessageApi}; chief must write agent://${worker.id} manually`).join("; ")}${checkins.length > 6 ? `; … ${checkins.length - 6} more` : ""}` : "",
      sizing.length ? `worker sizing: ${sizing.map((worker) => `${worker.id} ${worker.fact}; write agent://${worker.id} asking for done/left with a receipt, then split the rest`).join("; ")}` : "",
      ...overlapWarnings,
      silent.length ? `${silent.length} running worker(s) silent: ${silent.slice(0, 6).map((worker) => `${worker.name} (${worker.lastAt === undefined ? "no activity since start" : "last activity"} ${minutes(worker.ageMs)} ago)`).join(", ")}; write agent://<id> asking what it waits on. Workers not named here are active: their results arrive by themselves, so do not read their history` : "",
      understaffed ? `only ${running.length} of ${capacity} worker slots run and no row is ready: the rest wait on running work. ${waitingCritical ? `Waiting rows on the chain that sets the ETA, in order:${waitingCritical}\n${waitingCritical.includes("queued behind") ? `${RESOURCE_QUEUE}\n` : ""}${WHY_EACH_LINK}\n${SPLIT_EACH} (skill step 7)` : "Split the waiting rows into the part that needs that result and the part that can start now, and dispatch the second part (skill step 7)"}` : "",
      missing ? `${missing} planning issue(s) (missing estimates or dependencies) block every non-read tool` : "",
      overdue.length ? `${overdue.length} open row(s) past their time: ${names(overdue)}` : "",
      unresolved.length ? `${unresolved.length} row(s) have no forecast (the TODO header's "unresolved"); fix their estimate, dependencies or resources, or drop them: ${unresolved.slice(0, 4).map((row) => `${JSON.stringify(shorten(row.content))}${why(row) ? ` (${shorten(why(row)!)})` : ""}`).join(", ")}${unresolved.length > 4 ? `, … ${unresolved.length - 4} more` : ""}` : "",
      unlinked.length ? `${unlinked.length} running worker(s) own no row: ${unlinked.slice(0, 6).map((job) => job.id).join(", ")}` : "",
      deadOwners.length ? `${deadOwners.length} ready row(s) name an owner that is not running; staff them in one task call, one item per row with name = that owner and task = the row's exact title plus what to return: ${deadOwners.slice(0, 6).map((row) => `${JSON.stringify(shorten(row.content))} (owner ${row.owner})`).join(", ")}${deadOwners.length > 6 ? `, … ${deadOwners.length - 6} more` : ""}` : "",
      ready.length && running.length < workerCapacity(ctx) ? `${ready.length} ready row(s) have no worker: ${names(ready)}` : "",
      ready.length > capacity - running.length && idle > capacity ? `${idle} idle rows for ${capacity} worker slots: prune before adding` : "",
    ].filter(Boolean);
    return problems.length
      ? `PLAN CHECK: ${problems.length} problem(s). ${workerStatus ? `${workerStatus} ` : ""}${problems.map((line, i) => `(${i + 1}) ${line}`).join(" ")}. Fix them with the pass of skill://chief-of-staff.`
      : workerStatus
        ? `${PLAN_CHECK_CLEAN} ${workerStatus}`
        : PLAN_CHECK_CLEAN;
  };
  // Once a minute, busy or idle, a plan with problems gets its PLAN CHECK as an aside: the channel
  // IRC messages use, landing at the next step boundary without cutting the running tool (user
  // 2026-09-25: "надо всегда. то есть при любой возможности, типа как IRC"), once per distinct
  // problem list.
  let planTicker: Timer | null = null;
  let tickerContext: ExtensionContext | null = null;
  let lastIdlePlanCheck: string | null = null;
  let lastIdlePlanCheckAt = 0;
  const stopPlanTicker = () => {
    if (planTicker && tickerContext) tickerContext.clearTimer(planTicker);
    planTicker = null;
    tickerContext = null;
    lastIdlePlanCheck = null;
  };
  const markSizingNotices = () => {
    for (const id of pendingSizingNoticeIds) workerSizingNoticed.add(id);
    pendingSizingNoticeIds = [];
  };
  const planTick = (ctx: ExtensionContext) => {
    if (pauseGate?.paused || !isMain(ctx) || !pi.getActiveTools().includes("task") || ctx.hasPendingMessages()) return;
    const check = planCheck(ctx);
    if (!check || check === PLAN_CHECK_CLEAN) return;
    // Once per distinct problem list, and again after PLAN_REPEAT_MS while the same problems stand:
    // a per-minute repeat made the model restate its status every minute (22:08-22:11), while
    // never repeating let it idle on one worker for half an hour unnoticed (03:05-03:35).
    const now = Date.now();
    // Minutes and timestamps change every tick; the problem list is the same unless the words change.
    const key = check
      .replace(/\(\d+\) planning round due:.*?\(skill:\/\/chief-of-staff Planning\)\s*/g, "")
      .replace(/\(\d+\) worker sizing:.*?(?= \(\d+\) |\. Fix them with the pass)/g, "")
      .replace(/\s+/g, " ")
      .replace(/\d+/g, "#");
    if (gateSwitchedOff(ctx) || (pendingSizingNoticeIds.length === 0 && key === lastIdlePlanCheck && now - lastIdlePlanCheckAt < PLAN_REPEAT_MS)) return;
    lastIdlePlanCheck = key;
    lastIdlePlanCheckAt = now;
    pi.sendMessage(
      { customType: "todo-plan-check", content: check, display: false, attribution: "agent" },
      { deliverAs: "aside" },
    );
    markSizingNotices();
  };
  armPlanTicker = (ctx: ExtensionContext) => {
    stopPlanTicker();
    if (!ctx.setInterval) return;
    tickerContext = ctx;
    planTicker = ctx.setInterval(() => planTick(ctx), PLAN_TICK_MS);
  };
  disarmPlanTicker = stopPlanTicker;
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === "todo") {
      if (event.isError || !isMain(ctx) || !pi.getActiveTools().includes("task")) return;
      // The hook runs before this result joins the branch: check the plan the call just produced
      // (live 21:32: an owner written by this very call was reported as missing).
      const details = (event as { details?: unknown }).details;
      const check = planCheck(ctx, details ? [{ type: "message", message: { role: "toolResult", toolName: "todo", details } }] : []);
      if (!check) return;
      markSizingNotices();
      return { content: [...event.content, { type: "text" as const, text: check }] };
    }
    if (event.toolName !== "task") return;
    if (!event.isError && isRetroFacilitatorTaskResult(event)) finishRetro();
    const baseline = taskCallBaselines.get(event.toolCallId);
    taskCallBaselines.delete(event.toolCallId);
    if (!baseline || event.isError) return;
    const jobs = ctx.getAsyncJobSnapshot();
    const taskJobs = [...(jobs?.recent ?? []), ...(jobs?.running ?? [])]
      .filter((job) => job.type === "task");
    const workers = taskJobs
      .filter((job) => !baseline.has(job.id) || (baseline.get(job.id) !== "running" && job.status === "running"))
      .map((job) => ({ id: job.id, ...(job.agentId ? { agentId: job.agentId } : {}) }));
    const uniqueWorkers = [...new Map(workers.map((worker) => [worker.id, worker])).values()];
    pendingTaskReconciliation = {
      baseline,
      workers: uniqueWorkers,
      unknown: uniqueWorkers.length === 0,
      turnEnded: false,
      checks: 0,
      linkDemanded: false,
      linkAnswered: false,
    };
  });

  // The role rides on every provider request. A before_agent_start system prompt lasts only for
  // a user-started run, and a goal session lives mostly on autonomous continuations and restarts.
  // The kill switch stops only what can block a call (demands, refusals); this note only informs, so it stays.
  pi.on("context", (event, ctx) => {
    const now = Date.now();
    const decision = currentDecision(ctx, now);
    const chief = isMain(ctx) && pi.getActiveTools().includes("task");
    if (!decision.prompt && !chief) return;
    const attemptedIdleOwners = decision.readyCandidates
      .filter((row) => row.ownership === "idle-live-owner" && row.owner && idleResumeAttempts.has(row.owner))
      .map((row) => row.owner!);
    const facts = chief ? integrationFacts(ctx, now) : "";
    const content = [
      ...(chief ? [CHIEF_OF_STAFF] : []),
      ...(facts ? [facts] : []),
      ...(chief && activeDemand ? [`NEXT STEP (advice; no call is skipped or refused for it): ${activeDemand}`] : []),
      ...(decision.prompt
        ? [`${decision.prompt}${attemptedIdleOwners.length ? `\nFAIL CLOSED: exact idle worker resume already attempted once for ${attemptedIdleOwners.join(", ")}; inspect the exact session/result, do not retry or create a duplicate writer.` : ""}`]
        : []),
    ].join("\n");
    return { messages: [...event.messages, { role: "developer", content, timestamp: now }] };
  });

  const armIdleCheck = (ctx: ExtensionContext, decision = currentDecision(ctx)) => {
    clearIdleTimer();
    if (
      !pauseGate ||
      pauseGate.paused ||
      !decision.key ||
      !decision.forecast ||
      decision.nextCheckMs === null ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    )
      return;
    const delay = decision.wakeKey && decision.rawWakeKey !== lastWakeKey ? 0 : decision.nextCheckMs;
    timerContext = ctx;
    idleTimer = ctx.setTimeout(() => {
      idleTimer = null;
      timerContext = null;
      if (!pauseGate || pauseGate.paused || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      const fresh = currentDecision(ctx);
      if (pauseGate.paused) return;
      if (!fresh.key || !fresh.forecast || !fresh.wakeKey || !fresh.rawWakeKey) {
        armIdleCheck(ctx);
        return;
      }
      if (fresh.rawWakeKey === lastWakeKey) {
        armIdleCheck(ctx);
        return;
      }
      // Reserve this exact plan/alarm revision before queuing, so an unchanged alarm cannot loop.
      lastWakeKey = fresh.rawWakeKey;
      pi.sendMessage(
        {
          customType: "agent-focus-gym-eval-sandbox-wake",
          content:
            `Overdue TODO follow-through: the plan is past its time and the session went idle. ${ORDER}`,
          display: false,
          attribution: "agent",
          details: { planRevision: fresh.key, alarms: fresh.alarms },
        },
        { deliverAs: "aside" },
      );
    }, delay);
  };
  pi.on("agent_end", (_event, ctx) => {
    persistRoster(ctx);
    const decision = currentDecision(ctx);
    if (pendingTaskReconciliation) {
      pendingTaskReconciliation.turnEnded = true;
      const owners = new Set(decision.todoOwnerIds ?? []);
      const reconciled = pendingTaskReconciliation.workers.some(
        (worker) => owners.has(worker.id) || (worker.agentId !== undefined && owners.has(worker.agentId)),
      );
      if (reconciled && decision.rawWakeKey) lastWakeKey = decision.rawWakeKey;
    }
    dispatchGateBaseline = null;
    taskCallBaselines.clear();
    armIdleCheck(ctx, decision);
  });
}
