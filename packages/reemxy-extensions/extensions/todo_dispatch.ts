// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { gateSwitchedOff } from "./dispatch-off-switch";
import { auditLineage, checkableAuditFinding, reconcileSupersededAudit, withoutSupersededAudits } from "./audit-supersession";
import type { TodoAuditOrigin } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import dispatchIgnoredInstructions from "./dispatch-ignored.md" with { type: "text" };
import { JournalCursor } from "@oh-my-pi/pi-coding-agent/session/journal-cursor";
import planCritic from "./plan_critic";
import { isLegacyFixNow, withChiefFixNow } from "./fix_now";
import { prepareAttemptBrief } from "./attempt_receipt";
import { prepareRequirementBrief, installRequirementResolution } from "./requirement_quotes";
import { installWorkerAskInterrupt, pendingWorkerQuestions } from "./worker_asks";
import { resetDeliveryCriticTimers, queueDeliveryCritic, type DeliveryRow, type DeliveryVerdict } from "./delivery_critic";
import { openReviewPages, probeReviewPage, ReviewAnswerPoller } from "./todo_review_opener";
import { PREVIEW_ENTRY_TYPE, refreshPreviewVisibility, overduePreviewRows, previewScheduleRefusal, previewDispatchRefusal, previewPlanProblem, previewReason, type PreviewRecord } from "./todo_preview";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { isHarnessNotice } from "@oh-my-pi/pi-coding-agent/session/harness-notices";
import { selectBranchEntries, selectBranchNewestFirst, selectLatestBranchEntry, type BranchSource } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { prompt } from "@oh-my-pi/pi-utils";
import { truncateMiddleToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { findTodoExecutorTarget, taskPacketRow, todoMatchesObservedWorker } from "@oh-my-pi/pi-coding-agent/tools/todo-executor";
import { getLatestTodoPhasesFromEntries, readTodoArchiveState, getLiveTodoBranchEntries, getTodoActionRows, withTodoArchive } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { getTodoPlanCalibrationStore } from "@oh-my-pi/pi-coding-agent/tools/todo-plan-calibration";
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
import { readTodoDisplayLedger } from "@oh-my-pi/pi-coding-agent/tools/todo-plan-display";
import { refuseProofReview, renderLeadRowBlocks } from "./lead-row-instructions";
import { checkRowAudits } from "./row_audit";
import { todoNeedsOwnerDecision, classifyTodoDisplayRow, todoRowAfterWorker, todoRowHasDeliverable, isTodoAwaitingReview, getTodoPlanningIssues, parseUserWait, type TodoPlanPrediction, type TodoPlanForecast, type TodoPlanningIssue, type TodoScheduleInput, type TodoTaskForecast, type RowRiskOptions } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { formatLocalClock, formatLocalTimestamp, isUserDeadlineMissed, latestDeadlineUserMessage, lifecycleGoal, readGoalDeadline, rehydrateDeadlineState, resolveTimeZone, STATE_ENTRY as GOAL_DEADLINE_STATE_ENTRY, type DeadlineState } from "./deadlines";
import unansweredUserInstructions from "./unanswered-user-reply.md" with { type: "text" };
import unpushedInstructions from "./unpushed-work.md" with { type: "text" };
import { zeroActiveGate } from "./zero-active";
import zeroActiveInstructions from "./zero-active.md" with { type: "text" };
import planCheckInstructions from "./plan-check.md" with { type: "text" };
import staffingAdvice from "./staffing-advice.md" with { type: "text" };
import gateNoticeInstructions from "./gate-notices.md" with { type: "text" };
import chatChoiceInstructions from "./chat-choice-gate.md" with { type: "text" };
import riskReplanInstructions from "./risk-replan.md" with { type: "text" };
import deadlineMissInstructions from "./deadline-miss.md" with { type: "text" };
import idleRedRowsInstructions from "./idle-red-rows.md" with { type: "text" };
import { assignedResourceRefusals, countLiveWorkerModels } from "./agent_router";
import { currentRowOwner } from "./dispatch_preflight";
import { checkoutKeyFromResources, displayCheckoutKey, normalizeCheckoutKey, readOnlyClaim } from "./checkout_scope";
import { derivePresence, latestPresenceEntries, latestGoalLifecycleEntries, latestDeadlineStateEntries, type Presence } from "./goal_deadlines";
import { planChurnRows, unfinishedDependencyChains, appendTimedNote, timedNoteDue, noteContextBoundary, deliveredNoteWindow, projectRowBlocks, type RowBlock, renderPlanFactNote, renderCurrentSetForecast, waitChainDemands, waitChainAction, waitChainRejection, type WaitChainDemand } from "./lead_time_notes";
import leadTimeSummary from "./lead-time-summary.md" with { type: "text" };
import oneShotInstructions from "./one-shot.md" with { type: "text" };
import { calibrationHints, readDurationHistory } from "./todo_calibration";
import { getUserWaitPlanningIssues, parkUserWaits, USER_WAIT_SELF_FILL } from "./todo-schedule-away";

import dependencyWaitInstructions from "./dispatch-dependency-wait.md" with { type: "text" };
import waitingWorkInstructions from "./dispatch-waiting-work.md" with { type: "text" };
import { wakeDemand as stalledWakeDemand, wakeRetryMs, wakeRetryRemaining, countsAsWakeAction, type WakeReceipt, recoveryDemand, recoveryActionObserved, measuredRecoveryForecast, type RecoveryState } from "./dispatch_wake";
import dispatchWakeInstructions from "./dispatch-wake.md" with { type: "text" };
import dispatchToolRecoveryInstructions from "./dispatch-tool-recovery.md" with { type: "text" };
import concurrentRecoveryInstructions from "./dispatch-concurrent-recovery.md" with { type: "text" };


export function dispatchTodoArchive(ctx: ExtensionContext): TodoScheduleInput {
  return readTodoArchiveState(ctx.sessionManager).phases;
}

// Only these synthetic arrays carry a native immutable owner snapshot. Durable
// entries and mutable legacy getter results must still go through host replay.
const liveTodoEntrySnapshots = new WeakMap<object, readonly TodoPhase[]>();

export function readDispatchTodoPhases(entries: object, replay: (entries: never) => TodoPhase[]): TodoPhase[] {
  const snapshot = liveTodoEntrySnapshots.get(entries);
  return deliveredRowsClosed(snapshot ?? replay(entries as never));
}

export function todoStateEntries(ctx: ExtensionContext, pending: unknown[] = []) {
  const snapshot = ctx.getTodoSnapshot?.();
  const phases = snapshot ?? ctx.getTodoPhases?.();
  if (phases !== undefined) {
    const entries = [{ type: "custom", customType: "user_todo_edit", data: { phases } }, ...pending];
    if (snapshot !== undefined && pending.length === 0) liveTodoEntrySnapshots.set(entries, snapshot);
    return entries;
  }
  const branch = getLiveTodoBranchEntries(ctx.sessionManager);
  return pending.length ? [...branch, ...pending] : branch;
}

export function dispatchStateEntries(ctx: ExtensionContext, pending: unknown[] = []) {
  const snapshot = ctx.getTodoSnapshot?.();
  const phases = snapshot ?? ctx.getTodoPhases?.();
  // Each consumer needs current state, not all historical snapshots.
  const branch = [...latestDeadlineStateEntries(ctx), ...latestGoalLifecycleEntries(ctx), ...latestPresenceEntries(ctx)];
  if (phases !== undefined) {
    const entries = [...branch, { type: "custom", customType: "user_todo_edit", data: { phases } }, ...pending];
    if (snapshot !== undefined && pending.length === 0) liveTodoEntrySnapshots.set(entries, snapshot);
    return entries;
  }
  return [...branch, ...getLiveTodoBranchEntries(ctx.sessionManager), ...pending];
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

// A registry-backed running/restoring child may have no task job (IRC revival/startup).
// Use the same current-process identities for dispatch pressure and duplicate-spawn admission.
type LiveTaskWorker = { id: string; jobId: string; agent?: string; startedAt?: number };
function liveTaskWorkers(jobs: Jobs | null): LiveTaskWorker[] {
  const workers: LiveTaskWorker[] = (jobs?.running ?? []).filter(job => job.type === "task" && job.status === "running")
    .map(job => ({ id: job.agentId ?? job.id, jobId: job.id, agent: job.agent, startedAt: job.startTime }));
  for (const worker of jobs?.nonJobAgents ?? [])
    if (worker.live && !workers.some(candidate => candidate.id === worker.id || candidate.jobId === worker.id))
      workers.push({ id: worker.id, jobId: worker.id, agent: undefined, startedAt: undefined });
  return workers;
}
function liveTaskWorker(task: TaskRow | undefined, workers: LiveTaskWorker[]): LiveTaskWorker | undefined {
  const executor = task?.schedule?.executor;
  // A settled executor belongs to a previous attempt. Its agent may now be
  // running unrelated work; only the current assignment can establish ownership.
  const executorId = executor?.finishedAt === undefined && !executor?.outcome ? executor?.workerId : undefined;
  for (const identity of [executorId, task?.schedule?.owner]) {
    if (typeof identity !== "string") continue;
    // Agent IDs and job IDs have separate namespaces. Prefer the named agent
    // before a colliding job ID or a legacy numbered-job alias.
    const worker = workers.find(candidate => candidate.id === identity)
      ?? workers.find(candidate => candidate.jobId === identity)
      ?? workers.find(candidate => candidate.jobId.replace(/-\d+$/, "") === identity);
    if (worker) return worker;
  }
  return undefined;
}

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
  idleContinuationDemands: number;
  idleContinuationKey?: string;
  recoveryWaits?: RecoveryWait[];
  deliveryCheckpointHead?: string;
  deliveryCheckpointAt?: number;
  deliveryCheckpointPublished?: boolean;
  deliveryCheckpointActive?: boolean;
  receiptReadKeys?: string[];
  receiptReconciledKeys?: string[];
};
type TaskRow = TodoScheduleInput[number]["tasks"][number];
type SnapshotRow = { number: number; phase: string; task: TaskRow };
type AgentMessageDelivery = { delivered: boolean; text: string };
type WorkerCompactionCursor = { cursor: JournalCursor; at?: number };
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
// A plan longer than a worker's p90 (14-27 min in the router journal) is long enough to need a deadline.
const AUTO_GOAL_MIN_LEAD_MS = 15 * 60_000;
const ROSTER_ENTRY_TYPE = "todo-dispatch-roster";
export const SPRINT_STATE_ENTRY_TYPE = "todo-dispatch-sprint-state";
const CHIEF_RULES_ENTRY_TYPE = "chief-rules-after-compaction";
const WORKER_BRIEF_ENTRY_TYPE = "worker-brief-after-compaction";
const TODO_ERROR_ENTRY_TYPE = "todo-error-reminder";

export function autoGoalDeadlineState(input: {
  current: DeadlineState | null;
  planKey: string;
  goalId?: string;
  membershipFingerprint?: string;
  predictionVersion?: string;
  forecastFinish: number | undefined;
  openRows?: string[];
  now: number;
  hasRealGoal: boolean;
  hasRealDeadline: boolean;
}): DeadlineState | undefined {
  const { current, planKey, forecastFinish, now, hasRealGoal, hasRealDeadline } = input;
  if (hasRealGoal || (hasRealDeadline && current?.auto !== true)) return undefined;
  let anchorRows = current?.autoAnchorRows;
  if (!anchorRows && current?.autoPlanKey) {
    try {
      const saved = JSON.parse(current.autoPlanKey);
      if (Array.isArray(saved)) anchorRows = saved.flatMap(phase => Array.isArray(phase?.[1]) ? phase[1].flatMap(row => typeof row === "string" ? [row] : Array.isArray(row) && typeof row[0] === "string" ? [row[0]] : []) : []);
    } catch { /* Opaque legacy keys retain the active-anchor guard. */ }
  }
  // Row membership and estimate edits cannot establish a new goal or accepted completion.
  const sameGoal = input.goalId === undefined || input.goalId === current?.goalId;
  if (current?.auto === true && sameGoal && current.baselineDeadlineAt !== undefined) {
    const added = input.openRows?.filter(row => !anchorRows?.includes(row) && !current.autoScopeGrowthRows?.includes(row)) ?? [];
    const scopeGrowthRows = [...new Set([...(current.autoScopeGrowthRows ?? []), ...added])];
    if (added.length || !current.active || (input.openRows && !current.autoAnchorRows && anchorRows)) return {
      ...current, active: true, autoAnchorRows: anchorRows, autoScopeGrowthRows: scopeGrowthRows,
      autoEvents: [...(current.autoEvents ?? []), ...(added.length ? [{
        id: `${current.autoAnchorId ?? current.goalId}:scope:${now}:${Bun.hash(JSON.stringify(added))}`,
        at: Math.floor(now / 1_000), kind: "scope-observed" as const, actor: "todo-dispatch",
        reason: "Observed labels outside original membership; addition or split lineage unknown", rows: added,
      }] : [])],
    };
    return undefined;
  }
  if (forecastFinish === undefined || !Number.isFinite(forecastFinish) || forecastFinish <= now + AUTO_GOAL_MIN_LEAD_MS) return undefined;

  const deadlineAt = Math.ceil(forecastFinish / 1_000);
  return {
    version: 1,
    goalId: input.goalId ?? "auto-todo-plan",
    autoAnchorId: `${input.goalId ?? "auto-todo-plan"}:${now}`,
    autoInitialForecastFinish: forecastFinish,
    autoMembershipFingerprint: input.membershipFingerprint,
    autoPredictionVersion: input.predictionVersion,
    autoEvents: [...(current?.autoEvents ?? []), {
      id: `${input.goalId ?? "auto-todo-plan"}:${now}:initial`,
      at: Math.floor(now / 1_000), kind: current ? "new-goal" : "initial-forecast",
      actor: "todo-dispatch", reason: current ? "Explicit new goal identity" : "Initial forecast; not a user commitment",
      oldDeadlineAt: current?.baselineDeadlineAt, newDeadlineAt: deadlineAt, rows: input.openRows,
    }],
    goalStartedAt: Math.floor(now / 1_000),
    timezone: resolveTimeZone(),
    active: true,
    auto: true,
    autoPlanKey: planKey,
    autoAnchorRows: input.openRows,
    autoScopeGrowthRows: [],
    stages: [
      {
        id: "auto-plan-forecast",
        label: "Initial forecast for the TODO plan",
        expectedResult: "Complete the current TODO plan",
        deadlineAt,
      },
    ],
    baselineDeadlineAt: deadlineAt,
  };
}
function dispatchModelContext(ctx: ExtensionContext) {
  const options = { maxFrameDataBytes: 0 };
  return ctx.sessionManager.buildSessionContext?.(options) ?? buildSessionContext(ctx.sessionManager.getBranch(), undefined, undefined, options);
}
// Canonical surviving model context for the compact guard: use the shared
// SessionManager.buildSessionContext producer and check whether that customType still reaches the model.
// Never re-derive retained ranges or compaction boundaries here. Canonical builder errors must surface.
function survivingCompactionCustomType(ctx: ExtensionContext, customType: string): boolean {
  const context = dispatchModelContext(ctx);
  return context.messages.some((message) => message.role === "custom" && message.customType === customType);
}
function deliveredDispatchAction(ctx: ExtensionContext, content: string): boolean {
  const context = dispatchModelContext(ctx);
  const previous = context.messages.findLast(message => message.role === "custom" && message.customType === "todo-dispatch-action-required");
  const prefix = /^(?:REQUIRED|ESCALATED) DISPATCH ACTION \(\d+ ignored turns\): /;
  return typeof previous?.content === "string" && previous.content.replace(prefix, "") === content.replace(prefix, "");
}
// A merge whose conflicts are all resolved is one `git commit` away. Seen live: a planner kept a
// resolved merge open for hours behind feature rows and gates while main moved on, and spawned a
// fresh round of merge workers for every move. Past these ages the gate demands commit, then push.
export const STALE_MERGE_MS = 30 * 60_000;
// Publication alarm; projects may lower it with omp.unpushedThresholdMinutes.
export const STALE_PUSH_MS = 60 * 60_000;
export const PUSH_POLL_MS = 3 * 60_000;
/** Hard artifact cadence. Unlike Todo estimates, this clock cannot be revised by the model. */
export const DELIVERY_CHECKPOINT_MS = 15 * 60_000;
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
  pushBranch?: string;
  pushRemote?: string;
  pushTargetMissing?: boolean;
  targetMerged?: boolean;
  pushThresholdMs?: number;
}
export function pushRowTitle(state: GitIntegrationState): string {
  return `Push: run project gates and push ${state.pushRemote}/${state.pushBranch}`;
}
export function reconcilePushRow(phases: TodoPhase[], state: GitIntegrationState, cwd: string, now: number): TodoPhase[] {
  if (state.unpushed === undefined || !state.pushBranch) return phases;
  const title = pushRowTitle(state);
  const row = phases.flatMap(phase => phase.tasks).find(task => task.content === title);
  if (state.unpushed === 0) {
    if (!row || row.status === "completed") return phases;
    return phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => task === row
      ? { ...task, status: "completed", schedule: { ...task.schedule, finishedAt: now } } : task) }));
  }
  if ((state.oldestUnpushedAgeMs ?? 0) < (state.pushThresholdMs ?? STALE_PUSH_MS)) return phases;
  if (row && ["pending", "in_progress"].includes(row.status)) return phases;
  const pending = { content: title, status: "pending", schedule: {
    agentProfile: "git-pr-owner", dependencies: [], resources: [`checkout:${cwd}`],
    estimate: { optimisticSeconds: 60, likelySeconds: 300, pessimisticSeconds: 900,
      confidence: "low", basis: "Run required project gates; only if authorized and ready, push and read back the target ref", updatedAt: now },
  } };
  // First phase / first row makes publication visible ahead of ordinary feature work.
  const rest = phases.map(phase => ({ ...phase, tasks: phase.tasks.filter(task => task !== row) }));
  return [{ name: "Push overdue work", tasks: [pending] }, ...rest.filter(phase => phase.tasks.length)];
}
export async function readGitIntegrationState(cwd: string, now: number, env: NodeJS.ProcessEnv = process.env, probePush = true, target?: TodoAuditOrigin): Promise<GitIntegrationState | null> {
  const gitInput = async (args: string[], input?: string): Promise<string | null> => {
    const result = Promise.withResolvers<string | null>();
    const child = execFile("git", args, { cwd, encoding: "utf8", timeout: 5_000,
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => result.resolve(error ? null : stdout.trim()));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    return result.promise;
  };
  const git = (...args: string[]) => gitInput(args);
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
  if (!probePush) return state;
  const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
  state.pushBranch = await git("config", "--get", "omp.pushBranch") || branch || undefined;
  state.pushRemote = (branch && await git("config", "--get", `branch.${branch}.pushRemote`))
    || await git("config", "--get", "remote.pushDefault")
    || (branch && await git("config", "--get", `branch.${branch}.remote`)) || "origin";
  state.pushBranch = target?.branch ?? state.pushBranch;
  state.pushRemote = target?.remote ?? state.pushRemote;
  if (target?.commit && state.pushRemote) {
    const advertised = await git("ls-remote", "--symref", state.pushRemote, "HEAD");
    const tip = advertised?.split("\n").find(line => /^[0-9a-f]{40,64}\s+HEAD$/.test(line))?.split(/\s+/)[0];
    if (tip && await git("merge-base", "--is-ancestor", target.commit, tip) !== null) state.targetMerged = true;
  }
  const configured = Number(await git("config", "--get", "omp.unpushedThresholdMinutes"));
  state.pushThresholdMs = configured > 0 && Number.isFinite(configured) ? configured * 60_000 : STALE_PUSH_MS;
  if (!state.pushBranch || !state.pushRemote) return state;
  const heads = await git("ls-remote", "--heads", state.pushRemote, `refs/heads/${state.pushBranch}`);
  // Unknown is not published. Preserve the row on network/authentication failures.
  if (heads === null) return state;
  // An absent target has no comparison base. Counting HEAD against an empty
  // set counts the entire repository history, including already merged work.
  if (!heads) { state.pushTargetMissing = true; return state; }
  const advertised = new Set<string>();
  for (const line of heads.split("\n")) {
    const sha = line.split(/\s+/)[0];
    if (sha && /^[0-9a-f]{40,64}$/.test(sha)) advertised.add(sha);
  }
  const checked = advertised.size ? await gitInput(["cat-file", "--batch-check=%(objectname) %(objecttype)"], [...advertised].join("\n") + "\n") : "";
  if (checked === null) return state;
  const live = checked.split("\n").flatMap(line => line.endsWith(" commit") ? [line.split(" ")[0]] : []);
  // An advertised tip missing locally has unknown ancestry, not an empty remote history.
  if (live.length !== advertised.size) return state;
  // Only the selected live ref proves delivery; another remote branch does not.
  const unpushed = await git("log", "--format=%ct", head, "--not", ...live);
  if (unpushed !== null) {
    const times = unpushed.split("\n").filter(Boolean).map(Number);
    state.unpushed = times.length;
    if (times.length) state.oldestUnpushedAgeMs = Math.max(0, now - Math.min(...times) * 1000);
  }
  return await git("rev-parse", "HEAD") === head ? state : null;
}

/** A model-supplied reason is not proof that the audited target disappeared. */
export async function supersededAuditDropRefusal(input: { op?: string; reason?: string; task?: string; phase?: string; items?: string[] }, phases: readonly TodoPhase[], cwd: string, archive: readonly TodoPhase[] = []): Promise<string | undefined> {
  if (input?.op !== "drop" || !String(input.reason ?? "").startsWith("superseded:")) return;
  const rows = [...phases, ...archive].flatMap(phase => phase.tasks);
  const targets = [...phases, ...archive].flatMap(phase => phase.tasks.filter(row =>
    input.task ? row.content === input.task : input.phase ? phase.name === input.phase : (input.items ?? []).includes(row.content)));
  for (const row of targets) {
    const origin = auditLineage(row, rows);
    const state = origin && await readGitIntegrationState(origin.repoPath ?? cwd, Date.now(), process.env, true, origin);
    if (!origin || !state || (!(origin.branch && state.pushTargetMissing) && !state.targetMerged))
      return `Cannot drop ${JSON.stringify(row.content)} as superseded: its target is unmerged or git evidence is unavailable.`;
  }
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
    idleContinuationDemands: 0,
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

type SpawnOutcome = { kind?: unknown; agent?: unknown; status?: unknown; durationMs?: unknown; jobId?: unknown; spawnKey?: unknown };
type DurationFloors = { profiles: Map<string, number[]>; all: number[] };
let durationFloorsCache: { readAt: number; floors: DurationFloors } | undefined;
const ROUTER_SPAWNS_PATH = join(homedir(), ".local", "state", "omp-agent-router", "spawns.jsonl");
const TODO_DISPATCH_STATE_DIR = process.env.OMP_TODO_DISPATCH_STATE_DIR ?? join(homedir(), ".local", "state", "omp-todo-dispatch");

export function successfulDurationFloors(lines: readonly string[]): DurationFloors {
  const profiles = new Map<string, number[]>();
  const all: number[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as SpawnOutcome;
      if (event.kind !== "outcome" || event.status !== "completed" || typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs) || event.durationMs <= 0) continue;
      const profile = typeof event.agent === "string" ? event.agent : "";
      if (profile) profiles.set(profile, [...(profiles.get(profile) ?? []), event.durationMs]);
      all.push(event.durationMs);
    } catch {}
  }
  return { profiles, all };
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

function durationFloors(now: number): DurationFloors {
  if (durationFloorsCache && now - durationFloorsCache.readAt < 60_000) return durationFloorsCache.floors;
  const floors: DurationFloors = { profiles: new Map(), all: [] };
  try {
    const history = readDurationHistory(ROUTER_SPAWNS_PATH);
    for (const sample of history.samples) {
      const durationMs = sample.seconds * 1000;
      const samples = floors.profiles.get(sample.role) ?? [];
      samples.push(durationMs);
      floors.profiles.set(sample.role, samples);
      floors.all.push(durationMs);
    }
  } catch {}
  durationFloorsCache = { readAt: now, floors };
  return floors;
}

export function estimateFloorRefusal(updates: readonly Record<string, unknown>[], rows: readonly TodoTaskForecast[], floors: DurationFloors, now: number): string | undefined {
  for (const update of updates) {
    if (typeof update.status === "string" && !isNonClosedRowStatus(update.status)) continue;
    const content = typeof update.task === "string" ? update.task : undefined;
    const row = content ? rows.find((candidate) => candidate.content === content) : undefined;
    const estimate = update.estimate as { likelySeconds?: unknown; basis?: unknown } | undefined;
    if (!row || !estimate || typeof estimate.likelySeconds !== "number") continue;
    const profile = row.schedule?.executor?.agentProfile;
    const profileSamples = typeof profile === "string" ? floors.profiles.get(profile) : undefined;
    const samples = profileSamples?.length ? profileSamples : floors.all;
    const sampleMedian = median(samples);
    const priorLikely = row.estimateRangeSeconds?.likely ?? 0;
    const previousAttempt = row.schedule?.attemptHistory?.at(-1);
    const attemptFloor = typeof previousAttempt?.durationMs === "number" && Number.isFinite(previousAttempt.durationMs) && previousAttempt.durationMs > 0
      ? previousAttempt.durationMs : 0;
    // Profile and previous-attempt durations measure whole attempts. An
    // evidenced re-estimate for work already underway measures what remains;
    // applying the whole-attempt floor again would double-count elapsed work.
    const elapsedMs = typeof row.startedAt === "number" ? Math.max(0, now - row.startedAt) : 0;
    // A finished executor can leave a smaller verification or integration remainder.
    // Starting its successor does not make the completed work part of the estimate again.
    // Fresh unstarted rows still use the floor; changed remaining scope requires evidence.
    const startedWork = elapsedMs > 0;
    const progressUpdate = startedWork && typeof update.evidence === "string" && update.evidence.trim().length > 0;
    if (progressUpdate) continue;
    const fullAttemptFloor = Math.max(sampleMedian ?? 0, attemptFloor);
    const floorMs = fullAttemptFloor;
    const floorSource = sampleMedian === undefined
      ? `all profiles (successful outcomes, n=${samples.length})`
      : profileSamples?.length
        ? `${profile} profile p50 (successful outcomes, n=${profileSamples.length})`
        : `all profiles p50 fallback (successful outcomes, n=${samples.length})`;
    const floorReasons = [
      sampleMedian === undefined ? undefined : `p50 ${Math.ceil(sampleMedian / 60_000)}m from ${floorSource}`,
      attemptFloor > 0 ? `previous attempt took ${Math.ceil(attemptFloor / 60_000)}m` : undefined,
    ].filter((reason): reason is string => reason !== undefined);
    const ratifiesOverrun = row.status === "in_progress" && row.overdue && elapsedMs > priorLikely * 1_000
      && estimate.likelySeconds * 1_000 >= elapsedMs * 0.9
      && estimate.likelySeconds * 1_000 <= elapsedMs * 1.1
      && !(typeof update.evidence === "string" && update.evidence.trim());
    if (estimate.likelySeconds * 1_000 >= floorMs && !ratifiesOverrun) continue;
    const detail = ratifiesOverrun
      ? `likely ${Math.round(estimate.likelySeconds / 60)}m only ratifies ${Math.floor(elapsedMs / 60_000)}m already elapsed without new evidence`
      : `likely ${Math.round(estimate.likelySeconds / 60)}m is below ${Math.ceil(floorMs / 60_000)}m`;
    const evidence = ratifiesOverrun ? `Measured overrun: ${Math.floor(elapsedMs / 60_000)}m elapsed; state the remaining work` : `Measured floor: ${floorReasons.join("; ") || "no successful outcomes available"}`;
    const lower = Math.max(1, Math.ceil(floorMs / 1_000));
    const exactCall = JSON.stringify({
      op: "schedule",
      updates: [{
        task: row.content,
        evidence,
        estimate: { optimisticSeconds: lower, likelySeconds: lower, pessimisticSeconds: lower * 2, confidence: "low", basis: evidence },
      }],
    });
    return `Refusing todo schedule for ${JSON.stringify(shorten(row.content, 34))}: ${detail}; floor ${Math.ceil(floorMs / 60_000)}m; floor source ${floorReasons.join("; ") || `${floorSource}, no successful samples`}; exactly: todo ${exactCall}.`;
  }
  return undefined;
}

export function firstDeliveryCutRequired(
  rows: readonly TodoTaskForecast[],
  _requestAt: number,
  userDeadlineAt: number | undefined,
  _now: number,
): string | undefined {
  // Each request has its own first delivery. A quick row from another request
  // must not hide a new requirement whose first usable slice is too far away.
  const requests = new Map<number, TodoTaskForecast[]>();
  for (const row of rows) {
    const at = row.schedule?.firstRequirementAt;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    requests.set(at, [...(requests.get(at) ?? []), row]);
  }
  for (const [requestAt, requestRows] of requests) {
    if (requestRows.some((row) => row.schedule?.firstDeliveredAt !== undefined)) continue;
    const earliest = requestRows
      .filter((row) => isNonClosedRowStatus(row.status))
      .map((row) => ({ row, finish: row.resourceFinish ?? row.fixedPathP95Finish }))
      .filter((item): item is { row: TodoTaskForecast; finish: number } => typeof item.finish === "number" && Number.isFinite(item.finish))
      .sort((left, right) => left.finish - right.finish)[0];
    if (!earliest) continue;
    const deadlineAt = Math.min(requestAt + 30 * 60_000, userDeadlineAt ?? Number.POSITIVE_INFINITY);
    if (earliest.finish > deadlineAt) return earliest.row.content;
  }
  return undefined;
}

export function missedEtaRowsText(rows: readonly TodoTaskForecast[], now: number): string {
  return rows.map((row) => `${JSON.stringify(row.content)} ${row.owner ?? "unassigned"} ${Math.floor(Math.max(0, now - (row.resourceFinish ?? row.startedAt ?? now)) / 60_000)}m over`).join("; ");
}

/** A forecast that expired before a worker started is a plan miss, not that worker's overrun. */
export function workerPastForecast(p95: number | undefined, startedAt: number | undefined, now: number): boolean {
  return typeof p95 === "number" && Number.isFinite(p95) && now >= p95
    && !(typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > p95);
}

function scheduleEstimateFloorRefusal(updates: readonly Record<string, unknown>[], rows: readonly TodoTaskForecast[], now: number): string | undefined {
  return estimateFloorRefusal(updates, rows, durationFloors(now), now);
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
    // Legacy snapshots may carry the previous owner's count. A fresh attempt
    // can always replan; the launch path resets its persisted counter.
    const freshOwner = startedAt !== undefined && args.now - startedAt < FRESH_OWNER_MS;
    if (freshOwner) continue;
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
    return `Split remainder of ${actionTarget(content)}.\nRefusing todo schedule: ${JSON.stringify(content)} ${why}. Exactly: use todo op:"append" for independently executable remainder with disjoint resources; preserve ${row.owner} and its current output. If unsplittable, wait for this worker to finish, then schedule a successor. A worker is stalled only with no progress past its budget; an estimate cap alone is not a stall.`;
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
// Plan repair and receipt reconciliation stay executable; only starting work is gated.
const PLAN_WORK_OPS: Record<string, true> = { init: true, start: true, append: true, unblock: true };
const ESCALATION_REMEDY = "Use todo schedule to record evidence and a remaining-work estimate, split the affected row with todo append, or drop it with todo drop.";
// Each escalated demand names its own fix; a generic "re-estimate the late row" sent the lead to
// replan when the demand was an unread worker result (live DC 2026-10-28).
const UNREAD_REMEDY = (owners: readonly string[]) =>
  `Read ${owners.length ? owners.slice(0, 4).map((owner) => `agent://${owner}`).join(", ") : "each finished worker's agent:// output"}. If truncated, write agent://<owner> to request a concise COMPLETE terminal receipt, not new implementation, then read its full root receipt. Use todo schedule on the named row with receipt findings/evidence before restaffing it.`;
export const GATE_IDS = ["planning-issues", "chief-no-bash", "idle-wait", "checkout", "escalation", "missed-eta", "receipt", "duplicate-worker"] as const;
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
  if (call.name === "todo" && [undefined, "view", "history"].includes(todoOpOf(call))) return { allowed: true, remedyGateIds: [] };
  if (READ_TIER.has(call.name)) return { allowed: true, remedyGateIds: [] };
  // A planning problem must not prevent the lead from delivering an owner question.
  if (call.name === "ask") return { allowed: true, remedyGateIds: [] };
  if (call.name === "context_notes") return { allowed: true, remedyGateIds: [] };
  // Device dispatch invokes the canonical tool after admitting its outer write.
  // Deadline authorization remains the deadline tool's own responsibility.
  if (call.name === "goal_deadline") return { allowed: true, remedyGateIds: [] };
  if (isKill(call)) return { allowed: true, remedyGateIds: [] };
  // Messaging owns target lookup and rejects unknown ids. Gates must not require a
  // running task: idle/parked workers and shell:/peer: routes are also valid replies.
  if (call.name === "write") {
    const path = (call.arguments as { path?: unknown } | undefined)?.path;
    if (typeof path === "string" && (path.startsWith("agent://") || path === "xd://goal_deadline")) return { allowed: true, remedyGateIds: [] };
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
      // Retire legacy automatic retro demands on reload. Explicit facilitator jobs and
      // their receipts remain valid; ordinary work never waits for an unsolicited retro.
      correctionPending: false,
      retroDueReason: null,
      ...(typeof data.handledDeadlineAt === "number" ? { handledDeadlineAt: data.handledDeadlineAt } : {}),
      ...(typeof data.handledDeliveryKey === "string" ? { handledDeliveryKey: data.handledDeliveryKey } : {}),
      lastNotices: typeof data.lastNotices === "object" && data.lastNotices !== null
        ? boundedNotices(Object.fromEntries(Object.entries(data.lastNotices).filter((entry): entry is [string, string] => typeof entry[1] === "string")))
        : {},
      ...(Array.isArray(data.recoveryWaits) ? { recoveryWaits: data.recoveryWaits.filter((item): item is RecoveryWait =>
        item !== null && typeof item === "object" && (item.kind === "cap" || item.kind === "stuck") &&
        typeof item.row === "string" && typeof item.owner === "string" && typeof item.at === "number") } : {}),
      ignoredDemands: typeof data.ignoredDemands === "object" && data.ignoredDemands !== null
        ? Object.fromEntries(Object.entries(data.ignoredDemands).filter((entry): entry is [string, number] => entry[0] !== "retro" && typeof entry[1] === "number").slice(-MAX_NOTICE_KEYS))
        : {},
      idleContinuationDemands: typeof (data as Partial<SprintState>).idleContinuationDemands === "number"
        ? Math.max(0, Math.min(3, Math.floor((data as Partial<SprintState>).idleContinuationDemands!)))
        : 0,
      ...(typeof data.idleContinuationKey === "string" ? { idleContinuationKey: data.idleContinuationKey } : {}),
      ...(typeof data.deliveryCheckpointHead === "string" ? { deliveryCheckpointHead: data.deliveryCheckpointHead } : {}),
      ...(typeof data.deliveryCheckpointAt === "number" ? { deliveryCheckpointAt: data.deliveryCheckpointAt } : {}),
      ...(typeof data.deliveryCheckpointPublished === "boolean" ? { deliveryCheckpointPublished: data.deliveryCheckpointPublished } : {}),
      ...(typeof data.deliveryCheckpointActive === "boolean" ? { deliveryCheckpointActive: data.deliveryCheckpointActive } : {}),
      ...(Array.isArray(data.receiptReadKeys) ? { receiptReadKeys: data.receiptReadKeys.filter((item): item is string => typeof item === "string") } : {}),
      ...(Array.isArray(data.receiptReconciledKeys) ? { receiptReconciledKeys: data.receiptReconciledKeys.filter((item): item is string => typeof item === "string") } : {}),
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
  risk?: RowRiskOptions;
  phases: TodoScheduleInput;
  archivedPhases?: TodoScheduleInput;
  history?: readonly TodoPlanPrediction[];
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
  dispatchableReady?: Array<DispatchDecision["readyCandidates"][number] & { previous?: string; reason?: string; findings?: string }>;
  /** Delivered rows whose verification the runtime owns (critic or batched audit). */
  verifyingRows?: string[];
  todoOwnerIds?: string[];
  ownerRunStates?: Array<{ content: string; owner: string | null; running: boolean; progressing?: boolean; outcome?: string }>;
  /** In-progress rows whose recorded owner matches no live task job, parked child or external wait. */
  lostOwners?: Array<{ content: string; owner: string }>;
  externallyStaffedCount?: number;
  deadline?: DispatchInput["deadline"];
  autoForecastDeadlineMissed?: boolean;
  autoForecastMissedByMinutes?: number;
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
  const registryKey = (jobs?.nonJobAgents ?? []).map(({ id, live }) => [id, live])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([tasks, jobKey, registryKey, restoredKey, persistedKey, deadline ?? null, capacity ?? null, startableCapacity ?? null, goalPaused]);
}

function safeTimestamp(value: unknown, timeZone?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return "unknown";
  return formatLocalTimestamp(value, timeZone);
}

export function formatMeasuredPlanForecast(forecast: NonNullable<RecoveryState["forecast"]>, timeZone?: string, deadlineAt?: number): string {
  const { at, from, completed, rowsPerHour, open, eta } = forecast;
  return [
    `At this pace: ${safeTimestamp(eta, timeZone)} (${((eta - at) / 3600_000).toFixed(1)} h remaining).`,
    `Completed TODO rows: ${completed} in ${((at - from) / 3600_000).toFixed(2)} h (${rowsPerHour.toFixed(2)} rows/h), from ${safeTimestamp(from, timeZone)} to ${safeTimestamp(at, timeZone)}.`,
    `Remaining TODO rows: ${open}.`,
    ...(deadlineAt === undefined ? [] : [`Deadline: ${safeTimestamp(deadlineAt, timeZone)} (${eta > deadlineAt ? "after deadline" : "within deadline"}).`]),
    "Throughput extrapolation; row sizes and added scope can change the finish.",
  ].join("\n");
}

function localizeTimestampText(value: string, timeZone?: string): string {
  return value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/g, (timestamp) =>
    formatLocalTimestamp(Date.parse(timestamp), timeZone),
  );
}

function safeText(value: unknown, max = MAX_LABEL): string {
  return typeof value === "string" ? shorten(value, max) : "unknown";
}
/** Shared delivery evidence for review closure and the idle decision gate. */
function isDeliveredReview(task: { status: string; schedule?: unknown }): boolean {
  return isTodoAwaitingReview(task);
}

/** A review row is closed only when an artifact was actually delivered. */
export function deliveredRowsClosed<P extends { tasks: Array<{ status: string; schedule?: unknown }> }>(phases: readonly P[]): P[] {
  return phases.map((phase) => phase.tasks.some((task) => isDeliveredReview(task) && !todoRowAfterWorker(task) && isNonClosedRowStatus(task.status))
    ? { ...phase, tasks: phase.tasks.map((task) => isDeliveredReview(task) && !todoRowAfterWorker(task) && isNonClosedRowStatus(task.status) ? { ...task, status: "completed" } : task) }
    : phase);
}

const USER_ACTORS = /^(?:user|user-review)$/i;
/** A row owner label or a blocker that makes the user a dependency. */
export const userAbsentText = (clock: string) => `The user last wrote at ${clock} and may not come back. Do not wait for them. For every open question you asked, act on the default you stated now; if you stated none, pick the conservative one and say which. Close rows that only need their look as delivered. Only a missionCritical row may wait. If nothing can proceed without an irreversible/public step, wrap up: close what is done, then one final message listing done / left / defaults taken, and stop.`;
export const USER_ABSENT_WRAPUP = "No progress after the last nudge: write the final summary now and stop.";
export function waitsOnUser(owner: unknown, blocker: unknown): boolean {
  if (typeof owner === "string" && USER_ACTORS.test(owner.trim())) return true;
  if (typeof blocker !== "string") return false;
  return /\b(?:await(?:s|ing)?|wait(?:s|ing)?|pending|needs?|requires?|blocked)\b/i.test(blocker)
    && /\b(?:user|user's)\b/i.test(blocker)
    && /\b(?:verdicts?|answers?|repl(?:y|ies)|reviews?|restart|approv\w*|decisions?|responses?|feedback)\b/i.test(blocker);
}
export const USER_WAIT_REFUSAL = 'Deliver the unresolved owner question through review-questions-page and ask with its verified URL; record card/question ID, URL, default and delivery state in the owning row. If publication fails, keep delivery open with the exact failure and next action. Continue authorized reversible implementation on the default without waiting; preserve unanswered cards after implementation closes and while the user is away. Apply an existing saved answer without asking again. Only a mission-critical action may wait on the user: set missionCritical: "<why: irreversible/public/needs their hands or credential>" on that one row; silence or continue is not approval.';
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOpenRowStatus(status: string): boolean {
  return status === "pending" || status === "in_progress";
}
function isNonClosedRowStatus(status: string): boolean {
  return status === "pending" || status === "in_progress" || status === "blocked";
}
/** A row whose worker already delivered and that waits on nobody outside the lead: the only
 * remaining action (push, close, hand off) is the lead's own, so it is ready work, not a block.
 * Decided from row state (executor outcome, attempt deliverables, owner), never the reason prose. */
export function leadActionPending(row: { blocker?: unknown; schedule?: unknown }, runningOwners: ReadonlySet<string> = new Set()): boolean {
  const schedule = (row.schedule ?? {}) as {
    owner?: unknown; review?: unknown; missionCritical?: unknown;
    executor?: { outcome?: unknown; finishedAt?: unknown };
    attemptHistory?: Array<{ terminalStatus?: unknown; deliverablePaths?: unknown[]; gitCommits?: unknown[] }>;
  };
  if (schedule.review === "user" || schedule.review === "accepted" || nonEmptyString(schedule.missionCritical)) return false;
  if (typeof schedule.owner === "string" && (runningOwners.has(schedule.owner) || parseExternalWait(schedule.owner) !== null)) return false;
  if (waitsOnUser(schedule.owner, row.blocker)) return false;
  if (row.schedule?.auditOrigin?.supersededAt) return false;
  const executor = schedule.executor;
  if (executor?.outcome === "completed" && typeof executor.finishedAt === "number") return true;
  const last = schedule.attemptHistory?.at(-1);
  return last?.terminalStatus === "completed" && Boolean(last.deliverablePaths?.length || last.gitCommits?.length);
}
export function leadActionBlockRefusal(rows: readonly string[]): string {
  return `Refusing block: ${rows.map((row) => JSON.stringify(row)).join(", ")} already has a delivered worker result and waits on nobody else; the remaining action is yours. Do it now: push the commit, close the row with todo op="done", or hand it to the user with todo op="schedule", updates=[{task, review:"user"}]. block is only for waiting on someone outside this session.`;
}
function undeliveredUserWait(row: TodoTaskForecast): boolean {
  return row.status === "blocked" && !row.awaitingPrerequisite && (
    row.schedule?.review === "user" || waitsOnUser(row.owner, row.blocker) || row.waitsForUser !== undefined
  );
}
function unresolvedForecastRows(forecast: TodoPlanForecast | null | undefined): TodoTaskForecast[] {
  return (forecast?.rows ?? []).filter((row) => row.estimateRequired || undeliveredUserWait(row));
}
function unresolvedForecastRemedy(rows: TodoTaskForecast[]): string {
  return `Resolve each unforecast row: ${rows.map((row) => {
    const task = row.content;
    const reason = row.issues[0];
    return `${JSON.stringify(task)}${reason ? ` (${shorten(reason)})` : ""}: state a default, then todo ${JSON.stringify({ op: "unblock", task })} if blocked, plus todo ${JSON.stringify({ op: "schedule", updates: [{ task }] })} with the default as evidence, a usable estimate and real dependencies; or estimate the remaining work with todo ${JSON.stringify({ op: "schedule", updates: [{ task }] })}; or todo ${JSON.stringify({ op: "drop", task })}`;
  }).join("; ")}`;
}
function userWaitRows(phases: TodoScheduleInput): Array<{ content: string; question: string; proposal?: string }> {
  return phases.flatMap((phase) => phase.tasks).flatMap((task) => {
    const review = (task.schedule as { review?: unknown } | undefined)?.review === "user";
    const wait = task.status === "blocked" && !review ? parseUserWait(task.blocker) : undefined;
    return wait ? [{ content: task.content, ...wait }] : [];
  });
}
function sprintSetKey(rows: string[]): string {
  return JSON.stringify([...rows].sort());
}
// Updater jobs may deliver their structured result after the completed job snapshot.
const UPDATER_JOB_LABEL = /updat|deploy|install|publish|rollback|release|cutover/i;
// Read the payload before settling a completed updater job so late results remain observable.
function jobResultPayload(job: unknown): unknown {
  if (typeof job !== "object" || job === null) return undefined;
  return "result" in job ? job.result : "data" in job ? job.data : undefined;
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
// resets the completed-retro boundary. Older receipts are outside the processing window.
const RETRO_RECEIPT_SCAN_ENTRIES = 500;
function recentBranchMessages(ctx: ExtensionContext) {
  const source = ctx.sessionManager as BranchSource;
  if (source.getBranchTailMatching) return source.getBranchTailMatching(RETRO_RECEIPT_SCAN_ENTRIES,
    metadata => metadata.type === "message" || metadata.type === "custom_message");
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
// Reconcile those completed updater jobs here so settlement retains their structured results.
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
  const review = typeof schedule.review === "string" ? `; review=${schedule.review}` : "";
  const speculative = typeof schedule.speculativeOn === "string" ? `; speculativeOn=${JSON.stringify(schedule.speculativeOn)}` : "";
  const attempts = schedule.attemptHistory ?? [];
  const last = attempts.at(-1);
  const attemptSummary = last
    ? `${attempts.length} attempts; latest=${JSON.stringify({ attemptId: last.attemptId, workerName: last.workerName, terminalStatus: last.terminalStatus, rejectionReason: safeText(last.rejectionReason, 160), deliverablePaths: last.deliverablePaths })}; full history: todo view with this exact task`
    : "0 attempts";
  return `owner=${JSON.stringify(schedule.owner ?? null)}; dependencies=${dependencies}; resources=${resources}; O/L/P=${estimate}; progress=${progress}; estimateRevision=${revision}; reestimateCount=${reestimates}${review}${speculative}; attemptHistory=${attemptSummary}`;
}

const USER_REVIEW_CUSTOM_TYPE = "todo-user-review";
const USER_UNBLOCK_CUSTOM_TYPE = "todo-user-unblock";
const POST_DEADLINE_RELEASED_CUSTOM_TYPE = "todo-post-deadline-released";

type DispatchTodoPhases = Array<{ name: string; tasks: Array<Record<string, unknown>> }>;

function todoPhases(ctx: ExtensionContext): DispatchTodoPhases {
  const live = ctx.getTodoSnapshot?.() ?? ctx.getTodoPhases?.();
  return (live ?? getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never)) as Array<{ name: string; tasks: Array<Record<string, unknown>> }>;
}

export function updateTodoSchedule(ctx: ExtensionContext, update: (phases: DispatchTodoPhases) => DispatchTodoPhases): void {
  if ((!ctx.getTodoSnapshot && !ctx.getTodoPhases) || !ctx.updateTodoSchedule) return;
  const before = todoPhases(ctx);
  const next = update(before);
  const previousByContent = new Map(before.flatMap((phase) => phase.tasks.map((row) => [row.content, row] as const)));
  for (const phase of next) for (const row of phase.tasks) {
    const previous = previousByContent.get(row.content);
    if (!previous || row === previous || row.schedule === previous.schedule) continue;
    const patch = {} as Record<string, unknown>;
    for (const key of ["deliveryCritic", "handoffPending", "progress", "review", "reviewSummary", "firstRequirementAt", "firstDeliveredAt", "speculativeOn", "visibleAt", "previewPending", "previewTracked", "previewIdentityMissing", "previewPartial"]) {
      if (row.schedule?.[key] !== previous.schedule?.[key]) patch[key] = row.schedule?.[key];
    }
    if (Object.keys(patch).length > 0) ctx.updateTodoSchedule(String(row.content), patch);
  }
}

function rowReviewNotice(row: Record<string, unknown>): string {
  if (!row.schedule?.reviewPage) return prompt.render(chatChoiceInstructions, { failed: [{ row: row.content, status: "missing review page" }] }).trim();
  const schedule = row.schedule as { attemptHistory?: Array<{ deliverablePaths?: string[] }>; executor?: { workerId?: string }; reviewSummary?: string } | undefined;
  const paths = schedule?.attemptHistory?.at(-1)?.deliverablePaths?.filter((path): path is string => typeof path === "string") ?? [];
  const reportLocation = schedule?.reviewSummary?.match(/https?:\/\/\S+|(?:^|\s)(?:[\w./-]+\.(?:png|jpe?g|webp|html|md|tsx?|jsx?|css|rs|py)|[0-9a-f]{7,40})(?=$|\s|[),.])/gi)?.map((part) => part.trim()).join(", ");
  const where = row.schedule?.reviewPage ?? (paths.length ? paths.join(", ") : reportLocation ?? (schedule?.executor?.workerId ? `worker ${schedule.executor.workerId}'s diff/commit` : "the row's diff/commit"));
  const changed = schedule?.reviewSummary ? `Changed: ${schedule.reviewSummary}. ` : `Changed: completed ${String(row.content)}. `;
  return `Delivered to you: ${JSON.stringify(row.content)} is ready to review. ${changed}Look at ${where}. Show this link to the user once; this is information, no answer is awaited.`;
}

function pendingReview(phases: DispatchTodoPhases): Array<Record<string, unknown>> {
  return phases.flatMap((phase) => phase.tasks).filter((row) => (row.schedule as { review?: unknown } | undefined)?.review === "user" && !row.schedule?.reviewAnswers?.length).sort((a, b) => Number(todoNeedsOwnerDecision(b.schedule)) - Number(todoNeedsOwnerDecision(a.schedule)));
}

/** The user is asked once per row. A user message re-surfaces it at most once per message
 * (`userMessageEpoch` is part of the notice identity), never on a timer. */
export function userUnblockAskDue(askedAt: unknown, lastUserMessageAt?: number): boolean {
  if (typeof askedAt !== "number" || !Number.isFinite(askedAt)) return true;
  return typeof lastUserMessageAt === "number" && lastUserMessageAt > askedAt;
}

function latestBranchUserMessage(source: BranchSource) {
  for (const entry of selectBranchNewestFirst(source, metadata => metadata.type === "message" && metadata.messageRole === "user")) {
    const user = latestDeadlineUserMessage([entry]);
    if (user) return user;
  }
}

function lastUserUnblockAsk(ctx: ExtensionContext, row: string): number | undefined {
  for (const entry of selectBranchNewestFirst(ctx.sessionManager, metadata => metadata.type === "custom_message" && (metadata.customType === undefined || metadata.customType === USER_UNBLOCK_CUSTOM_TYPE))) {
    if (entry.type !== "custom_message" || entry.customType !== USER_UNBLOCK_CUSTOM_TYPE) continue;
    const details = (entry.details ?? entry.data) as { row?: unknown; at?: unknown } | undefined;
    if (details?.row === row && typeof details.at === "number") return details.at;
  }
  return;
}

function userUnblockWasAsked(ctx: ExtensionContext, row: string, question: string): boolean {
  for (const entry of selectBranchNewestFirst(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === USER_UNBLOCK_CUSTOM_TYPE)) {
    const details = entry.data as { row?: unknown; question?: unknown; asked?: unknown } | undefined;
    if (details?.row === row && details.question === question && details.asked === true) return true;
  }
  return false;
}

function speculativeRows(phases: DispatchTodoPhases, review: string): Array<Record<string, unknown>> {
  return phases.flatMap((phase) => phase.tasks).filter((row) => (row.schedule as { speculativeOn?: unknown } | undefined)?.speculativeOn === review);
}

export function acceptedSpeculativeMergeDemand(phases: DispatchTodoPhases): string | undefined {
  const demands = phases.flatMap((phase) => phase.tasks)
    .filter((row) => (row.schedule as { review?: unknown } | undefined)?.review === "accepted")
    .flatMap((review) => {
      const completed = speculativeRows(phases, String(review.content)).filter((row) => row.status === "completed");
      if (review.status === "completed" && review.schedule?.speculativeOn && todoRowHasDeliverable(review)) completed.unshift(review);
      return completed.length ? [`user accepted ${JSON.stringify(String(review.content))}; NEXT ACTION: fast merge/publish ${completed.map((row) => JSON.stringify(String(row.content))).join(", ")}`] : [];
    });
  return demands.length ? demands.join("; ") : undefined;
}

/** Match explicit dispatch metadata before worker ownership, then all named rows. */
export function speculativeTaskRows(item: Record<string, unknown>, phases: DispatchTodoPhases): Array<Record<string, unknown>> {
  const rows = phases.flatMap((phase) => phase.tasks);
  if (typeof item.row === "string") return rows.filter(row => row.content === item.row);
  const preview = item.previewIntegration as { task?: string } | undefined;
  if (typeof preview?.task === "string") return rows.filter((row) => row.content === preview.task);
  const taskText = typeof item.task === "string" ? item.task : undefined;
  // Packet Row wins over a worker name previously bound to another row. Same resolver TaskTool uses.
  if (taskPacketRow(taskText, rows.map(row => String(row.content ?? ""))) !== undefined) {
    const target = findTodoExecutorTarget(phases as TodoPhase[], {
      workerId: typeof item.name === "string" ? item.name : "",
      taskText,
      agentProfile: typeof item.agent === "string" ? item.agent : undefined,
      startedAt: 0,
    });
    return target ? [target] : [];
  }
  if (typeof item.name === "string") {
    const owned = rows.filter((row) => todoMatchesObservedWorker(row, { workerId: item.name }));
    if (owned.length) return owned;
  }
  const brief = String(item.task ?? "").trim();
  const exact = rows.filter((row) => row.content === brief);
  if (exact.length) return exact;
  const target = findTodoExecutorTarget(phases as TodoPhase[], {
    workerId: typeof item.name === "string" ? item.name : "",
    taskText: brief,
    agentProfile: typeof item.agent === "string" ? item.agent : undefined,
    startedAt: 0,
  });
  const mentioned = rows.filter((row) => typeof row.content === "string" && row.content.trim().length > 0 && brief.includes(row.content));
  const distinct = mentioned.filter((row) => !mentioned.some((other) => other !== row && typeof other.content === "string" && other.content.includes(String(row.content))));
  if (!target) return distinct;
  return [target, ...distinct.filter((row) => row !== target && !brief.includes(String(target.content)))];
}

function readOnlyAudit(item: Record<string, unknown>): boolean {
  return ["qa-auditor", "reviewer", "gate-runner"].includes(String(item.agent ?? "").toLowerCase());
}

export function missingSpeculativeReview(item: Record<string, unknown>, phases: DispatchTodoPhases, boundRow?: Record<string, unknown>): string | undefined {
  if (readOnlyAudit(item)) return;
  const rows = boundRow ? [boundRow] : speculativeTaskRows(item, phases);
  for (const row of rows) {
    const schedule = row.schedule as { dependencies?: string[]; speculativeOn?: string } | undefined;
    const pending = schedule?.dependencies?.find((dependency) => phases.some((phase) => phase.tasks.some((candidate) => candidate.content === dependency && candidate.status !== "completed" && candidate.status !== "abandoned" && candidate.schedule?.review === "user")));
    if (pending && schedule?.speculativeOn !== pending) return pending;
  }
  return;
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
      `- ${JSON.stringify(job.id)} ${job.status} agent=${JSON.stringify(job.agentId ?? null)} label=${JSON.stringify(shorten(job.label ?? job.id))}`,
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
      : "Reconcile every running job and parked/restored child against TODO ownership before another batch. Read delivered findings and custody first; resume a recoverable idle owner for the unmet delta, accept a valid delivery, or retire a disproved method with findings. Fresh-dispatch only ready rows disjoint from live-owned work. An empty live snapshot is not nothing-to-reconcile.",
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
  input = { ...input, phases: withoutSupersededAudits(input.phases) };
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
  const forecast = sdk.forecastTodoPlan(withTodoArchive(parking.phases, input.archivedPhases ?? []), {
    risk: input.risk,
    history: input.history,
    now,
    deadlineAt: deadline?.deadlineAt,
    ...(capacity === undefined ? {} : { capacity }),
    ...(startableCapacity === undefined ? {} : { executableCapacity: startableCapacity }),
  });
  const liveContents = new Set(phases.flatMap(phase => phase.tasks.map(task => task.content)));
  forecast.rows = forecast.rows.filter(row => liveContents.has(row.content));
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
  const liveWorkers = liveTaskWorkers(jobs);
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
    liveWorkers.map((worker) => worker.id),
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
      liveWorkers.some((worker) => liveJobMatchesOwner({ id: worker.jobId, agentId: worker.id }, owner)) ||
      livePersistedChildForOwner(owner) !== undefined ||
      externalOwners.get(owner) === true
    );
  const openTasksByContentEarly = new Map(open.map(({ task }) => [task.content, task]));
  const ownerRunStates = open.map(({ task }) => {
    const owner = typeof task.schedule?.owner === "string" ? task.schedule.owner : null;
    const executorId = task.schedule?.executor?.workerId;
    const identities = [owner, executorId].filter((id): id is string => typeof id === "string" && id.length > 0);
    const settled = jobs?.recent.find(job => identities.some(id => liveJobMatchesOwner(job, id)) && job.status !== "running");
    return { content: task.content, owner, running: liveTaskWorker(task, liveWorkers) !== undefined || (owner !== null && externalOwners.get(owner) === true), outcome: settled?.status ?? task.schedule?.executor?.outcome };
  });
  const runningOwnedContents = new Set(
    open
      .filter(({ task }) => {
        const owner = typeof task.schedule?.owner === "string" ? task.schedule.owner : null;
        return liveTaskWorker(task, liveWorkers) !== undefined || (owner !== null && ownerHasActiveTask(owner));
      })
      .map(({ task }) => task.content),
  );
  // Post-completion lifecycle from row state: a delivered result is verified by the runtime audit,
  // never re-staffed; findings-only, aborted or lost runs and failed audits need a worker that
  // continues from the previous output (live DC 2026-11-06: 9 delivered/finished rows re-demanded).
  const afterWorker = new Map(ownerRunStates.map((row) => {
    const task = openTasksByContentEarly.get(row.content);
    return [row.content, row.running || ownerHasActiveTask(row.owner) || !task ? undefined : todoRowAfterWorker(task)] as const;
  }));
  const verifyingContents = new Set([...afterWorker].filter(([, after]) => after?.kind === "verify").map(([content]) => content));
  const lostOwners = jobs !== null
    ? open.flatMap(({ task }) => {
        const owner = task.schedule?.owner;
        return task.status === "in_progress" && typeof owner === "string" && !liveTaskWorker(task, liveWorkers) && !ownerHasActiveTask(owner) && !verifyingContents.has(task.content)
          ? [{ content: task.content, owner }]
          : [];
      })
    : [];
  const openTasksByContent = new Map(open.map(({ task }) => [task.content, task]));
  const liveResourceHolders = open
    .filter(({ task }) => {
      const owner = task.schedule?.owner;
      return task.status === "in_progress" && (liveTaskWorker(task, liveWorkers) !== undefined || (typeof owner === "string" && ownerHasActiveTask(owner)));
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
      const liveWorkerId = liveTaskWorker(openTasksByContent.get(row.content), liveWorkers)?.id ?? activeRestoredChild?.id;
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
      return { content: row.content, owner: liveWorkerId ?? owner, ownership };
    });
  const ownerlessReady = readyCandidates.filter((row) => row.ownership !== "live-owned" && !verifyingContents.has(row.content));
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
      !(afterWorker.get(candidate.content)?.kind !== "needs-worker" && candidate.owner !== null && completedTaskOwners.has(candidate.owner) &&
        openTasksByContent.get(candidate.content)?.status === "in_progress") &&
      // A restored owner that is not running after startup is dead (omp --resume brings nobody back):
      // its row is staffed again under the owner's name (live 21:48: 0 of 20 ran while two such rows waited).
      resourceExecutableContents.has(candidate.content) &&
      !(candidate.ownership === "idle-live-owner" && candidate.owner !== null && input.idleResumeAttempts?.has(candidate.owner)) &&
      !(candidate.owner === null && (input.restoredChildren?.length ?? 0) > 0),
  ).map((candidate) => {
    const after = afterWorker.get(candidate.content);
    return after?.kind === "needs-worker"
      ? { ...candidate, previous: after.worker, reason: after.reason, ...(after.findings ? { findings: after.findings } : {}) }
      : candidate;
  });
  const actionableReadyContents = new Set(
    staffingSnapshotComplete && taskEnabled && !goalPaused && capacity !== undefined &&
      (startableCapacity === undefined
        ? capacity === 0 || liveWorkers.length + activeRestoredTaskIds.size < capacity
        : liveWorkers.length + activeRestoredTaskIds.size < startableCapacity)
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
                          : `First reconcile any just-settled task worker using action 2. For each idle or parked/restored owner${resumeOwners.length ? ` (${resumeOwners.map((owner) => JSON.stringify(owner)).join(", ")})` : ""}, inspect its actual result and custody first. Steer a recoverable live owner; accept a valid delivery or retire a disproved method with its findings. Start a capable continuation only for the concrete unmet delta. A historical owner name alone does not require a replacement. Then immediately start distinct live workers for as many unstaffed ready rows as the actual Task cap (0 means Unlimited) and canonical resource forecast allow; queue remaining rows and dispatch as capacity/resources free. Reuse one ID only on a strict dependency chain scheduled sequentially. Main coordinates staffed work, and owns integration and delivery.`;
  const readyFacts = readyCandidates.map((row) => [row.content, row.owner, row.ownership]);
  const failedTasks =
    jobs?.recent.filter(
      (job) => job.type === "task" && (job.status === "failed" || job.status === "cancelled"),
    ) ?? [];
  const alarmSet = new Set<string>();
  for (const issue of planningIssues)
    alarmSet.add(`${issue.code}:${JSON.stringify(issue.task)}`);
  // A user-wait with a proposal is parked while away, not a recovery failure.
  const recoveryBlocked = blocked.filter(({ task }) => !parkedContent.has(task.content) && (task.schedule as { review?: unknown } | undefined)?.review !== "user");
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
  const corrections = forecastRows.filter(row => missed.includes(row) || row.reestimateCount >= 5)
    .map((row) => row.reestimateCount >= 5
      ? `EXHAUSTED ${JSON.stringify(row.content)}: reestimates=${row.reestimateCount}. Do not reestimate this same row again; record the previous attempt's receipt and failing acceptance check, then split the remaining scope into new rows.`
      : `- ${JSON.stringify(row.content)}: revision=${row.estimateRevision}; reestimates=${row.reestimateCount}`);
  const repeatedEstimates = forecastRows.filter((row) => row.reestimateCount >= 3);
  const dispatchPrompt = [
    ...(!goalPaused && deadlineRisk
      ? [prompt.render(deadlineMissInstructions, { deliveryFirst: true }).trim()]
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
    ...(verifyingContents.size ? [`Delivered rows under runtime audit (${verifyingContents.size}; do not staff, the audit closes or returns them): ${[...verifyingContents].map((content) => JSON.stringify(content)).join(", ")}`] : []),
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
    prompt: dispatchPrompt,
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
    verifyingRows: [...verifyingContents],
    capacity,
    activeTaskCount: liveWorkers.length + activeRestoredTaskIds.size,
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

export default async function todoDispatch(pi: ExtensionAPI, options: { externalOwnerProbe?: ExternalOwnerProbe; reviewPageProbe?: ReviewPageProbe; reviewPageOpener?: (url: string) => void; deliveryCriticRecord?: (row: DeliveryRow, verdict: DeliveryVerdict) => Promise<void> } = {}): Promise<void> {
  planCritic(pi, ctx => currentDecision(ctx).ownerRunStates ?? []);
  installWorkerAskInterrupt(pi);
  installRequirementResolution(pi);
  const priorDeliveries = new Set<string>();
  const deliveryKey = (row) => JSON.stringify([row.content, row.schedule?.executor?.workerId, row.schedule?.executor?.startedAt, row.schedule?.executor?.finishedAt]);
  const checkDeliveries = (ctx: ExtensionContext) => {
    if (!isMain(ctx)) return;
    if (!singleWriterLane) void checkRowAudits(ctx, { recordRequirementDiff: data => pi.appendEntry("requirement-diff-audit", data), readTarget: async cwd => {
      const state = await readGitIntegrationState(cwd, Date.now());
      return { remote: state?.pushRemote, branch: state?.pushBranch };
    } }).catch(() => {});
    const previews = previewRecords(ctx);
    for (const phase of todoPhases(ctx)) for (const row of phase.tasks) {
      if (row.schedule?.deliveryCritic || !priorDeliveries.has(deliveryKey(row)))
        queueDeliveryCritic(ctx, row, "", options.deliveryCriticRecord, Date.now(), previews.find(record => record.task === row.content)?.previewPath);
    }
  };
  const singleWriterLane = process.env.OMP_LANE_UNIT !== undefined;
  const previewConfig = (ctx: ExtensionContext) => ctx.getTodoPreviewConfig?.() ?? { enabled: false, paths: [], thresholdMinutes: 15 };
  let previewPoll: Promise<PreviewRecord[]> | undefined;
  const previewRecords = (ctx: ExtensionContext): PreviewRecord[] => {
    const entry = selectLatestBranchEntry(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === PREVIEW_ENTRY_TYPE);
    return Array.isArray(entry?.data?.records) ? entry.data.records : [];
  };
  const openedReviewPages = new Set<string>();
  const reviewAnswers = new ReviewAnswerPoller();
  const pollReviewAnswers = (ctx: ExtensionContext, force = false) => {
    if (singleWriterLane || !isMain(ctx)) return Promise.resolve();
    return reviewAnswers.poll(ctx, (row, card) => pi.sendMessage({ customType: "todo-review-stale-answer",
      content: `Saved owner answer for ${JSON.stringify(row)} (card ${card}) belongs to an older published revision; reconcile it before requesting another review.`, display: true }), force);
  };
  const pollPreview = async (ctx: ExtensionContext): Promise<PreviewRecord[]> => {
    await pollReviewAnswers(ctx);
    if (!singleWriterLane && isMain(ctx)) {
      for (const row of todoPhases(ctx).flatMap(phase => phase.tasks)) {
        if (!row.schedule?.reviewPagePending || !row.schedule.reviewPage) continue;
        try {
          if (await (options.reviewPageProbe ?? probeReviewPage)(row.schedule.reviewPage, String(row.content)) === 200)
            ctx.updateTodoSchedule?.(String(row.content), { reviewPagePending: undefined });
        } catch {}
      }
      if (ctx.getTodoPreviewConfig?.().openReviewPages !== false) {
        const entry = selectLatestBranchEntry(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === "todo-review-opened");
        for (const key of entry?.data?.keys ?? []) if (typeof key === "string") openedReviewPages.add(key);
        await openReviewPages(todoPhases(ctx), openedReviewPages, options.reviewPageProbe, options.reviewPageOpener,
          key => pi.appendEntry("todo-review-opened", { keys: [...openedReviewPages].filter(value => !value.startsWith("pending:")).concat(key) }));
      }
    }
    const config = previewConfig(ctx);
    if (!config.enabled) {
      for (const row of ((ctx.getTodoSnapshot?.() ?? ctx.getTodoPhases?.()) ?? []).flatMap(phase => phase.tasks))
        if (row.schedule?.previewTracked) ctx.updateTodoSchedule?.(row.content, { previewTracked: false, previewPending: false });
      return [];
    }
    if (previewPoll) return previewPoll;
    previewPoll = (async () => {
      const before = previewRecords(ctx);
      const phases = (ctx.getTodoSnapshot?.() ?? ctx.getTodoPhases?.()) ?? [];
      const captured = await capturePreviewWorkerHeads(ctx, phases, before);
      const records = await refreshPreviewVisibility(phases, config, captured, Date.now());
      if (JSON.stringify(before) !== JSON.stringify(records)) pi.appendEntry(PREVIEW_ENTRY_TYPE, { records });
      for (const row of phases.flatMap(phase => phase.tasks)) {
        if (row.schedule?.firstRequirementAt === undefined) continue;
        const observed = records.filter(record => record.task === row.content);
        const visible = observed.filter(record => record.visibleAt !== undefined);
        const visibleAt = observed.length > 0 && visible.length === observed.length ? Math.max(...visible.map(record => record.visibleAt!)) : undefined;
        const pending = visibleAt === undefined;
        const previewIdentityMissing = !observed.some(record => record.commit);
        const previewPartial = visible.length > 0 && pending;
        if (row.schedule.previewTracked !== true || row.schedule.previewPending !== pending || row.schedule.visibleAt !== visibleAt || row.schedule.previewIdentityMissing !== previewIdentityMissing || row.schedule.previewPartial !== previewPartial)
          ctx.updateTodoSchedule?.(row.content, { previewTracked: true, previewPending: pending, previewIdentityMissing, previewPartial, visibleAt });
      }
      return records;
    })();
    try { return await previewPoll; } finally { previewPoll = undefined; }
  };

  const host = pi.pi;
  const hostSdk = host as DispatchForecastApi | undefined;
  if (!hostSdk?.forecastTodoPlan || !hostSdk.formatPlanForecast || !hostSdk.formatTaskForecast) return;
  const sdk = {
    forecastTodoPlan: hostSdk.forecastTodoPlan,
    formatPlanForecast: hostSdk.formatPlanForecast,
    formatTaskForecast: hostSdk.formatTaskForecast,
    getTodoPlanningIssues: hostSdk.getTodoPlanningIssues,
    // Older native readers do not recognize the extension-owned automatic anchor.
    readGoalDeadline: (entries, cwd, options) => rehydrateDeadlineState(entries)?.auto === true
      ? readGoalDeadline(entries, cwd, options)
      : (hostSdk.readGoalDeadline ?? readGoalDeadline)(entries, cwd, options),
    getLatestTodoPhasesFromEntries: ((entries: never) => readDispatchTodoPhases(entries, host.getLatestTodoPhasesFromEntries)) as typeof host.getLatestTodoPhasesFromEntries,
  };
  // Rows the lead declared mission-critical (irreversible/public/needs their hands) in a todo call; only these may wait on the user.
  const missionCriticalRows = new Set<string>();
  // The pause switch is host-owned. Never import a second module instance of its singleton.
  const pauseGate = host?.agentPauseGate;
  // Legacy hosts can render advice, but cannot safely schedule autonomous wakes until upgraded.
  let cachedStatic: { key: string; text: string } | null = null;
  let cachedDecision: { key: string; decision: DispatchDecision } | null = null;
  let pendingAutoForecastMissAt: number | null = null;
  let lastWakeKey: string | null = null;
  let persistedChildren: PersistedChild[] = [];
  let sprintState: SprintState = blankSprintState();
  let wakeContext: ExtensionContext | undefined;
  let wakeTurn: { before: TodoScheduleInput; toolCalls: number; mutations: number; target?: string; chain?: WaitChainDemand; rejection?: string; demandKey?: string } | undefined;
  let recovery: RecoveryState | undefined;
  let recoverySession: string | undefined;
  const recoveryReceipt = (ctx) => selectLatestBranchEntry(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === "todo-dispatch-action-demand")?.data as WakeReceipt | undefined;
  const saveRecovery = (ctx, fields = {}) => {
    const prior = recoveryReceipt(ctx);
    pi.appendEntry("todo-dispatch-action-demand", { ...prior, key: prior?.key ?? "recovery-observation", row: prior?.row, action: prior?.action ?? "", misses: prior?.misses ?? 0, noToolMisses: fields.mutations ? 0 : prior?.noToolMisses ?? 0, toolCalls: 0, mutations: 0, ...fields, ...(fields.mutations ? { retryAt: undefined, resetAt: Math.max(Date.now(), (recoveryReceipt(ctx)?.resetAt ?? 0) + 1) } : {}), recovery: structuredClone(recovery) });
  };
  const recoveryFor = (ctx) => {
    const session = ctx.sessionManager.getHeader()?.id;
    if (recoverySession !== session || !recovery) { recoverySession = session; recovery = recoveryReceipt(ctx)?.recovery; }
    const decision = currentDecision(ctx);
    const next = recoveryDemand(todoPhases(ctx), runningOwnerNames(ctx), Date.now(), workerCapacity(ctx), decision.deadline?.deadlineAt, decision.forecast?.expectedResourceFinish, recovery, (ctx.getAsyncJobSnapshot()?.running ?? []).filter(job => job.type === "task").length, new Set((decision.dispatchableReady ?? []).map(row => row.content)));
    if (JSON.stringify(next) !== JSON.stringify(recovery)) { recovery = next; saveRecovery(ctx); }
    return recovery?.pending;
  };
  const satisfyRecovery = (ctx) => {
    const pending = recovery?.pending;
    if (!pending) return;
    const decision = currentDecision(ctx);
    recovery.satisfied = pending.kind === "deadline" ? `deadline:${pending.deadline}:${Math.ceil((Math.max(Date.now(), decision.forecast?.expectedResourceFinish ?? 0) - pending.deadline) / 600000)}` : recovery.satisfied;
    recovery.pending = undefined;
    saveRecovery(ctx, { key: pending.key, action: pending.action, misses: 0, mutations: 1 });
  };
  if (pi.registerTool && pi.typebox) pi.registerTool({
    name: "todo_dispatch_forecast", label: "Measured plan forecast", approval: "write", loadMode: "essential",
    description: "Record an ETA computed from completed TODO rows per hour over the observed window; cannot invent pace or a delivery promise.",
    parameters: pi.typebox.Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      if (!isMain(ctx)) throw new Error("Only the lead can record a plan forecast");
      const demand = recoveryFor(ctx);
      recovery.forecast = measuredRecoveryForecast(recovery, todoPhases(ctx), Date.now());
      if (demand?.kind === "deadline") satisfyRecovery(ctx);
      else saveRecovery(ctx);
      const deadline = currentDecision(ctx).deadline;
      return { content: [{ type: "text", text: formatMeasuredPlanForecast(recovery.forecast, deadline?.timezone, deadline?.deadlineAt) }], details: { forecast: structuredClone(recovery.forecast) } };
    },
  });
  let wakeJobs: string | undefined;
  let wakeHasEvent = false;
  const chainDemand = (phases: TodoScheduleInput) => waitChainDemands(phases).find(demand => !waitChainRejection(demand, phases));
  const wakeDemand = (phases, running, now, deadline, finish, questions, ctx) => {
    if (ctx) {
      const prior = recoveryReceipt(ctx);
      if (prior?.row && unfinishedDependencyChains(phases, prior.row).length && prior.misses > 0)
        pi.appendEntry("todo-dispatch-action-demand", { ...prior, misses: 0, noToolMisses: 0, toolCalls: 0, mutations: 0 });
      const rows = phases.flatMap(phase => phase.tasks);
      const slipped = deadline !== undefined && Math.max(now, finish ?? 0) > deadline;
      const waiting = slipped ? rows.filter(row => isNonClosedRowStatus(row.status)).map(row => ({ row: row.content })) : planChurnRows(phases);
      for (const item of waiting) {
        const chains = unfinishedDependencyChains(phases, item.row).filter(chain => !chain.slice(1).some(title => {
          const row = rows.find(row => row.content === title);
          return running.has(row?.schedule?.owner ?? "") || running.has(row?.schedule?.executor?.workerId ?? "");
        }));
        if (!chains.length) continue;
        const paths = chains.map(chain => chain.join(" <- "));
        sendHarnessNotice("todo-dependency-wait", item.row, prompt.render(dependencyWaitInstructions, { paths }).trim(), { row: item.row, paths });
      }
    }
    const strict = ctx ? recoveryFor(ctx) : undefined;
    const usual = stalledWakeDemand(phases, running, now, deadline, finish, questions);
    const primary = questions?.length ? usual : chainDemand(phases) ?? (usual?.churn ? usual : undefined);
    return primary && strict
      ? { ...primary, key: JSON.stringify([primary.key, strict.key]), action: prompt.render(concurrentRecoveryInstructions, { primary: primary.action, recovery: strict.action }).trim() }
      : primary ?? strict ?? usual;
  };
  const retryRemaining = (ctx: ExtensionContext, key: string) => {
    const previous = selectLatestBranchEntry(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === "todo-dispatch-action-wake")?.data;
    return wakeRetryRemaining(key, Date.now(), recoveryReceipt(ctx), previous);
  };
  const prepareWake = (ctx: ExtensionContext) => {
    const before = todoPhases(ctx);
    const jobs = (ctx.getAsyncJobSnapshot()?.recent ?? []).filter(job => job.type === "task").map(job => [job.id, job.status]);
    const stamp = JSON.stringify(jobs);
    const realUpdate = wakeHasEvent || (wakeJobs !== undefined && stamp !== wakeJobs && jobs.length > 0);
    wakeJobs = stamp;
    wakeHasEvent = false;
    wakeTurn = { before: structuredClone(before), toolCalls: 0, mutations: 0 };
    const decision = currentDecision(ctx);
    const demand = wakeDemand(before, runningOwnerNames(ctx), Date.now(), decision.deadline?.deadlineAt, decision.forecast?.expectedResourceFinish, pendingWorkerQuestions(ctx), ctx);
    const receipt = selectLatestBranchEntry(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === "todo-dispatch-action-demand")?.data as WakeReceipt | undefined;
    wakeTurn.demandKey = demand?.key;
    if (demand?.churn) wakeTurn.target = demand.row;
    wakeTurn.chain = chainDemand(before);
    if (wakeTurn.chain || recovery?.pending) pi.appendEntry("todo-dispatch-action-demand", { ...(receipt?.key === demand.key ? receipt : {}), recovery: structuredClone(recovery), key: demand.key, row: demand.row, action: demand.action, edges: wakeTurn.chain?.edges, misses: receipt?.key === demand.key ? receipt.misses : 0, noToolMisses: receipt?.key === demand.key ? receipt.noToolMisses ?? 0 : 0, toolCalls: 0, mutations: 0 });
    const misses = demand && receipt?.key === demand.key ? receipt.misses : 0;
    return { silentAssistant: !realUpdate, ...(demand ? { actionDemandKey: demand.key, actionDemand: prompt.render(dispatchWakeInstructions, { ...demand, misses, escalation: misses > 0 }).trim() } : {}) };
  };
  const requirementRowsSeen = new Set<string>();
  let latestUserRequestAt: number | undefined;
  const rescheduledRowsThisTurn = new Set<string>();
  let idlePlanDemandedThisTurn = false;
  let persistedSprintStateJson = JSON.stringify(sprintState);
  let dispatchGateBaseline: Map<string, string> | null = null;
  const taskCallBaselines = new Map<string, Map<string, string>>();
  const receiptKey = (job: Jobs["recent"][number]): string => JSON.stringify([job.id, job.agentId, job.startTime, job.endTime]);
  const receiptJobForRow = (ctx: ExtensionContext, row: { owner?: string | null }) => {
    const jobs = ctx.getAsyncJobSnapshot();
    if (!row.owner || jobs?.running.some(job => liveJobMatchesOwner(job, row.owner!))) return;
    return jobs?.recent.find(job => job.type === "task" && job.status === "completed" && liveJobMatchesOwner(job, row.owner!));
  };
  const unreadReceiptRows = (ctx: ExtensionContext, rows: TodoTaskForecast[]) => rows.filter(row => {
    const job = receiptJobForRow(ctx, row);
    return isNonClosedRowStatus(row.status) && job && !sprintState.receiptReconciledKeys?.includes(JSON.stringify([receiptKey(job), row.content]));
  });
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
    wakeTurn = undefined;
    recovery = undefined;
    recoverySession = undefined;
    wakeJobs = undefined;
    wakeHasEvent = false;
    cachedStatic = null;
    cachedDecision = null;
    requirementRowsSeen.clear();
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
  const sendHarnessNotice = (kind: string, rowKey: string, content: string, details?: unknown, identity: string = content, delivery: { triggerTurn?: boolean; interruptWait?: boolean; supersedes?: string } = {}): boolean => {
    const key = noticeKey(kind, rowKey);
    const digest = noticeDigest(identity);
    if (sprintState.lastNotices[key] === digest) {
      pi.appendEntry("todo-dispatch-silent-notice", { kind, digest, at: Date.now() });
      return false;
    }
    const { [key]: _previous, ...others } = sprintState.lastNotices;
    sprintState = { ...sprintState, lastNotices: boundedNotices({ ...others, [key]: digest }) };
    persistSprintState();
    // Replace pending state by subject, independently of the digest used to suppress emissions.
    // The queue owns replacement across nextTurn and steering, including while the lead is busy.
    const wake = delivery.triggerTurn && wakeContext ? prepareWake(wakeContext) : undefined;
    if (wake?.actionDemandKey && wakeContext) {
      const now = Date.now();
      const previous = selectLatestBranchEntry(wakeContext.sessionManager, metadata => metadata.type === "custom" && metadata.customType === "todo-dispatch-action-wake")?.data;
      // One reservation shared by the minute ticker and idle timer, retained across reload.
      if (wakeRetryRemaining(wake.actionDemandKey, now, recoveryReceipt(wakeContext), previous) > 0) delivery = { ...delivery, triggerTurn: false };
      else pi.appendEntry("todo-dispatch-action-wake", { key: wake.actionDemandKey, at: now, resetAt: recoveryReceipt(wakeContext)?.resetAt });
    }
    if (wake?.actionDemand) content += `\n${wake.actionDemand}`;
    if (wake) details = { ...((details as Record<string, unknown>) ?? {}), ...wake };
    const sent = kind === "todo-plan-check" ? { ...((details as Record<string, unknown> | undefined) ?? {}), supersedesQueued: true } : details;
    const stateNote = kind === "todo-gate-steering" || kind === "todo-plan-check";
    const options = { deliverAs: stateNote ? "steer" as const : "nextTurn" as const, triggerTurn: false, interruptWait: false, supersedes: kind === "todo-plan-check" ? kind : key, ...delivery };
    pi.sendMessage(
      { customType: kind, content, display: false, attribution: "agent", ...(sent === undefined ? {} : { details: sent }) },
      options,
    );
    return true;
  };
  const addSeenRow = (content: string) => {
    if (sprintState.seenRows.includes(content)) return;
    sprintState = { ...sprintState, seenRows: [...sprintState.seenRows, content] };
  };
  // Both task receipts and plan snapshots settle through this path. Remember each job
  // once and keep explicitly requested facilitator completions across async delivery.
  const settleSprintJobs = (jobs: Jobs["recent"], now: number) => {
    let facilitatorSettled = false;
    for (const job of jobs) {
      if (job.type !== "task" || !["completed", "failed"].includes(job.status)) continue;
      if (sprintState.seenJobIds.includes(job.id)) continue;
      const label = typeof job.label === "string" ? job.label : "";
      // Async dispatch settles the job snapshot before its structured result lands on the
      // branch. An updater-labelled completion with no result yet is not final: marking it seen
      // here would skip the later async-result. It finalises when a result for the same id
      // is evaluated; a failed job finalises immediately.
      const payload = jobResultPayload(job);
      const awaitingResult = job.status === "completed" && UPDATER_JOB_LABEL.test(label) &&
        (payload === undefined || payload === null);
      const id = job.agentId ?? job.id;
      const at = typeof job.startTime === "number" ? job.startTime : now;
      const facilitator = [job.agentId, job.label, job.id].some((name) => typeof name === "string" && retroFacilitatorJobs.has(name));
      if (facilitator && job.status === "completed") facilitatorSettled = true;
      // Failed workers are usually provider refusals, not retro participants.
      sprintState = {
        ...sprintState,
        ...(awaitingResult ? {} : { seenJobIds: [...sprintState.seenJobIds, job.id] }),
        ...(job.status !== "completed" || facilitator || sprintState.workerFinishes.some((finish) => finish.jobId === job.id)
          ? {}
          : { workerFinishes: [...sprintState.workerFinishes, { jobId: job.id, id, at, row: label }] }),
      };
    }
    return { facilitatorSettled };
  };
  const touchSprintState = (ctx: ExtensionContext, phases: TodoScheduleInput, jobs: Jobs | null, now: number) => {
    const tasks = withTodoArchive(phases, dispatchTodoArchive(ctx)).flatMap((phase) => phase.tasks);
    sprintLiveRows = new Set(tasks.map((task) => task.content));
    const open = tasks.filter((task) => isOpenRowStatus(task.status));
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
    const { facilitatorSettled } = settleSprintJobs([...branchAsyncTaskResults(ctx, recentMessages), ...(jobs?.recent ?? [])], now);
    // One persist per loop: a burst of background receipts used to persist a full snapshot per receipt.
    const freshReceipts = branchRetroReceiptIds(ctx, recentMessages).filter((receipt) => !sprintState.retroReceiptIds.includes(receipt));
    if (facilitatorSettled || freshReceipts.length > 0) finishRetro(freshReceipts.length > 0 ? freshReceipts : undefined, false, tasks.flatMap(rowAttemptKeys));
    if (open.length > 0 && sprintState.goalWorkStartedAt === null) {
      // Only finishes since the last retro start the next goal-work window; older ones were covered.
      const sinceRetro = sprintState.workerFinishes.filter((finish) => sprintState.lastRetroAt === null || finish.at >= sprintState.lastRetroAt);
      const knownWorkerAt = sinceRetro.length ? Math.min(...sinceRetro.map((finish) => finish.at)) : now;
      sprintState = { ...sprintState, goalWorkStartedAt: Math.min(now, knownWorkerAt) };
    }
    sprintState = { ...sprintState, rowStatuses: nextStatuses };
    persistSprintState();
  };
  const finishRetro = (receipt?: string | string[], persist = true, coveredAttempts: string[] = []) => {
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
    };
    retroFacilitatorJobs.clear();
    if (persist) persistSprintState();
  };
  const demandThreshold = (id: string): number => (id === "todo-replan" ? DEMAND_IGNORE_MAX_REPLAN : DEMAND_IGNORE_MAX);
  const isDemandEscalated = (id: string): boolean => (sprintState.ignoredDemands[id] ?? 0) >= demandThreshold(id);
  // Grievances 547/590: a todo override names the gate it answers and suppresses it
  // for OVERRIDE_SUPPRESS_TURNS turns (negative count); the idle-wait refusal consults this.
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
  let risk: RowRiskOptions | undefined;
  let riskCheckedAt = 0;
  let riskRefreshing = false;
  const refreshRowRisk = (ctx: ExtensionContext) => {
    if (riskRefreshing || Date.now() - riskCheckedAt < 15_000 || !ctx.models?.rowRisk) return;
    riskRefreshing = true;
    void ctx.models.rowRisk().then((next) => { risk = next; cachedDecision = null; })
      .catch(() => { risk = undefined; })
      .finally(() => { riskCheckedAt = Date.now(); riskRefreshing = false; });
  };
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
    // Reconstruct historical archives during resume, before interactive dispatch/render reads.
    dispatchTodoArchive(ctx);
    resetDeliveryCriticTimers(ctx);
    priorDeliveries.clear();
    for (const phase of todoPhases(ctx)) for (const row of phase.tasks)
      if (row.schedule?.executor?.outcome === "completed") priorDeliveries.add(deliveryKey(row));
    checkDeliveries(ctx);
    flushSprintState();
    risk = undefined; riskCheckedAt = 0;
    reset();
    for (const phase of todoPhases(ctx)) for (const task of phase.tasks) if (typeof task.content === "string") requirementRowsSeen.add(task.content);
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
    void getTodoPlanCalibrationStore().refresh().then(() => { cachedDecision = null; });
    refreshRowRisk(ctx);
    releaseLapsedPostDeadline(ctx);
    if (typeof pi.appendEntry === "function" && !singleWriterLane && !pauseGate?.paused && !gateSwitchedOff(ctx) && isMain(ctx)) recoveryFor(ctx);
    announceGates(ctx);
    void refreshPush(ctx);
  };
  pi.on("session_start", loadAndRefresh);
  pi.on("session_switch", loadAndRefresh);
  pi.on("session_branch", loadAndRefresh);
  pi.on("session_tree", loadAndRefresh);
  pi.on("session_shutdown", (_event, ctx) => {
    persistRoster(ctx);
    flushSprintState();
    risk = undefined; riskCheckedAt = 0;
    reset();
    disarmPlanTicker();
  });
  pi.on("agent_start", (_event, ctx) => {
    clearIdleTimer();
    healPlanTicker(ctx);
  });
  pi.on("turn_start", (_event, ctx) => {
    if (!singleWriterLane && !pauseGate?.paused && !gateSwitchedOff(ctx) && isMain(ctx)) {
      // Observe dependency changes even when they suppress an actionable wake.
      // Otherwise held rows keep stale misses and never show their blocking path.
      const decision = currentDecision(ctx);
      const demand = wakeDemand(todoPhases(ctx), runningOwnerNames(ctx), Date.now(), decision.deadline?.deadlineAt, decision.forecast?.expectedResourceFinish, pendingWorkerQuestions(ctx), ctx);
      if (demand) {
        const wake = prepareWake(ctx);
        // Advice must not enqueue another turn; the existing wake scheduler owns retries.
        if (wake.actionDemand && !deliveredDispatchAction(ctx, wake.actionDemand)) pi.sendMessage({ customType: "todo-dispatch-action-required", content: wake.actionDemand, display: false, attribution: "agent" }, { deliverAs: "aside", triggerTurn: false, interruptWait: false, supersedes: "todo-dispatch-action-required" });
      }
    }
    sprintState.lastNotices = Object.fromEntries(Object.entries(sprintState.lastNotices).filter(([key]) => !key.startsWith("todo-gate-staffing\0")));
    announceGates(ctx);
    idlePlanDemandedThisTurn = false;
    healPlanTicker(ctx);
  });
  let presenceCache: { minute: number; entries: readonly unknown[]; presence: Presence } | null = null;
  const presenceOf = (branch: readonly unknown[], now: number): Presence => {
    const minute = Math.floor(now / 60_000);
    if (presenceCache?.minute === minute && presenceCache.entries.length === branch.length && presenceCache.entries.every((entry, index) => entry === branch[index])) return presenceCache.presence;
    let presence: Presence = "watching";
    try {
      presence = derivePresence(branch, rehydrateDeadlineState(branch), now);
    } catch {}
    presenceCache = { minute, entries: branch, presence };
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
    wakeContext = ctx;
    // `pending`: entries not yet on the branch, such as the todo result a tool_result hook is amending.
    const branch = dispatchStateEntries(ctx, pending);
    const header = ctx.sessionManager.getHeader();
    const presence = header !== null && !header.parentSession ? presenceOf(branch, now) : undefined;
    const goalPaused = lifecycleGoal(branch, [])?.status === "paused";
    let deadline = sdk.readGoalDeadline(branch, ctx.cwd, { includePaused: true });
    const deadlineState = rehydrateDeadlineState(branch);
    const realGoal = lifecycleGoal(branch, []);
    const taskMaxConcurrency = ctx.getTaskMaxConcurrency?.();
    const capacity =
      typeof taskMaxConcurrency === "number" &&
      Number.isFinite(taskMaxConcurrency) &&
      Number.isInteger(taskMaxConcurrency) &&
      taskMaxConcurrency >= 0
        ? taskMaxConcurrency
        : undefined;
    refreshRowRisk(ctx);
    const startableCapacity = workerCapacity(ctx);
    const jobs = ctx.getAsyncJobSnapshot();
    const phases = sdk.getLatestTodoPhasesFromEntries(branch);
    if (presence !== undefined) {
      if (lastPresence === "away" && presence !== "away") queueReturnNotice(phases);
      lastPresence = presence;
    }
    const restored = restoredChildren(persistedChildren, jobs);
    let key = `${staticKey(phases, jobs, deadline, capacity, startableCapacity, goalPaused, restored, persistedChildren)}:${Math.floor(now / 60_000)}:${presence ?? ""}`;
    // External processes can settle without changing TODOs or the async-job snapshot.
    const hasExternalOwner = phases.some((phase) => phase.tasks.some((task) => parseExternalWait(task.schedule?.owner) !== null));
    if (!hasExternalOwner && !forceRefresh && pending.length === 0 && cachedDecision?.key === key) {
      if (refreshSnapshot) writeCurrentPlanSnapshot(ctx, cachedDecision.decision, now, phases);
      return cachedDecision.decision;
    }
    const decisionInput = {
      risk,
      phases,
      archivedPhases: dispatchTodoArchive(ctx),
      history: getTodoPlanCalibrationStore().snapshot(now),
      jobs,
      externalOwnerProbe: options.externalOwnerProbe,
      persistedChildren,
      restoredChildren: restored,
      isMainSession: header !== null && !header.parentSession,
      capacity,
      startableCapacity: liveWorkerModelCheckedAt === 0 ? undefined : startableCapacity,
      taskEnabled: pi.getActiveTools().includes("task") && startableCapacity > 0,
      now,
      deadline,
      goalPaused,
      presence,
      dispatchGateAvailable: nativeGateRegistered,
      lastWakeKey,
      cachedStatic,
      idleResumeAttempts,
    };
    let decision = decideTodoDispatch(decisionInput, sdk);
    if (header !== null && !header.parentSession && typeof pi.appendEntry === "function") {
      const planKey = JSON.stringify(
        phases.map(phase => [
          phase.name,
          phase.tasks.map(task => [task.content, task.schedule?.dependencies ?? [], task.schedule?.estimate ?? null]),
        ]),
      );
      const autoState = autoGoalDeadlineState({
        current: deadlineState,
        planKey,
        membershipFingerprint: decision.forecast?.membershipFingerprint,
        predictionVersion: decision.forecast?.predictionVersion,
        openRows: phases.flatMap(phase => phase.tasks).filter(task => task.status !== "completed" && task.status !== "abandoned").map(task => task.content),
        forecastFinish:
          decision.forecast?.unresolvedCount === 0
            ? decision.forecast.autoDeadlineForecast?.finish
            : undefined,
        now,
        hasRealGoal: Boolean(realGoal && (realGoal.status === "active" || realGoal.status === "paused")),
        hasRealDeadline: Boolean(deadline && deadlineState?.auto !== true),
      });
      if (autoState) {
        pi.appendEntry(GOAL_DEADLINE_STATE_ENTRY, autoState);
        deadline =
          autoState.active && autoState.baselineDeadlineAt !== undefined
            ? {
                goalId: autoState.goalId,
                deadlineAt: autoState.baselineDeadlineAt * 1_000,
                timezone: autoState.timezone,
              }
            : undefined;
        key = `${staticKey(phases, jobs, deadline, capacity, startableCapacity, goalPaused, restored, persistedChildren)}:${Math.floor(now / 60_000)}:${presence ?? ""}`;
        decision = decideTodoDispatch({ ...decisionInput, deadline }, sdk);
      }
      if (deadlineState?.auto === true && deadlineState.baselineDeadlineAt !== undefined && now >= deadlineState.baselineDeadlineAt * 1_000) {
        pendingAutoForecastMissAt ??= deadlineState.baselineDeadlineAt * 1_000;
        decision.autoForecastDeadlineMissed = true;
        decision.autoForecastMissedByMinutes = Math.floor((now - deadlineState.baselineDeadlineAt * 1_000) / 60_000);
      }
    }
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
  let forecastMissActive = false;
  let forecastMissCount = 0;
  let forecastReplanBaseline: Map<string, string> | null = null;
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
  // The plan-check is delivered once per distinct problem list. It is delivered again only when something
  // changed since: a new user message, a worker result, or a row/status change. An unchanged list used to
  // re-wake the idle lead every 30 minutes (live datacenter 01a1921c 2026-10-31 15:58-19:02Z: ten identical
  // "user accepted …; NEXT ACTION: fast merge/publish …" wakes, each answered with "nothing changed").
  let userMessageEpoch = 0;
  // User-absent wake: the plan-check dedup above stops a replay of the same list, but an idle lead whose
  // user went quiet still needs a nudge that says they may not return. One wake per ABSENCE_AFTER_MS of silence; a turn that made no
  // progress gets one final wrap-up wake, then silence until a user message or a worker result.
  const ABSENCE_AFTER_MS = 30 * 60_000;
  const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "search", "web_search", "fetch", "lsp", "ls", "glob", "wait", "ask"]);
  const absence = { startedAt: Date.now(), lastWakeAt: 0, stage: 0 as 0 | 1 | 2, progressMark: 0, jobStamp: "" };
  let progressEvents = 0;
  let lastPlanEventStamp = "";
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
    const dir = join(TODO_DISPATCH_STATE_DIR, "plan");
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
      `Deadline forecast: ${sdk.formatPlanForecast(decision.forecast, now)}`,
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
  const replanInstruction = (ctx: ExtensionContext, open: TodoTaskForecast[], capacity: number) =>
    prompt.render(waitingWorkInstructions, { capacity, waitingRows: criticalWaitList(ctx, open) }).trim();
  const READ_ONLY_BASH = /^(?:grep|rg|ls|cat|head|tail|wc|pwd|echo|stat|test|\[|sha256sum|sha1sum|md5sum|readlink|realpath|file|cut|uniq|tr|nl|jq|cmp|basename|dirname|date|du|df|free|getconf|uptime|ps|pgrep|ss)$/;
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
      const value = method[1] ? { value: method[1], dynamic: word.dynamic } : args[++i];
      if (!value || value.dynamic || value.value.toUpperCase() !== "GET") return false;
    }
    return true;
  };
  // tasks-loop `bin/agent-cli` lookups (AGENTS.md mandates it for orientation). Verified in tools/agent_cli.py:
  // these subcommands only read (doc/usage keep an mtime cache under ~/.cache). `orient` runs
  // `tasks_loop_git_sync.py status --json` without --fetch, so it reads too. `sync`, `crumb` (appends
  // breadcrumbs and git-syncs) and `ship` (finish-agent-change commits) stay worker work, and the flags
  // that fetch or refresh evidence (`--fetch`, `--refresh`) are refused.
  const AGENT_CLI_LOOKS = /^(?:orient|git|id|doc|mem|port|session|pr|usage|logs|job|svc|model|stack|tool|read)$/;
  const readOnlyAgentCli = (words: Array<{ value: string; dynamic: boolean }>) => {
    const flag = /^--?(?:json|help|h)$/;
    const rest = words.slice(1);
    if (rest.length > 0 && rest.every((word) => flag.test(word.value))) return true;
    const sub = rest[0] && words[1].value === "--json" ? rest[1] : rest[0];
    if (!sub || sub.dynamic || !AGENT_CLI_LOOKS.test(sub.value)) return false;
    return !rest.some((word) => /^--(?:fetch|refresh)(?:=|$)/.test(word.value) || (sub.value === "model" && word.dynamic));
  };
  // Delivery commands are allowed for the chief only as a command or an &&-only chain.
  // Inspect shell structure without executing it. Unknown syntax fails closed; substitutions
  // use the same command checks, including inside double quotes and loop headers.
  const isChiefBash = (command: string) => {
    // Trusted repository helper contract only: readback performs a GET. It also
    // sources bitbucket.local.env, so this staffing exemption is not a sandbox
    // for untrusted repositories or env files. Do not admit general bash scripts.
    // Match the entire raw command before parsing: no wrappers, expansions,
    // redirects, separators, extra arguments, or interpreter options are allowed.
    if (!command.includes("\n") && /^bash[ \t]+\.agents\/skills\/bitbucket-prs\/scripts\/bb-pr\.sh[ \t]+readback[ \t]+[1-9][0-9]*$/.test(command)) return true;
    type Token = { value: string; plain: boolean; dynamic: boolean; newline?: boolean; assignment?: boolean };
    const separators: Record<string, true> = { ";": true, "&&": true, "||": true, "|": true };
    const reserved: Record<string, true> = { for: true, while: true, until: true, if: true, do: true, done: true, then: true, else: true, elif: true, fi: true };
    let cursor = 0;
    const check = (tokens: Token[], deliveryOnly = false): boolean => {
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
        if (deliveryOnly) {
          if (piped || words.some((word) => word.dynamic)) return false;
          if (words[0].value === "git") {
            let subcommand = 1;
            for (;;) {
              if (["-C", "-c"].includes(words[subcommand]?.value ?? "")) { subcommand += 2; continue; }
              if (/^--(?:no-pager|git-dir=|work-tree=)/.test(words[subcommand]?.value ?? "")) { subcommand += 1; continue; }
              break;
            }
            if (["add", "commit", "push", "fetch", "rebase", "merge"].includes(words[subcommand]?.value ?? "")) return true;
          }
          if (words[0].value === "gh") {
            const [, sub, verb, ...args] = words;
            if (sub?.value === "pr" && ["create", "edit", "view", "ready", "comment", "checks"].includes(verb?.value ?? "")) return true;
            if (sub?.value === "api" && args.some((word) => /^repos\/[^/]+\/[^/]+\/pulls\/\d+(?:\/|$)/.test(word.value))) return true;
          }
        }
        // `cat`, `head`, `tail` and `wc` are looks only as a pipe sink: flags and numbers, never files.
        if (piped && ["cat", "head", "tail", "wc"].includes(words[0].value) && words.slice(1).some((word) => word.dynamic || !/^(?:-\S*|\d+)$/.test(word.value))) return false;
        // `cd <dir>` anywhere in a chain is navigation: the commands around it are classified on their own,
        // so `cd x && git status; cd y && git log` passes and `cd x && make` still fails closed.
        if (words[0].value === "cd") return words.length === 2 && !words[1].dynamic && !words[1].value.startsWith("-");
        if (words[0].value === "gh") return readOnlyGh(words);
        if (/^(?:.*\/)?bin\/agent-cli$/.test(words[0].value)) return readOnlyAgentCli(words);
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
          if (!separator.plain || !Object.hasOwn(separators, separator.value) || (deliveryOnly && separator.value !== "&&")) return false;
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
        // Redirects that write nothing: fd duplication (`2>&1`, `>&2`) and discard to /dev/null
        // (`>/dev/null`, `2>/dev/null`, `&>/dev/null`). They are dropped, never an argument.
        // Every other `>`, `>>` or `&>` stays outside this grammar and fails closed.
        const quiet = /^(?:\d*>&\d+|(?:\d*|&)>[ \t]*\/dev\/null)(?=[\s;|&)`]|$)/.exec(command.slice(cursor));
        if (quiet) { cursor += quiet[0].length; continue; }
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
    return tokens !== null && (check(tokens, true) || check(tokens));
  };
  const WRITE_EXEMPT_PATH = /^(agent|xd|proc|history|artifact):\/\//;
  let chiefRefusals = 0;
  const MAX_CHIEF_REFUSALS = 3;
  const isMain = (ctx: ExtensionContext) => {
    const header = ctx.sessionManager.getHeader();
    return header !== null && !header.parentSession;
  };
  // An after-deadline set exists only for its deadline. Once that deadline is inactive or removed,
  // every postDeadline flag is cleared so the rows return to the normal queue, with one visible note.
  const releaseLapsedPostDeadline = (ctx: ExtensionContext): string[] => {
    if (!isMain(ctx) || typeof ctx.updateTodoSchedule !== "function") return [];
    const rows = todoPhases(ctx).flatMap((phase) => phase.tasks)
      .filter((row) => (row.schedule as { postDeadline?: unknown } | undefined)?.postDeadline === true)
      .map((row) => String(row.content));
    if (!rows.length) return [];
    if (sdk.readGoalDeadline(dispatchStateEntries(ctx), ctx.cwd, { includePaused: true })) return [];
    const released = rows.filter((row) => ctx.updateTodoSchedule!(row, { postDeadline: false }));
    if (released.length && typeof pi.sendMessage === "function") {
      pi.sendMessage(
        {
          customType: POST_DEADLINE_RELEASED_CUSTOM_TYPE,
          content: `Deadline no longer active: ${released.length} after-deadline row(s) returned to the normal queue: ${released.map((row) => JSON.stringify(row)).join(", ")}.`,
          display: true,
          attribution: "agent",
          details: { rows: released, at: Date.now() },
        },
        { deliverAs: "nextTurn", triggerTurn: false, interruptWait: false },
      );
    }
    return released;
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
    ? `Split remainder of ${actionTarget(item.row, 42)}; preserve ${shorten(item.owner, 24)}.`
    : `Kill ${shorten(item.owner, 48)} or get its new receipt before wait.`;
  const recoveryNotice = (item: RecoveryWait) => prompt.render(gateNoticeInstructions, {
    recovery: true, action: recoveryAction(item), owner: item.owner, recoveryCap: item.kind === "cap",
  }).trim();
  const activeRecoveries = (ctx: ExtensionContext, pending: unknown[] = []) => {
    const jobs = ctx.getAsyncJobSnapshot();
    const previous = sprintState.recoveryWaits ?? [];
    const kept = previous.flatMap((item): RecoveryWait[] => {
      const matches = (job: Jobs["running"][number]) => job.type === "task" && (job.id === item.owner || job.agentId === item.owner);
      const running = jobs?.running.some(job => matches(job) && job.status === "running");
      const killed = item.killed || jobs?.recent.some(job => matches(job) && job.status === "cancelled" && (job.endTime ?? 0) > item.at);
      if (item.kind === "cap") return [];
      // A stuck escalation targets a live attempt. Once that worker is gone from the job table
      // (finished before a restart, reaped), no kill or receipt can ever satisfy it.
      if (!running && (killed || jobs)) return [];
      const received = item.received || jobs?.recent.some(job => matches(job) && (job.status === "completed" || job.status === "failed") && (job.endTime ?? 0) > item.at)
        || (workerTrace(ctx, item.owner).receiptAt ?? 0) > item.at;
      // Retain the acknowledged escalation for this attempt so the next tick cannot rearm it.
      if (received) return running ? [{ ...item, received: true }] : [];
      return [{ ...item, ...(killed ? { killed: true } : {}) }];
    });
    if (JSON.stringify(kept) !== JSON.stringify(previous)) {
      sprintState = { ...sprintState, recoveryWaits: kept };
      persistSprintState();
    }
    return kept.filter(item => !item.received);
  };
  const leadDisplayContext = (ctx, phases, decision) => {
    const jobs = ctx.getAsyncJobSnapshot();
    const rowWorkers = liveTaskWorkers(jobs);
    const rowOwners = new Map(phases.flatMap(phase => phase.tasks).flatMap(row => {
      const worker = liveTaskWorker(row, rowWorkers);
      return worker ? [[row.content, worker]] : [];
    }));
    return {
      workers: rowWorkers, owners: rowOwners,
      ...readTodoDisplayLedger(["requirements_ledger", "requirements_auditor_assignments"].flatMap(customType => {
        const entry = selectLatestBranchEntry(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === customType);
        return entry ? [entry] : [];
      }), new Set(rowWorkers.map(worker => worker.id))),
      capacityFull: decision.capacity > 0 && decision.activeTaskCount >= decision.capacity,
    };
  };
  const staffingRows = (phases, displayContext) => phases.flatMap(phase => phase.tasks).filter(task => isOpenRowStatus(task.status)).flatMap(task => {
    const state = classifyTodoDisplayRow(task, phases, displayContext);
    return state.state === "needs worker" ? [{ content: task.content, owner: task.schedule?.owner, previous: state.previous, reason: state.reason, findings: todoRowAfterWorker(task)?.findings }] : [];
  });
  const staffingData = rows => ({
    staffing: true, rows: rows.map(row => JSON.stringify(row.content)).join(", ").slice(0, 140),
    previous: rows.map(row => row.previous).filter(Boolean).join(", ").slice(0, 60),
    continuations: rows.filter(row => row.previous).map(row =>
      `${JSON.stringify(row.content)} from agent://${row.previous} (${row.reason}${row.findings ? `: ${shorten(row.findings)}` : ""})`).join("; "),
  });
  const announceGates = (ctx: ExtensionContext, pending: unknown[] = [], now = Date.now(), measured?: DispatchDecision) => {
    if (singleWriterLane || !isMain(ctx) || typeof pi.sendMessage !== "function" || typeof pi.appendEntry !== "function") return;
    const phases = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx, pending));
    const notice = (kind: string, key: string, data: Record<string, unknown>, interruptWait = false, subject?: string) => {
      const type = `todo-gate-${kind}`;
      const content = prompt.render(gateNoticeInstructions, data).trim();
      if (sprintState.lastNotices[noticeKey(type, key)] === noticeDigest(content)) return;
      sendHarnessNotice(type, key, content, undefined, content, { interruptWait, supersedes: subject === undefined ? type : noticeKey(type, subject) });
    };
    if (pauseGate?.paused || gateSwitchedOff(ctx)) return;
    const decision = measured ?? currentDecision(ctx, now, pending);
    const displayContext = leadDisplayContext(ctx, phases, decision);
    const refusals = assignedResourceRefusals(phases, ctx);
    const rows = staffingRows(phases, displayContext).filter(row => !refusals.has(row.content));
    if (rows.length) notice("staffing", JSON.stringify(rows.map(row => [row.content, row.owner, row.previous ?? null])), staffingData(rows));
    const tasks = [...new Set(getTodoPlanningIssues(phases).map(issue => issue.task))];
    if (tasks.length) notice("schedule", JSON.stringify(tasks), { schedule: true, rows: tasks.map(task => JSON.stringify(task)).join(", "), tasks });
    for (const item of activeRecoveries(ctx, pending)) notice("recovery", JSON.stringify([item.kind, item.row, item.owner, item.at]), {
      recovery: true, action: recoveryAction(item), owner: item.owner, recoveryCap: item.kind === "cap",
    }, true, JSON.stringify([item.kind, item.row]));
    // Delivered rows the runtime audit could not verify go to the lead with the missing piece.
    const unverified = phases.flatMap((phase) => phase.tasks).flatMap((task) => {
      const after = todoRowAfterWorker(task);
      if (task.schedule?.auditEscalation) return [`${JSON.stringify(task.content)} (ask the user to decide unresolved blockers after two repair rounds: ${shorten(task.schedule.auditEscalation)})`];
      const audit = after?.kind === "verify" ? after.audit : undefined;
      if (audit?.verdict === "unavailable") return [`${JSON.stringify(task.content)} (auditor unavailable: ${shorten(audit.findings ?? "")})`];
      if (audit?.verdict === "inconclusive" && (audit.attempts ?? 1) >= 2) return [`${JSON.stringify(task.content)} (inconclusive: ${shorten(audit.findings ?? "")})`];
      return [];
    });
    if (unverified.length) notice("audit", JSON.stringify(unverified), { audit: true, rows: unverified.join("; ") });
    if (decision.presence === "away" && !rows.length && decision.awayWorkList?.length) notice("away", decision.key, {
      away: true, rows: decision.awayWorkList.join(" "),
    });
    for (const row of decision.forecast?.rows ?? []) {
      const task = phases.flatMap(phase => phase.tasks).find(task => task.content === row.content);
      if (!isOpenRowStatus(row.status) || !row.owner || !task || classifyTodoDisplayRow(task, phases, displayContext).state !== "working") continue;
      const key = `${row.content}:${row.owner}:${row.estimateRevision}`;
      const data = { row: JSON.stringify(row.content), owner: row.owner };
      if (row.reestimateCount >= 2) notice("cap", key, { ...data, cap: true }, false, row.content);
      const start = row.estimateUpdatedAt ?? row.startedAt;
      const finish = row.resourceFinish;
      if (row.reestimateCount < 2 && row.status === "in_progress" && start !== undefined && finish !== undefined && finish > start && now >= finish)
        notice("eta", key, { ...data, eta: true }, false, row.content);
    }

  };
  let inFlightAssistantHasText = false;
  const refusedChatChoices = new Set<string>();
  pi.on("message_start", (event, ctx) => {
    inFlightAssistantHasText = false;
    if (event.message?.role === "user") { wakeTurn = undefined; wakeHasEvent = true; }
    if (event.message?.role === "custom" && typeof event.message.details?.silentAssistant !== "boolean" && !isHarnessNotice(event.message)) { wakeTurn = undefined; wakeHasEvent = true; }
    if (event.message?.role === "assistant") rescheduledRowsThisTurn.clear();
    const user = latestDeadlineUserMessage([{ type: "message", message: event.message }]);
    if (user) announceHuman(ctx, user);
    if (!isMain(ctx) || event.message?.role !== "user") return;
    if (user) resetIdleContinuationDemand();
    latestUserRequestAt = Date.now();
    userMessageEpoch += 1;
    absence.stage = 0;
    absence.lastWakeAt = 0;
  });
  const resetIdleContinuationDemand = () => {
    if (sprintState.idleContinuationDemands === 0 && sprintState.idleContinuationKey === undefined) return;
    sprintState = { ...sprintState, idleContinuationDemands: 0, idleContinuationKey: undefined };
    persistSprintState();
  };
  const runningOwnerNames = (ctx: ExtensionContext): Set<string> => new Set((ctx.getAsyncJobSnapshot()?.running ?? [])
    .flatMap((job) => [job.id, job.agentId, job.label].filter((name): name is string => typeof name === "string")));
  let zeroActiveCalls = 0;
  const zeroActiveNag = (ctx: ExtensionContext): string | undefined => {
    if (singleWriterLane || !isMain(ctx) || gateSwitchedOff(ctx) || pauseGate?.paused || !pi.getActiveTools().includes("task")) return;
    const jobs = ctx.getAsyncJobSnapshot();
    if (!jobs || jobs.nonJobAgents?.some(agent => agent.live) || jobs.running.some(job => job.status === "running" && !job.queued && job.type === "task")) {
      zeroActiveCalls = 0;
      // A real worker transition rearms a later idle warning even if the plan
      // did not change. Do not rearm on an unavailable snapshot.
      if (jobs && sprintState.idleContinuationKey?.startsWith('["zero-active",')) resetIdleContinuationDemand();
      return;
    }
    const phases = withoutSupersededAudits(sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx)));
    const display = leadDisplayContext(ctx, phases, { capacity: 0, activeTaskCount: 0 });
    const rows = phases.flatMap(phase => phase.tasks).filter(row => {
      const state = classifyTodoDisplayRow(row, phases, display).state;
      return isOpenRowStatus(row.status) && state === "needs worker";
    });
    if (!rows.length) {
      zeroActiveCalls = 0;
      return;
    }
    const refusals = assignedResourceRefusals(phases, ctx);
    const conflicts = rows.flatMap(row => refusals.has(row.content) ? [{row: row.content, reason: refusals.get(row.content)}] : []);
    return prompt.render(zeroActiveInstructions, { count: rows.length, conflicts,
      rows: rows.map(row => row.content.replace(/\s+/g, " ")).join("; ").slice(0, 185),
    }).trim();
  };
  const isStaffingCall = (name: string, input: { op?: string } | undefined) =>
    name === "task" || name === "ask" || (name === "todo" && ![undefined, "view", "history"].includes(input?.op));
  const demandIdlePlanContinuation = (ctx: ExtensionContext, advance = true): string | undefined => {
    if (singleWriterLane || !isMain(ctx) || gateSwitchedOff(ctx) || pauseGate?.paused) return;
    const nag = zeroActiveNag(ctx);
    if (nag) {
      if (!advance) return nag;
      // Match the ordinary idle continuation's state-based rearming. A warning
      // is not new work: waking again on it creates an endless staffing loop.
      const phases = withoutSupersededAudits(sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx)));
      const idleKey = JSON.stringify(["zero-active", phases.map(phase => phase.tasks.map(task => [task.content, task.status, task.blocker, task.schedule]))]);
      if (sprintState.idleContinuationKey === idleKey && sprintState.idleContinuationDemands > 0) return;
      if (!idlePlanDemandedThisTurn) {
        idlePlanDemandedThisTurn = true;
        sprintState = { ...sprintState, idleContinuationKey: idleKey, idleContinuationDemands: 1 };
        persistSprintState();
        pi.sendMessage({ customType: "todo-idle-plan-demand", content: nag, display: false,
          attribution: "agent", details: { silentAssistant: false } },
          { deliverAs: "nextTurn", triggerTurn: true, interruptWait: false });
      }
      return;
    }
    const now = Date.now();
    const decision = currentDecision(ctx, now, [], true, true);
    if (!decision.forecast || !decision.staffingSnapshotComplete) return;
    const phases = withoutSupersededAudits(sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx)));
    const tasks = phases.flatMap((phase) => phase.tasks);
    const userWaits = new Set((decision.userWaits ?? []).map((row) => row.content));
    const runningRows = new Set([...(decision.ownerRunStates ?? []).filter((row) => row.running).map((row) => row.content), ...(decision.verifyingRows ?? [])]);
    const tasksByContent = new Map(tasks.map((task) => [task.content, task] as const));
    const waitsOnProgress = (content: string, visiting = new Set<string>()): boolean => {
      if (visiting.has(content)) return false;
      const task = tasksByContent.get(content);
      if (!task) return false;
      const next = new Set(visiting).add(content);
      return (task.schedule?.dependencies ?? []).some((dependency) => {
        if (userWaits.has(dependency) || runningRows.has(dependency)) return true;
        const prerequisite = tasksByContent.get(dependency);
        return prerequisite !== undefined && isNonClosedRowStatus(prerequisite.status) && waitsOnProgress(dependency, next);
      });
    };
    const openRows = tasks.filter((task) => isNonClosedRowStatus(task.status) && !userWaits.has(task.content));
    const uncoveredRows = openRows.filter((task) => !runningRows.has(task.content) && !waitsOnProgress(task.content));
    if (uncoveredRows.length === 0) {
      resetIdleContinuationDemand();
      return;
    }
    // Only a changed plan or ownership can rearm an idle demand. Tool calls such
    // as wait, read and view do not by themselves change the work state.
    const idleKey = JSON.stringify([tasks.map(task => [task.content, task.status, task.blocker, task.schedule]), [...runningRows].sort()]);
    if (sprintState.idleContinuationKey !== idleKey) {
      sprintState = { ...sprintState, idleContinuationKey: idleKey, idleContinuationDemands: 0 };
      persistSprintState();
    }
    const uncovered = new Set(uncoveredRows.map((row) => row.content));
    const overdueRows = decision.forecast.rows.filter((row) => row.overdue && row.ready && uncovered.has(row.content) && isOpenRowStatus(row.status)).map((row) => row.content);
    const forecastReady = decision.forecast.rows.filter((row) => row.ready && uncovered.has(row.content)).map((row) => row.content);
    // A row blocked only on the lead's own push/close/hand-off is ready work, not a block.
    const owners = runningOwnerNames(ctx);
    const leadActionRows = uncoveredRows.filter((row) => row.status === "blocked" && leadActionPending(row, owners)).map((row) => row.content);
    const readyRows = [...new Set([...forecastReady, ...leadActionRows])];
    const rowList = (rows: string[]) => rows.length ? rows.slice(0, MAX_ROWS).map((row) => JSON.stringify(shorten(row))).join(", ") : "none";
    const openList = rowList(uncoveredRows.map((row) => row.content));
    if (readyRows.length === 0 && overdueRows.length === 0) {
      if (!advance || idlePlanDemandedThisTurn || sprintState.idleContinuationDemands !== 0) return;
      const blockers = uncoveredRows.filter(row => row.status === "blocked")
        .map(row => `${JSON.stringify(shorten(row.content))}: ${shorten(row.blocker ?? "reason not recorded")}`);
      idlePlanDemandedThisTurn = true;
      sprintState = { ...sprintState, idleContinuationDemands: 3 };
      persistSprintState();
      pi.sendMessage({
        customType: "todo-idle-plan-demand",
        details: prepareWake(ctx),
        content: `No work is currently ready. Recheck the open blockers and dependencies once, continue any independently actionable work, and otherwise wait for the relevant change without repeating status. Open: ${openList}. Blockers: ${blockers.length ? blockers.join("; ") : "none recorded"}.`,
        display: false,
        attribution: "agent",
      }, { deliverAs: "nextTurn", triggerTurn: true, interruptWait: false });
      return;
    }
    const demand = `REQUIRED PLAN CONTINUATION: open rows have no running worker and are not waiting on the user or a live worker. Overdue: ${rowList(overdueRows)}. Ready: ${rowList(readyRows)}. Open: ${openList}. Re-estimate each overdue row from current evidence, staff every ready row, resolve any other blocker, and keep going until the deliverable is complete or only user-blocked rows/live workers remain.`;
    const count = sprintState.idleContinuationDemands;
    const refusal = prompt.render(gateNoticeInstructions, { idleAction: true, readyRows: rowList(readyRows) }).trim();
    if (!advance) return count >= 2 ? refusal : undefined;
    if (count >= 3) return refusal;
    if (idlePlanDemandedThisTurn) return;
    idlePlanDemandedThisTurn = true;
    if (count === 2) {
      sprintState = { ...sprintState, idleContinuationDemands: 3 };
      persistSprintState();
      pi.sendMessage(
        {
          customType: "todo-idle-plan-escalation",
          details: { silentAssistant: true },
          content: `PLAN STATUS: after 3 idle turns, the assistant has not staffed ready work ${rowList(readyRows)} or addressed overdue ready work ${rowList(overdueRows)}. Work remains open.`,
          display: false,
          attribution: "agent",
        },
        { deliverAs: "nextTurn", triggerTurn: false, interruptWait: false },
      );
      return refusal;
    }
    sprintState = { ...sprintState, idleContinuationDemands: count + 1 };
    persistSprintState();
    pi.sendMessage(
      {
        customType: "todo-idle-plan-demand",
        content: demand,
        display: false,
        attribution: "agent",
        details: { ...prepareWake(ctx), overdueRows, readyRows, openRows: uncoveredRows.map((row) => row.content), idleDemand: count + 1 },
      },
      { deliverAs: "nextTurn", triggerTurn: true, interruptWait: false },
    );
  };
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
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    inFlightAssistantHasText = text.length > 0;
  });
  const chatChoiceReason = async (ctx: ExtensionContext) => {
    await pollReviewAnswers(ctx, true);
    if (singleWriterLane || !isMain(ctx)) return;
    return idleUserReviewRefusal(
      todoPhases(ctx),
      ctx.getAsyncJobSnapshot(),
      refusedChatChoices,
      options.reviewPageProbe,
    );
  };
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    inFlightAssistantHasText = event.message.content.some(part => part.type === "text" && part.text.trim()) &&
      event.message.content.some(part => part.type === "toolCall" && part.name === "wait");
  });
  // An unplanned, single delegated read can finish before the lead replies. A newer
  // human input ends this exemption; it must not hide a correction behind an old job.
  const waitingForSingleRead = (ctx: ExtensionContext): boolean => {
    if (sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never).some(phase => phase.tasks.some(row => isNonClosedRowStatus(row.status)))) return false;
    const jobs = (ctx.getAsyncJobSnapshot()?.running ?? []).filter(job => job.type === "task" && job.status === "running");
    if (jobs.length !== 1) return false;
    const tasks: Record<string, unknown>[] = [];
    for (const entry of selectBranchNewestFirst(ctx.sessionManager, metadata =>
      metadata.type === "message" && (metadata.messageRole === "user" || metadata.messageRole === "assistant"),
    )) {
      if (entry.message.role === "user" && latestDeadlineUserMessage([entry])) break;
      if (entry.message.role !== "assistant") continue;
      for (const part of entry.message.content) {
        if (part.type === "toolCall" && part.name === "task") tasks.push(...taskItems(part.arguments));
      }
    }
    if (tasks.length !== 1) return false;
    const scope = tasks[0].scope as { paths?: unknown } | undefined;
    return Array.isArray(scope?.paths) && scope.paths.length === 0 &&
      [jobs[0].id, jobs[0].agentId, jobs[0].label].includes(String(tasks[0].name));
  };
  pi.on("before_agent_start", (event, ctx) => {
    if (singleWriterLane || !isMain(ctx) || sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never).some(phase => phase.tasks.length)) return;
    return { systemPrompt: [...event.systemPrompt, oneShotInstructions] };
  });
  const unansweredUserReasonWithDraft = (ctx: ExtensionContext) => {
    if (!inFlightAssistantHasText) return unansweredUserReason(ctx);
    const reason = unansweredUserReason(ctx);
    if (!reason) return;
    // The streamed assistant message carrying this wait call has not reached
    // canonical history yet, but its visible text already answers the user.
    return undefined;
  };
  const previewIdleNotified = new Set<string>();
  const redRowsIdleReason = async (ctx: ExtensionContext, action: "wait" | "stop" = "wait") => {
    if (singleWriterLane || !isMain(ctx) || pauseGate?.paused) return;
    const visibility = await pollPreview(ctx);
    const config = previewConfig(ctx);
    const now = Date.now();
    const decision = currentDecision(ctx, now, [], false, true);
    const jobs = ctx.getAsyncJobSnapshot()?.running ?? [];
    const activity = workerActivity(ctx, jobs, now);
    const tasks = new Map(todoPhases(ctx).flatMap(phase => phase.tasks).map(task => [task.content, task]));
    decision.ownerRunStates = decision.ownerRunStates?.map(row => {
      const job = jobs.find(job => liveJobMatchesOwner(job, row.owner ?? "") ||
        liveJobMatchesOwner(job, tasks.get(row.content)?.schedule?.executor?.workerId ?? ""));
      const worker = job && activity.find(worker => worker.name === (job.agentId ?? job.id));
      return { ...row, progressing: row.running && worker?.lastAt !== undefined && worker.ageMs < SILENT_MS };
    });
    return idleRedRowsRefusal(
      decision,
      overduePreviewRows(todoPhases(ctx), visibility, { ...config, thresholdMinutes: Math.min(15, config.thresholdMinutes) }, Date.now()),
      previewIdleNotified,
      action,
      content => pi.sendMessage({ customType: "todo-overdue-status", content, display: true, attribution: "agent" },
        { deliverAs: "nextTurn", triggerTurn: false, interruptWait: false }),
      new Set((decision.verifyingRows ?? []).filter(content => {
        const auditor = tasks.get(content)?.schedule?.audit?.workerId;
        return auditor && jobs.some(job => job.status === "running" && liveJobMatchesOwner(job, auditor));
      })),
    );
  };
  pi.on("session_stop", async (_event, ctx) => {
    if (gateSwitchedOff(ctx)) return;
    if (zeroActiveNag(ctx)) demandIdlePlanContinuation(ctx);
    const redReason = await redRowsIdleReason(ctx, "stop");
    if (redReason) return { decision: "block", reason: redReason };
    const reason = unansweredUserReason(ctx);
    if (reason) return { decision: "block", reason };
    const choiceReason = await chatChoiceReason(ctx);
    if (choiceReason) return { decision: "block", reason: choiceReason };
    const idleReason = demandIdlePlanContinuation(ctx);
    if (idleReason) return { decision: "block", reason: idleReason };
  });
  // The full chief-of-staff runbook (main) or a worker's original brief (subagent) can drop out of
  // context at compaction when the summary replaces the retained prefix. Conditionally re-persist it
  // once, right after a compaction that drops it, as a custom message entry that joins LLM context
  // without starting a turn (sendMessage deliverAs "nextTurn", no triggerTurn: appends to session history, no turn).
  // The canonical post-compaction model context (buildSessionContext) decides: when the newest copy still
  // survives, append nothing so the journal stays append-only without duplicates. The per-request
  // Time notes retain only a runbook pointer; this entry carries the
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
          { deliverAs: "steer", triggerTurn: false, interruptWait: false, supersedes: CHIEF_RULES_ENTRY_TYPE },
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
      ((toolName === "edit" || toolName === "write") && !(path !== undefined && (WRITE_EXEMPT_PATH.test(path) || (toolName === "write" && path.startsWith("out://"))))) ||
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
    // An unrelated blocked/completed plan must not let the chief implement a new
    // request without first adding its row (01a1921c, "single file under 30 lines").
    const jobsBeforePlanning = ctx.getAsyncJobSnapshot();
    const runningBeforePlanning = (jobsBeforePlanning?.running ?? []).filter((job) => job.type === "task" && job.status === "running").length;
    const hasWorkRow = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx))
      .some((phase) => phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"));
    if (jobsBeforePlanning && !hasWorkRow && runningBeforePlanning < workerCapacity(ctx)) {
      return {
        block: true,
        reason: `Add and schedule the new work, then dispatch it via task before ${event.toolName}.\nBlocked: ${event.toolName} is work for a worker, including small single-file edits. No pending or in-progress row covers this work. Read-only inspection and delivery remain available. ${ORDER}`,
      };
    }
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
      reason: `Staff ${actionTarget(decision.dispatchableReady[0].content)} via task before ${event.toolName}.\nBlocked: ${event.toolName} is work for a worker. Start one with a task call for: ${ready.join(", ")}. If a row only waits on a unit or job, set its owner to unit:<name> or job:<pid>. Reading (read, grep, find, git status/log/show/diff) stays allowed; the lead may run delivery commands itself: git add/commit/push/fetch/rebase/merge and gh pr create/edit/view/ready/comment/checks or gh api for its PR. ${ORDER}`,
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
    if (reason === lastGateReason && reason !== "speculative-review-checked") return;
    lastGateReason = reason;
    try {
      const dir = TODO_DISPATCH_STATE_DIR;
      mkdirSync(dir, { recursive: true });
      const session = ctx.sessionManager?.getHeader?.()?.id ?? "unknown";
      appendFileSync(join(dir, `${session}.gate.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, reason, ...detail })}\n`);
    } catch {}
  };
  const replanRequirement = (ctx: ExtensionContext, decision: ReturnType<typeof currentDecision>, now: number) => {
    const deadlineState = rehydrateDeadlineState(latestDeadlineStateEntries(ctx));
    if (isUserDeadlineMissed(deadlineState, now / 1_000)) return;
    if (pendingAutoForecastMissAt !== null && deadlineState?.auto !== true) {
      // A user-supplied deadline replaces the automatic anchor. Its old miss
      // cannot describe the new constraint; current row/plan debt is checked below.
      pendingAutoForecastMissAt = null;
      forecastMissActive = false;
      forecastReplanBaseline = null;
    }
    if (!decision.key || !decision.forecast) return gateTrace(ctx, "no-plan");
    if (!decision.staffingSnapshotComplete) return gateTrace(ctx, "staffing-snapshot-incomplete");
    if (decision.goalPaused) return gateTrace(ctx, "goal-paused");
    if (!pi.getActiveTools().includes("todo")) return gateTrace(ctx, "todo-tool-inactive");
    const open = (decision.forecast.rows ?? []).filter((row) => isOpenRowStatus(row.status) || undeliveredUserWait(row));
    const unresolved = unresolvedForecastRows(decision.forecast);
    const overdueRows = open.filter((row) => row.overdue || decision.alarms?.some((alarm) => alarm.startsWith(`missed-eta:${JSON.stringify(row.content)}:`)));
    const planFinish = decision.forecast.autoDeadlineForecast?.finish;
    const forecastPassed = open.length > 0 && planFinish !== undefined && planFinish <= now;
    const deadline = decision.deadline ?? sdk.readGoalDeadline(dispatchStateEntries(ctx), ctx.cwd, { includePaused: true });
    const deadlineAt = deadline?.deadlineAt ?? decision.forecast.deadlineAt;
    const overDeadline = open.length > 0 && deadlineAt !== undefined && now < deadlineAt && (
      (planFinish !== undefined && planFinish > deadlineAt) || decision.forecast.deadlineStatus === "will-miss"
    );
    const estimateSignature = (row: TodoTaskForecast) => `${row.estimateRevision}:${row.estimateUpdatedAt ?? ""}:${JSON.stringify(row.estimateRangeSeconds ?? null)}`;
    const estimatesRevised = forecastReplanBaseline !== null && open.every((row) =>
      !row.estimateRequired && estimateSignature(row) !== forecastReplanBaseline!.get(row.content),
    );
    const autoDeadlineMissed = !estimatesRevised && (
      pendingAutoForecastMissAt !== null || decision.autoForecastDeadlineMissed === true ||
      (deadline?.goalId === "auto-todo-plan" && deadlineAt !== undefined && now >= deadlineAt)
    );
    // A usable forecast may honestly miss the fixed deadline. Do not force
    // estimate-only turns until its numbers fit; delivery remains executable.
    const currentForecastMiss = unresolved.length > 0 || overdueRows.length > 0 || forecastPassed || autoDeadlineMissed;
    const forecastMiss = currentForecastMiss || (forecastMissActive && !estimatesRevised);
    if (forecastMiss) {
      if (!forecastMissActive) {
        forecastMissCount += 1;
        forecastReplanBaseline = new Map(open.map((row) => [row.content, estimateSignature(row)]));
      } else if (estimatesRevised && (overDeadline || forecastPassed || autoDeadlineMissed)) {
        forecastReplanBaseline = new Map(open.map((row) => [row.content, estimateSignature(row)]));
      }
      forecastMissActive = true;
      const offendingRows = [...new Set([
        ...unresolved.map((row) => row.content),
        ...overdueRows.map((row) => row.content),
        ...(forecastPassed || overDeadline || autoDeadlineMissed ? open.map((row) => row.content) : []),
      ])];
      const riskRows = decision.forecast.risk?.criticalRows.filter(row => row.lastFinishProbability > 0).slice(0, 5);
      const rowList = riskRows?.length
        ? riskRows.map(row => `${JSON.stringify(shorten(row.content))} (${row.workerType}, redo ${Math.round(row.redoRisk * 100)}%, last finish ${Math.round(row.lastFinishProbability * 100)}%)`).join(", ")
        : offendingRows.map((content) => JSON.stringify(shorten(content))).join(", ");
      const tz = deadline?.timezone;
      const deadlineClock = deadlineAt === undefined ? undefined : formatLocalClock(deadlineAt, tz);
      const lateBy = pendingAutoForecastMissAt !== null
        ? Math.floor((now - pendingAutoForecastMissAt) / 60_000)
          : decision.autoForecastMissedByMinutes ?? (planFinish !== undefined && planFinish <= now
            ? Math.max(0, Math.floor((now - planFinish) / 60_000))
            : undefined);
      const reason = overDeadline
        ? prompt.render(riskReplanInstructions, { finish: planFinish === undefined ? "unknown" : formatLocalClock(planFinish, tz), deadline: deadlineClock }).trim()
        : autoDeadlineMissed
          ? `The automatic TODO forecast deadline ${deadlineClock} passed with requested work still open.`
          : forecastPassed
            ? `The current plan forecast passed${lateBy === undefined ? "" : ` ${lateBy}m ago`} with requested work still open.`
            : overdueRows.length > 0
              ? "An open row passed its own ETA. Re-forecast the remaining requested rows."
            : unresolved.length > 0
              ? "Open rows have no usable estimate or await a user answer without delivery, so the finish is unknown."
              : "The previous replan did not give every remaining open row a new estimate.";
      const demandId = `todo-forecast-replan:${decision.key}:${forecastMissCount}`;
      gateTrace(ctx, "forecast-replan-demand", { rows: offendingRows, unresolved: unresolved.length, overdue: overdueRows.length, overDeadline, forecastPassed, autoDeadlineMissed });
      return {
        soft: true as const,
        id: demandId,
        toolName: "todo" as const,
        satisfies: (toolCall: { name: string }) => toolCall.name === "todo",
        reminder: [{
          role: "developer" as const,
          content: `MANDATORY REPLAN: ${reason} ${unresolved.length ? unresolvedForecastRemedy(unresolved) : ""} Rows: ${rowList || "all remaining requested rows"}. Update only stale remaining-work estimates from worker findings and actual capacity; preserve the fixed deadline and requested scope. Reconcile delivered work, retire disproved methods with findings, and keep independent ready work moving. Ask only for genuinely missing authority or input. Forecast missed ${forecastMissCount} time(s)${lateBy === undefined ? "" : `, last by ${lateBy}m`}.`,
          timestamp: now,
        }],
      };
    }
    forecastMissActive = false;
    forecastReplanBaseline = null;
    pendingAutoForecastMissAt = null;
    const jobs = ctx.getAsyncJobSnapshot();
    const runningTasks = (jobs?.running ?? []).filter((job) => job.type === "task" && job.status === "running").length;
    if (runningTasks > 0 && decision.readyCandidates.length > 0 &&
      decision.readyCandidates.every((row) => row.ownership === "live-owned") &&
      (decision.forecast.planningIssues ?? []).length === 0 && !hasReplannableWait(decision)) {
      pendingReplan = null;
      return gateTrace(ctx, "waiting-on-staffed-work");
    }
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
      // A real request breaks the internal no-action streak even when the advisory provider
      // has already consumed its pending-input signal before getToolChoice is evaluated.
      const priorWake = recoveryReceipt(ctx);
      if (priorWake) pi.appendEntry("todo-dispatch-action-demand", { ...priorWake, misses: 0, noToolMisses: 0, retryAt: undefined, resetAt: Math.max(Date.now(), (recoveryReceipt(ctx)?.resetAt ?? 0) + 1) });
      if (!singleWriterLane) {
        const branch = dispatchStateEntries(ctx);
        const wasAway = lastPresence === "away" || derivePresence(branch, rehydrateDeadlineState(branch), Date.now()) === "away";
        if (wasAway) {
          lastPresence = "away";
          queueReturnNotice(sdk.getLatestTodoPhasesFromEntries(branch as never));
        }
      }
    }
  });
  let gitStateCache: { cwd: string; at: number; state: GitIntegrationState | null } | null = null;
  let mergeStateCache: { cwd: string; at: number; state: GitIntegrationState | null } | null = null;
  const refreshMerge = async (ctx: ExtensionContext, now: number) => {
    const state = await readGitIntegrationState(ctx.cwd, now, process.env, false);
    mergeStateCache = { cwd: ctx.cwd, at: now, state };
    return state;
  };
  const lastChiefHead = new Map<string, string>();
  let gitStatePending: { cwd: string; promise: Promise<GitIntegrationState | null> } | null = null;
  const gitState = async (ctx: ExtensionContext, now: number, force = false): Promise<GitIntegrationState | null> => {
    if (!force && gitStateCache?.cwd === ctx.cwd && now - gitStateCache.at <= PUSH_POLL_MS) {
      const state = gitStateCache.state;
      return state?.oldestUnpushedAgeMs === undefined ? state : { ...state, oldestUnpushedAgeMs: state.oldestUnpushedAgeMs + now - gitStateCache.at };
    }
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
  const rowOwnsCheckout = (ctx: ExtensionContext, row: TaskRow) =>
    !readOnlyClaim(row) &&
    (row.content.startsWith("Push: run project gates and push ") ||
      row.schedule?.resources?.some(resource => {
        const target = resource.replace(/^(?:path|repo|repository|checkout|worktree):/, "");
        return isAbsolute(target) && (resolve(target) === resolve(ctx.cwd) || resolve(target).startsWith(`${resolve(ctx.cwd)}/`));
      }) === true);
  const ownsBranchWork = (ctx: ExtensionContext) => todoPhases(ctx).some(phase => phase.tasks.some(row => rowOwnsCheckout(ctx, row)));
  const ownsActiveBranchWork = (ctx: ExtensionContext) => todoPhases(ctx).some(phase =>
    phase.tasks.some(row => isOpenRowStatus(row.status) && rowOwnsCheckout(ctx, row))
  );
  const deliveryCheckpointIntervals = (state: GitIntegrationState | null, now: number): number => {
    if (
      !state?.head ||
      sprintState.deliveryCheckpointActive !== true ||
      sprintState.deliveryCheckpointHead !== state.head ||
      typeof sprintState.deliveryCheckpointAt !== "number"
    ) return 0;
    return Math.max(0, Math.floor((now - sprintState.deliveryCheckpointAt) / DELIVERY_CHECKPOINT_MS));
  };
  const observeDeliveryCheckpoint = (ctx: ExtensionContext, state: GitIntegrationState, now: number) => {
    const active = ownsActiveBranchWork(ctx);
    const published = state.unpushed === undefined ? undefined : state.unpushed === 0;
    if (!active) {
      if (sprintState.deliveryCheckpointActive !== false) {
        sprintState = {
          ...sprintState,
          deliveryCheckpointActive: false,
          deliveryCheckpointHead: state.head,
          deliveryCheckpointAt: now,
          ...(published === undefined ? {} : { deliveryCheckpointPublished: published }),
        };
        persistSprintState();
      }
      return;
    }
    const headChanged = sprintState.deliveryCheckpointHead !== state.head;
    const remotePublished = published === true && sprintState.deliveryCheckpointPublished === false;
    if (
      sprintState.deliveryCheckpointActive !== true ||
      (headChanged && published === true) ||
      remotePublished ||
      typeof sprintState.deliveryCheckpointAt !== "number"
    ) {
      sprintState = {
        ...sprintState,
        deliveryCheckpointActive: true,
        deliveryCheckpointHead: state.head,
        deliveryCheckpointAt: now,
        ...(published === undefined ? {} : { deliveryCheckpointPublished: published }),
      };
      persistSprintState();
      return;
    }
    if (headChanged) {
      // A new HEAD seen during a remote outage has not been confirmed. Keep it
      // pending so a later successful readback can reset the delivery clock.
      sprintState = { ...sprintState, deliveryCheckpointHead: state.head, deliveryCheckpointPublished: published ?? false };
      persistSprintState();
      return;
    }
    if (published !== undefined && sprintState.deliveryCheckpointPublished !== published) {
      sprintState = { ...sprintState, deliveryCheckpointPublished: published };
      persistSprintState();
    }
  };
  const deliveryCheckpointText = (intervals: number, state: GitIntegrationState) => state.pushTargetMissing
    ? `DELIVERY CHECKPOINT: ${state.pushRemote}/${state.pushBranch} does not exist on the remote. Check whether the work was integrated or a new target is intended before taking publication action. ${ORDER}`
    : state.unpushed === undefined
    ? `DELIVERY CHECKPOINT: cannot verify publication on ${state.pushRemote ?? "the selected remote"}/${state.pushBranch ?? "branch"} after ${intervals} fixed 15-minute interval(s). Restore readback, preserve any overlapping writer, and only if authorized and ready publish the prepared result. ${ORDER}`
    : state.unpushed > 0
    ? `DELIVERY CHECKPOINT: ${state.unpushed} commit(s) are not confirmed on ${state.pushRemote}/${state.pushBranch} after ${intervals} fixed 15-minute interval(s). Run required gates and, only if authorized and ready, push the prepared result and read back the target ref. Preserve any overlapping writer. ${ORDER}`
    : intervals >= 2
    ? `SECOND CONSECUTIVE ARTIFACT-FREE CHECKPOINT: checkout HEAD ${state.head} has not changed for ${intervals} fixed 15-minute wall-clock intervals. If authorized and ready, push and read back any existing commit; otherwise stop/release the current method or worker and split/reassign the smallest shippable slice. A changed ETA/PERT, status message or retrospective does not reset this clock. ${ORDER}`
    : `DELIVERY CHECKPOINT: checkout HEAD ${state.head} did not change during one fixed 15-minute wall-clock interval. Commit the smallest coherent slice now, or if authorized and ready push and read back an existing commit; if neither is possible, narrow the method immediately. A changed ETA/PERT or status message does not reset this clock. ${ORDER}`;
  const deliveryCheckpointSteered = new Map<string, { episode: string; delivered: boolean; pending: boolean; retryAt: number }>();
  const refreshPush = async (ctx: ExtensionContext, force = false) => {
    if (singleWriterLane || !isMain(ctx)) return;
    const ownerSession = AgentRegistry.global().list().find(ref => ref.kind === "main"
      && ref.session?.sessionManager === ctx.sessionManager)?.session;
    if (ownerSession) {
      const phases = todoPhases(ctx);
      const archive = dispatchTodoArchive(ctx);
      const rows = [...phases, ...archive].flatMap(phase => phase.tasks);
      const replacements = new Map();
      for (const row of phases.flatMap(phase => phase.tasks)) {
        if (!isNonClosedRowStatus(row.status)) continue;
        let origin = auditLineage(row, rows);
        if (!origin) continue;
        const running = ctx.getAsyncJobSnapshot()?.running ?? [];
        if (running.some(job => job.status === "running" && [job.id, job.agentId, job.name].some(id => id && [row.schedule?.owner, row.schedule?.executor?.workerId].includes(id)))) continue;
        origin = { ...origin, repoPath: origin.repoPath ?? ctx.cwd };
        const state = origin.supersededAt ? { head: origin.retargetHead } : await readGitIntegrationState(origin.repoPath, Date.now(), process.env, true, origin);
        if (!state?.head || (!origin.supersededAt && !(origin.branch && state.pushTargetMissing) && !state.targetMerged)) continue;
        const current = origin.supersededAt ? state : await readGitIntegrationState(ctx.cwd, Date.now(), process.env, false);
        if (!current?.head) continue;
        const next = reconcileSupersededAudit(row, origin, current.head, await checkableAuditFinding(row, ctx.cwd), Date.now(), ctx.cwd);
        if (next !== row) replacements.set(row.content, next);
      }
      if (replacements.size) {
        const fresh = todoPhases(ctx);
        ownerSession.commitTodoPhases(fresh.map(phase => ({ ...phase, tasks: phase.tasks.map(row => {
          const before = phases.flatMap(phase => phase.tasks).find(candidate => candidate.content === row.content);
          return JSON.stringify(before) === JSON.stringify(row) ? replacements.get(row.content) ?? row : row;
        }) })));
        cachedDecision = null;
      }
    }
    if (!ownsBranchWork(ctx)) {
      if (sprintState.deliveryCheckpointActive !== false) {
        sprintState = { ...sprintState, deliveryCheckpointActive: false, deliveryCheckpointAt: Date.now() };
        persistSprintState();
      }
      ctx.ui?.setStatus?.("todo-delivery-checkpoint", undefined);
      return;
    }
    const session = AgentRegistry.global().list().find(ref => ref.kind === "main"
      && ref.session?.sessionManager === ctx.sessionManager)?.session;
    if (!session) return;
    const now = Date.now();
    const state = await gitState(ctx, now, force);
    if (state) observeDeliveryCheckpoint(ctx, state, now);
    const checkpointIntervals = deliveryCheckpointIntervals(state, now);
    ctx.ui?.setStatus?.("todo-delivery-checkpoint", checkpointIntervals > 0
      ? `${checkpointIntervals >= 2 ? "stop/split" : "checkpoint"} · ${checkpointIntervals * 15}m ${state?.unpushed === undefined ? "publication unknown" : state.unpushed > 0 ? "publication unconfirmed" : "without new HEAD"}`
      : undefined);
    ctx.ui?.setStatus?.("todo-unpushed", state?.pushTargetMissing ? `push target missing · ${state.pushRemote}/${state.pushBranch}` : state?.unpushed === undefined ? undefined
      : state.unpushed ? `${state.unpushed} unpushed · oldest ${Math.floor((state.oldestUnpushedAgeMs ?? 0) / 60_000)}m` : undefined);
    if (state && checkpointIntervals > 0) {
      const level = checkpointIntervals >= 2 ? 2 : 1;
      sendHarnessNotice(
        "todo-delivery-checkpoint",
        `${ctx.cwd}:${state.head}:${level}`,
        deliveryCheckpointText(checkpointIntervals, state),
        { head: state.head, cwd: ctx.cwd, intervals: checkpointIntervals },
        `delivery-checkpoint:${state.head}:${level}`,
        { triggerTurn: ctx.isIdle?.() === true },
      );
      // A checkpoint must reach the worker holding this checkout, not just the
      // chief. Do not ask competing writers to commit the same checkout.
      const jobs = (ctx.getAsyncJobSnapshot()?.running ?? []).filter(job =>
        job.type === "task" && job.status === "running" && !job.queued);
      const owners = new Set(todoPhases(ctx).flatMap(phase => phase.tasks)
        .filter(row => isOpenRowStatus(row.status) && rowOwnsCheckout(ctx, row))
        .flatMap(row => [row.schedule?.owner, row.schedule?.executor?.workerId])
        .filter((owner): owner is string => typeof owner === "string"));
      const writers = jobs.filter(job => [...owners].some(owner => liveJobMatchesOwner(job, owner)));
      if (writers.length === 1) {
        const id = writers[0].agentId ?? writers[0].id;
        const episode = `${sprintState.deliveryCheckpointAt}:${level}`;
        const previous = deliveryCheckpointSteered.get(id);
        if (!previous || previous.episode !== episode || (!previous.delivered && !previous.pending && Date.now() >= previous.retryAt)) {
          const attempt = { episode, delivered: false, pending: true, retryAt: Date.now() + 30_000 };
          deliveryCheckpointSteered.set(id, attempt);
          void sendWorkerSteering(ctx, id, `Delivery checkpoint: report the smallest coherent, verified slice or the concrete blocker now. Preserve other workers' changes; commit or push only when authorized and safe.`)
            .then(result => {
              attempt.pending = false;
              attempt.delivered = result.delivered;
              if (!result.delivered) reportWorkerSteeringFailure(ctx, id, result, `chief must write agent://${id} manually`);
            });
        }
      }
    }
    if (state?.unpushed === undefined || !state.pushBranch) return;
    if (state.unpushed === 0) {
      const key = noticeKey("todo-unpushed", `${ctx.cwd}:${pushRowTitle(state)}`);
      if (sprintState.lastNotices[key]) {
        const { [key]: _cleared, ...rest } = sprintState.lastNotices;
        sprintState = { ...sprintState, lastNotices: rest };
        persistSprintState();
      }
    }
    const phases = todoPhases(ctx);
    const next = reconcilePushRow(phases, checkpointIntervals > 0 && state.unpushed > 0
      ? { ...state, pushThresholdMs: 0 } : state, ctx.cwd, Date.now());
    if (next !== phases) {
      // Use the owning session's canonical live-cache + durable-entry writer.
      session.commitTodoPhases(next);
      cachedDecision = null;
    }
    if (state.unpushed && (state.oldestUnpushedAgeMs ?? 0) >= (state.pushThresholdMs ?? STALE_PUSH_MS)) {
      const row = pushRowTitle(state);
      sendHarnessNotice("todo-unpushed", `${ctx.cwd}:${row}`, prompt.render(unpushedInstructions, {
        count: state.unpushed, minutes: Math.floor((state.oldestUnpushedAgeMs ?? 0) / 60_000), row,
      }).trim(), { head: state.head, cwd: ctx.cwd }, row, { triggerTurn: ctx.isIdle?.() === true });
    }
  };
  const resolvedMerge = (state: GitIntegrationState | null) =>
    state?.mergeHead !== undefined && state.unmerged === 0 && (state.mergeAgeMs ?? 0) >= STALE_MERGE_MS ? state : null;
  const integrationRequirement = (ctx: ExtensionContext, _goalActive: boolean, now: number) => {
    // This host callback is synchronous. Never run a child process here or use
    // expired advice; context/tool admission refreshes the canonical snapshot.
    const push = gitStateCache?.cwd === ctx.cwd && now - gitStateCache.at <= PUSH_POLL_MS ? gitStateCache.state : null;
    const mergeState = mergeStateCache?.cwd === ctx.cwd && now - mergeStateCache.at <= 15_000 ? mergeStateCache.state : null;
    const state = mergeState ? { ...(push?.head === mergeState.head ? push : {}), ...mergeState } : push;
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
    if (ownsBranchWork(ctx) && state && !state.mergeHead && (state.unpushed ?? 0) > 0 && (state.oldestUnpushedAgeMs ?? 0) >= (state.pushThresholdMs ?? STALE_PUSH_MS)) {
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
          content: `UNPUSHED WORK: ${state.unpushed} commit(s) on this branch, the oldest ${minutes} minutes old, are not confirmed on ${state.pushRemote}/${state.pushBranch}. Push only if authorized and ready; otherwise prepare the smallest deliverable and preserve any overlapping writer. ${ORDER}`,
          timestamp: now,
        }],
      };
    }
    const checkpointIntervals = deliveryCheckpointIntervals(state, now);
    if (state && !state.mergeHead && ownsActiveBranchWork(ctx) && checkpointIntervals > 0) {
      gateTrace(ctx, "delivery-checkpoint-demand", { head: state.head, intervals: checkpointIntervals });
      return {
        soft: true as const,
        id: `todo-delivery-checkpoint:${state.head}:${Math.min(checkpointIntervals, 2)}`,
        toolName: "task" as const,
        satisfies: (toolCall: { name: string; arguments?: Record<string, unknown> }) =>
          (toolCall.name === "bash" && typeof toolCall.arguments?.command === "string" &&
            (GIT_COMMIT.test(toolCall.arguments.command) || GIT_PUSH.test(toolCall.arguments.command))) ||
          (toolCall.name === "task" && /\b(commit|checkpoint|shippable|stop|release|split)\b/i.test(JSON.stringify(toolCall.arguments ?? {}))),
        reminder: [{
          role: "developer" as const,
          content: deliveryCheckpointText(checkpointIntervals, state),
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
  const workerCompactionAt = async (worker: { name: string; path?: string; size?: number }): Promise<number | undefined> => {
    const manager = AgentRegistry.global().get(worker.name)?.session?.sessionManager;
    if (manager && worker.path && typeof manager.getSessionFile === "function" && manager.getSessionFile() === worker.path) {
      const entry = selectLatestBranchEntry(manager, metadata => metadata.type === "compaction");
      const at = entry ? Date.parse(entry.timestamp) : undefined;
      return at !== undefined && Number.isFinite(at) ? at : undefined;
    }
    if (!worker.path) return undefined;
    let state = workerCompactionCursors.get(worker.name);
    if (!state) {
      state = { cursor: new JournalCursor() };
      workerCompactionCursors.set(worker.name, state);
    }
    const current = state;
    try {
      await current.cursor.read(worker.path, entry => {
        if (entry.type !== "compaction") return;
        const at = Date.parse(entry.timestamp);
        if (Number.isFinite(at)) current.at = at;
      }, () => { current.at = undefined; });
    } catch {
      workerCompactionCursors.delete(worker.name);
      return undefined;
    }
    return current.at;
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
  const previewHeadTimes = new Map<string, number>();
  // Capture ordinary shared-checkout output only inside a measured, completed worker run.
  // A later lead/gate commit is outside that interval and cannot become this row's output.
  const capturePreviewWorkerHeads = async (ctx: ExtensionContext, phases: TodoScheduleInput, records: PreviewRecord[]): Promise<PreviewRecord[]> => {
    const next = [...records];
    const recent = ctx.getAsyncJobSnapshot()?.recent ?? [];
    for (const row of phases.flatMap(phase => phase.tasks)) {
      if (row.schedule?.firstRequirementAt === undefined || records.some(record => record.task === row.content)) continue;
      const executor = row.schedule.executor;
      const runs = [
        ...(executor?.outcome === "completed" && typeof executor.finishedAt === "number"
          ? [{ id: executor.workerId, startedAt: executor.startedAt, finishedAt: executor.finishedAt }] : []),
        ...(row.schedule.attemptHistory ?? []).filter(attempt => attempt.terminalStatus === "completed")
          .map(attempt => ({ id: attempt.workerName, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt })),
      ];
      if (!executor && typeof row.schedule.owner === "string") {
        const owner = row.schedule.owner;
        for (const sibling of phases.flatMap(phase => phase.tasks)) {
          const observed = sibling.schedule?.executor;
          if (observed?.outcome === "completed" && typeof observed.finishedAt === "number" && liveJobMatchesOwner({ id: observed.workerId }, owner))
            runs.push({ id: observed.workerId, startedAt: observed.startedAt, finishedAt: observed.finishedAt });
          for (const attempt of sibling.schedule?.attemptHistory ?? [])
            if (attempt.terminalStatus === "completed" && liveJobMatchesOwner({ id: attempt.workerName }, owner))
              runs.push({ id: attempt.workerName, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt });
        }
        for (const job of recent) {
          if (job.type !== "task" || job.status !== "completed" || !liveJobMatchesOwner(job, owner) || typeof job.startTime !== "number" || typeof job.endTime !== "number") continue;
          runs.push({ id: job.agentId ?? job.id, startedAt: job.startTime, finishedAt: job.endTime });
        }
      }
      for (const run of runs) {
        if (!Number.isFinite(run.startedAt) || !Number.isFinite(run.finishedAt) || run.finishedAt < run.startedAt) continue;
        const declaredRoots = (row.schedule.resources ?? []).map(resource => resource.replace(/^(?:path|repo|repository|checkout|worktree):/, "")).filter(resource => isAbsolute(resource));
        for (const root of new Set([...workerRepoRoots(ctx, run.id), ...declaredRoots])) {
          try {
            const repo = vcs.git(root);
            const commit = await repo?.headSha();
            if (!repo || !commit) continue;
            const key = `${root}\0${commit}`;
            let at = previewHeadTimes.get(key);
            if (at === undefined) {
              at = await vcs.lastCommitTime(repo);
              if (typeof at !== "number" || await repo.headSha() !== commit) continue;
              if (previewHeadTimes.size >= 2048) previewHeadTimes.clear();
              previewHeadTimes.set(key, at);
            }
            if (at < Math.floor(run.startedAt / 1000) * 1000 || at > run.finishedAt) continue;
            if (!next.some(record => record.task === row.content && record.commit === commit)) next.push({ task: row.content, commit });
          } catch {}
        }
      }
    }
    return next;
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
      if (!row || typeof p95 !== "number" || !workerPastForecast(p95, job.startTime, now)) {
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
    void refreshPush(ctx);
    const local = await refreshMerge(ctx, now);
    const pushed = ownsBranchWork(ctx) && gitStateCache?.cwd === ctx.cwd && gitStateCache.state?.head === local?.head ? gitStateCache.state : null;
    const state = local ? { ...pushed, ...local } : pushed;
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
  let nativeGateRegistered = false;
  const softRequirementApi = pi as unknown as SoftToolRequirementRegistrar;
  if (!singleWriterLane && softRequirementApi.registerSoftToolRequirementProvider && pauseGate) {
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
      if (isMain(ctx)) syncCriticalFast(ctx, decision, fastByWorker);
      if (isMain(ctx)) {
        // Unpushed or unfinished git work needs delivery in any session, not only one with a /goal.
        const integration = integrationRequirement(ctx, !decision.goalPaused, now);
        if (integration) return integration;
      }
      if (isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) return;
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
      const claimRefusals = assignedResourceRefusals(todoPhases(ctx), ctx);
      const dispatchable = (decision.dispatchableReady ?? []).filter(row => !claimRefusals.has(row.content));
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
      const freshUserInput = userInputs > userInputsSeen;
      const demand = demandProvider(ctx) as { reminder?: Array<{ content: string }> } | undefined | void;
      activeDemand = demand?.reminder?.[0]?.content ?? null;
      const receipt = recoveryReceipt(ctx);
      // Recover repeated text-only wakes without cutting off any of the chief's tools.
      // Reads cannot clear the streak; only observed action or accepted refusal does.
      if (freshUserInput || !isMain(ctx) || pauseGate.paused || gateSwitchedOff(ctx) || !pi.getActiveTools().includes("task") ||
          !receipt || (receipt.noToolMisses ?? 0) < 3 || !wakeTurn || wakeTurn.mutations > 0 || wakeTurn.rejection || wakeTurn.demandKey !== receipt.key) return undefined;
      return {
        soft: true as const, id: `todo-no-action:${receipt.key}`, toolName: "task" as const,
        // This predicate admits calls before execution; action is counted only in tool_result.
        // Returning false here would skip every tool and make recovery impossible.
        escalationToolChoice: "required" as const, satisfies: () => true,
        reminder: [{ role: "developer" as const, content: dispatchToolRecoveryInstructions.trim(), timestamp: Date.now() }],
      };
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
      Object.entries(sprintState.lastNotices).filter(([key]) => !key.startsWith("todo-plan-check\0")),
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

  // A todo call may not make the user a dependency: refuse blocking a row on them (or keeping it blocked
  // on them) unless that row carries a non-empty missionCritical reason, given now or on an earlier call.
  const refuseUserWait = (input: unknown, ctx: ExtensionContext): string | undefined => {
    if (!input || typeof input !== "object") return undefined;
    const call = input as { op?: unknown; task?: unknown; phase?: unknown; reason?: unknown; items?: unknown; missionCritical?: unknown };
    const rows = todoPhases(ctx).flatMap((phase) => phase.tasks.map((task) => ({ phase: phase.name, task })));
    const critical = (row: string, ...marks: unknown[]) => {
      if (marks.some(nonEmptyString)) { missionCriticalRows.add(row); return true; }
      const stored = (rows.find((candidate) => candidate.task.content === row)?.task.schedule as { missionCritical?: unknown } | undefined)?.missionCritical;
      return nonEmptyString(stored) || missionCriticalRows.has(row);
    };
    if (call.op === "block") {
      const targets = rows.filter(({ phase, task }) => (typeof call.task === "string" && task.content === call.task) || (typeof call.phase === "string" && phase === call.phase && typeof call.task !== "string"));
      const waiting = targets.length
        ? targets.filter(({ task }) => waitsOnUser((task.schedule as { owner?: unknown } | undefined)?.owner, call.reason)).map(({ task }) => String(task.content))
        : waitsOnUser(undefined, call.reason) ? [String(call.task ?? call.phase ?? "")] : [];
      return waiting.every((name) => critical(name, call.missionCritical)) ? undefined : USER_WAIT_REFUSAL;
    }
    for (const update of todoScheduleUpdates(input)) {
      if (typeof update.task !== "string") continue;
      // A customer verdict resolves this wait; it is not another request to keep waiting.
      if (["accepted", "redo", "drop"].includes(String(update.review))) continue;
      const row = rows.find((candidate) => candidate.task.content === update.task)?.task;
      const schedule = row?.schedule as { owner?: unknown } | undefined;
      const owner = typeof update.owner === "string" ? update.owner : schedule?.owner;
      const stillBlocked = row?.status === "blocked";
      if (!stillBlocked || !waitsOnUser(owner, row?.blocker)) {
        if (nonEmptyString(update.missionCritical)) missionCriticalRows.add(update.task);
        continue;
      }
      if (!critical(update.task, update.missionCritical, call.missionCritical)) return USER_WAIT_REFUSAL;
    }
    return undefined;
  };
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "todo" && event.input?.op === "drop" && String(event.input.reason ?? "").startsWith("superseded:")) {
      const refusal = await supersededAuditDropRefusal(event.input, todoPhases(ctx), ctx.cwd, dispatchTodoArchive(ctx));
      if (refusal) return { block: true, reason: refusal };
      await refreshPush(ctx, true);
    }

    const nag = zeroActiveNag(ctx);
    const ownedWait = event.toolName === "wait" && (ctx.getAsyncJobSnapshot()?.running ?? []).some(job => job.status === "running" && !job.queued);
    if (nag && !isStaffingCall(event.toolName, event.input)) {
      zeroActiveCalls += 1;
      const gate = zeroActiveGate(nag);
      const verdict = decideGateCall({ name: event.toolName, arguments: event.input ?? {} }, [gate]);
      // Reuse the shell policy already applied by escalation below. A staffing
      // requirement must not block inspection or waiting on our own running job.
      const look = event.toolName === "bash" && typeof event.input?.command === "string" && isChiefBash(event.input.command);
      if (zeroActiveCalls >= 3 && zeroActiveCalls <= 5 && !verdict.allowed && !look && !ownedWait) return { block: true, reason: nag };
    }
    const originalTaskItems = event.toolName === "task" ? taskItems(event.input) : [];
    let contractInput;
    if (wakeTurn) wakeTurn.toolCalls += 1;
    if (isMain(ctx) && !pauseGate?.paused && !singleWriterLane && !gateSwitchedOff(ctx)) {
      if (event.toolName === "todo_dispatch_forecast" && recovery?.pending?.kind === "deadline") return;
      if (["wait", "yield"].includes(event.toolName) && !ownedWait && recovery?.pending && (recoveryReceipt(ctx)?.misses ?? 0) >= 2)
        return { block: true, reason: recovery.pending.action };
    }
    // A non-read tool call (a todo change, a task dispatch, an edit, a command) is progress for the absence wake.
    if (!READ_ONLY_TOOLS.has(event.toolName) && !(event.toolName === "todo" && ["view", undefined].includes((event.input as { op?: string } | undefined)?.op))) progressEvents += 1;
    if (event.toolName === "todo" && isMain(ctx)) {
      const rows = todoPhases(ctx).flatMap(phase => phase.tasks);
      const failed = [];
      for (const update of todoScheduleUpdates(event.input)) {
        const patch = update.schedule ?? update;
        const task = update.task ?? update.content;
        const row = rows.find(row => row.content === task);
        const review = patch.review ?? row?.schedule?.review;
        if (review !== "user" || (patch.review === undefined && !("reviewPage" in patch))) continue;
        const url = "reviewPage" in patch ? patch.reviewPage : row?.schedule?.reviewPage;
        let status = "missing review page";
        try { if (typeof url === "string") status = String(await (options.reviewPageProbe ?? probeReviewPage)(url, String(task))); } catch { status = "unreachable"; }
        if (status !== "200") {
          failed.push({ row: task, url, status });
          if (row && row.status !== "abandoned")
            ctx.updateTodoSchedule?.(String(task), { review: "user", reviewPagePending: true });
        }
      }
      if (failed.length) return { block: true, reason: prompt.render(chatChoiceInstructions, { failed }).trim() };
    }
    if (event.toolName === "wait") {
      const redReason = await redRowsIdleReason(ctx);
      if (redReason) return { block: true, reason: redReason };
      const reason = waitingForSingleRead(ctx) ? undefined : unansweredUserReasonWithDraft(ctx);
      if (reason) {
        const previous = selectBranchNewestFirst(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === "todo-reply-refusal").next().value;
        if (previous?.data?.reason !== reason) {
          pi.appendEntry("todo-reply-refusal", { reason });
          pi.sendMessage({ customType: "todo-reply-recovery", content: reason, display: false, attribution: "agent" }, { deliverAs: "nextTurn", triggerTurn: false, interruptWait: false });
          return { block: true, reason };
        }
        pi.appendEntry("todo-reply-gate-miss", { reason, action: "wait admitted after identical refusal" });
      }
      const choiceReason = await chatChoiceReason(ctx);
      if (choiceReason) return { block: true, reason: choiceReason };
      const idleReason = ownedWait ? undefined : demandIdlePlanContinuation(ctx, false);
      if (idleReason) return { block: true, reason: idleReason };
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
    const visibility = await pollPreview(ctx);
    if (previewConfig(ctx).enabled && isMain(ctx)) {
      const phases = (ctx.getTodoSnapshot?.() ?? ctx.getTodoPhases?.()) ?? [];
      if (event.toolName === "todo") {
        const profiles = new Map<string, string | undefined>();
        for (const job of ctx.getAsyncJobSnapshot()?.running ?? []) {
          const session = AgentRegistry.global().get(job.agentId ?? job.id)?.session;
          if (!session) continue;
          const init = selectBranchEntries(session.sessionManager, metadata => metadata.type === "session_init")
            .findLast(entry => typeof entry.agent === "string");
          profiles.set(job.id, init?.agent);
          profiles.set(job.agentId ?? job.id, init?.agent);
        }
        const refusal = previewScheduleRefusal(event.input, phases, visibility, profiles);
        if (refusal) return { block: true, reason: refusal };
      }
      if (event.toolName === "task") {
        const refusal = previewDispatchRefusal(event.input, overduePreviewRows(phases, visibility, previewConfig(ctx), Date.now()));
        if (refusal) return { block: true, reason: refusal };
      }
    }
    // Ownership survives IRC revival even when staffing policy is paused or disabled.
    if (event.toolName === "task" && isMain(ctx)) {
      const phases = todoPhases(ctx);
      const display = leadDisplayContext(ctx, phases, currentDecision(ctx));
      const reservedRows = new Set<string>();
      for (const item of taskItems(event.input)) {
        const matchedRows = speculativeTaskRows(item, phases);
        const reviewDebt = phases.flatMap((phase) => phase.tasks).some((row) => row.schedule?.review === "user" && row.status !== "completed" && row.status !== "abandoned");
        if (!matchedRows.length && reviewDebt && item.readOnly !== true && !readOnlyAudit(item)) {
          return { block: true, reason: "Task does not match a scheduled row while user-review work remains open. Add and schedule the new row, or name the exact existing row." };
        }
        for (const row of matchedRows) {
          if (item.readOnly !== true && !readOnlyAudit(item)) {
            if (reservedRows.has(String(row.content))) return { block: true, reason: `Task batch repeats writer row ${JSON.stringify(row.content)}; dispatch one executor for that row.` };
            reservedRows.add(String(row.content));
          }
          const owner = display.owners.get(row.content);
          if (owner) return { block: true, reason: prompt.render(gateNoticeInstructions, {
            liveOwner: true, row: JSON.stringify(row.content), owner: owner.id,
          }).trim() };
        }
      }
    }
    if (event.toolName === "task" && isMain(ctx)) {
      const input = event.input;
      contractInput = Array.isArray(input) ? input.map(item => ({ ...item }))
        : Array.isArray(input?.tasks) ? { ...input, tasks: input.tasks.map(item => ({ ...item })) } : { ...input };
      const phases = todoPhases(ctx);
      for (const item of taskItems(contractInput)) {
        for (const row of speculativeTaskRows(item, phases)) {
          const attempt = prepareAttemptBrief(row, String(item.task ?? ""));
          if (attempt.refusal) return { block: true, reason: attempt.refusal };
          const grounded = prepareRequirementBrief(row, ctx, attempt.task);
          if (grounded.refusal) return { block: true, reason: grounded.refusal };
          item.task = grounded.task;
        }
      }
      event = { ...event, input: contractInput };
    }
    await refreshLiveWorkerModels(ctx);
    if (gateSwitchedOff(ctx)) return contractInput ? { input: contractInput } : undefined;
    if (singleWriterLane) return contractInput ? { input: contractInput } : undefined;
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
      const userWait = refuseUserWait(event.input, ctx);
      if (userWait) return { block: true, reason: userWait };
      const blockCall = event.input as { op?: unknown; task?: unknown; phase?: unknown; reason?: unknown } | undefined;
      if (blockCall?.op === "block") {
        const owners = runningOwnerNames(ctx);
        const selfBlocked = todoPhases(ctx)
          .flatMap((phase) => phase.tasks.filter((task) => (typeof blockCall.task === "string" ? task.content === blockCall.task : typeof blockCall.phase === "string" && phase.name === blockCall.phase)))
          .filter((task) => isNonClosedRowStatus(String(task.status)) && leadActionPending({ ...task, blocker: blockCall.reason }, owners))
          .map((task) => String(task.content));
        if (selfBlocked.length) return { block: true, reason: leadActionBlockRefusal(selfBlocked) };
      }
      const gate = applyTodoOverride(event.input, ctx, false);
      if (gate !== undefined) persistSprintState();
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
          announceGates(ctx);
          gateTrace(ctx, "slip-reestimate-refused", {});
          return { block: true, reason: slip };
        }
        const floorRefusal = scheduleEstimateFloorRefusal(updates, rows, Date.now());
        if (floorRefusal) {
          announceGates(ctx);
          gateTrace(ctx, "estimate-floor-refused", {});
          return { block: true, reason: floorRefusal };
        }
      }
    }
    let preparedInput = contractInput;
    if (event.toolName === "task" && isMain(ctx)) {
      // Dispatch annotations belong to this call, never to provider arguments or owner snapshots.
      const input = event.input;
      preparedInput = Array.isArray(input) ? input.map(item => ({ ...item }))
        : Array.isArray(input?.tasks) ? { ...input, tasks: input.tasks.map(item => ({ ...item })) }
        : { ...input };
      event = { ...event, input: preparedInput };
      const phases = todoPhases(ctx);
      const rows = phases.flatMap((phase) => phase.tasks);
      for (const item of taskItems(event.input)) {
        const brief = String(item.task ?? "");
        const boundRows = speculativeTaskRows(item, phases);
        for (const row of boundRows) {
          const refusal = refuseProofReview(row, item.agent, Date.now());
          if (refusal) return { block: true, reason: refusal };
          gateTrace(ctx, "speculative-review-checked", { row: row.content, agent: item.agent, readOnly: readOnlyAudit(item), speculativeOn: row.schedule?.speculativeOn, dependencies: (row.schedule?.dependencies ?? []).map((content) => { const target = rows.find((candidate) => candidate.content === content); return { content, status: target?.status, review: target?.schedule?.review }; }) });
          if (readOnlyAudit(item)) continue;
          // Speculation can use a delivered artifact or an explicit proposal;
          // it cannot invent the missing input behind an external approval hold.
          const unavailable = (row.schedule?.dependencies ?? []).map(content => rows.find(candidate => candidate.content === content))
            .find(candidate => candidate && candidate.status === "blocked" && candidate.schedule?.review === "user" &&
              !todoRowHasDeliverable(candidate) && !parseUserWait(candidate.blocker)?.proposal);
          if (unavailable) return { block: true, reason: `Dependency ${JSON.stringify(unavailable.content)} is awaiting user input with no delivered artifact or recorded proposal. Keep ${JSON.stringify(row.content)} waiting; continue independent ready work.` };
          // A dropped title with the same exclusive resources is still the same work.
          let schedule = row.schedule ?? {};
          const resources = schedule.resources ?? [];
          const predecessor = resources.length && rows.find(candidate => candidate !== row && candidate.status === "abandoned"
            && candidate.schedule?.resources?.length === resources.length
            && resources.every(resource => candidate.schedule.resources.includes(resource))
            && candidate.schedule?.attemptHistory?.length);
          if (predecessor && !row.schedule?.attemptHistory?.length) {
            const patch = { decision: predecessor.schedule.decision, reviewAnswers: predecessor.schedule.reviewAnswers, review: predecessor.schedule.review,
              reviewPagePending: predecessor.schedule.reviewPagePending,
              firstDeliveredAt: predecessor.schedule.firstDeliveredAt };
            ctx.updateTodoSchedule?.(String(row.content), patch);
            schedule = { ...schedule, ...patch };
            pi.sendMessage({ customType: USER_REVIEW_CUSTOM_TYPE,
              content: prompt.render(gateNoticeInstructions, { renamedRow: row.content, predecessor: predecessor.content }).trim(),
              display: true, attribution: "agent" }, { deliverAs: "nextTurn", triggerTurn: false });
          }
          const unseen = todoNeedsOwnerDecision(schedule) && !(schedule.deliveryCritic?.verdict === "pending" && !schedule.deliveryCritic?.timedOut) && !schedule.review && (schedule.attemptHistory ?? predecessor?.schedule?.attemptHistory)?.some(attempt => attempt.terminalStatus === "completed");
          const dependentReview = missingSpeculativeReview(item, phases, row);
          const reviewTarget = dependentReview ?? schedule.speculativeOn ?? ((schedule.review === "user" && !schedule.reviewAnswers?.length) || unseen ? String(row.content) : undefined);
          const patch = {
            ...(unseen ? { review: "user" as const, reviewPagePending: !schedule.reviewPage,
              firstDeliveredAt: schedule.firstDeliveredAt ?? Date.now() } : {}),
            ...(reviewTarget ? { speculativeOn: reviewTarget } : {}),
          };
          if (Object.keys(patch).length) {
            ctx.updateTodoSchedule?.(String(row.content), patch);
            schedule = { ...schedule, ...patch };
          }
          if (reviewTarget) {
            item.task = `${brief}\n\n${prompt.render(gateNoticeInstructions, { speculative: true, reviewRow: reviewTarget }).trim()}`;
          }
          if (schedule?.review === "redo" && schedule.progress?.evidence) {
            item.task = `${item.task}\n\n${prompt.render(gateNoticeInstructions, { customerCorrection: true, correction: schedule.progress.evidence }).trim()}`;
          }
        }
      }
    }
    if (event.toolName === "wait") {
      if (isMain(ctx) && !pauseGate?.paused) {
        const recovery = activeRecoveries(ctx)[0];
        if (recovery) return { block: true, reason: recoveryNotice(recovery) };
      }
      return ownedWait && recovery?.pending?.kind === "deadline" ? undefined : blockIdleWait(ctx);
    }
    if (event.toolName === "task") chiefRefusals = 0;
    const rerouted = rerouteSettledWorkerWrite(event as { toolName: string; input?: unknown }, ctx);
    if (rerouted) return rerouted;
    if ((event.toolName === "task" || event.toolName === "todo") && isMain(ctx) && !pauseGate?.paused) {
      const text = JSON.stringify(event.input ?? {});
      const adds = event.toolName === "task" || /"op"\s*:\s*"(append|init)"/.test(text);
      // A worker told to commit (and push) the merge is the right move, not more merge work.
      // A checkout path can contain "rebase" or "merge" without assigning merge work.
      const mergeItems = taskItems(event.input).filter((item) => MERGE_WORK.test(`${item.name ?? ""} ${item.task ?? ""}`));
      const mergeWork = event.toolName === "task" ? mergeItems.length > 0 : MERGE_WORK.test(text);
      const integration = mergeWork && adds ? await readGitIntegrationState(ctx.cwd, Date.now(), process.env, false) : null;
      const merge = adds && !/\bcommit/i.test(text) ? resolvedMerge(integration) : null;
      const open = event.toolName === "task" ? integration : null;
      if (open?.mergeHead && !merge) {
        const items = mergeItems;
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
    // Forecast debt blocks staffing its row and declaring the whole plan complete.
    // Other ignored demands block work starts only on their identified rows.
    const decisionForGate = currentDecision(ctx);
    const forecastRows = decisionForGate.forecast?.rows ?? [];
    const phasesForGate = todoPhases(ctx);
    const overdueForMissedEta = forecastRows.filter(row => row.overdue);
    const escalatedIds = Object.keys(sprintState.ignoredDemands).filter(id =>
      PLAN_DEMAND_IDS.has(id) && isDemandEscalated(id) && (id !== "missed-eta" || overdueForMissedEta.length > 0));
    const unresolvedForGate = unresolvedForecastRows(decisionForGate.forecast);
    if ((escalatedIds.length || unresolvedForGate.length) && isMain(ctx) && !pauseGate?.paused && !isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) {
      const call = { name: event.toolName, arguments: (event.input ?? {}) as Record<string, unknown> };
      const targets = event.toolName === "todo" ? getTodoActionRows(phasesForGate, event.input ?? {}) : [];
      const items = event.toolName === "task" ? taskItems(event.input) : [];
      const matched = items.map(item => speculativeTaskRows(item, phasesForGate));
      const named = (rows: readonly { content: string }[]) => rows.map(row => JSON.stringify(row.content)).join(", ");
      const spawnTouches = (rows: readonly { content: string }[]) => matched.some(matches =>
        matches.some(row => rows.some(held => held.content === row.content)));
      const completesPlan = event.toolName === "todo" && event.input?.op === "done" &&
        forecastRows.filter(row => isNonClosedRowStatus(row.status)).every(row => targets.includes(row.content));
      if (unresolvedForGate.length && (spawnTouches(unresolvedForGate) || completesPlan)) {
        const affected = completesPlan ? unresolvedForGate : unresolvedForGate.filter(row => matched.some(matches => matches.some(match => match.content === row.content)));
        return { block: true, reason: `Forecast missing for ${affected.length} row(s).\nRows: ${named(affected)}. Use todo schedule with an estimate for each named row, or todo drop that row, before staffing it or completing the plan.` };
      }
      const jobs = ctx.getAsyncJobSnapshot();
      const affectedRows = (id: string): TodoTaskForecast[] => {
        if (id === "missed-eta") return overdueForMissedEta.filter(row => !rescheduledRowsThisTurn.has(row.content));
        if (id === "unread-receipts") return unreadReceiptRows(ctx, forecastRows);
        if (id === "todo-replan" || id === "todo-plan-doctor") return forecastRows.filter(row => !unresolvedForGate.some(held => held.content === row.content) &&
          (decisionForGate.forecast?.planningIssues?.some(issue => issue.task === row.content) || (pendingReplan && !row.ready && isOpenRowStatus(row.status))));
        if (id === "todo-link") {
          const owners = new Set(decisionForGate.todoOwnerIds ?? []);
          const linked = (jobs?.running ?? []).filter(job => job.type === "task" && !owners.has(job.id) && !owners.has(job.agentId ?? ""))
            .flatMap(job => speculativeTaskRows({ name: job.agentId ?? job.id, task: job.label }, phasesForGate));
          return forecastRows.filter(row => linked.some(match => match.content === row.content));
        }
        // A demand without a known row must not acquire authority over existing work.
        return [];
      };
      const refused = escalatedIds.flatMap(id => {
        const rows = affectedRows(id);
        if (id === "todo-replan" && !rows.length && unresolvedForGate.length) return [];
        const gatedItems = id === "todo-plan-doctor" ? items.filter(item => item.agent !== "plan-doctor") : items;
        if (id === "todo-plan-doctor" && items.length > 0 && gatedItems.length === 0) return [];
        const gatedMatched = gatedItems.map(item => speculativeTaskRows(item, phasesForGate));
        const releasedKnown = id === "missed-eta" && overdueForMissedEta.length > 0 && rows.length === 0;
        const spawn = gatedItems.length > 0 && (rows.length
          ? gatedMatched.some(matches => matches.some(row => rows.some(held => held.content === row.content))) || (id === "unread-receipts" && gatedItems.some(item => rows.some(row => {
            const job = receiptJobForRow(ctx, row);
            return job && typeof item.name === "string" && liveJobMatchesOwner(job, item.name);
          })))
          : id === "unread-receipts" ? !forecastRows.some(row => receiptJobForRow(ctx, row)) : releasedKnown ? false : true);
        const work = event.toolName === "todo" && PLAN_WORK_OPS[todoOpOf(call) ?? ""] && rows.some(row => targets.includes(row.content));
        if (!spawn && !work) return [];
        const remedy = id === "unread-receipts" ? UNREAD_REMEDY(rows.map(row => row.owner).filter(Boolean))
          : id === "todo-link" ? "Use todo schedule to link the running worker to its actual assignment row, or todo append to create that row."
          : id === "todo-plan-doctor" ? "Use task with agent plan-doctor to inspect the plan, then todo schedule to record the repair."
          : ESCALATION_REMEDY;
        return [`${id}: ${rows.length ? named(rows) : "affected rows unknown (new task spawns only)"}. ${remedy}`];
      });
      if (refused.length) {
        gateTrace(ctx, "escalation-refused", { toolName: event.toolName, gates: escalatedIds });
        return { block: true, reason: `Plan problem ignored: ${refused.join(" ")}` };
      }
    }
    // Independent chief-work policy remains separate from row-local plan admission.
    const chief = blockWorkerWork(event as { toolName: string; input?: unknown }, ctx);
    if (chief) return chief;
    if (event.toolName === "todo" && pendingReplan) pendingReplan.answered = pendingReplan.demands;
    if (event.toolName === "todo" && pendingTaskReconciliation?.linkDemanded) pendingTaskReconciliation.linkAnswered = true;
    if (event.toolName === "task") {
      for (const item of taskItems(event.input)) {
        if (item.agent === "retro-facilitator" && typeof item.name === "string") {
          retroFacilitatorJobs.add(item.name);
          sprintState = { ...sprintState, retroFacilitatorJobs: [...retroFacilitatorJobs] };
          persistSprintState();
        }
      }
    }
    if (event.toolName === "task" && dispatchGateBaseline) {
      if (pendingIdleResumeOwner) idleResumeAttempts.add(pendingIdleResumeOwner);
      taskCallBaselines.set(event.toolCallId, new Map(dispatchGateBaseline));
    }
    if (preparedInput !== undefined && taskItems(preparedInput).some((item, index) => item.task !== originalTaskItems[index]?.task)) return { input: preparedInput };
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
  let lastPlanProblems = "";
  const planCheck = async (ctx: ExtensionContext, pending: unknown[] = [], problemsOnly = false): Promise<string | null> => {
    if (!sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx, pending) as never).some(phase => phase.tasks.length)) return null;
    const visibility = await pollPreview(ctx);
    const visibilityProblem = previewPlanProblem(overduePreviewRows((ctx.getTodoSnapshot?.() ?? ctx.getTodoPhases?.()) ?? [], visibility, previewConfig(ctx), Date.now()));
    if (visibilityProblem) return visibilityProblem;
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
    touchSprintState(ctx, phasesNow, ctx.getAsyncJobSnapshot(), now);
    const acceptedClosingProblems = phasesNow.flatMap(phase => phase.tasks)
      .filter(row => isNonClosedRowStatus(row.status) && row.schedule?.review === "accepted")
      // The user's Accept is the acceptance: name the one call that closes the row, never an audit to wait for.
      .map(row => `user accepted ${JSON.stringify(row.content)}; close it now: todo op="schedule", updates=[{task:${JSON.stringify(row.content)}, review:"accepted"}] (internal audits run afterwards and never block it)`);
    if (!decision.forecast) {
      if (acceptedClosingProblems.length) return `PLAN CHECK: ${acceptedClosingProblems.length} problem(s). ${acceptedClosingProblems.join("; ")}`;
      // A plan with no open rows has no plan problems: decay every other demand here too, or an
      // escalated one (e.g. unread-receipts after the last row closed) would block forever.
      trackDemands([], false);
      persistSprintState();
      return null;
    }
    const rows = decision.forecast.rows ?? [];
    const openContents = new Set(
      phasesNow.flatMap((phase) => phase.tasks.filter((task) => isOpenRowStatus(task.status)).map((task) => task.content)),
    );
    const open = rows.filter((row) => isOpenRowStatus(row.status) && openContents.has(row.content));
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
    const acceptedMergeDemand = acceptedSpeculativeMergeDemand(phasesNow);
    const firstDeliveryLate = firstDeliveryCutRequired(
      decision.forecast.rows,
      sprintState.goalWorkStartedAt ?? now,
      decision.deadline?.baselineDeadlineAt === undefined ? undefined : decision.deadline.baselineDeadlineAt * 1_000,
      now,
    );
    const lateRowLines = overdue.map((row) => {
      const overMs = typeof row.resourceFinish === "number" ? Math.max(0, now - row.resourceFinish) : Math.max(0, now - (row.startedAt ?? now));
      return `${JSON.stringify(row.content)} · ${Math.floor(overMs / 60_000)}m over · owner ${row.owner ?? "unassigned"}`;
    });
    const userUnblockDue: Array<{ row: string; question: string }> = [];
    for (const task of phasesNow.flatMap((phase) => phase.tasks)) {
      if (task.status !== "blocked" || typeof task.blocker !== "string") continue;
      if ((task.schedule as { review?: unknown } | undefined)?.review === "user") continue;
      const wait = parseUserWait(task.blocker);
      if (!wait) continue;
      if (userUnblockWasAsked(ctx, task.content, wait.question)) continue;
      const askedAt = lastUserUnblockAsk(ctx, task.content);
      if (!userUnblockAskDue(askedAt, latestUserRequestAt)) continue;
      userUnblockDue.push({ row: task.content, question: wait.question });
      const content = `Ask the user now: ${task.content} — ${wait.question}`;
      sendHarnessNotice(USER_UNBLOCK_CUSTOM_TYPE, task.content, content, { row: task.content, question: wait.question, at: now }, `${content}:${userMessageEpoch}`);
    }
    const ready = (decision.dispatchableReady ?? []).filter((row) => openContents.has(row.content));
    const idle = open.length - running.length - (decision.externallyStaffedCount ?? 0);
    // A row naming an owner that runs nowhere looks staffed in the HUD and is not (user 2026-09-25:
    // "Owner not running - run it!!!!"): name each one so it is resumed by its exact name.
    // The HUD's "N unresolved": open rows omp cannot forecast. Nobody but the chief can fix them.
    const unresolved = rows.filter((row) => undeliveredUserWait(row) || (openContents.has(row.content) && isOpenRowStatus(row.status) && row.fixedPathP95Finish === undefined && !row.awaitingPrerequisite));
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
      .filter(({ task }) => task.status === "blocked" && typeof task.blocker === "string" && isDistantWaitReason(task.blocker) &&
        !(task.schedule?.dependencies ?? []).some(dependency => phasesNow.some(phase => phase.tasks.some(row => row.content === dependency && isNonClosedRowStatus(row.status)))))
      .map(({ task }) => `DROP blocked row ${JSON.stringify(task.content)} (${JSON.stringify(task.blocker)}); record a trigger note "when X changes -> do Y". Reserve blocked for waits of hours.`);
    const workerRows = workerInfos.flatMap(({ id, row, trace, age, p95Text }) => {
      if (!row) return [];
      const wrote = trace.wrote.length ? trace.wrote.join(",") : "none";
      return [`${id} row=${JSON.stringify(shorten(row.content))} last=${trace.lastTool} age=${minutes(age)} wrote=${wrote} P95=${p95Text}`];
    });
    const workerStatus = workerRows.length
      ? `Worker status: ${workerRows.slice(0, 8).join(" | ")}${workerRows.length > 8 ? ` | … ${workerRows.length - 8} more` : ""}`
      : "";
    const sizing = (await Promise.all(running.map(async job => {
      if (workerSizingNoticed.has(job.id)) return [];
      const id = job.agentId ?? job.id;
      const observed = activityByName.get(id);
      const compactedAt = observed ? await workerCompactionAt(observed) : undefined;
      if (compactedAt !== undefined) return [{ id, jobId: job.id, fact: `compacted at ${hhmm(compactedAt, decision.deadline?.timezone)}` }];
      if (typeof job.startTime === "number" && now - job.startTime > SILENT_MS)
        return [{ id, jobId: job.id, fact: `running ${minutes(now - job.startTime)}` }];
      return [];
    }))).flat();
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
    const ownerOf = new Map<string, string>();
    try {
      for (const phase of phasesNow)
        for (const task of phase.tasks) if (typeof task.schedule?.owner === "string") ownerOf.set(task.content, task.schedule.owner);
    } catch {}
    const unread = unreadReceiptRows(ctx, open);
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
      ...acceptedClosingProblems,
      ...(acceptedMergeDemand ? [acceptedMergeDemand] : []),
      ...(userUnblockDue.length ? userUnblockDue.map(({ row, question }) => `Ask the user now: ${row} — ${question}`) : []),
      ...staleWorkers,
      ...overrunWorkers,
      ...distantBlocked,
      planningAdvice,
      unread.length ? `${unread.length} worker result(s) came back and their rows are still open: ${names(unread)}. Read each receipt and close its row or send it back with the reason before restaffing that row (skill step 4)` : "",
      finishDelayNotice,
      receding,
      checkins.length ? `${checkins.length} overdue worker check-in(s): ${checkins.slice(0, 6).map((worker) => worker.sent ? `overdue check-in ${worker.repeated ? "already " : ""}sent to ${worker.id} for ${JSON.stringify(shorten(worker.row))}; ${worker.activityText}` : `overdue check-in blocked for ${worker.id}: ${worker.text ?? missingWorkerMessageApi}; chief must write agent://${worker.id} manually`).join("; ")}${checkins.length > 6 ? `; … ${checkins.length - 6} more` : ""}` : "",
      sizing.length ? `worker sizing: ${sizing.map((worker) => `${worker.id} ${worker.fact}; write agent://${worker.id} asking for done/left with a receipt, then split the rest`).join("; ")}` : "",
      ...overlapWarnings,
      silent.length ? `${silent.length} running worker(s) silent: ${silent.slice(0, 6).map((worker) => `${worker.name} (${worker.lastAt === undefined ? "no activity since start" : "last activity"} ${minutes(worker.ageMs)} ago)`).join(", ")}; write agent://<id> asking what it waits on. Workers not named here are active: their results arrive by themselves, so do not read their history` : "",
      ...serialQueues,
      ...await criticalWorkerWarnings(ctx, open, running),
      understaffed && (hasReplannableWait(decision) || waitingCritical.includes("queued behind"))
        ? prompt.render(waitingWorkInstructions, { capacity, waitingRows: waitingCritical }).trim() : "",
      missing ? `${missing} planning issue(s) (missing estimates or dependencies) need row-local repair; independent work remains available` : "",
      overdue.length ? `${overdue.length} late row(s): ${lateRowLines.join("; ")}` : "",
      firstDeliveryLate ? `first user handoff forecast is later than its 30-minute request window or the deadline for ${JSON.stringify(firstDeliveryLate)}; cut scope and ship the smallest visible piece first` : "",
      unresolved.length ? `${unresolved.length} row(s) have no forecast (the TODO header's "unresolved"); ${unresolvedForecastRemedy(unresolved)}` : "",
      unlinked.length ? `${unlinked.length} running worker(s) own no row: ${unlinked.slice(0, 6).map((job) => job.id).join(", ")}` : "",
      deadOwners.length ? `${deadOwners.length} ready row(s) name an owner that is not running; staff them in one task call, one item per row with name = that owner and task = the row's exact title plus what to return: ${deadOwners.slice(0, 6).map((row) => `${JSON.stringify(shorten(row.content))} (owner ${row.owner})`).join(", ")}${deadOwners.length > 6 ? `, … ${deadOwners.length - 6} more` : ""}` : "",
      ready.length && running.length < workerCapacity(ctx) ? `${ready.length} ready row(s) have no worker: ${names(ready)}` : "",
      ready.length > capacity - running.length && idle > capacity ? `${idle} idle rows for ${capacity} worker slots: prune before adding` : "",
    ].filter(Boolean);
    trackDemands([
      ...(receding.includes("plan-doctor") ? ["todo-plan-doctor"] : []),
      ...(pendingReplan || unresolved.length ? ["todo-replan"] : []),
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
      ? prompt.render(planCheckInstructions, {count: problems.length, problems: problems.map((line, i) => `(${i + 1}) ${line}`).join(" "), workerStatus}).trim()
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
      const dir = TODO_DISPATCH_STATE_DIR;
      mkdirSync(dir, { recursive: true });
      const session = ctx.sessionManager?.getHeader?.()?.id ?? "unknown";
      appendFileSync(join(dir, `${session}.gate.jsonl`), `${JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, plantick: reason, ticks: planTickCount, ...detail })}\n`);
    } catch {}
  };
  const absenceTick = (ctx: ExtensionContext, now: number) => {
    const jobs = ctx.getAsyncJobSnapshot();
    const finished = (jobs?.recent ?? []).filter((job) => job.type === "task").map((job) => `${job.id}:${job.status}`).join("|");
    const busy = ctx.isIdle?.() !== true || ctx.hasPendingMessages?.() === true;
    const working = (jobs?.running ?? []).some((job) => job.type === "task" && job.status === "running");
    if (busy) { absence.jobStamp = finished; return; }
    // After the final wrap-up the lead stays silent until a user message (resets above) or a worker result.
    if (absence.stage === 2) {
      if (finished !== absence.jobStamp) { absence.stage = 0; absence.lastWakeAt = now; absence.jobStamp = finished; }
      else return;
    }
    if (working) return;
    const rows = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never).flatMap((phase) => phase.tasks);
    if (!rows.some((row) => isNonClosedRowStatus(row.status))) return;
    const lastUserAt = latestUserRequestAt ?? absence.startedAt;
    if (now - Math.max(lastUserAt, absence.lastWakeAt) < ABSENCE_AFTER_MS) return;
    const delivery = { triggerTurn: true, interruptWait: false };
    if (absence.stage === 1 && progressEvents === absence.progressMark) {
      absence.stage = 2;
      sendHarnessNotice("todo-user-absent", "wrap-up", USER_ABSENT_WRAPUP, { stage: "wrap-up", at: now }, `wrap-up:${now}`, delivery);
    } else {
      absence.stage = 1;
      const clock = formatLocalClock(lastUserAt, sdk.readGoalDeadline(dispatchStateEntries(ctx), ctx.cwd, { includePaused: true })?.timezone);
      sendHarnessNotice("todo-user-absent", "absent", userAbsentText(clock), { stage: "absent", at: now, lastUserAt }, `absent:${now}`, delivery);
    }
    absence.lastWakeAt = now;
    absence.progressMark = progressEvents;
    absence.jobStamp = finished;
  };
  const planTick = async (ctx: ExtensionContext) => {
    checkDeliveries(ctx);
    await pollPreview(ctx);
    lastPlanTickAt = Date.now();
    planTickCount += 1;
    try {
      // ctx.hasPendingMessages() is not a guard: the notice is an aside, which the queue delivers in
      // order, and a flag stuck true silenced the ticker for a whole session.
      if (singleWriterLane) return planTrace(ctx, "single-writer-lane");
      if (pauseGate?.paused) return planTrace(ctx, "pause-gate");
      if (!isMain(ctx)) return planTrace(ctx, "not-main");
      if (!pi.getActiveTools().includes("task")) return planTrace(ctx, "task-tool-inactive");
      if (!gateSwitchedOff(ctx)) await refreshPush(ctx);
      if (isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) return planTrace(ctx, "user-deadline-missed");
      await refreshLiveWorkerModels(ctx);
      if (!gateSwitchedOff(ctx)) absenceTick(ctx, Date.now());
      const planCheckText = await planCheck(ctx, [], true);
      let check = planCheckText;
      const urgent = wakeDemand(todoPhases(ctx), runningOwnerNames(ctx), Date.now(), currentDecision(ctx).deadline?.deadlineAt, currentDecision(ctx).forecast?.expectedResourceFinish, pendingWorkerQuestions(ctx), ctx);
      if (!check && urgent) check = prompt.render(dispatchWakeInstructions, { ...urgent, misses: 0 }).trim();
      if (!check) return planTrace(ctx, "no-problems");
      if (check === PLAN_CHECK_CLEAN) return planTrace(ctx, "plan-clean");
      // Once per distinct problem list. Minutes and timestamps change every tick; the problem list is the
      // same unless the words change. Something that happened since the last delivery (a user message, a
      // worker result, a row or status change) makes the same list worth delivering again.
      const now = Date.now();
      const key = lastPlanProblems
        .replace(/\(\d+\) planning round due:.*?\(skill:\/\/chief-of-staff Planning\)\s*/g, "")
        .replace(/\(\d+\) worker sizing:.*?(?= \(\d+\) |\. Fix them with the pass|$)/g, "")
        .replace(/\s+/g, " ")
        .replace(/\d+/g, "#");
      if (gateSwitchedOff(ctx)) return planTrace(ctx, "switched-off");
      const eventStamp = JSON.stringify([
        userMessageEpoch,
        (ctx.getAsyncJobSnapshot()?.recent ?? []).filter((job) => job.type === "task").map((job) => `${job.id}:${job.status}`),
        sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never).flatMap((phase) => phase.tasks.map((task) => `${task.content}:${task.status}`)),
        planCheckText ? null : urgent?.key ?? null,
      ]);
      const unchanged = key === lastIdlePlanCheck && eventStamp === lastPlanEventStamp;
      if (pendingSizingNoticeIds.length === 0 && unchanged && (planCheckText || !urgent || retryRemaining(ctx, urgent.key) > 0)) return planTrace(ctx, "same-problems-already-delivered");
      lastPlanEventStamp = eventStamp;
      if (!unchanged) lastIdlePlanCheckAt = now;
      lastIdlePlanCheck = key;
      // Digest the stable key, not the rendered text: only a changed problem list or an escalation
      // (the stuck-worker and receding-finish wording changes at 30/60/20 min) delivers again.
      // An idle lead has no next step for an aside to land on: wake it, or open rows sit untouched
      // until the user writes (live 2026-10-27: two leads idle 23:26-00:57 with ready rows unstaffed).
      const planRows = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never)
        .flatMap((phase) => phase.tasks)
        .filter((row) => isOpenRowStatus(row.status))
        .map((row) => row.content);
      sendHarnessNotice("todo-plan-check", key, check, { planRows }, `${key}|${eventStamp}|${planTickCount}`, { interruptWait: activeRecoveries(ctx).length > 0, triggerTurn: ctx.isIdle?.() === true });
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
  const handleToolResult = async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (!event.isError && recovery?.pending && isMain(ctx)) {
      const pending = recovery.pending;
      const ownerQuestion = pending.kind === "deadline" && selectBranchEntries(ctx.sessionManager, metadata => metadata.customType === "todo-user-unblock" || metadata.customType === "lead-plan-critic-question").some(entry => {
        const data = entry.data ?? entry.details;
        const at = data?.at ?? Date.parse(entry.timestamp);
        return at >= pending.at && (entry.customType === "lead-plan-critic-question" || data?.asked === true) &&
          pending.baseline.flatMap(phase => phase.tasks).some(row => row.content === data?.row);
      });
      if (ownerQuestion || (["todo", "task"].includes(event.toolName) && recoveryActionObserved(pending, todoPhases(ctx), runningOwnerNames(ctx)))) {
        satisfyRecovery(ctx);
        if (wakeTurn) wakeTurn.mutations += 1;
      }
    }
    if (wakeTurn && !event.isError) {
      const phases = todoPhases(ctx);
      if (wakeTurn.chain) {
        if (waitChainAction(wakeTurn.chain, event.toolName, event.input, wakeTurn.before, phases)) wakeTurn.mutations += 1;
        if (event.toolName === "todo") wakeTurn.rejection = waitChainRejection(wakeTurn.chain, phases);
      } else if ((!recovery?.pending || wakeTurn.target) && countsAsWakeAction(event.toolName, event.input, wakeTurn.before, phases, wakeTurn.target)) wakeTurn.mutations += 1;
      wakeTurn.before = structuredClone(phases);
    }
    if (!event.isError && isMain(ctx)) {
      if (event.toolName === "read") {
        const details = event.details as ReadToolDetails | undefined;
        // Truncated roots stay unread; request a concise complete receipt from the same owner, then read its root.
        const truncated = details?.truncation !== undefined || details?.meta?.truncation !== undefined ||
          (details?.summary?.elidedLines ?? 0) > 0 || (details?.summary?.elidedSpans ?? 0) > 0;
        const job = !truncated && ctx.getAsyncJobSnapshot()?.recent.find(job => job.type === "task" && job.status === "completed" &&
          [job.id, job.agentId].some(owner => owner && (event.input?.path === `agent://${owner}` || event.input?.path === `agent://${owner}:raw`)));
        if (job) {
          sprintState.receiptReadKeys = [...new Set([...(sprintState.receiptReadKeys ?? []), receiptKey(job)])].slice(-MAX_NOTICE_KEYS);
          persistSprintState();
        }
      }
      if (event.toolName === "todo" && (event.details as { op?: unknown } | undefined)?.op === "schedule") {
        const rows = todoPhases(ctx).flatMap(phase => phase.tasks);
        for (const update of todoScheduleUpdates(event.input)) {
          if (!nonEmptyString(update.evidence)) continue;
          const row = rows.find(row => row.content === update.task);
          const job = row && receiptJobForRow(ctx, { owner: row.schedule?.owner });
          if (!job || !sprintState.receiptReadKeys?.includes(receiptKey(job))) continue;
          sprintState.receiptReconciledKeys = [...new Set([...(sprintState.receiptReconciledKeys ?? []), JSON.stringify([receiptKey(job), row.content])])].slice(-MAX_NOTICE_KEYS);
          persistSprintState();
        }
      }
    }
    if (event.toolName === "todo" && !event.isError) await refreshPush(ctx, true);
    if (previewConfig(ctx).enabled && isMain(ctx)) {
      if (event.toolName === "todo" && !event.isError) {
        const exception = previewReason(event.input);
        if (exception) {
          const before = previewRecords(ctx);
          const records = before.map(record => record.task === exception.task ? { ...record, reason: exception.reason } : record);
          if (!records.some(record => record.task === exception.task)) records.push({ task: exception.task, commit: "", reason: exception.reason });
          if (JSON.stringify(records) !== JSON.stringify(before)) pi.appendEntry(PREVIEW_ENTRY_TYPE, { records });
        }
      }
      const results = event.details?.results;
      if (Array.isArray(results)) {
        const records = previewRecords(ctx);
        const next = [...records];
        const rows = ((ctx.getTodoSnapshot?.() ?? ctx.getTodoPhases?.()) ?? []).flatMap(phase => phase.tasks);
        for (const result of results) {
          if (result?.exitCode !== 0 || typeof result.branchName !== "string" || typeof result.branchBaseSha !== "string") continue;
          const matchingRows = rows.filter(row => row.schedule?.executor?.workerId === result.id || row.schedule?.attemptHistory?.some(attempt => attempt.workerName === result.id) || (!row.schedule?.executor && typeof row.schedule?.owner === "string" && liveJobMatchesOwner({ id: result.id }, row.schedule.owner)));
          if (!matchingRows.length) continue;
          try {
            const repo = vcs.git(ctx.cwd);
            const commit = await repo?.resolveRef(result.branchName);
            if (commit && commit !== result.branchBaseSha) for (const row of matchingRows)
              if (!next.some(record => record.task === row.content && record.commit === commit)) next.push({ task: row.content, commit });
          } catch {}
        }
        if (JSON.stringify(next) !== JSON.stringify(records)) pi.appendEntry(PREVIEW_ENTRY_TYPE, { records: next });
      }
    }
    healPlanTicker(ctx);
    await pollPreview(ctx);
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
    if (event.toolName === "todo") {
      // Only a successful tool result proves init passed validation and began a new objective.
      if (!event.isError && isMain(ctx) && (event.details as { op?: unknown } | undefined)?.op === "init")
        resetFinishHistory(ctx);
      if (event.isError || !isMain(ctx) || !pi.getActiveTools().includes("task")) return;
      // The hook runs before this result joins the branch: check the plan the call just produced
      // (live 21:32: an owner written by this very call was reported as missing).
      const details = (event as { details?: unknown }).details;
      const pendingTodo = details ? [{ type: "message", message: { role: "toolResult", toolName: "todo", details } }] : [];
      if ((event.details as { op?: unknown } | undefined)?.op === "init") requirementRowsSeen.clear();
      updateTodoSchedule(ctx, (phases) => phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((task) => {
          const isNew = !requirementRowsSeen.has(task.content);
          requirementRowsSeen.add(task.content);
          if (!isNew || !isNonClosedRowStatus(task.status) || task.schedule?.firstRequirementAt !== undefined) return task;
          return { ...task, schedule: { ...task.schedule, firstRequirementAt: latestUserRequestAt ?? Date.now() } };
        }),
      })));
      const updates = todoScheduleUpdates(event.input);
      for (const update of updates) {
        if (typeof update.task !== "string" || !["accepted", "redo", "drop"].includes(String(update.review))) continue;
        const content = prompt.render(gateNoticeInstructions, {
          customerVerdict: true,
          reviewedRow: update.task,
          accepted: update.review === "accepted",
          correction: typeof update.evidence === "string" ? update.evidence : "Use the customer's actual words from the conversation.",
        }).trim();
        sendHarnessNotice(USER_REVIEW_CUSTOM_TYPE, update.task, content, { row: update.task, verdict: update.review, reviewPage: update.reviewPage }, content);
      }
      for (const update of updates) {
        const patch = update.schedule ?? update;
        if (!Array.isArray(patch.resources)) continue;
        const row = todoPhases(ctx).flatMap(phase => phase.tasks).find(row => row.content === (update.task ?? update.content));
        const owner = row?.schedule?.owner ?? row?.schedule?.executor?.workerId;
        if (typeof owner !== "string" || !currentRowOwner(row, owner)) continue;
        const registry = AgentRegistry.global();
        const worker = registry.get(owner);
        // A scope update changes the live grant; it never starts another attempt.
        if (!worker || !registry.isRunning(worker) || (worker.todoRow && worker.todoRow !== row.content)) continue;
        await worker.session?.steer(prompt.render(gateNoticeInstructions, { scopeChanged: true, row: JSON.stringify(row.content), resources: JSON.stringify(patch.resources) }).trim(), undefined, { passive: true });
      }
      for (const update of updates) if (typeof update.task === "string" && (update.estimate !== undefined || typeof update.evidence === "string")) rescheduledRowsThisTurn.add(update.task);
      for (const update of updates) {
        if (typeof update.owner !== "string" || typeof update.task !== "string") continue;
        sendHarnessNotice("todo-gate-steering", `${update.task}:${update.owner}`, prompt.render(gateNoticeInstructions, { steering: true, row: JSON.stringify(update.task), owner: update.owner }).trim());
      }
      const hints = scheduleCalibrationHints(event, ctx, pendingTodo);
      const hintPart = hints.length ? [{ type: "text" as const, text: hints.join("\n"), harnessNotice: true as const }] : [];
      const check = await planCheck(ctx, pendingTodo);
      if (!check) return hintPart.length ? { content: [...(event.content ?? []), ...hintPart] } : undefined;
      markSizingNotices();
      return { content: [...(event.content ?? []), ...hintPart, { type: "text" as const, text: check, harnessNotice: "record" as const }] };
    }
    if (event.toolName !== "task") return;
    lastTaskDispatchRefused = Boolean(event.isError);
    if (!event.isError && isRetroFacilitatorTaskResult(event)) {
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
        settleSprintJobs(settled, Date.now());
        if (settled.length > 0) persistSprintState();
        const completedIds = new Set(settled.filter((job) => job.status === "completed").flatMap((job) => [job.id, job.agentId].filter((id): id is string => typeof id === "string")));
        if (completedIds.size) {
          const resultById = new Map(details.results.flatMap((value) => {
            if (typeof value !== "object" || value === null || typeof value.id !== "string") return [];
            return [[value.id, value] as const];
          }));
          const delivered: Array<Record<string, unknown>> = [];
          updateTodoSchedule(ctx, (phases) => phases.map((phase) => ({
            ...phase,
            tasks: phase.tasks.map((row) => {
              const schedule = (row.schedule ?? {}) as Record<string, unknown>;
              const owner = typeof schedule.owner === "string" ? schedule.owner : "";
              const worker = [...completedIds].find((id) => liveJobMatchesOwner({ id }, owner));
              if (!worker) return row;
              const result = resultById.get(worker) as { output?: unknown } | undefined;
              const output = typeof result?.output === "string" ? result.output.trim() : "";
              if (queueDeliveryCritic(ctx, row, output, options.deliveryCriticRecord, Date.now(), previewRecords(ctx).find(record => record.task === row.content)?.previewPath)) return row;
              if (!todoNeedsOwnerDecision(schedule)) return row;
              const summary = output.split(/\n\s*\n/).at(-1)?.trim().slice(-800);
              const updated = { ...row, schedule: {
                ...schedule,
                review: "user",
                firstDeliveredAt: schedule.firstDeliveredAt ?? Date.now(),
                ...(summary ? { reviewSummary: summary } : {}),
              } };
              delivered.push(updated);
              return updated;
            }),
          })));
          for (const row of delivered) {
            const content = rowReviewNotice(row);
            pi.sendMessage({ customType: USER_REVIEW_CUSTOM_TYPE, content, details: { row: row.content, at: Date.now() }, display: true, attribution: "agent" }, { deliverAs: "nextTurn", triggerTurn: false, interruptWait: false });
          }
        }
      }
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
  };
  const staffingNotices = new WeakSet<object>();
  pi.on("tool_result", async (event, ctx) => {
    let result = await handleToolResult(event, ctx);
    const nag = zeroActiveNag(ctx);
    const content = result?.content ?? event.content ?? [];
    if (nag && !isStaffingCall(event.toolName, event.input)) {
      // The device wrapper forwards inner result blocks through this hook again.
      // Track our own blocks, preserving tool-authored text and other notices.
      if (content.some(part => staffingNotices.has(part))) result = { ...result, content };
      else {
        const notice = { type: "text" as const, text: nag, harnessNotice: true as const };
        staffingNotices.add(notice);
        result = { ...result, content: [notice, ...content] };
      }
    }
    else if (event.toolName === "task" && !event.isError)
      result = { ...result, content: [...(result?.content ?? event.content ?? []), { type: "text", text: staffingAdvice.trim(), harnessNotice: true as const }] };
    return result;
  });

  let calibrationKey = "";
  const appendLeadTimeNote = async (ctx: ExtensionContext, onlyPlanFact = false) => {
    await getTodoPlanCalibrationStore().refresh();
    const nextCalibrationKey = JSON.stringify(getTodoPlanCalibrationStore().snapshot(Date.now()));
    if (nextCalibrationKey !== calibrationKey) { calibrationKey = nextCalibrationKey; cachedDecision = null; }
    const now = Date.now();
    if (singleWriterLane) return;
    const decision = currentDecision(ctx, now);
    const chief = isMain(ctx) && pi.getActiveTools().includes("task");
    if (!decision.prompt && !chief) return;
    const attemptedIdleOwners = decision.readyCandidates
      .filter((row) => row.ownership === "idle-live-owner" && row.owner && idleResumeAttempts.has(row.owner))
      .map((row) => row.owner!);
    const phases = sdk.getLatestTodoPhasesFromEntries(todoStateEntries(ctx) as never);
    const facts = chief ? await integrationFacts(ctx, now) : "";
    const notice = isMain(ctx) ? returnNotice : null;
    const reviewAnswers = new Set(phases.flatMap(phase => phase.tasks).filter(row => row.schedule?.review === "user" && (latestUserRequestAt ?? (latestBranchUserMessage(ctx.sessionManager)?.at ?? 0) * 1_000) > (row.schedule.firstDeliveredAt ?? Infinity)).map(row => row.content));
    const userBlockAsked = new Set(phases.flatMap(phase => phase.tasks).filter(row => {
      const wait = parseUserWait(row.blocker);
      return wait && userUnblockWasAsked(ctx, row.content, wait.question);
    }).map(row => row.content));
    const displayContext = leadDisplayContext(ctx, phases, decision);
    const blocks: RowBlock[] = chief ? renderLeadRowBlocks(phases, displayContext, { now, forecast: decision.forecast, reviewAnswers, userBlockAsked, dispatchRefusals: assignedResourceRefusals(phases, ctx), compact: true }).map(block => {
      const record = phases.flatMap(phase => phase.tasks).find(row => row.content === block.row);
      return { ...block, sig: Bun.hash(JSON.stringify([block.text, record?.status, record?.schedule?.owner, record?.blocker])).toString(16) };
    }) : [];
    const rowInstructions = blocks.map(block => block.text).join("\n");
    const visibleRows = chief ? phases.flatMap(phase => phase.tasks).filter(row => isNonClosedRowStatus(row.status) || isTodoAwaitingReview(row)).map(row => classifyTodoDisplayRow(row, phases, displayContext)) : [];
    const questions = phases.flatMap(phase => phase.tasks).filter(row => row.status === "blocked" && row.schedule?.owner && row.blocker && !parseUserWait(row.blocker))
      .map(row => ({ worker: row.schedule.owner, question: row.blocker }));
    questions.push(...pendingWorkerQuestions(ctx));
    const anchor = rehydrateDeadlineState(dispatchStateEntries(ctx));
    const slipDeadline = anchor?.baselineDeadlineAt === undefined ? decision.deadline?.deadlineAt : anchor.baselineDeadlineAt * 1_000;
    const planFact = renderPlanFactNote(phases, now, slipDeadline, questions,
      decision.forecast?.expectedResourceFinish);
    if (onlyPlanFact && (!planFact || questions.length === 0)) return;
    const workOpen = Boolean(decision.prompt || phases.some((phase) => phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress")));
    const semanticKey = JSON.stringify({
      notice: notice && !notice.shown ? notice.text : null,
      chief,
      facts: facts.replace(/\b\d+ min\b/g, "<minutes>"),
      refused: chief && lastTaskDispatchRefused,
      activeDemand: chief ? activeDemand : null,
      rowInstructions,
      planFact,
      plan: decision.key,
      alarms: decision.alarms.filter((alarm) => !alarm.startsWith("overdue-todo-minute:")),
      deadline: decision.deadline ?? null,
      attemptedIdleOwners,
    });
    // Retained deltas can refer to full instructions lost during compaction.
    // Only a note delivered against the current canonical boundary can be the baseline.
    const modelContext = dispatchModelContext(ctx);
    const deliveredWindow = deliveredNoteWindow(modelContext.messages, "todo-dispatch-time-note");
    if (deliveredWindow && !timedNoteDue(ctx, "todo-dispatch-time-note", semanticKey, workOpen, now)) return;
    const projected = projectRowBlocks(blocks, deliveredWindow,
      kind => prompt.render(gateNoticeInstructions, { rowInstruction: true, bare: true, scopeParagraph: kind === "scope", staffingParagraph: kind === "staffing" }).trim(),
      delta => prompt.render(gateNoticeInstructions, { rowDelta: true, ...delta, multiple: "count" in delta && delta.count !== 1 }).trim());
    // The summary's explanatory paragraph never changes; the status line is the only per-note part.
    const summary = chief ? prompt.render(leadTimeSummary, {
      open: decision.forecast?.rows.filter(row => row.status !== "completed" && row.status !== "abandoned").length ?? 0,
      running: decision.activeTaskCount ?? 0,
      ready: visibleRows.filter(row => row.state === "needs worker").length,
      lost: visibleRows.filter(row => row.state === "needs worker" && row.reason === "lost").length,
      forecast: null,
    }).trim() : "";
    const content = [
      ...(planFact ? [planFact] : []),
      ...(decision.forecast ? [renderCurrentSetForecast(decision.forecast, rehydrateDeadlineState(dispatchStateEntries(ctx)), now)] : []),
      ...(notice && !notice.shown ? [notice.text] : []),
      ...(summary ? [deliveredWindow ? summary.split("\n")[0]! : summary] : []),
      ...(projected.text ? [projected.text] : []),
      ...(facts ? [facts] : []),
      ...(chief && lastTaskDispatchRefused ? ["The last task dispatch was refused; bounded work is open to you until the ready row can be dispatched."] : []),
      ...(chief && activeDemand ? [`NEXT STEP (advice; no call is skipped or refused for it): ${activeDemand}`] : []),
    ].join("\n");
    const appended = await appendTimedNote(
      pi,
      ctx,
      "todo-dispatch-time-note",
      content,
      semanticKey,
      formatLocalClock(now, decision.deadline?.timezone),
      workOpen,
      now,
      { membershipFingerprint: decision.forecast?.membershipFingerprint, predictionVersion: decision.forecast?.predictionVersion,
        anchorId: rehydrateDeadlineState(dispatchStateEntries(ctx))?.autoAnchorId, rows: projected.rows, shared: projected.shared, contextBoundary: noteContextBoundary(modelContext.messages) },
      !deliveredWindow,
    );
    if (appended && notice) notice.shown = true;
  };

  pi.on("turn_end", async (_event, ctx) => {
    if (wakeTurn && isMain(ctx)) {
      const decision = currentDecision(ctx);
      const demand = wakeDemand(todoPhases(ctx), runningOwnerNames(ctx), Date.now(), decision.deadline?.deadlineAt, decision.forecast?.expectedResourceFinish, pendingWorkerQuestions(ctx), ctx);
      if (demand && wakeTurn.mutations === 0 && !wakeTurn.rejection) {
        const previous = selectLatestBranchEntry(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === "todo-dispatch-action-demand")?.data as WakeReceipt | undefined;
        const misses = Math.min(100, previous?.key === demand.key ? previous.misses + 1 : 1);
        const noToolMisses = (previous?.key === demand.key ? previous.noToolMisses ?? 0 : 0) + 1;
        const receipt: WakeReceipt = { recovery: structuredClone(recovery), key: demand.key, row: demand.row, action: demand.action, misses, noToolMisses, resetAt: previous?.resetAt, retryAt: Date.now() + wakeRetryMs(misses), toolCalls: wakeTurn.toolCalls, mutations: 0 };
        pi.appendEntry("todo-dispatch-action-demand", receipt);
        // Passive advice cannot create a self-sustaining follow-up loop.
        if (misses >= 5) {
          const priorNotice = [...selectBranchNewestFirst(ctx.sessionManager, metadata => metadata.type === "custom" && metadata.customType === "todo-dispatch-ignored-notice")].some(entry => entry.data?.key === demand.key);
          if (!priorNotice) {
            pi.appendEntry("todo-dispatch-ignored-notice", { key: demand.key });
            pi.sendMessage({ customType: "todo-dispatch-ignored", content: prompt.render(dispatchIgnoredInstructions, demand).trim(), display: true, attribution: "agent" }, { deliverAs: "aside", triggerTurn: false, interruptWait: false });
          }
        }
        // An identical demand still in the model context adds only a counter. Repeat it at the escalation
        // steps (label change at 2, ignored-turn threshold at 5) and whenever compaction dropped the earlier message.
        const escalationDue = misses === 2 || misses === 5;
        const content = prompt.render(dispatchWakeInstructions, { ...receipt, escalation: misses > 1 }).trim();
        if (escalationDue || !deliveredDispatchAction(ctx, content)) pi.sendMessage({ customType: "todo-dispatch-action-required", content, display: false, attribution: "agent" }, { deliverAs: "aside", triggerTurn: false, interruptWait: false, supersedes: "todo-dispatch-action-required" });
      }
      if (wakeTurn.rejection) pi.appendEntry("todo-dispatch-action-demand", { recovery: structuredClone(recovery), key: wakeTurn.chain.key, action: wakeTurn.chain.action, edges: wakeTurn.chain?.edges, rejection: wakeTurn.rejection, misses: 0, noToolMisses: 0, retryAt: undefined, resetAt: Math.max(Date.now(), (recoveryReceipt(ctx)?.resetAt ?? 0) + 1), toolCalls: wakeTurn.toolCalls, mutations: 0 });
      if (wakeTurn.mutations > 0) pi.appendEntry("todo-dispatch-action-demand", { recovery: structuredClone(recovery), key: demand?.key ?? "resolved", action: demand?.action ?? "", misses: 0, noToolMisses: 0, retryAt: undefined, resetAt: Math.max(Date.now(), (recoveryReceipt(ctx)?.resetAt ?? 0) + 1), toolCalls: wakeTurn.toolCalls, mutations: wakeTurn.mutations });
      wakeTurn.toolCalls = 0;
      wakeTurn.mutations = 0;
      wakeTurn.before = structuredClone(todoPhases(ctx));
      wakeTurn.target = demand?.churn ? demand.row : undefined;
      wakeTurn.chain = chainDemand(todoPhases(ctx));
      wakeTurn.demandKey = demand?.key;
      wakeTurn.rejection = undefined;
    }
    releaseLapsedPostDeadline(ctx);
    checkDeliveries(ctx);
    announceGates(ctx);
    if (isMain(ctx)) {
      for (const row of pendingReview(todoPhases(ctx))) {
        const rowName = String(row.content);
        const content = `Handoff required: ${rowReviewNotice(row)}\n${prompt.render(gateNoticeInstructions, { customerReview: true, reviewedRow: rowName }).trim()}`;
        sendHarnessNotice(USER_REVIEW_CUSTOM_TYPE, rowName, content, { row: rowName, at: Date.now() }, content);
      }
      const decision = currentDecision(ctx);
      for (const row of decision.forecast?.rows ?? []) {
        if (row.status !== "blocked" || !row.waitsForUser) continue;
        if (userUnblockWasAsked(ctx, row.content, row.waitsForUser.question)) continue;
        const finalText = ctx.getLastAssistantText?.() ?? "";
        if (finalText.includes(row.content) && finalText.includes(row.waitsForUser.question)) {
          pi.appendEntry(USER_UNBLOCK_CUSTOM_TYPE, { row: row.content, question: row.waitsForUser.question, at: Date.now(), asked: true });
          continue;
        }
        const askedAt = lastUserUnblockAsk(ctx, row.content);
        if (!userUnblockAskDue(askedAt, latestUserRequestAt)) continue;
        const content = `Ask the user now: ${row.content} — ${row.waitsForUser.question}`;
        const at = Date.now();
        sendHarnessNotice(USER_UNBLOCK_CUSTOM_TYPE, row.content, content, { row: row.content, question: row.waitsForUser.question, at }, `${content}:${userMessageEpoch}`);
      }
    }
    await appendLeadTimeNote(ctx);
  });
  // Context shaping is append-only: all model-facing reminders are persisted at turn end.
  pi.on("context", async (event, ctx) => {
    await refreshLiveWorkerModels(ctx);
    if (!singleWriterLane && isMain(ctx)) { await refreshMerge(ctx, Date.now()); await refreshPush(ctx); }
    if (!singleWriterLane && !isUserDeadlineMissed(rehydrateDeadlineState(latestDeadlineStateEntries(ctx)))) currentDecision(ctx);
    // Startup warnings may have been queued before child restoration. Revalidate at consumption.
    const isStaffing = message => message.role === "custom" && message.customType === "todo-gate-staffing";
    // The visible ignored-demand notice is historical UI telemetry. Its demand
    // may already be closed; the revalidated snapshot below owns model advice.
    // Keep the journal and actual user/peer/worker messages untouched.
    const isIgnoredDemand = message => message.role === "custom" && message.customType === "todo-dispatch-ignored" && message.attribution === "agent";
    let messages = isMain(ctx) && event.messages.some(isIgnoredDemand) ? event.messages.filter(message => !isIgnoredDemand(message)) : event.messages;
    // Queue replacement ends at delivery. Project only the current dispatcher snapshot,
    // and collapse identical no-tool replies inside uninterrupted internal-wake exchanges.
    // Human/peer input, visible notices and tool work are lossless sequence boundaries.
    const isActionWake = message => message.role === "custom" && message.customType === "todo-dispatch-action-required" && message.display === false && message.attribution === "agent";
    if (isMain(ctx) && messages.some(isActionWake)) {
      const latest = messages.findLast(isActionWake);
      const decision = currentDecision(ctx);
      const demand = wakeDemand(todoPhases(ctx), runningOwnerNames(ctx), Date.now(), decision.deadline?.deadlineAt, decision.forecast?.expectedResourceFinish, pendingWorkerQuestions(ctx), ctx);
      const receipt = recoveryReceipt(ctx);
      const misses = demand && receipt?.key === demand.key ? receipt.misses : 0;
      const removed = new Set<number>();
      const replies = new Map<string, number>();
      let pendingWake = false;
      for (const [index, message] of messages.entries()) {
        if (isActionWake(message)) {
          if (message !== latest || !demand) removed.add(index);
          pendingWake = true;
        } else if (pendingWake && message.role === "assistant" && message.content.every(part => part.type === "text" || part.type === "thinking") && !message.errorMessage && message.stopReason !== "error" && message.stopReason !== "aborted") {
          const identity = JSON.stringify(message.content);
          const previous = replies.get(identity);
          if (previous !== undefined) removed.add(previous);
          replies.set(identity, index);
          pendingWake = false;
        } else {
          replies.clear();
          pendingWake = false;
        }
      }
      messages = messages.filter((_message, index) => !removed.has(index)).map(message => message === latest && demand
        ? { ...message, content: prompt.render(dispatchWakeInstructions, { ...demand, misses, escalation: misses > 0 }).trim() }
        : message);
    }
    if (isMain(ctx) && messages.some(isStaffing)) {
      const phases = todoPhases(ctx);
      const refusals = assignedResourceRefusals(phases, ctx);
      const rows = staffingRows(phases, leadDisplayContext(ctx, phases, currentDecision(ctx))).filter(row => !refusals.has(row.content));
      const last = messages.findLast(isStaffing);
      messages = messages.flatMap(message => !isStaffing(message) ? [message]
        : message === last && rows.length ? [{ ...message, content: prompt.render(gateNoticeInstructions, staffingData(rows)).trim() }] : []);
    }
    // Retire generated scope/deadline questions from older sessions. A slipped
    // forecast or retry count is not an owner decision and cannot change authority.
    if (messages.some(message => message.runtimeSupervisor)) messages = messages.filter(message => !message.runtimeSupervisor);
    const hasLegacy = messages.some(message => message.role === "toolResult"
      ? message.content.some(part => part.type === "text" && ((part.harnessNotice === true && part.text.startsWith("FIX NOW:")) || isLegacyFixNow(part.text)))
      : message.role === "custom" && typeof message.content === "string" && /^(todo-|requirements[_-]|lead-plan-critic)/.test(message.customType) && message.content.includes("\n\nFIX NOW:"));
    if (hasLegacy) messages = messages.map(message => {
      if (message.role === "toolResult") return { ...message, content: message.content.filter(part => part.type !== "text" || !((part.harnessNotice === true && part.text.startsWith("FIX NOW:")) || isLegacyFixNow(part.text))) };
      return message.role === "custom" && typeof message.content === "string" && /^(todo-|requirements[_-]|lead-plan-critic)/.test(message.customType)
        ? { ...message, content: withChiefFixNow(message.content, "") } : message;
    });
    return { messages };
  });

  const armIdleCheck = (ctx: ExtensionContext, decision = currentDecision(ctx)) => {
    clearIdleTimer();
    const lifecycle = latestGoalLifecycleEntries(ctx);
    if (
      singleWriterLane ||
      (lifecycle[0]?.mode === "none" || lifecycleGoal(lifecycle, [])?.status === "complete") ||
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
    const urgent = wakeDemand(todoPhases(ctx), runningOwnerNames(ctx), Date.now(), decision.deadline?.deadlineAt, decision.forecast?.expectedResourceFinish, pendingWorkerQuestions(ctx), ctx);
    const delay = Math.max(urgent ? retryRemaining(ctx, urgent.key) : 0, decision.wakeKey && decision.rawWakeKey !== lastWakeKey ? 0 : decision.nextCheckMs);
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
        { planRevision: noticeDigest(fresh.key), alarms: fresh.alarms },
        undefined,
        { triggerTurn: true, interruptWait: true },
      );
    }, delay);
  };
  pi.on("agent_end", async (_event, ctx) => {
    if (singleWriterLane) return;
    await pollReviewAnswers(ctx, true);
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
    await appendLeadTimeNote(ctx, true);
    armIdleCheck(ctx, decision);
  });
}

