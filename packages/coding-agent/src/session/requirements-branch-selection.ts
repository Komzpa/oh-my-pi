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
