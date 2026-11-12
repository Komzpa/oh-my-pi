import { describe, expect, it } from "bun:test";

import {
	evaluateRequirementDoneGate,
	invalidateStaleRequirementVerdicts,
	type RequirementLedgerItem,
	type RequirementVerdict,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";

const AT = "2026-10-01T00:00:00.000Z";
const DONE_ROW = "Create the branch";
const OTHER_ROW = "Write the report";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function pass(row: string): RequirementVerdict {
	return {
		status: "pass",
		evidence: "exercised",
		rawWords: "start a branch",
		artifact: `${row} @ ${SHA_A}`,
		workerId: "qa-1",
		auditor: "qa-auditor",
		receivedAt: AT,
	};
}

function requirement(): RequirementLedgerItem {
	return {
		id: "R1",
		at: AT,
		rawText: "start a branch",
		classification: "linked",
		rows: [DONE_ROW, OTHER_ROW],
		rowVerdicts: { [DONE_ROW]: pass(DONE_ROW), [OTHER_ROW]: pass(OTHER_ROW) },
	};
}

// The checkout HEAD has moved from A to B since the passes were recorded.
const movedHead = async () => ({ cwd: "/tmp", head: SHA_B, dirty: false });

describe("completed passing receipts are final", () => {
	it("keeps a completed pass without probing a moved artifact", async () => {
		const requirements = [requirement()];
		const sweep = await evaluateRequirementDoneGate(
			requirements,
			[DONE_ROW],
			async () => {
				throw new Error("completed passes must not probe artifacts");
			},
			new Map(),
			new Set([DONE_ROW]),
		);
		expect(sweep).toHaveLength(0);
		expect(invalidateStaleRequirementVerdicts(requirements, sweep)[0]!.rowVerdicts![DONE_ROW]!.status).toBe("pass");
	});

	it("recovers historical stale demotions but retains real unverifiable verdicts", async () => {
		const demoted = requirement();
		demoted.rowVerdicts = {
			[DONE_ROW]: {
				...pass(DONE_ROW),
				status: "unverifiable",
				evidence: "Previously passing receipt is stale; request a fresh audit.",
			},
		};
		const sweep = await evaluateRequirementDoneGate([demoted], [DONE_ROW], movedHead, new Map(), new Set([DONE_ROW]));
		expect(sweep).toHaveLength(0);
		// a real unverifiable verdict (other evidence) is still reported
		demoted.rowVerdicts[DONE_ROW] = { ...demoted.rowVerdicts[DONE_ROW]!, evidence: "Could not reproduce the screen" };
		const still = await evaluateRequirementDoneGate([demoted], [DONE_ROW], movedHead, new Map(), new Set([DONE_ROW]));
		expect(still.map(item => item.requirement.id)).toEqual(["R1"]);
	});

	it("closing a different row does not touch the completed row", async () => {
		const requirements = [requirement()];
		const open = await evaluateRequirementDoneGate(requirements, [OTHER_ROW], movedHead);
		expect(open).toHaveLength(1);
		expect(open[0]!.stalePassRows).toEqual([OTHER_ROW]);
		const next = invalidateStaleRequirementVerdicts(requirements, open)[0]!;
		expect(next.rowVerdicts![DONE_ROW]!.status).toBe("pass");
		expect(next.rowVerdicts![OTHER_ROW]!.status).toBe("unverifiable");
	});

	it("negative control: an open or reopened row still demands a fresh audit", async () => {
		const open = await evaluateRequirementDoneGate([requirement()], [DONE_ROW], movedHead);
		expect(open).toHaveLength(1);
		expect(open[0]!.stalePassRows).toEqual([DONE_ROW]);
	});

	it("a settled row whose audited source changed is still evaluated", async () => {
		const edited = { ...requirement(), rawText: "start a different branch" };
		const open = await evaluateRequirementDoneGate([edited], [DONE_ROW], movedHead, new Map(), new Set([DONE_ROW]));
		expect(open).toHaveLength(1);
	});

	it("a failed verdict on a settled row is preserved and still reported", async () => {
		const failed = requirement();
		failed.rowVerdicts![DONE_ROW] = { ...pass(DONE_ROW), status: "fail" };
		const open = await evaluateRequirementDoneGate([failed], [DONE_ROW], movedHead, new Map(), new Set([DONE_ROW]));
		expect(open).toHaveLength(1);
		expect(invalidateStaleRequirementVerdicts([failed], open)[0]!.rowVerdicts![DONE_ROW]!.status).toBe("fail");
	});
});
