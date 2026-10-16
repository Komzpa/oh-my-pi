import { matchingRequirementBranchNewestFirst } from "../../session/requirements-branch-selection";
import type { SessionManager } from "../../session/session-manager";
import {
	countRequirements,
	parseRequirementsLedger,
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

	let counts = countRequirements([]);
	for (const entry of matchingRequirementBranchNewestFirst(
		sessionManager,
		metadata => metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	)) {
		if (entry.type !== "custom") continue;
		const ledger = parseRequirementsLedger(entry.data);
		if (!ledger) continue;
		counts = countRequirements(ledger.requirements);
		break;
	}
	requirementHudCountsCache.set(sessionManager, { leafId, entryCount, counts });
	return counts;
}
