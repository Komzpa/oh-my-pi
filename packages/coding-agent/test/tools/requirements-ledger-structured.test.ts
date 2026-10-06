import { describe, expect, it } from "bun:test";
import {
	parseRequirementReceipt,
	type RequirementVerdictStatus,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import fixture from "../fixtures/qa-auditor-structured-verdict.json";

const ids = ["R7", "R8", "R9", "R10"];

describe("structured qa-auditor requirement receipts", () => {
	it("accepts the complete real AuditPhysicsOnD7be7018-2 receipt without changing its words", () => {
		expect(parseRequirementReceipt(JSON.stringify(fixture), ids)).toEqual(
			fixture.requirements.map(row => ({
				id: row.id,
				rawWords: row.raw_words,
				status: row.verdict as RequirementVerdictStatus,
				evidence: row.evidence,
				artifact: row.artifact_identity,
			})),
		);
	});

	it("rejects the real fixture with a required row removed or evidence emptied", () => {
		expect(
			parseRequirementReceipt(JSON.stringify({ ...fixture, requirements: fixture.requirements.slice(1) }), ids),
		).toBeNull();
		expect(
			parseRequirementReceipt(
				JSON.stringify({
					...fixture,
					requirements: fixture.requirements.map((row, index) => (index === 0 ? { ...row, evidence: "" } : row)),
				}),
				ids,
			),
		).toBeNull();
	});

	it("accepts bare arrays, one-key arrays and single rows with the supported field aliases", () => {
		const rows = fixture.requirements;
		expect(parseRequirementReceipt(JSON.stringify(rows), ids)).toEqual(
			parseRequirementReceipt(JSON.stringify(fixture), ids),
		);
		for (const key of ["requirements", "table", "audit", "verdict", "result"]) {
			expect(parseRequirementReceipt(JSON.stringify({ [key]: rows }), ids)).toEqual(
				parseRequirementReceipt(JSON.stringify(fixture), ids),
			);
		}
		for (const rawKey of ["raw_words", "rawWords", "raw_text"]) {
			for (const statusKey of ["verdict", "status"]) {
				for (const artifactKey of ["artifact", "artifact_identity"]) {
					const row = rows[0]!;
					expect(
						parseRequirementReceipt(
							JSON.stringify({
								id: row.id,
								[rawKey]: row.raw_words,
								[statusKey]: row.verdict,
								evidence: row.evidence,
								[artifactKey]: row.artifact_identity,
							}),
							[row.id],
						),
					).toEqual([
						{
							id: row.id,
							rawWords: row.raw_words,
							status: row.verdict as RequirementVerdictStatus,
							evidence: row.evidence,
							artifact: row.artifact_identity,
						},
					]);
				}
			}
		}
	});

	it("keeps every required field mandatory and rejects ambiguous or malformed rows", () => {
		const row = fixture.requirements[0]!;
		for (const key of ["id", "raw_words", "verdict", "evidence", "artifact_identity"] as const) {
			const missing: Record<string, unknown> = { ...row };
			delete missing[key];
			expect(parseRequirementReceipt(JSON.stringify([missing]), [row.id])).toBeNull();
			expect(parseRequirementReceipt(JSON.stringify([{ ...row, [key]: " " }]), [row.id])).toBeNull();
			expect(parseRequirementReceipt(JSON.stringify([{ ...row, [key]: 42 }]), [row.id])).toBeNull();
		}
		for (const change of [{ id: "R7-a" }, { id: "R8" }, { verdict: "approved" }, { rawWords: "conflicting alias" }]) {
			expect(parseRequirementReceipt(JSON.stringify([{ ...row, ...change }]), [row.id])).toBeNull();
		}
		expect(parseRequirementReceipt(JSON.stringify([row, row]), [row.id])).toBeNull();
		expect(parseRequirementReceipt(JSON.stringify({ table: [row], audit: [row] }), [row.id])).toBeNull();
		expect(parseRequirementReceipt(JSON.stringify([row, null]), [row.id])).toBeNull();
		expect(parseRequirementReceipt(JSON.stringify(fixture), [...ids, "R11"])).toBeNull();
	});

	it("uses the same parent and sub-id coverage and verdict reduction as markdown", () => {
		const row = fixture.requirements[0]!;
		const parts = [
			{ ...row, id: "R7a", verdict: "pass" },
			{ ...row, id: "R7b", verdict: "FAIL" },
		];
		const table = [
			"| id | raw words | verdict | evidence | artifact |",
			"| --- | --- | --- | --- | --- |",
			...parts.map(
				part =>
					`| ${part.id} | ${part.raw_words.replaceAll("\n", "<br>")} | ${part.verdict} | ${part.evidence.replaceAll("|", "\\|")} | ${part.artifact_identity} |`,
			),
		].join("\n");
		expect(parseRequirementReceipt(JSON.stringify(parts), ["R7"])).toEqual(parseRequirementReceipt(table, ["R7"]));
		expect(parseRequirementReceipt(JSON.stringify([...parts, row]), ["R7"])).toBeNull();
	});
});
