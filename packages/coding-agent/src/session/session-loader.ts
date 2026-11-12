import { entryRevision, headerRevision, foldJournalRecords } from "./journal-records";
import * as fs from "node:fs";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import {
	ConcatSink,
	getBlobsDir,
	isEisdir,
	isEnoent,
	isEnotdir,
	jsonContainerEnd,
	parseJsonlLenient,
	peekFile,
	tryParseJson,
	withLoopPhase,
} from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { Semaphore } from "../task/parallel";
import {
	BlobStore,
	isBlobRef,
	lazyImageDataSync,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
	resolveImageDataUrlSync,
} from "./blob-store";
import { ExecutorObservationCompactor, ExecutorObservationReferences } from "./executor-observation-compaction";
import {
	buildSessionContextFromLeafPath,
	selectSessionContextEntriesFromLeafPath,
	sessionContextEntryMetadata,
	type SessionContextEntryMetadata,
} from "./session-context";
import {
	CURRENT_SESSION_VERSION,
	type CompactionEntry,
	type FileEntry,
	type RawFileEntry,
	type SessionEntry,
	type SessionHeader,
	sessionEntryLeafId,
} from "./session-entries";
import { sanitizeRehydratedOpenAIResponsesAssistantMessage } from "./messages";
import { generateId, migrateToCurrentVersion, migrateV1SessionEntry } from "./session-migrations";
import { isExternalizableImagePosition, isPersistenceTruncatedString } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { enotdir } from "./session-storage-errors";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;
const BLOB_READ_CONCURRENCY = 8;

/**
 * Complete optional accounting fields from persisted/imported assistant turns.
 * Complete provider usage is left untouched; missing prices never discard reported tokens.
 */
export function normalizeAssistantUsage(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
	const usage = message.usage;
	if (
		usage &&
		usage.input !== undefined &&
		usage.output !== undefined &&
		usage.cacheRead !== undefined &&
		usage.cacheWrite !== undefined &&
		usage.totalTokens !== undefined &&
		usage.cost?.input !== undefined &&
		usage.cost.output !== undefined &&
		usage.cost.cacheRead !== undefined &&
		usage.cost.cacheWrite !== undefined &&
		usage.cost.total !== undefined
	) {
		return false;
	}
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	const cacheRead = usage?.cacheRead ?? 0;
	const cacheWrite = usage?.cacheWrite ?? 0;
	const cost = usage?.cost;
	message.usage = {
		...usage,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens:
			usage?.totalTokens ??
			input +
				output +
				cacheRead +
				cacheWrite +
				(usage?.orchestration?.input ?? 0) +
				(usage?.orchestration?.cacheRead ?? 0) +
				(usage?.orchestration?.output ?? 0),
		cost: {
			...cost,
			input: cost?.input ?? 0,
			output: cost?.output ?? 0,
			cacheRead: cost?.cacheRead ?? 0,
			cacheWrite: cost?.cacheWrite ?? 0,
			total:
				cost?.total ?? (cost?.input ?? 0) + (cost?.output ?? 0) + (cost?.cacheRead ?? 0) + (cost?.cacheWrite ?? 0),
		},
	};
	return true;
}

export interface VisitEntriesFromFileStreamOptions {
	startOffset?: number;
	onTrailingRecord?: (offset: number) => void | Promise<void>;
	/** Stop after the visitor returns `false`. */
	shouldContinue?: () => boolean;
	/** Stop after this many valid or malformed JSONL records have been consumed. */
	maxRecords?: number;
	/** Read at most this many bytes from the file's current prefix. */
	maxBytes?: number;
	/** Yield to the macrotask queue after this many bytes have been consumed. */
	yieldEveryBytes?: number;
	/** Yield to the macrotask queue after this many entries have been visited. */
	yieldEveryEntries?: number;
	/** Skip canonical single-line records of other types before decoding their payloads. */
	entryTypes?: readonly FileEntry["type"][];
	/** Called once for every malformed JSONL record skipped by the stream. */
	onMalformedRecord?: () => void;
	/** Rethrow missing source instead of visiting nothing (fork backstop). */
	throwIfMissing?: boolean;
	/**
	 * Called with each stream chunk's byte length as it is consumed. Lets
	 * callers derive the exact snapshot size without re-stating the file.
	 */
	onBytesConsumed?: (bytes: number) => void;
	/** Physical UTF-8 byte range of each valid record (including its newline, when present). */
	onEntryPosition?: (entry: FileEntry, offset: number, length: number) => void;
	/** Borrow an already-open source so scanning and indexed reads share one inode. */
	sourceFd?: number;
}

/** Controls how a missing session file is handled. */
export interface LoadSessionOptions {
	/** Resume projection; raw archival readers retain every observation. */
	compactExecutorObservations?: boolean;
	/** Propagate ENOENT instead of treating the path as a new empty session. */
	throwIfMissing?: boolean;
}

/** Parsed session entries plus corruption metadata needed by writable loaders. */
export interface SessionLoadResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Byte length of the snapshot actually parsed, or `null` when the path did not exist. */
	sourceSize?: number | null;
	/** Whether non-empty session data was found without a valid leading session header. */
	invalidHeader: boolean;
}

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

