import type { SessionEntry } from "./session-entries";

interface PruningBranchSource {
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
	iterateBranchMatchingNewestFirst?(
		predicate: (metadata: { id: string; type: string; messageRole?: string }) => boolean,
	): IterableIterator<SessionEntry>;
}

/** Read the prune region first, and older tool calls only when a kept result needs them. */
export function getPruningBranch(source: PruningBranchSource): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const seen = new Set<string>();
	let id = source.getLeafId();
	let boundary: string | undefined;
	let foundCompaction = false;
	let lookingForCalls = false;
	const selected = source.iterateBranchMatchingNewestFirst?.(metadata =>
		lookingForCalls
			? metadata.type === "message" && metadata.messageRole === "assistant"
			: metadata.type === "message" ||
				metadata.type === "compaction" ||
				metadata.type === "tool_result_prune" ||
				metadata.id === boundary,
	);
	const nextEntry = (): SessionEntry | undefined => {
		if (selected) return selected.next().value;
		if (!id || seen.has(id)) return undefined;
		seen.add(id);
		const entry = source.getEntry(id);
		id = entry?.parentId ?? null;
		return entry;
	};
	while (true) {
		const entry = nextEntry();
		if (!entry) break;
		entries.push(entry);
		if (!foundCompaction && entry.type === "compaction") {
			foundCompaction = true;
			boundary = entry.firstKeptEntryId;
		}
		if (entry.id === boundary) break;
	}
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult") results.add(entry.message.toolCallId);
		if (entry.message.role === "assistant") {
			for (const block of entry.message.content) if (block.type === "toolCall") calls.add(block.id);
		}
	}
	const missing = new Set([...results].filter(call => !calls.has(call)));
	lookingForCalls = true;
	while (missing.size > 0) {
		const entry = nextEntry();
		if (!entry) break;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		let needed = false;
		for (const block of entry.message.content) {
			if (block.type === "toolCall" && missing.delete(block.id)) needed = true;
		}
		if (needed) entries.push(entry);
	}
	return entries.reverse();
}
