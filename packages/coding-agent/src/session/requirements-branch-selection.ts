import {
	parseRequirementsLedger,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	type RequirementLedgerItem,
} from "../tools/requirements-ledger";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

export type RequirementEntryMetadata = {
	type: SessionEntry["type"];
	customType?: string;
	messageRole?: string;
	toolName?: string;
};
export function matchingRequirementBranch(
	manager: Pick<SessionManager, "getBranch">,
	predicate: (entry: RequirementEntryMetadata) => boolean,
): SessionEntry[] {
	const selective = manager as Pick<SessionManager, "getBranch"> & {
		getBranchMatching?: (predicate: (entry: RequirementEntryMetadata) => boolean) => SessionEntry[];
	};
	if (selective.getBranchMatching) return selective.getBranchMatching(predicate);
	return manager.getBranch().filter(entry =>
		predicate({
			type: entry.type,
			customType: entry.type === "custom" ? entry.customType : undefined,
			messageRole: entry.type === "message" ? entry.message.role : undefined,
			toolName: entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolName : undefined,
		}),
	);
}

/** Stop decoding once the caller has found its newest valid snapshot. */
export function* matchingRequirementBranchNewestFirst(
	manager: Pick<SessionManager, "getBranch">,
	predicate: (entry: RequirementEntryMetadata) => boolean,
): IterableIterator<SessionEntry> {
	const selective = manager as Pick<SessionManager, "getBranch"> & {
		iterateBranchMatchingNewestFirst?: (
			predicate: (entry: RequirementEntryMetadata) => boolean,
		) => Iterable<SessionEntry>;
	};
	if (selective.iterateBranchMatchingNewestFirst) {
		yield* selective.iterateBranchMatchingNewestFirst(predicate);
		return;
	}
	const entries = matchingRequirementBranch(manager, predicate);
	for (let index = entries.length - 1; index >= 0; index--) yield entries[index]!;
}

/** Read the newest valid ledger without hydrating superseded snapshots. */
export function latestRequirementsFromSession(manager: Pick<SessionManager, "getBranch">): RequirementLedgerItem[] {
	for (const entry of matchingRequirementBranchNewestFirst(
		manager,
		metadata => metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	)) {
		if (entry.type !== "custom") continue;
		const ledger = parseRequirementsLedger(entry.data);
		if (ledger) return ledger.requirements;
	}
	return [];
}
