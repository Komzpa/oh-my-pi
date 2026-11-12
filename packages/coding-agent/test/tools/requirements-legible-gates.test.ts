import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { TodoTool } from "../../src/tools/todo";
import {
	classifyRequirement,
	formatDoneGateRefusal,
	prepareAwaitingUserCheck,
	evaluateRequirementDoneGate,
	type ClassifyRequirementResult,
	type RequirementLedgerItem,
} from "../../src/tools/requirements-ledger";

const candidate = (
	id: string,
	classification: RequirementLedgerItem["classification"] = "candidate",
): RequirementLedgerItem => ({
	id,
	at: "2026-10-24T00:00:00.000Z",
	rawText: "Ship the requested change",
	classification,
	rows: classification === "linked" ? ["Build row"] : [],
});

function expectActionFirst(text: string, reference: string): void {
	const first = text.split("\n", 1)[0]!;
	expect(first.length).toBeLessThanOrEqual(100);
	expect(first).toContain(reference);
	expect(first.startsWith("Blocked:")).toBe(false);
}

describe("requirements gate refusals", () => {
	it("puts the concrete next step before details for each classify and relink refusal", () => {
		const cases: Array<{ result: ClassifyRequirementResult; id: string }> = [
			{ result: classifyRequirement([], "R7", "linked"), id: "R7" },
			{ result: classifyRequirement([candidate("R8")], "R8", "not-a-requirement"), id: "R8" },
			{ result: classifyRequirement([candidate("R9", "linked")], "R9", "not-a-requirement"), id: "R9" },
			{ result: classifyRequirement([candidate("R10")], "R10", "linked"), id: "R10" },
			{ result: classifyRequirement([candidate("R11")], "R11", "merged", { mergeInto: "R11" }), id: "R11" },
			{ result: classifyRequirement([candidate("R12")], "R12", "merged", { mergeInto: "R99" }), id: "R12" },
			{
				result: classifyRequirement([candidate("R13", "linked")], "R13", "not-a-requirement", { relink: true }),
				id: "R13",
			},
			{
				result: classifyRequirement([candidate("R14", "not-a-requirement")], "R14", "linked", { relink: true }),
				id: "R14",
			},
			{ result: classifyRequirement([candidate("R15", "linked")], "R15", "linked", { relink: true }), id: "R15" },
			{
				result: classifyRequirement([candidate("R16", "linked")], "R16", "linked", {
					relink: true,
					reason: "Move the row",
				}),
				id: "R16",
			},
		];
		for (const { result, id } of cases) {
			expect("error" in result).toBe(true);
			if ("error" in result) expectActionFirst(result.error, id);
		}
		const superseded = classifyRequirement(
			[
				{ ...candidate("R17", "linked"), at: "2026-10-23T00:00:00.000Z" },
				{ ...candidate("R18"), at: "2026-10-24T00:00:00.000Z" },
			],
			"R17",
			"linked",
			{ supersededBy: "R18" },
		);
		expect("error" in superseded).toBe(true);
		if ("error" in superseded) expectActionFirst(superseded.error, "R17");
	});

	it("shows the classify action for the R92 completion gate on its first line", () => {
		const text = formatDoneGateRefusal([
			{
				requirement: candidate("R92"),
				issues: ['R92 ("Retro sweep row"): R92 awaits todo classify'],
				awaitingUserIssues: [],
				auditRows: [],
			},
		]);
		expectActionFirst(text, "R92");
		expect(text.split("\n", 1)[0]).toContain("retry done");
		expect(text).toContain("R92 awaits todo classify");
		expect(text).toContain('op="classify", id="R92"');
	});

	it("names the first blocker and count when several requirements block one row", () => {
		const row = "A deliberately long row label that remains in the refusal details";
		const text = formatDoneGateRefusal(
			["R1", "R2", "R3"].map(id => ({
				requirement: candidate(id),
				issues: [`${id} (${JSON.stringify(row)}): ${id} awaits todo classify`],
				awaitingUserIssues: [],
				auditRows: [],
			})),
		);
		const first = text.split("\n", 1)[0]!;
		expect(first.length).toBeLessThanOrEqual(100);
		expect(first).toContain("R1");
		expect(first).toContain("+2 more below");
		expect(text).toContain("R3 awaits todo classify");
	});

	it("asks for the exact user action before setting a pending check", () => {
		const errors: string[] = [];
		const allowed = prepareAwaitingUserCheck(
			[],
			{ op: "block", task: "R31 row", awaitingUser: { action: "  " } },
			errors,
		);
		expect(allowed).toBe(false);
		expectActionFirst(errors[0]!, '"R31 row"');
	});

	it("uses distinct actions for user checks, unavailable artifacts, and QA verdict gaps", async () => {
		const linked = (id: string, extra: Partial<RequirementLedgerItem> = {}): RequirementLedgerItem => ({
			...candidate(id, "linked"),
			rows: ["Build row"],
			...extra,
		});
		const cases = [
			{
				requirement: linked("R21"),
				artifact: { cwd: "/tmp/repo", head: null, dirty: true, awaitingUser: { action: "check service output" } },
				action: "Complete the user check for R21",
			},
			{
				requirement: linked("R22"),
				artifact: {
					cwd: "/tmp/repo",
					head: null,
					dirty: true,
					reason: "current identity unavailable (missing path)",
				},
				action: "Restore or bind the artifact for R22",
			},
			{
				requirement: linked("R23"),
				artifact: { cwd: "/tmp/repo", head: null, dirty: true },
				action: "Re-audit R23",
			},
			{
				requirement: linked("R24", {
					verdict: { status: "fail", artifact: "old", evidence: "missing output", workerId: "qa" },
				}),
				artifact: { cwd: "/tmp/repo", head: null, dirty: true },
				action: "Re-audit R24",
			},
			{
				requirement: linked("R25", {
					verdict: {
						status: "pass",
						artifact: "old",
						evidence: "passed",
						workerId: "qa",
						receivedAt: "2026-10-23T00:00:00.000Z",
					},
				}),
				artifact: { cwd: "/tmp/repo", head: "new", dirty: false, identities: [] },
				action: "Re-audit R25",
			},
		];
		for (const { requirement, artifact, action } of cases) {
			const open = await evaluateRequirementDoneGate([requirement], ["Build row"], async () => artifact);
			const text = formatDoneGateRefusal(open);
			expectActionFirst(text, requirement.id);
			expect(text.split("\n", 1)[0]).toContain(action);
		}
	});

	it("puts unknown-row, deployment, and resource declaration recovery first in TodoTool errors", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("requirements_ledger", {
			version: 1,
			requirements: [candidate("R31"), candidate("R32")],
		});
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			getTodoPhases: () => [{ name: "Work", tasks: [{ content: "Build row", status: "pending" }] }],
			setTodoPhases: () => {},
		};
		const tool = new TodoTool(session);
		const attempts = [
			{ id: "R31" },
			{ id: "R31", classification: "linked", rows: ["missing row"] },
			{ id: "R31", classification: "linked", rows: ["Build row"], deployment: "file:/tmp/file" },
			{ id: "R31", classification: "linked", rows: ["Build row"], resources: ["relative/path"] },
		];
		for (const args of attempts) {
			const result = await tool.execute("classify", { op: "classify", ...args } as never);
			const text = result.content.find(item => item.type === "text")?.text ?? "";
			expect(result.isError).toBe(true);
			expectActionFirst(text, "R31");
		}
	});

	it("asks for persisted storage before classifying an otherwise valid requirement", async () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
		};
		const result = await new TodoTool(session).execute("no-storage", {
			op: "classify",
			id: "R32",
			classification: "not-a-requirement",
			reason: "Acknowledgement",
		});
		expect(result.isError).toBe(true);
		const text = result.content.find(item => item.type === "text")?.text ?? "";
		expectActionFirst(text, "R32");
		expect(text.split("\n", 1)[0]).toContain("persisted session");
	});

	it("requires a reasoned relink before replacing a saved row artifact", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("requirements_ledger", {
			version: 1,
			requirements: [{ ...candidate("R41", "linked"), rows: ["Build row"] }],
		});
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			getTodoPhases: () => [
				{
					name: "Work",
					tasks: [{ content: "Build row", status: "pending", schedule: { resources: ["/tmp/old"] } }],
				},
			],
			setTodoPhases: () => {},
		};
		const result = await new TodoTool(session).execute("replace-binding", {
			op: "classify",
			id: "R41",
			classification: "linked",
			rows: ["Build row"],
			resources: ["/tmp/new"],
		} as never);
		const text = result.content.find(item => item.type === "text")?.text ?? "";
		expect(result.isError).toBe(true);
		expectActionFirst(text, "R41");
		expect(text.split("\n", 1)[0]).toContain("reasoned relink");
	});
});