function applyTitleSlot(entry: FileEntry | undefined, slot: SessionTitleUpdate | undefined): void {
	if (!slot || !isValidSessionHeader(entry)) return;
	if (slot.title && slot.title.length > 0) {
		entry.title = slot.title;
	} else {
		delete entry.title;
	}
	if (slot.source) {
		entry.titleSource = slot.source;
	} else {
		delete entry.titleSource;
	}
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(content: string): SessionLoadResult {
	const { body, slot } = splitTitleSlot(content);
	let malformedRecords = 0;
	const records = parseJsonlLenient<RawFileEntry>(body, {
		onMalformedRecord: () => {
			malformedRecords++;
		},
	}) as FileEntry[];
	applyTitleSlot(records[0], slot);
	const entries = foldJournalRecords(records);
	return {
		entries,
		titleSlot: slot,
		malformedRecords,
		sourceSize: Buffer.byteLength(content, "utf8"),
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

/** Upper bound on the bytes read to find a header: real headers (and the title slot before them) are far smaller. */
const SESSION_HEADER_READ_LIMIT = 1024 * 1024;
/** First read; holds the title slot and any real header, so the full limit is read only for outliers. */
const SESSION_HEADER_FIRST_READ = 16 * 1024;

/** {@link sessionHeaderIdFromPrefix} result when the window ends inside the first record. */
const HEADER_INCOMPLETE = Symbol("header-incomplete");

/**
 * The session id in `filePath`'s header, or `undefined` when there is no file
 * there or it does not start with a valid session header. Reads
 * {@link SESSION_HEADER_FIRST_READ} bytes, and up to
 * {@link SESSION_HEADER_READ_LIMIT} only when the first record runs past them.
 */
export async function readSessionHeaderId(filePath: string): Promise<string | undefined> {
	try {
		const id = await peekFile(filePath, SESSION_HEADER_FIRST_READ, prefix =>
			sessionHeaderIdFromPrefix(prefix, prefix.length < SESSION_HEADER_FIRST_READ),
		);
		if (id !== HEADER_INCOMPLETE) return id;
		const full = await peekFile(filePath, SESSION_HEADER_READ_LIMIT, prefix =>
			sessionHeaderIdFromPrefix(prefix, true),
		);
		return full === HEADER_INCOMPLETE ? undefined : full;
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err) || isEisdir(err)) return undefined;
		throw err;
	}
}

/**
 * The header id from a file's leading bytes, past the optional title slot
 * line. Parses only the first record, which may span lines (a pretty-printed
 * header). {@link HEADER_INCOMPLETE} when that record runs past `prefix` and
 * `final` is false (more of the file can be read).
 */
function sessionHeaderIdFromPrefix(prefix: Uint8Array, final: boolean): string | undefined | typeof HEADER_INCOMPLETE {
	let records = prefix;
	const newline = prefix.indexOf(0x0a);
	if (newline !== -1) {
		const firstLine = new TextDecoder().decode(prefix.subarray(0, newline)).trim();
		if (firstLine && parseTitleSlotLine(firstLine)) records = prefix.subarray(newline + 1);
	}
	// Like the full parser, skip blank lines (and other JSON whitespace) before the first record.
	let start = 0;
	while (start < records.length) {
		const byte = records[start];
		if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09) break;
		start++;
	}
	records = records.subarray(start);
	if (records.length === 0) return final ? undefined : HEADER_INCOMPLETE;
	// A header is an object; anything else is not a session file.
	if (records[0] !== 0x7b) return undefined;
	const text = new TextDecoder().decode(records);
	const end = jsonContainerEnd(text, 0);
	if (end === -1) return final ? undefined : HEADER_INCOMPLETE;
	const entry = tryParseJson<FileEntry>(text.slice(0, end)) ?? undefined;
	return isValidSessionHeader(entry) ? entry.id : undefined;
}

/**
 * Frame one possibly multiline JSON value without reparsing its growing prefix.
 * Bun remains the parser; these states only locate a closing token or a syntax
 * boundary at which asking it for a result can make progress.
 */
class SessionRecordFrame {
	#states: ("value" | "colon" | "key" | "object-start" | "array-start" | "object-comma" | "array-comma")[] = ["value"];
	#containers: number[] = [];
	#string = false;
	#escape = false;
	#key = false;
	#atom = false;
	#terminal = false;

	get unfinished(): boolean {
		return !this.#terminal;
	}

	push(byte: number): boolean {
		if (this.#terminal) return byte === 0x0a;
		if (this.#string) {
			if (byte < 0x20) this.#terminal = true;
			else if (this.#escape) this.#escape = false;
			else if (byte === 0x5c) this.#escape = true;
			else if (byte === 0x22) {
				this.#string = false;
				if (this.#key) this.#states[this.#states.length - 1] = "colon";
				else this.#complete();
			}
			return this.#terminal && byte === 0x0a;
		}
		const whitespace = byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
		if (this.#atom) {
			if (!whitespace && byte !== 0x2c && byte !== 0x7d && byte !== 0x5d) return false;
			this.#atom = false;
			this.#complete();
		}
		if (whitespace) return this.#terminal && byte === 0x0a;
		const state = this.#states[this.#states.length - 1];
		if (state === "colon") {
			if (byte === 0x3a) this.#states[this.#states.length - 1] = "value";
			else this.#terminal = true;
		} else if (state === "object-comma" || state === "array-comma") {
			if (byte === 0x2c) this.#states[this.#states.length - 1] = state === "object-comma" ? "key" : "value";
			else if (byte === (state === "object-comma" ? 0x7d : 0x5d)) this.#close();
			else this.#terminal = true;
		} else if (state === "key" || state === "object-start") {
			if (byte === 0x22) {
				this.#string = true;
				this.#key = true;
			} else if (state === "object-start" && byte === 0x7d) this.#close();
			else this.#terminal = true;
		} else if (state === "array-start" && byte === 0x5d) this.#close();
		else if (byte === 0x7b) {
			this.#containers.push(byte);
			this.#states.push("object-start");
		} else if (byte === 0x5b) {
			this.#containers.push(byte);
			this.#states.push("array-start");
		} else if (byte === 0x22) {
			this.#string = true;
			this.#key = false;
		} else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39) || byte === 0x74 || byte === 0x66 || byte === 0x6e)
			this.#atom = true;
		else this.#terminal = true;
		return false;
	}

	#close(): void {
		this.#states.pop();
		this.#containers.pop();
		this.#complete();
	}

