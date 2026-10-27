// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { selectBranchEntries, selectBranchNewestFirst, selectLatestBranchEntry } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { prompt } from "@oh-my-pi/pi-utils";
import { truncateMiddleToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isTodoSelectionEntryMetadata } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { realizesPriorityServiceTier } from "@oh-my-pi/pi-ai";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { availableParallelism } from "node:os";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { resolveAgentModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgTaskAgentModelOverrides, cfgTaskMaxEffort } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { clampThinkingLevelToCeiling, resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { getTodoPlanningIssues, parseUserWait, type TodoPlanForecast, type TodoPlanningIssue, type TodoScheduleInput, type TodoTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { formatLocalClock, formatLocalTimestamp, isUserDeadlineMissed, latestDeadlineUserMessage, lifecycleGoal, readGoalDeadline, rehydrateDeadlineState } from "./deadlines";
import unansweredUserInstructions from "./unanswered-user-reply.md" with { type: "text" };
import gateNoticeInstructions from "./gate-notices.md" with { type: "text" };
import { countLiveWorkerModels } from "./agent_router";
import { checkoutKeyFromResources, displayCheckoutKey, normalizeCheckoutKey } from "./checkout_scope";
import { derivePresence, isDeadlineStateEntryMetadata, isGoalLifecycleEntryMetadata, latestDeadlineStateEntries, type Presence } from "./goal_deadlines";
import { calibrationHints, readDurationHistory } from "./todo_calibration";
import { getUserWaitPlanningIssues, parkUserWaits, USER_WAIT_SELF_FILL } from "./todo-schedule-away";

export function todoStateEntries(ctx: ExtensionContext, pending: unknown[] = []) {
  const phases = pending.length === 0 ? ctx.getTodoPhases?.() : undefined;
  if (phases !== undefined) return [{ type: "custom", customType: "user_todo_edit", data: { phases } }];
  const branch = selectBranchEntries(ctx.sessionManager, isTodoSelectionEntryMetadata);
  return pending.length ? [...branch, ...pending] : branch;
}

export function dispatchStateEntries(ctx: ExtensionContext, pending: unknown[] = []) {
  const phases = pending.length === 0 ? ctx.getTodoPhases?.() : undefined;
  const branch = selectBranchEntries(ctx.sessionManager, (metadata) =>
    (phases === undefined && isTodoSelectionEntryMetadata(metadata)) || isDeadlineStateEntryMetadata(metadata) || isGoalLifecycleEntryMetadata(metadata) ||
    (metadata.type === "message" && metadata.messageRole === "user"),
  );
  if (phases !== undefined) return [...branch, { type: "custom", customType: "user_todo_edit", data: { phases } }];
  return pending.length ? [...branch, ...pending] : branch;
}

type DispatchForecastApi = Pick<
  ExtensionAPI["pi"],
  "forecastTodoPlan" | "formatPlanForecast" | "formatTaskForecast"
> & {
  getTodoPlanningIssues?: (phases: TodoScheduleInput) => TodoPlanningIssue[];
};

type Jobs = Pick<AsyncJobSnapshot, "running" | "recent"> & {
  nonJobAgents?: Array<{ id: string; live: boolean }>;
};
const liveJobMatchesOwner = (job: { id: string; agentId?: string }, owner: string) =>
  job.id === owner || job.agentId === owner || job.id.replace(/-\d+$/, "") === owner;

type PersistedChild = { id: string; owner: string | null; live: boolean };
type SprintWorkerFinish = { jobId: string; id: string; at: number; row: string };
type RecoveryWait = { kind: "cap" | "stuck"; row: string; owner: string; at: number; startTime?: number; killed?: boolean; received?: boolean };
export type SprintState = {
  version: 1;
  seenRows: string[];
  lastPlanningSetKey: string | null;
  lastRetroAt: number | null;
  goalWorkStartedAt: number | null;
  rowStatuses: Record<string, string>;
  reopenedRows: string[];
  workerFinishes: SprintWorkerFinish[];
  seenJobIds: string[];
  retroFacilitatorJobs: string[];
  retroCoveredIds: string[];
  retroCoveredAttempts: string[];
  retroReceiptIds: string[];
  correctionPending: boolean;
  retroDueReason: string | null;
  retroDueDeadlineAt?: number;
  retroDueDeliveryKey?: string;
  retroDueNotifiedKey?: string;
  handledDeadlineAt?: number;
  handledDeliveryKey?: string;
  lastNotices: Record<string, string>;
  ignoredDemands: Record<string, number>;
  recoveryWaits?: RecoveryWait[];
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
const RECENT_FINISH_MS = 3 * 60 * 60_000;
const ROSTER_ENTRY_TYPE = "todo-dispatch-roster";
export const SPRINT_STATE_ENTRY_TYPE = "todo-dispatch-sprint-state";
const CHIEF_RULES_ENTRY_TYPE = "chief-rules-after-compaction";
const WORKER_BRIEF_ENTRY_TYPE = "worker-brief-after-compaction";
const TODO_ERROR_ENTRY_TYPE = "todo-error-reminder";
const COMPACTION_DEDUPED_ENTRY_TYPES = [CHIEF_RULES_ENTRY_TYPE, WORKER_BRIEF_ENTRY_TYPE, TODO_ERROR_ENTRY_TYPE];
// Latest-wins view for the three append-only custom types: keep only the newest message per
// customType by message order, preserve every unrelated message and the retained order, never
// mutate the input. Returns the original array when no type repeats, so callers can keep the
// pass-through behavior unchanged in the common case.
function dedupeLatestWinsCompactionMessages(messages: AgentMessage[]): AgentMessage[] {
  const lastIndexByType: Record<string, number> = {};
  let hasDuplicate = false;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "custom" || !COMPACTION_DEDUPED_ENTRY_TYPES.includes(message.customType)) continue;
    const customType = message.customType;
    if (lastIndexByType[customType] !== undefined) hasDuplicate = true;
    lastIndexByType[customType] = index;
  }
  if (!hasDuplicate) return messages;
  return messages.filter((message, index) => {
    if (message.role !== "custom" || !COMPACTION_DEDUPED_ENTRY_TYPES.includes(message.customType)) return true;
    return lastIndexByType[message.customType] === index;
  });
}
// Canonical surviving model context for the compact guard: use the shared
// SessionManager.buildSessionContext producer and check whether that customType still reaches the model.
// Never re-derive retained ranges or compaction boundaries here. Canonical builder errors must surface.
function survivingCompactionCustomType(ctx: ExtensionContext, customType: string): boolean {
  const context = ctx.sessionManager.buildSessionContext?.() ?? buildSessionContext(ctx.sessionManager.getBranch());
  return context.messages.some((message) => message.role === "custom" && message.customType === customType);
}
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
export async function readGitIntegrationState(cwd: string, now: number): Promise<GitIntegrationState | null> {
  const git = async (...args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 5_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  const head = await git("rev-parse", "HEAD");
  if (!head) return null;
  const state: GitIntegrationState = { head };
  const mergePath = await git("rev-parse", "--git-path", "MERGE_HEAD");
  if (mergePath) {
    try {
      const stat = statSync(isAbsolute(mergePath) ? mergePath : join(cwd, mergePath));
      state.mergeHead = await git("rev-parse", "--short", "MERGE_HEAD") ?? "MERGE_HEAD";
      state.mergeAgeMs = now - stat.mtimeMs;
      const unmerged = await git("diff", "--name-only", "--diff-filter=U");
      state.unmerged = unmerged ? new Set(unmerged.split("\n").filter(Boolean)).size : 0;
    } catch {}
  }
  const unpushed = await git("log", "--format=%ct", "@{upstream}..HEAD");
  if (unpushed !== null) {
    const times = unpushed.split("\n").filter(Boolean).map(Number);
    state.unpushed = times.length;
    if (times.length) state.oldestUnpushedAgeMs = now - Math.min(...times) * 1000;
  }
  return state;
}

const execFileAsync = promisify(execFile);
async function readGitLogSince(cwd: string, previousHead: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "--abbrev=10", "--format=%h %s", `${previousHead}..HEAD`], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
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
// Reopen words (Fix/Repair/…) mean "an earlier row failed acceptance". They must not block a
// fresh spawn for a new row: live 2026-10-01 "FixAsyncAsk" and "AskSelectorRepair" were refused
// while FixExtensionGates spawned fine. Block only when the staffed row was accepted before or
// the worker name targets an accepted row.
const REOPEN_WORD_GROUPS: Record<string, true> = { Repair: true, Recovery: true, Restore: true, Fix: true, Fixup: true, V: true, Cancel: true };

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
    retroFacilitatorJobs: [],
    retroCoveredIds: [],
    retroCoveredAttempts: [],
    retroReceiptIds: [],
    correctionPending: false,
    retroDueReason: null,
    lastNotices: {},
    ignoredDemands: {},
  };
}

/** Retro receipt ids are only consulted for membership, so keep the newest window; one id per retro is ~20 bytes. */
const MAX_RETRO_RECEIPT_IDS = 500;
/** Notice dedupe keeps only digests of the most recent keys; full notice texts made each persisted state megabytes. */
// Worker write tracking. A worker's session cwd is the lead's checkout; the files it changes and the
// commits it makes live in its own git worktree, reached through tool paths and bash `cwd`/`cd`/`git -C`.
// Paths are compared as normalized absolute paths so a shared word ("log") or the same relative name in two
// different worktrees is not an overlap.
// Split on &&, ||, ;, | and newlines outside quotes.
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') { current += char + (command[index + 1] ?? ""); index += 1; continue; }
      if (char === quote) quote = "";
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ";" || char === "|" || char === "&" || char === "\n") {
      segments.push(current);
      current = "";
    } else current += char;
  }
  segments.push(current);
  return segments;
}
function shellWords(segment: string): string[] {
  const words: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(segment); match; match = pattern.exec(segment))
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words;
}
export function normalizeWrittenPath(candidate: unknown, base?: string): string | undefined {
  if (typeof candidate !== "string") return undefined;
  const raw = candidate.trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("-") || /[*?[\]{}$`<>]/.test(raw)) return undefined;
  if (raw === "." || raw === "..") return undefined;
  const bare = raw.replace(/:\d+(?:-\d+)?$/, "");
  if (isAbsolute(bare)) return normalize(bare);
  return base && isAbsolute(base) ? resolve(base, bare) : normalize(bare);
}
// Files named by `git add` segments of a shell command, and the directories the command works in
// (`cd X`, `git -C X`). Only real `git add` arguments count: other words of a chained command are not paths.
export function bashWriteEffects(command: string, cwd?: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  let base = cwd;
  for (const segment of splitShellSegments(command)) {
    const words = shellWords(segment);
    if (words.length === 0) continue;
    if (words[0] === "cd" && words[1]) {
      const target = normalizeWrittenPath(words[1], base);
      if (target && isAbsolute(target)) { base = target; dirs.push(target); }
      continue;
    }
    if (words[0] !== "git") continue;
    let index = 1;
    let gitBase = base;
    while (index < words.length && words[index]!.startsWith("-")) {
      if (words[index] === "-C" && words[index + 1]) {
        const target = normalizeWrittenPath(words[index + 1], gitBase);
        if (target && isAbsolute(target)) { gitBase = target; dirs.push(target); }
        index += 2;
      } else index += 1;
    }
    if (words[index] === "commit" && gitBase) dirs.push(gitBase);
    if (words[index] !== "add") continue;
    if (gitBase) dirs.push(gitBase);
    for (const word of words.slice(index + 1)) {
      if (word === "--") continue;
      const file = normalizeWrittenPath(word, gitBase);
      if (file) files.push(file);
    }
  }
  return { files, dirs };
}
export function gitRootOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  let dir = path;
  for (let depth = 0; depth < 40; depth += 1) {
    try {
      if (existsSync(join(dir, ".git"))) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
const EDIT_INPUT_HEADER = /^\[([^\]#\n]+?)(?:#[^\]\n]*)?\]\s*$/gm;
export function editInputPaths(input: unknown): string[] {
  if (typeof input !== "string") return [];
  return [...input.matchAll(EDIT_INPUT_HEADER)].map((match) => match[1]!.trim()).filter(Boolean);
}

export const MAX_NOTICE_KEYS = 200;

export function noticeDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function noticeKey(kind: string, rowKey: string): string {
  return `${kind}\0${noticeDigest(rowKey)}`;
}

const DIGEST = /^[0-9a-f]{16}$/;

export function boundedNotices(notices: Record<string, string>): Record<string, string> {
  const entries = Object.entries(notices).map(([key, value]): [string, string] => {
    const split = key.indexOf("\0");
    const kind = split < 0 ? key : key.slice(0, split);
    const rowKey = split < 0 ? "" : key.slice(split + 1);
    return [DIGEST.test(rowKey) ? key : noticeKey(kind, rowKey), DIGEST.test(value) ? value : noticeDigest(value)];
  });
  return Object.fromEntries(entries.slice(-MAX_NOTICE_KEYS));
}
/** Checkout-lock refusal owner: "Refusing <agent>: <writer> worker <key> is running in this checkout". */
export function checkoutLockOwnerFromMessage(text: string): string | undefined {
  return text.match(/Refusing \S+: \S+ worker (.+?) is running in this checkout/i)?.[1]?.trim() || undefined;
}

/** Overrun budget mirrors the #70 badge: elapsed-at-reestimate plus the rescheduled remaining. */
export function todoOverrunBudgetMs(row: {
  startedAt?: number;
  estimateUpdatedAt?: number;
  reestimateCount?: number;
  estimateRangeSeconds?: { likely?: number; pessimistic?: number };
}): number | undefined {
  const remainingSeconds = typeof row.estimateRangeSeconds?.pessimistic === "number"
    ? row.estimateRangeSeconds.pessimistic
    : typeof row.estimateRangeSeconds?.likely === "number"
      ? row.estimateRangeSeconds.likely
      : undefined;
  if (typeof row.startedAt !== "number" || !Number.isFinite(row.startedAt) || remainingSeconds === undefined) return undefined;
  const absorbedMs = (row.reestimateCount ?? 0) >= 1
    && typeof row.estimateUpdatedAt === "number"
    && Number.isFinite(row.estimateUpdatedAt)
    && row.estimateUpdatedAt > row.startedAt
    ? row.estimateUpdatedAt - row.startedAt
    : 0;
  return absorbedMs + remainingSeconds * 1000;
}

/** Extract the row updates a `todo schedule` call carries, across its accepted shapes. */
function todoScheduleUpdates(input: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) if (item && typeof item === "object") out.push(item as Record<string, unknown>);
  };
  if (!input || typeof input !== "object") return out;
  const obj = input as { updates?: unknown; phases?: unknown; tasks?: unknown };
  collect(obj.updates);
  if (Array.isArray(obj.phases)) for (const phase of obj.phases) collect((phase as { tasks?: unknown } | undefined)?.tasks);
  collect(obj.tasks);
  return out;
}

/** Owners running for less than this are a fresh attempt (e.g. crash recovery,
 * 658): the missed ETA belongs to the killed attempt, so a reestimate is
 * legitimate replanning, not a slip. */
export const FRESH_OWNER_MS = 15 * 60_000;
/** R1/R2: a same-owner reestimate on a slipping row is refused with one exact recovery action. */
export function slipReestimateRefusal(args: {
  updates: readonly Record<string, unknown>[];
  rows: readonly TodoTaskForecast[];
  runningProfiles: ReadonlyMap<string, string | undefined>;
  runningStartedAt?: ReadonlyMap<string, number>;
  now: number;
}): string | undefined {
  for (const update of args.updates) {
    const content = typeof update.task === "string" ? update.task : typeof update.content === "string" ? update.content : undefined;
    if (content === undefined) continue;
    const row = args.rows.find((candidate) => candidate.content === content);
    if (!row) continue;
    const status = typeof update.status === "string" ? update.status : undefined;
    if (status === "completed" || status === "abandoned") continue;
    const nextOwner = typeof update.owner === "string" ? update.owner : row.owner;
    if (typeof row.owner !== "string" || nextOwner !== row.owner) continue;
    const estimate = update.estimate as { optimisticSeconds?: unknown; likelySeconds?: unknown; pessimisticSeconds?: unknown; updatedAt?: unknown } | undefined;
    if (!estimate || typeof estimate !== "object") continue;
    const differs = (typeof estimate.updatedAt === "number" && estimate.updatedAt !== row.estimateUpdatedAt)
      || (row.estimateRangeSeconds !== undefined && (
        (typeof estimate.optimisticSeconds === "number" && estimate.optimisticSeconds !== row.estimateRangeSeconds.optimistic)
        || (typeof estimate.likelySeconds === "number" && estimate.likelySeconds !== row.estimateRangeSeconds.likely)
        || (typeof estimate.pessimisticSeconds === "number" && estimate.pessimisticSeconds !== row.estimateRangeSeconds.pessimistic)));
    const reestimate = (row.estimateUpdatedAt !== undefined || row.estimateRangeSeconds !== undefined) && differs;
    if (!reestimate) continue;
    const budgetMs = todoOverrunBudgetMs({ startedAt: row.startedAt, estimateUpdatedAt: row.estimateUpdatedAt, reestimateCount: row.reestimateCount, estimateRangeSeconds: row.estimateRangeSeconds });
    const overBudget = typeof row.startedAt === "number" && budgetMs !== undefined && args.now - row.startedAt > budgetMs;
    const exhausted = row.reestimateCount >= 2;
    const startedAt = args.runningStartedAt?.get(row.owner);
    // A freshly started owner is a new attempt after crash recovery (658): its
    // reestimate replans the remainder, it does not slip the old ETA. Only the
    // exhausted cap still applies to fresh owners.
    const freshOwner = startedAt !== undefined && args.now - startedAt < FRESH_OWNER_MS;
    const slipping = !freshOwner && row.status === "in_progress" && args.runningProfiles.has(row.owner) && (row.overdue || overBudget);
    if (!exhausted && !slipping) continue;
    // A slipping row may be reestimated under the same owner when the update
    // records the failure reason as evidence (658): the lead keeps a worker
    // that is making progress and still logs a new estimate. The counter
    // increment happens on the normal schedule path.
    const hasEvidence = typeof update.evidence === "string" && update.evidence.trim().length > 0;
    if (slipping && !exhausted && hasEvidence) continue;
    const profile = args.runningProfiles.get(row.owner);
    const strong = typeof profile === "string" && existsSync(new URL(`./agents/${profile}-strong.md`, import.meta.url)) ? `${profile}-strong` : undefined;
    if (!exhausted) {
      return `Reestimate ${actionTarget(content)} with evidence + estimate.\nRefusing todo schedule: ${JSON.stringify(content)} is past its ETA under running owner ${row.owner}. Exactly: todo schedule the row with evidence (the failure reason) plus a new estimate, or with a new owner${strong ? ` (${strong})` : ""} or split the remainder into new rows.`;
    }
    const why = `has ${row.reestimateCount} reestimates under owner ${row.owner}`;
    return `Kill ${shorten(row.owner, 32)}; reassign ${actionTarget(content)}.\nRefusing todo schedule: ${JSON.stringify(content)} ${why}. Exactly: write proc://${row.owner}/kill (empty content), read its receipt, then todo schedule the row with a new owner${strong ? ` (${strong})` : ""} or split the remainder into new rows.`;
  }
  return undefined;
}

/** A blocked reason that records the user's decision to wait for a distant event, not an hours-long wait. */
export function isDistantWaitReason(blocker: string): boolean {
  return /chose to wait|waiting (?:until|for)|wait (?:until|for)|release (?:next week|next month|in \d+ days?)|next week|next month|\d{4}-\d\d-\d\d/i.test(blocker);
}

/** Central union-of-remedies gate decision: one allow decision instead of independent refusals. */
export type GateCall = { name: string; arguments?: Record<string, unknown> };
export type ActiveGate = { id: string; remedy: string; satisfies: (call: GateCall) => boolean };
export type GateDecision = { allowed: boolean; remedyGateIds: string[]; reason?: string };
export const DEMAND_IGNORE_MAX = 3;
export const DEMAND_IGNORE_MAX_REPLAN = 5;
export const OVERRIDE_SUPPRESS_TURNS = 5;
const PLAN_DEMAND_IDS = new Set(["missed-eta", "todo-plan-doctor", "todo-replan", "todo-link", "unread-receipts"]);
const PLAN_FIX_OPS = new Set(["schedule", "drop", "rm", "done", "append", "init"]);
const ESCALATION_REMEDY = "Fix the plan in a todo call: re-estimate the late row with evidence, split it, or drop it. Don't start workers to answer this.";
export const GATE_IDS = ["planning-issues", "chief-no-bash", "idle-wait", "checkout", "retro", "escalation", "missed-eta", "receipt", "duplicate-worker"] as const;
const READ_TIER = new Set(["read", "grep", "glob", "find"]);
const todoOpOf = (call: GateCall): string | undefined => {
  const args = call.arguments ?? {};
  const op = (args as { op?: unknown }).op;
  return typeof op === "string" ? op : undefined;
};
const isKill = (call: GateCall): boolean => {
  if (call.name !== "write") return false;
  const path = (call.arguments as { path?: unknown } | undefined)?.path;
  return typeof path === "string" && path.startsWith("proc://");
};
export function demandClassOf(id: string): string {
  const base = id.split(":")[0] ?? id;
  return base.trim() || id;
}
export function parseTodoOverride(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("override" in input)) return undefined;
  const override = input.override;
  if (typeof override !== "string" || !override.trim()) return undefined;
  const lowered = override.toLowerCase();
  // Grievances 547/590: the tracked demands below never matched a GATE_ID, so an
  // override naming them was silently dropped and the refusal stood. Map each to
  // the ignoredDemands key that trackDemands/isDemandEscalated use. These run first:
  // "unread-receipts" contains the GATE_ID "receipt" and must win over it.
  if (lowered.includes("plan-doctor")) return "todo-plan-doctor";
  if (lowered.includes("todo-replan") || lowered.includes("replan")) return "todo-replan";
  if (lowered.includes("todo-link")) return "todo-link";
  if (lowered.includes("unread-receipts") || lowered.includes("unread receipt")) return "unread-receipts";
  for (const id of GATE_IDS) if (lowered.includes(id)) return id;
  return undefined;
}
// A worker's session cwd is the lead's checkout. Once a worker works by absolute path in another
// checkout, a relative edit/write path still resolves against the lead's checkout and lands there
// (live sunbim 2026-10-23 18:41: RolesBuild read wt/roles-workspaces-2026-10-23/AGENTS.md, then its
// `[AGENTS.md#3BBD]` patch edited the user's review checkout, which the brief said never to write).
const WRITE_TOOLS = new Set(["edit", "write", "ast_edit"]);
function inputPaths(input: unknown): { absolute: string[]; relativeWrites: string[] } {
  const absolute: string[] = [];
  const relative: string[] = [];
  const args = (input ?? {}) as Record<string, unknown>;
  const take = (value: unknown) => {
    if (typeof value !== "string" || !value || /^[a-z]+:\/\//i.test(value)) return;
    (value.startsWith("/") || value.startsWith("~") ? absolute : relative).push(value);
  };
  take(args.path);
  take(args.cwd);
  if (typeof args.input === "string") for (const match of args.input.matchAll(/^\[([^\]#\n]+)#/gm)) take(match[1]);
  return { absolute, relativeWrites: relative };
}
/** Records where a subagent works and refuses a relative write once it works outside `cwd`. */
export function refuseRelativeWorkerWrite(seenElsewhere: Map<string, string>, session: string, toolName: string, input: unknown, cwd: string): string | undefined {
  const { absolute, relativeWrites } = inputPaths(input);
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const outside = absolute.find((path) => !path.startsWith("~") && path !== cwd && !path.startsWith(root));
  if (outside && !seenElsewhere.has(session)) seenElsewhere.set(session, outside);
  const elsewhere = seenElsewhere.get(session);
  const target = WRITE_TOOLS.has(toolName) ? relativeWrites[0] : undefined;
  if (!elsewhere || !target) return undefined;
  return `Use an absolute ${toolName} path for ${actionTarget(target, 37)} inside ROOT.\nBlocked: relative path \`${target}\` resolves into ${cwd}, the lead's checkout, but you work in another checkout (${elsewhere}). Repeat the ${toolName} with the absolute path inside your ROOT.`;
}
export const GLOBAL_KILL_REFUSAL =
  "Stop only your recorded PID with kill <pid>.\nBlocked: global kill on a shared host. Record the PID of each process you start and stop only that PID with `kill <pid>`.";
// A subagent shares the host with other sessions' servers and tests: a kill chosen by name, pattern,
// file or "everything" hits their processes (live sunbim 2026-10-20: `pkill -f "vite preview"`,
// `fuser -k`, `pkill -9 -f "node.*playwright"`, repeated after the lead's STOP). Only a kill of a
// literal numeric PID or a variable holding one stays allowed.
export function isGlobalKillCommand(command: string, depth = 0): boolean {
  // Text inside quotes is data (echo/grep arguments), except `$(...)`/backticks inside double quotes,
  // which run, and the program text of `sh -c '...'`, which is scanned on its own.
  const inner: string[] = [];
  let code = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch !== "'" && ch !== '"') { code += ch; continue; }
    let j = i + 1;
    while (j < command.length && command[j] !== ch) j += ch === '"' && command[j] === "\\" ? 2 : 1;
    const body = command.slice(i + 1, j);
    inner.push(body);
    if (ch === '"') code += (body.match(/\$\([^)]*\)|`[^`]*`/g) ?? []).join(" ");
    i = j;
    code += " ";
  }
  const patternPids = /\b(?:pgrep|pidof|lsof|fuser|ps)\b/;
  if (/\bkill\b[^;&|\n]*(?:\$\(|`)[^)`]*\b(?:pgrep|pidof|lsof|fuser|ps)\b/.test(code)) return true;
  if (new RegExp(`${patternPids.source}[^;&\\n]*\\|\\s*xargs\\b[^|;&\\n]*\\bkill\\b`).test(code)) return true;
  for (const segment of code.split(/[;&|\n(){}`]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || ["sudo", "env", "nohup", "time", "command", "exec", "builtin"].includes(words[0]!))) words.shift();
    if (words[0] === "timeout") words.splice(0, 2);
    const head = words[0]?.replace(/^.*\//, "");
    const args = words.slice(1);
    if (head === "pkill" || head === "killall") return true;
    if (head === "fuser" && args.some((arg) => /^-[A-Za-z0-9]*k/.test(arg))) return true;
    // `kill 0` signals the process group; `-1` is "every process" only as a pid operand (`kill -9 -1`,
    // `kill -- -1`), while `kill -1 <pid>` sends SIGHUP to one pid.
    if (head === "kill" && args.some((arg, index) => arg === "0" || (arg === "-1" && (index > 0 || args[0] === "--")))) return true;
    if (depth < 2 && (head === "bash" || head === "sh" || head === "zsh") && args.includes("-c"))
      for (const body of inner) if (isGlobalKillCommand(body, depth + 1)) return true;
  }
  return false;
}
export function decideGateCall(
  call: GateCall,
  gates: readonly ActiveGate[],
): GateDecision {
  if (READ_TIER.has(call.name)) return { allowed: true, remedyGateIds: [] };
  if (call.name === "context_notes") return { allowed: true, remedyGateIds: [] };
  if (isKill(call)) return { allowed: true, remedyGateIds: [] };
  // Messaging owns target lookup and rejects unknown ids. Gates must not require a
  // running task: idle/parked workers and shell:/peer: routes are also valid replies.
  if (call.name === "write") {
    const path = (call.arguments as { path?: unknown } | undefined)?.path;
    if (typeof path === "string" && path.startsWith("agent://")) return { allowed: true, remedyGateIds: [] };
  }
  if (gates.length === 0) return { allowed: true, remedyGateIds: [] };
  const passing = gates.filter((gate) => {
    try {
      return gate.satisfies(call);
    } catch {
      return false;
    }
  });
  if (passing.length > 0) return { allowed: true, remedyGateIds: passing.map((gate) => gate.id) };
  return {
    allowed: false,
    remedyGateIds: gates.map((gate) => gate.id),
    reason: `Answer ${shorten(gates[0]!.id, 32)} via todo${gates.length > 1 ? ` (+${gates.length - 1} more below)` : ""}.\nblocked by ${gates.length} gate(s): ${gates.map((gate) => `${gate.id} (remedy: ${gate.remedy})`).join("; ")}`,
  };
}

