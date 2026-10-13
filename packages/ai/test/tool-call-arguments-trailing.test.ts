import { describe, expect, it } from "bun:test";
import { parseToolCallArguments } from "../src/utils/tool-call-arguments";

// Real FixPr98Types prefix (session FixPr98Types.jsonl lines 118-137, __rawJson
// head before the 512-char `… [truncated N chars]` bound; reported positions
// 1838/1896/2009/2033/2035/2198 lie past the bound so the full suffix is
// unrecoverable — the stored raw keeps only this head).
const REAL_HEAD =
	`{"data": {"status":"done","commit":"ef8a6799dd950647bc70149d47ca4c53db7a3dfd",` +
	`"commit_message":"fix(coding-agent): typecheck provider exhaustion types under pi-catalog"}`;

describe("parseToolCallArguments trailing characters", () => {
	it("accepts one complete object plus a stray duplicated closer", () => {
		const raw = `${REAL_HEAD}}}`;
		const parsed = parseToolCallArguments(raw) as Record<string, unknown>;
		expect((parsed.data as Record<string, unknown>).status).toBe("done");
		expect("__parseError" in parsed).toBe(false);
	});

	it("keeps the rejection with a resend hint when the suffix carries content", () => {
		const raw = `${REAL_HEAD}} {"second":1}`;
		const parsed = parseToolCallArguments(raw) as Record<string, unknown>;
		expect(typeof parsed.__parseError).toBe("string");
		expect(parsed.__parseError as string).toMatch(/Unexpected trailing characters at position/);
		expect(parsed.__parseError as string).toMatch(/Resend exactly one JSON object/);
	});
});
