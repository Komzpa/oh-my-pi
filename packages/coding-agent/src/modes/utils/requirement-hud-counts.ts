import { matchingRequirementBranch, latestRequirementsFromSession } from "../../session/requirements-branch-selection";
import { getCompletedTodoRows, getClosedTodoRows, getAcceptedTodoRows } from "../../tools/todo";
import type { SessionManager } from "../../session/session-manager";
import type { SessionEntry } from "../../session/session-entries";
import type { RequirementEntryMetadata } from "../../session/requirements-branch-selection";
import {
	countRequirements,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	type RequirementCounts,
} from "../../tools/requirements-ledger";

type RequirementHudSessionManager = Pick<SessionManager, "getLeafId" | "getEntries" | "getBranch">;

const requirementHudCountsCache = new WeakMap<
	RequirementHudSessionManager,
	{
		leafId: string | null;
		entryCount: number;
		counts: RequirementCounts;
		revision: number | undefined;
		selected?: SessionEntry[];
	}
>();

const isRequirementHudEntry = (entry: RequirementEntryMetadata): boolean =>
	(entry.type === "custom" &&
		(entry.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE || entry.customType === "user_todo_edit")) ||
	(entry.type === "message" && entry.messageRole === "toolResult" && entry.toolName === "todo");

/** Reuse counts until the session branch or entry count changes, without copying entries. */
export function getRequirementHudCounts(sessionManager: RequirementHudSessionManager): RequirementCounts {
	const leafId = sessionManager.getLeafId();
	const counter = sessionManager as RequirementHudSessionManager & {
		getEntryCount?: () => number;
		readonly bodyRevision?: number;
		getCachedBranchMatching?: (predicate: (entry: RequirementEntryMetadata) => boolean) => SessionEntry[];
	};
	const entryCount = counter.getEntryCount?.() ?? sessionManager.getEntries().length;
	const cached = requirementHudCountsCache.get(sessionManager);
	const revision = counter.bodyRevision;
	if (cached?.leafId === leafId && cached.entryCount === entryCount && cached.revision === revision)
		return cached.counts;
	const selected = counter.getCachedBranchMatching?.(isRequirementHudEntry);
	if (selected && cached?.selected === selected && cached.revision === revision) {
		requirementHudCountsCache.set(sessionManager, { ...cached, leafId, entryCount });
		return cached.counts;
	}

	const requirements = selected ? getLatestRequirements(selected) : latestRequirementsFromSession(sessionManager);
	const branch = requirements.some(r => r.classification === "linked")
		? (selected ??
			matchingRequirementBranch(
				sessionManager,
				entry =>
					(entry.type === "custom" && entry.customType === "user_todo_edit") ||
					(entry.type === "message" && entry.messageRole === "toolResult" && entry.toolName === "todo"),
			))
		: [];
	const counts = countRequirements(
		requirements,
		getCompletedTodoRows(branch),
		getClosedTodoRows(branch),
		getAcceptedTodoRows(branch),
	);

	requirementHudCountsCache.set(sessionManager, { leafId, entryCount, counts, revision, selected });
	return counts;
}