export function readPersistedSprintState(branch: unknown[]): SprintState {
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
      retroFacilitatorJobs: Array.isArray(data.retroFacilitatorJobs) ? data.retroFacilitatorJobs.filter((item): item is string => typeof item === "string") : [],
      retroCoveredIds: Array.isArray(data.retroCoveredIds) ? data.retroCoveredIds.filter((item): item is string => typeof item === "string") : [],
      retroCoveredAttempts: Array.isArray((data as Partial<SprintState>).retroCoveredAttempts) ? ((data as Partial<SprintState>).retroCoveredAttempts as unknown[]).filter((item): item is string => typeof item === "string") : [],
      retroReceiptIds: Array.isArray(data.retroReceiptIds) ? data.retroReceiptIds.filter((item): item is string => typeof item === "string") : [],
      correctionPending: data.correctionPending === true,
      retroDueReason: typeof data.retroDueReason === "string" ? data.retroDueReason : null,
      ...(typeof data.retroDueDeadlineAt === "number" ? { retroDueDeadlineAt: data.retroDueDeadlineAt } : {}),
      ...(typeof data.retroDueDeliveryKey === "string" ? { retroDueDeliveryKey: data.retroDueDeliveryKey } : {}),
      ...(typeof data.retroDueNotifiedKey === "string" ? { retroDueNotifiedKey: data.retroDueNotifiedKey } : {}),
      ...(typeof data.handledDeadlineAt === "number" ? { handledDeadlineAt: data.handledDeadlineAt } : {}),
      ...(typeof data.handledDeliveryKey === "string" ? { handledDeliveryKey: data.handledDeliveryKey } : {}),
      lastNotices: typeof data.lastNotices === "object" && data.lastNotices !== null
        ? boundedNotices(Object.fromEntries(Object.entries(data.lastNotices).filter((entry): entry is [string, string] => typeof entry[1] === "string")))
        : {},
      ...(Array.isArray(data.recoveryWaits) ? { recoveryWaits: data.recoveryWaits.filter((item): item is RecoveryWait =>
        item !== null && typeof item === "object" && (item.kind === "cap" || item.kind === "stuck") &&
        typeof item.row === "string" && typeof item.owner === "string" && typeof item.at === "number") } : {}),
      ignoredDemands: typeof data.ignoredDemands === "object" && data.ignoredDemands !== null
        ? Object.fromEntries(Object.entries(data.ignoredDemands).filter((entry): entry is [string, number] => typeof entry[1] === "number").slice(-MAX_NOTICE_KEYS))
        : {},
    };
  }
  return blankSprintState();
}

/** Cap on retained settled job ids; ids older than this are never re-checked as "seen". */
export const MAX_SEEN_JOB_IDS = 256;
/** Cap on retained settled roster children; live children are always kept. */
export const MAX_SETTLED_CHILDREN = 32;
/** A covered row attempt is a JSON-encoded [row content, attempt id] pair. */
function rowAttemptKeys(task: TaskRow): string[] {
  const schedule = task.schedule && typeof task.schedule === "object" ? task.schedule : undefined;
  const attempts = Array.isArray(schedule?.attemptHistory) ? schedule.attemptHistory : [];
  const ids: string[] = [];
  if (typeof schedule?.owner === "string" && schedule.owner !== "") ids.push(schedule.owner);
  for (const attempt of attempts) {
    if (typeof attempt !== "object" || attempt === null) continue;
    const record = attempt as { attemptId?: unknown; workerName?: unknown };
    if (typeof record.attemptId === "string" && record.attemptId !== "") ids.push(record.attemptId);
    else if (typeof record.workerName === "string" && record.workerName !== "") ids.push(record.workerName);
  }
  return ids.map((id) => JSON.stringify([task.content, id]));
}
function coveredAttemptRow(key: string): string {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : key;
  } catch {
    return key;
  }
}

/**
 * Bound sprint state to the rows still in the todo plan plus a recent window. Every array here
 * only ever grew, so one long session persisted hundreds of megabytes of dead row names and job
 * ids. `liveRows` null means the plan is not loaded yet: only the time-window pruning applies.
 */
export function pruneSprintState(
  state: SprintState,
  liveRows: ReadonlySet<string> | null,
  now: number = Date.now(),
): SprintState {
  const keepRow = (row: string) => liveRows === null || liveRows.has(row);
  const seenRows = state.seenRows.filter(keepRow);
  const rowStatuses = Object.fromEntries(Object.entries(state.rowStatuses).filter(([row]) => keepRow(row)));
  const reopenedRows = state.reopenedRows.filter(keepRow);
  // lastNotices keys are `${kind}\0${hexDigest}`: they never contain a row name,
  // so row-filtering drops every entry and identical PLAN CHECKs resend as new
  // chief turns instead of silent notices. Keep the digest cache but bound it
  // so 500 dead rows cannot persist unbounded state.
  const lastNotices = boundedNotices(state.lastNotices);
  const retroCoveredAttempts = (state.retroCoveredAttempts ?? []).filter((key) => keepRow(coveredAttemptRow(key))).slice(-MAX_RETRO_RECEIPT_IDS);
  const workerFinishes = state.workerFinishes.filter(
    (finish) => now - finish.at < RECENT_FINISH_MS || keepRow(finish.row),
  );
  const recentJobIds = new Set(workerFinishes.map((finish) => finish.jobId));
  const seenJobIds = state.seenJobIds.filter((id) => recentJobIds.has(id));
  for (const id of state.seenJobIds.slice(-MAX_SEEN_JOB_IDS)) {
    if (!seenJobIds.includes(id)) seenJobIds.push(id);
  }
  return { ...state, seenRows, rowStatuses, reopenedRows, lastNotices, workerFinishes, seenJobIds, retroCoveredAttempts };
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
  for (const job of jobs.running) {
    if (job.status !== "running") continue;
    const id = job.agentId ?? job.id;
    children.set(id, { id, owner: job.agentId ? job.id : null, live: true });
  }
  const merged = [...children.values()];
  const settled = merged.filter((child) => !child.live);
  return settled.length <= MAX_SETTLED_CHILDREN
    ? merged
    : [...merged.filter((child) => child.live), ...settled.slice(-MAX_SETTLED_CHILDREN)];
}

/** IDs the current omp process knows: its task jobs plus explicitly live registry agents.
 * A persisted roster ID outside this set belongs to a process that no longer exists
 * (omp --resume brings no worker back), so it never proves staffing. */
function currentProcessChildIds(jobs: Jobs): Set<string> {
  return new Set([
    ...[...jobs.running, ...jobs.recent].flatMap((job) => job.agentId ? [job.id, job.agentId] : [job.id]),
    ...(jobs.nonJobAgents ?? []).filter((agent) => agent.live).map((agent) => agent.id),
  ]);
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
  ]);
  const settledIds = new Set(
    jobs.recent
      .filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled")
      .flatMap((job) => job.agentId ? [job.id, job.agentId] : [job.id]),
  );
  // Only current-process jobs or explicitly live registry entries prove resumability.
  const knownIds = currentProcessChildIds(jobs);
  return previous.filter((child) =>
    (knownIds.has(child.id) || (child.owner !== null && knownIds.has(child.owner))) &&
    !activeIds.has(child.id) && !(child.owner && activeIds.has(child.owner)) &&
    !settledIds.has(child.id) && !(child.owner && settledIds.has(child.owner)),
  );
}
const shorten = (text: string, max = MAX_LABEL) => text.replace(/\s+/g, " ").trim().slice(0, max);
const actionTarget = (text: string, width = 34) => truncateMiddleToWidth(JSON.stringify(text.replace(/\s+/g, " ")), width);
function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  if (typeof value === "object" && value !== null)
    return Object.values(value as Record<string, unknown>).some((item) => containsExactString(item, expected));
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
  externalOwnerProbe?: ExternalOwnerProbe;
  restoredChildren?: PersistedChild[];
  persistedChildren?: PersistedChild[];
  isMainSession: boolean;
  taskEnabled: boolean;
  now: number;
  /** Current Task worker cap when exposed by the host; 0 means Unlimited. */
  capacity?: number;
  /** Unique authenticated model routes that can start now, after Task and CPU limits. */
  startableCapacity?: number;
  /** Whether the host can enforce a Task call before another turn. */
  dispatchGateAvailable?: boolean;
  deadline?: { goalId: string; deadlineAt: number; timezone?: string; paused?: boolean };
  goalPaused?: boolean;
  lastWakeKey?: string | null;
  cachedStatic?: { key: string; text: string } | null;
  idleResumeAttempts?: ReadonlySet<string>;
  /** Presence guess from goal_deadlines; away parks user waits that have a proposal. */
  presence?: Presence;
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
  /** In-progress rows whose recorded owner matches no live task job, parked child or external wait. */
  lostOwners?: Array<{ content: string; owner: string }>;
  externallyStaffedCount?: number;
  deadline?: DispatchInput["deadline"];
  capacity?: number;
  activeTaskCount?: number;
  goalPaused?: boolean;
  staffingSnapshotComplete?: boolean;
  taskEnabled?: boolean;
  presence?: Presence;
  userWaits?: Array<{ content: string; question: string; proposal?: string }>;
  onProposal?: Array<[string, string[]]>;
  awayWorkList?: string[];
}

function staticKey(
  phases: TodoScheduleInput,
  jobs: Jobs | null,
  deadline: DispatchInput["deadline"],
  capacity: number | undefined,
  startableCapacity: number | undefined,
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
  const restoredKey = restored.map(({ id, owner, live }) => [id, owner, live])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const persistedKey = persisted.map(({ id, owner, live }) => [id, owner, live])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([tasks, jobKey, restoredKey, persistedKey, deadline ?? null, capacity ?? null, startableCapacity ?? null, goalPaused]);
}

function safeTimestamp(value: unknown, timeZone?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return "unknown";
  return formatLocalTimestamp(value, timeZone);
}

function localizeTimestampText(value: string, timeZone?: string): string {
  return value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/g, (timestamp) =>
    formatLocalTimestamp(Date.parse(timestamp), timeZone),
  );
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
function userWaitRows(phases: TodoScheduleInput): Array<{ content: string; question: string; proposal?: string }> {
  return phases.flatMap((phase) => phase.tasks).flatMap((task) => {
    const wait = task.status === "blocked" ? parseUserWait(task.blocker) : undefined;
    return wait ? [{ content: task.content, ...wait }] : [];
  });
}
function sprintSetKey(rows: string[]): string {
  return JSON.stringify([...rows].sort());
}
// A failed deploy/install job is how an updater or deploy rejection surfaces in the job
// snapshot; quota failures on other labels do not match.
const UPDATER_JOB_LABEL = /updat|deploy|install|publish|rollback|release|cutover/i;
// A completed install/updater job can still carry a rejection in its structured result: a
// non-zero install/updater/deploy exit or non-empty blocked/remaining gaps. The result records
// the same fact the receipt does, so derive the incident from it here, once.
function jobResultPayload(job: unknown): unknown {
  if (typeof job !== "object" || job === null) return undefined;
  return "result" in job ? job.result : "data" in job ? job.data : undefined;
}
function structuredInstallRejection(job: unknown): boolean {
  const result = jobResultPayload(job);
  if (typeof result !== "object" || result === null) return false;
  // Unchecked cast to a named const: job results are untyped at this extension boundary.
  const record = result as Record<string, unknown>;
  // Exit keys are matched across case and separators so a camelCase installExit reads the
  // same as install_exit, and a top-level terminal status of blocked/failed is a rejection.
  const normalised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) normalised[key.toLowerCase().replace(/[_\-\s]/g, "")] = value;
  const status = normalised.status;
  if (typeof status === "string" && ["blocked", "failed"].includes(status.trim().toLowerCase())) return true;
  for (const key of ["install_exit", "updater_exit", "deploy_exit", "exit_code"]) {
    const value = normalised[key.toLowerCase().replace(/[_\-\s]/g, "")];
    if (typeof value === "number" && value !== 0) return true;
    if (typeof value === "string" && value.trim() !== "" && value.trim() !== "0") return true;
  }
  for (const key of ["blocked", "remaining", "gaps"]) {
    const value = record[key];
    if (Array.isArray(value) && value.length > 0) return true;
    if (typeof value === "string" && value.trim() !== "") return true;
    if (typeof value === "object" && value !== null && Object.keys(value).length > 0) return true;
  }
  return false;
}
function dispatchedResultAgent(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("agent" in result)) return undefined;
  const agent: unknown = result.agent;
  return typeof agent === "string" ? agent : undefined;
}
function isCorrectionInput(text: string, source: string): boolean {
  if (source === "extension") return false;
  // Only whole correction phrases in user text count; profanity and event metadata do not.
  return /(?<![\p{L}])(?:не то|не так|опять|я же просил)(?![\p{L}])/iu.test(text);
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
function retroFacilitatorResultId(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || !("details" in event)) return undefined;
  const details = event.details;
  if (typeof details !== "object" || details === null || !("results" in details)) return undefined;
  const results = details.results;
  if (!Array.isArray(results)) return undefined;
  const match = results.find((result) => typeof result === "object" && result !== null && "agent" in result && result.agent === "retro-facilitator");
  if (typeof match !== "object" || match === null || !("id" in match)) return undefined;
  return typeof match.id === "string" ? match.id : undefined;
}
// Scan window paired with MAX_RETRO_RECEIPT_IDS: only receipts in the tail can be new, and only
// retained ids are remembered, so an evicted receipt outside the window is never rediscovered and
// re-clears demand. A receipt older than the window that was never processed keeps the old
// behavior (demand persists until the next retro) instead of breaking the cap.
const RETRO_RECEIPT_SCAN_ENTRIES = 500;
function recentBranchMessages(ctx: ExtensionContext) {
  let branchEntryCount = 0;
  selectBranchEntries(ctx.sessionManager, () => {
    branchEntryCount += 1;
    return false;
  });
  let branchIndex = 0;
  // Keep the original last-500-branch-entry window, not the last 500 matching messages.
  const entries = selectBranchEntries(ctx.sessionManager, (metadata) => {
    const inWindow = branchIndex++ >= branchEntryCount - RETRO_RECEIPT_SCAN_ENTRIES;
    return inWindow && (metadata.type === "message" || metadata.type === "custom_message");
  });
  return entries;
}
export function branchRetroReceiptIds(ctx: ExtensionContext, entries = recentBranchMessages(ctx)): string[] {
  const found: string[] = [];
  const scan = (text: string) => {
    for (const tag of text.match(/<task-result\b[^>]*>/g) ?? []) {
      if (!tag.includes('agent="retro-facilitator"') || !tag.includes('status="completed"')) continue;
      const id = tag.match(/\bid="([^"]+)"/)?.[1];
      if (id !== undefined && !found.includes(id)) found.push(id);
    }
  };
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("type" in entry)) continue;
    const content = entry.type === "message"
      ? (typeof entry.message === "object" && entry.message !== null && "content" in entry.message ? entry.message.content : undefined)
      : ("content" in entry ? entry.content : undefined);
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
    for (const part of parts) {
      if (typeof part === "string") scan(part);
      else if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") scan(part.text);
    }
  }
  return found;
}

// Async dispatch returns no inline results; the real worker completion arrives later as an
// async-result `<task-result status="completed">…<output>…</output>…</task-result>` on the branch.
// Reconcile those completed updater jobs here so settleSprintJobs sees their rejection payloads.
export function branchAsyncTaskResults(ctx: ExtensionContext, entries = recentBranchMessages(ctx)): (Jobs["recent"][number] & { result?: unknown })[] {
  const out: (Jobs["recent"][number] & { result?: unknown })[] = [];
  const scan = (text: string) => {
    for (const match of text.matchAll(/<task-result\b[^>]*>([\s\S]*?)<\/task-result>/g)) {
      const block = match[0];
      const status = /<task-result\b[^>]*\bstatus="([^"]*)"/i.exec(block)?.[1];
      if (status !== "completed") continue;
      const outputText = /<output>([\s\S]*?)<\/output>/.exec(match[1])?.[1]?.trim();
      if (!outputText) continue;
      const idMatch = /\bid="([^"]*)"/.exec(/<task-result\b[^>]*>/i.exec(block)?.[0] ?? "");
      const jobId = idMatch?.[1] ?? `async-${out.length}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(outputText);
      } catch {
        continue;
      }
      if (!UPDATER_JOB_LABEL.test(jobId)) continue;
      out.push({
        id: jobId,
        type: "task",
        status: "completed",
        label: jobId,
        startTime: 0,
        result: parsed,
      });
    }
  };
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("type" in entry)) continue;
    const content = entry.type === "message"
      ? (typeof entry.message === "object" && entry.message !== null && "content" in entry.message ? entry.message.content : undefined)
      : ("content" in entry ? entry.content : undefined);
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
    for (const part of parts) {
      if (typeof part === "string") scan(part);
      else if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") scan(part.text);
    }
  }
  return out;
}
function taskDetails(task: TaskRow, timeZone?: string): string {
  const schedule = task.schedule && typeof task.schedule === "object" ? task.schedule : undefined;
  if (!schedule) return "schedule=missing";
  const estimate = schedule.estimate
    ? `${schedule.estimate.optimisticSeconds}/${schedule.estimate.likelySeconds}/${schedule.estimate.pessimisticSeconds}s ${safeText(schedule.estimate.confidence)}; basis=${safeText(schedule.estimate.basis, 80)}; updated=${safeTimestamp(schedule.estimate.updatedAt, timeZone)}`
    : "MISSING estimate";
  const dependencies = Array.isArray(schedule.dependencies)
    ? JSON.stringify(schedule.dependencies)
    : "unknown";
  const resources = Array.isArray(schedule.resources) ? JSON.stringify(schedule.resources) : "unknown";
  const progress = schedule.progress
    ? `${safeTimestamp(schedule.progress.at, timeZone)}:${safeText(schedule.progress.evidence, 120)}`
    : "none";
  const revision = schedule.estimateRevision ?? (schedule.estimate ? 1 : 0);
  const reestimates = schedule.reestimateCount ?? 0;
  return `owner=${JSON.stringify(schedule.owner ?? null)}; dependencies=${dependencies}; resources=${resources}; O/L/P=${estimate}; progress=${progress}; estimateRevision=${revision}; reestimateCount=${reestimates}; attemptHistory=${JSON.stringify(schedule.attemptHistory ?? [])}`;
}

function buildStaticPrompt(
  rows: SnapshotRow[],
  jobs: Jobs | null,
  deadline: DispatchInput["deadline"],
  capacity: number | undefined,
  startableCapacity: number | undefined,
  goalPaused: boolean,
  restored: PersistedChild[],
): string {
  const nonclosedCount = rows.filter(({ task }) => isNonClosedRowStatus(task.status)).length;
  let closedBudget = Math.max(0, MAX_ROWS - nonclosedCount);
  const snapshotRows = rows.filter(({ task }) => isNonClosedRowStatus(task.status) || closedBudget-- > 0);
  const snapshotLines: string[] = [];
  let lastPhase: string | undefined;
  for (const { number, phase, task } of snapshotRows) {
    if (phase !== lastPhase) snapshotLines.push(`${JSON.stringify(phase)}:`);
    lastPhase = phase;
    const blocker = task.status === "blocked" ? `; blocker=${JSON.stringify(task.blocker ?? "not recorded")}` : "";
    const closed = task.status === "completed" || task.status === "abandoned";
    snapshotLines.push(`  #${number} [${task.status}] ${JSON.stringify(task.content)}${blocker}${closed ? "" : `; ${taskDetails(task, deadline?.timezone)}`}`);
  }
  if (rows.length > snapshotRows.length)
    snapshotLines.push(`… ${rows.length - snapshotRows.length} closed rows omitted; every nonclosed row is included`);

  const running = jobs?.running ?? [];
  const recentTasks = jobs?.recent.filter((job) => job.type === "task") ?? [];
  const jobLines = (list: typeof running) =>
    list.map((job) =>
      `- ${JSON.stringify(job.id)} ${job.status} agent=${JSON.stringify(job.agentId ?? null)} label=${JSON.stringify(shorten(job.label))}`,
    );
  const runningLines = jobLines(running);
  const recentLines = jobLines(recentTasks).slice(0, MAX_ROWS);
  if (recentTasks.length > MAX_ROWS) recentLines.push(`- ${recentTasks.length - MAX_ROWS} more recent task jobs; inspect live hub jobs`);
  const restoredLines = restored.map(({ id, owner, live }) =>
    `- id=${JSON.stringify(id)} owner=${JSON.stringify(owner)} last-known-live=${live}`,
  );
  const openCount = rows.filter(({ task }) => task.status === "pending" || task.status === "in_progress").length;
  const blockedCount = rows.filter(({ task }) => task.status === "blocked").length;
  const shownCapacity = startableCapacity ?? (capacity === undefined ? "unknown" : capacity === 0 ? "unlimited" : capacity);
  return [
    "[TODO supervisor; advisory, not a user request]",
    `TODO rows ${snapshotRows.length}/${rows.length}; open=${openCount}; blocked=${blockedCount}; tail=${Math.max(0, rows.length - snapshotRows.length)}; Task cap=${shownCapacity}. Rows follow canonical order:`,
    ...(snapshotLines.length ? snapshotLines : ["- none"]),
    "Owner labels are not active staffing proof: count exact IDs in running task jobs or a persisted parked child matching a task-child owner. Idle live agents may be re-staffed but do not count as staffed. Do not dispatch blocked or dependency-waiting rows. Main coordinates staffed work; if Task dispatch is unavailable, main may do bounded safe work directly rather than leave the deliverable untouched.",
    goalPaused
      ? "Paused goal: observation only; require evidence-based current O/L/P plus confidence for every nonclosed row, the full remaining scope, and exact Task/parked-child roster. Do not start Task jobs or perform autonomous goal work."
      : "Schedule every pending/in-progress/blocked row before work: evidence-based O/L/P plus confidence, explicit dependencies ([] only if proven independent), owner and exclusive resources when known; inspect/ask on unknowns, split pessimistic work >1h, and recover blockers safely. Once recorded, do not repeat planning without a new fact; move to the next deliverable-producing action.",
    `Fixed native deadline: ${deadline ? `${JSON.stringify(deadline.goalId)} at ${safeTimestamp(deadline.deadlineAt, deadline.timezone)} (immutable${goalPaused ? "; paused: observation only, no autonomous goal work" : ""})` : goalPaused ? "paused goal; deadline unavailable through host API (observation only, no autonomous goal work)" : "none"}.`,
    `Running task jobs (${running.length}; session-owned):`,
    ...(jobs === null ? ["- snapshot unavailable; inspect live hub state"] : runningLines.length ? runningLines : ["- none"]),
    `Recent task jobs (${recentTasks.length}; reconcile exact settlements):`,
    ...(jobs === null ? ["- snapshot unavailable"] : recentLines.length ? recentLines : ["- none"]),
    `Parked/restored child roster (${restored.length}; persisted last-known IDs, not proof of liveness):`,
    ...(restoredLines.length ? restoredLines : ["- none"]),
    goalPaused
      ? "Paused observation only: reconcile every running job and parked/restored child against TODO ownership with exact IDs; do not resume or start jobs. An empty live snapshot is not nothing-to-reconcile."
      : "Reconcile every running job and parked/restored child against TODO ownership before another batch. Require an exact resume of idle owners; fresh-dispatch only ready rows disjoint from all roster-owned work. An empty live snapshot is not nothing-to-reconcile.",
  ].join("\n");
}