	#complete(): void {
		if (this.#states.length === 1) this.#terminal = true;
		else {
			const index = this.#states.length - 1;
			this.#states[index] = this.#containers[index - 1] === 0x7b ? "object-comma" : "array-comma";
		}
	}
}

/** Parse session JSONL and visit each entry without retaining prior entries. */
export async function visitEntriesFromFileStream(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	options: VisitEntriesFromFileStreamOptions = {},
): Promise<SessionTitleUpdate | undefined> {
	let lastYield = performance.now();
	let titleSlot: SessionTitleUpdate | undefined;
	let sawFirstLine = (options.startOffset ?? 0) > 0;
	let sawFirstEntry = sawFirstLine;
	let bytesSinceYield = 0;
	let entriesSinceYield = 0;
	let recordsSeen = 0;
	let sourceBytes = options.startOffset ?? 0;
	let offset = options.startOffset ?? 0;
	let stopped = false;
	const maxRecords = Math.max(0, options.maxRecords ?? Number.POSITIVE_INFINITY);
	const maxBytes = Math.max(0, options.maxBytes ?? Number.POSITIVE_INFINITY);
	const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? STREAM_YIELD_BYTES);
	const yieldEveryEntries = Math.max(0, options.yieldEveryEntries ?? STREAM_YIELD_ENTRIES);
	const sink = new ConcatSink();
	const decoder = new TextDecoder();

	const yieldToMacrotask = async (): Promise<void> => {
		if (
			(yieldEveryBytes > 0 && bytesSinceYield >= yieldEveryBytes) ||
			(yieldEveryEntries > 0 && entriesSinceYield >= yieldEveryEntries) ||
			performance.now() - lastYield >= 16
		) {
			bytesSinceYield = 0;
			entriesSinceYield = 0;
			await yieldImmediate();
			lastYield = performance.now();
		}
	};
	let pending: { firstNewline: number; scanned: number; frame: SessionRecordFrame } | undefined;
	// Fast path: a record that is valid JSON on its own physical line. A small
	// byte-state framer carries multiline values across chunks so Bun parses each
	// completed record once. Bun remains authoritative for JSON validity and the
	// exact end of a valid prefix before trailing junk.
	const drain = async (atEnd = false): Promise<void> => {
		const view = sink.flush();
		if (!view) return;
		let consumed = 0;
		const emit = async (entry: FileEntry, start: number, end: number): Promise<void> => {
			if (!sawFirstEntry) {
				sawFirstEntry = true;
				applyTitleSlot(entry, titleSlot);
			}
			options.onEntryPosition?.(entry, offset + start, Math.min(end - start, sourceBytes - offset - start));
			stopped =
				(!options.entryTypes || options.entryTypes.includes(entry.type)) &&
				withLoopPhase("session-journal:visit", () => visit(entry) === false);
			recordsSeen++;
			entriesSinceYield++;
			if (recordsSeen >= maxRecords) stopped = true;
			await yieldToMacrotask();
		};
		const skipMalformed = (from: number, to: number): void => {
			for (let index = from; index < to; index++) {
				const byte = view[index];
				if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
					options.onMalformedRecord?.();
					break;
				}
			}
			recordsSeen++;
			if (recordsSeen >= maxRecords) stopped = true;
		};
		while (consumed < view.length && !stopped) {
			await yieldToMacrotask();
			if (recordsSeen >= maxRecords || options.shouldContinue?.() === false) {
				stopped = true;
				break;
			}
			const start = consumed;
			if (!pending) {
				let firstNewline = view.indexOf(0x0a, consumed);
				if (firstNewline < 0) {
					if (!atEnd) break;
					firstNewline = view.length;
				}
				const firstLine = decoder.decode(view.subarray(start, firstNewline)).trim();
				if (!sawFirstLine) {
					sawFirstLine = true;
					const slot = firstLine ? parseTitleSlotLine(firstLine) : undefined;
					if (slot) {
						titleSlot = titleUpdateFromSlot(slot);
						consumed = Math.min(firstNewline + 1, view.length);
						continue;
					}
				}
				if (!firstLine) {
					consumed = Math.min(firstNewline + 1, view.length);
					continue;
				}
				// Session writers put `type` first. Only skip that canonical shape;
				// imported/reordered and multiline JSON still uses the normal parser.
				if (options.entryTypes) {
					const type = /^\{\s*"type"\s*:\s*"([^"\\]+)"/.exec(firstLine)?.[1];
					if (type && !options.entryTypes.includes(type as FileEntry["type"]) && firstLine.endsWith("}")) {
						consumed = firstNewline + 1;
						recordsSeen++;
						entriesSinceYield++;
						continue;
					}
				}
				let lineEntry: FileEntry | undefined;
				try {
					lineEntry = withLoopPhase("session-journal:parse", () => JSON.parse(firstLine) as FileEntry);
				} catch {}
				if (lineEntry) {
					consumed = Math.min(firstNewline + 1, view.length);
					await emit(lineEntry, start, consumed);
					continue;
				}
				pending = { firstNewline, scanned: start, frame: new SessionRecordFrame() };
			}
			let recordEnd = pending.scanned;
			while (recordEnd < view.length && !pending.frame.push(view[recordEnd])) recordEnd++;
			pending.scanned = recordEnd;
			if (recordEnd === view.length) {
				if (!atEnd) break;
				if (pending.frame.unfinished) {
					// The value never completes before EOF or the byte limit: one malformed record.
					consumed = view.length;
					skipMalformed(start, consumed);
					pending = undefined;
					break;
				}
			}
			pending = undefined;
			const recordLimit = Math.min(recordEnd + 1, view.length);
			const { values, error, read, done } = withLoopPhase("session-journal:parse", () =>
				Bun.JSONL.parseChunk(view, start, recordLimit),
			);
			if (values.length > 0) {
				// `read` is the absolute end of the parsed value. On success the
				// record keeps its trailing whitespace and newline.
				const valueEnd = error ? read : recordLimit;
				consumed = recordLimit;
				await emit(values[0] as FileEntry, start, valueEnd);
				if (error && !stopped) skipMalformed(read, recordEnd);
				continue;
			}
			if (error || done) {
				// Malformed before any value: skip through the physical line containing the error.
				const errorStart = Math.max(start, read);
				const nextNewline = view.indexOf(0x0a, errorStart);
				const malformedEnd = nextNewline < 0 ? view.length : nextNewline;
				consumed = Math.min(view.length, malformedEnd + 1);
				skipMalformed(errorStart, malformedEnd);
				continue;
			}
			// The framing scanner and Bun disagree only for malformed input; discard
			// one physical line and continue with the next recoverable record.
			const nextNewline = view.indexOf(0x0a, start);
			const malformedEnd = nextNewline < 0 ? view.length : nextNewline;
			consumed = Math.min(view.length, malformedEnd + 1);
			skipMalformed(start, malformedEnd);
		}
		if (pending) {
			pending.firstNewline -= consumed;
			pending.scanned -= consumed;
		}
		sink.consume(consumed);
		offset += consumed;
	};
	if (maxBytes === 0) return titleSlot;
	let source: AsyncIterable<Uint8Array>;
	try {
		if (options.sourceFd === undefined && options.startOffset === undefined) {
			// Capped by hand, not with `file.slice(0, maxBytes)`: on Bun 1.3.14 a slice's
			// stream over a file that continues past the slice either stays pending after
			// delivering its bytes (macOS) or ignores the bound and streams the whole
			// file (Windows).
			source = Bun.file(filePath).stream();
		} else {
			source = fs.createReadStream(filePath, {
				fd: options.sourceFd,
				autoClose: options.sourceFd === undefined,
				highWaterMark: 64 * 1024,
				start: options.startOffset ?? 0,
				...(Number.isFinite(maxBytes) && maxBytes > 0 ? { end: (options.startOffset ?? 0) + maxBytes - 1 } : {}),
			});
		}
		let unread = maxBytes;
		// Start reading inside this catch, but never turn visitor failures into missing-file success.
		for await (const streamed of source) {
			if (stopped || recordsSeen >= maxRecords) break;
			const chunk = streamed.byteLength > unread ? streamed.subarray(0, unread) : streamed;
			unread -= chunk.byteLength;
			sourceBytes += chunk.byteLength;
			bytesSinceYield += chunk.byteLength;
			options.onBytesConsumed?.(chunk.byteLength);
			sink.append(chunk);
			if (chunk.includes(0x0a)) await drain();
			await yieldToMacrotask();
			if (unread === 0 && options.sourceFd === undefined) break;
		}
	} catch (err) {
		if (!options.throwIfMissing && isEnoent(err) && sourceBytes === 0) return undefined;
		throw err;
	}
	if (!stopped && recordsSeen < maxRecords && !sink.isEmpty) {
		await options.onTrailingRecord?.(offset);
		await drain(true);
	}
	return titleSlot;
}
/** Share immutable text across repeated snapshots without aliasing their mutable containers. */
export function createSessionStringPool(): (entry: FileEntry) => void {
	const strings = new Map<string, string>();
	const budget = 32 * 1024 * 1024;
	let bytes = 0;
	return entry => {
		const pending: object[] = [entry];
		const seen = new WeakSet<object>();
		while (pending.length > 0) {
			const object = pending.pop()! as Record<string, unknown>;
			if (seen.has(object) || ArrayBuffer.isView(object) || Object.isFrozen(object)) continue;
			seen.add(object);
			for (const key of Object.keys(object)) {
				const value = object[key];
				if (typeof value === "object" && value !== null) pending.push(value);
				if (typeof value !== "string" || value.length < 64 || value.length * 2 > budget) continue;
				const existing = strings.get(value);
				if (existing !== undefined) {
					// Partly readonly maps (for example auditor row identities) are not
					// frozen. Intern only writable data properties, never accessors.
					if (Object.getOwnPropertyDescriptor(object, key)?.writable) object[key] = existing;
					continue;
				}
				while (bytes + value.length * 2 > budget || strings.size >= 16_384) {
					const oldest = strings.keys().next().value!;
					bytes -= oldest.length * 2;
					strings.delete(oldest);
				}
				strings.set(value, value);
				bytes += value.length * 2;
			}
		}
	};
}

