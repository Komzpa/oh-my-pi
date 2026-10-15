import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import qaAuditorPrompt from "../../src/prompts/agents/qa-auditor.md" with { type: "text" };
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	formatRequirementGateArtifact,
	getLatestRequirements,
	getPersistedRequirementAuditRejections,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import {
	getLatestTodoPhasesFromEntries,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";

const AT = "2026-10-13T00:00:00.000Z";
const IDS = ["R39", "R40"] as const;

async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ledger-partial-"));
	await Bun.write(path.join(cwd, ".omp", "agents", "qa-auditor.md"), qaAuditorPrompt);
	const manager = SessionManager.inMemory();
	const rows = IDS.map(id => {
		const content = `Build ${id} artifact`;
		const artifactPath = path.join(cwd, `${id}.txt`);
		const bytes = `${id} audited file bytes\n`;
		return { id, content, artifactPath, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
	});
	for (const row of rows) await Bun.write(row.artifactPath, row.bytes);
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Work",
				tasks: rows.map(row => ({
					content: row.content,
					status: "pending",
					schedule: { owner: "main", resources: [row.artifactPath] },
				})),
			},
		],
	});
	appendRequirementsSnapshot(
		{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
		createRequirementCandidates(
			[],
			IDS.map(id => `audit ${id} file artifact`),
			AT,
		).map((requirement, index) => ({
			...requirement,
			id: IDS[index]!,
			classification: "linked",
			rows: [rows[index]!.content],
		})),
	);
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => cwd,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
	});
	return { cwd, manager, rows, runtime };
}

async function multiRowFixture(quotedRows = false) {
	const setup = await fixture();
	const rows = setup.rows.slice(0, 2).map((row, index) => ({
		...row,
		content: quotedRows ? (index === 0 ? `Build "${row.id}" artifact at C:\\work\\${row.id}` : "Build") : row.content,
	}));
	setup.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Work",
				tasks: rows.map(row => ({
					content: row.content,
					status: "pending",
					schedule: { owner: row === rows[0] ? "main" : "OtherAudit", resources: [row.artifactPath] },
				})),
			},
		],
	});
	appendRequirementsSnapshot({ appendEntry: (type, data) => setup.manager.appendCustomEntry(type, data) }, [
		{
			...getLatestRequirements(setup.manager.getBranch())[0]!,
			id: "R24",
			rawText: "audit both file artifacts",
			rows: rows.map(row => row.content),
		},
	]);
	const tool = new TodoTool({
		cwd: setup.cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		sessionManager: setup.manager,
		getTodoPhases: () => getLatestTodoPhasesFromEntries(setup.manager.getBranch()),
		setTodoPhases: (phases: TodoPhase[]) => setup.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
	} as unknown as ToolSession);
	return { ...setup, rows, tool };
}