function compactForecastRow(row: TodoTaskForecast, timeZone?: string): string {
  return [
    `ready=${row.ready ? "yes" : "no"}`,
    row.awaitingPrerequisite ? `await=${JSON.stringify(row.awaitingPrerequisite)}` : undefined,
    `CPM=${safeTimestamp(row.earliestStart, timeZone)}/${safeTimestamp(row.earliestFinish, timeZone)}/${safeTimestamp(row.latestStart, timeZone)}/${safeTimestamp(row.latestFinish, timeZone)}`,
    `float=${Number.isFinite(row.totalFloatSeconds) ? `${Math.round(row.totalFloatSeconds!)}s` : "?"}/${Number.isFinite(row.freeFloatSeconds) ? `${Math.round(row.freeFloatSeconds!)}s` : "?"}`,
    `resource=${safeTimestamp(row.resourceStart, timeZone)}..${safeTimestamp(row.resourceFinish, timeZone)}; expected=${safeTimestamp(row.expectedResourceFinish, timeZone)}`,
    `PERT=${Number.isFinite(row.fixedPathExpectedSeconds) ? `${Math.round(row.fixedPathExpectedSeconds!)}s` : "?"}/${Number.isFinite(row.fixedPathSigmaSeconds) ? `${Math.round(row.fixedPathSigmaSeconds!)}s` : "?"}; P95=${safeTimestamp(row.fixedPathP95Finish ?? row.resourceFinish, timeZone)}`,
    `critical=${row.criticalityKnown === false ? "unknown" : row.critical ? "yes" : "no"}`,
    row.overdue ? `MISSED-ETA revision=${row.estimateRevision}; reestimates=${row.reestimateCount}` : undefined,
    row.stale ? "STALE" : undefined,
  ].filter((part): part is string => part !== undefined).join(" ");
}

