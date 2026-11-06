import { matchingRequirementBranch, latestRequirementsFromSession } from "../../session/requirements-branch-selection";
import { getCompletedTodoRows, getClosedTodoRows, getAcceptedTodoRows } from "../../tools/todo";
import type { SessionManager } from "../../session/session-manager";
import { countRequirements, type RequirementCounts } from "../../tools/requirements-ledger";

type RequirementHudSessionManager = Pick<SessionManager, "getLeafId" | "getEntries" | "getBranch">;

const requirementHudCountsCache = new WeakMap<
	RequirementHudSessionManager,
	{ leafId: string | null; entryCount: number; counts: RequirementCounts }
>();

/** Reuse counts until the session branch or entry count changes, without copying entries. */
export function getRequirementHudCounts(sessionManager: RequirementHudSessionManager): RequirementCounts {
	const leafId = sessionManager.getLeafId();
	const counter = sessionManager as RequirementHudSessionManager & { getEntryCount?: () => number };
	const entryCount = counter.getEntryCount?.() ?? sessionManager.getEntries().length;
	const cached = requirementHudCountsCache.get(sessionManager);
	if (cached?.leafId === leafId && cached.entryCount === entryCount) return cached.counts;

	const requirements = latestRequirementsFromSession(sessionManager);
	const branch = requirements.some(r => r.classification === "linked")
		? matchingRequirementBranch(
				sessionManager,
				entry =>
					(entry.type === "custom" && entry.customType === "user_todo_edit") ||
					(entry.type === "message" && entry.messageRole === "toolResult" && entry.toolName === "todo"),
			)
		: [];
	const counts = countRequirements(
		requirements,
		getCompletedTodoRows(branch),
		getClosedTodoRows(branch),
		getAcceptedTodoRows(branch),
	);

	requirementHudCountsCache.set(sessionManager, { leafId, entryCount, counts });
	return counts;
}
