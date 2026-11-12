import * as fs from "node:fs/promises";
import type * as fileFs from "node:fs";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { entryRevision, headerRevision } from "./journal-records";
import { sessionEntryLeafId, type FileEntry, type SessionEntry, type SessionHeader } from "./session-entries";
import { sessionExitFollowsLastMessage } from "./exit-diagnostics";
import { visitEntriesFromFileStream, type SessionLoadResult } from "./session-loader";

interface PositionedEntry {
	position: number;
	entry: SessionEntry;
}

/** Only facts read by restore/crash selection, never conversation bodies. */
interface Projection {
	ids: Set<string>;
	leafId: string | null;
	leafEntryId?: string;
	selfLeafId: string | null;
	header?: SessionHeader;
	invalidHeader: boolean;
	seen: number;
	malformedRecords: number;
	init?: PositionedEntry;
	assistant?: PositionedEntry;
	message?: PositionedEntry;
	exit?: PositionedEntry;
	yields: Map<string, PositionedEntry>;
}

export interface SessionRestoreSummary extends SessionLoadResult {
	restoreLeafId: string | null;
}

interface Snapshot {
	stat: fileFs.Stats;
	projection: Projection;
	/** State before an unterminated final record, which an append can complete. */
	checkpoint: Projection;
	offset: number;
	result: SessionRestoreSummary;
}

// One compact index per observed file. Serialise readers of the same file so
// simultaneous restore consumers do not parse an unchanged snapshot twice.
const snapshots = new Map<string, Snapshot>();
const pending = new Map<string, Promise<SessionRestoreSummary>>();

function emptyProjection(): Projection {
	return {
		invalidHeader: false,
		seen: 0,
		malformedRecords: 0,
		yields: new Map(),
		ids: new Set(),
		leafId: null,
		selfLeafId: null,
	};
}

async function copyProjection(value: Projection): Promise<Projection> {
	const copy = { ...value, yields: new Map<string, PositionedEntry>(), ids: new Set<string>() };
	let count = 0;
	for (const id of value.ids) {
		copy.ids.add(id);
		if (++count % 128 === 0) await Bun.sleep(0);
	}
	for (const [id, result] of value.yields) {
		copy.yields.set(id, result);
		if (++count % 128 === 0) await Bun.sleep(0);
	}
	return copy;
}

function visit(projection: Projection, entry: FileEntry): void {
	const revisedHeader = headerRevision(entry);
	if (revisedHeader) {
		if (projection.header?.id === revisedHeader.id) projection.header = revisedHeader;
		return;
	}
	const revisedEntry = entryRevision(entry);
	if (revisedEntry) {
		// Revision records replace their target's logical slot. They do not add a
		// new leaf or advance the position counter.
		if (!projection.ids.has(revisedEntry.id)) return;
		const summaryEntry = summarizeEntry(revisedEntry);
		const replace = (value: PositionedEntry | undefined) =>
			value?.entry.id === revisedEntry.id ? { ...value, entry: summaryEntry } : value;
		projection.init = replace(projection.init);
		projection.assistant = replace(projection.assistant);
		projection.message = replace(projection.message);
		projection.exit = replace(projection.exit);
		for (const [id, value] of projection.yields) {
			if (value.entry.id === revisedEntry.id) projection.yields.set(id, { ...value, entry: summaryEntry });
		}
		if (projection.leafEntryId === revisedEntry.id) projection.leafId = sessionEntryLeafId(revisedEntry);
		return;
	}
	const position = projection.seen++;
	if (position === 0) {
		if (entry.type === "session" && typeof entry.id === "string") projection.header = entry;
		else projection.invalidHeader = true;
	}
	if (entry.type === "session") return;
	projection.ids.add(entry.id);
	projection.leafEntryId = entry.id;
	projection.leafId = sessionEntryLeafId(entry);
	if (projection.leafId === entry.id) projection.selfLeafId = entry.id;
	const positioned = { position, entry };
	if (entry.type === "session_init") projection.init = positioned;
	if (sessionExitFollowsLastMessage([entry])) projection.exit = positioned;
	if (entry.type !== "message") return;
	// Classification only needs roles, stop reasons and tool identities. Text,
	// images, tool output and arguments are deliberately not retained.
	const message = entry.message;
	if (message.role === "assistant") {
		positioned.entry = summarizeEntry(entry);
		projection.assistant = positioned;
	} else if (message.role === "user" || message.role === "toolResult") {
		positioned.entry = summarizeEntry(entry);
	}
	projection.message = positioned;
	if (message.role === "toolResult" && !message.isError) projection.yields.set(message.toolCallId, positioned);
}

