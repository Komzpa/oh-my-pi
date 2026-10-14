import type { SessionEntry } from "../../session/session-entries";
import type { SessionManager } from "../../session/session-manager";
import {
	countRequirements,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	type RequirementCounts,
} from "../../tools/requirements-ledger";

const requirementHudCountsCache = new WeakMap<
	SessionManager,
	{ leafId: string | null; entryCount: number; counts: RequirementCounts }
>();

/** Reuse counts until the session branch or entry count changes, without copying entries. */
export function getRequirementHudCounts(sessionManager: SessionManager): RequirementCounts {
	const leafId = sessionManager.getLeafId();
	const counter = sessionManager as SessionManager & { getEntryCount?: () => number };
	const entryCount = counter.getEntryCount?.() ?? sessionManager.getEntries().length;
	const cached = requirementHudCountsCache.get(sessionManager);
	if (cached?.leafId === leafId && cached.entryCount === entryCount) return cached.counts;

	const selective = sessionManager as SessionManager & {
		getBranchMatching?: (predicate: (entry: { type: string; customType?: string }) => boolean) => SessionEntry[];
	};
	const entries = selective.getBranchMatching
		? selective.getBranchMatching(
				entry => entry.type === "custom" && entry.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE,
			)
		: sessionManager.getBranch();
	const counts = countRequirements(getLatestRequirements(entries));
	requirementHudCountsCache.set(sessionManager, { leafId, entryCount, counts });
	return counts;
}