function displayClock(now: number, timeZone?: string): string {
  return safeTimestamp(now, timeZone);
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
export type ExternalWait = { kind: "unit" | "job"; name: string };
export type ExternalOwnerProbe = (wait: ExternalWait, jobs: Jobs | null) => boolean;

/** External wait owners reuse the existing TODO ownership slot. */
export function parseExternalWait(owner: string | null | undefined): ExternalWait | null {
  const match = typeof owner === "string" ? /^(unit|job):(.+)$/i.exec(owner) : null;
  const name = match?.[2]?.trim();
  return name ? { kind: match![1]!.toLowerCase() as ExternalWait["kind"], name } : null;
}

export function isExternalWaitRunning(wait: ExternalWait, jobs: Jobs | null = null): boolean {
  if (wait.kind === "unit") {
    try {
      const out = spawnSync("systemctl", ["--user", "is-active", "--", wait.name], { encoding: "utf8", timeout: 5_000 });
      return out.status === 0 && out.stdout.trim() === "active";
    } catch {
      return false;
    }
  }
  if (wait.kind === "job" && jobs?.running.some((job) => job.id === wait.name && job.status === "running")) return true;
  if (wait.kind === "job" && /^\d+$/.test(wait.name)) {
    try {
      statSync(join("/proc", wait.name));
      return true;
    } catch {
      return false;
    }
  }
  return false;
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
  const startableCapacity =
    typeof input.startableCapacity === "number" &&
    Number.isFinite(input.startableCapacity) &&
    Number.isInteger(input.startableCapacity) &&
    input.startableCapacity >= 0
      ? input.startableCapacity
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

  const key = staticKey(phases, jobs, deadline, capacity, startableCapacity, goalPaused, input.restoredChildren ?? [], input.persistedChildren ?? []);
  let staticPrompt = input.cachedStatic?.key === key ? input.cachedStatic.text : undefined;
  if (staticPrompt === undefined) {
    const snapshotRows: SnapshotRow[] = [];
    for (const phase of phases)
      for (const task of phase.tasks)
        snapshotRows.push({ number: snapshotRows.length + 1, phase: phase.name, task });
    staticPrompt = buildStaticPrompt(snapshotRows, jobs, deadline, capacity, startableCapacity, goalPaused, input.restoredChildren ?? []);
  }
  const away = input.presence === "away";
  const parking = away ? parkUserWaits(phases) : { phases, parked: [], onProposal: new Map<string, string[]>() };
  const parkedContent = new Set(parking.parked.map((row) => row.content));
  const userWaits = userWaitRows(phases);
  const forecast = sdk.forecastTodoPlan(parking.phases, {
    now,
    deadlineAt: deadline?.deadlineAt,
    ...(capacity === undefined ? {} : { capacity }),
  });
  const basePlanningIssues = forecast.planningIssues ?? sdk.getTodoPlanningIssues?.(phases) ?? [];
  const planningIssues = [
    ...basePlanningIssues,
    ...getUserWaitPlanningIssues(phases).filter((issue) =>
      !basePlanningIssues.some((known) => known.code === issue.code && known.task === issue.task),
    ),
  ];
  const obligatedContent = new Set(obligated.map(({ task }) => task.content));
  const forecastRows = forecast.rows.filter((row) => obligatedContent.has(row.content));
  const forecastLines = forecastRows.map((row) =>
    `- [${row.status}] ${JSON.stringify(shorten(row.content))}: ${compactForecastRow(row, deadline?.timezone)}`,
  );
  const missing = planningIssues
    .filter((issue) => issue.code === "missing-estimate")
    .map((issue) => issue.task);
  const stale = forecast.rows
    .filter((row) => obligatedContent.has(row.content) && row.stale)
    .map((row) => row.content);
  const openContent = new Set(open.map(({ task }) => task.content));
  const activeTaskJobs =
    jobs?.running.filter((job) => job.type === "task" && job.status === "running") ?? [];
  // A roster entry persisted before a restart is staffing proof only while the current process
  // still knows that child; otherwise its row is lost/unstaffed, not exactly running (live
  // 2026-10-15: SurfaceDroppedFact reported staffed for ~5.4h with 0 running jobs).
  const knownChildIds = jobs === null ? null : currentProcessChildIds(jobs);
  const persistedTaskChildren = (input.persistedChildren ?? []).filter((child) =>
    knownChildIds === null || knownChildIds.has(child.id) || (child.owner !== null && knownChildIds.has(child.owner))
  );
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
    return child;
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
  const externalOwners = new Map<string, boolean>();
  for (const { task } of open) {
    const owner = task.schedule?.owner;
    const wait = parseExternalWait(owner);
    if (!wait || externalOwners.has(owner!)) continue;
    try {
      externalOwners.set(owner!, (input.externalOwnerProbe ?? isExternalWaitRunning)(wait, jobs) === true);
    } catch {
      externalOwners.set(owner!, false);
    }
  }
  const externallyStaffedCount = open.filter(({ task }) => externalOwners.get(task.schedule?.owner ?? "") === true).length;
  const ownerHasActiveTask = (owner: string | null) =>
    owner !== null && (
      activeTaskJobs.some((job) => liveJobMatchesOwner(job, owner)) ||
      livePersistedChildForOwner(owner) !== undefined ||
      externalOwners.get(owner) === true
    );
  const ownerRunStates = open.map(({ task }) => {
    const owner = typeof task.schedule?.owner === "string" ? task.schedule.owner : null;
    return { content: task.content, owner, running: owner !== null && (activeTaskJobs.some((job) => liveJobMatchesOwner(job, owner)) || externalOwners.get(owner) === true) };
  });
  const runningOwnedContents = new Set(
    open
      .filter(({ task }) => {
        const owner = typeof task.schedule?.owner === "string" ? task.schedule.owner : null;
        return owner !== null && ownerHasActiveTask(owner);
      })
      .map(({ task }) => task.content),
  );
  const lostOwners = jobs !== null
    ? open.flatMap(({ task }) => {
        const owner = task.schedule?.owner;
        return task.status === "in_progress" && typeof owner === "string" && !ownerHasActiveTask(owner)
          ? [{ content: task.content, owner }]
          : [];
      })
    : [];
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
      const activeRestoredChild = livePersistedChildForOwner(owner);
      const restoredOwner = owner === null
        ? undefined
        : input.restoredChildren?.find((child) => child.id === owner || child.owner === owner);
      const jobByAgentId = owner === null
        ? undefined
        : activeTaskJobs.find((active) => active.agentId === owner);
      const jobById = owner === null
        ? undefined
        : activeTaskJobs.find((active) => active.id === owner || active.id.replace(/-\d+$/, "") === owner);
      const liveWorkerId =
        jobByAgentId?.agentId || (jobById ? jobById.agentId || jobById.id : undefined) ||
        activeRestoredChild?.id;
      const sharedLiveOwner = liveWorkerId !== undefined && claimedLiveWorkerIds.has(liveWorkerId);
      if (liveWorkerId !== undefined && !sharedLiveOwner) claimedLiveWorkerIds.add(liveWorkerId);
      const ownership = externalOwners.get(owner ?? "") === true
        ? "live-owned" as const
        : sharedLiveOwner
          ? "shared-live-owner" as const
          : liveWorkerId !== undefined
            ? "live-owned" as const
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
  // A ready row already in progress whose owner just completed is an unread result waiting
  // to be closed (live 2026-10-12: Fix #115 re-staffed after Fix115Countdown completed), not
  // re-staffed. A pending row with a completed owner was never worked and still reopens;
  // failed or cancelled owners stay dispatchable: that row still needs a worker.
  const completedTaskOwners = new Set(
    (jobs?.recent ?? [])
      .filter((job) => job.type === "task" && job.status === "completed")
      .flatMap((job) => [job.id, job.agentId ?? job.id, job.id.replace(/-\d+$/, "")]),
  );
   const staffingSnapshotComplete = jobs !== null;
   const dispatchableReady = ownerlessReady.filter(
     (candidate) =>
       staffingSnapshotComplete &&
      !(candidate.owner !== null && completedTaskOwners.has(candidate.owner) &&
        openTasksByContent.get(candidate.content)?.status === "in_progress") &&
      // A restored owner that is not running after startup is dead (omp --resume brings nobody back):
      // its row is staffed again under the owner's name (live 21:48: 0 of 20 ran while two such rows waited).
      resourceExecutableContents.has(candidate.content) &&
      !(candidate.ownership === "idle-live-owner" && candidate.owner !== null && input.idleResumeAttempts?.has(candidate.owner)) &&
      !(candidate.owner === null && (input.restoredChildren?.length ?? 0) > 0),
  );
  const actionableReadyContents = new Set(
    staffingSnapshotComplete && taskEnabled && !goalPaused && capacity !== undefined &&
      (startableCapacity === undefined
        ? capacity === 0 || activeTaskJobs.length < capacity
        : activeTaskJobs.length < startableCapacity)
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
              ? "Every dependency-ready row has an exact running owner; do not duplicate them."
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
  // A user-wait with a proposal is parked while away, not a recovery failure.
  const recoveryBlocked = blocked.filter(({ task }) => !parkedContent.has(task.content));
  for (const { task } of recoveryBlocked)
    alarmSet.add(`blocked-recovery:${JSON.stringify(task.content)}:${JSON.stringify(task.blocker ?? null)}`);
  for (const row of ownerlessReady) alarmSet.add(`ownerless-ready:${JSON.stringify(row.content)}`);
  for (const job of failedTasks) alarmSet.add(`failed-child:${job.id}:${job.status}`);
  for (const row of forecast.rows) {
    if (!obligatedContent.has(row.content)) continue;
    if (row.overdue && !runningOwnedContents.has(row.content))
      alarmSet.add(`missed-eta:${JSON.stringify(row.content)}:${row.estimateRevision}`);
    if (row.latestStart !== undefined && now >= row.latestStart)
      alarmSet.add(`late-start:${JSON.stringify(row.content)}:${row.latestStart}`);
    if (row.stale)
      alarmSet.add(
        `stale-estimate:${JSON.stringify(row.content)}:${row.estimateUpdatedAt ?? null}`,
      );
  }
  const missed = forecast.rows.filter((row) => openContent.has(row.content) && row.overdue && !runningOwnedContents.has(row.content));
  const executableMissed = forecast.rows.filter(
    (row) => actionableReadyContents.has(row.content) && row.ready && row.overdue && !runningOwnedContents.has(row.content) &&
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
  const planNeedsDiagnosis = planningIssues.length > 0 || recoveryBlocked.length > 0;
  const listNames = (list: string[]) =>
    list.slice(0, 6).map((content) => JSON.stringify(shorten(content))).join(", ") +
    (list.length > 6 ? `, … ${list.length - 6} more` : "");
  const awayWorkList: string[] = [];
  // Scoped to plans with user waits: without one, parking, issues and prompt lines are
  // already no-ops, so the wait/wake gates stay exactly as today for such plans.
  if (away && !goalPaused && userWaits.length > 0 && dispatchableReady.length === 0) {
    const noProposal = userWaits.filter((wait) => wait.proposal === undefined).map((wait) => wait.content);
    if (noProposal.length)
      awayWorkList.push(`rows waiting for the user without your proposal: ${listNames(noProposal)}; ${USER_WAIT_SELF_FILL}`);
    const holds = (content: string) =>
      open.filter(({ task }) => Array.isArray(task.schedule?.dependencies) && task.schedule.dependencies.includes(content)).length;
    const stuck = recoveryBlocked
      .map(({ task }) => ({ content: task.content, holds: holds(task.content) }))
      .sort((a, b) => b.holds - a.holds);
    if (stuck.length)
      awayWorkList.push(`decompose the blocked rows into independent subtasks that can start now, the ones holding other rows first: ${stuck.slice(0, 6).map((row) => `${JSON.stringify(shorten(row.content))}${row.holds ? ` (holds ${row.holds})` : ""}`).join(", ")}${stuck.length > 6 ? `, … ${stuck.length - 6} more` : ""}`);
    const runningContent = new Set(ownerRunStates.filter((row) => row.running).map((row) => row.content));
    const idleOpen = open.map(({ task }) => task.content).filter((content) => !runningContent.has(content));
    if (idleOpen.length)
      awayWorkList.push(`for each open row without a running worker, one line on why it cannot start now, and take any that can: ${listNames(idleOpen)}`);
    const finished = phases
      .flatMap((phase) => phase.tasks)
      .filter((task) => task.status === "completed" && typeof task.schedule?.finishedAt === "number" && now - task.schedule.finishedAt <= RECENT_FINISH_MS)
      .sort((a, b) => b.schedule!.finishedAt! - a.schedule!.finishedAt!)
      .map((task) => task.content);
    if (finished.length)
      awayWorkList.push(`quality pass over recently finished rows: re-verify each one's acceptance evidence and look for defects: ${listNames(finished)}`);
  }
  const rawWakeKey =
    taskEnabled && !goalPaused &&
    ((deadline !== undefined && (executableMissed.length > 0 || planNeedsDiagnosis || (alarms.length > 0 && executableReady))) || awayWorkList.length > 0)
      ? JSON.stringify([deadline ?? null, capacity ?? null, alarmRevision, alarms, readyFacts, awayWorkList])
      : null;
  const wakeKey = rawWakeKey !== null && rawWakeKey !== lastWakeKey ? rawWakeKey : null;
  const planSummary = localizeTimestampText(sdk.formatPlanForecast(forecast, now), deadline?.timezone);
  const forecastIssues = forecast.issues.map((issue) => `- ${JSON.stringify(issue)}`);
  const planningIssueLines = planningIssues
    .map((issue) => `- [${issue.code}] ${JSON.stringify(issue.task)}: ${issue.message}`);
  const corrections = missed
    .map((row) => row.reestimateCount >= 5
      ? `EXHAUSTED ${JSON.stringify(row.content)}: reestimates=${row.reestimateCount}. Do not reestimate this same row again; record the previous attempt's receipt and failing acceptance check, then split the remaining scope into new rows.`
      : `- ${JSON.stringify(row.content)}: revision=${row.estimateRevision}; reestimates=${row.reestimateCount}`);
  const repeatedEstimates = forecastRows.filter((row) => row.reestimateCount >= 3);
  const prompt = [
    ...(!goalPaused && deadlineRisk
      ? ["DELIVERY FIRST: the fixed deadline is at risk. Name the exact missing user-visible artifact and its current version; take the shortest safe action that creates or updates it now. Do not re-read the same plan, reforecast, or rerun broad checks without a changed artifact or a specific new diagnostic question. Reconcile workers only to unblock real work; report the remaining gap without moving the deadline or silently shrinking scope. No automatic paid/model escalation."]
      : []),
    staticPrompt,
    `Now=${displayClock(now, deadline?.timezone)}; ETA anchored to recorded estimates/real starts, not redraw time.`,
    `Whole-plan CPM/resource/P95: ${planSummary}. Shared predecessors and resource assumptions bound confidence; this is not an optimum.`,
    `Planning issues (${planningIssues.length}):`,
    ...(planningIssueLines.length ? planningIssueLines : ["- none"]),
    `Forecast issues (${forecast.issues.length}):`,
    ...(forecastIssues.length ? forecastIssues : ["- none"]),
    `Nonclosed row timing (${forecastRows.length}/${obligated.length}; CPM ES/EF/LS/LF, float, resource, PERT):`,
    ...(forecastLines.length ? forecastLines : ["- none"]),
    `Missing estimates (${missing.length}): ${missing.length ? missing.map((content) => JSON.stringify(content)).join(", ") : "none"}; stale (${stale.length}): ${stale.length ? stale.map((content) => JSON.stringify(content)).join(", ") : "none"}`,
    `Ready rows needing distinct live workers (${ownerlessReady.length}/${readyCandidates.length}): ${ownerlessReady.length ? ownerlessReady.map((row) => `${JSON.stringify(row.content)} [${row.ownership}; owner=${JSON.stringify(row.owner)}]`).join(", ") : "none"}`,
    ...(lostOwners.length
      ? [`Lost/unstaffed in-progress owners (${lostOwners.length}): ${lostOwners.map((row) => `${JSON.stringify(row.content)} [owner=${JSON.stringify(row.owner)}; not running]`).join(", ")}. No live task job or parked child matches these owners after resume; re-staff each row under its owner name or a new owner.`]
      : []),
    `Dependency-waiting rows (${dependencyUnready.length}; do not dispatch): ${dependencyUnready.length ? dependencyUnready.map((row) => `${JSON.stringify(row.content)}${row.awaitingPrerequisite ? ` [awaiting ${JSON.stringify(row.awaitingPrerequisite)}]` : ""}`).join(", ") : "none"}`,
    `Dispatch: ${dispatchDirective}`,
    ...(userWaits.length
      ? [`Rows waiting for the user (${userWaits.length}): ${userWaits.slice(0, MAX_ROWS).map((wait) => `${JSON.stringify(shorten(wait.content))} → ${wait.proposal ? `proposal: ${JSON.stringify(shorten(wait.proposal))}` : "NO PROPOSAL: fill in your own first"}`).join("; ")}. ${away ? "The user is away: rows with a proposal are parked until the user returns (no recovery, not in the ETA)." : "The user is here: put each question to the user, with your proposal."}`]
      : []),
    ...(parking.onProposal.size
      ? [`Rows proceeding on a proposal (re-check each when the user answers): ${[...parking.onProposal].slice(0, MAX_ROWS).map(([content, on]) => `${JSON.stringify(shorten(content))} on proposal of ${on.map((row) => JSON.stringify(shorten(row))).join(", ")}`).join("; ")}`]
      : []),
    `Alarm facts: ${alarms.length ? alarms.join("; ") : "none"}`,
    ...(corrections.length ? ["MISSED ETA: inspect exact worker/artifact and failed assumption, then write proc://<owner>/kill, read its receipt and schedule the remainder under a new owner (name the -strong variant when one exists) or split it into new rows; reestimating the same owner is refused.", ...corrections] : []),
    ...(repeatedEstimates.length ? ["Repeated estimate changes are preserved failure evidence even when the current ETA is not overdue. Inspect the exact failed attempts, receipts and assumptions; choose a concrete recovery action or explain the genuine wait. Do not clear the warning by editing the ETA.", ...repeatedEstimates.map((row) => `- ${JSON.stringify(row.content)}: revision=${row.estimateRevision}; reestimates=${row.reestimateCount}`)] : []),
    "Never claim there is no actionable work from a truncated display: every nonclosed row above must have a next action or a genuine dependency/approval wait. Act on ready unstaffed rows within actual capacity; preserve healthy running owners and external approval gates.",
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
      !taskEnabled || goalPaused || (deadline === undefined && awayWorkList.length === 0)
        ? null
        : deadline === undefined
          ? MAX_IDLE_RECHECK_MS
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
    lostOwners,
    externallyStaffedCount,
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
    presence: input.presence,
    userWaits,
    onProposal: [...parking.onProposal],
    awayWorkList,
  };

}
/** Per-worker bookkeeping for critical-path /fast: the (wanted, model) pair last sent to
 * setSubagentFastMode and whether priority is actually realized for it. */
export type CriticalFastState = Map<string, { modelKey: string | undefined; wanted: boolean; on: boolean }>;

// A worker whose row is on the critical path gets /fast; the harness sets it from the plan, not the
// model (user 2026-09-24: "If a worker's task is on the critical path, it gets /fast"). Needs omp's
// ctx.setSubagentFastMode (fork PR #8); older builds skip this silently. setFastMode returns false —
// and emits "The current model has no service-tier control" — for models without a tier knob
// (muse-code/kimi-code), so a failed attempt is retried only when the worker's model changes (a
// fallback to another family re-applies /fast for the new model), never every request. Fast counts
// as on only when the call succeeded AND the worker's model realizes priority on the wire.
export function syncCriticalFast(
  ctx: ExtensionContext,
  decision: { forecast?: { rows?: TodoTaskForecast[] } | null },
  fastByWorker: CriticalFastState,
): void {
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
    const model = AgentRegistry.global().get(id)?.session?.model;
    const modelKey = model ? `${model.provider}/${model.id}` : undefined;
    const prior = fastByWorker.get(id);
    // Re-apply only when the wanted state or the worker's model changed: a failed attempt must not
    // repeat every request (each call re-emits the no-service-tier notice on tier-less models), but
    // a fallback to another family re-applies /fast.
    if (prior && prior.wanted === enabled && prior.modelKey === modelKey) continue;
    try {
      const ok = setFast.call(ctx, id, enabled) === true;
      fastByWorker.set(id, {
        modelKey,
        wanted: enabled,
        on: ok && (!enabled || (model ? realizesPriorityServiceTier("priority", model) : false)),
      });
    } catch {
      // Not our child or already gone: leave no record so the next request retries if it is listed.
      fastByWorker.delete(id);
    }
  }
  for (const id of [...fastByWorker.keys()]) if (!want.has(id)) fastByWorker.delete(id);
}

export default async function todoDispatch(pi: ExtensionAPI, options: { externalOwnerProbe?: ExternalOwnerProbe } = {}): Promise<void> {
  const singleWriterLane = process.env.OMP_LANE_UNIT !== undefined;
  const host = pi.pi;
  const hostSdk = host as DispatchForecastApi | undefined;
  if (!hostSdk?.forecastTodoPlan || !hostSdk.formatPlanForecast || !hostSdk.formatTaskForecast) return;
  const sdk = {
    forecastTodoPlan: hostSdk.forecastTodoPlan,
    formatPlanForecast: hostSdk.formatPlanForecast,
    formatTaskForecast: hostSdk.formatTaskForecast,
    getTodoPlanningIssues: hostSdk.getTodoPlanningIssues,
    readGoalDeadline: hostSdk.readGoalDeadline ?? readGoalDeadline,
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
  // Agents named by each task dispatch: a result that arrives empty or from an agent
  // that was never dispatched means the row's owner did not do the dispatched work.
  const dispatchedAgents = new Map<string, string[]>();
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
    criticalSplitWait = null;
    lateWaitRefusalKey = null;
  };
  let sprintLiveRows: ReadonlySet<string> | null = null;
  let sprintFlushScheduled = false;
  // Prune to live rows before writing, and coalesce a burst of changes inside one turn into one
  // entry: appends are immutable entries, so every write is another full snapshot in the branch.
  const flushSprintState = () => {
    sprintFlushScheduled = false;
    sprintState = pruneSprintState(sprintState, sprintLiveRows);
    const json = JSON.stringify(sprintState);
    if (json === persistedSprintStateJson) return;
    persistedSprintStateJson = json;
    pi.appendEntry(SPRINT_STATE_ENTRY_TYPE, sprintState);
  };
  const persistSprintState = () => {
    if (sprintFlushScheduled) return;
    sprintFlushScheduled = true;
    queueMicrotask(flushSprintState);
  };
  // `identity` is the stable fingerprint of what the notice says (defaults to the full text): a notice
  // whose rendered text only differs by minute counters or worker telemetry must not look new.
  const sendHarnessNotice = (kind: string, rowKey: string, content: string, details?: unknown, identity: string = content, delivery: { triggerTurn?: boolean; interruptWait?: boolean } = {}): boolean => {
    const key = noticeKey(kind, rowKey);
    const digest = noticeDigest(identity);
    if (sprintState.lastNotices[key] === digest) {
      pi.appendEntry("todo-dispatch-silent-notice", { kind, digest, at: Date.now() });
      return false;
    }
    const { [key]: _previous, ...others } = sprintState.lastNotices;
    sprintState = { ...sprintState, lastNotices: boundedNotices({ ...others, [key]: digest }) };
    persistSprintState();
    pi.sendMessage(
      { customType: kind, content, display: false, attribution: "agent", ...(details === undefined ? {} : { details }) },
      { deliverAs: "aside", triggerTurn: false, interruptWait: false, ...delivery },
    );
    return true;
  };
  const addSeenRow = (content: string) => {
    if (sprintState.seenRows.includes(content)) return;
    sprintState = { ...sprintState, seenRows: [...sprintState.seenRows, content] };
  };
  const setRetroDue = (reason: string, meta: { deadlineAt?: number; deliveryKey?: string } = {}) => {
    if (sprintState.retroDueReason) {
      const newWindow = reason === sprintState.retroDueReason && (
        (meta.deadlineAt !== undefined && meta.deadlineAt !== sprintState.retroDueDeadlineAt) ||
        (meta.deliveryKey !== undefined && meta.deliveryKey !== sprintState.retroDueDeliveryKey)
      );
      if (!newWindow) return;
    }
    sprintState = {
      ...sprintState,
      retroDueReason: reason,
      correctionPending: reason === "user correction" ? false : sprintState.correctionPending,
      ...(meta.deadlineAt === undefined ? { retroDueDeadlineAt: undefined } : { retroDueDeadlineAt: meta.deadlineAt }),
      ...(meta.deliveryKey === undefined ? { retroDueDeliveryKey: undefined } : { retroDueDeliveryKey: meta.deliveryKey }),
    };
  };
  // An empty or substituted worker result is an incident: the next retro must observe
  // expected vs actual from journals, receipts and transcripts.
  const reportWorkerResultIncident = (event: { toolCallId: string; details?: unknown }) => {
    const details = event.details;
    const results = details !== null && typeof details === "object" && "results" in details
      ? details.results
      : undefined;
    if (!Array.isArray(results) || results.length === 0) {
      // An async dispatch returns no inline results while its workers are still pending; the
      // completion arrives later as an async-result. That is not an empty worker result.
      const progress = details !== null && typeof details === "object" && "progress" in details
        ? details.progress
        : undefined;
      if (Array.isArray(progress) && progress.length > 0) return;
      setRetroDue("empty worker result");
      persistSprintState();
      return;
    }
    const dispatched = dispatchedAgents.get(event.toolCallId) ?? [];
    dispatchedAgents.delete(event.toolCallId);
    if (dispatched.length === 0) return;
    const substituted = results.some((result) => {
      const agent = dispatchedResultAgent(result);
      return agent !== undefined && agent.length > 0 && !dispatched.includes(agent);
    });
    if (substituted) {
      setRetroDue("substituted worker result");
      persistSprintState();
    }
  };
  // Both task receipts and plan snapshots settle through this path. Remembering the
  // job ID here prevents a later timer tick from reopening a covered install incident.
  const settleSprintJobs = (jobs: Jobs["recent"], now: number) => {
    let facilitatorSettled = false;
    let updaterRejected = false;
    for (const job of jobs) {
      if (job.type !== "task" || !["completed", "failed"].includes(job.status)) continue;
      if (sprintState.seenJobIds.includes(job.id)) continue;
      const label = typeof job.label === "string" ? job.label : "";
      // Async dispatch settles the job snapshot before its structured result lands on the
      // branch. An updater-labelled completion with no result yet is not final: marking it seen
      // here would drop the rejection the later async-result carries (wave4b 2026-10-14). It
      // finalises when a result for the same id is evaluated; a failed job finalises immediately.
      const payload = jobResultPayload(job);
      const awaitingResult = job.status === "completed" && UPDATER_JOB_LABEL.test(label) &&
        (payload === undefined || payload === null);
      const id = job.agentId ?? job.id;
      const at = typeof job.startTime === "number" ? job.startTime : now;
      const facilitator = [job.agentId, job.label, job.id].some((name) => typeof name === "string" && retroFacilitatorJobs.has(name));
      if (facilitator && job.status === "completed") facilitatorSettled = true;
      if (UPDATER_JOB_LABEL.test(label) &&
        (job.status === "failed" || structuredInstallRejection(job))) updaterRejected = true;
      // Failed workers are usually provider refusals, not retro participants.
      sprintState = {
        ...sprintState,
        ...(awaitingResult ? {} : { seenJobIds: [...sprintState.seenJobIds, job.id] }),
        ...(job.status !== "completed" || facilitator || sprintState.workerFinishes.some((finish) => finish.jobId === job.id)
          ? {}
          : { workerFinishes: [...sprintState.workerFinishes, { jobId: job.id, id, at, row: label }] }),
      };
    }
    return { facilitatorSettled, updaterRejected };
  };
  const touchSprintState = (ctx: ExtensionContext, phases: TodoScheduleInput, jobs: Jobs | null, now: number, deadline: DispatchInput["deadline"], alarms: string[]) => {
    const tasks = phases.flatMap((phase) => phase.tasks);
    sprintLiveRows = new Set(tasks.map((task) => task.content));
    const open = tasks.filter((task) => isOpenRowStatus(task.status));
    const nonClosed = tasks.filter((task) => isNonClosedRowStatus(task.status));
    const seenJobIdsBefore = new Set(sprintState.seenJobIds);
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
    const recentMessages = recentBranchMessages(ctx);
    const { facilitatorSettled, updaterRejected } = settleSprintJobs([...branchAsyncTaskResults(ctx, recentMessages), ...(jobs?.recent ?? [])], now);
    // One persist per loop: a burst of background receipts used to persist a full snapshot per receipt.
    const freshReceipts = branchRetroReceiptIds(ctx, recentMessages).filter((receipt) => !sprintState.retroReceiptIds.includes(receipt));
    if (facilitatorSettled || freshReceipts.length > 0) finishRetro(freshReceipts.length > 0 ? freshReceipts : undefined, false, tasks.flatMap(rowAttemptKeys));
    if (open.length > 0 && sprintState.goalWorkStartedAt === null) {
      // Only finishes since the last retro start the next goal-work window; older ones were covered.
      const sinceRetro = sprintState.workerFinishes.filter((finish) => sprintState.lastRetroAt === null || finish.at >= sprintState.lastRetroAt);
      const knownWorkerAt = sinceRetro.length ? Math.min(...sinceRetro.map((finish) => finish.at)) : now;
      sprintState = { ...sprintState, goalWorkStartedAt: Math.min(now, knownWorkerAt) };
    }
    if (sprintState.correctionPending) setRetroDue("user correction");
    if (sprintState.reopenedRows.length >= 1) setRetroDue("reopened row");
    if (
      deadline &&
      nonClosed.length > 0 &&
      now >= deadline.deadlineAt &&
      sprintState.handledDeadlineAt !== deadline.deadlineAt
    )
      setRetroDue("deadline passed", { deadlineAt: deadline.deadlineAt });
    // Incident-only retros: a predictable delivery or quiet hours never open one on
    // their own; the workers' Retro blocks accumulate for the next incident-driven
    // retro. Only evidence this window has not seen yet can open one, so a retro that
    // observed an incident does not re-fire on the same jobs.
    const recentTaskJobs = (jobs?.recent ?? []).filter((job) => job.type === "task");
    if (updaterRejected) setRetroDue("updater rejection");
    // A lead re-dispatch of one row, read from the row's own attempt data: owners
    // Foo -> Foo-2 -> Foo-3 accumulated on one row, or the row sent out again after an
    // attempt already completed. Parallel workers on one row are not a re-dispatch.
    const coveredAttempts = new Set(sprintState.retroCoveredAttempts ?? []);
    const redispatchedRow = tasks.some((task) => {
      const keys = rowAttemptKeys(task);
      if (keys.every((key) => coveredAttempts.has(key))) return false;
      const schedule = task.schedule && typeof task.schedule === "object" ? task.schedule : undefined;
      const attempts = Array.isArray(schedule?.attemptHistory) ? schedule.attemptHistory : [];
      const names = [
        typeof schedule?.owner === "string" ? schedule.owner : "",
        ...attempts.map((attempt) => typeof attempt?.workerName === "string" ? attempt.workerName : ""),
      ].filter((name) => name !== "");
      const distinct = new Set(names);
      const suffixChain = distinct.size >= 2 && new Set([...distinct].map((name) => name.replace(/-\d+$/, ""))).size === 1;
      const completedIdx = attempts.findIndex((attempt) => attempt?.terminalStatus === "completed");
      const afterCompleted = completedIdx >= 0 && (
        attempts.length > completedIdx + 1 || (typeof schedule?.owner === "string" && schedule.owner !== "")
      );
      return suffixChain || afterCompleted;
    });
    const failuresByLabel = new Map<string, { total: number; fresh: number }>();
    for (const job of recentTaskJobs) {
      if (job.status !== "failed") continue;
      const label = typeof job.label === "string" ? job.label : "";
      const entry = failuresByLabel.get(label) ?? { total: 0, fresh: 0 };
      entry.total += 1;
      if (!seenJobIdsBefore.has(job.id)) entry.fresh += 1;
      failuresByLabel.set(label, entry);
    }
    const repeatedFailure = [...failuresByLabel.values()].some(
      (entry) => entry.total >= 2 && entry.fresh >= 1,
    ) || redispatchedRow;
    if (repeatedFailure) setRetroDue("repeated failure");
    // A receipt covers the row's current attempt, not just its finished workers.
    // An unchanged pre-retro estimate aging past ETA is not a new incident.
    const freshMissedEta = open.some((task) =>
      alarms.some((alarm) => alarm.startsWith(`missed-eta:${JSON.stringify(task.content)}:`)) &&
      (sprintState.lastRetroAt === null ||
        (task.schedule?.startedAt ?? 0) > sprintState.lastRetroAt ||
        (task.schedule?.estimate?.updatedAt ?? 0) > sprintState.lastRetroAt),
    );
    if (freshMissedEta) setRetroDue("missed ETA");
    sprintState = { ...sprintState, rowStatuses: nextStatuses };
    persistSprintState();
  };
  const finishRetro = (receipt?: string | string[], persist = true, coveredAttempts: string[] = []) => {
    const handledDeadlineAt = sprintState.retroDueReason === "deadline passed" ? sprintState.retroDueDeadlineAt : sprintState.handledDeadlineAt;
    const handledDeliveryKey = sprintState.retroDueReason === "goal delivered" ? sprintState.retroDueDeliveryKey : sprintState.handledDeliveryKey;
    const covered = new Set(sprintState.retroCoveredIds);
    for (const id of retroWorkerIds()) covered.add(id);
    const coveredRows = new Set([...(sprintState.retroCoveredAttempts ?? []), ...coveredAttempts].slice(-MAX_RETRO_RECEIPT_IDS));
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
      retroFacilitatorJobs: [],
      retroCoveredIds: [...covered],
      retroCoveredAttempts: [...coveredRows],
      retroReceiptIds: [...sprintState.retroReceiptIds, ...(Array.isArray(receipt) ? receipt : receipt === undefined ? [] as string[] : [receipt]).filter((id) => !sprintState.retroReceiptIds.includes(id))].slice(-MAX_RETRO_RECEIPT_IDS),
      ...(handledDeadlineAt === undefined ? {} : { handledDeadlineAt }),
      ...(handledDeliveryKey === undefined ? {} : { handledDeliveryKey }),
    };
    retroFacilitatorJobs.clear();
    if (persist) persistSprintState();
  };
  const demandThreshold = (id: string): number => (id === "todo-replan" ? DEMAND_IGNORE_MAX_REPLAN : DEMAND_IGNORE_MAX);
  const isDemandEscalated = (id: string): boolean => (sprintState.ignoredDemands[id] ?? 0) >= demandThreshold(id);
  // Grievances 547/590: a todo override names the gate it answers and suppresses it
  // for OVERRIDE_SUPPRESS_TURNS turns (negative count). Both refusal sites consult
  // this so the named refusal stops blocking task and wait within that window.
  const isOverrideSuppressed = (id: string): boolean => (sprintState.ignoredDemands[demandClassOf(id)] ?? 0) < 0;
  // persist=false lets planCheck fold the tick into the loop's trailing persist: the in-memory
  // counts stay authoritative and the decay lands on the next persisted record either way.
  const trackDemands = (activeIds: string[], persist = true): void => {
    let changed = false;
    const next: Record<string, number> = { ...sprintState.ignoredDemands };
    const active = new Set(activeIds);
    for (const id of new Set([...Object.keys(next), ...activeIds])) {
      const current = next[id] ?? 0;
      if (active.has(id)) {
        if (current === 0 && typeof pi.sendMessage === "function") sendHarnessNotice("todo-gate-escalation", id, prompt.render(gateNoticeInstructions, { escalation: true, gate: id }).trim());
        if (current < 99) { next[id] = current + 1; changed = true; }
      } else if (current > 0) { next[id] = 0; changed = true; }
      else if (current < 0) { next[id] = current + 1; changed = true; }
    }
    const keys = Object.keys(next).slice(-MAX_NOTICE_KEYS);
    const bounded: Record<string, number> = {};
    for (const key of keys) bounded[key] = next[key] as number;
    if (changed) { sprintState = { ...sprintState, ignoredDemands: bounded }; if (persist) persistSprintState(); }
  };
  const resetDemand = (id: string, persist = true): void => {
    if ((sprintState.ignoredDemands[id] ?? 0) === 0) return;
    sprintState = { ...sprintState, ignoredDemands: { ...sprintState.ignoredDemands, [id]: 0 } };
    if (persist) persistSprintState();
  };
  const applyTodoOverride = (input: unknown, ctx: ExtensionContext, persist = true): string | undefined => {
    const gate = parseTodoOverride(input);
    // The escalated plan demands are lifted only by fixing the plan, never by naming them.
    if (!gate || PLAN_DEMAND_IDS.has(gate)) return undefined;
    sprintState = { ...sprintState, ignoredDemands: { ...sprintState.ignoredDemands, [gate]: -OVERRIDE_SUPPRESS_TURNS } };
    if (persist) persistSprintState();
    gateTrace(ctx, "override", { gate });
    return gate;
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
  let healPlanTicker: (ctx: ExtensionContext) => void = () => {};
  let disarmPlanTicker = () => {};
  let writeCurrentPlanSnapshot: (ctx: ExtensionContext, decision: ReturnType<typeof decideTodoDispatch>, now: number, phases: TodoScheduleInput) => void = () => {};
  let liveWorkerModelCount = 0;
  let liveWorkerModelCheckedAt = 0;
  let liveWorkerModelSession = "";
  let liveWorkerModelRefresh: { session: string; promise: Promise<number> } | null = null;
  const refreshLiveWorkerModels = (ctx: ExtensionContext): Promise<number> => {
    const session = `${ctx.cwd}\u0000${ctx.sessionManager.getHeader()?.id ?? "unknown"}`;
    if (session !== liveWorkerModelSession) {
      liveWorkerModelSession = session;
      liveWorkerModelCount = 0;
      liveWorkerModelCheckedAt = 0;
    }
    if (Date.now() - liveWorkerModelCheckedAt < 15_000) return Promise.resolve(liveWorkerModelCount);
    if (liveWorkerModelRefresh?.session === session) return liveWorkerModelRefresh.promise;
    const promise = countLiveWorkerModels(ctx)
      .then((count) => {
        if (liveWorkerModelSession === session) {
          liveWorkerModelCount = count;
          liveWorkerModelCheckedAt = Date.now();
        }
        return count;
      })
      .catch(() => {
        if (liveWorkerModelSession === session) liveWorkerModelCheckedAt = Date.now();
        return liveWorkerModelCount;
      })
      .finally(() => {
        if (liveWorkerModelRefresh?.promise === promise) liveWorkerModelRefresh = null;
      });
    liveWorkerModelRefresh = { session, promise };
    return promise;
  };
  const load = (ctx: ExtensionContext) => {
    flushSprintState();
    reset();
    const roster = selectLatestBranchEntry(ctx.sessionManager, (metadata) => metadata.type === "custom" && metadata.customType === ROSTER_ENTRY_TYPE);
    const sprint = selectLatestBranchEntry(ctx.sessionManager, (metadata) => metadata.type === "custom" && metadata.customType === SPRINT_STATE_ENTRY_TYPE);
    persistedChildren = readPersistedChildren(roster ? [roster] : []);
    sprintState = readPersistedSprintState(sprint ? [sprint] : []);
    retroFacilitatorJobs.clear();
    for (const name of sprintState.retroFacilitatorJobs) retroFacilitatorJobs.add(name);
    persistedSprintStateJson = JSON.stringify(sprintState);
    if (!singleWriterLane) armPlanTicker(ctx);
    if (!singleWriterLane && isMain(ctx) && pi.getActiveTools().includes("task") && typeof pi.sendMessage === "function")
      sendHarnessNotice("todo-gate-worker-names", ctx.sessionManager.getHeader()?.id ?? ctx.cwd, prompt.render(gateNoticeInstructions, { names: true }).trim());
  };
  const loadAndRefresh = (_event: unknown, ctx: ExtensionContext) => {
	load(ctx);
	// Quota discovery may wait on providers; restoring the session must not.
	// The refresh already coalesces requests and handles failures internally.
	void refreshLiveWorkerModels(ctx);
    announceGates(ctx);
  };
  pi.on("session_start", loadAndRefresh);
  pi.on("session_switch", loadAndRefresh);
  pi.on("session_branch", loadAndRefresh);
  pi.on("session_tree", loadAndRefresh);
  pi.on("session_shutdown", (_event, ctx) => {
    persistRoster(ctx);
    flushSprintState();
    reset();
    disarmPlanTicker();
  });
  pi.on("agent_start", (_event, ctx) => {
    clearIdleTimer();
    healPlanTicker(ctx);
  });
  pi.on("turn_start", (_event, ctx) => { healPlanTicker(ctx); announceGates(ctx); });
  let presenceCache: { minute: number; entries: number; presence: Presence } | null = null;
  const presenceOf = (branch: readonly unknown[], now: number): Presence => {
    const minute = Math.floor(now / 60_000);
    if (presenceCache?.minute === minute && presenceCache.entries === branch.length) return presenceCache.presence;
    let presence: Presence = "watching";
    try {
      presence = derivePresence(branch, rehydrateDeadlineState(branch), now);
    } catch {}
    presenceCache = { minute, entries: branch.length, presence };
    return presence;
  };
  let lastPresence: Presence | null = null;
  let returnNotice: { text: string; shown: boolean } | null = null;
  const queueReturnNotice = (phases: TodoScheduleInput) => {
    if (returnNotice) return;
    const waits = userWaitRows(phases);
    if (!waits.length) return;
    const dependents = [...parkUserWaits(phases).onProposal];
    const lines = waits.map((wait, index) => {
      const on = dependents.filter(([, parked]) => parked.includes(wait.content)).map(([content]) => JSON.stringify(shorten(content)));
      return `(${index + 1}) ${JSON.stringify(shorten(wait.content))}: ${shorten(wait.question, 200)} — ${wait.proposal ? `your proposal: ${shorten(wait.proposal, 300)}` : "no proposal recorded"}${on.length ? `; proceeded on it: ${on.join(", ")}` : ""}`;
    });
    returnNotice = {
      text: `THE USER IS BACK. Before anything else this turn, put the rows that wait for the user to them, each with your proposal: ${lines.join(" ")} For each answer, unblock that row (todo unblock) so it leaves the waiting state, and re-check the rows that proceeded on its proposal.`,
      shown: false,
    };
  };

  const currentDecision = (ctx: ExtensionContext, now = Date.now(), pending: unknown[] = [], refreshSnapshot = false, forceRefresh = false) => {
    // `pending`: entries not yet on the branch, such as the todo result a tool_result hook is amending.
    const branch = dispatchStateEntries(ctx, pending);
    const header = ctx.sessionManager.getHeader();
    const presence = header !== null && !header.parentSession ? presenceOf(branch, now) : undefined;
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
    const startableCapacity = workerCapacity(ctx);
    const jobs = ctx.getAsyncJobSnapshot();
    const phases = sdk.getLatestTodoPhasesFromEntries(branch);
    if (presence !== undefined) {
      if (lastPresence === "away" && presence !== "away") queueReturnNotice(phases);
      lastPresence = presence;
    }
    const restored = restoredChildren(persistedChildren, jobs);
    const key = `${staticKey(phases, jobs, deadline, capacity, startableCapacity, goalPaused, restored, persistedChildren)}:${Math.floor(now / 60_000)}:${presence ?? ""}`;
    // External processes can settle without changing TODOs or the async-job snapshot.
    const hasExternalOwner = phases.some((phase) => phase.tasks.some((task) => parseExternalWait(task.schedule?.owner) !== null));
    if (!hasExternalOwner && !forceRefresh && pending.length === 0 && cachedDecision?.key === key) {
      if (refreshSnapshot) writeCurrentPlanSnapshot(ctx, cachedDecision.decision, now, phases);
      return cachedDecision.decision;
    }
    const decision = decideTodoDispatch(
      {
        phases,
        jobs,
        externalOwnerProbe: options.externalOwnerProbe,
        persistedChildren,
        restoredChildren: restored,
        isMainSession: header !== null && !header.parentSession,
        capacity,
        startableCapacity,
        taskEnabled: pi.getActiveTools().includes("task") && startableCapacity > 0,
        now,
        deadline,
        goalPaused,
        presence,
        dispatchGateAvailable: nativeGateRegistered,
        lastWakeKey,
        cachedStatic,
        idleResumeAttempts,
      },
      sdk,
    );
    cachedStatic = decision.key && decision.staticPrompt ? { key: decision.key, text: decision.staticPrompt } : null;
    if (pending.length === 0 && decision.key) cachedDecision = { key, decision };
    writeCurrentPlanSnapshot(ctx, decision, now, phases);
    return decision;
  };
  // A worker whose row is on the critical path gets /fast; the harness sets it from the plan, not
  // the model (user 2026-09-24: "If a worker's task is on the critical path, it gets /fast").
  // Needs omp's ctx.setSubagentFastMode (fork PR #8); older builds skip this silently.
  const fastByWorker: CriticalFastState = new Map();
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
  const refuseWait = (reason: string, key = reason) => {
    if (lateWaitRefusalKey === key) return;
    lateWaitRefusalKey = key;
    return { block: true as const, reason };
  };
  // Worker capacity is bounded by the Task cap, CPU slots, and unique authenticated live model routes.
  const workerCapacity = (ctx: ExtensionContext) => {
    const cap = ctx.getTaskMaxConcurrency?.() ?? 0;
    // Same rule as omp task/worker-capacity (not imported: an extension must load on an omp built before that module).
    const providerSlots = liveWorkerModelCheckedAt === 0 ? availableParallelism() : liveWorkerModelCount;
    return Math.min(cap > 0 ? Math.min(cap, availableParallelism()) : availableParallelism(), providerSlots);
  };
  const understaffed = (ctx: ExtensionContext, runningTasks: number, parked: number) =>
    parked >= 2 && runningTasks < workerCapacity(ctx);
  // A waiting row is genuinely chained when every dependency names a real plan row (a true
  // output link, whatever that row's status: open, blocked on an external gate, or already
  // closed) and the row itself is not externally gated. Only a row whose dependency names no
  // plan row at all can be freed by rewriting the plan, so only that (or ready work without
  // a worker, handled on the staffing path) may demand a replan or split advice. Otherwise
  // the demand manufactures noise while every row waits on real outputs or external gates.
  const hasReplannableWait = (decision: {
    openStructure?: Array<[string, string[]]>;
    forecast: TodoPlanForecast | null;
  }) => {
    const rows = decision.forecast?.rows ?? [];
    const known = rows.map((row) => row.content);
    return (decision.openStructure ?? []).some(([content, deps]) => {
      const row = rows.find((candidate) => candidate.content === content);
      if (!row || row.ready) return false;
      if (row.blocker || row.waitsForUser) return false;
      return deps.some((dep) => !known.includes(dep));
    });
  };
  // Identity is in the running session's session_init, not the public job snapshot.
  // Rediscover through core precedence and resolve settings/aliases on each check;
  // permitted mechanical routes and operator effort caps are not routing defects.
  const criticalWorkerWarnings = async (ctx: ExtensionContext, rows: TodoTaskForecast[], running: Jobs["running"]) => {
    const warnings = await Promise.all(rows.filter((row) => row.critical && row.owner).flatMap((row) =>
      running.filter((job) => liveJobMatchesOwner(job, row.owner!)).map(async (job) => {
        const id = job.agentId ?? job.id;
        const session = AgentRegistry.global().get(id)?.session;
        const model = session?.model;
        const effort = session?.thinkingLevel;
        const isFree = model?.id.endsWith(":free") ?? false;
        const isWeakEffort = effort === "low" || effort === "minimal";
        if (!session || !model || (!isFree && !isWeakEffort)) return [];
        const init = selectBranchEntries(session.sessionManager, metadata => metadata.type === "session_init")
          .findLast(entry => typeof entry.agent === "string");
        if (!init?.agent) return [];
        const discovery = await discoverAgents(ctx.cwd, homedir(), session.effectiveExtensionRoots);
        const agent = getAgent([...discovery.agents, ...(session.getSessionAgents?.() ?? [])], init.agent);
        if (!agent) return [];
        const settings = session.settings;
        const patterns = resolveAgentModelPatterns({
          settingsOverride: cfgTaskAgentModelOverrides.get(settings)[agent.name],
          agentModel: agent.model, settings,
        });
        const routes = patterns.map(pattern => resolveModelOverride([pattern], ctx.modelRegistry, settings))
          .filter(route => route.model);
        const permitsFree = routes.some(route => route.model.id.endsWith(":free"));
        // Each configured fallback keeps its own effort: judge the permitted route the
        // live model resolves to, not the first route. A live model matching no route
        // keeps the primary route's semantics (a free mismatch is the free defect).
        const primary = routes.find(route =>
          route.model.id === model.id && route.model.provider === model.provider) ?? routes[0];
        const selector = primary?.explicitThinkingLevel ? primary.thinkingLevel
          : agent.thinkingLevel ?? cfgDefaultThinkingLevel.get(settings);
        const requiredEffort = selector === undefined || selector === "auto" ? undefined
          : resolveThinkingLevelForModel(model, clampThinkingLevelToCeiling(model, selector, cfgTaskMaxEffort.get(settings)));
        const requiresStrongEffort = requiredEffort === "medium" || requiredEffort === "high" ||
          requiredEffort === "xhigh" || requiredEffort === "max";
        if (!(isFree && routes.length > 0 && !permitsFree) && !(isWeakEffort && requiresStrongEffort)) return [];
        return [prompt.render(gateNoticeInstructions, {
          criticalWorker: true, row: JSON.stringify(row.content), worker: id,
          model: `${model.provider}/${model.id}`, effort: effort ?? "unknown",
        }).trim()];
      }),
    ));
    return warnings.flat();
  };
  let criticalSplitWait: { key: string; structure: Structure } | null = null;
  const blockIdleWait = async (ctx: ExtensionContext) => {
    if (isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) return;
    if (pauseGate?.paused) return;
    // Grievance 547: a todo override naming idle-wait answers this refusal; let
    // the wait through for the same few-turn window instead of deadlocking.
    if (isOverrideSuppressed("idle-wait")) return;
    const jobs = ctx.getAsyncJobSnapshot();
    if (!jobs) return;
    const running = jobs.running.filter((job) => job.status === "running");
    const runningTasks = running.filter((job) => job.type === "task");
    const parkedChildren = restoredChildren(persistedChildren, jobs).filter((child) => child.live);
    const idle = running.length === 0 && parkedChildren.length === 0;
    const decision = currentDecision(ctx, Date.now(), [], false, true);
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
    // While the user is away, the ordered away work list comes first; once it was shown (or is
    // empty) the critical split demand below still applies.
    const awayWorkList = decision.presence === "away" && ready.length === 0 ? decision.awayWorkList ?? [] : [];
    if (awayWorkList.length) {
      return refuseWait(
        `Finish ${actionTarget(open[0]?.content ?? "away work", 37)} before wait.\nStop waiting while the user is away; finish this work list first: ${awayWorkList.join(" ")}`,
        `away:${decision.key}`,
      );
    }
    // A real output dependency can still hide parallel work. Ask once per plan revision,
    // before the zero-ready early return; an append or dropped dependency answers the demand.
    if (ready.length === 0 && runningTasks.length < workerCapacity(ctx)) {
      const runningRows = open.filter((row) => row.status === "in_progress" && row.owner &&
        runningTasks.some((job) => liveJobMatchesOwner(job, row.owner!)));
      const criticalRunning = runningRows.filter((row) => row.critical &&
        runningTasks.filter((job) => liveJobMatchesOwner(job, row.owner!)).length === 1);
      const structure = decision.openStructure ?? [];
      const closed = new Set(rows.filter((row) => row.status === "completed" || row.status === "abandoned").map((row) => row.content));
      const depsByRow = new Map(structure.map(([content, deps]) => [content, deps.filter((dep) => !closed.has(dep))]));
      const waitingCritical = open.filter((row) => {
        if (!row.critical || row.status !== "pending" || row.blocker || row.waitsForUser) return false;
        const deps = depsByRow.get(row.content) ?? [];
        return deps.length > 0 && deps.every((dep) => runningRows.some((running) => running.content === dep));
      });
      // Only a critical row parked behind running work makes waiting cost ETA; a lone running row with
      // nothing behind it is the normal end of a staffed plan (liveness matrix: staffing clears idle-wait).
      if (waitingCritical.length) {
        const key = `critical-split:${decision.key}:${JSON.stringify(structure)}`;
        // An already-asked or answered demand falls through to the remaining wait gates.
        const asked = criticalSplitWait?.key === key;
        const answered = !asked && criticalSplitWait && unlockedSince(criticalSplitWait.structure, structure);
        if (!asked) criticalSplitWait = { key, structure };
        if (!asked && !answered) {
          const runningNames = criticalRunning.map((row) => JSON.stringify(row.content)).join(", ");
          const waitingNames = waitingCritical.map((row) =>
            `${JSON.stringify(row.content)} (waiting on ${(depsByRow.get(row.content) ?? []).map((dep) => JSON.stringify(dep)).join(", ")})`).join(", ");
          return refuseWait(prompt.render(gateNoticeInstructions, {
            criticalSplit: true, splitRows: runningNames || waitingNames, waitingRows: waitingNames,
            staffingWarnings: (await criticalWorkerWarnings(ctx, open, runningTasks)).join("\n"),
          }).trim(), key);
        }
      }
    }
    // An empty away work list still allows the wait (after any critical split demand above).
    if (decision.presence === "away" && ready.length === 0) return;
    // One next action, naming the exact tool. Seen live: "write the rows into the todo plan" sent the
    // model to edit a backlog file in the repo, and "start workers … replan …" in one breath gave it two orders at once.
    const next = ready.length
      ? `Ready rows needing a distinct running worker: ${ready.slice(0, MAX_TASK_DISPATCH).join(", ")}. If a running worker already does one of these rows but differs from its recorded owner, set that row's schedule.owner via todo schedule to that worker; otherwise start one worker for the row (skill://chief-of-staff).`
      : replanInstruction(ctx, open, workerCapacity(ctx));
    if (idle) {
      const reason = [
        `Staff ${actionTarget(readyRows[0]?.content ?? open[0]?.content ?? "open plan")} via task before wait.\nStop waiting: nothing is running, so nothing will arrive.`,
        overdue ? "You are past the deadline." : undefined,
        next,
      ].filter(Boolean).join("\n");
      return refuseWait(reason);
    }
    // Other dependency-waiting and recorded-approval rows cannot start yet.
    if (runningTasks.length === 0 || ready.length === 0) return;
    const reason = [
      `Staff ${actionTarget(readyRows[0]?.content ?? "ready work")} via task before wait.\nStop waiting: ready work lacks a distinct running worker${overdue ? ", and you are past the deadline" : late ? ", and you are about to miss the deadline" : ""}.`,
      next,
      activityLine(ctx, runningTasks),
    ].filter(Boolean).join("\n");
    return refuseWait(reason);
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
  const PLAN_REDELIVERY_MS = 30 * 60_000;
  let planHeartbeatSeq = 0;
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
      for (const phase of sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx)))
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
  writeCurrentPlanSnapshot = (ctx, decision, now, phases) => {
    if (!decision.key || !decision.forecast || !isMain(ctx)) return;
    const rows = decision.forecast.rows ?? [];
    const open = rows.filter((row) => row.status === "pending" || row.status === "in_progress");
    const currentFinish = recordFinishSample(ctx, open, now);
    const phaseRows = phases.flatMap((phase) => phase.tasks.map((task) => [task.content, task] as const));
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
      const p95 = safeTimestamp(row.fixedPathP95Finish ?? row.resourceFinish, decision.deadline?.timezone);
      const critical = row.criticalityKnown === false ? "unknown" : row.critical ? "yes" : "no";
      return `| ${markdownCell(row.content)} | ${row.status} | ${olp} | ${markdownCell(deps)} | ${markdownCell(owner)} | ${runs} | ${markdownCell(resources)} | ${p95} | ${critical} |`;
    });
    const sampleLines = finishSamples.length
      ? finishSamples.map((sample) => `- ${safeTimestamp(sample.at, decision.deadline?.timezone)} -> ${safeTimestamp(sample.finish, decision.deadline?.timezone)}`)
      : ["- none"];
    const text = [
      "# OMP Plan Snapshot",
      "",
      "Read by plan-doctor first. This file is written by tools/omp/todo_dispatch.ts from the dispatcher forecast.",
      `Snapshot paths: ${byCwd} and ${bySession}`,
      "CWD slug rule: absolute cwd, replace every non [A-Za-z0-9._-] with -, collapse repeated -, trim leading/trailing -, take first 120 chars, fallback cwd",
      `Written: ${safeTimestamp(now, decision.deadline?.timezone)}`,
      `CWD: ${ctx.cwd}`,
      `Session: ${ctx.sessionManager.getHeader()?.id ?? "unknown"}`,
      "",
      "## Goal And Deadline",
      `Goal: ${decision.deadline?.goalId ?? "none"}`,
      `Deadline: ${decision.deadline ? safeTimestamp(decision.deadline.deadlineAt, decision.deadline.timezone) : "none"}`,
      "",
      "## ETA",
      `Current ETA/P95 finish: ${currentFinish === null ? "unknown" : safeTimestamp(currentFinish, decision.deadline?.timezone)}`,
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
  const CHIEF_OF_STAFF = `ROLE: You are the chief of staff for this session, not a worker; your runbook is skill://chief-of-staff. ${ORDER} Put Retro: required or Retro: not requested in the actual received brief (incident briefs require it); intake records missing-required when a brief that requires Retro omits it (cause missing-by-brief), versus present / not-requested, without changing product acceptance and never wakes a worker for a missing Retro. Every checkout preparation or mutation brief names ROOT=<absolute path> in its actual body, matching its assigned resource; a structured resource or assignedroot placeholder does not substitute. Missing or conflicting ROOT stops that item without searching for a replacement checkout. Fetch and merge-tree object writes are Git-metadata mutations: before an authorized preparation command, establish ROOT's Git common directory and isolation; never run them in a checkout whose shared metadata is read-only. For lifecycle work accept a receipt mapping each acceptance clause to its production entry, wiring, and behavior proof through the real consumer; require owner-end proof only when the acceptance explicitly requires it. Helper-only proof does not prove consumer behavior. Rejected reflection preserves unproved criteria, authorized git handoff, and docs; never reset another owner's workspace or cut scope. A read-only diagnostic never invokes a shared installer/upgrader, even labelled --dry-run; compare lane-owned executables by absolute path with isolated install prefix and explicit DB endpoint named. Derive the publication tuple (exact remote URL, full destination ref, old OID) from one fresh forge-head readback and cite it; record the local branch separately — equal OIDs never substitute for matching repo and ref; push only the named ref with the lease bound to that full ref plus OID; rollback is a direct protected update of the same ref expecting the published OID, never delete/recreate.`
  const READ_ONLY_BASH = /^(?:grep|rg|ls|cat|head|tail|wc|pwd|echo|stat|test|\[|sha256sum|sha1sum|md5sum|readlink|realpath|file|cut|uniq|tr|nl|jq|cmp|basename|dirname|date|du|df|free|uptime|ps|pgrep|ss)$/;
  // Live 2026-10-12: the chief was refused `git show … | cat && sed -n '160,170p' ledger | cut -c1-400`,
  // a pure look, so its rows went overdue. sed only as a line-range print, find and sort without write/exec flags.
  const readOnlyLook = (words: Array<{ value: string; dynamic: boolean }>) => {
    const [name, ...args] = words;
    if (["sed", "find", "sort"].includes(name.value) && args.some((word) => word.dynamic)) return false;
    // sed is a look as a line-range print (`-n 10,20p`) or as one plain substitution filter
    // (`-E 's/a/b/g'`): no -i, no script file, and no flag beyond g/I/p/N, so no `w` file write or `e` exec.
    if (name.value === "sed") {
      if (args[0]?.value === "-n" && args.length >= 2 && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[1].value)) return true;
      const flags = args.filter((word) => word.value.startsWith("-"));
      const scripts = args.filter((word) => !word.value.startsWith("-"));
      if (!flags.every((word) => /^-[Enr]+$/.test(word.value))) return false;
      return scripts.length >= 1 && /^s([^\\\w\s])(?:(?!\1).|\\.)*\1(?:(?!\1).|\\.)*\1[gIp\d]*$/.test(scripts[0].value);
    }
    // awk reads unless its program writes or runs: no redirection, pipe, system(), getline or close()
    // (live 2026-10-23 16:4xZ: `awk -F'[›|\t]' '{print $0}' failure-keys.txt | grep …` was refused).
    if (name.value === "awk") {
      const program = args.find((word, index) => !word.value.startsWith("-") && !/^-[Fv]$/.test(args[index - 1]?.value ?? ""));
      if (!program || program.dynamic) return false;
      if (args.some((word) => /^-(?:f|-file|i|-include|E|-exec)/.test(word.value))) return false;
      return !/[>|]|\bsystem\s*\(|\bgetline\b|\bclose\s*\(|\bfflush\b/.test(program.value);
    }
    if (name.value === "find") return !args.some((word) => /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(word.value));
    if (name.value === "sort") return !args.some((word) => /^(?:-o|--output)/.test(word.value));
    // systemctl reads: leading display/scope options, then a listing or state verb (live 2026-10-23 15:59Z:
    // `systemctl --user list-units --all 'review-*' --no-legend` was refused).
    if (name.value === "systemctl") {
      const verb = args.find((word) => !word.value.startsWith("-"));
      if (!verb || verb.dynamic) return false;
      if (!args.every((word) => !word.value.startsWith("-") || /^(?:--user|--system|--all|-a|--no-legend|--no-pager|--plain|--full|-l|--failed|--state=[\w,-]+|--type=[\w,-]+|--property=[\w,]+|-p)$/.test(word.value))) return false;
      return ["status", "is-active", "is-enabled", "is-failed", "list-units", "list-timers", "list-unit-files", "show", "cat"].includes(verb.value);
    }
    if (name.value === "journalctl") return !args.some((word) => word.dynamic || /^--(?:rotate|vacuum|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)(?:[=-]|$)/.test(word.value));
    return READ_ONLY_BASH.test(name.value);
  };
  // gh reads: `gh api` stays a look only while its method is GET and it sends no fields or body.
  // The PR and run views are looks; other gh verbs (pr merge/comment/create, run rerun) stay worker work.
  const readOnlyGh = (words: Array<{ value: string; dynamic: boolean }>) => {
    const [, sub, ...args] = words;
    if (!sub || sub.dynamic) return false;
    if (sub.value === "pr" || sub.value === "run") {
      const verb = args[0];
      if (!verb || verb.dynamic) return false;
      return (sub.value === "pr" ? ["view", "checks", "list", "diff"] : ["view", "list"]).includes(verb.value);
    }
    if (sub.value !== "api") return false;
    for (let i = 0; i < args.length; i += 1) {
      const word = args[i];
      if (/^(?:-f|-F)/.test(word.value) || /^--(?:field|raw-field|input)(?:=|$)/.test(word.value)) return false;
      const method = word.value.match(/^(?:-X|--method=?)(.*)$/);
      if (!method) continue;
      const value = method[1] || args[++i];
      if (!value || value.dynamic || value.value.toUpperCase() !== "GET") return false;
    }
    return true;
  };
  // Git mutation (add, commit, push, merge) is the git-pr-owner worker's job, never the chief's
  // (user 2026-09-25: "чего чиф оф стафф гит дрочит, у него же писарь есть и гитарь?").
  // Inspect shell structure without executing it. Unknown syntax fails closed; substitutions
  // use the same command checks, including inside double quotes and loop headers.
  const isChiefBash = (command: string) => {
    type Token = { value: string; plain: boolean; dynamic: boolean; newline?: boolean; assignment?: boolean };
    const separators: Record<string, true> = { ";": true, "&&": true, "||": true, "|": true };
    const reserved: Record<string, true> = { for: true, while: true, until: true, if: true, do: true, done: true, then: true, else: true, elif: true, fi: true };
    let cursor = 0;
    const check = (tokens: Token[]): boolean => {
      let at = 0;
      // A leading checkout change is navigation, not delegated work. Classify every
      // following command normally, so `cd x && make` still fails closed.
      if (tokens[0]?.plain && tokens[0].value === "cd") {
        if (!tokens[1] || tokens[1].dynamic || tokens[1].value.startsWith("-") || !tokens[2]?.plain || tokens[2].value !== "&&") return false;
        at = 3;
      }
      const keyword = (words: string[]) => tokens[at]?.plain && words.includes(tokens[at].value);
      const take = (word: string) => {
        if (!keyword([word])) return false;
        at += 1;
        return true;
      };
      const simple = (words: Token[], piped = false) => {
        if (!words.length || words[0].dynamic) return false;
        // A static absolute binary (/usr/bin/git, /bin/sed) is judged by its basename.
        const binary = words[0].value.match(/^\/(?:usr\/(?:local\/)?)?s?bin\/([^/]+)$/);
        if (binary) words = [{ ...words[0], value: binary[1] }, ...words.slice(1)];
        // `cat`, `head`, `tail` and `wc` are looks only as a pipe sink: flags and numbers, never files.
        if (piped && ["cat", "head", "tail", "wc"].includes(words[0].value) && words.slice(1).some((word) => word.dynamic || !/^(?:-\S*|\d+)$/.test(word.value))) return false;
        // `cd <dir>` anywhere in a chain is navigation: the commands around it are classified on their own,
        // so `cd x && git status; cd y && git log` passes and `cd x && make` still fails closed.
        if (words[0].value === "cd") return words.length === 2 && !words[1].dynamic && !words[1].value.startsWith("-");
        if (words[0].value === "gh") return readOnlyGh(words);
        if (words[0].value !== "git") return readOnlyLook(words);
        let subcommand = 1;
        // Global options precede the subcommand: `-C <dir>`, `-c k=v`, `--no-pager`, `--git-dir=…`, `--work-tree=…`.
        for (;;) {
          const option = words[subcommand];
          if (!option) break;
          if (option.dynamic) return false;
          if (["-C", "-c"].includes(option.value)) {
            if (!words[subcommand + 1]) return false;
            subcommand += 2;
          } else if (/^--(?:no-pager|git-dir=|work-tree=)/.test(option.value)) {
            subcommand += 1;
          } else break;
        }
        if (!words[subcommand] || words[subcommand].dynamic || !/^(?:status|log|show|diff|rev-parse|branch|remote|ls-files|ls-remote|ls-tree|cat-file|merge-base|worktree|fetch|patch-id|rev-list|for-each-ref|name-rev|describe|blame|shortlog|grep|stash)$/.test(words[subcommand].value)) return false;
        const verb = words[subcommand].value;
        const rest = words.slice(subcommand + 1);
        // Plumbing that can write: `worktree add/remove/…`, `remote add/remove/set-url/…`, and `--output=<file>`.
        if (verb === "worktree") return rest[0] !== undefined && !rest[0].dynamic && rest[0].value === "list";
        // `stash list` and `stash show` read; a bare `stash`, `push`, `pop`, `apply`, `drop` or `clear` writes.
        if (verb === "stash") return rest[0] !== undefined && !rest[0].dynamic && ["list", "show"].includes(rest[0].value);
        if (verb === "remote" && rest.length > 0 && (rest[0].dynamic || !/^(?:-v|--verbose|show|get-url)$/.test(rest[0].value))) return false;
        if (["diff", "log", "show"].includes(verb) && rest.some((word) => /^--output(?:=|$)/.test(word.value))) return false;
        if (words[subcommand].value !== "branch") return true;
        // Bare names create branches; -d/-D/-m/-M/-c/-C and unknown options mutate or
        // cannot be classified. Only known listing forms belong to the chief.
        let list = false;
        for (let i = subcommand + 1; i < words.length; i += 1) {
          const word = words[i];
          if (word.dynamic) return false;
          if (word.value === "--list") { list = true; continue; }
          if (/^(?:-a|-r|-v|-vv|--all|--remotes|--show-current|--no-color|--color=never)$/.test(word.value)) continue;
          if (/^--(?:contains|no-contains|merged|no-merged)$/.test(word.value)) {
            if (words[i + 1] && !words[i + 1].value.startsWith("-")) {
              const value = words[++i];
              // tokenize has already recursively admitted this substitution's commands.
              if (value.dynamic && value.value !== "$substitution") return false;
            }
            continue;
          }
          if (/^--(?:contains|no-contains|merged|no-merged|sort|format)=/.test(word.value)) continue;
          if (list && !word.value.startsWith("-")) continue;
          return false;
        }
        return true;
      };
      const list = (stops: string[]): boolean => {
        while (tokens[at]?.newline) at += 1;
        if (at === tokens.length || keyword(stops)) return false;
        let piped = false;
        while (at < tokens.length) {
          if (!statement(piped)) return false;
          if (at === tokens.length || keyword(stops)) return true;
          const separator = tokens[at++];
          if (!separator.plain || !Object.hasOwn(separators, separator.value)) return false;
          piped = separator.value === "|";
          if (at === tokens.length || keyword(stops)) return separator.value === ";";
        }
        return true;
      };
      const statement = (piped = false): boolean => {
        while (tokens[at]?.assignment) at += 1;
        if (take("for")) {
          const variable = tokens[at++];
          if (!variable?.plain || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.value) || !take("in")) return false;
          while (at < tokens.length && !keyword([";"])) {
            if (tokens[at].plain && Object.hasOwn(separators, tokens[at].value)) return false;
            at += 1;
          }
          return take(";") && take("do") && list(["done"]) && take("done");
        }
        if (take("while") || take("until")) return list(["do"]) && take("do") && list(["done"]) && take("done");
        if (take("if")) {
          if (!list(["then"]) || !take("then") || !list(["elif", "else", "fi"])) return false;
          while (take("elif")) {
            if (!list(["then"]) || !take("then") || !list(["elif", "else", "fi"])) return false;
          }
          if (take("else") && !list(["fi"])) return false;
          return take("fi");
        }
        if (tokens[at]?.plain && Object.hasOwn(reserved, tokens[at].value)) return false;
        const start = at;
        while (at < tokens.length && !(tokens[at].plain && Object.hasOwn(separators, tokens[at].value))) at += 1;
        return simple(tokens.slice(start, at), piped);
      };
      return list([]) && at === tokens.length;
    };
    const tokenize = (stop = "", depth = 0): Token[] | null => {
      if (depth > 32) return null;
      const tokens: Token[] = [];
      while (cursor < command.length) {
        const char = command[cursor];
        if (stop && char === stop) { cursor += 1; return tokens; }
        if (char === " " || char === "\t" || char === "\r") { cursor += 1; continue; }
        if (char === "\n" || char === ";" || char === "|" || char === "&") {
          cursor += 1;
          let value = char === "\n" ? ";" : char;
          if ((char === "|" || char === "&") && command[cursor] === char) { value += char; cursor += 1; }
          if (value === "&") return null;
          // Newlines after operators are whitespace, but an argument named do/then/else
          // must never swallow the boundary before the next executable command.
          const previous = tokens.at(-1);
          if (char !== "\n" || (previous && !(previous.plain && Object.hasOwn(separators, previous.value)))) tokens.push({ value, plain: true, dynamic: false, newline: char === "\n" });
          continue;
        }
        // `< file` only reads; its path word is not an argument (live 2026-10-23 16:55Z: `tr '\0' ' ' </proc/$p/cmdline`
        // was refused twice). `<<`, `<>`, `<&` and `<(` stay outside this grammar.
        let inputRedirect = false;
        if (char === "<") {
          if (/[<>&(]/.test(command[cursor + 1] ?? "")) return null;
          cursor += 1;
          while (command[cursor] === " " || command[cursor] === "\t") cursor += 1;
          if (cursor >= command.length || /[;|&\n]/.test(command[cursor]!)) return null;
          inputRedirect = true;
        }
        const start = cursor;
        let value = "";
        let plain = true;
        let dynamic = false;
        let quote = "";
        while (cursor < command.length) {
          const next = command[cursor];
          if (!quote && (/[\s;|&]/.test(next) || (stop && next === stop))) break;
          cursor += 1;
          if (next === "'" && quote !== '"') {
            plain = false;
            const end = command.indexOf("'", cursor);
            if (end < 0) return null;
            value += command.slice(cursor, end);
            cursor = end + 1;
          } else if (next === '"') {
            plain = false;
            quote = quote ? "" : '"';
          } else if (next === "\\") {
            plain = false;
            // Legacy backticks re-interpret escaped syntax; refuse that unsupported form.
            if (stop === "`" || cursor === command.length) return null;
            const escaped = command[cursor++];
            if (escaped !== "\n") value += escaped;
          } else if (next === "`" || (next === "$" && command[cursor] === "(")) {
            if (next === "$") cursor += 1;
            const nested = tokenize(next === "`" ? "`" : ")", depth + 1);
            if (!nested || !check(nested)) return null;
            value += "$substitution";
            dynamic = true;
            plain = false;
          } else {
            // Redirects, subshells, brace/parameter expansions and comments are not
            // part of this deliberately small grammar (including process substitution).
            if (!quote && /[<>(){}#]/.test(next)) return null;
            if (next === "$") {
              if (command[cursor] === "{" || command[cursor] === "'") return null;
              dynamic = true;
            }
            value += next;
          }
        }
        if (quote) return null;
        if (inputRedirect) continue;
        tokens.push({ value, plain, dynamic, assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(start, cursor)) });
      }
      return stop ? null : tokens;
    };
    const tokens = tokenize();
    return tokens !== null && check(tokens);
  };
  const WRITE_EXEMPT_PATH = /^(agent|xd|proc|history|artifact):\/\//;
  let chiefRefusals = 0;
  const MAX_CHIEF_REFUSALS = 3;
  const isMain = (ctx: ExtensionContext) => {
    const header = ctx.sessionManager.getHeader();
    return header !== null && !header.parentSession;
  };
  const announceHuman = (ctx: ExtensionContext, user: { at: number; text: string }) => {
    if (singleWriterLane || !isMain(ctx) || typeof pi.sendMessage !== "function" || typeof pi.appendEntry !== "function") return;
    const timestamp = new Date(user.at * 1_000).toISOString();
    const key = `${timestamp}:${user.text}`;
    const content = prompt.render(gateNoticeInstructions, { human: true, timestamp }).trim();
    if (sprintState.lastNotices[noticeKey("todo-gate-user-reply", key)] === noticeDigest(content)) return;
    sendHarnessNotice("todo-gate-user-reply", key, content);
  };
  // These are recovery obligations, not advice: changing an owner label cannot abandon its live attempt.
  const requireRecovery = (ctx: ExtensionContext, recovery: RecoveryWait) => {
    if (!isMain(ctx) || singleWriterLane || pauseGate?.paused) return;
    const existing = sprintState.recoveryWaits ?? [];
    if (existing.some(item => item.kind === recovery.kind && (item.kind === "stuck" || item.row === recovery.row) && item.owner === recovery.owner && item.startTime === recovery.startTime)) return;
    sprintState = { ...sprintState, recoveryWaits: [...existing, recovery] };
    persistSprintState();
  };
  const recoveryAction = (item: RecoveryWait) => item.kind === "cap"
    ? `Kill ${shorten(item.owner, 24)}; reassign ${actionTarget(item.row, 42)} before wait.`
    : `Kill ${shorten(item.owner, 48)} or get its new receipt before wait.`;
  const recoveryNotice = (item: RecoveryWait) => prompt.render(gateNoticeInstructions, {
    recovery: true, action: recoveryAction(item), owner: item.owner, recoveryCap: item.kind === "cap",
  }).trim();
  const activeRecoveries = (ctx: ExtensionContext, pending: unknown[] = []) => {
    const phases = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx, pending));
    const tasks = phases.flatMap(phase => phase.tasks);
    const jobs = ctx.getAsyncJobSnapshot();
    const previous = sprintState.recoveryWaits ?? [];
    const kept = previous.flatMap((item): RecoveryWait[] => {
      const row = tasks.find(task => task.content === item.row);
      const matches = (job: Jobs["running"][number]) => job.type === "task" && (job.id === item.owner || job.agentId === item.owner);
      const running = jobs?.running.some(job => matches(job) && job.status === "running");
      const killed = item.killed || jobs?.recent.some(job => matches(job) && job.status === "cancelled" && (job.endTime ?? 0) > item.at);
      if (item.kind === "cap") {
        if (!row || !isNonClosedRowStatus(row.status)) return [];
        if (killed && !running && row.schedule?.owner && row.schedule.owner !== item.owner) return [];
      } else {
        if (killed && !running) return [];
        const received = item.received || jobs?.recent.some(job => matches(job) && (job.status === "completed" || job.status === "failed") && (job.endTime ?? 0) > item.at)
          || (workerTrace(ctx, item.owner).receiptAt ?? 0) > item.at;
        // Retain the acknowledged escalation for this attempt so the next tick cannot rearm it.
        if (received) return running ? [{ ...item, received: true }] : [];
      }
      return [{ ...item, ...(killed ? { killed: true } : {}) }];
    });
    if (JSON.stringify(kept) !== JSON.stringify(previous)) {
      sprintState = { ...sprintState, recoveryWaits: kept };
      persistSprintState();
    }
    return kept.filter(item => !item.received);
  };
  const announceGates = (ctx: ExtensionContext, pending: unknown[] = [], now = Date.now(), measured?: DispatchDecision) => {
    if (singleWriterLane || !isMain(ctx) || typeof pi.sendMessage !== "function" || typeof pi.appendEntry !== "function") return;
    const phases = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx, pending));
    const notice = (kind: string, key: string, data: Record<string, unknown>, interruptWait = false) => {
      const type = `todo-gate-${kind}`;
      const content = prompt.render(gateNoticeInstructions, data).trim();
      if (sprintState.lastNotices[noticeKey(type, key)] === noticeDigest(content)) return;
      sendHarnessNotice(type, key, content, undefined, content, { interruptWait });
    };
    const tasks = [...new Set(getTodoPlanningIssues(phases).map(issue => issue.task))];
    if (tasks.length) notice("schedule", JSON.stringify(tasks), { schedule: true, rows: tasks.map(task => JSON.stringify(task)).join(", "), tasks });
    if (pauseGate?.paused || gateSwitchedOff(ctx)) return;
    for (const item of activeRecoveries(ctx, pending)) notice("recovery", JSON.stringify([item.kind, item.row, item.owner, item.at]), {
      recovery: true, action: recoveryAction(item), owner: item.owner, recoveryCap: item.kind === "cap",
    }, true);
    const decision = measured ?? currentDecision(ctx, now, pending);
    const rows = decision.dispatchableReady ?? [];
    if (rows.length) notice("staffing", JSON.stringify(rows.map(row => [row.content, row.owner, row.ownership])), {
      staffing: true, rows: rows.map(row => JSON.stringify(row.content)).join(", "),
    });
    if (decision.presence === "away" && !rows.length && decision.awayWorkList?.length) notice("away", decision.key, {
      away: true, rows: decision.awayWorkList.join(" "),
    });
    for (const row of decision.forecast?.rows ?? []) {
      if (!isOpenRowStatus(row.status) || !row.owner) continue;
      const key = `${row.content}:${row.owner}:${row.estimateRevision}`;
      const data = { row: JSON.stringify(row.content), owner: row.owner };
      if (row.reestimateCount >= 2) notice("cap", key, { ...data, cap: true });
      const start = row.estimateUpdatedAt ?? row.startedAt;
      const finish = row.resourceFinish;
      if (row.status === "in_progress" && start !== undefined && finish !== undefined && finish > start && now >= start + 0.8 * (finish - start))
        notice("eta", key, { ...data, eta: true });
    }

  };
  pi.on("message_start", (event, ctx) => {
    const user = latestDeadlineUserMessage([{ type: "message", message: event.message }]);
    if (user) announceHuman(ctx, user);
  });
  const unansweredUserReason = (ctx: ExtensionContext) => {
    if (singleWriterLane || !isMain(ctx)) return;
    // Canonical history contains finalized assistant_message rewrites, not streamed drafts.
    // Walk the selected branch backwards, including across compaction, stopping at its latest
    // genuine human turn. Reuse deadline attribution rules so peers/notices stay agent-owned.
    let replied = false;
    for (const entry of selectBranchNewestFirst(ctx.sessionManager, metadata =>
      metadata.type === "message" && (metadata.messageRole === "user" || metadata.messageRole === "assistant"),
    )) {
      const message = entry.message;
      if (message.role === "assistant") {
        if (message.content.some(part => part.type === "text" && part.text.trim())) replied = true;
        continue;
      }
      const user = latestDeadlineUserMessage([entry]);
      if (!user) continue;
      if (replied) return;
      return prompt.render(unansweredUserInstructions, {
        timestamp: new Date(user.at * 1_000).toISOString(),
        excerpt: shorten(user.text.replace(/\s+/g, " ").trim(), 80),
      }).trim();
    }
  };
  pi.on("session_stop", (_event, ctx) => {
    const reason = unansweredUserReason(ctx);
    if (reason) return { decision: "block", reason };
  });
  // The full chief-of-staff runbook (main) or a worker's original brief (subagent) can drop out of
  // context at compaction when the summary replaces the retained prefix. Conditionally re-persist it
  // once, right after a compaction that drops it, as a custom message entry that joins LLM context
  // without starting a turn (sendMessage deliverAs "nextTurn", no triggerTurn: appends to session history, no turn).
  // The canonical post-compaction model context (buildSessionContext) decides: when the newest copy still
  // survives, append nothing so the journal stays append-only without duplicates. The per-request
  // CHIEF_OF_STAFF one-liner stays in the `context` hook as the cheap pointer; this entry carries the
  // full text only when the rules are genuinely missing after compaction.
  pi.on("session_compact", (_event, ctx) => {
    if (isMain(ctx)) {
      if (survivingCompactionCustomType(ctx, CHIEF_RULES_ENTRY_TYPE)) return;
      const chief = host.getActiveSkills?.().find((skill) => skill.name === "chief-of-staff");
      let text: string | undefined;
      if (chief?.filePath) {
        try {
          text = readFileSync(chief.filePath, "utf8");
        } catch {
          text = undefined;
        }
      }
      if (text) {
        pi.sendMessage(
          { customType: CHIEF_RULES_ENTRY_TYPE, content: text, display: false, attribution: "agent" },
          { deliverAs: "nextTurn" },
        );
      }
      return;
    }
    if (survivingCompactionCustomType(ctx, WORKER_BRIEF_ENTRY_TYPE)) return;
    const init = selectBranchEntries(ctx.sessionManager, (metadata) => metadata.type === "session_init")[0];
    const brief = init && "task" in init && typeof init.task === "string" ? init.task : undefined;
    if (brief) {
      pi.sendMessage(
        { customType: WORKER_BRIEF_ENTRY_TYPE, content: brief, display: false, attribution: "agent" },
        { deliverAs: "nextTurn" },
      );
    }
  });
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
    const phases = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx));
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
      reason: `Write agent://${shorten(currentOwner, 35)} for ${actionTarget(row.content, 28)}.\n${addressed} is settled; row ${JSON.stringify(shorten(row.content))} current live owner is ${currentOwner}; redirect requested.`,
    };
  };
  let lastTaskDispatchRefused = false;
  const blockWorkerWork = (event: { toolName: string; input?: unknown }, ctx: ExtensionContext) => {
    if (isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) return;
    if (pauseGate?.paused || !isMain(ctx) || !pi.getActiveTools().includes("task")) return;
    const input = (event.input ?? {}) as { command?: unknown; path?: unknown };
    if (!isWorkerWork(event.toolName, event.input)) return;
    const decision = currentDecision(ctx);
    if (!decision.key || !decision.forecast || decision.goalPaused || !decision.staffingSnapshotComplete) return;
    // Refusal must name work that can actually be delegated, not an empty task list.
    if (!decision.dispatchableReady?.length) return;
    const jobs = ctx.getAsyncJobSnapshot();
    const runningTasks = (jobs?.running ?? []).filter((job) => job.type === "task" && job.status === "running").length;
    const open = (decision.forecast.rows ?? []).filter((row) => row.status === "pending" || row.status === "in_progress");
    // Dependency-blocked rows cannot start yet: when every ready row already has a running
    // owner and the blocked rows wait on real outputs (not dangling links a rewrite could
    // free), they are chain, not idle (live 2026-10-12), and leave the parked count. While
    // a ready row still needs staffing they keep their pressure in the count.
    const chiefReadyCandidates = decision.readyCandidates ?? [];
    const chiefAllReadyStaffed = chiefReadyCandidates.length > 0 && chiefReadyCandidates.every((row) => row.ownership === "live-owned" || row.ownership === "shared-live-owner");
    const chiefGenuineChain = chiefAllReadyStaffed && !hasReplannableWait(decision);
    const parked = open.length - (chiefGenuineChain ? open.filter((row) => !row.ready).length : 0) - runningTasks - (decision.externallyStaffedCount ?? 0);
    if (!understaffed(ctx, runningTasks, parked) || lastTaskDispatchRefused) return;
    if (chiefRefusals >= MAX_CHIEF_REFUSALS) return; // it insists three times in a row: let it through
    chiefRefusals += 1;
    gateTrace(ctx, `chief-refused-${event.toolName}`, { runningTasks, parked });
    const ready = (decision.dispatchableReady ?? []).slice(0, MAX_TASK_DISPATCH).map((row) => JSON.stringify(shorten(row.content)));
    return {
      block: true,
      reason: `Staff ${actionTarget(decision.dispatchableReady[0].content)} via task before ${event.toolName}.\nBlocked: ${event.toolName} is work for a worker. Start one with a task call for: ${ready.join(", ")}. If a row only waits on a unit or job, set its owner to unit:<name> or job:<pid>. Reading (read, grep, find, git status/log/show/diff) stays allowed. ${ORDER}`,
    };
  };
  const completedPlanRows = (ctx: ExtensionContext): Array<{ content: string; schedule?: { owner?: unknown } }> => {
    try {
      return sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx))
        .flatMap((phase) => phase.tasks)
        .filter((task) => task.status === "completed" || task.status === "abandoned");
    } catch {
      return [];
    }
  };
  const reopenWordTargetsAcceptedRow = (ctx: ExtensionContext, workerName: string, word: string, taskText: unknown): boolean => {
    const completed = completedPlanRows(ctx);
    if (completed.length === 0) return false;
    if (typeof taskText === "string") {
      const needle = taskText.toLowerCase().trim();
      if (needle && completed.some((row) => row.content.toLowerCase().trim() === needle)) return true;
    }
    const tokenize = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
    const nameTokens = new Set([...tokenize(workerName.replace(word, "")), ...tokenize(workerName)]);
    return completed.some((row) => {
      const owner = row.schedule?.owner;
      if (typeof owner === "string" && owner && workerName.toLowerCase().includes(owner.toLowerCase())) return true;
      const rowTokens = new Set(tokenize(row.content));
      for (const token of nameTokens) if (rowTokens.has(token)) return true;
      return false;
    });
  };
  const isExistingOwnerName = (ctx: ExtensionContext, name: string) => {
    try {
      return sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx))
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
      if (REOPEN_WORD_GROUPS[group] === true && !reopenWordTargetsAcceptedRow(ctx, item.name, word, item.task)) continue;
      gateTrace(ctx, "planning-failure-worker-name-refused", { name: item.name, word });
      return {
        block: true,
        reason: `Rename ${actionTarget(item.name)} to the result it produces.\nWorker name ${JSON.stringify(item.name)} contains planning-failure word ${JSON.stringify(word)}: name the result its row produces, verb first (e.g. AdmitChiefBashLooks), never a reopen verb like Fix/Repair/Retry; a resend reuses the row owner. ${WORKER_NAME_ACTION[group] ?? WORKER_NAME_ACTION.Owner} (skill step 8: ${WORKER_NAME_GUIDANCE[group] ?? WORKER_NAME_GUIDANCE.Owner}).`,
      };
    }
  };
  const refuseConcurrentGitPrOwner = (event: { toolName: string; input?: unknown }, ctx: ExtensionContext) => {
    if (event.toolName !== "task" || !isMain(ctx)) return;
    const gitItems = taskItems(event.input).filter(isGitPrOwnerItem);
    if (!gitItems.length) return;
    const phases = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx));
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
          reason: `Use ${shorten(conflict.owner, 30)} for ${actionTarget(displayCheckoutKey(key))}; keep one git-pr-owner.\ncheckout ${displayCheckoutKey(key)} already has live git-pr-owner ${conflict.owner}; do not start a second git-pr-owner on the same checkout. Use a different worktree for parallel git ownership, or wait for the running one.`,
        };
      }
      const previous = claimed.get(key);
      if (previous) {
        gateTrace(ctx, "git-pr-owner-batch-checkout-refused", { checkout: displayCheckoutKey(key), first: previous, second: item.name });
        return {
          block: true,
          reason: `Keep only ${shorten(previous, 28)} for ${actionTarget(displayCheckoutKey(key))} in this batch.\ncheckout ${displayCheckoutKey(key)} is targeted by multiple git-pr-owner task items in this batch (${previous}, ${String(item.name ?? "unnamed")}); one checkout gets one git-pr-owner.`,
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
    if (isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)), now / 1_000)) return;
    if (!decision.key || !decision.forecast) return gateTrace(ctx, "no-plan");
    if (!decision.staffingSnapshotComplete) return gateTrace(ctx, "staffing-snapshot-incomplete");
    if (decision.goalPaused) return gateTrace(ctx, "goal-paused");
    if (!pi.getActiveTools().includes("todo")) return gateTrace(ctx, "todo-tool-inactive");
    const jobs = ctx.getAsyncJobSnapshot();
    const runningTasks = (jobs?.running ?? []).filter((job) => job.type === "task" && job.status === "running").length;
    if (runningTasks > 0 && decision.readyCandidates.length > 0 &&
      decision.readyCandidates.every((row) => row.ownership === "live-owned") &&
      (decision.forecast.planningIssues ?? []).length === 0 && !hasReplannableWait(decision)) {
      pendingReplan = null;
      return gateTrace(ctx, "waiting-on-staffed-work");
    }
    const open = (decision.forecast.rows ?? []).filter((row) => row.status === "pending" || row.status === "in_progress");
    // Dependency-blocked rows cannot start yet: when every ready row already has a running
    // owner and the blocked rows wait on real outputs (not dangling links a rewrite could
    // free), they are chain, not idle (live 2026-10-12), and leave the parked count. While
    // a ready row still needs staffing they keep their pressure in the count.
    const replanReadyCandidates = decision.readyCandidates ?? [];
    const replanAllReadyStaffed = replanReadyCandidates.length > 0 && replanReadyCandidates.every((row) => row.ownership === "live-owned" || row.ownership === "shared-live-owner");
    const replanGenuineChain = replanAllReadyStaffed && !hasReplannableWait(decision);
    const parked = open.length - (replanGenuineChain ? open.filter((row) => !row.ready).length : 0) - runningTasks - (decision.externallyStaffedCount ?? 0);
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
    // Grievance rows wait on real outputs or external gates: no rewrite can free them, so a
    // split demand only manufactures noise. Stay silent unless a row waits on something that
    // is not a real output (ready work without a worker is handled on the staffing path
    // above). A resource queue on the critical chain is not an output link either — the
    // waiting list itself marks it "not a dependency" — and copying the contended resource
    // can free it, so it stays replannable. A plan bigger than the worker slots still gets
    // the prune demand: dropping rows is something a rewrite can always do.
    if (!hasReplannableWait(decision) && !criticalWaitList(ctx, open).includes("queued behind") && parked < workerCapacity(ctx)) {
      pendingReplan = null;
      return gateTrace(ctx, "waiting-on-real-outputs", { runningTasks, parked });
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
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") {
      userInputs += 1;
      if (!singleWriterLane) {
        const branch = dispatchStateEntries(ctx);
        const wasAway = lastPresence === "away" || derivePresence(branch, rehydrateDeadlineState(branch), Date.now()) === "away";
        if (wasAway) {
          lastPresence = "away";
          queueReturnNotice(sdk.getLatestTodoPhasesFromEntries(branch as never));
        }
      }
    }
    if (singleWriterLane) return;
    if (isCorrectionInput(event.text, event.source)) sprintState = { ...sprintState, correctionPending: true };
  });
  let gitStateCache: { cwd: string; at: number; state: GitIntegrationState | null } | null = null;
  const lastChiefHead = new Map<string, string>();
  let gitStatePending: { cwd: string; promise: Promise<GitIntegrationState | null> } | null = null;
  const gitState = async (ctx: ExtensionContext, now: number, force = false): Promise<GitIntegrationState | null> => {
    if (!force && gitStateCache?.cwd === ctx.cwd && now - gitStateCache.at <= 15_000) return gitStateCache.state;
    if (gitStatePending?.cwd === ctx.cwd) return gitStatePending.promise;
    const pending = { cwd: ctx.cwd, promise: readGitIntegrationState(ctx.cwd, now) };
    gitStatePending = pending;
    try {
      const state = await pending.promise;
      if (gitStatePending === pending) gitStateCache = { cwd: pending.cwd, at: Date.now(), state };
      return state;
    } finally {
      if (gitStatePending === pending) gitStatePending = null;
    }
  };
  const resolvedMerge = (state: GitIntegrationState | null) =>
    state?.mergeHead !== undefined && state.unmerged === 0 && (state.mergeAgeMs ?? 0) >= STALE_MERGE_MS ? state : null;
  const integrationRequirement = (ctx: ExtensionContext, goalActive: boolean, now: number) => {
    // This host callback is synchronous. Never run a child process here or use
    // expired advice; context/tool admission refreshes the canonical snapshot.
    const state = gitStateCache?.cwd === ctx.cwd && now - gitStateCache.at <= 15_000 ? gitStateCache.state : null;
    const merge = resolvedMerge(state);
    if (state?.mergeHead) sendHarnessNotice("todo-gate-merge", state.mergeHead, prompt.render(gateNoticeInstructions, { merge: true, head: state.mergeHead }).trim());
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
    const manager = AgentRegistry.global().get(worker.name)?.session?.sessionManager;
    if (manager && worker.path && typeof manager.getSessionFile === "function" && manager.getSessionFile() === worker.path) {
      const entry = selectLatestBranchEntry(manager, metadata => metadata.type === "compaction");
      const at = entry ? Date.parse(entry.timestamp) : undefined;
      return at !== undefined && Number.isFinite(at) ? at : undefined;
    }
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
  const workerTrace = (ctx: ExtensionContext, id: string) => {
    const path = workerSessionPath(ctx, id);
    if (!path) return { lastTool: "none", wrote: [] as string[], repos: [] as string[] };
    const sessionCwd = (AgentRegistry.global().get(id)?.session?.sessionManager?.getCwd?.() ?? (ctx as { cwd?: string }).cwd) as string | undefined;
    const wrote: string[] = [];
    const repos: string[] = [];
    let lastTool = "none";
    let receiptAt: number | undefined;
    const rememberRepo = (dir: string | undefined) => {
      const root = dir && isAbsolute(dir) ? gitRootOf(dir) : undefined;
      if (root && !repos.includes(root)) repos.push(root);
    };
    const rememberPath = (candidate: unknown, base: string | undefined) => {
      const file = normalizeWrittenPath(candidate, base);
      if (!file) return;
      if (!wrote.includes(file)) wrote.push(file);
      if (isAbsolute(file)) rememberRepo(dirname(file));
    };
    const observeTool = (name: unknown, rawArgs: unknown) => {
      if (typeof name !== "string") return;
      const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
      const target = toolTarget(name, args);
      lastTool = target ? `${name} ${target}` : name;
      if (name === "edit" || name === "write") {
        rememberPath(args.path ?? args.file_path, sessionCwd);
        for (const file of editInputPaths(args.input)) rememberPath(file, sessionCwd);
      }
      if (name === "bash" && typeof args.command === "string") {
        const callCwd = normalizeWrittenPath(args.cwd, sessionCwd) ?? sessionCwd;
        const effects = bashWriteEffects(args.command, callCwd);
        for (const file of effects.files) rememberPath(file, callCwd);
        for (const dir of effects.dirs) rememberRepo(dir);
      }
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
        const msg = message as { role?: unknown; toolName?: unknown; content?: unknown; timestamp?: unknown; isError?: unknown };
        if (msg.role === "toolResult" && msg.toolName === "yield" && msg.isError !== true && typeof msg.timestamp === "number")
          receiptAt = Math.max(receiptAt ?? 0, msg.timestamp);
        if (msg.role === "toolResult") observeTool(msg.toolName, {});
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          if (typeof part !== "object" || part === null) continue;
          const item = part as { type?: unknown; name?: unknown; arguments?: unknown };
          if (item.type === "toolCall") observeTool(item.name, item.arguments);
        }
      }
    } catch {}
    return { lastTool, wrote: wrote.slice(-4), repos, receiptAt };
  };
  // The worker's own worktrees: git roots it edited, added or committed in. The session cwd is the lead's
  // checkout and only stands in when the worker has not touched any other repository.
  const workerRepoRoots = (ctx: ExtensionContext, id: string): string[] => {
    const sessionCwd = AgentRegistry.global().get(id)?.session?.sessionManager?.getCwd?.() as string | undefined;
    let repos: string[] = [];
    try { repos = workerTrace(ctx, id).repos; } catch {}
    const own = repos.filter((root) => !sessionCwd || resolve(root) !== resolve(sessionCwd));
    if (own.length) return own;
    return sessionCwd ? [sessionCwd] : [];
  };
  const workerCommitAt = async (ctx: ExtensionContext, id: string): Promise<number | undefined> => {
    const times: number[] = [];
    for (const root of workerRepoRoots(ctx, id)) {
      try {
        const repo = vcs.git(root);
        if (!repo) continue;
        const at = await vcs.lastCommitTime(repo);
        if (typeof at === "number") times.push(at);
      } catch {}
    }
    return times.length ? Math.max(...times) : undefined;
  };
  const noCommitWarnings = new Set<string>();
  // Newest mtime of any file under a worker's cwd (bounded walk; VCS and build dirs skipped). A worker that
  // is alive but waiting writes its session file and nothing else; the files it is meant to change tell
  // whether it is working.
  const newestFileMtime = (root: string | undefined): number | undefined => {
    if (!root) return undefined;
    let newest: number | undefined;
    let budget = 4000;
    const walk = (dir: string, depth: number) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (budget-- <= 0) return;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 4) walk(full, depth + 1);
        } else {
          try {
            const mtime = statSync(full).mtimeMs;
            if (newest === undefined || mtime > newest) newest = mtime;
          } catch {}
        }
      }
    };
    walk(root, 0);
    // A walk cut off by the entry budget only underestimates the newest mtime, so a "stale" verdict
    // from it is unknown, never a number (live 2026-10-23: "no file change ... for 125916 min").
    // Epoch or invalid mtimes are unknown too.
    if (newest !== undefined && (!Number.isFinite(newest) || newest <= 0)) return undefined;
    if (budget <= 0 && newest !== undefined && Date.now() - newest > SILENT_MS) return undefined;
    return newest;
  };
  const silentWorkers = (activity: ReturnType<typeof workerActivity>) =>
    activity.filter((worker) => worker.known && worker.ageMs !== undefined && worker.ageMs >= SILENT_MS);
  const minutes = (ms: number | undefined) => `${Math.round((ms ?? 0) / 60_000)} min`;
  const hhmm = (at: number, timeZone?: string) => formatLocalClock(at, timeZone);
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
    sendHarnessNotice(
      "todo-worker-message-undelivered",
      id,
      `PLAN CHECK: overdue check-in not delivered to ${id}: ${result.text}; ${fallback}.`,
    );
  };
  const overdueWorkerCheckins = (
    ctx: ExtensionContext,
    open: TodoTaskForecast[],
    running: Array<{ id: string; agentId?: string; startTime?: number }>,
    activity: ReturnType<typeof workerActivity>,
    now: number,
    timeZone?: string,
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
      const content = `your row ${shorten(row.content)} is past its P95 at ${hhmm(p95, timeZone)}; reply with current artifact/path, first failing proof, or what you wait on`;
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
  const integrationFacts = async (ctx: ExtensionContext, now: number) => {
    const state = await gitState(ctx, now, true);
    const lines: string[] = [];
    const sessionId = ctx.sessionManager.getHeader?.()?.id ?? "unknown";
    const headKey = `${ctx.cwd}\0${sessionId}`;
    const previousHead = lastChiefHead.get(headKey);
    if (state?.head) {
      if (previousHead && previousHead !== state.head) {
        const commits = await readGitLogSince(ctx.cwd, previousHead);
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
  if (!singleWriterLane && softRequirementApi.registerSoftToolRequirementProvider && pauseGate) {
    // The skipped-call text omp shows the model says only "the pending action"; the reminder
    // reaches just the forced request. Keep the live demand in every request's context instead.
    const demandProvider = (ctx: ExtensionContext) => {
      if (isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) return;
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
      if (isMain(ctx)) syncCriticalFast(ctx, decision, fastByWorker);
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

  let pendingFinishDelay: { notice: string; allowedFinish: number } | null = null;
  const resetFinishHistory = (ctx: ExtensionContext) => {
    finishSamples.length = 0;
    finishSession = ctx.sessionManager.getHeader()?.id;
    recedingSince = undefined;
    pendingFinishDelay = null;
    // The answered demand must not linger as the lead's last word: the next
    // tick's check repeats a pre-escalation text, so the digest dedupe would
    // swallow it and leave the stale escalated demand standing. Drop the
    // cached plan-check digests (and the repeat key) so the fresh check goes
    // out once.
    const keptNotices = Object.fromEntries(
      Object.entries(sprintState.lastNotices).filter(([key]) => !key.startsWith("todo-plan-check ")),
    );
    sprintState = { ...sprintState, lastNotices: keptNotices };
    lastIdlePlanCheck = null;
    lastIdlePlanCheckAt = 0;
    persistSprintState();
  };

  const workerWorksElsewhere = new Map<string, string>();
  pi.on("before_subagent_spawn", async (event, ctx) => {
    if (singleWriterLane) return;
    await refreshLiveWorkerModels(ctx);
    if (event.agent !== "plan-doctor") return;
    const decision = currentDecision(ctx, Date.now(), [], true);
    const paths = planSnapshotPaths(ctx);
    return decision.key
      ? { note: `plan snapshot refreshed: ${paths.byCwd}` }
      : { note: `plan snapshot unavailable: no current main-session plan` };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "wait") {
      const reason = unansweredUserReason(ctx);
      if (reason) return { block: true, reason };
    }
    // A safety control, not a staffing gate: it holds even when the staffing gates are switched off.
    if (event.toolName === "bash" && !isMain(ctx)) {
      const command = (event.input as { command?: unknown } | undefined)?.command;
      if (typeof command === "string" && isGlobalKillCommand(command)) return { block: true, reason: GLOBAL_KILL_REFUSAL };
    }
    if (!isMain(ctx)) {
      const reason = refuseRelativeWorkerWrite(workerWorksElsewhere, ctx.sessionManager.getHeader()?.id ?? ctx.cwd, event.toolName, event.input, ctx.cwd);
      if (reason) return { block: true, reason };
    }
    await refreshLiveWorkerModels(ctx);
    if (gateSwitchedOff(ctx)) return;
    if (singleWriterLane) return;
    const badWorkerName = refusePlanningFailureWorkerName(event as { toolName: string; input?: unknown }, ctx);
    if (badWorkerName) return badWorkerName;
    if (event.toolName === "task") lastTaskDispatchRefused = false;
    const gitOwnerConflict = refuseConcurrentGitPrOwner(event as { toolName: string; input?: unknown }, ctx);
    if (gitOwnerConflict) return gitOwnerConflict;
    if (event.toolName === "task" && isPlanDoctorTaskInput(event.input)) {
      // The plan-doctor reads the whole plan: every row open now has been looked at by an executor.
      try {
        let marked = false;
        for (const phase of sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx)))
          for (const task of phase.tasks)
            if (isOpenRowStatus(task.status) && !sprintState.seenRows.includes(task.content)) { sprintLiveRows = new Set([...(sprintLiveRows ?? []), task.content]); addSeenRow(task.content); marked = true; }
        if (marked) persistSprintState();
      } catch {}
      currentDecision(ctx, Date.now(), [], true);
      resetFinishHistory(ctx);
    }
    if (event.toolName === "todo") {
      // One persist for both: the override sets ignoredDemands[gate]=-5 and the retro reset clears it back
      // to 0 when the same input names retro, so persisting each step wrote a net-zero record in between.
      const gate = applyTodoOverride(event.input, ctx, false);
      const retroMentioned = /retro/i.test(JSON.stringify(event.input ?? {}));
      if (retroMentioned) resetDemand("retro", false);
      if (gate !== undefined || retroMentioned) persistSprintState();
      // R1/R2: refuse the same-owner reestimate on a slipping row before any other todo handling.
      if (!pauseGate?.paused) {
        const runningProfiles = new Map<string, string | undefined>();
        const runningStartedAt = new Map<string, number>();
        for (const job of ctx.getAsyncJobSnapshot()?.running ?? []) {
          const candidate = job as typeof job & { agent?: unknown; agentProfile?: unknown; profile?: unknown; startTime?: unknown };
          const profile = typeof candidate.agent === "string" ? candidate.agent
            : typeof candidate.agentProfile === "string" ? candidate.agentProfile
              : typeof candidate.profile === "string" ? candidate.profile : undefined;
          runningProfiles.set(job.agentId ?? job.id, profile);
          if (typeof candidate.startTime === "number") runningStartedAt.set(job.agentId ?? job.id, candidate.startTime);
        }
        const rows = currentDecision(ctx, Date.now(), [], true, true).forecast?.rows ?? [];
        const updates = todoScheduleUpdates(event.input);
        const slip = slipReestimateRefusal({
          updates,
          rows,
          runningProfiles,
          runningStartedAt,
          now: Date.now(),
        });
        if (slip) {
          for (const row of rows) {
            if (row.reestimateCount < 2 || !row.owner) continue;
            if (slipReestimateRefusal({ updates, rows: [row], runningProfiles, runningStartedAt, now: Date.now() }) === slip) {
              requireRecovery(ctx, { kind: "cap", row: row.content, owner: row.owner, at: Date.now(), startTime: runningStartedAt.get(row.owner) });
              break;
            }
          }
          announceGates(ctx);
          gateTrace(ctx, "slip-reestimate-refused", {});
          return { block: true, reason: slip };
        }
      }
    }
    if (event.toolName === "task" && taskItems(event.input).some((item) => item["agent"] === "retro-facilitator")) resetDemand("retro");
    if (event.toolName === "wait") {
      if (isMain(ctx) && !pauseGate?.paused) {
        const recovery = activeRecoveries(ctx)[0];
        if (recovery) return { block: true, reason: recoveryNotice(recovery) };
      }
      return blockIdleWait(ctx);
    }
    if (event.toolName === "task") chiefRefusals = 0;
    const rerouted = rerouteSettledWorkerWrite(event as { toolName: string; input?: unknown }, ctx);
    if (rerouted) return rerouted;
    const chief = blockWorkerWork(event as { toolName: string; input?: unknown }, ctx);
    if (chief) return chief;
    if ((event.toolName === "task" || event.toolName === "todo") && isMain(ctx) && !pauseGate?.paused) {
      const text = JSON.stringify(event.input ?? {});
      const adds = event.toolName === "task" || /"op"\s*:\s*"(append|init)"/.test(text);
      // A worker told to commit (and push) the merge is the right move, not more merge work.
      const integration = MERGE_WORK.test(text) && (adds || event.toolName === "task") ? await gitState(ctx, Date.now(), true) : null;
      const merge = adds && !/\bcommit/i.test(text) ? resolvedMerge(integration) : null;
      const open = event.toolName === "task" ? integration : null;
      if (open?.mergeHead && !merge) {
        const items = ((event.input as { tasks?: unknown[] } | undefined)?.tasks ?? [event.input]).filter((item) => MERGE_WORK.test(JSON.stringify(item ?? {})));
        const running = (ctx.getAsyncJobSnapshot()?.running ?? []).filter((job) => job.type === "task" && job.status === "running" && MERGE_WORK.test(`${job.id} ${job.label ?? ""} ${job.agentId ?? ""}`));
        if (items.length > 1 || running.length > 0) {
          gateTrace(ctx, "merge-fanout-refused", { items: items.length, running: running.map((job) => job.id) });
          return {
            block: true,
            reason: running.length
              ? `Use ${shorten(running[0].id, 30)} for merge ${shorten(open.mergeHead, 12)}.\nMerge ${open.mergeHead} already has its worker (${running.map((job) => job.id).join(", ")}); one merge gets one worker. ${ORDER}`
              : `Assign one worker to merge ${shorten(open.mergeHead, 12)}.\nThis batch splits merge ${open.mergeHead} across ${items.length} workers; one merge gets one worker. ${ORDER}`,
          };
        }
      }
      if (merge) {
        gateTrace(ctx, `merge-work-refused-${event.toolName}`, { mergeHead: merge.mergeHead });
        return {
          block: true,
          reason: `Commit merge ${shorten(merge.mergeHead, 12)} now.\nThe merge of ${merge.mergeHead} has no unresolved paths; it needs a commit, not more merge work. ${ORDER}`,
        };
      }
    }
    // Ignored demands escalate: while one stands, only its remedy (a todo call or the
    // demanded specialist) and the always-allowed calls pass this one union decision.
    // Grievance 590: a demand the todo override names stays suppressed for the same
    // few-turn window, so it must not escalate while the override is active.
    // Ignored plan-fix demands escalate: the model must fix the plan, not start more work. Only a
    // read-tier call or a `todo` call that changes the plan passes; an override or a worker spawn
    // does not lift it. It clears when the next plan check no longer reports the problem.
    // retro stays a notice: a retrospective is extra work by definition.
    const escalatedIds = Object.keys(sprintState.ignoredDemands).filter((id) => PLAN_DEMAND_IDS.has(id) && isDemandEscalated(id));
    if (escalatedIds.length > 0 && isMain(ctx) && !pauseGate?.paused && !isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) {
      const planFix = (call: GateCall): boolean => call.name === "todo" && PLAN_FIX_OPS.has(todoOpOf(call) ?? "");
      const gates: ActiveGate[] = escalatedIds.map((id) => ({
        id,
        remedy: ESCALATION_REMEDY,
        satisfies: planFix,
      }));
      const gateCall = { name: event.toolName, arguments: (event.input ?? {}) as Record<string, unknown> };
      const verdict = decideGateCall(gateCall, gates);
      if (!verdict.allowed) {
        gateTrace(ctx, "escalation-refused", { toolName: event.toolName, gates: verdict.remedyGateIds });
        return { block: true, reason: `Plan problem ignored: ${verdict.remedyGateIds.join(", ")}. ${ESCALATION_REMEDY}` };
      }
    }
    if (event.toolName === "todo" && pendingReplan) pendingReplan.answered = pendingReplan.demands;
    if (event.toolName === "todo" && pendingTaskReconciliation?.linkDemanded) pendingTaskReconciliation.linkAnswered = true;
    if (event.toolName === "task") {
      const agents = taskItems(event.input)
        .map((item) => item["agent"])
        .filter((agent): agent is string => typeof agent === "string");
      if (agents.length > 0) dispatchedAgents.set(event.toolCallId, agents);
      for (const item of taskItems(event.input)) {
        if (item.agent === "retro-facilitator" && typeof item.name === "string") {
          retroFacilitatorJobs.add(item.name);
          sprintState = { ...sprintState, retroFacilitatorJobs: [...retroFacilitatorJobs] };
          persistSprintState();
        }
      }
    }
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
  const recedingFinish = (ctx: ExtensionContext, open: TodoTaskForecast[], now: number, timeZone?: string): string => {
    const finish = recordFinishSample(ctx, open, now);
    if (finish === null) return "";
    const first = finishSamples[0];
    if (!first || now - first.at < DRIFT_WINDOW_MS) return "";
    // Receding: the finish moved later by at least 80% of the time that passed, so work is being
    // found about as fast as it is done.
    if (finish - first.finish < 0.8 * (now - first.at)) { recedingSince = undefined; return ""; }
    recedingSince ??= now;
    const history = finishSamples.filter((_, i, all) => i === 0 || i === all.length - 1 || i % 3 === 0).map((sample) => `${safeTimestamp(sample.at, timeZone)} → ${safeTimestamp(sample.finish, timeZone)}`).join(", ");
    // Twenty minutes after the first report the numbers have not changed the plan: a second look
    // with no execution duties decides, and the chief applies it (user 2026-09-25: "давай 1 2 3").
    if (now - recedingSince >= 20 * 60_000)
      return `the finish has receded with the clock for ${minutes(now - first.at)} and ${minutes(now - recedingSince)} after this was first reported (samples, now → finish: ${history}). Run \`task\` with agent \`plan-doctor\` now: give it the goal, these samples, the open rows with dependencies, owners and receipts, and ask one question: what makes the finish later and which plan change shortens it. Apply its plan in one \`todo\` call; do not add rows of your own before it answers`;
    return `the finish recedes with the clock: the projected finish moved from ${safeTimestamp(first.finish, timeZone)} (projected ${minutes(now - first.at)} ago) to ${safeTimestamp(finish, timeZone)} (projected now; the current time is ${safeTimestamp(now, timeZone)}). Work is being found as fast as it is done, one defect per attempt. Find all remaining defects in one pass (run the whole check once with failures collected instead of stopping at the first), fix them as parallel rows, and take every check that does not consume the stuck output off the chain`;
  };
  const retroWorkerIds = (): string[] => {
    const finishes = sprintState.workerFinishes.filter((finish) => (sprintState.lastRetroAt === null || finish.at >= sprintState.lastRetroAt) && !sprintState.retroCoveredIds.includes(finish.id));
    const counts = new Map<string, { count: number; firstAt: number }>();
    for (const finish of finishes) {
      const previous = counts.get(finish.id);
      counts.set(finish.id, { count: (previous?.count ?? 0) + 1, firstAt: Math.min(previous?.firstAt ?? finish.at, finish.at) });
    }
    return [...counts.entries()].sort((left, right) => right[1].count - left[1].count || left[1].firstAt - right[1].firstAt || left[0].localeCompare(right[0])).slice(0, 12).map(([id]) => id);
  };
  const retroNotifyKey = (): string => `${sprintState.retroDueReason ?? ""}|${sprintState.retroDueDeadlineAt ?? ""}|${sprintState.retroDueDeliveryKey ?? ""}|${retroWorkerIds().join(",")}`;
  const retroRowStaffed = (phases: TodoScheduleInput): boolean => phases.flatMap((phase) => phase.tasks).some((task) => /retro/i.test(task.content) && typeof task.schedule?.owner === "string" && task.schedule.owner.length > 0);
  const buildRetroLine = (now: number, timeZone?: string): string => {
    if (!sprintState.retroDueReason) return "";
    const since = sprintState.lastRetroAt ?? sprintState.goalWorkStartedAt ?? now;
    const workerIds = retroWorkerIds();
    if (workerIds.length === 0) return `retrospective due (${sprintState.retroDueReason}): no new eligible worker reports. Review the triggering incident using the lead's tool results, plan history and available receipts; do not fabricate worker reports or skip the incident review. Then retro-facilitator (skill://chief-of-staff Retrospective) uses that evidence to identify what happened and the next corrective action. Create a mechanism row editing a skill or prompt only when the evidence identifies an actual instruction defect; otherwise record that no instruction change is warranted. It closes only when a task with agent retro-facilitator completes; retro notes recorded on todo rows do not close it.`;
    return `retrospective due (${sprintState.retroDueReason}): read the Retro block in the final answer of the ${workerIds.length} workers who finished since ${safeTimestamp(since, timeZone)} from agent://<id> (do not write to them; a missing block is recorded as missing), then retro-facilitator (skill://chief-of-staff Retrospective): ${workerIds.join(", ") || "none"}; for each red item, identify which instruction line (skill or prompt) missed it and output a mechanism row that edits that instruction. It closes only when a task with agent retro-facilitator completes; retro notes recorded on todo rows do not close it.`;
  };
  let lastPlanProblems = "";
  const planCheck = async (ctx: ExtensionContext, pending: unknown[] = [], problemsOnly = false): Promise<string | null> => {
    // Finish I/O before reading or mutating plan state. A worker may finish or
    // a todo result may arrive while Git is pending; judge the fresh snapshot.
    const sampledJobs = (ctx.getAsyncJobSnapshot()?.running ?? []).filter((job) => job.type === "task" && job.status === "running");
    const commitTimes = new Map(await Promise.all(sampledJobs.map(async (job) => {
      const id = job.agentId ?? job.id;
      return [id, await workerCommitAt(ctx, id)] as const;
    })));
    pendingSizingNoticeIds = [];
    const now = Date.now();
    const decision = currentDecision(ctx, now, pending);
    announceGates(ctx, pending, now, decision);
    const phasesNow = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx, pending) as never);
    touchSprintState(ctx, phasesNow, ctx.getAsyncJobSnapshot(), now, decision.deadline, decision.alarms);
    const retroAdvice = () => {
      if (!sprintState.retroDueReason) return "";
      const notifyKey = retroNotifyKey();
      if (sprintState.retroDueNotifiedKey === notifyKey) return "";
      sprintState = { ...sprintState, retroDueNotifiedKey: notifyKey };
      persistSprintState();
      return buildRetroLine(now, decision.deadline?.timezone);
    };
    const retroLine = retroAdvice();
    if (!decision.forecast)
      return retroLine
        ? `PLAN CHECK: 1 problem(s). (1) ${retroLine}. Fix them with the pass of skill://chief-of-staff.`
        : null;
    const rows = decision.forecast.rows ?? [];
    const openContents = new Set(
      phasesNow.flatMap((phase) => phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress").map((task) => task.content)),
    );
    const open = rows.filter((row) => (row.status === "pending" || row.status === "in_progress") && openContents.has(row.content));
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
      pendingFinishDelay = { notice: finishDelayNotice, allowedFinish: previousFinish };
    }
    const names = (list: Array<{ content: string }>) =>
      list.slice(0, 6).map((row) => JSON.stringify(shorten(row.content))).join(", ") + (list.length > 6 ? `, … ${list.length - 6} more` : "");
    const running = (ctx.getAsyncJobSnapshot()?.running ?? []).filter((job) => job.type === "task" && job.status === "running");
    const owners = new Set(decision.todoOwnerIds ?? []);
    const unlinked = running.filter((job) => !owners.has(job.id) && !(job.agentId && owners.has(job.agentId)) && ![...owners].some((owner) => job.id.replace(/-\d+$/, "") === owner));
    const missing = (decision.forecast.planningIssues ?? []).length;
    const overdue = open.filter((row) => row.overdue);
    const ready = (decision.dispatchableReady ?? []).filter((row) => openContents.has(row.content));
    const idle = open.length - running.length - (decision.externallyStaffedCount ?? 0);
    // A row naming an owner that runs nowhere looks staffed in the HUD and is not (user 2026-09-25:
    // "Owner not running - run it!!!!"): name each one so it is resumed by its exact name.
    // The HUD's "N unresolved": open rows omp cannot forecast. Nobody but the chief can fix them.
    const unresolved = open.filter((row) => (row as { fixedPathP95Finish?: number }).fixedPathP95Finish === undefined);
    const why = (row: unknown) => ((row as { issues?: string[] }).issues ?? [])[0];
    const deadOwners = (decision.readyCandidates ?? []).filter((row) =>
      openContents.has(row.content) && row.owner && row.ownership !== "live-owned" && row.ownership !== "shared-live-owner"
    );
    // Few workers and no ready row: the rows wait on running work, which only the chief can unchain
    // (live 2026-09-25 03:35: 1 of 20 workers ran for half an hour and nothing said so).
    const capacity = workerCapacity(ctx);
    const waitingCritical = criticalWaitList(ctx, open);
    const understaffed = running.length < capacity && ready.length === 0 && idle > 0;
    const activity = workerActivity(ctx, running, now);
    const activeJobIds = new Set(running.map((job) => job.id));
    for (const id of workerSizingNoticed) if (!activeJobIds.has(id)) workerSizingNoticed.delete(id);
    const activeWorkerNames = new Set(activity.map((worker) => worker.name));
    for (const name of workerCompactionCursors.keys()) if (!activeWorkerNames.has(name)) workerCompactionCursors.delete(name);
    const checkins = overdueWorkerCheckins(ctx, open, running, activity, now, decision.deadline?.timezone);
    const checkedIn = new Set(checkins.map((worker) => worker.id));
    const silent = silentWorkers(activity).filter((worker) => !checkedIn.has(worker.name));
    const activityByName = new Map(activity.map((worker) => [worker.name, worker]));
    const workerInfos = running.map((job) => {
      const id = job.agentId ?? job.id;
      const row = open.find((candidate) => candidate.owner === job.id || candidate.owner === job.agentId);
      AgentRegistry.global().setTodoRow(id, row?.content);
      const label = row?.content ?? job.label ?? id;
      const p95 = row?.fixedPathP95Finish ?? row?.resourceFinish;
      const p95Text = typeof p95 === "number" && Number.isFinite(p95)
        ? now >= p95 ? `past ${minutes(now - p95)} (P95 ${hhmm(p95, decision.deadline?.timezone)})` : `due ${hhmm(p95, decision.deadline?.timezone)}`
        : "unknown";
      const trace = workerTrace(ctx, id);
      const age = activityByName.get(id)?.ageMs;
      return { id, row, label, trace, age, p95Text };
    });
    let escalated = false;
    const staleWorkers = workerInfos.flatMap(({ id, row, label, trace }) => {
      const job = running.find(candidate => (candidate.agentId ?? candidate.id) === id);
      const startTime = job?.startTime;
      const elapsed = typeof startTime === "number" ? now - startTime : 0;
      const commitAt = commitTimes.get(id);
      const roots = elapsed > SILENT_MS ? workerRepoRoots(ctx, id) : [];
      const mtimes = roots.map((root) => newestFileMtime(root)).filter((value): value is number => value !== undefined);
      const filesAt = mtimes.length ? Math.max(...mtimes) : undefined;
      const commitStale = commitAt !== undefined && now - commitAt > SILENT_MS;
      const filesStale = filesAt !== undefined && now - filesAt > SILENT_MS && (commitAt === undefined || commitStale);
      const isStale = elapsed > SILENT_MS && (commitStale || filesStale);
      const minutesOld = Math.floor(elapsed / 60_000);
      // The wording changes at 30 and 60 minutes so the once-per-problem-list dedupe lets the escalation through.
      const stuckFor = elapsed >= 60 * 60_000 ? "STUCK over 60 min, stop it now" : elapsed >= 30 * 60_000 ? "STILL STUCK over 30 min" : "";
      const warning = isStale ? { minutes: minutesOld, lastLine: trace.lastTool, ...(row ? { row: row.content } : {}) } : undefined;
      AgentRegistry.global().setWorktreeWarning(id, warning);
      if (!warning) {
        noCommitWarnings.delete(id);
        return [];
      }
      noCommitWarnings.add(id);
      if (elapsed >= 60 * 60_000) {
        requireRecovery(ctx, { kind: "stuck", row: row?.content ?? label, owner: id, at: now, startTime });
        escalated = true;
      }
      return [`suspect: ${label} · ${id} · ${minutesOld} · ${trace.lastTool}${filesStale && !commitStale ? ` · no file change in its worktree for ${Math.floor((now - filesAt!) / 60_000)} min` : ""}${stuckFor ? ` (${stuckFor})` : ""}; write agent://${id} asking for done/left with a receipt, or stop it`];
    });
    if (escalated) announceGates(ctx, pending, now, decision);
    for (const id of noCommitWarnings) {
      if (running.some(job => (job.agentId ?? job.id) === id)) continue;
      AgentRegistry.global().setWorktreeWarning(id, undefined);
      noCommitWarnings.delete(id);
    }
    const overrunWorkers = workerInfos.flatMap(({ id, row }) => {
      if (!row || row.status !== "in_progress") return [];
      const budgetMs = todoOverrunBudgetMs({
        startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
        estimateUpdatedAt: typeof row.estimateUpdatedAt === "number" ? row.estimateUpdatedAt : undefined,
        reestimateCount: row.reestimateCount,
        estimateRangeSeconds: row.estimateRangeSeconds,
      });
      if (budgetMs === undefined || typeof row.startedAt !== "number") return [];
      const elapsedMs = now - row.startedAt;
      return elapsedMs > budgetMs
        ? [`overrun: ${JSON.stringify(row.content)} elapsed ${minutes(elapsedMs)} exceeds its ${minutes(budgetMs)} budget (elapsed-at-reestimate plus remaining); stop worker ${id}, get done/left receipt, then split the rest into new rows`]
        : [];
    });
    const distantBlocked = phasesNow
      .flatMap((phase) => phase.tasks.map((task) => ({ phase: phase.name, task })))
      .filter(({ task }) => task.status === "blocked" && typeof task.blocker === "string" && isDistantWaitReason(task.blocker))
      .map(({ task }) => `DROP blocked row ${JSON.stringify(task.content)} (${JSON.stringify(task.blocker)}); record a trigger note "when X changes -> do Y". Reserve blocked for waits of hours.`);
    const workerRows = workerInfos.flatMap(({ id, row, trace, age, p95Text }) => {
      if (!row) return [];
      const wrote = trace.wrote.length ? trace.wrote.join(",") : "none";
      return [`${id} row=${JSON.stringify(shorten(row.content))} last=${trace.lastTool} age=${minutes(age)} wrote=${wrote} P95=${p95Text}`];
    });
    const workerStatus = workerRows.length
      ? `Worker status: ${workerRows.slice(0, 8).join(" | ")}${workerRows.length > 8 ? ` | … ${workerRows.length - 8} more` : ""}`
      : "";
    const sizing = running.flatMap(job => {
      if (workerSizingNoticed.has(job.id)) return [];
      const id = job.agentId ?? job.id;
      const observed = activityByName.get(id);
      const compactedAt = observed ? workerCompactionAt(observed) : undefined;
      if (compactedAt !== undefined) return [{ id, jobId: job.id, fact: `compacted at ${hhmm(compactedAt, decision.deadline?.timezone)}` }];
      if (typeof job.startTime === "number" && now - job.startTime > SILENT_MS)
        return [{ id, jobId: job.id, fact: `running ${minutes(now - job.startTime)}` }];
      return [];
    });
    pendingSizingNoticeIds = sizing.map(worker => worker.jobId);
    const runningByContent = new Map((decision.ownerRunStates ?? []).map((row) => [row.content, row.running]));
    // A row that waits on unfinished rows (a running worker, a queued stage, or a user wait) cannot be
    // planned usefully yet: its estimate and split depend on that output. The nag names only rows whose
    // dependencies are empty, closed or unknown (a dangling link is a plan defect the chief can fix now).
    // Measured over four lead journals 2026-10-23: 71% of named rows were such waiters.
    const statusByContent = new Map(phasesNow.flatMap((phase) => phase.tasks).map((task) => [task.content, task.status] as const));
    const waitsOnUnfinished = (task: { schedule?: { dependencies?: readonly string[] } }) => {
      const deps = task.schedule?.dependencies ?? [];
      return deps.length > 0 && deps.every((dep) => {
        const status = statusByContent.get(String(dep));
        return status === "pending" || status === "in_progress" || status === "blocked";
      });
    };
    const unseenPlanningRows = phasesNow
      .flatMap((phase) => phase.tasks)
      .filter((task) => isOpenRowStatus(task.status) && runningByContent.get(task.content) !== true && !sprintState.seenRows.includes(task.content) && !waitsOnUnfinished(task))
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
      for (const phase of phasesNow)
        for (const task of phase.tasks) if (typeof task.schedule?.owner === "string") ownerOf.set(task.content, task.schedule.owner);
    } catch {}
    const unread = open.filter((row) => {
      const owner = ownerOf.get(row.content);
      return owner && !running.some((job) => job.id === owner || job.agentId === owner) && settled.some((job) => job.id === owner || job.agentId === owner);
    });
    const receding = recedingFinish(ctx, open, now, decision.deadline?.timezone);
    // Serial fan-in: many open rows wait directly on one row a worker is
    // running while worker slots are free (live batumarket 2026-10-22: 6 of 9 rows behind one
    // landing row, one worker running, no line said so). Waiting stays allowed; the chief is told
    // to split that row or start the independent parts now.
    const structure = new Map((decision.openStructure ?? []).filter(([content]) => openContents.has(content)));
    const serialQueues: string[] = [];
    if (running.length < capacity) {
      for (const row of open) {
        const owner = ownerOf.get(row.content);
        if (!owner || !running.some((job) => job.id === owner || job.agentId === owner)) continue;
        // Direct dependents only: a chain A->B->C->D is a pipeline that cannot be parallelised.
        const behind = new Set<string>();
        for (const [content, deps] of structure) if (content !== row.content && deps.includes(row.content)) behind.add(content);
        if (behind.size > 3)
          serialQueues.push(`${behind.size} rows are queued behind ${JSON.stringify(shorten(row.content))}: split it or start the independent parts now (${capacity - running.length} worker slot(s) free). Queued: ${names([...behind].map((content) => ({ content })))}`);
      }
    }
    const problems = [
      retroLine,
      ...staleWorkers,
      ...overrunWorkers,
      ...distantBlocked,
      planningAdvice,
      unread.length ? `${unread.length} worker result(s) came back and their rows are still open: ${names(unread)}. Read each receipt now and close the row or send it back with the reason, before any other plan change (skill step 4)` : "",
      finishDelayNotice,
      receding,
      checkins.length ? `${checkins.length} overdue worker check-in(s): ${checkins.slice(0, 6).map((worker) => worker.sent ? `overdue check-in ${worker.repeated ? "already " : ""}sent to ${worker.id} for ${JSON.stringify(shorten(worker.row))}; ${worker.activityText}` : `overdue check-in blocked for ${worker.id}: ${worker.text ?? missingWorkerMessageApi}; chief must write agent://${worker.id} manually`).join("; ")}${checkins.length > 6 ? `; … ${checkins.length - 6} more` : ""}` : "",
      sizing.length ? `worker sizing: ${sizing.map((worker) => `${worker.id} ${worker.fact}; write agent://${worker.id} asking for done/left with a receipt, then split the rest`).join("; ")}` : "",
      ...overlapWarnings,
      silent.length ? `${silent.length} running worker(s) silent: ${silent.slice(0, 6).map((worker) => `${worker.name} (${worker.lastAt === undefined ? "no activity since start" : "last activity"} ${minutes(worker.ageMs)} ago)`).join(", ")}; write agent://<id> asking what it waits on. Workers not named here are active: their results arrive by themselves, so do not read their history` : "",
      ...serialQueues,
      ...await criticalWorkerWarnings(ctx, open, running),
      understaffed && (hasReplannableWait(decision) || waitingCritical.includes("queued behind")) ? `only ${running.length} of ${capacity} worker slots run and no row is ready: the rest wait on running work. ${waitingCritical ? `Waiting rows on the chain that sets the ETA, in order:${waitingCritical}\n${waitingCritical.includes("queued behind") ? `${RESOURCE_QUEUE}\n` : ""}${WHY_EACH_LINK}\n${SPLIT_EACH} (skill step 7)` : "Split the waiting rows into the part that needs that result and the part that can start now, and dispatch the second part (skill step 7)"}` : "",
      missing ? `${missing} planning issue(s) (missing estimates or dependencies) block every non-read tool` : "",
      overdue.length ? `${overdue.length} open row(s) past their time: ${names(overdue)}` : "",
      unresolved.length ? `${unresolved.length} row(s) have no forecast (the TODO header's "unresolved"); fix their estimate, dependencies or resources, or drop them: ${unresolved.slice(0, 4).map((row) => `${JSON.stringify(shorten(row.content))}${why(row) ? ` (${shorten(why(row)!)})` : ""}`).join(", ")}${unresolved.length > 4 ? `, … ${unresolved.length - 4} more` : ""}` : "",
      unlinked.length ? `${unlinked.length} running worker(s) own no row: ${unlinked.slice(0, 6).map((job) => job.id).join(", ")}` : "",
      deadOwners.length ? `${deadOwners.length} ready row(s) name an owner that is not running; staff them in one task call, one item per row with name = that owner and task = the row's exact title plus what to return: ${deadOwners.slice(0, 6).map((row) => `${JSON.stringify(shorten(row.content))} (owner ${row.owner})`).join(", ")}${deadOwners.length > 6 ? `, … ${deadOwners.length - 6} more` : ""}` : "",
      ready.length && running.length < workerCapacity(ctx) ? `${ready.length} ready row(s) have no worker: ${names(ready)}` : "",
      ready.length > capacity - running.length && idle > capacity ? `${idle} idle rows for ${capacity} worker slots: prune before adding` : "",
    ].filter(Boolean);
    trackDemands([
      ...(retroLine ? ["retro"] : []),
      ...(receding.includes("plan-doctor") ? ["todo-plan-doctor"] : []),
      ...(pendingReplan ? ["todo-replan"] : []),
      ...(unlinked.length ? ["todo-link"] : []),
      ...(unread.length ? ["unread-receipts"] : []),
      ...(overdue.length ? ["missed-eta"] : []),
    ], false);
    // The identity of this check is its problem list alone: worker telemetry (last tool, age, files
    // written) changes every minute and must not make an unchanged problem look new.
    lastPlanProblems = problems.map((line, i) => `(${i + 1}) ${line}`).join(" ");
    // Background ticks must not wake the chief for healthy worker telemetry.
    if (problemsOnly && problems.length === 0) return null;
    return problems.length
      ? `PLAN CHECK: ${problems.length} problem(s). ${problems.map((line, i) => `(${i + 1}) ${line}`).join(" ")}.${workerStatus ? ` ${workerStatus}` : ""} Fix them with the pass of skill://chief-of-staff.`
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
    if (planTicker && tickerContext) tickerContext.clearTimer?.(planTicker);
    planTicker = null;
    tickerContext = null;
    lastIdlePlanCheck = null;
  };
  const markSizingNotices = () => {
    for (const id of pendingSizingNoticeIds) workerSizingNoticed.add(id);
    pendingSizingNoticeIds = [];
  };
  // Why the ticker was silent, readable from ~/.local/state/omp-todo-dispatch/<session>.gate.jsonl:
  // one line per change of reason, and a heartbeat every PLAN_HEARTBEAT_MS so "no lines" can only
  // mean "no ticks" (live 2026-10-20: a ticker stopped after 07:51Z and nothing said why).
  const PLAN_HEARTBEAT_MS = 10 * 60_000;
  const PLAN_HEAL_AFTER_MS = 3 * 60_000;
  let lastPlanTickAt = 0;
  let planTickCount = 0;
  let lastPlanTickReason = "";
  let lastPlanHeartbeatAt = 0;
  const planTrace = (ctx: ExtensionContext, reason: string, detail: Record<string, unknown> = {}) => {
    const now = Date.now();
    if (reason === lastPlanTickReason && now - lastPlanHeartbeatAt < PLAN_HEARTBEAT_MS) return;
    lastPlanTickReason = reason;
    lastPlanHeartbeatAt = now;
    try {
      const dir = join(homedir(), ".local", "state", "omp-todo-dispatch");
      mkdirSync(dir, { recursive: true });
      const session = ctx.sessionManager?.getHeader?.()?.id ?? "unknown";
      appendFileSync(join(dir, `${session}.gate.jsonl`), `${JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, plantick: reason, ticks: planTickCount, ...detail })}\n`);
    } catch {}
  };
  const planTick = async (ctx: ExtensionContext) => {
    lastPlanTickAt = Date.now();
    planTickCount += 1;
    try {
      if (isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) return planTrace(ctx, "user-deadline-missed");
      // ctx.hasPendingMessages() is not a guard: the notice is an aside, which the queue delivers in
      // order, and a flag stuck true silenced the ticker for a whole session.
      if (singleWriterLane) return planTrace(ctx, "single-writer-lane");
      if (pauseGate?.paused) return planTrace(ctx, "pause-gate");
      if (!isMain(ctx)) return planTrace(ctx, "not-main");
      if (!pi.getActiveTools().includes("task")) return planTrace(ctx, "task-tool-inactive");
      await refreshLiveWorkerModels(ctx);
      const check = await planCheck(ctx, [], true);
      if (!check) return planTrace(ctx, "no-problems");
      if (check === PLAN_CHECK_CLEAN) return planTrace(ctx, "plan-clean");
      // Once per distinct problem list, plus one heartbeat every PLAN_REDELIVERY_MS while the same problems
      // stand: a per-minute repeat made the model restate its status every minute (22:08-22:11), while
      // never repeating let problem kinds without an escalation step (understaffed, no worker) go
      // unmentioned for the rest of the session. Escalations change the wording, so they change the key.
      const now = Date.now();
      // Minutes and timestamps change every tick; the problem list is the same unless the words change.
      const key = lastPlanProblems
        .replace(/\(\d+\) planning round due:.*?\(skill:\/\/chief-of-staff Planning\)\s*/g, "")
        .replace(/\(\d+\) worker sizing:.*?(?= \(\d+\) |\. Fix them with the pass|$)/g, "")
        .replace(/\s+/g, " ")
        .replace(/\d+/g, "#");
      if (gateSwitchedOff(ctx)) return planTrace(ctx, "switched-off");
      const unchanged = key === lastIdlePlanCheck;
      if (pendingSizingNoticeIds.length === 0 && unchanged && now - lastIdlePlanCheckAt < PLAN_REDELIVERY_MS)
        return planTrace(ctx, "same-problems-recently-sent");
      // A heartbeat re-delivers an unchanged list, so it needs an identity the notice digest has not seen.
      const heartbeat = unchanged && now - lastIdlePlanCheckAt >= PLAN_REDELIVERY_MS;
      if (heartbeat) planHeartbeatSeq += 1;
      if (!unchanged || heartbeat) lastIdlePlanCheckAt = now;
      lastIdlePlanCheck = key;
      // Digest the stable key, not the rendered text: only a changed problem list or an escalation
      // (the stuck-worker and receding-finish wording changes at 30/60/20 min) delivers again.
      sendHarnessNotice("todo-plan-check", key, check, undefined, heartbeat ? `${key}|heartbeat-${planHeartbeatSeq}` : key, { interruptWait: activeRecoveries(ctx).length > 0 });
      markSizingNotices();
      planTrace(ctx, "sent", { problems: check.slice(0, 160) });
    } catch (error) {
      planTrace(ctx, "tick-threw", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  // The interval can vanish without an error (clearManagedTimers on a session change, a throwing
  // tick before this guard): any later session, turn or tool event re-arms it when no tick ran for 3 min.
  healPlanTicker = (ctx: ExtensionContext) => {
    if (singleWriterLane || !ctx.setInterval) return;
    if (lastPlanTickAt === 0 || Date.now() - lastPlanTickAt <= PLAN_HEAL_AFTER_MS) return;
    planTrace(ctx, "ticker-rearmed", { sinceLastTickMs: Date.now() - lastPlanTickAt });
    armPlanTicker(ctx);
  };
  armPlanTicker = (ctx: ExtensionContext) => {
    stopPlanTicker();
    if (singleWriterLane || !ctx.setInterval) return;
    tickerContext = ctx;
    lastPlanTickAt = Date.now();
    planTicker = ctx.setInterval(() => planTick(ctx), PLAN_TICK_MS);
  };
  disarmPlanTicker = stopPlanTicker;
  // `todo schedule` hands the lead the finished-run history of the owners it just set, so the next
  // estimate starts from what that role/model actually took. Generic text; the journal is the router's.
  const scheduleCalibrationHints = (event: { input?: unknown }, ctx: ExtensionContext, pending: unknown[]): string[] => {
    const input = event.input as { op?: unknown; updates?: unknown } | undefined;
    if (input?.op !== "schedule" || !Array.isArray(input.updates)) return [];
    try {
      const phases = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx, pending) as never);
      const ownerOf = (task: string) => phases.flatMap((phase) => phase.tasks).find((row) => row.content === task)?.schedule?.owner;
      const targets = input.updates.flatMap((update: { task?: unknown; owner?: unknown }) => {
        if (typeof update?.task !== "string") return [];
        const owner = (typeof update.owner === "string" ? update.owner : ownerOf(update.task))?.trim();
        return owner && !/^(?:unit|job):/.test(owner) ? [{ task: update.task, owner }] : [];
      });
      return calibrationHints(targets, readDurationHistory());
    } catch {
      return [];
    }
  };
  pi.on("tool_result", async (event, ctx) => {
    healPlanTicker(ctx);
    await refreshLiveWorkerModels(ctx);
    if (singleWriterLane) return;
    if (!event.isError && isMain(ctx)) {
      const cancelled = (event.details as { proc?: { op?: string; cancelled?: Array<{ id: string; status: string }> } } | undefined)?.proc;
      if (cancelled?.op === "cancel" && cancelled.cancelled?.some(item => item.status === "cancelled")) {
        sprintState = { ...sprintState, recoveryWaits: (sprintState.recoveryWaits ?? []).map(item =>
          cancelled.cancelled!.some(outcome => outcome.id === item.owner && outcome.status === "cancelled") ? { ...item, killed: true } : item) };
        persistSprintState();
      }
    }
    if (event.content?.some((part) => part.type === "text" && part.text.startsWith("Blocked:"))) {
      setRetroDue("gate rejection");
      persistSprintState();
    } else if (event.toolName === "todo" && event.isError) {
      setRetroDue("failed todo update");
      persistSprintState();
    }
    if (event.toolName === "todo") {
      // Only a successful tool result proves init passed validation and began a new objective.
      if (!event.isError && isMain(ctx) && (event.details as { op?: unknown } | undefined)?.op === "init")
        resetFinishHistory(ctx);
      if (event.isError || !isMain(ctx) || !pi.getActiveTools().includes("task")) return;
      // The hook runs before this result joins the branch: check the plan the call just produced
      // (live 21:32: an owner written by this very call was reported as missing).
      const details = (event as { details?: unknown }).details;
      const pendingTodo = details ? [{ type: "message", message: { role: "toolResult", toolName: "todo", details } }] : [];
      const updates = todoScheduleUpdates(event.input);
      for (const update of updates) {
        if (typeof update.owner !== "string" || typeof update.task !== "string") continue;
        sendHarnessNotice("todo-gate-steering", `${update.task}:${update.owner}`, prompt.render(gateNoticeInstructions, { steering: true, row: JSON.stringify(update.task), owner: update.owner }).trim());
      }
      const hints = scheduleCalibrationHints(event, ctx, pendingTodo);
      const hintPart = hints.length ? [{ type: "text" as const, text: hints.join("\n") }] : [];
      const check = await planCheck(ctx, pendingTodo);
      if (!check) return hintPart.length ? { content: [...event.content, ...hintPart] } : undefined;
      markSizingNotices();
      return { content: [...event.content, ...hintPart, { type: "text" as const, text: check }] };
    }
    if (event.toolName !== "task") return;
    lastTaskDispatchRefused = Boolean(event.isError);
    if (!event.isError && isRetroFacilitatorTaskResult(event)) {
      dispatchedAgents.delete(event.toolCallId);
      let covered: string[] = [];
      try {
        covered = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never).flatMap((phase) => phase.tasks).flatMap(rowAttemptKeys);
      } catch {
        covered = [];
      }
      finishRetro(retroFacilitatorResultId(event), true, covered);
    } else if (!event.isError) {
      const details = event.details as { results?: unknown } | undefined;
      if (Array.isArray(details?.results)) {
        const recent = ctx.getAsyncJobSnapshot()?.recent ?? [];
        const settled = details.results.flatMap((value) => {
          if (typeof value !== "object" || value === null || typeof value.id !== "string") return [];
          const snapshot = recent.find((job) => job.id === value.id);
          const status = value.status ?? (value.aborted ? "cancelled" : typeof value.exitCode === "number" ? (value.exitCode === 0 ? "completed" : "failed") : undefined);
          if (!["completed", "failed"].includes(status)) return [];
          return [{ ...snapshot, ...value, id: value.id, type: "task", status,
            agentId: value.agentId ?? snapshot?.agentId ?? value.id,
            label: value.label ?? snapshot?.label ?? value.description ?? value.id,
          }];
        });
        const { updaterRejected } = settleSprintJobs(settled, Date.now());
        if (updaterRejected) setRetroDue("updater rejection");
        if (settled.length > 0) persistSprintState();
      }
      reportWorkerResultIncident(event);
    }
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
  pi.on("context", async (event, ctx) => {
    const deduped = dedupeLatestWinsCompactionMessages(event.messages);
    const passThrough = deduped !== event.messages ? { messages: deduped } : undefined;
    await refreshLiveWorkerModels(ctx);
    announceGates(ctx);
    if (singleWriterLane) return passThrough;
    const now = Date.now();
    if (isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)), now / 1_000)) return passThrough;
    const decision = currentDecision(ctx, now);
    const chief = isMain(ctx) && pi.getActiveTools().includes("task");
    if (!decision.prompt && !chief) return passThrough;
    const attemptedIdleOwners = decision.readyCandidates
      .filter((row) => row.ownership === "idle-live-owner" && row.owner && idleResumeAttempts.has(row.owner))
      .map((row) => row.owner!);
    const phases = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never);
    const retroDue = sprintState.retroDueReason && !retroRowStaffed(phases) ? buildRetroLine(now, decision.deadline?.timezone) : "";
    if (retroDue) {
      sprintState = { ...sprintState, retroDueNotifiedKey: retroNotifyKey() };
      persistSprintState();
    }
    const facts = chief ? await integrationFacts(ctx, now) : "";
    const notice = isMain(ctx) ? returnNotice : null;
    if (notice) notice.shown = true;
    const content = [
      ...(notice ? [notice.text] : []),
      ...(chief ? [CHIEF_OF_STAFF] : []),
      ...(facts ? [facts] : []),
      ...(chief && lastTaskDispatchRefused ? ["The last task dispatch was refused; bounded work is open to you until the ready row can be dispatched."] : []),
      ...(chief && activeDemand ? [`NEXT STEP (advice; no call is skipped or refused for it): ${activeDemand}`] : []),
      ...(retroDue ? [retroDue] : []),
      ...(decision.prompt
        ? [`${decision.prompt}${attemptedIdleOwners.length ? `\nFAIL CLOSED: exact idle worker resume already attempted once for ${attemptedIdleOwners.join(", ")}; inspect the exact session/result, do not retry or create a duplicate writer.` : ""}`]
        : []),
    ].join("\n");
    return { messages: [...deduped, { role: "developer", content, timestamp: now }] };
  });

  const armIdleCheck = (ctx: ExtensionContext, decision = currentDecision(ctx)) => {
    clearIdleTimer();
    if (
      singleWriterLane ||
      isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx))) ||
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
    idleTimer = ctx.setTimeout(async () => {
      idleTimer = null;
      timerContext = null;
      if (!pauseGate || pauseGate.paused || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      await refreshLiveWorkerModels(ctx);
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
      const awayWorkList = fresh.presence === "away" ? fresh.awayWorkList ?? [] : [];
      sendHarnessNotice(
        "agent-focus-gym-eval-sandbox-wake",
        fresh.rawWakeKey,
        awayWorkList.length
          ? `The user is away. Continue this work list: ${awayWorkList.join("\n")} ${ORDER}`
          : `Overdue TODO follow-through: the plan is past its time and the session went idle. ${ORDER}`,
        { planRevision: fresh.key, alarms: fresh.alarms },
        undefined,
        { triggerTurn: true, interruptWait: true },
      );
    }, delay);
  };
  pi.on("agent_end", async (_event, ctx) => {
    if (singleWriterLane) return;
    persistRoster(ctx);
    await refreshLiveWorkerModels(ctx);
    const decision = currentDecision(ctx);
    if (returnNotice?.shown) returnNotice = null;
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
    dispatchedAgents.clear();
    armIdleCheck(ctx, decision);
  });
}
