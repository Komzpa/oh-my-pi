import { launchRestartSnapshots, type RestartSnapshotCapture } from "./restart-snapshot-worker";
import * as fs from "node:fs/promises";
import { AgentRegistry } from "../registry/agent-registry";
import {
	preserveRestartIsolation,
	restartIsolation,
	snapshotRestartIsolation,
	type RestartIsolation,
} from "./restart-isolation";
import { selectRestartBranchEntries } from "./restart-branch-selection";
import { formatDuration, logger, withTimeout } from "@oh-my-pi/pi-utils";
import restartQueuedPrompt from "../prompts/restart-queued.md" with { type: "text" };
import type { RestartDrainLease } from "../session/agent-session-types";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import type { AgentSession } from "../session/agent-session";
import {
	captureSubagentsForRestart,
	getLiveSubagentsForRestart,
	type LiveRestartSubagent,
	restoreSubagentsAfterRestart,
	type RestartRecoveryReport,
	sendRootContinuationOnce,
} from "./restart-recovery";
import type { SessionEntry } from "../session/session-entries";

const RESTART_REQUEST_TRANSITION_TYPE = "restart_request_transition";
const RESTART_REQUEST_TRANSITION_VERSION = 1;
const MAX_RESTART_REQUEST_ID_LENGTH = 128;
const MAX_RESTART_REASON_LENGTH = 1_024;
const MAX_RESTART_ERROR_LENGTH = 4_096;
const DEFAULT_RESTART_WORKER_GRACE_MS = 5_000;
// Abort plus journal quiescence of a worker parked in a long tool: the tool's process tree
// gets SIGTERM, then SIGKILL after its own grace, and the worker then flushes results.
const DEFAULT_RESTART_WORKER_ABORT_GRACE_MS = 30_000;
const RESTART_QUEUED_NOTICE_TYPE = "restart-queued";

/**
 * Canonical model-visible text for every restart-queue notice. Active states carry the
 * drain restriction; terminal states supersede it so the model resumes normal work.
 * requestId and state live in the visible text because `details` never reach the model.
 */
function restartNoticeContent(record: Pick<RestartRequestRecord, "requestId" | "state"> & { error?: string }): string {
	switch (record.state) {
		case "completed":
			return `Restart ${record.requestId} completed; the earlier restriction no longer applies; resume normal work.`;
		case "cancelled":
			return `Restart ${record.requestId} was cancelled; the earlier restriction no longer applies; resume normal work.`;
		case "failed":
			return `Restart ${record.requestId} failed; the earlier restriction no longer applies; resume normal work.${record.error ? ` Error: ${record.error}` : ""}`;
		default:
			return `Restart ${record.requestId} is ${record.state}. ${restartQueuedPrompt.trim()}`;
	}
}

export interface RestartStageEstimate {
	stage: string;
	estimateMs: number;
}

/** One immutable request deadline; every stage reserves the work following it. */
export class RestartBudget {
	constructor(
		readonly deadlineAt: number,
		readonly plan: readonly RestartStageEstimate[],
		readonly waitDeadlines: Record<string, number> = {},
	) {}

	startWorkers(now: number, graceMs: number, abortMs: number): void {
		this.waitDeadlines.worker_grace ??= now + graceMs;
		this.waitDeadlines.worker_abort ??= now + graceMs + abortMs;
	}

	remainingEstimate(stage: string): number {
		const index = this.plan.findIndex(item => item.stage === stage);
		return index < 0 ? 0 : this.plan.slice(index + 1).reduce((sum, item) => sum + item.estimateMs, 0);
	}

	stageDeadline(stage: string): number {
		return Math.min(
			this.deadlineAt - this.remainingEstimate(stage),
			this.waitDeadlines[stage] ?? Number.POSITIVE_INFINITY,
		);
	}
}

export interface RestartControlIdentity {
	instanceId: string;
	sessionId: string;
	generation: number;
}

export type RestartRequestState =
	| "queued"
	| "draining"
	| "checkpointed"
	| "restarting"
	| "completed"
	| "cancelled"
	| "failed";

export interface RestartRequestRecord {
	version: 1;
	requestId: string;
	sessionId: string;
	state: RestartRequestState;
	requestedAt: number;
	updatedAt: number;
	reason?: string;
	error?: string;
	rootWasRunning: boolean;
	runningWorkerCount?: number;
	drainStatus?: RestartDrainStatus;
	goalModeBefore?: { goalId: string };
	budget?: { deadlineAt: number; plan: RestartStageEstimate[] };
}

export interface RestartDrainWorkerStatus {
	id: string;
	name: string;
	startedAt: number;
}

export interface RestartDrainStatus {
	stage?: string;
	stageStartedAt?: number;
	stageElapsedMs?: number;
	stageDeadlineAt?: number;
	remainingEstimateMs?: number;
	deadlineAt?: number;
	abandoned?: RestartDrainWorkerStatus[];
	runningWorkers: RestartDrainWorkerStatus[];
	queuedInputCount: number;
	workerGraceDeadlineAt?: number;
	isolationPendingReason?: string;
}

export interface RestartControlSnapshot {
	identity: RestartControlIdentity;
	pid: number;
	cwd: string;
	request: RestartRequestRecord | null;
	/** Entry files and content hashes captured when this session loaded its extensions. */
	loadedExtensions?: Array<{ path: string; sha256: string }>;
}

export interface RestartControlRequest {
	identity: RestartControlIdentity;
	op: "request" | "status" | "cancel";
	requestId?: string;
	reason?: string;
}

export interface RestartQueueController {
	snapshot(): RestartControlSnapshot;
	handle(request: RestartControlRequest): Promise<RestartControlSnapshot>;
	restore(): Promise<void>;
	resumeChildren(): Promise<void>;
	dispose(): void;
}

export interface RestartQueueControllerOptions {
	session: AgentSession;
	identity: () => RestartControlIdentity;
	restart: () => Promise<void>;
	/** Whether startup was invoked by the same-session restart handoff. */
	restartSuccessor?: boolean;
	/** Interactive startup calls resumeChildren after accepting input and painting. */
	deferChildren?: boolean;
	/** Interactive process replacement lets filesystem capture survive exec. */
	backgroundSnapshots?: boolean;
	onChildProgress?: (id: string, completed: number, total: number) => void;
	onStateChange?: (record: RestartRequestRecord) => void;
	captureGoalMode?: () => { goalId: string } | undefined;
	restorePendingAsk?: (onAnswered: (answered?: boolean) => void) => boolean;
	restoreGoalMode?: (snapshot: { goalId: string }, resumeWork: boolean) => Promise<void>;
	/** Root wait bound; expiry leaves the restart queued until the safe boundary. */
	restartRootQuiescenceMs?: number;
	/** Total request budget. Defaults to the sum of the configured stage estimates. */
	restartTotalMs?: number;
	restartWatchdogSlackMs?: number;
	/** Minimum durability reserves, raised by recent measured durations. */
	restartStageMinimaMs?: Partial<Record<string, number>>;
	restartWorkerGraceMs?: number;
	/** @deprecated Dirty isolated work no longer waits for commits or pushes. */
	restartIsolationWaitMs?: number;
	restartWorkerAbortGraceMs?: number;
}

interface RestartRequestTransition {
	version: 1;
	identity: RestartControlIdentity;
	record: RestartRequestRecord;
}

interface StoredRestartRequest {
	identity: RestartControlIdentity;
	record: RestartRequestRecord;
	entryIndex: number;
}

interface RestartJournal {
	byId: Map<string, StoredRestartRequest>;
	latest?: StoredRestartRequest;
	active?: StoredRestartRequest;
}

interface ActiveRestartDrain {
	identity: RestartControlIdentity;
	record: RestartRequestRecord;
	ack?: Promise<RestartControlSnapshot>;
	cancelled: boolean;
	cancelSignal: Promise<void>;
	resolveCancel(): void;
	leases: Map<AgentSessionHandle, RestartDrainLease>;
	children: Map<string, AgentSessionHandle>;
	isolations: Map<string, RestartIsolation>;
	runningAgentIds: Set<string>;
	workerGraceDeadlineAt?: number;
	notifications: Promise<void>[];
	budget: RestartBudget;
	watchdog?: Timer;
	abandoned: Set<string>;
	notifiedSessions: Map<AgentSessionHandle, Set<string>>;
	irreversible: boolean;
	callbackStarted: boolean;
	snapshotCapture?: RestartSnapshotCapture;
	cancelNoticeDelivered: boolean;
}