function summarizeEntry(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message") return entry;
	if (entry.message.role === "assistant")
		return {
			...entry,
			message: {
				...entry.message,
				content: entry.message.content.flatMap(part =>
					part.type === "toolCall" ? [{ ...part, arguments: {} }] : [],
				),
			},
		};
	if (entry.message.role === "user" || entry.message.role === "toolResult")
		return { ...entry, message: { ...entry.message, content: [] } };
	return entry;
}

function resultFor(projection: Projection, size: number): SessionRestoreSummary {
	const retained = new Map<number, SessionEntry>();
	for (const value of [projection.init, projection.assistant, projection.message, projection.exit]) {
		if (value) retained.set(value.position, value.entry);
	}
	const assistant = projection.assistant?.entry;
	if (assistant?.type === "message" && assistant.message.role === "assistant") {
		for (const part of assistant.message.content) {
			if (part.type !== "toolCall" || part.name !== "yield") continue;
			const result = projection.yields.get(part.id);
			if (result) retained.set(result.position, result.entry);
		}
	}
	return {
		restoreLeafId:
			projection.leafId === null || projection.ids.has(projection.leafId)
				? projection.leafId
				: projection.selfLeafId,
		entries: projection.header
			? [projection.header, ...[...retained].sort(([a], [b]) => a - b).map(([, entry]) => entry)]
			: [],
		invalidHeader: projection.invalidHeader || (!projection.header && projection.malformedRecords > 0),
		malformedRecords: projection.malformedRecords,
		titleSlot: undefined,
		sourceSize: size,
	};
}

async function readSummary(file: string): Promise<SessionRestoreSummary> {
	let stat: fileFs.Stats;
	try {
		stat = await fs.stat(file);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		snapshots.delete(file);
		return resultFor(emptyProjection(), 0);
	}
	const previous = snapshots.get(file);
	if (
		previous &&
		previous.stat.ino === stat.ino &&
		previous.stat.dev === stat.dev &&
		previous.stat.size === stat.size &&
		previous.stat.mtimeMs === stat.mtimeMs &&
		previous.stat.ctimeMs === stat.ctimeMs
	)
		return previous.result;
	// Session journals append; replacement, truncation and same-size rewrites
	// invalidate the index. A trailing partial record is replayed from its boundary.
	const append =
		previous && previous.stat.ino === stat.ino && previous.stat.dev === stat.dev && stat.size > previous.stat.size;
	const projection = append ? await copyProjection(previous.checkpoint) : emptyProjection();
	const start = append ? previous.offset : 0;
	let checkpoint: Projection | undefined;
	let offset = stat.size;
	if (stat.size > start)
		await visitEntriesFromFileStream(file, entry => visit(projection, entry), {
			startOffset: start,
			maxBytes: stat.size - start,
			yieldEveryBytes: 64 * 1024,
			yieldEveryEntries: 128,
			onMalformedRecord: () => {
				projection.malformedRecords++;
			},
			onTrailingRecord: async boundary => {
				offset = boundary;
				checkpoint = await copyProjection(projection);
			},
		});
	const result = resultFor(projection, stat.size);
	snapshots.set(file, { stat, projection, checkpoint: checkpoint ?? projection, offset, result });
	return result;
}

/** Incremental, yielding restore selection; unchanged transcripts are never parsed again. */
export async function loadSessionRestoreSummary(file: string): Promise<SessionRestoreSummary> {
	const inflight = pending.get(file);
	if (inflight) return inflight;
	const read = readSummary(file);
	pending.set(file, read);
	try {
		return await read;
	} finally {
		pending.delete(file);
	}
}
