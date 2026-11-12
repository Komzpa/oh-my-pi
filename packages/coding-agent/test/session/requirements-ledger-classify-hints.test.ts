import { describe, expect, it } from "bun:test";
import {
	createRequirementCandidates,
	formatUnclassifiedCandidateReminder,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";

const AT = "2026-09-28T12:00:00.000Z";
// Supplied synthetic representatives of the reported shapes (not exact live raw messages,
// and not an exhaustive history claim): only user-supplied descriptions and the Answer prefix were available.
const R17_CARD2 = "card 2 images are wrong, please fix the second card images";
const R18_XRAY_ANSWER = "Answer to toolu_abc123: X-ray scope shows no fracture, see notes";
// Reported unrelated open row; must be listed but never made runnable for R17/R18.
const UNRELATED_ROW = "Rebuild PR #54 from Maksim's whole branch";

function candidate(id: string, rawText: string): RequirementLedgerItem {
	const [item] = createRequirementCandidates([], [rawText], AT);
	if (!item) throw new Error("candidate fixture failed");
	return { ...item, id };
}

function runnableRows(reason: string): string[] | null {
	const match = /rows=(\[.*?\])/.exec(reason);
	if (!match?.[1]) return null;
	try {
		const parsed: unknown = JSON.parse(match[1]);
		return Array.isArray(parsed) ? (parsed as string[]) : null;
	} catch {
		return null;
	}
}

describe("unclassified candidate hints never suggest unrelated rows", () => {
	it("R17 card-2 complaint with one unrelated row abstains", () => {
		const reason = formatUnclassifiedCandidateReminder([candidate("R17", R17_CARD2)], [UNRELATED_ROW]);
		expect(reason).toContain("R17");
		expect(reason).toContain(JSON.stringify(R17_CARD2));
		// The runnable classify call must not offer the unrelated row.
		expect(reason).not.toContain(`rows=${JSON.stringify([UNRELATED_ROW])}`);
		const rows = runnableRows(reason);
		expect(rows === null || !rows.includes(UNRELATED_ROW)).toBe(true);
		// The open row is still listed separately so the model can choose.
		expect(reason).toContain(UNRELATED_ROW);
		expect(reason).toContain("this call was not blocked");
	});

	it("R18 X-ray Answer-to-tool-call with one unrelated row abstains", () => {
		const reason = formatUnclassifiedCandidateReminder([candidate("R18", R18_XRAY_ANSWER)], [UNRELATED_ROW]);
		expect(reason).toContain("R18");
		expect(reason).toContain(JSON.stringify(R18_XRAY_ANSWER));
		expect(reason).not.toContain(`rows=${JSON.stringify([UNRELATED_ROW])}`);
		const rows = runnableRows(reason);
		expect(rows === null || !rows.includes(UNRELATED_ROW)).toBe(true);
		expect(reason).toContain(UNRELATED_ROW);
	});

	it("multiple unrelated rows are listed, none is runnable", () => {
		const other = "Fix login bug";
		const reason = formatUnclassifiedCandidateReminder([candidate("R17", R17_CARD2)], [UNRELATED_ROW, other]);
		expect(reason).not.toContain(`rows=${JSON.stringify([UNRELATED_ROW, other])}`);
		expect(reason).not.toContain(`rows=${JSON.stringify([UNRELATED_ROW])}`);
		const rows = runnableRows(reason);
		expect(rows === null || (rows.includes(UNRELATED_ROW) === false && rows.includes(other) === false)).toBe(true);
		expect(reason).toContain(UNRELATED_ROW);
		expect(reason).toContain(other);
	});

	it("no open rows still names the candidate with a non-executable placeholder", () => {
		const reason = formatUnclassifiedCandidateReminder([candidate("R17", R17_CARD2)], []);
		expect(reason).toContain("R17");
		expect(reason).toContain(JSON.stringify(R17_CARD2));
		expect(reason).toContain("<exact todo row>");
		const rows = runnableRows(reason);
		expect(rows === null || rows.includes(UNRELATED_ROW) === false).toBe(true);
	});
});
