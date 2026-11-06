import { createHash } from "node:crypto";

import { describe, expect, it } from "bun:test";

import {
	evaluateRequirementDoneGate,
	formatRequirementGateNotice,
	getRequirementVerdictStaleness,
	type RequirementGateArtifact,
	type RequirementLedgerItem,
	type RequirementVerdict,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";

const AT = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-02T00:00:00.000Z";
const ROW = "Build artifact";
const SHA_A = "a".repeat(40);
const FILE_SHA = createHash("sha256").update("external file bytes").digest("hex");
const ROW_JSON = JSON.stringify(ROW);
type Artifact = { row: string } & RequirementGateArtifact;

function linkedRequirement(overrides: Partial<RequirementLedgerItem> = {}): RequirementLedgerItem {
	return {
		id: "R1",
		at: AT,
		rawText: "build the thing",
		classification: "linked",
		rows: [ROW],
		...overrides,
	};
}

function passVerdict(artifact: string, overrides: Partial<RequirementVerdict> = {}): RequirementVerdict {
	return {
		status: "pass",
		evidence: "exercised the build",
		rawWords: "build the thing",
		artifact,
		workerId: "qa-1",
		auditor: "qa-auditor",
		receivedAt: AT,
		...overrides,
	};
}

describe("getRequirementVerdictStaleness missing baseline cases", () => {
	it("reports a non-linked requirement", () => {
		const requirement = linkedRequirement({ classification: "candidate", rows: [] });
		expect(getRequirementVerdictStaleness(requirement, [])).toBe("requirement R1 is not linked");
	});

	it("reports missing row artifacts", () => {
		expect(getRequirementVerdictStaleness(linkedRequirement(), [])).toBe(
			"requirement R1 has no row artifacts to check",
		);
	});

	it("reports a row that is not linked to the requirement", () => {
		const requirement = linkedRequirement({ rowVerdicts: { [ROW]: passVerdict(`row @ ${SHA_A}`) } });
		expect(getRequirementVerdictStaleness(requirement, [{ row: "Other row", head: SHA_A, dirty: false }])).toBe(
			'row "Other row" is not linked to requirement R1',
		);
	});

	it("reports a duplicated row artifact", () => {
		const requirement = linkedRequirement({ rowVerdicts: { [ROW]: passVerdict(`${ROW} @ ${SHA_A}`) } });
		const artifact: Artifact = { row: ROW, head: SHA_A, dirty: false };
		expect(getRequirementVerdictStaleness(requirement, [artifact, { ...artifact }])).toBe(
			`duplicate artifact for row ${ROW_JSON}`,
		);
	});

	it("reports a missing verdict", () => {
		expect(getRequirementVerdictStaleness(linkedRequirement(), [{ row: ROW, head: SHA_A, dirty: false }])).toBe(
			`requirement R1 has no verdict for row ${ROW_JSON}`,
		);
	});

	it("reports a non-pass verdict", () => {
		for (const status of ["fail", "unverifiable"] as const) {
			const requirement = linkedRequirement({
				rowVerdicts: { [ROW]: passVerdict(`${ROW} @ ${SHA_A}`, { status }) },
			});
			expect(getRequirementVerdictStaleness(requirement, [{ row: ROW, head: SHA_A, dirty: false }])).toBe(
				`requirement R1 verdict for row ${ROW_JSON} is ${status}, not pass`,
			);
		}
	});

	it("reports a verdict with an empty worker id", () => {
		const requirement = linkedRequirement({
			rowVerdicts: { [ROW]: passVerdict(`${ROW} @ ${SHA_A}`, { workerId: "   " }) },
		});
		expect(getRequirementVerdictStaleness(requirement, [{ row: ROW, head: SHA_A, dirty: false }])).toBe(
			`no authenticated qa-auditor identity for row ${ROW_JSON}`,
		);
	});

	it("reports raw words with Rn, lengths, and the zero-based first differing char", () => {
		const requirement = linkedRequirement({
			rowVerdicts: { [ROW]: passVerdict(`${ROW} @ ${SHA_A}`, { rawWords: "build a thing" }) },
		});
		expect(getRequirementVerdictStaleness(requirement, [{ row: ROW, head: SHA_A, dirty: false }])).toBe(
			`R1 raw words differ for row ${ROW_JSON} at char 6 (source 15 chars vs receipt 13 chars)`,
		);
	});

	it("reports literal raw words without collapsing source spaces", () => {
		const requirement = linkedRequirement({
			rawText: "build  the   thing",
			rowVerdicts: { [ROW]: passVerdict(`${ROW} @ ${SHA_A}`, { rawWords: "build the" }) },
		});
		expect(getRequirementVerdictStaleness(requirement, [{ row: ROW, head: SHA_A, dirty: false }])).toBe(
			`R1 raw words differ for row ${ROW_JSON} at char 6 (source 18 chars vs receipt 9 chars)`,
		);
	});

	it("surfaces the image-prefix user repro as raw words, never SHA, when the file SHA matches", async () => {
		const requirement = linkedRequirement({
			rawText: "[Image #1, 1568x1233] import the mailbox",
			rowVerdicts: {
				[ROW]: passVerdict(`${ROW} @ installed omp sha256 ${FILE_SHA}`, { rawWords: "import the mailbox" }),
			},
		});
		const open = await evaluateRequirementDoneGate([requirement], [ROW], async () => ({
			cwd: "/tmp/mailbox",
			head: null,
			dirty: false,
			sha256: FILE_SHA,
		}));
		expect(open).toHaveLength(1);
		expect(open[0]!.issues).toHaveLength(1);
		const reason = open[0]!.issues[0]!;
		expect(reason).toContain(
			`R1 raw words differ for row ${ROW_JSON} at char 0 (source 40 chars vs receipt 18 chars)`,
		);
		expect(reason).not.toContain("sha256 mismatch");
		expect(reason).not.toContain(requirement.rawText);
		expect(reason).not.toContain("import the mailbox");
		const matching = {
			...requirement,
			rowVerdicts: { [ROW]: { ...requirement.rowVerdicts![ROW]!, rawWords: requirement.rawText } },
		};
		expect(
			await evaluateRequirementDoneGate([matching], [ROW], async () => ({
				head: null,
				dirty: false,
				sha256: FILE_SHA,
			})),
		).toEqual([]);
	});

	it("reports a file SHA mismatch with receipt and file values", () => {
		const requirement = linkedRequirement({
			rowVerdicts: { [ROW]: passVerdict(`${ROW} @ installed omp sha256 ${FILE_SHA}`) },
		});
		const otherSha = createHash("sha256").update("other bytes").digest("hex");
		expect(
			getRequirementVerdictStaleness(requirement, [{ row: ROW, head: null, dirty: false, sha256: otherSha }]),
		).toBe(`sha256 mismatch for row ${ROW_JSON}: receipt ${FILE_SHA} vs file ${otherSha}`);
	});

	it("reports ambiguous file SHA cardinality without deduplicating repeated hashes", () => {
		for (const [artifact, count] of [
			["manual check with no hash", 0],
			[`${FILE_SHA} ${FILE_SHA}`, 2],
		] as const) {
			const requirement = linkedRequirement({ rowVerdicts: { [ROW]: passVerdict(artifact) } });
			expect(
				getRequirementVerdictStaleness(requirement, [{ row: ROW, head: null, dirty: false, sha256: FILE_SHA }]),
			).toBe(`ambiguous file SHA in verdict artifact for row ${ROW_JSON}: found ${count}`);
		}
	});

	it("reports a dirty file artifact even when the SHA matches", () => {
		const requirement = linkedRequirement({
			rowVerdicts: { [ROW]: passVerdict(`${ROW} @ installed omp sha256 ${FILE_SHA}`) },
		});
		expect(
			getRequirementVerdictStaleness(requirement, [{ row: ROW, head: null, dirty: true, sha256: FILE_SHA }]),
		).toBe(`dirty file artifact for row ${ROW_JSON}`);
	});

	it("reports an invalid HEAD", () => {
		const requirement = linkedRequirement({ rowVerdicts: { [ROW]: passVerdict(`${ROW} @ ${SHA_A}`) } });
		expect(getRequirementVerdictStaleness(requirement, [{ row: ROW, head: "main", dirty: false }])).toBe(
			`invalid HEAD "main" for row ${ROW_JSON}`,
		);
	});

	it("preserves saved-row-history freshness and reasons for resolved dirty and headless rows", () => {
		const requirement = linkedRequirement({
			rowVerdicts: { [ROW]: passVerdict("saved row check", { receivedAt: LATER, rowChangeId: "change" }) },
		});
		for (const current of [
			{ row: ROW, head: SHA_A, dirty: true },
			{ row: ROW, head: null, dirty: false },
		]) {
			expect(getRequirementVerdictStaleness(requirement, [current])).toBe(
				`no saved TODO change for row ${ROW_JSON}`,
			);
			expect(
				getRequirementVerdictStaleness(requirement, [{ ...current, lastChange: { at: AT, id: "other" } }]),
			).toBe(`verdict for row ${ROW_JSON} does not cite the saved TODO change`);
			expect(
				getRequirementVerdictStaleness(requirement, [
					{ ...current, lastChange: { at: "2026-10-03T00:00:00.000Z", id: "change" } },
				]),
			).toBe(`verdict for row ${ROW_JSON} predates the saved TODO change`);
			expect(
				getRequirementVerdictStaleness(requirement, [
					{ ...current, lastChange: { at: "invalid timestamp", id: "change" } },
				]),
			).toBe(`invalid saved TODO change timestamp for row ${ROW_JSON}`);
			expect(
				getRequirementVerdictStaleness(requirement, [{ ...current, lastChange: { at: LATER, id: "change" } }]),
			).toBeNull();
			const noReceiveTime = {
				...requirement,
				rowVerdicts: { [ROW]: { ...requirement.rowVerdicts![ROW]!, receivedAt: undefined } },
			};
			expect(
				getRequirementVerdictStaleness(noReceiveTime, [{ ...current, lastChange: { at: AT, id: "change" } }]),
			).toBe(`missing receipt timestamp for row ${ROW_JSON}`);
			const invalidReceiveTime = {
				...requirement,
				rowVerdicts: { [ROW]: { ...requirement.rowVerdicts![ROW]!, receivedAt: "invalid timestamp" } },
			};
			expect(
				getRequirementVerdictStaleness(invalidReceiveTime, [{ ...current, lastChange: { at: AT, id: "change" } }]),
			).toBe(`invalid receipt timestamp for row ${ROW_JSON}`);
		}
	});
});

describe("completion diagnosis reaches the model notice", () => {
	const gateArtifact: RequirementGateArtifact = { cwd: "/tmp/build", head: SHA_A, dirty: false };
	const cases: Array<{ name: string; verdict?: RequirementVerdict; reason: string; evidence?: string }> = [
		{ name: "missing verdict", reason: `requirement R1 has no verdict for row ${ROW_JSON}` },
		{
			name: "failing verdict",
			verdict: passVerdict(`${ROW} @ ${SHA_A}`, { status: "fail", evidence: "build exited 1" }),
			reason: `requirement R1 verdict for row ${ROW_JSON} is fail, not pass`,
			evidence: "build exited 1",
		},
		{
			name: "unverifiable verdict",
			verdict: passVerdict(`${ROW} @ ${SHA_A}`, { status: "unverifiable", evidence: "no browser" }),
			reason: `requirement R1 verdict for row ${ROW_JSON} is unverifiable, not pass`,
			evidence: "no browser",
		},
		{
			name: "unauthenticated verdict",
			verdict: passVerdict(`${ROW} @ ${SHA_A}`, { workerId: " " }),
			reason: `no authenticated qa-auditor identity for row ${ROW_JSON}`,
		},
	];
	for (const { name, verdict, reason, evidence } of cases) {
		it(`keeps the exact ${name} cause on the gate and the model notice`, async () => {
			const requirement = linkedRequirement(verdict ? { rowVerdicts: { [ROW]: verdict } } : {});
			const open = await evaluateRequirementDoneGate([requirement], [ROW], async () => gateArtifact);
			expect(open).toHaveLength(1);
			expect(open[0]!.awaitingUserIssues).toEqual([]);
			const [issue] = open[0]!.issues;
			expect(issue).toContain(reason);
			if (evidence) expect(issue).toContain(evidence);
			const notice = formatRequirementGateNotice(open);
			expect(notice).toContain(reason);
		});
	}
});
