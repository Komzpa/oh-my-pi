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

it("skips malformed newest ledgers and stops before decoding superseded snapshots", () => {
	let reads = 0;
	const manager = {
		getLeafId: () => "latest",
		getEntryCount: () => 3,
		getBranch: () => {
			throw new Error("must not load full history");
		},
		*iterateBranchMatchingNewestFirst() {
			reads++;
			yield { type: "custom", customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE, data: { version: -1 } };
			reads++;
			yield {
				type: "custom",
				customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE,
				data: { version: 1, requirements: createRequirementCandidates([], ["latest ask"], "2026-10-15T00:00:00Z") },
			};
			throw new Error("superseded ledger must not be decoded");
		},
	} as unknown as SessionManager;
	const counts = getRequirementHudCounts(manager);
	expect(counts).toEqual({ total: 1, passed: 0, failed: 0, legacyUnverified: 0, open: 1 });
	expect(counts).toEqual(getRequirementHudCounts(manager));
	expect(reads).toBe(2);
});

// Worker-homed TUI sessions expose history reads through a session handle.
it("refreshes HUD counts from a session handle without selective history methods", () => {
	const entries: SessionEntry[] = [];
	const manager = {
		getLeafId: () => null,
		getEntries: () => entries,
		getBranch: () => entries,
	};
	expect(getRequirementHudCounts(manager)).toEqual({ total: 0, passed: 0, failed: 0, legacyUnverified: 0, open: 0 });
	entries.push({
		type: "custom",
		id: "ledger",
		parentId: null,
		timestamp: "2026-11-03T00:00:00Z",
		customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE,
		data: {
			version: 1,
			requirements: createRequirementCandidates([], ["handle requirement"], "2026-11-03T00:00:00Z"),
		},
	});
	expect(getRequirementHudCounts(manager)).toEqual({ total: 1, passed: 0, failed: 0, legacyUnverified: 0, open: 1 });
});

// The interactive observer listener runs on every worker frame; it must decide the
// plan display from the newest ledger entry, never by hydrating the branch
// (3.8 s of a 30 s live DC profile on a 2 GB journal, 2026-11-06).
it("observer plan probe reads only the newest ledger and never the whole branch", async () => {
	const { latestRequirementsFromSession } = await import("../src/session/requirements-branch-selection");
	let decoded = 0;
	const manager = {
		getBranch: () => {
			throw new Error("observer frame must not hydrate the branch");
		},
		*iterateBranchMatchingNewestFirst(predicate: (entry: { type: string; customType?: string }) => boolean) {
			expect(predicate({ type: "message" })).toBe(false);
			expect(predicate({ type: "custom", customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE })).toBe(true);
			decoded++;
			yield {
				type: "custom",
				customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE,
				data: { version: 1, requirements: createRequirementCandidates([], ["plan"], "2026-11-06T00:00:00Z") },
			};
			throw new Error("older ledgers must not be decoded");
		},
	} as unknown as SessionManager;
	for (let frame = 0; frame < 100; frame++) expect(latestRequirementsFromSession(manager).length).toBe(1);
	expect(decoded).toBe(100);
});

it("retains derived counts across unrelated appends and refreshes after ledger edits", () => {
	let count = 1;
	let bodyRevision = 0;
	let decoded = 0;
	let requirements = createRequirementCandidates([], ["first"], "2026-11-06T00:00:00Z");
	const selected = Object.freeze([
		{
			type: "custom",
			customType: REQUIREMENTS_LEDGER_CUSTOM_TYPE,
			get data() {
				decoded++;
				return { version: 1, requirements };
			},
		},
	]) as unknown as SessionEntry[];
	const manager = {
		getLeafId: () => String(count),
		getEntryCount: () => count,
		get bodyRevision() {
			return bodyRevision;
		},
		getEntries: () => selected,
		getBranch: () => selected,
		getCachedBranchMatching: () => selected,
	};
	expect(getRequirementHudCounts(manager).total).toBe(1);
	const firstDecoded = decoded;
	for (let i = 0; i < 100; i++) {
		count++;
		expect(getRequirementHudCounts(manager).total).toBe(1);
	}
	expect(decoded).toBe(firstDecoded);
	requirements = createRequirementCandidates([], ["first", "second"], "2026-11-06T00:00:00Z");
	bodyRevision++;
	expect(getRequirementHudCounts(manager).total).toBe(2);
	expect(decoded).toBeGreaterThan(firstDecoded);
});
