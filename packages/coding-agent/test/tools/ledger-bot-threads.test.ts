import { describe, expect, it } from "bun:test";
import * as ledger from "../../src/tools/requirements-ledger";
import type { RequirementLedgerItem } from "../../src/tools/requirements-ledger";
const {
	classifyRequirement,
	countRequirements,
	invalidateStaleRequirementVerdicts,
	requirementAuditSnapshot,
	requirementSourceSnapshot,
	evaluateRequirementDoneGate,
	formatDoneGateRefusal,
	getRequirementVerdictSourceIssue,
	getRequirementVerdictStaleness,
	parseRequirementReceipt,
} = ledger;

const SHA = "b".repeat(40);
const AT = "2026-10-25T05:00:00.000Z";
function linked(): RequirementLedgerItem {
	return {
		id: "R1",
		at: AT,
		rawText: "Run\twith  literal spacing",
		classification: "linked",
		rows: ["A"],
		rowVerdicts: {
			A: {
				status: "pass",
				rawWords: "Run\twith  literal spacing",
				evidence: "examined",
				artifact: SHA,
				workerId: "qa",
				auditor: "qa-auditor",
				receivedAt: AT,
				rowChangeId: "before",
			},
		},
	};
}

describe("bot review receipt and completion regressions", () => {
	it("rejects a changed raw-words echo including literal whitespace", () => {
		const r = linked();
		r.rowVerdicts!.A!.rawWords = "Run with literal spacing";
		expect(getRequirementVerdictSourceIssue(r, "A", r.rowVerdicts!.A!)).not.toBeNull();
		r.rowVerdicts!.A!.rawWords = r.rawText;
		expect(getRequirementVerdictSourceIssue(r, "A", r.rowVerdicts!.A!)).toBeNull();
	});
	it("rejects a persisted pass missing its authenticated source words", () => {
		const r = linked();
		delete r.rowVerdicts!.A!.rawWords;
		expect(getRequirementVerdictSourceIssue(r, "A", r.rowVerdicts!.A!)).not.toBeNull();
		expect(countRequirements([r]).passed).toBe(0);
	});
	it("keeps audit identity stable when image bytes move into session storage", () => {
		const r = linked();
		r.images = [{ index: 1, sha256: "c".repeat(64), mimeType: "image/png", data: "inline" }];
		const before = requirementAuditSnapshot([r], [r.id]);
		r.images[0] = { ...r.images[0]!, data: undefined, artifactPath: "/session/image.png" };
		expect(requirementAuditSnapshot([r], [r.id])).toBe(before);
		r.images[0]!.sha256 = "d".repeat(64);
		expect(requirementAuditSnapshot([r], [r.id])).not.toBe(before);
	});
	it("preserves a row receipt when only a sibling link changes", async () => {
		const r = linked();
		r.rowVerdicts!.A!.sourceSnapshot = requirementSourceSnapshot([r], r.id);
		r.rows.push("B");
		expect(
			await evaluateRequirementDoneGate([r], ["A"], async () => ({ cwd: "/tmp", head: SHA, dirty: false })),
		).toEqual([]);
		r.rawText += " changed";
		expect(
			await evaluateRequirementDoneGate([r], ["A"], async () => ({ cwd: "/tmp", head: SHA, dirty: false })),
		).toHaveLength(1);
	});
	it("invalidates rejected passes so the HUD no longer reports completion", async () => {
		const r = linked();
		const open = await evaluateRequirementDoneGate([r], ["A"], async () => ({
			cwd: "/tmp",
			head: "d".repeat(40),
			dirty: false,
		}));
		const next = invalidateStaleRequirementVerdicts([r], open);
		expect(countRequirements(next)).toEqual({ total: 1, passed: 0, failed: 0, open: 1 });
		expect(countRequirements([r]).passed).toBe(1);
	});
	it("requires dirty receipt HEAD and content fingerprint before row history", () => {
		const r = linked();
		const fingerprint = "c".repeat(64);
		r.rowVerdicts!.A!.artifact = `${SHA}, dirty-fingerprint=${fingerprint}`;
		const current = {
			row: "A",
			cwd: "/tmp/fixture",
			head: SHA,
			dirty: true,
			dirtyFingerprint: fingerprint,
			lastChange: { at: AT, id: "before" },
		};
		expect(getRequirementVerdictStaleness(r, [current])).toBeNull();
		expect(getRequirementVerdictStaleness(r, [{ ...current, dirtyFingerprint: "d".repeat(64) }])).not.toBeNull();
		expect(getRequirementVerdictStaleness(r, [{ ...current, head: "e".repeat(40) }])).not.toBeNull();
	});
	it("does not block a neighboring row for an unrelated missing image", async () => {
		const r = linked();
		r.imageState = "needs-user-restatement";
		expect(
			await evaluateRequirementDoneGate([r], ["B"], async () => ({ cwd: "/tmp", head: SHA, dirty: false })),
		).toEqual([]);
		expect(
			await evaluateRequirementDoneGate([r], ["A"], async () => ({ cwd: "/tmp", head: SHA, dirty: false })),
		).toHaveLength(1);
	});
	it("requires receipt entry ordering when a user check shares a millisecond", async () => {
		const r = linked();
		const probe = async () => ({
			cwd: "/tmp",
			head: SHA,
			dirty: false,
			lastChange: { at: AT, id: "after" },
			awaitingUser: { action: "Inspect the delivered artifact" },
		});
		const open = await evaluateRequirementDoneGate([r], ["A"], probe);
		expect(open[0]!.awaitingUserIssues).toHaveLength(1);
		r.rowVerdicts!.A!.rowChangeId = "after";
		expect(await evaluateRequirementDoneGate([r], ["A"], probe)).toEqual([]);
	});
	it("puts structured requirement IDs in advertised retry arguments", async () => {
		const r = linked();
		delete r.rowVerdicts;
		const open = await evaluateRequirementDoneGate([r], ["A"], async () => ({
			cwd: "/tmp",
			head: SHA,
			dirty: false,
		}));
		expect(formatDoneGateRefusal(open)).toContain('requirementIds=["R1"]');
	});
	it("keeps a valid sibling when another receipt row contains an extra cell", () => {
		const receipt = `| id | raw words | status | evidence | artifact |\n| --- | --- | --- | --- | --- |\n| R1 | first ask | pass | verified | ${SHA} |\n| R2 | second ask | pass | malformed | ${SHA} | extra |`;
		expect(parseRequirementReceipt(receipt, ["R1"])).toEqual([
			{ id: "R1", rawWords: "first ask", status: "pass", evidence: "verified", artifact: SHA },
		]);
	});
	it("records inherited cancellation authority and refuses its reuse", () => {
		const r = linked();
		const cancel: RequirementLedgerItem = {
			id: "R2",
			at: "2026-10-25T05:01:00.000Z",
			rawText: "Cancel previous work",
			classification: "not-a-requirement",
			rows: [],
			reason: "Owner cancelled",
		};
		const first = classifyRequirement([r, cancel], "R1", "merged", {
			mergeInto: "R2",
			supersededBy: "R2",
			reason: "Owner cancellation",
		});
		expect("requirements" in first).toBe(true);
		if (!("requirements" in first)) return;
		expect(first.requirements[0]!.amendments?.[0]?.newClassification).toBe("not-a-requirement");
		expect(
			classifyRequirement(first.requirements, "R1", "linked", { rows: ["A"], supersededBy: "R2", reason: "Reuse" }),
		).toHaveProperty("error");
	});
});