/** Uses the plan's canonical timing and exact live-owner observations at the idle boundary. */
export function idleRedRowsRefusal(
  decision: DispatchDecision,
  previewRows: TodoScheduleInput[number]["tasks"][number][] = [],
  previewNotified: Set<string> = new Set(),
  action: "wait" | "stop" = "wait",
  reportStatus?: (content: string) => void,
  activeVerifying: Set<string> = new Set(),
): string | undefined {
  if (decision.goalPaused) return;
  const running = new Set((decision.ownerRunStates ?? []).filter(row => row.running).map(row => row.content));
  const forecast = decision.forecast;
  const verifying = activeVerifying;
  const scoped = (forecast?.rows ?? []).filter(row => !row.schedule?.postDeadline && isNonClosedRowStatus(row.status) && !verifying.has(row.content));
  const outcomes = new Map((decision.ownerRunStates ?? []).map(row => [row.content, row.outcome]));
  const progressing = new Set((decision.ownerRunStates ?? []).filter(row => row.running && row.progressing === true).map(row => row.content));
  const red = scoped.filter(row => !(row.status === "blocked" && row.waitsForUser) &&
    !(row.schedule?.review === "user" && row.schedule?.reviewPage && typeof row.schedule?.visibleAt === "number") && !(row.overdue ? progressing : running).has(row.content) &&
    (row.overdue || row.startedAt !== undefined || row.status === "in_progress" || outcomes.get(row.content)));
  const actions = red.map(row => ({
    content: JSON.stringify(row.content),
    owner: row.owner ? JSON.stringify(row.owner) : undefined,
    completed: (outcomes.get(row.content) ?? row.schedule?.executor?.outcome) === "completed",
    outcome: outcomes.get(row.content) ?? row.schedule?.executor?.outcome ?? "no live executor",
  }));
  const overdue = scoped.filter(row => row.overdue);
  const deadlineActive = Boolean(decision.deadline) && !decision.deadline?.paused;
  const deadlineCauses = scoped.filter(row => row.critical || row.overdue || (row.expectedResourceFinish ?? 0) > (forecast?.deadlineAt ?? Infinity));
  const staffed = deadlineCauses.length > 0 && deadlineCauses.every(row => progressing.has(row.content));
  if (action === "stop" && scoped.some(row => running.has(row.content)))
    return prompt.render(deadlineMissInstructions, { runningStop: true }).trim();
  if ((deadlineActive && forecast?.deadlineStatus === "will-miss") || overdue.length) {
    const finish = forecast.expectedResourceFinish ?? Math.max(...scoped.map(row => row.expectedResourceFinish ?? 0));
    const late = Math.max(0, Math.ceil((finish - (forecast.deadlineAt ?? finish)) / 60_000), ...overdue.map(row => Math.ceil((forecast.now - (row.resourceFinish ?? forecast.now)) / 60_000)));
    const causes = scoped.filter(row => row.critical || overdue.includes(row) || (row.expectedResourceFinish ?? 0) > (forecast.deadlineAt ?? Infinity));
    if (staffed) {
      const status = prompt.render(deadlineMissInstructions, { status: true, late,
        rows: causes.map(row => `${JSON.stringify(row.content)} (${(decision.ownerRunStates ?? []).find(owner => owner.content === row.content)?.owner ?? row.owner ?? "executor"})`).join(", "),
      }).trim();
      const key = `status:${status}`;
      if (!previewNotified.has(key)) { previewNotified.add(key); reportStatus?.(status); }
    } else if (deadlineActive) {
      const revision = `deadline:${forecast.deadlineAt}:${JSON.stringify(scoped.map(row => [row.content, row.status, row.estimateRevision, row.estimateUpdatedAt, row.owner, row.schedule?.dependencies, row.expectedResourceFinish, row.overdue]))}`;
      if (previewNotified.has(revision)) return [prompt.render(deadlineMissInstructions, { repeated: true }).trim(), actions.length ? prompt.render(idleRedRowsInstructions, { red: actions, first: JSON.stringify(shorten(red[0].content, 24)) }).trim() : ""].filter(Boolean).join("\n");
      previewNotified.add(revision);
      return [prompt.render(deadlineMissInstructions, { late, rows: causes.map(row => {
        const finish = row.expectedResourceFinish ?? row.resourceFinish ?? row.earliestFinish;
        const deadlineSlack = finish === undefined || forecast.deadlineAt === undefined ? "" : `, deadline slack ${Math.floor((forecast.deadlineAt - finish) / 60_000)}m`;
        return `${JSON.stringify(row.content)} (slack ${row.totalFloatSeconds === undefined ? "unknown" : `${Math.floor(row.totalFloatSeconds / 60)}m`}${deadlineSlack})`;
      }).join(", ") }).trim(), actions.length ? prompt.render(idleRedRowsInstructions, { red: actions, first: JSON.stringify(shorten(red[0].content, 24)) }).trim() : ""].filter(Boolean).join("\n");
    }
  }

  const preview = previewRows.filter(row => !row.schedule?.postDeadline && row.status === "in_progress").filter(row => {
    const key = `${row.content}\0${row.schedule?.estimateRevision ?? 0}`;
    if (previewNotified.has(key)) return false;
    previewNotified.add(key);
    return true;
  });
  if (!red.length && !preview.length) return;
  return prompt.render(idleRedRowsInstructions, {
    red: actions,
    first: red.length ? JSON.stringify(shorten(red[0].content, 24)) : undefined,
    preview: preview.map(row => JSON.stringify(row.content)).join(", "),
  }).trim();
}

