import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import {
	isFreshRequirementVerdict,
	parseRequirementReceipt,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";

const AT = "2026-09-28T12:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("requirements receipt parsing", () => {
	it("splits cells only on unescaped pipes and unescapes the cell text", () => {
		const table = [
			"| id | raw words | verdict | evidence | artifact identity |",
			"| --- | --- | --- | --- | --- |",
			`| R1 | compare a \\| b to c | pass | ran x \\| y; saw y | Build artifact @ ${SHA_A} |`,
		].join("\n");
		const rows = parseRequirementReceipt(table, ["R1"]);
		expect(rows).not.toBeNull();
		expect(rows![0]).toMatchObject({
			id: "R1",
			rawWords: "compare a | b to c",
			status: "pass",
			evidence: "ran x | y; saw y",
			artifact: `Build artifact @ ${SHA_A}`,
		});
	});

	it("rejects a receipt without a raw-words column", () => {
		const table = [
			"| id | verdict | evidence | artifact identity |",
			"| --- | --- | --- | --- |",
			`| R1 | pass | saw it | Build artifact @ ${SHA_A} |`,
		].join("\n");
		expect(parseRequirementReceipt(table, ["R1"])).toBeNull();
	});

	it("rejects a receipt with duplicate raw-words columns", () => {
		const table = [
			"| id | raw words | verdict | evidence | raw words | artifact identity |",
			"| --- | --- | --- | --- | --- | --- |",
			`| R1 | build the thing | pass | saw it | build the thing | Build artifact @ ${SHA_A} |`,
		].join("\n");
		expect(parseRequirementReceipt(table, ["R1"])).toBeNull();
	});

	it("rejects a receipt whose raw-words cell is empty", () => {
		const table = [
			"| id | raw words | verdict | evidence | artifact identity |",
			"| --- | --- | --- | --- | --- |",
			`| R1 |  | pass | saw it | Build artifact @ ${SHA_A} |`,
		].join("\n");
		expect(parseRequirementReceipt(table, ["R1"])).toBeNull();
	});

	it("accepts a complete table that marks unreached ids unverifiable", () => {
		const table = [
			"| id | raw words | verdict | evidence | artifact identity |",
			"| --- | --- | --- | --- | --- |",
			`| R1 | build the thing | pass | opened the app | Build artifact @ ${SHA_A} |`,
			`| R2 | fix the crash | unverifiable | not reached | Review artifact @ ${SHA_B} |`,
		].join("\n");
		const rows = parseRequirementReceipt(table, ["R1", "R2"]);
		expect(rows?.map(row => [row.id, row.status, row.evidence])).toEqual([
			["R1", "pass", "opened the app"],
			["R2", "unverifiable", "not reached"],
		]);
	});
});

describe("persisted verdict freshness", () => {
	const artifact = (words: string, identity: string): RequirementLedgerItem => ({
		id: "R1",
		at: AT,
		rawText: "build   the thing",
		classification: "linked",
		rows: ["Build artifact"],
		verdict: {
			status: "pass",
			evidence: "qa evidence",
			artifact: identity,
			workerId: "qa-1",
			auditor: "qa-auditor",
			rawWords: words,
		},
	});

	it("keeps a pass fresh only when the raw-words echo matches the immutable ask", () => {
		const artifacts = [{ row: "Build artifact", head: SHA_A, dirty: false }];
		expect(isFreshRequirementVerdict(artifact("build the thing", `Build artifact @ ${SHA_A}`), artifacts)).toBe(true);
		expect(
			isFreshRequirementVerdict(artifact("ship the thing instead", `Build artifact @ ${SHA_A}`), artifacts),
		).toBe(false);
	});

	it("invalidates a pass when two linked rows swap commits", () => {
		const requirement: RequirementLedgerItem = {
			id: "R1",
			at: AT,
			rawText: "build and review the thing",
			classification: "linked",
			rows: ["Build artifact", "Review artifact"],
			verdict: {
				status: "pass",
				evidence: "qa evidence",
				artifact: `Build artifact @ ${SHA_A}; Review artifact @ ${SHA_B}`,
				workerId: "qa-1",
				auditor: "qa-auditor",
			},
		};
		expect(
			isFreshRequirementVerdict(requirement, [
				{ row: "Build artifact", head: SHA_A, dirty: false },
				{ row: "Review artifact", head: SHA_B, dirty: false },
			]),
		).toBe(true);
		expect(
			isFreshRequirementVerdict(requirement, [
				{ row: "Build artifact", head: SHA_B, dirty: false },
				{ row: "Review artifact", head: SHA_A, dirty: false },
			]),
		).toBe(false);
	});

	it("invalidates a multi-row pass that does not name one audited commit per linked row", () => {
		const requirement: RequirementLedgerItem = {
			id: "R1",
			at: AT,
			rawText: "build and review the thing",
			classification: "linked",
			rows: ["Build artifact", "Review artifact"],
			verdict: {
				status: "pass",
				evidence: "qa evidence",
				artifact: `Build artifact @ ${SHA_A}; Review artifact @ ${SHA_A}`,
				workerId: "qa-1",
				auditor: "qa-auditor",
			},
		};
		expect(
			isFreshRequirementVerdict(requirement, [
				{ row: "Build artifact", head: SHA_A, dirty: false },
				{ row: "Review artifact", head: SHA_B, dirty: false },
			]),
		).toBe(false);
	});
});

describe("qa-auditor prompt contract", () => {
	it("requires the complete table with unreached ids marked not reached", () => {
		const prompt = readFileSync(new URL("../src/prompts/agents/qa-auditor.md", import.meta.url), "utf8");
		expect(prompt).toContain("the table below is still complete");
		expect(prompt).toContain("not reached");
		expect(prompt).toContain("character for character");
	});
});