const VALID_RESTART_STATES: readonly RestartRequestState[] = [
	"queued",
	"draining",
	"checkpointed",
	"restarting",
	"completed",
	"cancelled",
	"failed",
];

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseIdentity(value: unknown): RestartControlIdentity | undefined {
	if (!isObject(value)) return undefined;
	if (
		typeof value.instanceId !== "string" ||
		value.instanceId.length === 0 ||
		value.instanceId.length > 256 ||
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0 ||
		value.sessionId.length > 256 ||
		typeof value.generation !== "number" ||
		!Number.isFinite(value.generation)
	) {
		return undefined;
	}
	return {
		instanceId: value.instanceId,
		sessionId: value.sessionId,
		generation: value.generation,
	};
}

function parseDrainStatus(value: unknown): RestartDrainStatus | undefined {
	if (!isObject(value) || !Array.isArray(value.runningWorkers)) return undefined;
	if (
		typeof value.queuedInputCount !== "number" ||
		!Number.isInteger(value.queuedInputCount) ||
		value.queuedInputCount < 0
	) {
		return undefined;
	}
	const runningWorkers: RestartDrainWorkerStatus[] = [];
	for (const item of value.runningWorkers) {
		if (
			!isObject(item) ||
			typeof item.id !== "string" ||
			item.id.length === 0 ||
			item.id.length > 256 ||
			typeof item.name !== "string" ||
			item.name.length === 0 ||
			item.name.length > 256 ||
			typeof item.startedAt !== "number" ||
			!Number.isFinite(item.startedAt)
		) {
			return undefined;
		}
		runningWorkers.push({ id: item.id, name: item.name, startedAt: item.startedAt });
	}
	return {
		runningWorkers,
		queuedInputCount: value.queuedInputCount,
		...Object.fromEntries(
			["stageDeadlineAt", "remainingEstimateMs", "deadlineAt"]
				.filter(key => typeof value[key] === "number" && Number.isFinite(value[key]))
				.map(key => [key, value[key]]),
		),
		...(typeof value.stage === "string" ? { stage: value.stage } : {}),
		...(typeof value.stageStartedAt === "number" ? { stageStartedAt: value.stageStartedAt } : {}),
		...(Array.isArray(value.abandoned)
			? {
					abandoned: value.abandoned.filter(
						(item): item is RestartDrainWorkerStatus =>
							isObject(item) &&
							typeof item.id === "string" &&
							typeof item.name === "string" &&
							typeof item.startedAt === "number",
					),
				}
			: {}),
		...(typeof value.isolationPendingReason === "string"
			? { isolationPendingReason: value.isolationPendingReason }
			: {}),
		...(typeof value.workerGraceDeadlineAt === "number" && Number.isFinite(value.workerGraceDeadlineAt)
			? { workerGraceDeadlineAt: value.workerGraceDeadlineAt }
			: {}),
	};
}

function parseBudget(value: unknown): RestartRequestRecord["budget"] {
	if (
		!isObject(value) ||
		typeof value.deadlineAt !== "number" ||
		!Number.isFinite(value.deadlineAt) ||
		!Array.isArray(value.plan)
	)
		return undefined;
	const plan: RestartStageEstimate[] = [];
	for (const item of value.plan) {
		if (
			!isObject(item) ||
			typeof item.stage !== "string" ||
			typeof item.estimateMs !== "number" ||
			!Number.isFinite(item.estimateMs) ||
			item.estimateMs < 0
		)
			return undefined;
		plan.push({ stage: item.stage, estimateMs: item.estimateMs });
	}
	return { deadlineAt: value.deadlineAt, plan };
}

function parseRestartRequestRecord(value: unknown): RestartRequestRecord | undefined {
	if (!isObject(value)) return undefined;
	if (
		value.version !== RESTART_REQUEST_TRANSITION_VERSION ||
		typeof value.requestId !== "string" ||
		value.requestId.length === 0 ||
		value.requestId.length > MAX_RESTART_REQUEST_ID_LENGTH ||
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0 ||
		value.sessionId.length > 256 ||
		(value.reason !== undefined &&
			(typeof value.reason !== "string" || value.reason.length > MAX_RESTART_REASON_LENGTH)) ||
		(value.error !== undefined &&
			(typeof value.error !== "string" || value.error.length > MAX_RESTART_ERROR_LENGTH)) ||
		(value.runningWorkerCount !== undefined &&
			(typeof value.runningWorkerCount !== "number" ||
				!Number.isInteger(value.runningWorkerCount) ||
				value.runningWorkerCount < 0)) ||
		(value.drainStatus !== undefined && parseDrainStatus(value.drainStatus) === undefined) ||
		(value.goalModeBefore !== undefined &&
			(!isObject(value.goalModeBefore) ||
				typeof value.goalModeBefore.goalId !== "string" ||
				value.goalModeBefore.goalId.length === 0 ||
				value.goalModeBefore.goalId.length > 256)) ||
		!VALID_RESTART_STATES.includes(value.state as RestartRequestState) ||
		typeof value.requestedAt !== "number" ||
		!Number.isFinite(value.requestedAt) ||
		typeof value.updatedAt !== "number" ||
		!Number.isFinite(value.updatedAt) ||
		typeof value.rootWasRunning !== "boolean"
	) {
		return undefined;
	}
	return {
		version: RESTART_REQUEST_TRANSITION_VERSION,
		requestId: value.requestId,
		sessionId: value.sessionId,
		state: value.state as RestartRequestState,
		requestedAt: value.requestedAt,
		updatedAt: value.updatedAt,
		...(typeof value.reason === "string" ? { reason: value.reason } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		rootWasRunning: value.rootWasRunning,
		...(parseBudget(value.budget) ? { budget: parseBudget(value.budget) } : {}),
		...(typeof value.runningWorkerCount === "number" ? { runningWorkerCount: value.runningWorkerCount } : {}),
		...(value.drainStatus !== undefined ? { drainStatus: parseDrainStatus(value.drainStatus)! } : {}),
		...(isObject(value.goalModeBefore) && typeof value.goalModeBefore.goalId === "string"
			? { goalModeBefore: { goalId: value.goalModeBefore.goalId } }
			: {}),
	};
}

function parseTransition(entry: SessionEntry, entryIndex: number): StoredRestartRequest | undefined {
	if (entry.type !== "custom" || entry.customType !== RESTART_REQUEST_TRANSITION_TYPE || !isObject(entry.data))
		return undefined;
	const data = entry.data;
	if (data.version !== RESTART_REQUEST_TRANSITION_VERSION) return undefined;
	const identity = parseIdentity(data.identity);
	const record = parseRestartRequestRecord(data.record);
	if (!identity || !record || identity.sessionId !== record.sessionId) return undefined;
	return { identity, record, entryIndex };
}

/** Label the notice itself; legacy notices without a state use the persisted journal. */
export function restartNoticeText(entries: readonly SessionEntry[], requestId: string, noticeState?: unknown): string {
	let latest: RestartRequestRecord | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry) continue;
		const transition = parseTransition(entry, index);
		if (transition?.record.requestId === requestId) latest = transition.record;
	}
	switch (noticeState ?? latest?.state) {
		case "completed":
			return "Restarted";
		case "cancelled":
			return "Restart cancelled";
		case "failed":
			return "Restart failed";
		case "draining":
			return "Restart draining";
		case "checkpointed":
		case "restarting":
			return "Restarting";
		default:
			return "Restart queued";
	}
}

function plural(count: number, singular: string, pluralText = `${singular}s`): string {
	return count === 1 ? singular : pluralText;
}

function formatWorker(worker: RestartDrainWorkerStatus, now: number): string {
	const elapsed = Math.max(0, now - worker.startedAt);
	return `${worker.name} ${formatDuration(elapsed)}`;
}

function formatRestartRequestSummary(record: RestartRequestRecord | null, now = Date.now()): string {
	if (!record) return "No restart request is queued.";
	if (record.state !== "queued" && record.state !== "draining") {
		return `Restart ${record.state} (${record.requestId}).`;
	}
	const status = record.drainStatus;
	if (status?.isolationPendingReason) return status.isolationPendingReason;
	const workers = status?.runningWorkers ?? [];
	const queuedInputCount = status?.queuedInputCount ?? 0;
	const queued = `${queuedInputCount} queued ${plural(queuedInputCount, "input")}`;
	if (workers.length > 0) {
		if (status?.workerGraceDeadlineAt !== undefined) {
			const remaining = Math.max(0, status.workerGraceDeadlineAt - now);
			return `Restart waiting up to ${formatDuration(remaining)} for ${workers.length} ${plural(workers.length, "worker")} to reach a safe point: ${workers.map(worker => formatWorker(worker, now)).join(", ")}; ${queued}.`;
		}
		return `Restart waiting for ${workers.length} ${plural(workers.length, "worker")}: ${workers.map(worker => formatWorker(worker, now)).join(", ")}; ${queued}.`;
	}
	if (queuedInputCount > 0) return `Restart waiting for ${queued}.`;
	return `Restart ${record.state} (${record.requestId}).`;
}

