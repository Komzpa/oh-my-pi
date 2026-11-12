import type { SessionEntry } from "./session-entries";

/** Consumer metadata contract; the optional indexed APIs are supplied by the session backend. */
export type SessionContextEntryMetadata = {
	id?: string;
	type: SessionEntry["type"];
	customType?: string;
	messageRole?: string;
	toolName?: string;
};
export function sessionContextEntryMetadata(entry: SessionEntry): SessionContextEntryMetadata {
	return {
		id: entry.id,
		type: entry.type,
		customType: entry.type === "custom" || entry.type === "custom_message" ? entry.customType : undefined,
		messageRole: entry.type === "message" ? entry.message.role : undefined,
		toolName: entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolName : undefined,
	};
}
type Predicate = (metadata: SessionContextEntryMetadata) => boolean;
export type BranchSource = {
	getBranch(): readonly SessionEntry[];
	getLeafId?: () => string | null;
	getEntry?: (id: string) => SessionEntry | undefined;
	getBranchTailMatching?: (limit: number, predicate: Predicate) => SessionEntry[];
	getBranchMatching?: (predicate: Predicate) => SessionEntry[];
	getBranchMatchingCooperatively?: (predicate: Predicate) => Promise<SessionEntry[]>;
	getCachedBranchMatching?: (predicate: Predicate) => SessionEntry[];
	getLatestBranchMatching?: (predicate: Predicate) => SessionEntry | undefined;
	iterateBranchMatchingNewestFirst?: (predicate: Predicate) => Iterable<SessionEntry>;
};
export function selectBranchEntries(source: BranchSource, predicate: Predicate): SessionEntry[] {
	if (predicate === isTodoSelectionEntryMetadata && source.getCachedBranchMatching)
		return source.getCachedBranchMatching(predicate);
	if (source.getBranchMatching) return source.getBranchMatching(predicate);
	return source.getBranch().filter(entry => predicate(sessionContextEntryMetadata(entry)));
}
export function* selectBranchNewestFirst(source: BranchSource, predicate: Predicate): IterableIterator<SessionEntry> {
	if (source.iterateBranchMatchingNewestFirst) {
		yield* source.iterateBranchMatchingNewestFirst(predicate);
		return;
	}
	const branch = selectBranchEntries(source, predicate);
	for (let i = branch.length - 1; i >= 0; i--) yield branch[i]!;
}
export function selectLatestBranchEntry(source: BranchSource, predicate: Predicate): SessionEntry | undefined {
	if (source.getLatestBranchMatching) return source.getLatestBranchMatching(predicate);
	return selectBranchNewestFirst(source, predicate).next().value;
}

export function isTodoSelectionEntryMetadata(metadata: {
	type: SessionEntry["type"];
	customType?: string;
	messageRole?: string;
	toolName?: string;
}): boolean {
	return (
		(metadata.type === "custom" &&
			(metadata.customType === "user_todo_edit" || metadata.customType === "todo_hud_state")) ||
		(metadata.type === "message" && metadata.messageRole === "toolResult" && metadata.toolName === "todo")
	);
}

/** Walk indexed parents cooperatively: no branch materialization or transcript filtering. */
export async function selectBranchEntriesCooperatively(
	source: BranchSource,
	predicate: Predicate,
): Promise<SessionEntry[]> {
	if (source.getBranchMatchingCooperatively) return source.getBranchMatchingCooperatively(predicate);
	if (source.iterateBranchMatchingNewestFirst) {
		const selected: SessionEntry[] = [];
		for (const entry of source.iterateBranchMatchingNewestFirst(predicate)) {
			selected.push(entry);
			if (selected.length % 128 === 0) await Bun.sleep(0);
		}
		return selected.reverse();
	}
	if (!source.getLeafId || !source.getEntry) return selectBranchEntries(source, predicate);
	const selected: SessionEntry[] = [];
	let id = source.getLeafId();
	let count = 0;
	const seen = new Set<string>();
	while (id && !seen.has(id)) {
		seen.add(id);
		const entry = source.getEntry(id);
		if (!entry) break;
		if (predicate(sessionContextEntryMetadata(entry))) selected.push(entry);
		id = entry.parentId;
		if (++count % 256 === 0) await Bun.sleep(0);
	}
	return selected.reverse();
}
