import { describe, expect, it } from "bun:test";
import { parseRequirementReceipt } from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import table from "../fixtures/qa-pipe-924-bare-table.txt" with { type: "text" };

const raw = "[Image #1, 1568x1185] some red shit";
const artifact = 'row "Fix audit receipt rejecting foreign cited Rn in #41" @ cfd747275215622b5d3a7b9c488f82ef9028da77';
const evidence =
	'Screenshot checked (attached in the audit input): the gate rejects the R4 receipt with "Blocked: todo done is blocked until every linked requirement has a fresh qa-auditor pass", and the agent notes the R4 artifact identity was labelled "R6 row ..." instead of "TODO row". The checkout is clean with HEAD at cfd747275215622b5d3a7b9c488f82ef9028da77. packages/coding-agent/src/tools/requirements-ledger.ts:567 now reads `/^\\s*(?:(?:TODO|R[1-9]\\d*)\\s+)?row\\s+"…"\\s*@/i`. `bun test packages/coding-agent/test/tools/requirements-ledger.test.ts packages/coding-agent/test/session/requirements-ledger-runtime.test.ts` passed 75 of 75 tests (325 expect() calls, 0 fail). Isolated probe of getRequirementRowArtifactIdentity: pre-fix 4354bfd7 returned `undefined` for `R6 row "A" @ aaaa…(40 a\'s)` on row A. Post-fix cfd74727 returned the artifact `R6 row "A" @ aaaa…`. The foreign label `R6 row "B" @ …` on row A returned `undefined` in both versions. The temporary __pre.ts, __post.ts and __probe.ts files were deleted, and `git status --short` was empty afterwards.';

// Source: AuditR42ReceiptScope-4, yield cd48bcac, 2026-10-13T16:45:04.961Z; grievance #924.
describe("receipt priority #924: requested parent selection", () => {
	it("accepts the byte-exact live bare table, retaining the whole R42 evidence and ignoring unlinked R43", () => {
		expect(parseRequirementReceipt(table, ["R42"])).toEqual([
			{ id: "R42", rawWords: raw, status: "pass", evidence, artifact },
		]);
	});

	it("locates reordered named columns, optional raw-source maps, and legacy header aliases", () => {
		const reordered =
			"| notes | evidence | artifact identity | verdict | id | raw words |\n| --- | --- | --- | --- | --- | --- |\n" +
			`| extra | psql a\\|b | ${artifact} | pass | R42 | ${raw} |`;
		expect(parseRequirementReceipt(reordered, ["R42"])?.[0]).toEqual({
			id: "R42",
			rawWords: raw,
			status: "pass",
			evidence: "psql a|b",
			artifact,
		});
		const legacy = `| id | status | evidence | artifact |\n| --- | --- | --- | --- |\n| R42 | pass | inspected | ${artifact} |`;
		expect(parseRequirementReceipt(legacy, ["R42"], new Map([["R42", raw]]))?.[0]?.rawWords).toBe(raw);
		expect(parseRequirementReceipt(legacy, ["R42"])).toBeNull();
	});

	it("ignores only unrelated valid parent IDs before their malformed fields are checked", () => {
		const unrelatedMalformed = table.replace(/\| R43 \|[^\n]*/, "| R43 | missing fields |");
		expect(parseRequirementReceipt(unrelatedMalformed, ["R42"])?.[0]?.status).toBe("pass");
		expect(
			parseRequirementReceipt(
				JSON.stringify([
					{ id: "R42", raw_words: raw, verdict: "pass", evidence: "inspected", artifact },
					{ id: "R43", verdict: 42 },
				]),
				["R42"],
			)?.[0]?.id,
		).toBe("R42");
	});

	it("requires every assigned parent, including R43 when it is assigned to the same row", () => {
		const parsed = parseRequirementReceipt(table, ["R42", "R43"]);
		expect(parsed?.map(row => [row.id, row.status])).toEqual([
			["R42", "pass"],
			["R43", "unverifiable"],
		]);
		expect(parseRequirementReceipt(table.replace(/\n\| R43 \|[^\n]*/, ""), ["R42", "R43"])).toBeNull();
	});

	it("rejects a missing requested row, duplicate requested row, malformed verdict and unescaped requested pipe", () => {
		expect(parseRequirementReceipt(table.replace(/\n\| R42 \|[^\n]*/, ""), ["R42"])).toBeNull();
		const requestedLine = table.split("\n").find(line => line.startsWith("| R42 |"))!;
		expect(parseRequirementReceipt(`${table.trimEnd()}\n${requestedLine}`, ["R42"])).toBeNull();
		expect(parseRequirementReceipt(table.replace("| pass |", "| pass with caveats |"), ["R42"])).toBeNull();
		expect(parseRequirementReceipt(table.replace("TODO\\|R", "TODO|R"), ["R42"])).toBeNull();
	});

	it("does not silently ignore same-parent suffix IDs or malformed IDs", () => {
		let identityFailure: string | undefined;
		expect(
			parseRequirementReceipt(table.replace("| R43 |", "| R42a |"), ["R42"], undefined, (received, parent) => {
				identityFailure = `${received}:${parent}`;
			}),
		).toBeNull();
		expect(identityFailure).toBe("R42a:R42");
		expect(parseRequirementReceipt(table.replace("| R43 |", "| R43-a |"), ["R42"])).toBeNull();
	});
});