describe("multi-row audit retry identity", () => {
	it("refuses sub-rows with conflicting artifacts and requests an exact-parent restatement", async () => {
		const { cwd, manager, rows, runtime } = await multiRowFixture();
		try {
			const row = rows[0]!;
			await runtime.prepareAuditorTaskCall("task", "suffix-row-audit", {
				name: "main",
				agent: "qa-auditor",
				task: `Audit R24 for ${row.content} @ sha256=${row.sha256}`,
			});
			const result = await runtime.afterToolCall({
				toolCall: { id: "suffix-row-audit", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "suffix-row-qa",
								exitCode: 0,
								output: `| id | verdict | evidence | artifact |\n| --- | --- | --- | --- |\n| R24a | pass | read first artifact | row "${row.content}" @ file:${row.artifactPath}@sha256=${row.sha256} |\n| R24b | fail | different artifact | row "${row.content}" @ file:${rows[1]!.artifactPath}@sha256=${rows[1]!.sha256} |`,
							},
						],
					},
				},
				isError: false,
			} as never);
			const diagnostic = JSON.stringify(result?.content) ?? "";
			expect(diagnostic).toContain("requirements receipt rejected");
			expect(diagnostic).toContain("R24b");
			expect(diagnostic).toContain("exact assigned ID R24");
			expect(diagnostic).toContain("restate one row");
			expect(diagnostic).toContain("discard a failing clause");
			const requirement = getLatestRequirements(manager.getBranch())[0]!;
			for (const linkedRow of rows) expect(requirement.rowVerdicts?.[linkedRow.content]).toBeUndefined();
			expect(getPersistedRequirementAuditRejections(manager.getBranch(), manager.getSessionId()).has("R24")).toBe(
				true,
			);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("accepts an exact R24 per-row receipt and allows only that row to close", async () => {
		const { cwd, manager, rows, runtime, tool } = await multiRowFixture();
		try {
			const row = rows[0]!;
			const other = rows[1]!;
			await runtime.prepareAuditorTaskCall("task", "exact-row-audit", {
				name: "main",
				agent: "qa-auditor",
				task: `Audit R24 for ${row.content} @ sha256=${row.sha256}`,
			});
			const result = await runtime.afterToolCall({
				toolCall: { id: "exact-row-audit", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "exact-row-qa",
								exitCode: 0,
								output: `| id | verdict | evidence | artifact |\n| --- | --- | --- | --- |\n| R24 | pass | read ${row.artifactPath} | row ${JSON.stringify(row.content)} @ file:${row.artifactPath}@sha256=${row.sha256} |`,
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(result).toBeUndefined();
			const requirement = getLatestRequirements(manager.getBranch())[0]!;
			expect(requirement.rowVerdicts?.[row.content]).toMatchObject({
				status: "pass",
				auditor: "qa-auditor",
				workerId: "exact-row-qa",
				rawWords: "audit both file artifacts",
			});
			expect(requirement.rowVerdicts?.[other.content]).toBeUndefined();
			expect((await tool.execute("done-exact-row", { op: "done", task: row.content })).isError).not.toBe(true);
			expect((await tool.execute("done-unaudited-row", { op: "done", task: other.content })).isError).toBe(true);
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks.map(task => task.status)).toEqual([
				"completed",
				"in_progress",
			]);
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.[other.content]).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps a quoted and backslashed row assignment scoped to its exact parent and artifact", async () => {
		const { cwd, manager, rows, runtime, tool } = await multiRowFixture(true);
		try {
			const row = rows[0]!;
			const other = rows[1]!;
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				...getLatestRequirements(manager.getBranch()),
				{
					...getLatestRequirements(manager.getBranch())[0]!,
					id: "R25",
					rawText: "audit sibling file artifact",
					rows: [other.content],
				},
			]);
			const artifact = formatRequirementGateArtifact(
				{
					head: null,
					dirty: false,
					identities: [{ kind: "file", path: row.artifactPath, sha256: row.sha256 }],
					cwd: row.artifactPath,
				},
				row.content,
			);
			const prepared = await runtime.prepareAuditorTaskCall("task", "quoted-row-audit", {
				name: "main",
				agent: "qa-auditor",
				task: `Audit exact requirement IDs R24, R25 for TODO ${artifact}`,
			});
			expect(prepared?.task).toContain(`R24 ${artifact}`);
			expect(prepared?.task).not.toContain(other.sha256);
			const result = await runtime.afterToolCall({
				toolCall: { id: "quoted-row-audit", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "quoted-row-qa",
								exitCode: 0,
								output: `| id | verdict | evidence | artifact |\n| --- | --- | --- | --- |\n| R24 | pass | read assigned file artifact | ${artifact.replace(/\\/g, "\\\\")} |`,
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(result).toBeUndefined();
			const requirements = getLatestRequirements(manager.getBranch());
			expect(requirements.find(requirement => requirement.id === "R24")?.rowVerdicts?.[row.content]?.status).toBe(
				"pass",
			);
			expect(
				requirements.find(requirement => requirement.id === "R24")?.rowVerdicts?.[other.content],
			).toBeUndefined();
			expect(requirements.find(requirement => requirement.id === "R25")?.rowVerdicts).toBeUndefined();
			expect((await tool.execute("done-quoted-row", { op: "done", task: row.content })).isError).not.toBe(true);
			expect((await tool.execute("done-quoted-sibling", { op: "done", task: other.content })).isError).toBe(true);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("gives separate exact-parent audit retry calls with each row's current file SHA", async () => {
		const { cwd, rows, tool } = await multiRowFixture();
		try {
			const result = await tool.execute("done-both-unaudited-rows", {
				op: "done",
				items: rows.map(row => row.content),
			});
			expect(result.isError).toBe(true);
			const refusal = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n");
			expect(refusal).not.toMatch(/<\s*(?:rejected\s+)?Rn\s*>/);
			const calls = [...refusal.matchAll(/agent="qa-auditor", task="((?:\\.|[^"\\])*)"/g)].map(
				match => JSON.parse(`"${match[1]}"`) as string,
			);
			expect(calls).toHaveLength(2);
			for (const row of rows) {
				const rowCalls = calls.filter(call => call.includes(row.content));
				expect(rowCalls).toHaveLength(1);
				expect(rowCalls[0]).toMatch(/\bR24\b/);
				expect(rowCalls[0]).not.toMatch(/\bR24[a-z]\b/i);
				expect(rowCalls[0]).toContain(`sha256=${row.sha256}`);
				for (const other of rows.filter(candidate => candidate !== row)) {
					expect(rowCalls[0]).not.toContain(other.content);
					expect(rowCalls[0]).not.toContain(other.sha256);
				}
			}
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("authenticated parent verdicts from auditor sub-rows", () => {
	for (const status of ["pass", "fail", "unverifiable"] as const) {
		it(`records R18 as ${status} when its second clause is ${status}`, async () => {
			const { cwd, manager, rows, runtime } = await fixture();
			try {
				const row = rows[0]!;
				appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
					{ ...getLatestRequirements(manager.getBranch())[0]!, id: "R18" },
				]);
				const identity = `row "${row.content}" @ file:${row.artifactPath}@sha256=${row.sha256}`;
				await runtime.prepareAuditorTaskCall("task", "sub-row-audit", {
					name: "main",
					agent: "qa-auditor",
					task: "Recount both clauses",
				});
				const result = await runtime.afterToolCall({
					toolCall: { id: "sub-row-audit", name: "task" },
					result: {
						content: [],
						details: {
							results: [
								{
									index: 0,
									agent: "qa-auditor",
									id: "sub-row-worker",
									exitCode: 0,
									output: [
										"| id | verdict | evidence | artifact-identity |",
										"| --- | --- | --- | --- |",
										`| R18a | pass | first clause exercised | ${identity} |`,
										`| R18b | ${status} | second clause exercised | ${identity} |`,
									].join("\n"),
								},
							],
						},
					},
					isError: false,
				} as never);
				expect(result).toBeUndefined();
				const receipt = getLatestRequirements(manager.getBranch())[0]!.rowVerdicts?.[row.content];
				expect(receipt?.status).toBe(status);
				expect(receipt?.evidence).toContain("R18a");
				expect(receipt?.evidence).toContain("first clause exercised");
				expect(receipt?.evidence).toContain("R18b");
				expect(receipt?.evidence).toContain("second clause exercised");
				const tool = new TodoTool({
					cwd,
					hasUI: false,
					settings: Settings.isolated(),
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					sessionManager: manager,
					getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
					setTodoPhases: phases => manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
				} as ToolSession);
				expect((await tool.execute("finish", { op: "done", task: row.content })).isError).toBe(
					status === "pass" ? undefined : true,
				);
			} finally {
				await fs.rm(cwd, { recursive: true, force: true });
			}
		});
	}
});

describe("gate refusals on QA dispatch are not audit failures", () => {
	it("passes a pre-dispatch gate refusal through unchanged", async () => {
		const { cwd, rows, runtime } = await multiRowFixture();
		try {
			const row = rows[0]!;
			await runtime.prepareAuditorTaskCall("task", "gate-refused-audit", {
				name: "main",
				agent: "qa-auditor",
				task: `Audit R24 for ${row.content}`,
			});
			const refusal = "Blocked: todo done is blocked until every linked requirement has a fresh qa-auditor pass";
			const result = await runtime.afterToolCall({
				toolCall: { id: "gate-refused-audit", name: "task" },
				result: { content: [{ type: "text", text: refusal }], details: {} },
				isError: true,
			} as never);
			expect(result).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("still reports a launched qa-auditor that fails as failed", async () => {
		const { cwd, rows, runtime } = await multiRowFixture();
		try {
			const row = rows[0]!;
			await runtime.prepareAuditorTaskCall("task", "launched-failed-audit", {
				name: "main",
				agent: "qa-auditor",
				task: `Audit R24 for ${row.content}`,
			});
			const result = await runtime.afterToolCall({
				toolCall: { id: "launched-failed-audit", name: "task" },
				result: {
					content: [],
					details: {
						results: [{ index: 0, agent: "qa-auditor", id: "qa-failed", exitCode: 1, output: "crashed" }],
					},
				},
				isError: true,
			} as never);
			const diagnostic = JSON.stringify(result?.content) ?? "";
			expect(diagnostic).toContain("qa-auditor task failed");
			expect(diagnostic).toContain("requirements receipt rejected");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
