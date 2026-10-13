import { describe, expect, it } from "bun:test";
import {
	parseRequirementReceipt,
	type RequirementVerdictStatus,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";

const ARTIFACT = "a".repeat(40);
const HEADER = "| id | raw words | verdict | evidence | claimed | measured | artifact identity |";
const SEPARATOR = "| --- | --- | --- | --- | --- | --- | --- |";

function markdownReceipt(claimed: string, measured: string, verdict = "pass", evidence = "recounted the rows"): string {
	return [
		HEADER,
		SEPARATOR,
		`| R1 | audit artifact | ${verdict} | ${evidence} | ${claimed} | ${measured} | ${ARTIFACT} |`,
	].join("\n");
}

function jsonReceipt(claimed: string, measured: string, verdict = "pass", evidence = "recounted the rows"): string {
	return JSON.stringify([
		{
			id: "R1",
			raw_words: "audit artifact",
			verdict,
			evidence,
			artifact_identity: ARTIFACT,
			claimed,
			measured,
		},
	]);
}

function statuses(
	claimed: string,
	measured: string,
	verdict = "pass",
): [RequirementVerdictStatus | undefined, RequirementVerdictStatus | undefined] {
	const markdown = parseRequirementReceipt(markdownReceipt(claimed, measured, verdict), ["R1"]);
	const json = parseRequirementReceipt(jsonReceipt(claimed, measured, verdict), ["R1"]);
	return [markdown?.[0]?.status, json?.[0]?.status];
}

describe("numeric claimed/measured bounds", () => {
	it("keeps the auditor pass when a satisfied bound's figures differ", () => {
		expect(statuses(">=4 complete cards", "5")).toEqual(["pass", "pass"]);
		expect(statuses(">=4", "5")).toEqual(["pass", "pass"]);
	});

	it("records a genuine numeric miss as fail with numeric-miss evidence", () => {
		expect(statuses("≥4", "3")).toEqual(["fail", "fail"]);
		const markdown = parseRequirementReceipt(markdownReceipt("≥4", "3"), ["R1"]);
		expect(markdown?.[0]?.status).toBe("fail");
		expect(markdown?.[0]?.evidence.startsWith("claimed ≥4 ≠ measured 3: ")).toBe(true);
	});

	it("keeps plain numeric equality on the digit path", () => {
		expect(statuses("5", "5")).toEqual(["pass", "pass"]);
		expect(statuses("5", "4")).toEqual(["fail", "fail"]);
	});

	it("compares every bound form numerically at strict and inclusive boundaries", () => {
		const cases: Array<[string, string, RequirementVerdictStatus]> = [
			[">=4", "4", "pass"],
			[">=4", "5", "pass"],
			[">=4", "3", "fail"],
			[">4", "5", "pass"],
			[">4", "4", "fail"],
			["<=4", "4", "pass"],
			["<=4", "3", "pass"],
			["<=4", "5", "fail"],
			["<4", "3", "pass"],
			["<4", "4", "fail"],
			["≥4", "4", "pass"],
			["≥4", "5", "pass"],
			["≥4", "3", "fail"],
			["≤4", "4", "pass"],
			["≤4", "3", "pass"],
			["≤4", "5", "fail"],
			["at least 4", "4", "pass"],
			["at least 4", "5", "pass"],
			["at least 4", "3", "fail"],
			["at most 4", "4", "pass"],
			["at most 4", "3", "pass"],
			["at most 4", "5", "fail"],
		];
		for (const [claimed, measured, expected] of cases) {
			expect(statuses(claimed, measured), `${claimed} vs ${measured}`).toEqual([expected, expected]);
		}
	});

	it("compares bounded figures with their stated units and lets a bare measured figure inherit the claimed unit", () => {
		expect(statuses(">=4 complete cards", "5 complete cards")).toEqual(["pass", "pass"]);
		expect(statuses(">=4 complete cards", "4 complete cards")).toEqual(["pass", "pass"]);
		expect(statuses(">=4 complete cards", "3 complete cards")).toEqual(["fail", "fail"]);
		expect(statuses(">4 complete cards", "4 complete cards")).toEqual(["fail", "fail"]);
		expect(statuses("<=4 complete cards", "4 complete cards")).toEqual(["pass", "pass"]);
		expect(statuses("<4 complete cards", "4 complete cards")).toEqual(["fail", "fail"]);
		expect(statuses(">=4 complete cards", "5")).toEqual(["pass", "pass"]);
		expect(statuses(">=4 complete cards", "3")).toEqual(["fail", "fail"]);
	});

	it("preserves the grouped multi-metric entries/bytes consumer", () => {
		expect(statuses("3,149 entries / 163,804,637 B", "3,225 entries / 171,168,243 B")).toEqual(["fail", "fail"]);
		expect(statuses("3,149 entries / 163,804,637 B", "3149 entries, 163804637 bytes")).toEqual(["pass", "pass"]);
	});

	it("never upgrades fail or unverifiable verdicts", () => {
		expect(statuses(">=4", "5", "fail")).toEqual(["fail", "fail"]);
		expect(statuses(">=4", "5", "unverifiable")).toEqual(["unverifiable", "unverifiable"]);
		expect(statuses(">=4", "3", "fail")).toEqual(["fail", "fail"]);
	});
});
