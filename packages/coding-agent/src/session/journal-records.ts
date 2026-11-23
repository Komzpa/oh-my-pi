import type { CustomEntry, FileEntry, SessionEntry, SessionHeader } from "./session-entries";

/** Physical journal records; loaders fold these before exposing logical history. */
export const ENTRY_REVISION = "omp:journal-entry-revision:v1";
export const HEADER_REVISION = "omp:journal-header-revision:v1";

export function entryRevision(record: FileEntry): SessionEntry | undefined {
	if (record.type !== "custom" || record.customType !== ENTRY_REVISION) return undefined;
	const entry = record.data as FileEntry | undefined;
	if (!entry || typeof entry.id !== "string" || typeof entry.type !== "string" || entry.type === "session")
		throw new Error("Invalid journal entry revision");
	return entry;
}

export function headerRevision(record: FileEntry): SessionHeader | undefined {
	if (record.type !== "custom" || record.customType !== HEADER_REVISION) return undefined;
	const header = record.data as SessionHeader | undefined;
	if (!header || header.type !== "session" || typeof header.id !== "string")
		throw new Error("Invalid journal header revision");
	return header;
}

export function revisionRecord(customType: string, data: SessionEntry | SessionHeader): CustomEntry {
	return {
		type: "custom",
		customType,
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		data,
	};
}

/** Revisions replace the original logical slot, never the current conversation leaf. */
export function foldJournalRecords(records: readonly FileEntry[]): FileEntry[] {
	const entries: FileEntry[] = [];
	const slots = new Map<string, number>();
	for (const record of records) {
		const revision = entryRevision(record);
		if (revision) {
			const slot = slots.get(revision.id);
			if (slot === undefined) throw new Error(`Journal revision target ${revision.id} not found`);
			entries[slot] = revision;
			continue;
		}
		const header = headerRevision(record);
		if (header) {
			if (entries[0]?.type !== "session" || entries[0].id !== header.id)
				throw new Error("Journal header identity changed");
			entries[0] = header;
			continue;
		}
		if (record.type === "title_change" && entries[0]?.type === "session") {
			entries[0].title = record.title;
			entries[0].titleSource = record.source;
		}
		if (record.type !== "session") slots.set(record.id, entries.length);
		entries.push(record);
	}
	return entries;
}
