import type { SessionEntry } from "../session/session-entries";

type RestartEntryMetadata = {
	type: SessionEntry["type"];
	customType?: string;
	messageRole?: string;
	toolName?: string;
};
type RestartEntryPredicate = (metadata: RestartEntryMetadata) => boolean;
type RestartBranchSource = {
	getBranch(): readonly SessionEntry[];
	getBranchMatching?: (predicate: RestartEntryPredicate) => SessionEntry[];
	getLatestBranchMatching?: (predicate: RestartEntryPredicate) => SessionEntry | undefined;
};

/** Prefer the backend metadata index without requiring it on standalone restart topics. */
export function selectRestartBranchEntries(
	source: RestartBranchSource,
	predicate: RestartEntryPredicate,
): SessionEntry[] {
	if (source.getBranchMatching) return source.getBranchMatching(predicate);
	return source.getBranch().filter(entry =>
		predicate({
			type: entry.type,
			customType: entry.type === "custom" ? entry.customType : undefined,
			messageRole: entry.type === "message" ? entry.message.role : undefined,
			toolName: entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolName : undefined,
		}),
	);
}

export function selectLatestRestartBranchEntry(
	source: RestartBranchSource,
	predicate: RestartEntryPredicate,
): SessionEntry | undefined {
	if (source.getLatestBranchMatching) return source.getLatestBranchMatching(predicate);
	return selectRestartBranchEntries(source, predicate).at(-1);
}
