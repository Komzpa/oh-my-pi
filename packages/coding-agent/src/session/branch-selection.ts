import type { SessionEntry } from "./session-entries";

/** Consumer metadata contract; the optional indexed APIs are supplied by the session backend. */
export type SessionContextEntryMetadata = {
	type: SessionEntry["type"];
	customType?: string;
	messageRole?: string;
	toolName?: string;
};
export function sessionContextEntryMetadata(entry: SessionEntry): SessionContextEntryMetadata {
	return {
		type: entry.type,
		customType: entry.type === "custom" ? entry.customType : undefined,
		messageRole: entry.type === "message" ? entry.message.role : undefined,
		toolName: entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolName : undefined,
	};
}
type Predicate = (metadata: SessionContextEntryMetadata) => boolean;
export type BranchSource = {
	getBranch(): readonly SessionEntry[];
	getBranchMatching?: (predicate: Predicate) => SessionEntry[];
	getLatestBranchMatching?: (predicate: Predicate) => SessionEntry | undefined;
	iterateBranchMatchingNewestFirst?: (predicate: Predicate) => Iterable<SessionEntry>;
};
export function selectBranchEntries(source: BranchSource, predicate: Predicate): SessionEntry[] {
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