/** Exported for testing — the ≥8MiB streaming path (works on any file size). */
export async function loadEntriesFromFileStream(
	filePath: string,
	options?: Pick<VisitEntriesFromFileStreamOptions, "throwIfMissing"> & { compactExecutorObservations?: boolean },
): Promise<SessionLoadResult> {
	const references = new ExecutorObservationReferences();
	let snapshotBytes: number | undefined;
	if (options?.compactExecutorObservations) {
		snapshotBytes = 0;
		await visitEntriesFromFileStream(filePath, entry => references.visit(entryRevision(entry) ?? entry), {
			throwIfMissing: options.throwIfMissing,
			onBytesConsumed: bytes => {
				snapshotBytes! += bytes;
			},
		});
	}
	const compactor = options?.compactExecutorObservations
		? new ExecutorObservationCompactor(references.ids)
		: undefined;
	const entries: FileEntry[] = [];
	const internStrings = createSessionStringPool();
	let malformedRecords = 0;
	let bytesConsumed = 0;
	const titleSlot = await visitEntriesFromFileStream(
		filePath,
		entry => {
			internStrings(entry);
			entries.push(entry);
		},
		{
			// Both passes must see the same prefix: a later appended branch may
			// reference an observation the first pass did not know to protect.
			maxBytes: snapshotBytes,
			onMalformedRecord: () => {
				malformedRecords++;
			},
			throwIfMissing: options?.throwIfMissing,
			onBytesConsumed: bytes => {
				bytesConsumed += bytes;
			},
		},
	);
	const folded = foldJournalRecords(entries);
	if (compactor) {
		for (const record of entries) {
			const revised = entryRevision(record);
			if (revised) references.ids.add(revised.id);
		}
		for (const entry of folded) compactor.push(entry);
		compactor.flush();
	}
	return {
		entries: compactor?.entries ?? folded,
		titleSlot,
		malformedRecords,
		sourceSize: bytesConsumed,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}
function shouldStreamEntries(storage: SessionStorage, size: number): boolean {
	return storage instanceof FileSessionStorage && size >= STREAM_LOAD_THRESHOLD_BYTES;
}

async function loadWithKnownSize(
	filePath: string,
	storage: SessionStorage,
	size: number,
	options?: LoadSessionOptions,
): Promise<{ loaded: SessionLoadResult; sourceSize: number }> {
	if (shouldStreamEntries(storage, size)) {
		const loaded = await loadEntriesFromFileStream(filePath, options);
		const sourceSize = loaded.sourceSize ?? 0;
		return { loaded: loaded.invalidHeader ? { ...loaded, entries: [] } : loaded, sourceSize };
	}
	const content = await storage.readText(filePath);
	const loaded = parseSessionContent(content);
	if (options?.compactExecutorObservations) {
		const references = new ExecutorObservationReferences();
		for (const entry of loaded.entries) references.visit(entry);
		const compactor = new ExecutorObservationCompactor(references.ids);
		for (const entry of loaded.entries) compactor.push(entry);
		compactor.flush();
		loaded.entries = compactor.entries;
	}
	return {
		loaded: loaded.invalidHeader ? { ...loaded, entries: [] } : loaded,
		sourceSize: Buffer.byteLength(content, "utf8"),
	};
}

/**
 * Windows reports ENOENT when a path component is a regular file, where POSIX
 * yields ENOTDIR. Inspecting the leaf itself and then climbing to the first
 * existing ancestor distinguishes that path error from a genuinely missing
 * file.
 */
export async function hasFileAsPathComponent(filePath: string): Promise<boolean> {
	let current = path.resolve(filePath);
	for (;;) {
		try {
			return !(await fs.promises.stat(current)).isDirectory();
		} catch {
			// Missing component: climb to the first existing ancestor.
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/** Load and validate a session while retaining malformed-record diagnostics. */
export async function loadSessionFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options: LoadSessionOptions = {},
): Promise<SessionLoadResult> {
	try {
		const statSize = storage.statSync(filePath).size;
		const { loaded, sourceSize } = await loadWithKnownSize(filePath, storage, statSize, options);
		return { ...loaded, sourceSize };
	} catch (caught) {
		// Windows reports ENOENT where POSIX reports ENOTDIR for a path running
		// through a regular file; restore ENOTDIR so that path error is never
		// masked as a missing session.
		const err =
			isEnoent(caught) &&
			process.platform === "win32" &&
			storage instanceof FileSessionStorage &&
			(await hasFileAsPathComponent(filePath))
				? enotdir(filePath)
				: caught;
		if (options?.throwIfMissing && (isEnoent(err) || isEnotdir(err))) {
			throw err;
		}
		if (isEnoent(err)) {
			return {
				entries: [],
				titleSlot: undefined,
				malformedRecords: 0,
				sourceSize: null,
				invalidHeader: false,
			};
		}
		throw err;
	}
}

/**
 * Load the valid entries from a session file, skipping malformed records.
 * Each call returns freshly parsed entries owned by the caller.
 */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options?: { throwIfMissing?: boolean },
): Promise<FileEntry[]> {
	return (await loadSessionFile(filePath, storage, options)).entries;
}

/** Physical payload source and migrated identity shared by resume and read-only history. */
export interface PositionedSessionEntry extends SessionContextEntryMetadata {
	/** Header version of the physical record, before resume migrations. */
	sourceVersion?: number;
	/** Current-version record whose physical bytes need no migration. */
	rawCopy?: boolean;
	offset: number;
	length: number;
	firstKeptEntryId?: string;
	/** Compacted executor payload may combine fields from multiple physical records. */
	entry?: SessionEntry;
}

/** Stream canonical migrations; caller owns the returned source descriptor and must close or adopt it. */
export async function visitSessionFileForResume(
	filePath: string,
	visit: (entry: SessionEntry, position: PositionedSessionEntry) => void,
	options: LoadSessionOptions = {},
): Promise<SessionLoadResult & { migrated: boolean; sourceFd?: number }> {
	let sourceFd: number;
	try {
		sourceFd = fs.openSync(filePath, "r");
	} catch (error) {
		if (options.throwIfMissing || !isEnoent(error)) throw error;
		return {
			entries: [],
			titleSlot: undefined,
			malformedRecords: 0,
			sourceSize: null,
			invalidHeader: false,
			migrated: false,
		};
	}
	let transferred = false;
	try {
		// Scan references on the same inode and byte prefix as the indexed pass.
		const snapshotBytes = fs.fstatSync(sourceFd).size;
		const references = new ExecutorObservationReferences();
		const revisions = new Map<string, PositionedSessionEntry>();
		let sourceVersion = CURRENT_SESSION_VERSION;
		await visitEntriesFromFileStream(
			filePath,
			entry => {
				if (entry.type === "session") sourceVersion = entry.version ?? 1;
				const revised = entryRevision(entry);
				if (revised) references.ids.add(revised.id);
				references.visit(revised ?? entry);
			},
			{
				sourceFd,
				startOffset: 0,
				maxBytes: snapshotBytes,
				throwIfMissing: options.throwIfMissing,
				onEntryPosition: (record, offset, length) => {
					const revised = entryRevision(record);
					if (revised)
						revisions.set(revised.id, {
							...sessionContextEntryMetadata(revised),
							sourceVersion,
							offset,
							length,
							firstKeptEntryId: revised.type === "compaction" ? revised.firstKeptEntryId : undefined,
							rawCopy: false,
						});
				},
			},
		);
		const positions = new WeakMap<SessionEntry, PositionedSessionEntry>();
		const compactor = options.compactExecutorObservations
			? new ExecutorObservationCompactor(references.ids, (entry, compacted) => {
					if (entry.type === "session") return;
					const position = positions.get(entry)!;
					if (position.parentId !== entry.parentId) position.rawCopy = false;
					position.parentId = entry.parentId;
					if (compacted) position.entry = entry;
					visit(entry, position);
				})
			: undefined;
		let header: SessionHeader | undefined;
		let version = CURRENT_SESSION_VERSION;
		let malformedRecords = 0;
		let sourceSize = 0;
		let lastPosition: PositionedSessionEntry | undefined;
		let invalidHeader = false;
		let migrated = false;
		let parentId: string | null = null;
		const ids = new Set<string>();
		const legacyIds: Array<string | undefined> = [undefined];
		const rawIds: Array<string | undefined> = [undefined];
		const forwardReferences: Array<{ position: PositionedSessionEntry; target: number }> = [];
		const titleSlot = await visitEntriesFromFileStream(filePath, () => !invalidHeader, {
			sourceFd,
			startOffset: 0,
			maxBytes: snapshotBytes,
			throwIfMissing: options.throwIfMissing,
			onBytesConsumed: bytes => {
				sourceSize += bytes;
			},
			onMalformedRecord: () => {
				malformedRecords++;
			},
			onEntryPosition: (entry, offset, length) => {
				if (!header) {
					if (!isValidSessionHeader(entry)) {
						invalidHeader = true;
						return;
					}
					header = entry;
					version = header.version ?? 1;
					header.version = Math.max(version, CURRENT_SESSION_VERSION);
					migrated = version < CURRENT_SESSION_VERSION;
					return;
				}
				const revisedHeader = headerRevision(entry);
				if (revisedHeader) {
					if (revisedHeader.id !== header.id) throw new Error("Journal header identity changed");
					header = revisedHeader;
					return;
				}
				if (entryRevision(entry)) return;
				const revisionPosition = entry.type === "session" ? undefined : revisions.get(entry.id);
				if (revisionPosition) {
					entry = readPositionedSessionEntry(sourceFd, revisionPosition);
					offset = revisionPosition.offset;
					length = revisionPosition.length;
				}
				if (entry.type === "title_change") {
					header.title = entry.title;
					header.titleSource = entry.source;
				}
				const arrayIndex = legacyIds.length;
				rawIds.push(entry.type === "session" ? undefined : entry.id);
				if (entry.type === "session") {
					legacyIds.push(undefined);
					return;
				}
				const target =
					version < 2 && entry.type === "compaction"
						? (entry as CompactionEntry & { firstKeptEntryIndex?: number }).firstKeptEntryIndex
						: undefined;
				if (version < 2) {
					const id = generateId(ids);
					migrateV1SessionEntry(
						entry,
						id,
						parentId,
						target === arrayIndex ? id : target === undefined ? undefined : legacyIds[target],
					);
				}
				legacyIds.push(entry.id);
				ids.add(entry.id);
				parentId = entry.id;
				migrateToCurrentVersion([{ ...header, version: Math.max(version, 2) }, entry]);
				if (entry.type === "message" && entry.message.role === "assistant") {
					const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
					if (sanitized !== entry.message) {
						entry.message = sanitized;
					}
				}
				const position: PositionedSessionEntry = {
					rawCopy: !revisionPosition && version >= CURRENT_SESSION_VERSION,
					sourceVersion: revisionPosition?.sourceVersion ?? version,
					...sessionContextEntryMetadata(entry),
					offset,
					length,
					firstKeptEntryId: entry.type === "compaction" ? entry.firstKeptEntryId : undefined,
				};
				lastPosition = position;
				if (target !== undefined && target > arrayIndex) forwardReferences.push({ position, target });
				if (compactor) {
					positions.set(entry, position);
					compactor.push(entry);
				} else visit(entry, position);
			},
		});
		compactor?.flush();
		for (const id of revisions.keys()) if (!ids.has(id)) throw new Error(`Journal revision target ${id} not found`);
		// Array migration reads a forward target's original id before that target is
		// migrated. Preserve that exact behavior rather than inventing a future id.
		for (const { position, target } of forwardReferences) {
			if (rawIds[target] !== undefined) position.firstKeptEntryId = rawIds[target];
		}
		if (sourceSize > 0 && header && !invalidHeader) {
			const lastByte = Buffer.allocUnsafe(1);
			if (fs.readSync(sourceFd, lastByte, 0, 1, sourceSize - 1) === 1 && lastByte[0] !== 0x0a) {
				migrated = true;
				if (lastPosition) lastPosition.rawCopy = false;
			}
			transferred = true;
		}
		return {
			entries: header && !invalidHeader ? [header] : [],
			titleSlot,
			malformedRecords,
			sourceSize,
			sourceFd: transferred ? sourceFd : undefined,
			invalidHeader: invalidHeader || (!header && malformedRecords > 0),
			migrated,
		};
	} finally {
		if (!transferred) fs.closeSync(sourceFd);
	}
}

/** Read one record from an open inode; atomic replacement cannot invalidate its offsets. */
export function readPositionedSessionEntry(fd: number, position: PositionedSessionEntry): SessionEntry {
	const bytes = Buffer.allocUnsafe(position.length);
	let read = 0;
	while (read < bytes.length) {
		const count = fs.readSync(fd, bytes, read, bytes.length - read, position.offset + read);
		if (count === 0) throw new Error(`Session entry ${position.id} was truncated`);
		read += count;
	}
	const record = JSON.parse(bytes.toString("utf8")) as SessionEntry;
	const entry = entryRevision(record) ?? record;
	entry.id = position.id;
	entry.parentId = position.parentId;
	if (entry.type === "compaction") {
		entry.firstKeptEntryId = position.firstKeptEntryId!;
		delete (entry as CompactionEntry & { firstKeptEntryIndex?: number }).firstKeptEntryIndex;
	}
	migrateToCurrentVersion([
		{ type: "session", version: Math.max(position.sourceVersion ?? 2, 2) } as SessionHeader,
		entry,
	]);
	if (entry.type === "message" && entry.message.role === "assistant") {
		entry.message = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
	}
	repairTruncatedSnapcompactFrames(entry);
	return entry;
}

/**
 * Visit session entries, using bounded streaming for large file-backed journals.
 * Small files and non-file backends keep the existing full-load path.
 */
export async function visitEntriesFromFile(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<void> {
	const size = storage.statSync(filePath).size;
	if (shouldStreamEntries(storage, size)) {
		const positions = new Map<string, PositionedSessionEntry>();
		const loaded = await visitSessionFileForResume(filePath, (entry, position) => positions.set(entry.id, position));
		try {
			for (const header of loaded.entries) if (visit(header) === false) return;
			if (loaded.sourceFd !== undefined) {
				for (const position of positions.values()) {
					// Match the streaming visitor's EOF behavior if its consumer truncates the journal.
					if (position.offset + position.length > fs.fstatSync(loaded.sourceFd).size) break;
					if (visit(readPositionedSessionEntry(loaded.sourceFd, position)) === false) return;
				}
			}
		} finally {
			if (loaded.sourceFd !== undefined) fs.closeSync(loaded.sourceFd);
		}
		return;
	}

	for (const entry of (await loadWithKnownSize(filePath, storage, size)).loaded.entries) {
		if (visit(entry) === false) return;
	}
}

function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

/** A persisted blob reference and the field that holds it. */
interface BlobRefSite {
	holder: Record<string, unknown>;
	key: string;
	ref: string;
	/** Provider image URLs persist the whole data URL; image payloads persist bare base64. */
	asDataUrl: boolean;
}

/**
 * Collect the blob references in session image blocks and provider image URLs.
 * Snapcompact frames stay as references until context rebuilding selects them.
 */
function collectBlobRefSites(value: unknown, sites: BlobRefSite[], key?: string): void {
	if (key !== "frames" && isExternalizableImagePosition(value, key) && isBlobRef(value.data)) {
		sites.push({ holder: value, key: "data", ref: value.data, asDataUrl: false });
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) collectBlobRefSites(item, sites, key);
		return;
	}

	if (typeof value !== "object" || value === null) return;
	const holder = value as Record<string, unknown>;
	if (holder.type === "image_generation_call" && typeof holder.result === "string" && isBlobRef(holder.result)) {
		sites.push({ holder, key: "result", ref: holder.result, asDataUrl: false });
	}

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		sites.push({ holder, key: "image_url", ref: value.image_url, asDataUrl: true });
	}

	for (const childKey in holder) collectBlobRefSites(holder[childKey], sites, childKey);
}

/**
 * Cheap synchronous precheck: does this value's tree contain any `blob:sha256:` string?
 * Early-exits on the first hit, so blob-free entries skip the
 * {@link collectBlobRefSites} descent entirely. Conservative — a blob ref in a
 * non-resolved position still returns true, which only costs an extra (no-op) walk.
 */
function containsBlobRef(value: unknown): boolean {
	if (typeof value === "string") return isBlobRef(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsBlobRef(item)) return true;
		}
		return false;
	}
	if (typeof value !== "object" || value === null) return false;
	for (const key in value) {
		if (containsBlobRef((value as Record<string, unknown>)[key])) return true;
	}
	return false;
}

