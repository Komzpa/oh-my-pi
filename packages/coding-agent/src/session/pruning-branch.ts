import type { SessionEntry } from "./session-entries";

interface PruningBranchSource {
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
}

/** Read the prune region first, and older tool calls only when a kept result needs them. */
export function getPruningBranch(source: PruningBranchSource): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const seen = new Set<string>();
	let id = source.getLeafId();
	let boundary: string | undefined;
	let foundCompaction = false;
	while (id && !seen.has(id)) {
		seen.add(id);
		const entry = source.getEntry(id);
		if (!entry) break;
		entries.push(entry);
		id = entry.parentId;
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
	while (missing.size > 0 && id && !seen.has(id)) {
		seen.add(id);
		const entry = source.getEntry(id);
		if (!entry) break;
		id = entry.parentId;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		let needed = false;
		for (const block of entry.message.content) {
			if (block.type === "toolCall" && missing.delete(block.id)) needed = true;
		}
		if (needed) entries.push(entry);
	}
	return entries.reverse();
}
