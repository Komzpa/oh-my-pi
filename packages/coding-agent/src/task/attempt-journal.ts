import * as fs from "node:fs";
import * as path from "node:path";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import { BlobStore, BLOB_HASH_RE } from "../session/blob-store";
import { FileSessionStorage, tryAcquireSessionLease } from "../session/session-storage";
import type {
	AttemptJournalAttempt,
	AttemptJournalCommand,
	AttemptJournalEvent,
	AttemptJournalProjection,
	AttemptJournalResult,
	AttemptJournalTaskCommand,
} from "./attempt-journal-types";
export * from "./attempt-journal-types";

const taskKinds: Record<string, true> = {
	AttemptQueued: true,
	AttemptStarted: true,
	ResultCommitted: true,
	AttemptAborted: true,
	AttemptCancelled: true,
	GenerationAdvanced: true,
	OwnerTransferred: true,
	CheckpointRecorded: true,
	LegacyImported: true,
	LegacyAdopted: true,
};
const states: Record<string, true> = {
	queued: true,
	running: true,
	succeeded: true,
	failed: true,
	aborted: true,
	cancelled: true,
	unknown: true,
	"legacy-unresolved": true,
};
const restartStates = ["queued", "draining", "ready", "restoring", "completed", "failed", "cancelled"];
function fail(message: string): never {
	throw new Error(`Attempt journal: ${message}`);
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function integer(value: unknown, minimum = 0): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function terminal(state: string): boolean {
	return ["succeeded", "failed", "aborted", "cancelled"].includes(state);
}
function requestTerminal(state: string): boolean {
	return ["completed", "failed", "cancelled"].includes(state);
}
const canonical = stableStringifyJson;
function payload(command: AttemptJournalCommand | AttemptJournalEvent): string {
	const copy = { ...command } as Record<string, unknown>;
	for (const key of ["v", "leadSessionId", "seq", "writerEpoch", "at", "artifact"]) delete copy[key];
	return canonical(copy);
}
function validateResult(result: unknown): asserts result is AttemptJournalResult {
	if (
		!object(result) ||
		!text(result.sha256) ||
		!BLOB_HASH_RE.test(result.sha256) ||
		!text(result.artifactUri) ||
		!text(result.mediaType) ||
		!["success", "failure"].includes(String(result.executionOutcome))
	)
		fail("invalid result artifact");
}
function validateSource(source: unknown): void {
	if (!object(source) || !text(source.fingerprint) || !Array.isArray(source.entryIds) || !source.entryIds.every(text))
		fail("invalid source provenance");
}
function validateCommand(value: unknown): asserts value is AttemptJournalCommand {
	if (!object(value) || !text(value.kind) || !text(value.commandId)) fail("invalid command schema");
	if (Object.hasOwn(taskKinds, value.kind)) {
		const imported = value.kind === "LegacyImported" || value.kind === "LegacyAdopted";
		const resultKind = imported || value.kind === "ResultCommitted";
		if (("result" in value || "artifact" in value) && !resultKind)
			fail("result payload is not allowed for this event kind");
		if ("checkpoint" in value && !imported && value.kind !== "CheckpointRecorded")
			fail("checkpoint is not allowed for this event kind");
		if ("source" in value && !imported) fail("source is not allowed for this event kind");
		if (["requestId", "affectedAttempts", "restart"].some(key => key in value))
			fail("task event cannot contain restart aggregate fields");
		if (
			!text(value.taskId) ||
			!integer(value.attempt) ||
			!integer(value.generation, imported ? 0 : 1) ||
			!Object.hasOwn(states, String(value.state))
		)
			fail("invalid task identity/state");
		const owner = value.owner;
		if (
			owner !== null &&
			(!object(owner) ||
				!text(owner.ownerName) ||
				!text(owner.workerId) ||
				!text(owner.childSessionId) ||
				!integer(owner.leaseEpoch, 1))
		)
			fail("invalid task owner");
		if (value.rowId !== undefined && !text(value.rowId)) fail("invalid row identity");
		if (value.purpose !== undefined && !["work", "audit", "observe"].includes(String(value.purpose)))
			fail("invalid purpose");
		for (const key of ["expectedRevision", "expectedAttempt", "expectedGeneration", "expectedLeaseEpoch"]) {
			if (value.kind === "LegacyImported" && value[key] === undefined) continue;
			if (!integer(value[key])) fail(`missing or invalid ${key}`);
		}
		if (value.expectedRowRevision !== undefined && !integer(value.expectedRowRevision)) fail("invalid row revision");
		if (value.kind === "ResultCommitted" || value.result !== undefined) validateResult(value.result);
		if (
			value.kind === "ResultCommitted" &&
			object(value.result) &&
			value.result.artifactUri !== `blob:sha256:${value.result.sha256}`
		)
			fail("result commit requires content-addressed blob");
		if (value.kind === "CheckpointRecorded" && !text(value.checkpoint)) fail("missing resumable checkpoint");
		if (value.kind === "LegacyImported" || value.kind === "LegacyAdopted") validateSource(value.source);
		if (
			value.artifact !== undefined &&
			(!object(value.artifact) || typeof value.artifact.data !== "string" || !text(value.artifact.mediaType))
		)
			fail("invalid artifact bytes");
	} else if (value.kind === "RestartTransition" || value.kind === "LegacyRestartImported") {
		if (["taskId", "attempt", "generation", "owner", "rowId", "result"].some(key => key in value))
			fail("restart event cannot contain task aggregate fields");
		if (
			!text(value.requestId) ||
			!(
				restartStates.includes(String(value.state)) ||
				(value.kind === "LegacyRestartImported" && value.state === "unknown")
			) ||
			!Array.isArray(value.affectedAttempts) ||
			!value.affectedAttempts.every(ref => object(ref) && text(ref.taskId) && integer(ref.attempt))
		)
			fail("invalid restart schema");
		if (value.kind === "LegacyRestartImported") validateSource(value.source);
		if (value.reason !== undefined && !text(value.reason)) fail("invalid restart reason");
		if (
			value.accountedChildren !== undefined &&
			(!Array.isArray(value.accountedChildren) || !value.accountedChildren.every(text))
		)
			fail("invalid accounted children");
	} else if (value.kind === "NoticeApplied") {
		if (!text(value.childSessionId) || !text(value.requestId) || !integer(value.terminalEventSeq, 1))
			fail("invalid notice schema");
	} else if (value.kind === "ImportCompleted") {
		if (!text(value.sourceFingerprint)) fail("invalid import fingerprint");
	} else if (value.kind !== "WriterEpochStarted") fail("unknown event kind");
}
export function decodeAttemptJournalEvent(line: string): AttemptJournalEvent {
	const value: unknown = JSON.parse(line);
	validateCommand(value);
	const envelope = value as unknown as Record<string, unknown>;
	if (envelope.v !== 1) fail("unknown schema version");
	if (
		!text(envelope.leadSessionId) ||
		!integer(envelope.seq, 1) ||
		!integer(envelope.writerEpoch, 1) ||
		!text(envelope.at) ||
		!Number.isFinite(Date.parse(envelope.at))
	)
		fail("invalid envelope");
	return value as AttemptJournalEvent;
}
export function encodeAttemptJournalEvent(event: AttemptJournalEvent): string {
	decodeAttemptJournalEvent(JSON.stringify(event));
	return `${JSON.stringify(event)}\n`;
}
export function createAttemptJournalProjection(leadSessionId: string): AttemptJournalProjection {
	return {
		leadSessionId,
		appliedSeq: 0,
		writerEpoch: 0,
		tasks: {},
		rows: {},
		restarts: {},
		notices: {},
		imports: [],
		commands: {},
	};
}
export function getAttemptJournalAssignment(
	projection: AttemptJournalProjection,
	rowId: string,
): AttemptJournalAttempt | undefined {
	const current = projection.rows[rowId]?.currentWork;
	return current ? projection.tasks[current.taskId]?.attempts[current.attempt] : undefined;
}
function reduceTask(p: AttemptJournalProjection, e: AttemptJournalEvent & AttemptJournalTaskCommand): void {
	const task = p.tasks[e.taskId];
	const old = task?.attempts[task.currentAttempt];
	// Compare producer expectations against the current durable attempt.
	if (
		(e.expectedRevision ?? 0) !== (task?.revision ?? 0) ||
		(e.expectedAttempt ?? 0) !== (old?.attempt ?? 0) ||
		(e.expectedGeneration ?? 0) !== (old?.generation ?? 0) ||
		(e.expectedLeaseEpoch ?? 0) !== (old?.leaseEpoch ?? 0)
	)
		fail("stale revision, attempt, generation or lease epoch");
	const previous = task?.attempts[e.attempt];
	// One terminal fact per task/attempt, regardless of command ID or generation.
	if (previous?.terminalSeq && e.kind !== "GenerationAdvanced" && e.kind !== "OwnerTransferred")
		fail("terminal outcome already committed");
	const creation = e.kind === "AttemptQueued" || e.kind === "LegacyImported";
	if (creation) {
		if (
			previous ||
			(e.kind === "LegacyImported" ? !!task : e.attempt !== (task?.currentAttempt ?? 0) + 1) ||
			(old && !terminal(old.state))
		)
			fail("new attempt requires next attempt after terminal");
		if (e.kind === "AttemptQueued" && (e.state !== "queued" || e.generation !== 1 || !e.owner))
			fail("queued attempt requires initial generation and owner");
	} else {
		if (!previous || e.attempt !== task?.currentAttempt) fail("attempt does not exist or is not current");
		if (e.kind === "GenerationAdvanced") {
			if (
				e.generation !== previous.generation + 1 ||
				e.state !== previous.state ||
				e.owner?.ownerName !== previous.owner?.ownerName ||
				(e.owner && e.owner.leaseEpoch < previous.leaseEpoch)
			)
				fail("invalid generation advancement");
		} else if (e.kind === "LegacyAdopted") {
			if (e.generation !== previous.generation + 1 || (e.owner && e.owner.leaseEpoch <= previous.leaseEpoch))
				fail("adoption must fence prior producers");
			if (["queued", "running"].includes(e.state) && !e.owner) fail("dispatchable adoption requires owner");
			if (
				!previous.source ||
				e.source.fingerprint !== previous.source.fingerprint ||
				canonical(e.source.entryIds) !== canonical(previous.source.entryIds)
			)
				fail("adoption must select retained source evidence");
			if (e.result) {
				const candidates = previous.source.conflicts;
				if (
					!Array.isArray(candidates) ||
					!candidates.some(
						candidate =>
							object(candidate) &&
							candidate.sha256 === e.result?.sha256 &&
							candidate.executionOutcome === e.result?.executionOutcome &&
							candidate.mediaType === e.result?.mediaType,
					)
				)
					fail("adopted result is not retained conflict evidence");
			}
		} else if (e.generation !== previous.generation) fail("generation must be advanced explicitly");
		if (
			(e.rowId !== undefined && e.rowId !== previous.rowId) ||
			(e.purpose !== undefined && e.purpose !== previous.purpose)
		)
			fail("attempt row and purpose are immutable");
		if (
			e.kind !== "OwnerTransferred" &&
			e.kind !== "GenerationAdvanced" &&
			e.kind !== "LegacyAdopted" &&
			canonical(e.owner) !== canonical(previous.owner)
		)
			fail("owner change requires transfer");
		if (e.kind === "AttemptStarted" && (!e.owner || previous.state !== "queued" || e.state !== "running"))
			fail("start requires queued attempt with current owner");
		if (
			e.kind === "ResultCommitted" &&
			(!e.owner ||
				!["running", "succeeded", "failed"].includes(previous.state) ||
				e.state !== (e.result.executionOutcome === "success" ? "succeeded" : "failed"))
		)
			fail("result requires owned running attempt and matching outcome");
		if (
			(e.kind === "AttemptAborted" || e.kind === "AttemptCancelled") &&
			(!["queued", "running"].includes(previous.state) ||
				e.state !== (e.kind === "AttemptAborted" ? "aborted" : "cancelled"))
		)
			fail("explicit stop requires queued/running attempt");
		if (
			e.kind === "LegacyAdopted" &&
			(previous.state !== "legacy-unresolved" || e.state === "legacy-unresolved" || e.state === "unknown")
		)
			fail("adoption requires unresolved evidence and resolved state");
		if ((e.kind === "OwnerTransferred" || e.kind === "CheckpointRecorded") && e.state !== previous.state)
			fail("custody/checkpoint cannot change outcome");
		if (e.kind === "OwnerTransferred" && e.owner && e.owner.leaseEpoch <= previous.leaseEpoch)
			fail("replacement must advance retained lease epoch");
	}
	const revision = (task?.revision ?? 0) + 1;
	const attempt: AttemptJournalAttempt = {
		...previous,
		taskId: e.taskId,
		attempt: e.attempt,
		generation: e.generation,
		state: e.state,
		owner: e.owner,
		leaseEpoch: e.owner?.leaseEpoch ?? previous?.leaseEpoch ?? 0,
		rowId: e.rowId ?? previous?.rowId,
		purpose: e.purpose ?? previous?.purpose ?? "work",
		revision,
	};
	if ("result" in e && e.result) attempt.result = e.result;
	if ("checkpoint" in e && e.checkpoint) attempt.checkpoint = e.checkpoint;
	if ("source" in e) attempt.source = e.kind === "LegacyAdopted" ? previous?.source : e.source;
	if (terminal(e.state)) attempt.terminalSeq ??= e.seq;
	if ((e.state === "succeeded" || (e.state === "failed" && e.kind !== "LegacyImported")) && !attempt.result)
		fail("terminal execution outcome requires immutable result");
	if (
		attempt.result &&
		e.state !== (attempt.result.executionOutcome === "success" ? "succeeded" : "failed") &&
		e.state !== "legacy-unresolved"
	)
		fail("result cannot be overwritten by another outcome");
	p.tasks[e.taskId] = {
		taskId: e.taskId,
		revision,
		currentAttempt: e.attempt,
		attempts: { ...task?.attempts, [e.attempt]: attempt },
	};
	if (attempt.rowId && attempt.purpose !== "observe") {
		const row = p.rows[attempt.rowId] ?? { rowId: attempt.rowId, revision: 0, owner: null };
		if (e.kind !== "LegacyImported" && e.expectedRowRevision !== row.revision) fail("stale or missing row revision");
		if (e.kind === "GenerationAdvanced" && row.stageTaskId !== e.taskId) return;
		if (row.owner && row.stageTaskId !== e.taskId) {
			const stage = row.stageTaskId ? p.tasks[row.stageTaskId] : undefined;
			const stageAttempt = stage?.attempts[stage.currentAttempt];
			if (
				!stageAttempt ||
				!terminal(stageAttempt.state) ||
				!creation ||
				!["work", "audit"].includes(attempt.purpose ?? "work")
			)
				fail("row already has an exclusive stage owner");
		}
		row.revision++;
		row.owner = e.owner;
		row.stageTaskId = e.owner ? e.taskId : undefined;
		if (attempt.purpose === "work") row.currentWork = { taskId: e.taskId, attempt: e.attempt };
		p.rows[attempt.rowId] = row;
	}
}
export function reduceAttemptJournalEvent(
	projection: AttemptJournalProjection,
	event: AttemptJournalEvent,
): AttemptJournalProjection {
	decodeAttemptJournalEvent(JSON.stringify(event));
	if (event.leadSessionId !== projection.leadSessionId || event.seq !== projection.appliedSeq + 1)
		fail("lead or sequence mismatch");
	if (
		event.kind === "WriterEpochStarted"
			? event.writerEpoch !== projection.writerEpoch + 1
			: event.writerEpoch !== projection.writerEpoch
	)
		fail("writer epoch mismatch");
	const key = `${event.leadSessionId}\0${event.commandId}`;
	if (projection.commands[key]) fail("duplicate command record");
	const p = structuredClone(projection);
	if (Object.hasOwn(taskKinds, event.kind)) reduceTask(p, event as AttemptJournalEvent & AttemptJournalTaskCommand);
	else if (event.kind === "WriterEpochStarted") p.writerEpoch = event.writerEpoch;
	else if (event.kind === "RestartTransition" || event.kind === "LegacyRestartImported") {
		const old = p.restarts[event.requestId];
		if (old && requestTerminal(old.state)) fail("restart already terminal");
		if (event.kind === "LegacyRestartImported") {
			if (old) fail("restart already imported");
		} else {
			if (
				!old
					? event.state !== "queued"
					: old.state === "unknown" ||
						!(
							["failed", "cancelled"].includes(event.state) ||
							restartStates.indexOf(event.state) === restartStates.indexOf(old.state) + 1
						)
			)
				fail("illegal restart transition");
			if (old && canonical(old.affectedAttempts) !== canonical(event.affectedAttempts))
				fail("affected attempts cannot change");
			if (["failed", "cancelled"].includes(event.state) && !event.reason) fail("terminal restart requires reason");
			const affected = event.affectedAttempts.map(ref => p.tasks[ref.taskId]?.attempts[ref.attempt]);
			if (event.state === "ready" && affected.some(attempt => !attempt || (!attempt.result && !attempt.checkpoint)))
				fail("ready requires durable results or checkpoints");
			if (
				event.state === "completed" &&
				affected.some(
					attempt =>
						!attempt || (attempt.owner && !event.accountedChildren?.includes(attempt.owner.childSessionId)),
				)
			)
				fail("completed requires every child accounted for");
		}
		p.restarts[event.requestId] = { ...event, seq: event.seq };
	} else if (event.kind === "NoticeApplied") {
		const request = p.restarts[event.requestId];
		if (!request || !requestTerminal(request.state) || request.seq !== event.terminalEventSeq)
			fail("notice must reference latest terminal restart");
		const notice = p.notices[event.childSessionId] ?? { appliedSeq: 0, keys: [] };
		const noticeKey = `${event.requestId}\0${event.terminalEventSeq}`;
		if (!notice.keys.includes(noticeKey)) notice.keys.push(noticeKey);
		notice.appliedSeq = Math.max(notice.appliedSeq, event.terminalEventSeq);
		p.notices[event.childSessionId] = notice;
	} else if (event.kind === "ImportCompleted") {
		if (p.imports.includes(event.sourceFingerprint)) fail("import already completed");
		p.imports.push(event.sourceFingerprint);
	}
	p.appliedSeq = event.seq;
	p.commands[key] = { payload: payload(event), event: structuredClone(event) };
	return p;
}
export function replayAttemptJournalEvents(
	events: readonly AttemptJournalEvent[],
	leadSessionId = events[0]?.leadSessionId ?? "",
): AttemptJournalProjection {
	return events.reduce(reduceAttemptJournalEvent, createAttemptJournalProjection(leadSessionId));
}
function syncPath(file: string): void {
	const fd = fs.openSync(file, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}
export interface AttemptJournalOpenOptions {
	path: string;
	leadSessionId: string;
	blobDir?: string;
}
const constructionToken = Symbol("AttemptJournal.open");
export class AttemptJournal {
	#projection: AttemptJournalProjection;
	#lease: FileLockHandle;
	#storage = new FileSessionStorage();
	#blobs: BlobStore;
	#closed = false;
	#poisoned = false;
	#path: string;
	constructor(options: AttemptJournalOpenOptions, lease: FileLockHandle, token: symbol) {
		if (token !== constructionToken) fail("use AttemptJournal.open to acquire the writer lease");
		this.#path = options.path;
		this.#projection = createAttemptJournalProjection(options.leadSessionId);
		this.#lease = lease;
		this.#blobs = new BlobStore(options.blobDir ?? path.join(path.dirname(options.path), "attempt-blobs"));
	}
	static async open(options: AttemptJournalOpenOptions): Promise<AttemptJournal> {
		if (!text(options.leadSessionId)) fail("missing lead session ID");
		const lease = tryAcquireSessionLease(`attempt-journal-${options.leadSessionId}`);
		if (!lease) fail("another writer owns this lead journal");
		const journal = new AttemptJournal(options, lease, constructionToken);
		try {
			fs.mkdirSync(path.dirname(options.path), { recursive: true });
			journal.#storage.withSidecarAppendLockSync(options.path, () => {
				const fd = fs.openSync(options.path, "a+", 0o600);
				try {
					const bytes = fs.readFileSync(fd);
					const lastNewline = bytes.lastIndexOf(10);
					const complete = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, lastNewline + 1));
					for (const line of complete.split("\n").slice(0, -1))
						journal.#projection = reduceAttemptJournalEvent(journal.#projection, decodeAttemptJournalEvent(line));
					if (bytes.length !== lastNewline + 1) fs.ftruncateSync(fd, lastNewline + 1);
					fs.fsyncSync(fd);
				} finally {
					fs.closeSync(fd);
				}
				syncPath(path.dirname(options.path));
			});
			await journal.append({
				kind: "WriterEpochStarted",
				commandId: `writer-epoch-${journal.#projection.writerEpoch + 1}`,
			});
			return journal;
		} catch (error) {
			lease.release();
			throw error;
		}
	}
	snapshot(): AttemptJournalProjection {
		return structuredClone(this.#projection);
	}
	async append(command: AttemptJournalCommand): Promise<AttemptJournalEvent> {
		if (this.#closed || this.#poisoned) fail("writer closed or uncertain; reopen before retry");
		validateCommand(command);
		const normalized = structuredClone(command);
		if (
			(normalized.kind === "ResultCommitted" ||
				normalized.kind === "LegacyImported" ||
				normalized.kind === "LegacyAdopted") &&
			normalized.artifact
		) {
			const hash = new Bun.SHA256().update(normalized.artifact.data).digest("hex");
			if (
				!normalized.result ||
				hash !== normalized.result.sha256 ||
				normalized.artifact.mediaType !== normalized.result.mediaType
			)
				fail("artifact hash or media type mismatch");
		}
		return this.#storage.withSidecarAppendLockSync(this.#path, () => {
			const key = `${this.#projection.leadSessionId}\0${normalized.commandId}`;
			// Durable command deduplication: keep this guard independent of terminal uniqueness.
			const prior = this.#projection.commands[key];
			if (prior) {
				if (prior.payload !== payload(normalized)) fail("command ID payload conflict");
				return structuredClone(prior.event);
			}
			const event = {
				...normalized,
				v: 1,
				leadSessionId: this.#projection.leadSessionId,
				seq: this.#projection.appliedSeq + 1,
				writerEpoch: this.#projection.writerEpoch + (normalized.kind === "WriterEpochStarted" ? 1 : 0),
				at: new Date().toISOString(),
			} as AttemptJournalEvent;
			if (event.kind === "ResultCommitted" || event.kind === "LegacyImported" || event.kind === "LegacyAdopted")
				delete event.artifact;
			const next = reduceAttemptJournalEvent(this.#projection, event);
			if (
				(normalized.kind === "ResultCommitted" ||
					normalized.kind === "LegacyImported" ||
					normalized.kind === "LegacyAdopted") &&
				normalized.result
			) {
				let data = this.#blobs.getSync(normalized.result.sha256);
				if (normalized.artifact) data = Buffer.from(normalized.artifact.data);
				if (normalized.result.artifactUri.startsWith("data:")) {
					const comma = normalized.result.artifactUri.indexOf(",");
					if (comma < 0) fail("invalid inline legacy artifact");
					const header = normalized.result.artifactUri.slice(5, comma);
					const content = normalized.result.artifactUri.slice(comma + 1);
					data = header.endsWith(";base64")
						? Buffer.from(content, "base64")
						: Buffer.from(decodeURIComponent(content));
				}
				if (!data || new Bun.SHA256().update(data).digest("hex") !== normalized.result.sha256)
					fail("missing or corrupt result artifact");
				const blob = this.#blobs.putSync(data);
				const stored = this.#blobs.getSync(blob.hash);
				if (!stored || new Bun.SHA256().update(stored).digest("hex") !== normalized.result.sha256)
					fail("stored artifact failed hash validation");
				syncPath(blob.path);
				syncPath(this.#blobs.dir);
				syncPath(path.dirname(this.#blobs.dir));
			}
			const fd = fs.openSync(this.#path, "a");
			try {
				const bytes = Buffer.from(encodeAttemptJournalEvent(event));
				let offset = 0;
				while (offset < bytes.length) {
					const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
					if (!written) fail("short journal write");
					offset += written;
				}
				fs.fsyncSync(fd);
			} catch (error) {
				this.#poisoned = true;
				throw error;
			} finally {
				fs.closeSync(fd);
			}
			this.#projection = next;
			return structuredClone(event);
		});
	}
	async close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			this.#lease.release();
		}
	}
}