export type ReviewPageProbe = (url: string, row?: string) => Promise<number>;

/** The stop/wait boundary and the session-owned job snapshot establish an idle lead. */
export async function idleUserReviewRefusal(
  phases: DispatchTodoPhases,
  jobs: Jobs | null | undefined,
  refused: Set<string>,
  probe: ReviewPageProbe = probeReviewPage,
): Promise<string | undefined> {
  if (!jobs) return;
  const open = phases.flatMap((phase) => phase.tasks).filter((row) => (row.status === "blocked" && waitsOnUser(row.schedule?.owner, row.blocker)) || (row.status !== "abandoned" && isDeliveredReview(row)));
  if (!open.length) return;
  // Reuse the todo owner/review interpretation. No assistant message is an input.
  const decisions = open.filter(
    (row) =>
      row.schedule?.review === "user" || (row.status === "blocked" && waitsOnUser(row.schedule?.owner, row.blocker)),
  );
  const checks = await Promise.all(
    decisions.map(async (row) => {
      const url = row.schedule?.reviewPage;
      if (typeof url !== "string" || !URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol))
        return { row: row.content, url, status: "missing review page" };
      try {
        return { row: row.content, url, status: await probe(url, String(row.content)) };
      } catch {
        return { row: row.content, url, status: "unreachable" };
      }
    }),
  );
  const failed = checks.filter((check) => check.status !== 200);
  if (decisions.length && !failed.length) return;
  const key = createHash("sha256")
    .update(JSON.stringify([open.map((row) => [row.content, row.status, row.schedule, row.blocker]), checks]))
    .digest("hex");
  refused.add(key);
  return prompt.render(chatChoiceInstructions, { missingRow: decisions.length === 0, failed }).trim();
}
