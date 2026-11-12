import { isRecord } from "@oh-my-pi/pi-utils";
import type { TodoDisplayRequirement } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { TodoArchiveSummary, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { readTodoArchiveState } from "./todo";
import { type BranchSource, isTodoSelectionEntryMetadata, selectLatestBranchEntry } from "../session/branch-selection";
import type { SessionEntry } from "../session/session-entries";

/** Read the ledger's durable wire projection without depending on an extension implementation. */
export function readTodoDisplayLedger(
	entries: readonly SessionEntry[],
	liveWorkerIds?: ReadonlySet<string>,
): {
	requirements?: TodoDisplayRequirement[];
	auditors: Map<string, string>;
} {
	let ledger: unknown;
	let assignments: unknown;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "requirements_ledger") ledger = entry.data;
		if (entry.customType === "requirements_auditor_assignments") assignments = entry.data;
	}
	const requirements: TodoDisplayRequirement[] = [];
	if (isRecord(ledger) && Array.isArray(ledger.requirements)) {
		for (const item of ledger.requirements) {
			if (!isRecord(item) || typeof item.classification !== "string" || !Array.isArray(item.rows)) continue;
			const rowVerdicts: Record<string, { status: string }> = {};
			if (isRecord(item.rowVerdicts))
				for (const [title, verdict] of Object.entries(item.rowVerdicts)) {
					if (isRecord(verdict) && typeof verdict.status === "string")
						rowVerdicts[title] = { status: verdict.status };
				}
			requirements.push({
				classification: item.classification,
				rows: item.rows.filter((row): row is string => typeof row === "string"),
				rowVerdicts,
			});
		}
	}
	const auditors = new Map<string, string>();
	if (isRecord(assignments) && Array.isArray(assignments.jobs))
		for (const job of assignments.jobs) {
			if (
				!isRecord(job) ||
				job.agent !== "qa-auditor" ||
				typeof job.workerId !== "string" ||
				!Array.isArray(job.rows)
			)
				continue;
			if (liveWorkerIds && !liveWorkerIds.has(job.workerId)) continue;
			for (const row of job.rows) if (typeof row === "string") auditors.set(row, job.workerId);
		}
	return { requirements: ledger === undefined ? undefined : requirements, auditors };
}

interface DisplayLedgerSource extends BranchSource {
	getLeafId(): string | null;
}
const displayEntries = new WeakMap<DisplayLedgerSource, { leaf: string | null; entries: SessionEntry[] }>();

/** Keep HUD refreshes off the full journal; only the latest two snapshots matter. */
export function readTodoDisplayLedgerFromManager(manager: DisplayLedgerSource, liveWorkerIds?: ReadonlySet<string>) {
	const leaf = manager.getLeafId();
	let cached = displayEntries.get(manager);
	if (!cached || cached.leaf !== leaf) {
		const entries: SessionEntry[] = [];
		for (const customType of ["requirements_ledger", "requirements_auditor_assignments"]) {
			const entry = selectLatestBranchEntry(
				manager,
				metadata => metadata.type === "custom" && metadata.customType === customType,
			);
			if (entry) entries.push(entry);
		}
		cached = { leaf, entries };
		displayEntries.set(manager, cached);
	}
	return readTodoDisplayLedger(cached.entries, liveWorkerIds);
}

interface DisplayArchive {
	latest: string | undefined;
	phases: TodoPhase[];
	summary: TodoArchiveSummary | undefined;
}

/** Use the archive fold already maintained by resume and native todo operations. */
export function readTodoDisplayArchive(manager: DisplayLedgerSource): DisplayArchive {
	const latest = selectLatestBranchEntry(manager, isTodoSelectionEntryMetadata)?.id;
	const archive = readTodoArchiveState(manager);
	return { latest, phases: archive.phases, summary: archive.summary };
}
