import { expect, test } from "bun:test";
import { getPruningBranch } from "../src/session/pruning-branch";
import type { SessionEntry } from "../src/session/session-entries";

function fixture(entries: SessionEntry[], indexed = false) {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const reads: string[] = [];
	return {
		...(indexed
			? {
					*iterateBranchMatchingNewestFirst(
						predicate: (metadata: { id: string; type: string; messageRole?: string }) => boolean,
					) {
						for (const entry of entries.toReversed())
							if (
								predicate({
									id: entry.id,
									type: entry.type,
									messageRole: entry.type === "message" ? entry.message.role : undefined,
								})
							) {
								reads.push(entry.id);
								yield entry;
							}
					},
				}
			: {}),
		reads,
		getLeafId: () => entries.at(-1)?.id ?? null,
		getEntry(id: string) {
			reads.push(id);
			return byId.get(id);
		},
	};
}

const timestamp = new Date(0).toISOString();
function note(id: string, parentId: string | null): SessionEntry {
	return { id, parentId, timestamp, type: "custom", customType: "test", data: {} };
}
function compact(parentId: string, firstKeptEntryId: string): SessionEntry {
	return {
		id: "compact",
		parentId,
		timestamp,
		type: "compaction",
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

test("does not read summarized entries before a valid boundary", () => {
	const source = fixture([note("old", null), note("kept", "old"), compact("kept", "kept"), note("tail", "compact")]);
	expect(getPruningBranch(source).map(entry => entry.id)).toEqual(["kept", "compact", "tail"]);
	expect(source.reads).toEqual(["tail", "compact", "kept"]);
});

test("retains a pre-boundary call required by a kept tool result", () => {
	const call = {
		...note("call", "old"),
		type: "message",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			stopReason: "toolUse",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "SKILL.md" } }],
		},
	} as SessionEntry;
	const result = {
		...note("result", "call"),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: "protected instructions" }],
			isError: false,
			timestamp: 0,
		},
	} as SessionEntry;
	for (const indexed of [false, true]) {
		const source = fixture([note("old", null), call, result, compact("result", "result")], indexed);
		expect(getPruningBranch(source).map(entry => entry.id)).toEqual(["call", "result", "compact"]);
		expect(source.reads).toEqual(["compact", "result", "call"]);
	}
});

test("preserves the whole branch without a compaction or with a missing boundary", () => {
	const entries = [note("old", null), note("tail", "old")];
	expect(getPruningBranch(fixture(entries))).toEqual(entries);
	const invalidBoundary = [...entries, compact("tail", "missing")];
	expect(getPruningBranch(fixture(invalidBoundary))).toEqual(invalidBoundary);
});

test("indexed pruning skips unrelated payloads while preserving a compaction anchor", () => {
	const entries = [note("old", null), note("kept", "old"), compact("kept", "kept"), note("tail", "compact")];
	const reads: string[] = [];
	const source = {
		getLeafId: () => "tail",
		getEntry: (_id: string): SessionEntry | undefined => {
			throw new Error("unfiltered payload read");
		},
		*iterateBranchMatchingNewestFirst(predicate: (metadata: { id: string; type: string }) => boolean) {
			for (const entry of entries.toReversed())
				if (predicate(entry)) {
					reads.push(entry.id);
					yield entry;
				}
		},
	};
	expect(getPruningBranch(source).map(entry => entry.id)).toEqual(["kept", "compact"]);
	expect(reads).toEqual(["compact", "kept"]);
});