/**
 * Older persistence versions truncated oversized frame base64 in place. Recover
 * those archives from their retained source text so an already-wedged session
 * resumes as text instead of sending malformed image data to the provider.
 */
function repairTruncatedSnapcompactFrames(entry: FileEntry): void {
	if (entry.type !== "compaction") return;
	const archive = snapcompact.getPreservedArchive(entry.preserveData);
	if (!archive?.frames.some(frame => isPersistenceTruncatedString(frame.data))) return;
	const slot = entry.preserveData?.[snapcompact.PRESERVE_KEY];
	if (typeof slot !== "object" || slot === null) return;

	if (archive.text) {
		Object.assign(slot, { frames: [], textHead: archive.text, textTail: "" });
		return;
	}
	Object.assign(slot, {
		frames: archive.frames.filter(frame => !isPersistenceTruncatedString(frame.data)),
	});
}

function blobRefSites(values: readonly unknown[]): BlobRefSite[] {
	const sites: BlobRefSite[] = [];
	for (const value of values) {
		if (containsBlobRef(value)) collectBlobRefSites(value, sites);
	}
	return sites;
}

function blobSiteKey(site: BlobRefSite): string {
	return `${site.asDataUrl ? "url" : "base64"}:${site.ref}`;
}

async function resolveBlobRefs(values: readonly unknown[], blobStore: BlobStore): Promise<void> {
	const semaphore = new Semaphore(BLOB_READ_CONCURRENCY);
	const resolved = new Map<string, Promise<string>>();
	await Promise.all(
		blobRefSites(values).map(async site => {
			const key = blobSiteKey(site);
			let data = resolved.get(key);
			if (!data) {
				data = (async () => {
					await semaphore.acquire();
					try {
						return await (site.asDataUrl
							? resolveImageDataUrl(blobStore, site.ref)
							: resolveImageData(blobStore, site.ref));
					} finally {
						semaphore.release();
					}
				})();
				resolved.set(key, data);
			}
			site.holder[site.key] = await data;
		}),
	);
}

