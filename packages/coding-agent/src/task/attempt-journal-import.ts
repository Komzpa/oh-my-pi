import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { assembleYieldResult } from "@oh-my-pi/pi-tui/tools/task-yield-assembly";
import type { YieldItem } from "@oh-my-pi/pi-tui/tools/task";
import type {
	AttemptJournalCommand,
	AttemptJournalResult,
	AttemptJournalState,
	JsonValue,
} from "./attempt-journal-types";
import { yieldSectionShapes } from "./yield-assembly";

/** A frozen, already-read legacy snapshot. The importer performs no I/O. */
export interface LegacyAttemptJournalSnapshot {
	leadSessionId: string;
	entries?: readonly unknown[];
	todoPhases?: readonly unknown[];
	children?: readonly {
		id: string;
		taskId?: string;
		toolCallId?: string;
		sessionId?: string;
		sessionFile?: string;
		entries: readonly unknown[];
	}[];
	artifacts?: readonly {
		id: string;
		workerId: string;
		artifactUri: string;
		sha256: string;
		mediaType: string;
		executionOutcome: "success" | "failure";
		data?: string;
	}[];
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;
const hash = (value: unknown): string =>
	new Bun.CryptoHasher("sha256").update(stableStringifyJson(value)).digest("hex");
const json = (value: unknown): JsonValue => JSON.parse(stableStringifyJson(value)) as JsonValue;
const sourceId = (entry: unknown): string => text(record(entry).id) ?? `fingerprint:${hash(entry)}`;
const derivedId = (lead: string, id: string): string => `legacy:${hash([lead, id])}`;

interface Evidence {
	id: string;
	originalId?: string;
	workerId?: string;
	rowId?: string;
	entries: unknown[];
	checkpoint?: string;
	state: AttemptJournalState;
	startedAt?: number;
	ambiguous?: boolean;
	reassembled?: AttemptJournalResult;
	savedPayload?: JsonValue;
	results: AttemptJournalResult[];
}

/** Reuse the same assembly used by the executor, only for a saved terminal tool result. */
function savedYield(entries: readonly unknown[]): { data: JsonValue; status: "success" | "aborted" } | undefined {
	let schema: unknown;
	let lastText: string | undefined;
	const calls = new Set<string>();
	const items: YieldItem[] = [];
	let terminal = false;
	for (const raw of entries) {
		const entry = record(raw);
		if (entry.type === "session_init") schema = entry.outputSchema;
		if (entry.type !== "message") continue;
		const message = record(entry.message);
		if (message.role === "assistant") {
			calls.clear();
			terminal = false;
			for (const part of Array.isArray(message.content) ? message.content : []) {
				const value = record(part);
				if (value.type === "text" && typeof value.text === "string") lastText = value.text;
				if (value.type === "toolCall" && value.name === "yield" && text(value.id)) calls.add(value.id as string);
			}
		} else if (
			message.role === "toolResult" &&
			text(message.toolCallId) &&
			calls.has(message.toolCallId as string) &&
			message.isError !== true
		) {
			const item = record(message.details) as YieldItem;
			items.push(item);
			terminal =
				item.status === "aborted" || item.complete === true || !(Array.isArray(item.type) && item.type.length > 0);
		} else if (message.role !== "toolResult") {
			terminal = false;
			calls.clear();
		}
	}
	if (!terminal) return undefined;
	const last = items.at(-1);
	if (last?.status === "aborted")
		return { data: json({ aborted: true, error: last.error ?? null }), status: "aborted" };
	const assembled = assembleYieldResult(items, lastText, yieldSectionShapes(schema));
	if (!assembled || assembled.missingData) return undefined;
	return { data: json(assembled.data), status: "success" };
}

/** Map a frozen legacy snapshot into idempotent journal commands without changing its sources. */
export function importLegacyAttemptJournal(snapshot: LegacyAttemptJournalSnapshot): AttemptJournalCommand[] {
	const { leadSessionId } = snapshot;
	const groups = new Map<string, Evidence>();
	const group = (id: string, workerId?: string): Evidence => {
		let value = groups.get(id);
		if (!value) {
			value = { id, workerId, entries: [], state: "unknown", results: [] };
			groups.set(id, value);
		}
		return value;
	};
	const restarts = new Map<string, unknown[]>();
	for (const entry of snapshot.entries ?? []) {
		const item = record(entry);
		const data = record(item.data);
		if (item.type !== "custom") continue;
		if (item.customType === "restart_request_transition") {
			const requestId = text(record(data.record).requestId) ?? derivedId(leadSessionId, sourceId(entry));
			const list = restarts.get(requestId) ?? [];
			list.push(entry);
			restarts.set(requestId, list);
		} else if (item.customType === "subagent_restart_handoff") {
			if (
				!Array.isArray(data.children) ||
				data.children.length === 0 ||
				(Array.isArray(data.omittedChildren) && data.omittedChildren.length > 0)
			) {
				group(derivedId(leadSessionId, sourceId(entry))).entries.push(entry);
			}
			for (const child of Array.isArray(data.children) ? data.children : []) {
				const workerId = text(record(child).id);
				const value = group(workerId ?? derivedId(leadSessionId, `${sourceId(entry)}:${hash(child)}`), workerId);
				value.entries.push(entry);
				value.checkpoint = text(record(child).sessionFile) ?? value.checkpoint;
			}
		} else if (item.customType === "subagent_restart_receipt") {
			const workerId = text(data.id);
			const value = group(workerId ?? derivedId(leadSessionId, sourceId(entry)), workerId);
			value.entries.push(entry);
			value.checkpoint = text(data.sessionFile) ?? value.checkpoint;
		}
	}
	for (const phase of snapshot.todoPhases ?? []) {
		const phaseRecord = record(phase);
		for (const task of Array.isArray(phaseRecord.tasks) ? phaseRecord.tasks : []) {
			const row = record(task);
			const schedule = record(row.schedule);
			const rowId = text(row.id) ?? derivedId(leadSessionId, `todo:${hash([phase, task])}`);
			const observations = [
				...(Array.isArray(schedule.attemptHistory) ? schedule.attemptHistory : []),
				...(schedule.executor ? [schedule.executor] : []),
			];
			if (observations.length === 0) {
				const value = group(derivedId(leadSessionId, `todo:${hash([phaseRecord.name, task])}`));
				value.entries.push({ phase: phaseRecord.name, task });
			}
			for (const observation of observations) {
				const obs = record(observation);
				const historyName = text(obs.workerName);
				const workerId =
					text(obs.workerId) ??
					(historyName && typeof obs.startedAt === "number" && obs.attemptId === `${historyName}:${obs.startedAt}`
						? historyName
						: undefined);
				const attemptId =
					text(obs.attemptId) ??
					(workerId && typeof obs.startedAt === "number" ? `${workerId}:${obs.startedAt}` : undefined);
				const value = group(attemptId ?? derivedId(leadSessionId, `todo:${hash(observation)}`), workerId);
				if (
					(value.rowId && value.rowId !== rowId) ||
					(typeof obs.startedAt === "number" && value.startedAt !== undefined && value.startedAt !== obs.startedAt)
				) {
					value.ambiguous = true;
				}
				if (typeof obs.startedAt === "number") value.startedAt = obs.startedAt;
				value.rowId = rowId;
				value.entries.push({
					id: text(obs.attemptId) ?? attemptId ?? sourceId(observation),
					phase: phaseRecord.name,
					task,
					observation,
				});
				const outcome = text(obs.terminalStatus) ?? text(obs.outcome);
				if (outcome === "failed") value.state = "failed";
				else if (outcome === "completed") value.state = "unknown";
				else if (outcome === "aborted") value.state = "aborted";
			}
		}
	}
	for (const child of snapshot.children ?? []) {
		const value = group(child.id, child.id);
		value.originalId = child.taskId ?? child.toolCallId ?? child.sessionId;
		value.entries.push(child);
		value.checkpoint = child.sessionFile ?? value.checkpoint;
		const saved = savedYield(child.entries);
		if (saved) {
			value.savedPayload = saved.data;
			if (saved.status === "aborted") {
				value.state = "aborted";
			} else {
				const bytes = stableStringifyJson(saved.data);
				const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
				value.reassembled = {
					artifactUri: `data:application/json,${encodeURIComponent(bytes)}`,
					sha256,
					mediaType: "application/json",
					executionOutcome: "success",
				};
			}
		}
	}
	for (const artifact of snapshot.artifacts ?? []) {
		const value = group(artifact.workerId, artifact.workerId);
		value.entries.push(artifact);
		const artifactUri =
			artifact.data === undefined
				? artifact.artifactUri
				: `data:${artifact.mediaType},${encodeURIComponent(artifact.data)}`;
		value.results.push({
			artifactUri,
			sha256: artifact.sha256,
			mediaType: artifact.mediaType,
			executionOutcome: artifact.executionOutcome,
		});
		if (artifact.data === undefined && !artifact.artifactUri.startsWith("data:")) value.ambiguous = true;
	}
	// A worker-only handoff or artifact identifies an attempt only when exactly one
	// recorded attempt uses that worker. Otherwise keep the evidence unresolved.
	for (const value of [...groups.values()]) {
		if (!value.workerId || value.id !== value.workerId) continue;
		const matches = [...groups.values()].filter(other => other !== value && other.workerId === value.workerId);
		if (matches.length === 1) {
			const target = matches[0]!;
			target.entries.push(...value.entries);
			target.results.push(...value.results);
			target.originalId = value.originalId ?? target.originalId;
			target.ambiguous ||= value.ambiguous;
			target.reassembled = value.reassembled;
			target.savedPayload = value.savedPayload;
			if (value.state === "aborted") target.state = "aborted";
			target.checkpoint = value.checkpoint ?? target.checkpoint;
			groups.delete(value.id);
		} else if (matches.length > 1) {
			value.ambiguous = true;
		}
	}
	const commands: AttemptJournalCommand[] = [];
	for (const value of [...groups.values()].sort(
		(a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id),
	)) {
		const candidates = value.results.length ? value.results : value.reassembled ? [value.reassembled] : [];
		const distinct = new Map(candidates.map(result => [`${result.sha256}:${result.executionOutcome}`, result]));
		const result = !value.ambiguous && distinct.size === 1 ? [...distinct.values()][0] : undefined;
		const state: AttemptJournalState =
			value.ambiguous || distinct.size > 1
				? "legacy-unresolved"
				: result
					? result.executionOutcome === "success"
						? "succeeded"
						: "failed"
					: value.state;
		const fingerprint = hash(value.entries);
		commands.push({
			kind: "LegacyImported",
			commandId: `legacy:${hash([leadSessionId, value.originalId ?? value.id, fingerprint])}`,
			taskId: value.originalId ?? value.id,
			attempt: 0,
			generation: 0,
			state,
			owner: null,
			...(!value.ambiguous && value.rowId ? { rowId: value.rowId, purpose: "work" as const } : {}),
			...(result ? { result } : {}),
			...(value.checkpoint ? { checkpoint: value.checkpoint } : {}),
			source: {
				fingerprint,
				entryIds: value.entries.map(sourceId),
				evidence: json(value.entries),
				identity: value.originalId ?? value.workerId ?? "unknown",
				conflicts: json([...distinct.values()]),
				reassembled: json(value.reassembled ?? null),
				savedPayload: value.savedPayload ?? null,
			},
		});
	}
	for (const [requestId, entries] of restarts) {
		const latest = record(record(entries.at(-1)).data);
		const state = text(record(latest.record).state);
		const mapped =
			state === "checkpointed"
				? "ready"
				: state === "restarting"
					? "restoring"
					: ["queued", "draining", "completed", "failed", "cancelled"].includes(state ?? "")
						? state
						: "unknown";
		const fingerprint = hash(entries);
		const affectedAttempts: { taskId: string; attempt: number }[] = [];
		for (const value of groups.values()) {
			if (value.ambiguous || !value.workerId) continue;
			const included = value.entries.some(entry => {
				const item = record(entry);
				const data = record(item.data);
				return (
					item.customType === "subagent_restart_handoff" &&
					data.requestId === requestId &&
					Array.isArray(data.children) &&
					data.children.some(child => record(child).id === value.workerId)
				);
			});
			if (included) affectedAttempts.push({ taskId: value.originalId ?? value.id, attempt: 0 });
		}
		commands.push({
			kind: "LegacyRestartImported",
			commandId: `legacy-restart:${hash([leadSessionId, requestId, fingerprint])}`,
			requestId,
			state: mapped as
				| "queued"
				| "draining"
				| "ready"
				| "restoring"
				| "completed"
				| "failed"
				| "cancelled"
				| "unknown",
			affectedAttempts,
			source: {
				fingerprint,
				entryIds: entries.map(sourceId),
				evidence: json(entries),
				rootControlGeneration: json(record(latest.identity).generation ?? "unknown"),
			},
		});
	}
	const sourceFingerprint = hash(snapshot);
	commands.push({
		kind: "ImportCompleted",
		commandId: `legacy-complete:${hash([leadSessionId, sourceFingerprint])}`,
		sourceFingerprint,
	});
	return commands;
}
