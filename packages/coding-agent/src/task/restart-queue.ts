import { logger } from "@oh-my-pi/pi-utils";
import restartQueuedPrompt from "../prompts/restart-queued.md" with { type: "text" };
import type { RestartDrainLease } from "../session/agent-session-types";
import type { AgentSession } from "../session/agent-session";
import {
	captureSubagentsForRestart,
	getLiveSubagentsForRestart,
	restoreSubagentsAfterRestart,
	sendRootContinuationOnce,
} from "./restart-recovery";
import type { SessionEntry } from "../session/session-entries";

const RESTART_REQUEST_TRANSITION_TYPE = "restart_request_transition";
const RESTART_REQUEST_TRANSITION_VERSION = 1;
const MAX_RESTART_REQUEST_ID_LENGTH = 128;
const MAX_RESTART_REASON_LENGTH = 1_024;
const MAX_RESTART_ERROR_LENGTH = 4_096;

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
}

export interface RestartControlSnapshot {
	identity: RestartControlIdentity;
	pid: number;
	cwd: string;
	request: RestartRequestRecord | null;
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
	dispose(): void;
}

export interface RestartQueueControllerOptions {
	session: AgentSession;
	identity: () => RestartControlIdentity;
	restart: () => Promise<void>;
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
	leases: Map<AgentSession, RestartDrainLease>;
	children: Map<string, AgentSession>;
	runningAgentIds: Set<string>;
	notifications: Promise<void>[];
	irreversible: boolean;
	callbackStarted: boolean;
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

/** Human-facing state for a persisted restart notice; the model prompt remains unchanged. */
export function restartNoticeText(entries: readonly SessionEntry[], requestId: string): string {
	let latest: RestartRequestRecord | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry) continue;
		const transition = parseTransition(entry, index);
		if (transition?.record.requestId === requestId) latest = transition.record;
	}
	switch (latest?.state) {
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

/** Only a checkpoint from the previous process licenses active-goal recovery. */
export function isRestartResumePending(
	entries: readonly SessionEntry[],
	sessionId: string,
	instanceId: string,
): boolean {
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
	if (from === "draining") return to === "checkpointed" || to === "cancelled";
	if (from === "checkpointed") return to === "restarting" || to === "completed";
	return from === "restarting" && to === "completed";
}

function makeRun(identity: RestartControlIdentity, record: RestartRequestRecord): ActiveRestartDrain {
	const { promise, resolve } = Promise.withResolvers<void>();
	return {
		identity,
		record,
		cancelled: false,
		cancelSignal: promise,
		resolveCancel: resolve,
		leases: new Map(),
		children: new Map(),
		runningAgentIds: new Set(),
		notifications: [],
		irreversible: false,
		callbackStarted: false,
		cancelNoticeDelivered: false,
	};
}

class RestartQueueControllerImpl implements RestartQueueController {
	readonly #session: AgentSession;
	readonly #identity: () => RestartControlIdentity;
	readonly #restart: () => Promise<void>;
	#serial: Promise<void> = Promise.resolve();
	#run: ActiveRestartDrain | undefined;
	#restorePromise: Promise<void> | undefined;
	#disposed = false;

	constructor(options: RestartQueueControllerOptions) {
		this.#session = options.session;
		this.#identity = options.identity;
		this.#restart = options.restart;
	}

	snapshot(): RestartControlSnapshot {
		const identity = this.#identity();
		const journal = this.#readJournal(identity.sessionId);
		return this.#makeSnapshot(identity, journal.latest?.record ?? null);
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
			return Promise.resolve(this.#makeSnapshot(identity, selected ?? null));
		}
		if (request.op === "request") return this.#requestRestart(request, identity);
		if (request.op === "cancel") return this.#cancelRestart(request, identity);
		return Promise.reject(new Error("Unsupported restart control operation"));
	}

	restore(): Promise<void> {
		this.#assertUsable();
		if (this.#restorePromise) return this.#restorePromise;
		const identity = this.#currentIdentity();
		this.#restorePromise = this.#serialize(async () => {
			const stored = this.#readJournal(identity.sessionId).latest;
			let record = stored?.record;
			let restartCompleted = record?.state === "completed";
			if (stored && record?.state === "checkpointed") {
				if (stored.identity.instanceId !== identity.instanceId) {
					record = await this.#persistStateUnserialized(identity, record, "completed");
					restartCompleted = true;
				} else {
					record = await this.#persistStateUnserialized(identity, record, "restarting");
					try {
						this.#assertCurrentIdentity(identity);
						await this.#restart();
						record = await this.#persistStateUnserialized(identity, record, "completed");
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
					record = await this.#persistStateUnserialized(identity, record, "completed");
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

			await restoreSubagentsAfterRestart(this.#session);
			if (restartCompleted && record?.rootWasRunning) {
				await sendRootContinuationOnce(this.#session, record.requestId);
			}
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
		this.#releaseLeases(run);
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
		const record: RestartRequestRecord = {
			version: RESTART_REQUEST_TRANSITION_VERSION,
			requestId,
			sessionId: identity.sessionId,
			state: "queued",
			requestedAt: now,
			updatedAt: now,
			...(reason !== undefined ? { reason } : {}),
			rootWasRunning: this.#session.isStreaming,
		};
		const run = makeRun(identity, record);
		this.#run = run;
		const ack = this.#serialize(async () => {
			try {
				this.#prepareInitialDrain(run);
				await this.#persistRecord(identity, run.record);
				if (run.cancelled) {
					run.record = await this.#persistStateUnserialized(identity, run.record, "cancelled");
					return this.#makeSnapshot(identity, run.record);
				}
				void this.#drain(run).catch(error => this.#reportBackgroundFailure(run, error));
				return this.#makeSnapshot(identity, run.record);
			} catch (error) {
				this.#releaseLeases(run);
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
				this.#releaseLeases(pendingRun);
				if (this.#run === pendingRun) this.#run = undefined;
			}
			return this.#makeSnapshot(identity, cancelled);
		});
	}

	#prepareInitialDrain(run: ActiveRestartDrain): void {
		const rootWasStreaming = this.#session.isStreaming;
		this.#notifySession(run, this.#session);
		const rootLease = this.#takeLease(run, this.#session);
		run.record = { ...run.record, rootWasRunning: rootLease.wasRunning || rootWasStreaming };
		for (const child of getLiveSubagentsForRestart(this.#session))
			this.#prepareChild(run, child.id, child.status, child.session);
	}

	#prepareChild(run: ActiveRestartDrain, id: string, status: string, session: AgentSession): void {
		const priorSession = run.children.get(id);
		if (priorSession) {
			if (priorSession !== session)
				throw new Error(`Cannot restart safely: live child ${id} changed session identity while draining.`);
			return;
		}
		run.children.set(id, session);
		if (status === "running" || session.isStreaming) run.runningAgentIds.add(id);
		this.#notifySession(run, session);
		const lease = this.#takeLease(run, session);
		if (lease.wasRunning) run.runningAgentIds.add(id);
	}

	#notifySession(run: ActiveRestartDrain, session: AgentSession): void {
		let notification: Promise<void>;
		try {
			notification = session
				.sendCustomMessage(
					{
						customType: "restart-queued",
						content: restartQueuedPrompt.trim(),
						display: true,
						attribution: "agent",
						details: { requestId: run.record.requestId, state: run.record.state },
					},
					{ deliverAs: "nextTurn", triggerTurn: false },
				)
				.then(() => undefined);
		} catch (error) {
			notification = Promise.reject(error);
		}
		void notification.catch(() => {});
		run.notifications.push(notification);
	}

	#takeLease(run: ActiveRestartDrain, session: AgentSession): RestartDrainLease {
		const existing = run.leases.get(session);
		if (existing) return existing;
		const lease = session.beginRestartDrain();
		run.leases.set(session, lease);
		return lease;
	}

	async #drain(run: ActiveRestartDrain): Promise<void> {
		try {
			if (run.cancelled) return;
			run.record = await this.#transition(run, "draining");
			const safe = await this.#settleAndFlush(run);
			if (!safe || run.cancelled || this.#disposed) return;
			await captureSubagentsForRestart(this.#session, { runningAgentIds: run.runningAgentIds });
			if (run.cancelled || this.#disposed) return;
			run.record = await this.#transition(run, "checkpointed");
			if (run.cancelled || this.#disposed) return;
			run.irreversible = true;
			run.record = await this.#transition(run, "restarting");
			run.callbackStarted = true;
			await this.#restart();
			if (!this.#disposed) run.record = await this.#transition(run, "completed");
		} catch (error) {
			if (!run.cancelled && !this.#disposed) await this.#recordDrainFailure(run, error);
		} finally {
			if (run.cancelled ? run.cancelNoticeDelivered : !run.callbackStarted) this.#releaseLeases(run);
			if (this.#run === run && (!run.cancelled || run.cancelNoticeDelivered)) this.#run = undefined;
		}
	}

	async #settleAndFlush(run: ActiveRestartDrain): Promise<boolean> {
		while (true) {
			if (run.cancelled || this.#disposed) return false;
			const notifications = run.notifications.splice(0);
			await Promise.all(notifications);
			const wait = Promise.all([...run.leases.values()].map(lease => lease.waitForQuiescence())).then(() => true);
			const settled = await Promise.race([wait, run.cancelSignal.then(() => false)]);
			if (!settled || run.cancelled || this.#disposed) return false;
			await this.#flushSessions(run);
			let added = false;
			for (const child of getLiveSubagentsForRestart(this.#session)) {
				if (run.children.has(child.id)) continue;
				this.#prepareChild(run, child.id, child.status, child.session);
				added = true;
			}
			if (!added) return true;
		}
	}

	async #flushSessions(run: ActiveRestartDrain): Promise<void> {
		const sessions = [this.#session, ...run.children.values()];
		await Promise.all(
			sessions.map(async session => {
				await session.sessionManager.ensureOnDisk();
				await session.sessionManager.flush();
			}),
		);
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
	): Promise<RestartRequestRecord> {
		if (run?.cancelled && state !== "cancelled") throw new Error("Restart request was cancelled before checkpoint");
		const latest = this.#readJournal(identity.sessionId).byId.get(current.requestId)?.record;
		const from = latest?.state ?? current.state;
		if (!canTransition(from, state)) {
			if (from === state) return latest ?? current;
			throw new Error(`Invalid restart request transition ${from} -> ${state}`);
		}
		const base = latest ?? current;
		const next: RestartRequestRecord = {
			...base,
			state,
			updatedAt: Date.now(),
			...(state === "failed" && error ? { error } : {}),
		};
		if (state !== "failed") delete next.error;
		await this.#persistRecord(identity, next);
		if (run) run.record = next;
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
		const entries = this.#session.sessionManager.getBranch();
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

	#serialize<T>(work: () => Promise<T>): Promise<T> {
		const pending = this.#serial.then(work, work);
		this.#serial = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	#releaseLeases(run: ActiveRestartDrain): void {
		for (const lease of run.leases.values()) {
			try {
				lease.release();
			} catch (error) {
				logger.error("Failed to release restart drain lease", { error: this.#errorText(error) });
			}
		}
		run.leases.clear();
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
