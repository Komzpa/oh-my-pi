import { expect, it } from "bun:test";
import { getRequirementHudCounts } from "../src/modes/utils/requirement-hud-counts";
import type { SessionManager } from "../src/session/session-manager";
import type { SessionEntry } from "../src/session/session-entries";
import { createRequirementCandidates, REQUIREMENTS_LEDGER_CUSTOM_TYPE } from "../src/tools/requirements-ledger";

it("reads only ledger entries, caches unchanged history, and refreshes on append", () => {
	let revision = 1;
	let reads = 0;
	const manager = {
		getLeafId: () => String(revision),
		getEntryCount: () => revision,
		getBranch: () => {
			throw new Error("unrelated historical payload must not be hydrated");
		},
		getBranchMatching: (predicate: (entry: { type: string; customType?: string }) => boolean) => {
			reads++;
			expect(predicate({ type: "message" })).toBe(false);
			expect(predicate({ type: "custom", customType: "unrelated" })).toBe(false);
			expect(predicate({ type: "custom", customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE })).toBe(true);
			return [
				{
					type: "custom",
					customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE,
					data: {
						version: 1,
						requirements: createRequirementCandidates(
							[],
							Array.from({ length: revision }, (_, i) => `ask ${i}`),
							"2026-10-15T00:00:00Z",
						),
					},
				},
			] as SessionEntry[];
		},
	} as unknown as SessionManager;
	const first = getRequirementHudCounts(manager);
	for (let i = 0; i < 50; i++) expect(getRequirementHudCounts(manager)).toEqual(first);
	expect(reads).toBe(1);
	revision++;
	expect(getRequirementHudCounts(manager)).not.toEqual(first);
	expect(reads).toBe(2);
});
