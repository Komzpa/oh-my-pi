import { describe, expect, it } from "bun:test";
import {
	RequirementsLedgerRuntime,
	type RequirementPublicationGate,
} from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

import {
	createRequirementCandidates,
	getRequirementVerdictStaleness,
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
		expect(
			getRequirementVerdictStaleness(artifact("build the thing", `Build artifact @ ${SHA_A}`), artifacts),
		).toBeNull();
		expect(
			getRequirementVerdictStaleness(artifact("ship the thing instead", `Build artifact @ ${SHA_A}`), artifacts),
		).toBe('R1 raw words differ for row "Build artifact" at char 0 (source 15 chars vs receipt 22 chars)');
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
			getRequirementVerdictStaleness(requirement, [
				{ row: "Build artifact", head: SHA_A, dirty: false },
				{ row: "Review artifact", head: SHA_B, dirty: false },
			]),
		).toBeNull();
		const swapped = getRequirementVerdictStaleness(requirement, [
			{ row: "Build artifact", head: SHA_B, dirty: false },
			{ row: "Review artifact", head: SHA_A, dirty: false },
		]);
		expect(swapped).toContain(SHA_A);
		expect(swapped).toContain(SHA_B);
		expect(swapped).toContain("Build artifact");
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
		const stale = getRequirementVerdictStaleness(requirement, [
			{ row: "Build artifact", head: SHA_A, dirty: false },
			{ row: "Review artifact", head: SHA_B, dirty: false },
		]);
		expect(stale).toContain(SHA_A);
		expect(stale).toContain(SHA_B);
		expect(stale).toContain("Review artifact");
	});
});

describe("requirement publication visibility", () => {
	function publicationFixture() {
		const manager = SessionManager.inMemory();
		let gate: RequirementPublicationGate | undefined;
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => process.cwd(),
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: value => {
				gate = value;
			},
		});
		runtime.captureCandidate("Fix the login bug");
		return { gate: () => gate };
	}

	it("keeps the real final answer visible above the unverified status", async () => {
		const fx = publicationFixture();
		const message = {
			content: [{ type: "text", text: "Login repair is committed; deployment is pending." }],
			stopReason: "stop",
		};
		const result = await fx.gate()?.(message as never, new AbortController().signal);
		expect(result?.replacementText).toBe(
			"Login repair is committed; deployment is pending.\n\nNot audit-verified: R1 (1 of 1)",
		);
	});

	it("shows provider failure text without applying requirement decoration", async () => {
		const fx = publicationFixture();
		const message = {
			content: [{ type: "text", text: "Provider stream failed: connection reset" }],
			stopReason: "error",
			errorMessage: "connection reset",
		};
		const result = await fx.gate()?.(message as never, new AbortController().signal);
		expect(result).toBeUndefined();
		expect(message.content).toEqual([{ type: "text", text: "Provider stream failed: connection reset" }]);
		expect(message.errorMessage).toBe("connection reset");
	});

	it("records lead steer references as controls while keeping ordinary file asks eligible", () => {
		const controls = createRequirementCandidates([], ["@/tmp/session/scratchpad/steer_qa_shipnow.md"], AT);
		expect(controls[0]?.classification).toBe("not-a-requirement");
		const asks = createRequirementCandidates(
			[],
			["@/tmp/requirements.md", "Implement @/tmp/session/steer_feature.md"],
			AT,
		);
		expect(asks.map(item => item.classification)).toEqual(["candidate", "candidate"]);
	});
});
