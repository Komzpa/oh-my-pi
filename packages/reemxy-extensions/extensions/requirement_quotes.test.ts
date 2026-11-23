// @ts-nocheck -- minimal durable journal fixture.
import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { prepareRequirementBrief, rowRequirementQuotes, requirementConflict, installRequirementResolution } from "./requirement_quotes";
function fixture() {
	const row = {
		content: "Edit PRD levels",
		status: "pending",
		schedule: { resources: ["doc/product-requirements.md"] },
	};
	const journal = [
		{
			type: "custom",
			customType: "requirements_ledger",
			data: {
				requirements: [
					{
						id: "R1",
						rows: [row.content],
						rawText: "solar should not block levels",
						text: "levels never refused",
					},
				],
			},
		},
	];
	const ctx = {
		sessionManager: {
			getLatestBranchMatching: predicate => journal.findLast(predicate),
			getBranchMatching: predicate => journal.filter(predicate),
			getBranch: () => journal,
		},
	};
	return { row, journal, ctx };
}
test("PRD dispatch carries original solar quote and refuses a row without its linked quote", () => {
	const h = fixture();
	const prepared = prepareRequirementBrief(h.row, h.ctx, "Edit requirements");
	expect(prepared.refusal).toBeUndefined();
	expect(prepared.task).toContain('"solar should not block levels"');
	expect(prepared.task).not.toContain("levels never refused");
	h.journal[0].data.requirements[0].rows = ["unrelated"];
	expect(prepareRequirementBrief(h.row, h.ctx, "Edit requirements").refusal).toContain(
		"no linked verbatim user quote",
	);
	expect(prepareRequirementBrief({ content: "Fix button", schedule: {} }, h.ctx, "Fix button")).toEqual({
		task: "Fix button",
	});
});
test("conflicting product contract cannot redispatch through prose; only exact quote/conflict-bound resolution releases it", async () => {
	const h = fixture();
	h.row.blocker = "BLOCKED_BY_CONFLICTING_PRODUCT_CONTRACT: 1 rack over 4 levels";
	h.row.schedule.progress = { evidence: "I chose to hide conflicts" };
	expect(prepareRequirementBrief(h.row, h.ctx, "retry").refusal).toContain("unresolved product contract conflict");
	let tool;
	installRequirementResolution({ typebox: { Type }, registerTool: value => tool = value,
		appendEntry: (customType, data) => h.journal.push({ type: "custom", customType, data }) });
	h.ctx.sessionManager.getHeader = () => ({});
	h.ctx.getTodoSnapshot = () => [{ tasks: [h.row] }];
	const params = { row: h.row.content, quoteIds: ["R1"], resolution: "Show physical infeasibility; ignore solar artefacts" };
	await expect(tool.execute("bad", { ...params, quoteIds: ["invented"] }, undefined, undefined, h.ctx)).rejects.toThrow();
	await tool.execute("resolve", params, undefined, undefined, h.ctx);
	expect(prepareRequirementBrief(h.row, h.ctx, "retry").refusal).toBeUndefined();
	h.journal.push({ type: "custom", customType: "requirement-contract-resolution", data: { row: "Another row" } });
	expect(prepareRequirementBrief(h.row, h.ctx, "retry").refusal).toBeUndefined();
	h.journal[0].data.requirements[0].rawText = "physical infeasibility MUST be a conflict";
	expect(prepareRequirementBrief(h.row, h.ctx, "retry").refusal).toContain("unresolved product contract conflict");
});

import { settleRowAuditVerdict } from "./row_audit";
test("a passing requirement audit with executable checks cannot hide widening or omit quote comparison", () => {
	const h = fixture();
	const quotes = rowRequirementQuotes(h.ctx, h.row.content);
	const verdict = {
		row: h.row.content,
		verdict: "pass",
		findings: "tests pass",
		checks: [{ command: "bun test levels", exitCode: 0 }],
		screenshots: [],
	};
	expect(settleRowAuditVerdict(verdict, () => false, quotes).verdict).toBe("inconclusive");
	verdict.requirementDiffs = [
		{
			before: "Solar is a model artefact",
			after: "Levels never refused",
			quoteIds: ["R1"],
			widening: true,
			reason: "Physical infeasibility was incorrectly hidden",
		},
	];
	expect(settleRowAuditVerdict(verdict, () => false, quotes)).toMatchObject({
		verdict: "fail",
		findings: "Physical infeasibility was incorrectly hidden",
	});
	verdict.requirementDiffs[0] = {
		before: "Solar blocks levels",
		after: "Solar does not block levels",
		quoteIds: ["R1"],
		widening: false,
		reason: "Solar-only restriction removed",
	};
	expect(settleRowAuditVerdict(verdict, () => false, quotes).verdict).toBe("pass");
});
