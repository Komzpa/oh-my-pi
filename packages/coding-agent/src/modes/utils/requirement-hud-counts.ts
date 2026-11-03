import { latestRequirementsFromSession } from "../../session/requirements-branch-selection";
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

	const counts = countRequirements(latestRequirementsFromSession(sessionManager));

	requirementHudCountsCache.set(sessionManager, { leafId, entryCount, counts });
	return counts;
}