export function formatRestartRequestStatus(record: RestartRequestRecord | null, now = Date.now()): string {
	const summary = formatRestartRequestSummary(record, now);
	const status = record?.drainStatus;
	const lead = status?.stage === "root_quiescence" ? " Waiting for the lead's turn to finish." : "";
	const stageElapsedMs =
		record && status?.stageStartedAt !== undefined
			? isActiveState(record.state)
				? Math.max(0, now - status.stageStartedAt)
				: Math.max(0, status.stageElapsedMs ?? record.updatedAt - status.stageStartedAt)
			: undefined;
	return status?.stage && status.stageStartedAt !== undefined
		? `${summary}${lead} Stage: ${status.stage} (${formatDuration(stageElapsedMs ?? 0)}); deadline: ${status.stageDeadlineAt === undefined ? "unknown" : new Date(status.stageDeadlineAt).toISOString()}; reserved remaining work: ${formatDuration(status.remainingEstimateMs ?? 0)}; abandoned: ${status.abandoned?.length ?? 0}.`
		: summary;
}

/** Only a checkpoint from the previous process licenses active-goal recovery. */
export function isRestartResumePending(
	source: Parameters<typeof selectRestartBranchEntries>[0],
	sessionId: string,
	instanceId: string,
): boolean {
	const entries = selectRestartBranchEntries(
		source,
		metadata => metadata.type === "custom" && metadata.customType === RESTART_REQUEST_TRANSITION_TYPE,
	);
	let latest: StoredRestartRequest | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry) continue;
		const transition = parseTransition(entry, index);
		if (transition?.record.sessionId === sessionId) latest = transition;
	}
	return (
		latest !== undefined &&
		latest.identity.instanceId !== instanceId &&
		(latest.record.state === "checkpointed" || latest.record.state === "restarting")
	);
}

function sameIdentity(left: RestartControlIdentity, right: RestartControlIdentity): boolean {
	return (
		left.instanceId === right.instanceId && left.sessionId === right.sessionId && left.generation === right.generation
	);
}

function isActiveState(state: RestartRequestState): boolean {
	return state === "queued" || state === "draining" || state === "checkpointed" || state === "restarting";
}

function canTransition(from: RestartRequestState, to: RestartRequestState): boolean {
	if (to === "failed") return isActiveState(from);
	if (from === "queued") return to === "draining" || to === "cancelled";
	if (from === "draining") return to === "queued" || to === "checkpointed" || to === "cancelled";
	if (from === "checkpointed") return to === "restarting" || to === "completed";
	return from === "restarting" && to === "completed";
}

function makeRun(
	identity: RestartControlIdentity,
	record: RestartRequestRecord,
	budget: RestartBudget,
): ActiveRestartDrain {
	const { promise, resolve } = Promise.withResolvers<void>();
	return {
		identity,
		record,
		budget,
		cancelled: false,
		cancelSignal: promise,
		resolveCancel: resolve,
		leases: new Map(),
		children: new Map(),
		isolations: new Map(),
		runningAgentIds: new Set(),
		notifications: [],
		abandoned: new Set(),
		notifiedSessions: new Map(),
		irreversible: false,
		callbackStarted: false,
		cancelNoticeDelivered: false,
	};
}

class RestartQueueControllerImpl implements RestartQueueController {
	readonly #session: AgentSession;
	readonly #identity: () => RestartControlIdentity;
	readonly #restart: () => Promise<void>;
	readonly #deferChildren: boolean;
	readonly #backgroundSnapshots: boolean;
	readonly #onChildProgress: RestartQueueControllerOptions["onChildProgress"];
	readonly #restartSuccessor: boolean | undefined;
	readonly #onStateChange: ((record: RestartRequestRecord) => void) | undefined;
	readonly #captureGoalMode: (() => { goalId: string } | undefined) | undefined;
	readonly #restorePendingAsk: RestartQueueControllerOptions["restorePendingAsk"];
	readonly #restartWorkerAbortGraceMs: number;
	readonly #restoreGoalMode: RestartQueueControllerOptions["restoreGoalMode"];
	readonly #restartWorkerGraceMs: number;
	readonly #restartRootQuiescenceMs: number;
	readonly #restartTotalMs: number | undefined;
	readonly #restartWatchdogSlackMs: number;
	readonly #stageMinima: Partial<Record<string, number>>;
	readonly #recentDurations = new Map<string, number[]>();
	#serial: Promise<void> = Promise.resolve();
	#run: ActiveRestartDrain | undefined;
	#restorePromise: Promise<void> | undefined;
	#childrenRecovery: (() => Promise<void>) | undefined;
	#childrenRecoveryPromise: Promise<void> | undefined;
	#restoringRecord: RestartRequestRecord | undefined;
	#disposed = false;

