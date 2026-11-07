import { expect, it } from "bun:test";
import {
	buildSessionContextFromLeafPath,
	selectSessionContextEntriesFromLeafPath,
} from "../../src/session/session-context";
import { SessionEntryIndex } from "../../src/session/session-manager";
import { CONTEXT_NOTES_ENTRY_TYPE } from "../../src/session/context-notes";
import type { SessionEntry } from "../../src/session/session-entries";

const timestamp = "2026-11-06T00:00:00Z";

it("refreshes cached provider and display selections after edits, appends and branch changes", () => {
	const index = new SessionEntryIndex();
	const first: SessionEntry = {
		type: "message",
		id: "first",
		parentId: null,
		timestamp,
		message: { role: "user", content: "first", timestamp: 1 },
	};
	const second: SessionEntry = {
		type: "message",
		id: "second",
		parentId: "first",
		timestamp,
		message: { role: "user", content: "second", timestamp: 2 },
	};
	const compaction: SessionEntry = {
		type: "compaction",
		id: "compact",
		parentId: "second",
		timestamp,
		summary: "summary",
		tokensBefore: 100,
		firstKeptEntryId: "second",
	};
	index.insert(first);
	index.insert(second);
	index.insert(compaction);
	const context = (transcript = false) =>
		buildSessionContextFromLeafPath(
			index.contextLeafPath(transcript ? { transcript: true, collapseCompactedHistory: true } : undefined),
		).messages;
	expect(context().map(message => message.role)).toEqual(["compactionSummary", "user"]);
	expect(context(true).map(message => message.role)).toEqual(["compactionSummary", "user"]);
	compaction.firstKeptEntryId = "first";
	index.update(compaction);
	expect(context().map(message => message.role)).toEqual(["compactionSummary", "user", "user"]);
	expect(context(true).map(message => message.role)).toEqual(["compactionSummary", "user", "user"]);
	index.insert({ type: "reset_boundary", id: "reset", parentId: "compact", timestamp });
	expect(context()).toEqual([]);
	index.setLeaf("first");
	expect(context()).toEqual([first.message]);
	expect(context(true)).toEqual([first.message]);
});

it("incremental appends preserve full replay after a compaction and an unrelated leaf", () => {
	const index = new SessionEntryIndex();
	const initial: SessionEntry[] = [
		{
			type: "message",
			id: "old",
			parentId: null,
			timestamp,
			message: { role: "user", content: "old", timestamp: 1 },
		},
		{
			type: "custom",
			id: "notes",
			parentId: "old",
			timestamp,
			customType: CONTEXT_NOTES_ENTRY_TYPE,
			data: { version: 1, text: "remember" },
		},
		{
			type: "message",
			id: "kept",
			parentId: "notes",
			timestamp,
			message: { role: "user", content: "kept", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp,
			summary: "summary",
			tokensBefore: 100,
			firstKeptEntryId: "kept",
		},
		{ type: "custom", id: "archive", parentId: "compact", timestamp, customType: "archive", data: {} },
	];
	for (const entry of initial) index.insert(entry);
	const assertReplay = () => {
		for (const transcript of [false, true]) {
			const options = transcript ? { transcript: true, collapseCompactedHistory: true } : undefined;
			const actual = buildSessionContextFromLeafPath(index.contextLeafPath(options), options);
			const full = selectSessionContextEntriesFromLeafPath(
				index.metadataPath().toReversed(),
				id => index.get(id)!,
				options,
			);
			expect(actual).toEqual(buildSessionContextFromLeafPath(full, options));
		}
	};
	assertReplay();
	const appended: SessionEntry[] = [
		{
			type: "message",
			id: "new",
			parentId: "archive",
			timestamp,
			message: { role: "user", content: "new", timestamp: 3 },
		},
		{
			type: "custom",
			id: "new-notes",
			parentId: "new",
			timestamp,
			customType: CONTEXT_NOTES_ENTRY_TYPE,
			data: { version: 1, text: "updated" },
		},
		{ type: "custom", id: "irrelevant", parentId: "new-notes", timestamp, customType: "archive", data: {} },
	];
	for (const entry of appended) {
		index.insert(entry);
		assertReplay();
	}
});
