import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { ProviderSessionState, StreamOptions } from "../types";

interface Fingerprint {
	hash: string;
	length: number;
}
interface BlockFingerprint extends Fingerprint {
	type: string;
	fields: Record<string, Fingerprint>;
}
interface MessageFingerprint {
	role: string;
	blocks: BlockFingerprint[];
}
export interface PrefixSnapshot {
	system: Fingerprint;
	tools: Fingerprint;
	messages: MessageFingerprint[];
}
interface PrefixDifference {
	section: string;
	messageIndex?: number;
	blockIndex?: number;
	oldRole?: string;
	newRole?: string;
	oldBlockTypes?: string[];
	newBlockTypes?: string[];
	field: string;
	old?: Fingerprint;
	new?: Fingerprint;
}
export interface ThinkingPrefixDiagnostic {
	baseline: "previous-dispatch" | "unavailable";
	comparison: "changed" | "shared-prefix-unchanged" | "unavailable";
	stage: string;
	difference?: PrefixDifference;
}

function fingerprint(value: unknown): Fingerprint {
	const normalized = stableStringifyJson(value ?? null);
	return { hash: Bun.hash(normalized).toString(16).padStart(16, "0"), length: normalized.length };
}
function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function blockFingerprint(value: unknown): BlockFingerprint {
	const block = record(value);
	const fields: Record<string, Fingerprint> = {};
	// Only fixed field names can reach logs; tool input keys and message bodies cannot.
	for (const key of [
		"text",
		"thinking",
		"content",
		"cache_control",
		"signature",
		"id",
		"source",
		"input",
		"data",
		"tool_use_id",
		"reasoningContent",
		"toolResult",
		"toolUse",
		"image",
		"cachePoint",
	]) {
		if (key in block) fields[key] = fingerprint(block[key]);
	}
	return {
		...fingerprint(value),
		type: typeof block.type === "string" ? block.type : Object.keys(fields).join("+"),
		fields,
	};
}

/** Retains hashes and lengths only. Object key order is normalized; cache markers are deliberately retained. */
export function snapshotThinkingPrefix(payload: unknown): PrefixSnapshot {
	const body = record(payload);
	return {
		system: fingerprint(body.system),
		tools: fingerprint(body.tools ?? body.toolConfig),
		messages: (Array.isArray(body.messages) ? body.messages : []).map(value => {
			const message = record(value);
			const content =
				typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
			return { role: String(message.role), blocks: (Array.isArray(content) ? content : []).map(blockFingerprint) };
		}),
	};
}

function firstDifference(old: PrefixSnapshot, next: PrefixSnapshot): PrefixDifference | undefined {
	for (const section of ["system", "tools"] as const) {
		if (old[section].hash !== next[section].hash)
			return { section, field: section, old: old[section], new: next[section] };
	}
	for (let messageIndex = 0; messageIndex < old.messages.length; messageIndex++) {
		const before = old.messages[messageIndex]!;
		const after = next.messages[messageIndex];
		const location = {
			section: "messages",
			messageIndex,
			oldRole: before.role,
			newRole: after?.role,
			oldBlockTypes: before.blocks.map(block => block.type),
			newBlockTypes: after?.blocks.map(block => block.type),
		};
		if (!after || before.role !== after.role) return { ...location, field: after ? "role" : "message-count" };
		for (let blockIndex = 0; blockIndex < Math.max(before.blocks.length, after.blocks.length); blockIndex++) {
			const a = before.blocks[blockIndex];
			const b = after.blocks[blockIndex];
			// Appending blocks to the last message extends the shared prefix.
			if (!a && messageIndex === old.messages.length - 1) continue;
			if (a?.hash === b?.hash) continue;
			let field = !a || !b ? "content-length" : a.type !== b.type ? "type" : "other";
			if (a && b && field === "other") {
				field =
					[...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].find(
						key => a.fields[key]?.hash !== b.fields[key]?.hash,
					) ?? "other";
			}
			return {
				...location,
				blockIndex,
				field,
				old: a && { hash: a.hash, length: a.length },
				new: b && { hash: b.hash, length: b.length },
			};
		}
	}
	return undefined;
}

class PrefixDiagnosticsState implements ProviderSessionState {
	readonly sessions = new Map<string, PrefixSnapshot>();
	close(): void {
		this.sessions.clear();
	}
	releaseSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}
}
const diagnostics = new WeakMap<object, ThinkingPrefixDiagnostic>();

/** Call at dispatch, using the full logical body even when the wire uses a thread delta. */
export function recordThinkingPrefixDispatch(
	payload: object,
	options: StreamOptions | undefined,
	scope: string,
	beforeHook?: PrefixSnapshot,
): void {
	const key = `thinking-prefix-diagnostics:${scope}`;
	const store = options?.providerSessionState;
	let state = store?.get(key) as PrefixDiagnosticsState | undefined;
	if (store && !state) {
		state = new PrefixDiagnosticsState();
		store.set(key, state);
	}
	const session = options?.sessionId ?? "";
	const previous = state?.sessions.get(session);
	const current = snapshotThinkingPrefix(payload);
	const difference = previous && firstDifference(previous, current);
	const hookDifference = beforeHook && firstDifference(beforeHook, current);
	diagnostics.set(payload, {
		baseline: previous ? "previous-dispatch" : "unavailable",
		comparison: previous ? (difference ? "changed" : "shared-prefix-unchanged") : "unavailable",
		stage: difference
			? hookDifference &&
				hookDifference.section === difference.section &&
				hookDifference.messageIndex === difference.messageIndex &&
				hookDifference.blockIndex === difference.blockIndex
				? "onPayload-or-final-normalization"
				: "before-onPayload; upstream-stage-unknown"
			: "unknown",
		...(difference ? { difference } : {}),
	});
	state?.sessions.set(session, current);
}

export function thinkingPrefixDiagnostic(payload: object): ThinkingPrefixDiagnostic | undefined {
	return diagnostics.get(payload);
}