/** The non-header entries, with legacy truncated snapcompact frames repaired before their blobs resolve. */
function entriesForBlobResolution(entries: FileEntry[]): FileEntry[] {
	const sessionEntries = entries.filter(entry => entry.type !== "session");
	for (const entry of sessionEntries) repairTruncatedSnapcompactFrames(entry);
	return sessionEntries;
}

/** Restore the image data that persistence externalized to the blob store, in place. */
export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	await resolveBlobRefs(entriesForBlobResolution(entries), blobStore);
}

/** Synchronous {@link resolveBlobRefsInEntries}. */
export function resolveBlobRefsInEntriesSync(entries: FileEntry[], blobStore: BlobStore): void {
	const resolved = new Map<string, string>();
	for (const site of blobRefSites(entriesForBlobResolution(entries))) {
		const key = blobSiteKey(site);
		let data = resolved.get(key);
		if (data === undefined) {
			data = site.asDataUrl
				? resolveImageDataUrlSync(blobStore, site.ref)
				: resolveImageDataSync(blobStore, site.ref);
			resolved.set(key, data);
		}
		site.holder[site.key] = data;
	}
}

/**
 * Read-only transcript view of a session file: load entries, migrate to the
 * current version, resolve blob refs, and build the display transcript along
 * the replayed leaf path (including late usage's captured leaf). Uses transcript mode (collapsed to the
 * latest compaction) so failed/aborted tail turns stay visible, unlike the
 * provider-context builder which drops them. Does NOT create a writer or take
 * the session lock — safe to call against a file another session is writing.
 */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const blobs = new BlobStore(getBlobsDir());
	const byId = new Map<string, PositionedSessionEntry>();
	let leafId: string | null = null;
	let lastSelfSelected: string | null = null;
	const loaded = await visitSessionFileForResume(filePath, (entry, position) => {
		byId.set(position.id, position);
		leafId = sessionEntryLeafId(entry);
		if (leafId === entry.id) lastSelfSelected = leafId;
	});
	if (leafId !== null && !byId.has(leafId)) leafId = lastSelfSelected;
	let leaf = leafId === null ? undefined : byId.get(leafId);
	if (loaded.invalidHeader || loaded.entries.length === 0 || loaded.sourceFd === undefined) return [];
	const fd = loaded.sourceFd;
	let messages: AgentMessage[];
	try {
		const path: PositionedSessionEntry[] = [];
		const seen = new Set<string>();
		while (leaf && !seen.has(leaf.id)) {
			seen.add(leaf.id);
			path.push(leaf);
			leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
		}
		const options = {
			transcript: true,
			collapseCompactedHistory: true,
			resolveFrameData: (data: string) => lazyImageDataSync(blobs, data),
		};
		const selected = selectSessionContextEntriesFromLeafPath(
			path,
			id => readPositionedSessionEntry(fd, byId.get(id)!),
			options,
		);
		({ messages } = buildSessionContextFromLeafPath(selected, options));
	} finally {
		fs.closeSync(fd);
	}
	// A collapsed summary carries the remote-compaction replacement history for
	// provider replay only; this transcript is never replayed, and the renderer
	// reads just the summary. Dropping it keeps hydration off every image blob
	// buried in that hidden history.
	const displayMessages = messages.map(message =>
		message.role === "compactionSummary" && message.providerPayload !== undefined
			? { ...message, providerPayload: undefined }
			: message,
	);
	await resolveBlobRefs(displayMessages, blobs);
	return displayMessages;
}