	constructor(options: RestartQueueControllerOptions) {
		this.#restartRootQuiescenceMs =
			options.restartRootQuiescenceMs ?? Number(process.env.OMP_RESTART_ROOT_QUIESCENCE_MS ?? 600_000);
		if (!Number.isFinite(this.#restartRootQuiescenceMs) || this.#restartRootQuiescenceMs < 0)
			throw new Error("Invalid root restart wait");
		this.#restartTotalMs =
			options.restartTotalMs ??
			(process.env.OMP_RESTART_TOTAL_MS ? Number(process.env.OMP_RESTART_TOTAL_MS) : undefined);
		this.#restartWatchdogSlackMs = options.restartWatchdogSlackMs ?? 5_000;
		this.#stageMinima = options.restartStageMinimaMs ?? {};
		for (const value of [this.#restartTotalMs, this.#restartWatchdogSlackMs, ...Object.values(this.#stageMinima)]) {
			if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("Invalid restart budget");
		}
		this.#session = options.session;
		this.#identity = options.identity;
		this.#restart = options.restart;
		this.#restartSuccessor = options.restartSuccessor;
		this.#deferChildren = options.deferChildren ?? false;
		this.#backgroundSnapshots = options.backgroundSnapshots ?? false;
		this.#onChildProgress = options.onChildProgress;
		this.#onStateChange = options.onStateChange;
		this.#captureGoalMode = options.captureGoalMode;
		this.#restoreGoalMode = options.restoreGoalMode;
		this.#restorePendingAsk = options.restorePendingAsk;
		this.#restartWorkerAbortGraceMs =
			options.restartWorkerAbortGraceMs !== undefined && Number.isFinite(options.restartWorkerAbortGraceMs)
				? Math.max(0, Math.floor(options.restartWorkerAbortGraceMs))
				: DEFAULT_RESTART_WORKER_ABORT_GRACE_MS;
		this.#restartWorkerGraceMs =
			options.restartWorkerGraceMs !== undefined && Number.isFinite(options.restartWorkerGraceMs)
				? Math.max(0, Math.floor(options.restartWorkerGraceMs))
				: DEFAULT_RESTART_WORKER_GRACE_MS;
	}

	snapshot(): RestartControlSnapshot {
		const identity = this.#identity();
		const journal = this.#readJournal(identity.sessionId);
		return this.#makeSnapshot(identity, this.#run?.record ?? this.#restoringRecord ?? journal.latest?.record ?? null);
	}

	async handle(request: RestartControlRequest): Promise<RestartControlSnapshot> {
		this.#assertUsable();
		this.#validateControlRequest(request);
		const identity = this.#assertRequestIdentity(request.identity);
		if (request.op === "status") {
			const journal = this.#readJournal(identity.sessionId);
			const selected = request.requestId
				? journal.byId.get(request.requestId)?.record
				: (journal.active?.record ?? journal.latest?.record);
			return Promise.resolve(
				this.#makeSnapshot(
					identity,
					this.#run && this.#run.record.requestId === selected?.requestId
						? this.#run.record
						: ((this.#restoringRecord?.requestId === selected?.requestId ? this.#restoringRecord : selected) ??
								null),
				),
			);
		}
		if (request.op === "request") return this.#requestRestart(request, identity);
		if (request.op === "cancel") return this.#cancelRestart(request, identity);
		return Promise.reject(new Error("Unsupported restart control operation"));
	}

	resumeChildren(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		return (this.#childrenRecoveryPromise ??= this.#childrenRecovery?.() ?? Promise.resolve());
	}

	restore(): Promise<void> {
		this.#assertUsable();
		if (this.#restorePromise) return this.#restorePromise;
		const identity = this.#currentIdentity();
		this.#restorePromise = this.#serialize(async () => {
			// The interactive question owns the root until answered or cancelled.
			let restoreComplete = false;
			let askSettled = false;
			let askAnswered = false;
			const pendingAsk = this.#restorePendingAsk?.((answered = true) => {
				askSettled = true;
				askAnswered = answered;
				if (restoreComplete && !this.#disposed) {
					void this.#resumeAfterRestoredAsk(record, answered).catch(error =>
						this.#notice("error", `Could not resume after restored question: ${this.#errorText(error)}`),
					);
				}
			});
			const stored = this.#readJournal(identity.sessionId).latest;
			let record = stored?.record;
			let restartCompleted = record?.state === "completed";
			const manualHandoff =
				stored &&
				(record?.state === "checkpointed" || record?.state === "restarting") &&
				stored.identity.instanceId !== identity.instanceId &&
				this.#restartSuccessor === false;
			if (
				stored &&
				record &&
				(record.state === "checkpointed" || record.state === "restarting") &&
				stored.identity.instanceId !== identity.instanceId &&
				this.#restartSuccessor === false
			) {
				record = await this.#persistStateUnserialized(
					identity,
					record,
					"failed",
					"Session was resumed without a restart successor handoff; restart completion was not confirmed.",
				);
			} else if (stored && record?.state === "checkpointed") {
				if (stored.identity.instanceId !== identity.instanceId) {
					record = await this.#persistStateUnserialized(
						identity,
						record,
						"completed",
						undefined,
						undefined,
						false,
					);
					restartCompleted = true;
				} else {
					record = await this.#persistStateUnserialized(identity, record, "restarting");
					try {
						this.#assertCurrentIdentity(identity);
						await this.#restart();
						record = await this.#persistStateUnserialized(
							identity,
							record,
							"completed",
							undefined,
							undefined,
							false,
						);
						restartCompleted = true;
					} catch (error) {
						record = await this.#persistStateUnserialized(
							identity,
							record,
							"failed",
							`Restart callback failed after checkpoint: ${this.#errorText(error)}`,
						);
						this.#notice("error", record.error ?? "Restart callback failed after checkpoint");
					}
				}
			} else if (stored && record?.state === "restarting") {
				if (stored.identity.instanceId !== identity.instanceId) {
					record = await this.#persistStateUnserialized(
						identity,
						record,
						"completed",
						undefined,
						undefined,
						false,
					);
					restartCompleted = true;
				} else {
					record = await this.#persistStateUnserialized(
						identity,
						record,
						"failed",
						"Restart callback outcome is unresolved in this process; it was not replayed.",
					);
					this.#notice("error", record.error ?? "Restart callback outcome is unresolved; it was not replayed.");
				}
			} else if (record?.state === "queued" || record?.state === "draining") {
				record = await this.#persistStateUnserialized(
					identity,
					record,
					"failed",
					"Process restarted before the request reached a safe checkpoint; pending effects were not replayed.",
				);
				this.#notice("error", record.error ?? "Restart request did not reach a safe checkpoint.");
			}

			// The queues were loaded before the journal transition above. Drop stale
			// drain restrictions before any child or root continuation can run.
			await this.#session.reconcileRestartNotices();

			const publishTerminalNotice = async (terminalRecord: RestartRequestRecord): Promise<void> => {
				const notices = this.#restartNoticesFor(terminalRecord.requestId);
				if (notices.some(notice => notice.terminal) === false) {
					await this.#session.sendRestartNotice({
						customType: RESTART_QUEUED_NOTICE_TYPE,
						content: restartNoticeContent(terminalRecord),
						display: true,
						attribution: "agent",
						details: { requestId: terminalRecord.requestId, state: terminalRecord.state },
					});
					await this.#session.sessionManager.flush();
				}
			};
			if (record && (record.state === "cancelled" || record.state === "failed")) {
				await publishTerminalNotice(record);
			}
			let readinessRecord = record;
			if (record?.state === "completed") {
				readinessRecord = this.#restoringStageRecord(record, "restore_children");
				this.#restoringRecord = readinessRecord;
				this.#onStateChange?.(readinessRecord);
				if (this.#restartNoticesFor(record.requestId).some(notice => notice.terminal) === false) {
					await this.#session.sendRestartNotice({
						customType: RESTART_QUEUED_NOTICE_TYPE,
						content: restartNoticeContent(readinessRecord),
						display: true,
						attribution: "agent",
						details: { requestId: readinessRecord.requestId, state: readinessRecord.state },
					});
					await this.#session.sessionManager.flush();
				}
			}
			this.#childrenRecovery = async () => {
				let recoveryReport: RestartRecoveryReport | undefined;
				if (!stored || record?.state === "completed" || manualHandoff) {
					recoveryReport = await this.#measureStage(readinessRecord, "restore_children", () =>
						restoreSubagentsAfterRestart(this.#session, {
							requestId: record?.requestId,
							onProgress: this.#onChildProgress,
							beforeChildResume:
								record && ["completed", "cancelled", "failed"].includes(record.state)
									? child =>
											child
												.sendRestartNotice({
													customType: RESTART_QUEUED_NOTICE_TYPE,
													content: restartNoticeContent(record!),
													display: true,
													attribution: "agent",
													details: { requestId: record!.requestId, state: record!.state },
												})
												.then(() => undefined)
									: undefined,
						}),
					);
				}
				if (record?.state === "completed") {
					this.#onStateChange?.(record);
					await publishTerminalNotice(record);
				}
				// Publish the short completion before goal restoration can start work.
				if (!pendingAsk && restartCompleted && record)
					await sendRootContinuationOnce(this.#session, record.requestId, recoveryReport);
				if (!pendingAsk && record && ["completed", "cancelled", "failed"].includes(record.state))
					await this.#restoreGoalModeFor(record);
				restoreComplete = true;
				if (askSettled) await this.#resumeAfterRestoredAsk(record, askAnswered);
			};
			if (!this.#deferChildren) await this.resumeChildren();
		});
		return this.#restorePromise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const run = this.#run;
		if (!run || run.irreversible || run.callbackStarted) return;
		run.cancelled = true;
		run.resolveCancel();
		void this.#releaseLeases(run);
	}

	#requestRestart(request: RestartControlRequest, identity: RestartControlIdentity): Promise<RestartControlSnapshot> {
		const requestId = request.requestId ?? crypto.randomUUID();
		const reason = request.reason;
		const journal = this.#readJournal(identity.sessionId);
		const existing = journal.byId.get(requestId)?.record;
		if (existing) {
			if (existing.reason !== reason)
				return Promise.reject(new Error("Restart request id was already used with a different reason"));
			return Promise.resolve(this.#makeSnapshot(identity, existing));
		}
		if (this.#run && !this.#run.cancelled) {
			if (this.#run.record.requestId === requestId && this.#run.record.reason === reason) {
				return this.#run.ack ?? Promise.resolve(this.#makeSnapshot(identity, this.#run.record));
			}
			return Promise.reject(new Error(`Restart request ${this.#run.record.requestId} is already active`));
		}
		if (journal.active)
			return Promise.reject(new Error(`Restart request ${journal.active.record.requestId} is already active`));

		const now = Date.now();
		const goalModeBefore = this.#captureGoalMode?.();
		const record: RestartRequestRecord = {
			version: RESTART_REQUEST_TRANSITION_VERSION,
			requestId,
			sessionId: identity.sessionId,
			state: "queued",
			requestedAt: now,
			updatedAt: now,
			...(reason !== undefined ? { reason } : {}),
			rootWasRunning: this.#session.isStreaming,
			...(goalModeBefore ? { goalModeBefore } : {}),
		};
		const minima: RestartStageEstimate[] = [
			["prepare", 1_000],
			["isolation", 0],
			["notifications", 1_000],
			["root_quiescence", this.#restartRootQuiescenceMs],
			["worker_grace", this.#restartWorkerGraceMs],
			["worker_abort", this.#restartWorkerAbortGraceMs],
			["flush_sessions", 1_000],
			["snapshot_isolation", 1_000],
			["capture_children", 1_000],
			["flush", 1_000],
			["replace_runtime", 1_000],
			["restore_children", 1_000],
		].map(([stage, minimum]) => ({ stage: String(stage), estimateMs: Number(minimum) }));
		if (this.#backgroundSnapshots) {
			const index = minima.findIndex(item => item.stage === "snapshot_isolation");
			const [capture] = minima.splice(index, 1);
			minima.splice(
				minima.findIndex(item => item.stage === "replace_runtime"),
				0,
				capture,
			);
		}
		const plan = minima.map(({ stage, estimateMs }) => ({
			stage,
			estimateMs: Math.max(this.#stageMinima[stage] ?? estimateMs, ...(this.#recentDurations.get(stage) ?? [])),
		}));
		const budget = new RestartBudget(
			now + (this.#restartTotalMs ?? minima.reduce((sum, item) => sum + item.estimateMs, 0)),
			plan,
			{
				root_quiescence: now + this.#restartRootQuiescenceMs,
			},
		);
		record.budget = { deadlineAt: budget.deadlineAt, plan };
		const run = makeRun(identity, record, budget);
		this.#run = run;
		run.watchdog = setTimeout(
			() => {
				if (run.cancelled || this.#disposed) return;
				const stage = run.record.drainStatus?.stage ?? "prepare";
				const message = `Restart watchdog: stage ${stage} overran request deadline ${new Date(run.budget.deadlineAt).toISOString()}`;
				logger.error(message, { requestId, stage, deadlineAt: run.budget.deadlineAt });
				this.#notice("error", message);
			},
			Math.max(0, budget.deadlineAt + this.#restartWatchdogSlackMs - Date.now()),
		);
		const ack = this.#serialize(async () => {
			try {
				await this.#measureStage(run.record, "prepare", () => this.#prepareInitialDrain(run));
				await this.#persistRecord(identity, run.record);
				if (run.cancelled) {
					run.record = await this.#persistStateUnserialized(identity, run.record, "cancelled");
					return this.#makeSnapshot(identity, run.record);
				}
				void this.#drain(run).catch(error => this.#reportBackgroundFailure(run, error));
				return this.#makeSnapshot(identity, run.record);
			} catch (error) {
				clearTimeout(run.watchdog);
				await this.#releaseLeases(run);
				if (this.#run === run) this.#run = undefined;
				throw error;
			}
		});
		run.ack = ack;
		return ack;
	}

	#cancelRestart(request: RestartControlRequest, identity: RestartControlIdentity): Promise<RestartControlSnapshot> {
		const journal = this.#readJournal(identity.sessionId);
		const target = request.requestId
			? journal.byId.get(request.requestId)?.record
			: (journal.active?.record ?? journal.latest?.record);
		const pendingRun = this.#run;
		const pendingMatches =
			pendingRun !== undefined &&
			(request.requestId === undefined || pendingRun.record.requestId === request.requestId);
		const pendingRecord = pendingMatches && pendingRun ? pendingRun.record : undefined;
		const record = target ?? pendingRecord;
		if (!record) return Promise.reject(new Error("No restart request is available to cancel"));
		const retryNotice = Boolean(
			pendingRun && pendingMatches && pendingRun.cancelled && !pendingRun.cancelNoticeDelivered,
		);
		if (record.state === "cancelled" && !retryNotice) return Promise.resolve(this.#makeSnapshot(identity, record));
		if (record.state !== "queued" && record.state !== "draining" && !retryNotice) {
			return Promise.reject(
				new Error(`Restart request ${record.requestId} can no longer be cancelled in state ${record.state}`),
			);
		}
		if (pendingRun && pendingMatches) {
			pendingRun.cancelled = true;
			pendingRun.resolveCancel();
		}
		return this.#serialize(async () => {
			const current = this.#readJournal(identity.sessionId).byId.get(record.requestId)?.record ?? record;
			const canRetryNotice = Boolean(
				pendingRun && pendingMatches && pendingRun.cancelled && !pendingRun.cancelNoticeDelivered,
			);
			if (current.state === "cancelled" && pendingRun && pendingMatches && pendingRun.cancelNoticeDelivered) {
				return this.#makeSnapshot(identity, current);
			}
			if (
				current.state !== "queued" &&
				current.state !== "draining" &&
				!(current.state === "cancelled" && canRetryNotice)
			) {
				throw new Error(
					`Restart request ${current.requestId} can no longer be cancelled in state ${current.state}`,
				);
			}
			const cancelled =
				current.state === "cancelled"
					? current
					: await this.#persistStateUnserialized(identity, current, "cancelled");
			if (pendingRun && pendingMatches) {
				pendingRun.record = cancelled;
				const firstCancellationNotice = pendingRun.notifications.length;
				this.#notifySession(pendingRun, this.#session);
				for (const child of pendingRun.children.values()) this.#notifySession(pendingRun, child);
				const notices = pendingRun.notifications.splice(firstCancellationNotice);
				try {
					await Promise.all(notices);
				} catch (error) {
					const blocker = `Restart request ${cancelled.requestId} was durably cancelled, but its cancellation notice could not be delivered; the session drain remains held. ${this.#errorText(error)}`;
					this.#notice("error", blocker);
					throw new Error(blocker);
				}
				pendingRun.cancelNoticeDelivered = true;
				await this.#releaseLeases(pendingRun);
				if (this.#run === pendingRun) this.#run = undefined;
			}
			await this.#restoreGoalModeFor(cancelled);
			return this.#makeSnapshot(identity, cancelled);
		});
	}

	async #prepareInitialDrain(run: ActiveRestartDrain): Promise<void> {
		const rootWasStreaming = this.#session.isStreaming;
		this.#notifySession(run, this.#session);
		const rootLease = this.#takeLease(run, this.#session);
		run.record = { ...run.record, rootWasRunning: rootLease.wasRunning || rootWasStreaming };
		await Promise.all(
			getLiveSubagentsForRestart(this.#session).map(async child => {
				const isolated = await restartIsolation(child);
				if (isolated) {
					await preserveRestartIsolation(isolated);
					run.isolations.set(child.id, isolated);
				}
				this.#prepareChild(run, child.id, child.status, child.session);
			}),
		);
		run.record = this.#withDrainStatus({ ...run.record, runningWorkerCount: run.runningAgentIds.size }, run);
	}

	async #retainIsolation(run: ActiveRestartDrain, child: LiveRestartSubagent): Promise<void> {
		if (run.isolations.has(child.id)) return;
		const isolated = await restartIsolation(child);
		if (!isolated) return;
		await preserveRestartIsolation(isolated);
		run.isolations.set(child.id, isolated);
	}

	#prepareChild(run: ActiveRestartDrain, id: string, status: string, session: AgentSessionHandle): void {
		const priorSession = run.children.get(id);
		if (priorSession) {
			if (priorSession !== session)
				throw new Error(`Cannot restart safely: live child ${id} changed session identity while draining.`);
			return;
		}
		run.children.set(id, session);
		if (status === "running" || session.isStreaming) run.runningAgentIds.add(id);
		// Registry claims survive a dead executor. Use the same corroboration as jobs/wait.
		const ref = AgentRegistry.global().get(id);
		if (status === "running" && ref && !AgentRegistry.global().isRunning(ref)) {
			run.abandoned.add(id);
			return;
		}
		run.budget.startWorkers(Date.now(), this.#restartWorkerGraceMs, this.#restartWorkerAbortGraceMs);
		this.#notifySession(run, session);
		const lease = this.#takeLease(run, session);
		if (lease.wasRunning) run.runningAgentIds.add(id);
	}

	#notifySession(run: ActiveRestartDrain, session: AgentSessionHandle): void {
		const bucket = run.notifiedSessions.get(session) ?? new Set<string>();
		const noticeKey = `${run.record.requestId}:${run.record.state}`;
		if (bucket.has(noticeKey)) return;
		bucket.add(noticeKey);
		run.notifiedSessions.set(session, bucket);
		if ([...run.children].some(([id, child]) => child === session && run.abandoned.has(id))) return;
		let notification: Promise<void>;
		try {
			notification = session
				.sendRestartNotice({
					customType: RESTART_QUEUED_NOTICE_TYPE,
					content: restartNoticeContent(run.record),
					display: true,
					attribution: "agent",
					details: { requestId: run.record.requestId, state: run.record.state },
				})
				.then(() => undefined);
		} catch (error) {
			notification = Promise.reject(error);
		}
		void notification.catch(() => {
			bucket.delete(noticeKey);
		});
		const bounded = this.#boundSession(run, session, () => notification);
		void bounded.catch(() => {});
		run.notifications.push(bounded);
	}

	#withDrainStatus(record: RestartRequestRecord, run: ActiveRestartDrain): RestartRequestRecord {
		const liveChildren = getLiveSubagentsForRestart(this.#session);
		const runningWorkers = liveChildren
			.filter(child => !run.abandoned.has(child.id) && AgentRegistry.global().isRunning(child))
			.map(child => ({
				id: child.id,
				name: child.displayName || child.id,
				startedAt: child.createdAt,
			}))
			.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
		const sessions = new Set<AgentSessionHandle>([this.#session, ...run.children.values()]);
		let queuedInputCount = 0;
		for (const session of sessions) queuedInputCount += session.getRestartPendingInputCount();
		return {
			...record,
			updatedAt: Date.now(),
			runningWorkerCount: runningWorkers.length,
			drainStatus: {
				...record.drainStatus,
				abandoned: liveChildren
					.filter(child => run.abandoned.has(child.id))
					.map(child => ({ id: child.id, name: child.displayName || child.id, startedAt: child.createdAt })),
				runningWorkers,
				queuedInputCount,
				...(record.drainStatus?.isolationPendingReason
					? { isolationPendingReason: record.drainStatus.isolationPendingReason }
					: {}),
				workerGraceDeadlineAt: run.workerGraceDeadlineAt,
			},
		};
	}

	#takeLease(run: ActiveRestartDrain, session: AgentSessionHandle): RestartDrainLease {
		const existing = run.leases.get(session);
		if (existing) return existing;
		const lease = session.beginRestartDrain({ interruptProvider: true });
		run.leases.set(session, lease);
		return lease;
	}

	async #drain(run: ActiveRestartDrain): Promise<void> {
		try {
			if (run.cancelled) return;
			run.record = await this.#transition(run, "draining");
			await this.#measureStage(run.record, "isolation", async () => {
				// Dirty and unpushed work is captured as-is after writer quiescence.
				await Promise.all(
					getLiveSubagentsForRestart(this.#session).map(async child => {
						await this.#retainIsolation(run, child);
						this.#prepareChild(run, child.id, child.status, child.session);
					}),
				);
			});
			if (run.cancelled || this.#disposed) return;
			const safe = await this.#settleAndFlush(run);
			if (!safe || run.cancelled || this.#disposed) return;
			if (!this.#backgroundSnapshots) {
				await this.#measureStage(run.record, "snapshot_isolation", () =>
					Promise.all([...run.isolations.values()].map(isolated => snapshotRestartIsolation(isolated))),
				);
			}
			await this.#measureStage(run.record, "capture_children", deadlineAt =>
				captureSubagentsForRestart(this.#session, {
					runningAgentIds: run.runningAgentIds,
					deadlineAt,
					requestId: run.record.requestId,
				}),
			);
			if (run.cancelled || this.#disposed) return;
			run.record = await this.#measureStage(run.record, "flush", () => this.#transition(run, "checkpointed"));
			if (run.cancelled || this.#disposed) return;
			run.irreversible = true;
			if (this.#backgroundSnapshots) {
				await this.#measureStage(run.record, "snapshot_isolation", async () => {
					run.snapshotCapture = await launchRestartSnapshots(
						[...run.isolations.values()],
						run.record.requestId,
						run.budget.deadlineAt,
					);
				});
			}
			run.record = await this.#transition(run, "restarting");
			run.callbackStarted = true;
			await this.#measureStage(run.record, "replace_runtime", () => this.#restart());
			if (!this.#disposed) run.record = await this.#transition(run, "completed");
			if (!this.#disposed && run.record.state === "completed") {
				this.#notifySession(run, this.#session);
				for (const child of run.children.values()) this.#notifySession(run, child);
				const terminalNotices = run.notifications.splice(0);
				try {
					await Promise.all(terminalNotices);
				} catch (error) {
					this.#notice(
						"error",
						`Restart request ${run.record.requestId} completed, but its completion notice could not be delivered. ${this.#errorText(error)}`,
					);
				}
				await this.#flushSessions(run);
			}
		} catch (error) {
			if (!run.cancelled && !this.#disposed) await this.#recordDrainFailure(run, error);
		} finally {
			clearTimeout(run.watchdog);
			if (run.cancelled ? run.cancelNoticeDelivered : !run.callbackStarted || run.record.state === "failed")
				await this.#releaseLeases(run);
			if (this.#run === run && (!run.cancelled || run.cancelNoticeDelivered)) this.#run = undefined;
		}
	}

	async #settleAndFlush(run: ActiveRestartDrain): Promise<boolean> {
		while (true) {
			if (run.cancelled || this.#disposed) return false;
			const notifications = run.notifications.splice(0);
			await this.#measureStage(run.record, "notifications", () => Promise.all(notifications));
			// Child drain leases are already active. Count that time toward their grace
			// instead of granting a second full window after the root finishes.
			const settled = await this.#measureStage(run.record, "root_quiescence", deadline =>
				this.#waitForRoot(run, deadline),
			);
			if (!settled || run.cancelled || this.#disposed) return false;
			await this.#measureStage(run.record, "worker_grace", deadline => this.#waitForWorkerGrace(run, deadline));
			if (run.cancelled || this.#disposed) return false;
			await this.#measureStage(run.record, "flush_sessions", () => this.#flushSessions(run));
			let added = false;
			for (const child of getLiveSubagentsForRestart(this.#session)) {
				if (run.children.has(child.id)) continue;
				await this.#retainIsolation(run, child);
				this.#prepareChild(run, child.id, child.status, child.session);
				added = true;
			}
			if (!added) return true;
		}
	}

	async #waitForRoot(run: ActiveRestartDrain, deadline: number): Promise<boolean> {
		const boundary = Promise.race([
			this.#rootLease(run)
				.waitForQuiescence()
				.then(() => true),
			run.cancelSignal.then(() => false),
		]);
		const expired = Promise.withResolvers<undefined>();
		const timer = setTimeout(() => expired.resolve(undefined), Math.max(0, deadline - Date.now()));
		try {
			const settled = await Promise.race([boundary, expired.promise]);
			if (settled !== undefined) return settled;
			if (run.cancelled || this.#disposed) return false;
			// Keep the lease and its original wait alive: expiry must never interrupt generation.
			run.record = await this.#transition(run, "queued");
			const safe = await boundary;
			if (!safe || run.cancelled || this.#disposed) return false;
			run.record = await this.#transition(run, "draining");
			return true;
		} finally {
			clearTimeout(timer);
		}
	}

	async #measureStage<T>(
		record: RestartRequestRecord | undefined,
		stage: string,
		operation: (deadline: number) => Promise<T>,
	): Promise<T> {
		const started = performance.now();
		const run = this.#run;
		const budget =
			run?.budget ?? (record?.budget ? new RestartBudget(record.budget.deadlineAt, record.budget.plan) : undefined);
		const deadline = budget?.stageDeadline(stage) ?? Number.POSITIVE_INFINITY;
		// Successors retain the original request deadline across runtime replacement.
		let restoreWatchdog: Timer | undefined;
		if (!run && record) {
			const statusRecord = this.#restoringStageRecord(record, stage);
			this.#restoringRecord = statusRecord;
			this.#onStateChange?.(statusRecord);
			if (budget) {
				restoreWatchdog = setTimeout(
					() =>
						this.#notice(
							"error",
							`Restart watchdog: stage ${stage} overran request deadline ${new Date(budget.deadlineAt).toISOString()}`,
						),
					Math.max(0, budget.deadlineAt + this.#restartWatchdogSlackMs - Date.now()),
				);
			}
		}
		if (run && record?.requestId === run.record.requestId) {
			run.record = this.#withDrainStatus(
				{
					...run.record,
					drainStatus: {
						...run.record.drainStatus,
						runningWorkers: run.record.drainStatus?.runningWorkers ?? [],
						queuedInputCount: run.record.drainStatus?.queuedInputCount ?? 0,
						stage,
						stageStartedAt: Date.now(),
						stageDeadlineAt: deadline,
						remainingEstimateMs: run.budget.remainingEstimate(stage),
						deadlineAt: run.budget.deadlineAt,
					},
				},
				run,
			);
			this.#onStateChange?.(run.record);
		}
		const context = {
			requestId: record?.requestId,
			sessionId: this.#session.sessionManager.getSessionId(),
			stage,
			deadlineAt: budget?.deadlineAt,
			remainingEstimateMs: budget?.remainingEstimate(stage),
		};
		logger.info("Restart stage started", {
			...context,
			requestElapsedMs: record ? Math.max(0, Date.now() - record.requestedAt) : undefined,
		});
		let outcome = "failed";
		try {
			const result = await operation(deadline);
			outcome = "settled";
			return result;
		} finally {
			clearTimeout(restoreWatchdog);
			this.#restoringRecord = undefined;
			const samples = this.#recentDurations.get(stage) ?? [];
			samples.push(Math.ceil(performance.now() - started));
			this.#recentDurations.set(stage, samples.slice(-5));
			logger.info("Restart stage finished", {
				...context,
				outcome,
				durationMs: performance.now() - started,
				remainingReserveMs: budget ? budget.deadlineAt - Date.now() : undefined,
				requestElapsedMs: record ? Math.max(0, Date.now() - record.requestedAt) : undefined,
			});
		}
	}

	#restoringStageRecord(record: RestartRequestRecord, stage: string): RestartRequestRecord {
		const budget = record.budget ? new RestartBudget(record.budget.deadlineAt, record.budget.plan) : undefined;
		const stageStartedAt =
			record.drainStatus?.stage === stage ? (record.drainStatus.stageStartedAt ?? Date.now()) : Date.now();
		return {
			...record,
			state: record.state === "completed" ? "restarting" : record.state,
			drainStatus: {
				runningWorkers: [],
				queuedInputCount: this.#session.getRestartPendingInputCount(),
				stage,
				stageStartedAt,
				...(budget
					? {
							stageDeadlineAt: budget.stageDeadline(stage),
							remainingEstimateMs: budget.remainingEstimate(stage),
							deadlineAt: budget.deadlineAt,
						}
					: {}),
			},
		};
	}

	#rootLease(run: ActiveRestartDrain): RestartDrainLease {
		const lease = run.leases.get(this.#session);
		if (!lease) throw new Error("Restart drain has no root session lease");
		return lease;
	}

	async #waitForWorkerGrace(run: ActiveRestartDrain, deadline: number): Promise<void> {
		const liveChildren = new Map(getLiveSubagentsForRestart(this.#session).map(child => [child.id, child.session]));
		const childLeases = [...run.children]
			.filter(([id, session]) => !run.abandoned.has(id) && liveChildren.get(id) === session)
			.map(([, session]) => ({ session, lease: run.leases.get(session) }))
			.filter((item): item is { session: AgentSessionHandle; lease: RestartDrainLease } => item.lease !== undefined);
		if (childLeases.length === 0) return;
		run.workerGraceDeadlineAt = deadline;
		const graceMs = Math.max(0, run.workerGraceDeadlineAt - Date.now());
		run.record = this.#withDrainStatus(run.record, run);
		this.#onStateChange?.(run.record);
		const progressTimer =
			graceMs > 1_000
				? setInterval(() => {
						run.record = this.#withDrainStatus(run.record, run);
						this.#onStateChange?.(run.record);
					}, 1_000)
				: undefined;
		try {
			const settledSessions = new Set<AgentSessionHandle>();
			const wait = Promise.all(
				childLeases.map(async item => {
					try {
						await item.lease.waitForQuiescence();
					} catch (error) {
						if (!item.session.isDisposed) throw error;
						// Idle-TTL parking can dispose a captured child while the root
						// drains. Disposal invalidates its lease but owns the final
						// transcript flush; join it before treating the child as settled.
						await item.session.dispose();
					}
					settledSessions.add(item.session);
				}),
			).then(() => true);
			const settled = await Promise.race([
				wait,
				Bun.sleep(graceMs).then(() => false),
				run.cancelSignal.then(() => false),
			]);
			if (!settled && !run.cancelled)
				await this.#measureStage(run.record, "worker_abort", abortDeadline =>
					this.#abortUnsettledWorkers(run, settledSessions, abortDeadline),
				);
		} finally {
			if (progressTimer) clearInterval(progressTimer);
			run.workerGraceDeadlineAt = undefined;
		}
	}

	async #abortUnsettledWorkers(
		run: ActiveRestartDrain,
		settledSessions: ReadonlySet<AgentSessionHandle>,
		deadline: number,
	): Promise<void> {
		const settlement = Promise.all(
			[...run.children].map(([id, session]) =>
				this.#boundSession(
					run,
					session,
					async () => {
						if (settledSessions.has(session) || run.abandoned.has(id)) return;
						if (!run.runningAgentIds.has(id) && !session.isStreaming) return;
						if (session.isDisposed) {
							await session.dispose();
							return;
						}
						const abort = (session as { abort?: AgentSessionHandle["abort"] }).abort;
						if (typeof abort !== "function")
							throw new Error(`Restart worker ${id} cannot settle after its grace period`);
						await abort.call(session, {
							goalReason: "internal",
							cancelBackgroundJobs: true,
							reason:
								"Restart interrupted this worker; it will continue from its persisted session after relaunch.",
						});
						// abort() acknowledgement alone does not prove that tool results and
						// pending effect receipts have reached the worker's journal.
						await run.leases.get(session)!.waitForQuiescence();
					},
					deadline,
				),
			),
		);
		await Promise.race([settlement, run.cancelSignal]);
	}

	async #flushSessions(run: ActiveRestartDrain): Promise<void> {
		const sessions = [this.#session, ...run.children.values()];
		await Promise.all(
			sessions.map(session =>
				this.#boundSession(run, session, async () => {
					// The worker grace deadline may expire while idle parking is still
					// closing its journal. That terminal flush must finish before relaunch.
					if (session.isDisposed) await session.dispose();
					await session.flushRestartJournal({ handoffIndex: session !== this.#session && !session.isDisposed });
				}),
			),
		);
	}

	async #boundSession(
		run: ActiveRestartDrain,
		session: AgentSessionHandle,
		work: () => Promise<void>,
		stageDeadline?: number,
	): Promise<void> {
		const child = [...run.children].find(([, value]) => value === session);
		if (child && run.abandoned.has(child[0])) return;
		const timeout = new Error("Restart session deadline expired");
		const deadline = Math.min(
			stageDeadline ?? run.budget.stageDeadline(run.record.drainStatus?.stage ?? "prepare"),
			run.budget.stageDeadline("worker_abort"),
		);
		const remaining = Math.max(0, deadline - Date.now());
		try {
			if (!child) {
				await work();
				return;
			}
			await withTimeout(work(), remaining, timeout);
		} catch (error) {
			if (!child || error !== timeout) throw error;
			run.abandoned.add(child[0]);
			run.record = this.#withDrainStatus(run.record, run);
			this.#onStateChange?.(run.record);
		}
	}

	async #transition(
		run: ActiveRestartDrain,
		state: RestartRequestState,
		error?: string,
	): Promise<RestartRequestRecord> {
		if (run.cancelled && state !== "cancelled") throw new Error("Restart request was cancelled before checkpoint");
		return this.#persistState(run.identity, run.record, state, error, run);
	}

	async #persistState(
		identity: RestartControlIdentity,
		current: RestartRequestRecord,
		state: RestartRequestState,
		error?: string,
		run?: ActiveRestartDrain,
	): Promise<RestartRequestRecord> {
		return this.#serialize(() => this.#persistStateUnserialized(identity, current, state, error, run));
	}

	async #persistStateUnserialized(
		identity: RestartControlIdentity,
		current: RestartRequestRecord,
		state: RestartRequestState,
		error?: string,
		run?: ActiveRestartDrain,
		notify = true,
	): Promise<RestartRequestRecord> {
		if (run?.cancelled && state !== "cancelled") throw new Error("Restart request was cancelled before checkpoint");
		const latest = this.#readJournal(identity.sessionId).byId.get(current.requestId)?.record;
		const from = latest?.state ?? current.state;
		if (!canTransition(from, state)) {
			if (from === state) return latest ?? current;
			throw new Error(`Invalid restart request transition ${from} -> ${state}`);
		}
		const base = latest ?? current;
		let next: RestartRequestRecord = {
			...base,
			...(run?.record.drainStatus ? { drainStatus: run.record.drainStatus } : {}),
			state,
			updatedAt: Date.now(),
			...(state === "failed" && error ? { error } : {}),
		};
		if (run && (state === "queued" || state === "draining")) next = this.#withDrainStatus(next, run);
		if (state !== "failed") delete next.error;
		await this.#persistRecord(identity, next);
		if (run) run.record = next;
		if (notify) this.#onStateChange?.(next);
		return next;
	}

	async #persistRecord(identity: RestartControlIdentity, record: RestartRequestRecord): Promise<void> {
		this.#assertCurrentIdentity(identity);
		await this.#session.sessionManager.ensureOnDisk();
		this.#assertCurrentIdentity(identity);
		this.#session.sessionManager.appendCustomEntry(RESTART_REQUEST_TRANSITION_TYPE, {
			version: RESTART_REQUEST_TRANSITION_VERSION,
			identity,
			record,
		} satisfies RestartRequestTransition);
		await this.#session.sessionManager.flush();
		this.#assertCurrentIdentity(identity);
	}

	#readJournal(sessionId: string): RestartJournal {
		const byId = new Map<string, StoredRestartRequest>();
		let latest: StoredRestartRequest | undefined;
		let active: StoredRestartRequest | undefined;
		const entries = selectRestartBranchEntries(
			this.#session.sessionManager,
			metadata => metadata.type === "custom" && metadata.customType === RESTART_REQUEST_TRANSITION_TYPE,
		);
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry) continue;
			const parsed = parseTransition(entry, index);
			if (!parsed || parsed.record.sessionId !== sessionId) continue;
			byId.set(parsed.record.requestId, parsed);
			latest = parsed;
		}
		for (const stored of byId.values()) {
			if (isActiveState(stored.record.state) && (!active || stored.entryIndex > active.entryIndex)) active = stored;
		}
		return { byId, latest, active };
	}

	#restartNoticesFor(requestId: string): Array<{ terminal: boolean }> {
		const notices: Array<{ terminal: boolean }> = [];
		for (const entry of selectRestartBranchEntries(
			this.#session.sessionManager,
			metadata => metadata.type === "custom_message",
		)) {
			if (entry.type !== "custom_message" || entry.customType !== RESTART_QUEUED_NOTICE_TYPE) continue;
			const details: unknown = entry.details;
			const detailedId = isObject(details) && typeof details.requestId === "string" ? details.requestId : undefined;
			const detailedState = isObject(details) && typeof details.state === "string" ? details.state : undefined;
			if (detailedId !== requestId) continue;
			notices.push({
				terminal: detailedState === "completed" || detailedState === "cancelled" || detailedState === "failed",
			});
		}
		return notices;
	}

	#serialize<T>(work: () => Promise<T>): Promise<T> {
		const pending = this.#serial.then(work, work);
		this.#serial = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	async #releaseLeases(run: ActiveRestartDrain): Promise<void> {
		// A failed relaunch must stop the reader before workers can write again.
		await run.snapshotCapture?.stop();
		run.snapshotCapture = undefined;
		clearTimeout(run.watchdog);
		for (const lease of run.leases.values()) {
			try {
				lease.release();
			} catch (error) {
				logger.error("Failed to release restart drain lease", { error: this.#errorText(error) });
			}
		}
		run.leases.clear();
		for (const item of run.isolations.values())
			await fs
				.rm(item.marker, { force: true })
				.catch(error => logger.warn("Cannot remove restart isolation marker", { error }));
	}

	#reportBackgroundFailure(run: ActiveRestartDrain, error: unknown): void {
		void this.#recordDrainFailure(run, error).catch(persistError => {
			this.#notice(
				"error",
				`Restart request ${run.record.requestId} failed and its failure could not be persisted: ${this.#errorText(persistError)}`,
			);
			logger.error("Restart request failure could not be persisted", {
				requestId: run.record.requestId,
				error: this.#errorText(persistError),
			});
		});
	}

	async #recordDrainFailure(run: ActiveRestartDrain, error: unknown): Promise<void> {
		const detail = this.#errorText(error);
		if (run.cancelled || !sameIdentity(this.#identity(), run.identity)) {
			if (!run.cancelled) {
				this.#notice(
					"error",
					`Restart request ${run.record.requestId} stopped because the root session identity changed; no restart was issued. ${detail}`,
				);
			}
			return;
		}
		try {
			run.record = await this.#transition(run, "failed", detail);
			this.#notifySession(run, this.#session);
			for (const child of run.children.values()) this.#notifySession(run, child);
			await Promise.all(run.notifications);
			await this.#restoreGoalModeFor(run.record);
		} catch (persistError) {
			this.#notice(
				"error",
				`Restart request ${run.record.requestId} is blocked: ${detail}. The failure record could not be flushed: ${this.#errorText(persistError)}`,
			);
			throw persistError;
		}
		this.#notice("error", `Restart request ${run.record.requestId} failed safely: ${detail}`);
	}

	#validateControlRequest(request: RestartControlRequest): void {
		if (!isObject(request)) throw new Error("Invalid restart control request");
		if (request.op !== "request" && request.op !== "status" && request.op !== "cancel") {
			throw new Error("Unsupported restart control operation");
		}
		if (
			request.requestId !== undefined &&
			(typeof request.requestId !== "string" ||
				request.requestId.length === 0 ||
				request.requestId.length > MAX_RESTART_REQUEST_ID_LENGTH)
		) {
			throw new Error(
				`Restart request id must be a non-empty string of at most ${MAX_RESTART_REQUEST_ID_LENGTH} characters`,
			);
		}
		if (
			request.reason !== undefined &&
			(request.op !== "request" ||
				typeof request.reason !== "string" ||
				request.reason.length > MAX_RESTART_REASON_LENGTH)
		) {
			throw new Error(
				`Only restart requests may include a reason of at most ${MAX_RESTART_REASON_LENGTH} characters`,
			);
		}
	}

	async #resumeAfterRestoredAsk(record: RestartRequestRecord | undefined, answered: boolean): Promise<void> {
		const resumeWork = answered || record?.rootWasRunning === true || this.#session.getRestartPendingInputCount() > 0;
		if (record) await this.#restoreGoalModeFor(record, resumeWork);
		// restore() skips the continuation while a question owns the root; restored
		// input stays held until one exists, so publish it once the question settles.
		if (!this.#disposed && resumeWork && record?.state === "completed")
			await sendRootContinuationOnce(this.#session, record.requestId);
		if (!this.#disposed && resumeWork) this.#session.resumeAfterAskReanswer();
	}

	async #restoreGoalModeFor(record: RestartRequestRecord, resumeWork = true): Promise<void> {
		if (!record.goalModeBefore || !this.#restoreGoalMode) return;
		try {
			await this.#restoreGoalMode(record.goalModeBefore, resumeWork);
		} catch (error) {
			this.#notice(
				"error",
				`Restart request ${record.requestId} reached ${record.state}, but its prior goal mode could not be restored: ${this.#errorText(error)}`,
			);
		}
	}
	#assertRequestIdentity(identity: RestartControlIdentity): RestartControlIdentity {
		const current = this.#currentIdentity();
		if (!parseIdentity(identity) || !sameIdentity(identity, current)) {
			throw new Error("Restart control identity is stale; no request was persisted");
		}
		return current;
	}

	#currentIdentity(): RestartControlIdentity {
		const identity = parseIdentity(this.#identity());
		if (!identity) throw new Error("Restart controller identity is invalid");
		if (identity.sessionId !== this.#session.sessionManager.getSessionId()) {
			throw new Error("Restart controller session identity does not match its current branch");
		}
		return identity;
	}

	#assertCurrentIdentity(identity: RestartControlIdentity): void {
		if (!sameIdentity(this.#currentIdentity(), identity)) {
			throw new Error("Restart controller identity changed before durable state was flushed");
		}
	}

	#makeSnapshot(identity: RestartControlIdentity, request: RestartRequestRecord | null): RestartControlSnapshot {
		const stageStartedAt = request?.drainStatus?.stageStartedAt;
		if (request?.drainStatus && stageStartedAt !== undefined) {
			const observedAt = isActiveState(request.state) ? Date.now() : request.updatedAt;
			request = {
				...request,
				drainStatus: { ...request.drainStatus, stageElapsedMs: Math.max(0, observedAt - stageStartedAt) },
			};
		}
		return { identity: { ...identity }, pid: process.pid, cwd: this.#session.sessionManager.getCwd(), request };
	}

	#notice(level: "warning" | "error", message: string): void {
		this.#session.emitNotice(level, message, "restart-queue");
	}

	#errorText(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).slice(0, MAX_RESTART_ERROR_LENGTH);
	}

	#assertUsable(): void {
		if (this.#disposed) throw new Error("Restart controller is disposed");
	}
}

export function createRestartQueueController(options: RestartQueueControllerOptions): RestartQueueController {
	return new RestartQueueControllerImpl(options);
}
