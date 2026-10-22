import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ASYNC_RESULT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import {
	RequirementsLedgerRuntime,
	type RequirementPublicationGate,
} from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { finalizeSubprocessOutput } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	evaluateRequirementDoneGate,
	getPersistedRequirementAuditRejections,
	getPersistedRequirementAuditorAssignments,
	requirementSourceDigest,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { formatRequirementIdentity } from "@oh-my-pi/pi-coding-agent/utils/requirement-artifact";
import {
	getLatestTodoPhasesFromEntries,
	getRequirementRowArtifact,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";

const AT = "2026-09-28T12:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitIdentity(cwd: string, commit: string): string {
	return formatRequirementIdentity({ kind: "git", repo: cwd, commit });
}

function fixture(
	auditorProfile = readFileSync(new URL("../../src/prompts/agents/qa-auditor.md", import.meta.url), "utf8"),
) {
	const cwd = mkdtempSync(join(tmpdir(), "omp-ledger-runtime-"));
	const auditorDir = join(cwd, ".omp", "agents");
	mkdirSync(auditorDir, { recursive: true });
	writeFileSync(join(auditorDir, "qa-auditor.md"), auditorProfile);
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "tester@example.invalid");
	git(cwd, "config", "user.name", "Ledger Runtime Test");
	writeFileSync(join(cwd, "artifact.txt"), "audited\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "audited artifact");
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
		version: 1,
		requirements: createRequirementCandidates([], ["audit the artifact"], AT),
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Work",
				tasks: [{ content: "Build artifact", status: "pending", schedule: { owner: "main", resources: [cwd] } }],
			},
		],
	});
	const appender = {
		appendEntry: (customType: string, data?: unknown) => manager.appendCustomEntry(customType, data),
	};
	const linked = classifyRequirement(getLatestRequirements(manager.getBranch()), "R1", "linked", {
		rows: ["Build artifact"],
	});
	if ("error" in linked) throw new Error(linked.error);
	appendRequirementsSnapshot(appender, linked.requirements);
	let gate: RequirementPublicationGate | undefined;
	const notices: string[] = [];
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => cwd,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
		queueModelNotice: (notice: string) => {
			notices.push(notice);
		},
		setPublicationGate: next => {
			gate = next;
		},
	});
	return { cwd, manager, runtime, notices, gate: () => gate };
}

// A long session can contain thousands of obsolete snapshots. Restoring pending
// work needs the newest valid ledger and the newest assignment for this session.
it.each([false, true])(
	"restores pending auditors without decoding obsolete snapshots (malformed tail: %s)",
	malformed => {
		const { cwd, manager } = fixture();
		try {
			manager.appendCustomEntry("requirements_auditor_assignments", {
				version: 1,
				sessionId: manager.getHeader()!.id,
				jobs: [],
			});
			manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements: [] });
			const selected = manager.getBranch().slice(-2).reverse();
			if (malformed) {
				manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: -1 });
				manager.appendCustomEntry("requirements_auditor_assignments", { version: 1, sessionId: "other", jobs: [] });
				selected.unshift(...manager.getBranch().slice(-2).reverse());
			}
			let decoded = 0;
			Object.defineProperty(manager, "iterateBranchMatchingNewestFirst", {
				value: function* () {
					for (const entry of selected) {
						decoded++;
						yield entry;
					}
					throw new Error("obsolete snapshots must not be decoded after current snapshots were found");
				},
			});
			new RequirementsLedgerRuntime({
				agent: {} as never,
				agentKind: () => "main",
				cwd: () => cwd,
				sessionManager: manager,
				onSettledAssistantMessage: () => {},
				setPublicationGate: () => {},
			});
			expect(decoded).toBe(malformed ? 7 : 3);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

function receiptTable(head: string, evidence = "exercised the build"): string {
	return [
		"| id | raw words | verdict | evidence | artifact identity |",
		"| --- | --- | --- | --- | --- |",
		`| R1 | audit the artifact | pass | ${evidence} | ${head} |`,
	].join("\n");
}

async function auditFixtureArtifact(
	runtime: RequirementsLedgerRuntime,
	workerId: string,
	artifact: string,
	evidence: string,
): Promise<void> {
	await runtime.prepareAuditorTaskCall("task", workerId, {
		name: "main",
		agent: "qa-auditor",
		task: "Audit R1 please",
		context: "",
	});
	const outcome = await runtime.afterToolCall({
		toolCall: { id: workerId, name: "task" },
		result: {
			content: [],
			details: {
				results: [
					{ index: 0, agent: "qa-auditor", id: workerId, exitCode: 0, output: receiptTable(artifact, evidence) },
				],
			},
		},
		isError: false,
	} as never);
	expect(outcome).toBeUndefined();
}

describe("requirements ledger auditor binding", () => {
	it("accepts a multiline lane brief by authenticated digest and rejects a changed digest", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const rawText = "# Target\r\nFix the login bug | preserve receipts\n# Acceptance\nLogin succeeds";
			const requirements = getLatestRequirements(manager.getBranch());
			requirements[0]!.rawText = rawText;
			appendRequirementsSnapshot(
				{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
				requirements,
			);
			const artifact = gitIdentity(cwd, git(cwd, "rev-parse", "HEAD"));
			const digest = requirementSourceDigest(rawText);
			for (const [workerId, sourceDigest, accepted] of [
				["wrong", "0".repeat(64), false],
				["fresh", digest, true],
			] as const) {
				await runtime.prepareAuditorTaskCall("task", workerId, {
					name: "main",
					agent: "qa-auditor",
					task: "Audit R1",
					context: "",
				});
				const outcome = await runtime.afterToolCall({
					toolCall: { id: workerId, name: "task" },
					result: {
						content: [],
						details: {
							results: [
								{
									index: 0,
									agent: "qa-auditor",
									id: workerId,
									exitCode: 0,
									output: `| id | source sha256 | verdict | evidence | artifact identity |\n| --- | --- | --- | --- | --- |\n| R1 | ${sourceDigest} | pass | login exercised | ${artifact} |`,
								},
							],
						},
					},
					isError: false,
				} as never);
				expect(outcome === undefined).toBe(accepted);
			}
			const requirement = getLatestRequirements(manager.getBranch())[0]!;
			expect(requirement.rowVerdicts?.["Build artifact"]?.rawWords ?? requirement.verdict?.rawWords).toBe(rawText);
			let phases = getLatestTodoPhasesFromEntries(manager.getBranch());
			const tool = new TodoTool({
				cwd,
				hasUI: false,
				settings: Settings.isolated(),
				sessionManager: manager,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getTodoPhases: () => phases,
				setTodoPhases: next => {
					phases = next;
				},
			});
			const done = await tool.execute("complete-multiline", { op: "done", task: "Build artifact" });
			expect(done.isError).toBeFalsy();
			expect(phases[0]!.tasks[0]!.status).toBe("completed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("uses only structured row ownership when a packet quotes unrelated R6 examples", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const phases = getLatestTodoPhasesFromEntries(manager.getBranch());
			Object.assign(phases[0]!.tasks[0]!, { schedule: { owner: "FindingXAudit", resources: [cwd] } });
			phases[0]!.tasks.push({ content: "Unrelated manifest", status: "pending" });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			appendRequirementsSnapshot(
				{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
				[
					...getLatestRequirements(manager.getBranch()),
					{
						...createRequirementCandidates([], ["unrelated manifest requirement"], AT)[0]!,
						id: "R6",
						classification: "linked",
						rows: ["Unrelated manifest"],
					},
				],
			);
			const input = {
				context: 'Quoted syntax: `R6 row "Unrelated manifest" @ file:/tmp/example@sha256=…`',
				tasks: [
					{
						name: "FindingXAudit",
						agent: "qa-auditor",
						task: "Verify finding X. An example mentions R6; do not audit it.",
					},
				],
			};
			const revised = await runtime.prepareAuditorTaskCall("task", "grievance937", input);
			expect(revised).toBeDefined();
			await runtime.afterToolCall({
				toolCall: { id: "grievance937", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "FindingXAudit",
								exitCode: 0,
								output: receiptTable(gitIdentity(cwd, git(cwd, "rev-parse", "HEAD"))),
							},
						],
					},
				},
				isError: false,
			} as never);
			const requirements = getLatestRequirements(manager.getBranch());
			expect(
				requirements.find(requirement => requirement.id === "R1")?.rowVerdicts?.["Build artifact"]?.status,
			).toBe("pass");
			expect(requirements.find(requirement => requirement.id === "R6")).toEqual({
				...createRequirementCandidates([], ["unrelated manifest requirement"], AT)[0]!,
				id: "R6",
				classification: "linked",
				rows: ["Unrelated manifest"],
			});
			await expect(
				runtime.prepareAuditorTaskCall("task", "unassigned937", { agent: "qa-auditor", task: "Audit R6" }),
			).rejects.toThrow("Set requirementIds");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	for (const scenario of ["image-prefix-omitted", "foreign-id", "foreign-artifact", "changed-source"] as const) {
		it(`binds free-text R23 audit by structured ownership and source snapshot: ${scenario}`, async () => {
			const { cwd, manager, runtime } = fixture();
			const row = "Merge open PRs #44 #45 #57 into PR #60 branch";
			const words = "Merge all four open PR branches without dropping their commits";
			const raw = `[Image #1, 1568x622] ${words}`;
			let phases: TodoPhase[] = [
				{
					name: "Work",
					tasks: [Object.assign({ content: row, status: "pending" as const }, { schedule: { resources: [cwd] } })],
				},
			];
			const appender = { appendEntry: (type: string, data?: unknown) => manager.appendCustomEntry(type, data) };
			const tool = new TodoTool({
				cwd,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => phases,
				setTodoPhases: next => {
					phases = next;
				},
			} as ToolSession);
			try {
				manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
				appendRequirementsSnapshot(appender, [
					{ ...createRequirementCandidates([], [raw], AT)[0]!, id: "R23", classification: "linked", rows: [row] },
				]);
				// Scheduling is owned by PR #92; replay its durable result through #41's canonical reader.
				Object.assign(phases[0]!.tasks[0]!, { schedule: { owner: "AuditR23MergeRow", resources: [cwd] } });
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "schedule-r23",
					toolName: "todo",
					content: [],
					details: { op: "schedule", phases },
					isError: false,
					timestamp: Date.now(),
				});
				const head = git(cwd, "rev-parse", "HEAD");
				await expect(
					runtime.prepareAuditorTaskCall("task", "unmatched-r23", {
						name: "OtherAudit",
						agent: "qa-auditor",
						task: `Audit R23 for ${row}`,
					}),
				).rejects.toThrow("Set requirementIds");
				await runtime.afterToolCall({
					toolCall: { id: "unmatched-r23", name: "task" },
					result: { content: [], details: { progress: [{ index: 0, agent: "qa-auditor", id: "OtherAudit" }] } },
					isError: false,
				} as never);
				await runtime.prepareAuditorTaskCall("task", "r23", {
					name: "AuditR23MergeRow",
					agent: "qa-auditor",
					task: "Check the merge result and run the merge oracle.",
				});
				await runtime.afterToolCall({
					toolCall: { id: "r23", name: "task" },
					result: {
						content: [],
						details: { progress: [{ index: 0, agent: "qa-auditor", id: "AuditR23MergeRow" }] },
					},
					isError: false,
				} as never);
				const assignments = getPersistedRequirementAuditorAssignments(
					manager.getBranch(),
					manager.getSessionId(),
					getLatestRequirements(manager.getBranch()),
				);
				expect(assignments.get("AuditR23MergeRow")?.rows).toEqual([row]);
				expect(assignments.get("AuditR23MergeRow")?.ids).toEqual(["R23"]);
				expect(assignments.has("OtherAudit")).toBe(false);
				if (scenario === "changed-source") {
					const requirements = getLatestRequirements(manager.getBranch());
					requirements[0]!.rawText += " and verify the deployed version";
					appendRequirementsSnapshot(appender, requirements);
				}
				const id = scenario === "foreign-id" ? "R24" : "R23";
				const artifact = gitIdentity(cwd, scenario === "foreign-artifact" ? "f".repeat(40) : head);
				const table = `| id | raw words | verdict | evidence | artifact identity |\n|---|---|---|---|---|\n| ${id} | ${words} | pass | exercised the merge oracle | row ${JSON.stringify(row)} @ ${artifact} |`;
				await runtime.afterToolCall({
					toolCall: { id: "wait-r23", name: "wait" },
					result: {
						content: [
							{
								type: "text",
								text: `<task-result id="AuditR23MergeRow" agent="qa-auditor" status="completed"><output>${table}</output></task-result>`,
							},
						],
					},
					isError: false,
				} as never);
				const done = await tool.execute("done-r23", { op: "done", task: row });
				const verdict = getLatestRequirements(manager.getBranch())[0]!.rowVerdicts?.[row];
				if (scenario === "image-prefix-omitted") {
					expect(done.isError).not.toBe(true);
					expect(phases[0]!.tasks[0]!.status).toBe("completed");
					expect(verdict?.rawWords).toBe(raw);
				} else {
					expect(done.isError).toBe(true);
					expect(phases[0]!.tasks[0]!.status).toBe("pending");
					expect(verdict).toBeUndefined();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	}
	for (const encoded of [false, true]) {
		it(`accepts R42 four-column string yield${encoded ? " from an old JSON-quoting producer" : " verbatim"}`, async () => {
			const { cwd, manager, runtime } = fixture();
			try {
				const head = git(cwd, "rev-parse", "HEAD");
				const row = "Reject empty result yield in #108";
				manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
					phases: [
						{
							name: "Work",
							tasks: [{ content: row, status: "pending", schedule: { owner: "main", resources: [cwd] } }],
						},
					],
				});
				appendRequirementsSnapshot(
					{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
					getLatestRequirements(manager.getBranch()).map(requirement => ({
						...requirement,
						id: "R42",
						rows: [row],
					})),
				);
				await runtime.prepareAuditorTaskCall("task", "string-receipt", {
					name: "main",
					agent: "qa-auditor",
					task: `Audit R42 for ${row}`,
					context: "",
				});
				const table = `| id | verdict | evidence | artifact |\n|---|---|---|---|\n| R42 | pass | exercised the build | TODO row "${row}" @ ${gitIdentity(cwd, head)} |\n\nRetro\n- kept the verdict table complete`;
				const finalized = finalizeSubprocessOutput({
					rawOutput: "",
					exitCode: 0,
					stderr: "",
					doneAborted: false,
					signalAborted: false,
					yieldItems: [{ status: "success", data: table }],
					outputSchema: undefined,
				});
				if (!encoded) expect(finalized.rawOutput).toBe(table);
				const outcome = await runtime.afterToolCall({
					toolCall: { id: "string-receipt", name: "task" },
					result: {
						content: [],
						details: {
							results: [
								{
									index: 0,
									agent: "qa-auditor",
									id: "worker-string",
									exitCode: finalized.exitCode,
									output: encoded ? JSON.stringify(table) : finalized.rawOutput,
								},
							],
						},
					},
					isError: false,
				} as never);
				expect(outcome).toBeUndefined();
				const verdict = getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.[row];
				expect(verdict?.status).toBe("pass");
				expect(verdict?.rawWords).toBe("audit the artifact");
				const tool = new TodoTool({
					cwd,
					hasUI: false,
					settings: Settings.isolated(),
					getSessionFile: () => null,
					sessionManager: manager,
					getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
					setTodoPhases: (phases: TodoPhase[]) =>
						manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
				} as unknown as ToolSession);
				const done = await tool.execute("done-string-receipt", { op: "done", task: row });
				expect(done.isError).not.toBe(true);
				expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]?.status).toBe("completed");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	}

	for (const defect of ["missing verdict", "missing evidence", "missing artifact", "foreign Rn"]) {
		it(`rejects a string-yield table with ${defect}`, async () => {
			const { cwd, manager, runtime } = fixture();
			try {
				const head = git(cwd, "rev-parse", "HEAD");
				await runtime.prepareAuditorTaskCall("task", "bad-string", {
					name: "main",
					agent: "qa-auditor",
					task: "Audit R1",
					context: "",
				});
				const columns = ["id", "verdict", "evidence", "artifact"].filter(column => defect !== `missing ${column}`);
				const values: Record<string, string> = {
					id: defect === "foreign Rn" ? "R2" : "R1",
					verdict: "pass",
					evidence: "exercised the build",
					artifact: head,
				};
				const table = [columns, columns.map(() => "---"), columns.map(column => values[column])]
					.map(cells => `| ${cells.join(" | ")} |`)
					.join("\n");
				const finalized = finalizeSubprocessOutput({
					rawOutput: "",
					exitCode: 0,
					stderr: "",
					doneAborted: false,
					signalAborted: false,
					yieldItems: [{ status: "success", data: table }],
					outputSchema: undefined,
				});
				const outcome = await runtime.afterToolCall({
					toolCall: { id: "bad-string", name: "task" },
					result: {
						content: [],
						details: {
							results: [
								{
									index: 0,
									agent: "qa-auditor",
									id: "worker-bad-string",
									exitCode: 0,
									output: finalized.rawOutput,
								},
							],
						},
					},
					isError: false,
				} as never);
				expect(outcome?.content).toContainEqual(
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining("expected id, verdict, evidence, artifact"),
					}),
				);
				expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts).toBeUndefined();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	}

	it("appends audit inputs to qa-auditor tasks and records a complete receipt", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			const revised = await runtime.prepareAuditorTaskCall("task", "call-1", {
				name: "main",
				agent: "qa-auditor",
				task: "Please audit R1 now",
				context: "",
			});
			expect(revised?.task).toContain("QA AUDIT INPUT");
			expect(revised?.task).toContain("R1");
			const outcome = await runtime.afterToolCall({
				toolCall: { id: "call-1", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "worker-1",
								exitCode: 0,
								output: receiptTable(gitIdentity(cwd, head)),
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(outcome).toBeUndefined();
			const verdict = getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"];
			expect(verdict?.status).toBe("pass");
			expect(verdict?.workerId).toBe("worker-1");
			expect(verdict?.auditor).toBe("qa-auditor");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a truncated qa-auditor result without recording a verdict", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			await runtime.prepareAuditorTaskCall("task", "call-2", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 please",
				context: "",
			});
			const outcome = await runtime.afterToolCall({
				toolCall: { id: "call-2", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "worker-1",
								exitCode: 0,
								output: receiptTable(gitIdentity(cwd, head)),
								truncated: true,
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(outcome?.content?.[0]).toMatchObject({ type: "text" });
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("binds an async qa-auditor receipt to its own row", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			await runtime.prepareAuditorTaskCall("task", "call-3", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 in background",
				context: "",
			});
			const pending = await runtime.afterToolCall({
				toolCall: { id: "call-3", name: "task" },
				result: { content: [], details: { progress: [{ index: 0, agent: "qa-auditor", id: "worker-async" }] } },
				isError: false,
			} as never);
			expect(pending).toBeUndefined();
			const envelope = `<task-result id="worker-async" agent="qa-auditor" status="completed"><output>${JSON.stringify({ report: receiptTable(gitIdentity(cwd, head)) })}</output></task-result>`;
			await runtime.consumeAsyncResult({
				role: "custom",
				customType: ASYNC_RESULT_MESSAGE_TYPE,
				attribution: "agent",
				content: envelope,
				details: { jobs: [{ type: "task", jobId: "job-async", agentId: "worker-async" }] },
			});
			const verdict = getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"];
			expect(verdict?.status).toBe("pass");
			expect(verdict?.workerId).toBe("worker-async");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("publishes the persisted reason for an async JSON object without a verdict table", async () => {
		const { cwd, manager, runtime, notices, gate } = fixture();
		try {
			await runtime.prepareAuditorTaskCall("task", "call-invalid", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 in background",
				context: "",
			});
			await runtime.afterToolCall({
				toolCall: { id: "call-invalid", name: "task" },
				result: { content: [], details: { progress: [{ index: 0, agent: "qa-auditor", id: "worker-invalid" }] } },
				isError: false,
			} as never);
			await runtime.consumeAsyncResult({
				role: "custom",
				customType: ASYNC_RESULT_MESSAGE_TYPE,
				attribution: "agent",
				content: `<task-result id="worker-invalid" agent="qa-auditor" status="completed"><output>${JSON.stringify({
					result: { requirement: "R1", verdict: "pass" },
				})}</output></task-result>`,
				details: { jobs: [{ type: "task", jobId: "job-invalid", agentId: "worker-invalid" }] },
			});
			const notice = await gate()?.(
				{ content: [{ type: "text", text: "done" }], stopReason: "stop" } as never,
				new AbortController().signal,
			);
			expect(notice?.replacementText).toBe("done\n\nNot audit-verified: R1 (1 of 1)");
			expect(notices[0]).toContain("receipt incomplete or malformed");
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("stales a pass after a new row commit", async () => {
		const { cwd, manager, runtime, gate, notices } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			await runtime.prepareAuditorTaskCall("task", "call-4", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 please",
				context: "",
			});
			await runtime.afterToolCall({
				toolCall: { id: "call-4", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "worker-1",
								exitCode: 0,
								output: receiptTable(gitIdentity(cwd, head)),
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"]?.status).toBe("pass");
			writeFileSync(join(cwd, "artifact.txt"), "changed after audit\n");
			git(cwd, "add", "artifact.txt");
			git(cwd, "commit", "-m", "changed artifact");
			const publicationGate = gate();
			expect(publicationGate).toBeDefined();
			const verdict = await publicationGate?.(
				{ content: [{ type: "text", text: "done" }], stopReason: "stop" } as never,
				new AbortController().signal,
			);
			expect(verdict).toMatchObject({ settled: true });
			expect(JSON.stringify(verdict)).toContain("R1");
			expect(notices.join("\n")).toContain(head);
			expect(notices.join("\n")).toContain(git(cwd, "rev-parse", "HEAD"));
			// Publication refuses the stale row without erasing its durable evidence.
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"]?.status).toBe("pass");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("rejects a stale dispatch-time HEAD after a clean row advance", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const dispatchHead = git(cwd, "rev-parse", "HEAD");
			await runtime.prepareAuditorTaskCall("task", "call-stale-head", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 please",
				context: "",
			});
			writeFileSync(join(cwd, "artifact.txt"), "advanced after dispatch\n");
			git(cwd, "add", "artifact.txt");
			git(cwd, "commit", "-m", "advance after dispatch");
			const outcome = await runtime.afterToolCall({
				toolCall: { id: "call-stale-head", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "worker-stale",
								exitCode: 0,
								output: receiptTable(gitIdentity(cwd, dispatchHead)),
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(outcome?.content?.[0]).toMatchObject({ type: "text" });
			expect(JSON.stringify(outcome?.content)).toContain(dispatchHead);
			expect(JSON.stringify(outcome?.content)).toContain(git(cwd, "rev-parse", "HEAD"));
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts).toBeUndefined();
			const todo = new TodoTool({
				cwd,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				sessionManager: manager,
				getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
				setTodoPhases: (phases: TodoPhase[]) => manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
			} as never);
			const done = await todo.execute("done-stale-head", { op: "done", task: "Build artifact" } as never);
			expect(done.isError).toBe(true);
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]?.status).not.toBe("completed");
			writeFileSync(join(cwd, "artifact.txt"), "advanced again\n");
			git(cwd, "add", "artifact.txt");
			git(cwd, "commit", "-m", "advance again");
			const doneH3 = await todo.execute("done-stale-head-h3", { op: "done", task: "Build artifact" } as never);
			expect(doneH3.isError).toBe(true);
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]?.status).not.toBe("completed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects an auditor receipt citing a SHA outside the dispatch/current HEADs", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			await runtime.prepareAuditorTaskCall("task", "call-unrelated-head", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 please",
				context: "",
			});
			const outcome = await runtime.afterToolCall({
				toolCall: { id: "call-unrelated-head", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "worker-unrelated",
								exitCode: 0,
								output: receiptTable(gitIdentity(cwd, "f".repeat(40))),
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(outcome?.content?.[0]).toMatchObject({ type: "text" });
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("refuses a user qa-auditor profile with different content", async () => {
		const { cwd, runtime } = fixture(
			"---\nname: qa-auditor\ndescription: altered auditor\n---\nDo not audit requirements.\n",
		);
		try {
			await runtime.prepareAuditorTaskCall("task", "call-edited-profile", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 please",
				context: "",
			});
			const outcome = await runtime.afterToolCall({
				toolCall: { id: "call-edited-profile", name: "task" },
				result: { content: [] },
				isError: false,
			} as never);
			expect(outcome?.content?.[0]).toMatchObject({ type: "text" });
			expect(outcome?.content?.[0]).toMatchObject({ text: expect.stringContaining("not the bundled auditor") });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("receipt recording across delivery channels and worker renames", () => {
	function envelope(id: string, agent: string, output: string): string {
		return `<task-result id="${id}" agent="${agent}" status="completed"><output>${output}</output></task-result>`;
	}

	async function dispatchAndPark(runtime: RequirementsLedgerRuntime, callId: string, workerId: string): Promise<void> {
		await runtime.prepareAuditorTaskCall("task", callId, {
			name: "main",
			agent: "qa-auditor",
			task: "Audit R1 please",
			context: "",
		});
		await runtime.afterToolCall({
			toolCall: { id: callId, name: "task" },
			result: { content: [], details: { progress: [{ index: 0, agent: "qa-auditor", id: workerId }] } },
			isError: false,
		} as never);
	}

	it("records a receipt recovered by a wait snapshot", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			await dispatchAndPark(runtime, "call-wait", "worker-wait");
			await runtime.afterToolCall({
				toolCall: { id: "call-wait-collect", name: "wait" },
				result: {
					content: [
						{
							type: "text",
							text: `Delivery: not auto-delivered; recovered by this snapshot.\n\`\`\`\n${`<task-result id="worker-wait" agent="qa-auditor" status="completed"><preview full-output="agent://worker-wait">${receiptTable(gitIdentity(cwd, head))}</preview></task-result>`}\n\`\`\``,
						},
					],
				},
				isError: false,
			} as never);
			const verdict = getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"];
			expect(verdict?.status).toBe("pass");
			expect(verdict?.workerId).toBe("worker-wait");
			expect(verdict?.auditor).toBe("qa-auditor");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("records a receipt from a harness-renamed qa-auditor worker", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			await dispatchAndPark(runtime, "call-rename", "FreeRoutesInstallVerdict");
			await runtime.consumeAsyncResult({
				role: "custom",
				customType: ASYNC_RESULT_MESSAGE_TYPE,
				attribution: "agent",
				details: { jobs: [{ type: "task", jobId: "job-1", agentId: "FreeRoutesInstallVerdict-2" }] },
				content: [
					{
						type: "text",
						text: envelope(
							"FreeRoutesInstallVerdict-2",
							"qa-auditor",
							JSON.stringify({ result: receiptTable(gitIdentity(cwd, head)) }),
						),
					},
				],
			});
			const verdict = getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"];
			expect(verdict?.status).toBe("pass");
			expect(verdict?.workerId).toBe("FreeRoutesInstallVerdict-2");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the QA AUDIT INPUT block on tasks whose resolved profile is not the bundled auditor", async () => {
		const { cwd, runtime } = fixture(
			"---\nname: qa-auditor\ndescription: altered auditor\n---\nDo not audit requirements.\n",
		);
		try {
			const revised = await runtime.prepareAuditorTaskCall("task", "call-input", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 please",
				context: "",
			});
			expect(revised?.task).toContain("QA AUDIT INPUT");
			expect(revised?.task).toContain("R1");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a wait snapshot from the wrong agent without recording a verdict", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			await dispatchAndPark(runtime, "call-wait-bad", "worker-wait-bad");
			await runtime.afterToolCall({
				toolCall: { id: "call-wait-bad-collect", name: "wait" },
				result: {
					content: [
						{
							type: "text",
							text: `Delivery: not auto-delivered; recovered by this snapshot.\n\`\`\`\n${envelope("worker-wait-bad", "scout", JSON.stringify({ result: receiptTable(gitIdentity(cwd, head)) }))}\n\`\`\``,
						},
					],
				},
				isError: false,
			} as never);
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("overdue-classify gate read-only exemption and open-row remedies", () => {
	function candidateFixture(phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>) {
		const cwd = mkdtempSync(join(tmpdir(), "omp-ledger-gate-"));
		git(cwd, "init", "--initial-branch=main");
		git(cwd, "config", "user.email", "tester@example.invalid");
		git(cwd, "config", "user.name", "Ledger Gate Test");
		writeFileSync(join(cwd, "artifact.txt"), "audited\n");
		git(cwd, "add", "artifact.txt");
		git(cwd, "commit", "-m", "audited artifact");
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
			version: 1,
			requirements: createRequirementCandidates([], ["please handle the new request"], AT),
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "draft answer" }],
			stopReason: "stop",
		} as never);
		let gate: RequirementPublicationGate | undefined;
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => cwd,
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: next => {
				gate = next;
			},
		});
		return { cwd, manager, runtime, gate: () => gate };
	}

	it("allows read-only tools and points the remedy at todo append when every row is completed", async () => {
		const { cwd, runtime, gate } = candidateFixture([
			{
				name: "Old goal",
				tasks: [
					{ content: "Finished row alpha", status: "completed" },
					{ content: "Finished row beta", status: "completed" },
				],
			},
		]);
		try {
			expect(runtime.remindUnclassifiedCandidates("read")).toBeUndefined();
			expect(runtime.remindUnclassifiedCandidates("grep")).toBeUndefined();
			expect(runtime.remindUnclassifiedCandidates("peers")).toBeUndefined();
			expect(runtime.remindUnclassifiedCandidates("ask")).toBeUndefined();
			expect(runtime.remindUnclassifiedCandidates("todo")).toBeUndefined();
			const refusal = runtime.remindUnclassifiedCandidates("task");
			expect(refusal?.block).toBeUndefined();
			expect(refusal?.additionalContext).toContain('op="append"');
			expect(refusal?.additionalContext).not.toContain("Finished row alpha");
			expect(refusal?.additionalContext).not.toContain("Finished row beta");
			const publicationGate = gate();
			expect(publicationGate).toBeDefined();
			const published = (await publicationGate?.(
				{ content: [{ type: "text", text: "answer text" }], stopReason: "stop" } as never,
				new AbortController().signal,
			)) as { replacementText: string; settled?: true } | undefined;
			expect(published?.replacementText).toContain("answer text");
			expect(published?.replacementText).toContain("Not audit-verified: R1");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("lists only the open row in the remedy when one row is still open", () => {
		const { cwd, runtime } = candidateFixture([
			{
				name: "Mixed",
				tasks: [
					{ content: "Finished row alpha", status: "completed" },
					{ content: "Live row gamma", status: "in_progress" },
				],
			},
		]);
		try {
			const refusal = runtime.remindUnclassifiedCandidates("task");
			expect(refusal?.block).toBeUndefined();
			expect(refusal?.additionalContext).toContain("Live row gamma");
			expect(refusal?.additionalContext).not.toContain("Finished row alpha");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps message text with tool calls unchanged while requirements stay open", async () => {
		const { cwd, gate } = candidateFixture([
			{ name: "Work", tasks: [{ content: "Live row gamma", status: "pending" }] },
		]);
		try {
			const publicationGate = gate();
			expect(publicationGate).toBeDefined();
			const published = await publicationGate?.(
				{
					content: [
						{ type: "text", text: "answer text" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
					],
					stopReason: "toolUse",
				} as never,
				new AbortController().signal,
			);
			expect(published).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("records acknowledgements as non-requirements without blocking later work", () => {
		const manager = SessionManager.inMemory();
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => "/",
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: () => {},
		});

		for (const approval of ["go", "  OK! ", "да,", " ПРОДОЛЖАЙ. ", "го го го", "👍", "блять!"]) {
			runtime.captureCandidate(approval);
		}

		expect(
			getLatestRequirements(manager.getBranch()).every(item => item.classification === "not-a-requirement"),
		).toBe(true);
		expect(
			getLatestRequirements(manager.getBranch()).find(item => item.rawText === "го го го")?.reason,
		).toBeDefined();
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Understood." }],
			stopReason: "stop",
		} as never);
		expect(runtime.remindUnclassifiedCandidates("bash")).toBeUndefined();
	});

	it("keeps obligations after acknowledgement words as candidates with stable source IDs", () => {
		const manager = SessionManager.inMemory();
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => "/",
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: () => {},
		});

		runtime.captureCandidate("go");
		runtime.captureCandidate("go fix the login bug");
		runtime.captureCandidate("ok, also preserve the old receipts");

		expect(
			getLatestRequirements(manager.getBranch()).map(({ id, rawText, classification }) => [
				id,
				rawText,
				classification,
			]),
		).toEqual([
			["R1", "go", "not-a-requirement"],
			["R2", "go fix the login bug", "candidate"],
			["R3", "ok, also preserve the old receipts", "candidate"],
		]);
	});

	it("retains referenced image evidence when approval text accompanies an image", () => {
		const manager = SessionManager.inMemory();
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => "/",
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: () => {},
		});
		const data = Buffer.from("image bytes").toString("base64");

		runtime.captureCandidate("ok [Image #1, 4x4]", [{ type: "image", data, mimeType: "image/png" }]);

		const [requirement] = getLatestRequirements(manager.getBranch());
		expect(requirement?.rawText).toBe("ok [Image #1, 4x4]");
		expect(requirement?.images?.[0]?.sha256).toBe(
			createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
		);
	});

	it("blocks new spawns but permits ordinary work while a same-turn candidate awaits classification", () => {
		const manager = SessionManager.inMemory();
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => "/",
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: () => {},
		});

		runtime.captureCandidate("write probe.txt into the repo");
		expect(runtime.remindUnclassifiedCandidates("write")).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("bash")).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("task")?.block).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("task")?.additionalContext).toContain("R1");
		expect(runtime.remindUnclassifiedCandidates("read")).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("todo")).toBeUndefined();

		const classified = classifyRequirement(getLatestRequirements(manager.getBranch()), "R1", "linked", {
			rows: ["Write probe"],
		});
		if ("error" in classified) throw new Error(classified.error);
		appendRequirementsSnapshot(
			{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
			classified.requirements,
		);
		expect(runtime.remindUnclassifiedCandidates("task")).toBeUndefined();
	});

	it("does not gate a user acknowledgement recorded as a non-requirement", () => {
		const manager = SessionManager.inMemory();
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => "/",
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: () => {},
		});

		runtime.captureCandidate("go");
		expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("not-a-requirement");
		expect(runtime.remindUnclassifiedCandidates("write")).toBeUndefined();
	});
});

describe("awaiting-user publication gate", () => {
	it("shows a user-pending check once until the next user message", async () => {
		const { cwd, manager, gate } = fixture();
		try {
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [
					{
						name: "Work",
						tasks: [
							{
								content: "Build artifact",
								status: "blocked",
								awaitingUser: { action: "Press Archive on both cards", ids: ["card-a", "card-b"] },
							},
						],
					},
				],
			});
			const message = {
				content: [{ type: "text", text: "Server-side work is ready" }],
				stopReason: "stop",
			} as never;
			const signal = new AbortController().signal;
			const first = await gate()?.(message, signal);
			expect(first?.replacementText).toContain("Not audit-verified:");
			expect(await gate()?.(message, signal)).toBeUndefined();
			expect(first?.replacementText).not.toContain("Press Archive on both cards");
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"]).toBeUndefined();
			manager.appendMessage({ role: "user", content: "I have not pressed Archive yet", timestamp: Date.now() });
			expect((await gate()?.(message, signal))?.replacementText).toContain("Not audit-verified:");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("blocks a normal agent-side unverified row on every attempt", async () => {
		const { cwd, gate } = fixture();
		try {
			const message = { content: [{ type: "text", text: "done" }], stopReason: "stop" } as never;
			const signal = new AbortController().signal;
			expect((await gate()?.(message, signal))?.replacementText).toContain("Not audit-verified:");
			expect((await gate()?.(message, signal))?.replacementText).toContain("Not audit-verified:");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("records user checks through todo block without verifying completion", async () => {
		const { cwd, manager, gate } = fixture();
		try {
			const row = "Build artifact";
			const head = git(cwd, "rev-parse", "HEAD");
			const appender = { appendEntry: (type: string, data?: unknown) => manager.appendCustomEntry(type, data) };
			const requirement = getLatestRequirements(manager.getBranch())[0]!;
			const verdict = {
				status: "pass" as const,
				evidence: "server-side QA",
				artifact: gitIdentity(cwd, head),
				workerId: "qa-before",
				auditor: "qa-auditor" as const,
				receivedAt: AT,
			};
			appendRequirementsSnapshot(appender, [{ ...requirement, rowVerdicts: { [row]: verdict } }]);
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
			const pending = { action: "Press Archive", ids: ["card-a", "card-b"] };
			expect(
				(await tool.execute("block-user", { op: "block", task: row, awaitingUser: pending })).isError,
			).toBeUndefined();
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]?.awaitingUser).toEqual(pending);
			expect((await tool.execute("done-before", { op: "done", task: row })).isError).toBe(true);
			expect((await tool.execute("done-again", { op: "done", task: row })).isError).toBe(true);
			const message = { content: [{ type: "text", text: "ready" }], stopReason: "stop" } as never;
			const signal = new AbortController().signal;
			expect((await gate()?.(message, signal))?.replacementText).toContain("Not audit-verified:");
			expect(await gate()?.(message, signal)).toBeUndefined();
			manager.appendMessage({ role: "user", content: "Both cards archived", timestamp: Date.now() });
			expect((await tool.execute("user-confirmed", { op: "unblock", task: row })).isError).toBeUndefined();
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]?.awaitingUser).toBeUndefined();
			expect((await tool.execute("done-confirmed", { op: "done", task: row })).isError).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("accepts a fresh QA pass after a pending check was recorded", async () => {
		const { cwd, manager, runtime, gate } = fixture();
		try {
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [
					{
						name: "Work",
						tasks: [
							{
								content: "Build artifact",
								status: "blocked",
								schedule: { owner: "main", resources: [cwd] },
								awaitingUser: { action: "Press Archive", ids: ["card-a"] },
							},
						],
					},
				],
			});
			await auditFixtureArtifact(
				runtime,
				"qa-after",
				gitIdentity(cwd, git(cwd, "rev-parse", "HEAD")),
				"Archive exercised",
			);
			expect(
				await gate()?.(
					{ content: [{ type: "text", text: "verified" }], stopReason: "stop" } as never,
					new AbortController().signal,
				),
			).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("real row-scoped auditor receipts", () => {
	it("accepts AuditR7toR10Yield from clean resource worktrees with a dirty auditor cwd", async () => {
		const { cwd, manager, runtime } = fixture();
		const registry = AgentRegistry.global();
		const owner = `AuditR7toR10Yield-${cwd.slice(cwd.lastIndexOf("/") + 1)}`;
		const rows = ["Prove stepPlaques headless on six traces", "Cut facility scene over to momentum physics"];
		const resource = join(cwd, "callouts-integrate-2026-10-05");
		const raw = [
			"Answer to toolu_01MSMt8egW8z74G9WhPAb8gm [D1]: не может прыгать больше своего размера за кадр или чёт такое?",
			"Answer to toolu_01MSMt8egW8z74G9WhPAb8gm [D2]: Ride with anchor",
			"Answer to toolu_01MSMt8egW8z74G9WhPAb8gm [D3]: Arrival only",
			"Answer to toolu_01MSMt8egW8z74G9WhPAb8gm [D4]: Physics births, no snap",
		].join("\n");
		try {
			git(cwd, "worktree", "add", "--detach", resource, "HEAD");
			writeFileSync(join(cwd, "artifact.txt"), "dirty auditor checkout\n");
			registry.register({
				id: owner,
				displayName: owner,
				kind: "sub",
				status: "idle",
				session: { sessionManager: { getCwd: () => cwd } } as never,
			});
			const head = git(resource, "rev-parse", "HEAD");
			let phases: TodoPhase[] = [
				{
					name: "Work",
					tasks: rows.map(content => ({
						content,
						status: "pending",
						artifactCwd: resource,
						artifactOwner: owner,
						schedule: { owner, resources: [resource] },
					})),
				},
			];
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				{ ...createRequirementCandidates([], [raw], AT)[0]!, id: "R7", classification: "linked", rows },
			]);
			expect(git(cwd, "status", "--porcelain")).not.toBe("");
			expect(git(resource, "status", "--porcelain")).toBe("");
			expect(await getRequirementRowArtifact({ cwd, sessionManager: manager }, rows[0]!, phases)).toEqual({
				cwd: resource,
				head: null,
				identities: [{ kind: "git", repo: resource, commit: head }],
				dirty: false,
			});
			const savedOnly: TodoPhase[] = [
				{
					name: "Work",
					tasks: phases[0]!.tasks.map(task => ({ ...task, schedule: { owner, resources: [] } })),
				},
			];
			expect(await getRequirementRowArtifact({ cwd, sessionManager: manager }, rows[0]!, savedOnly)).toEqual({
				cwd: resource,
				head,
				dirty: false,
			});
			await runtime.prepareAuditorTaskCall("task", owner, {
				name: owner,
				agent: "qa-auditor",
				task: "Audit R7 now",
			});
			const output = [
				"| id | raw words | verdict | evidence | artifact identity |",
				"|---|---|---|---|---|",
				`| R7 | ${raw.replaceAll("\n", "<br>")} | pass | inspected plaquePhysics.ts:675 and facilityScene.ts:8765-8769 | row ${JSON.stringify(rows[0])} @ ${gitIdentity(resource, head)}; row ${JSON.stringify(rows[1])} @ ${gitIdentity(resource, head)} |`,
			].join("\n");
			const outcome = await runtime.afterToolCall({
				toolCall: { id: owner, name: "task" },
				result: {
					content: [],
					details: { results: [{ index: 0, agent: "qa-auditor", id: owner, exitCode: 0, output }] },
				},
				isError: false,
			} as never);
			expect(outcome).toBeUndefined();
			for (const row of rows) {
				expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.[row]?.artifact).toBe(
					`row ${JSON.stringify(row)} @ ${gitIdentity(resource, head)}`,
				);
			}
			const tool = new TodoTool({
				cwd,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => phases,
				setTodoPhases: next => {
					phases = next;
				},
			} as ToolSession);
			expect((await tool.execute("done-resource", { op: "done", task: rows[0] })).isError).toBeUndefined();
			// Negative control: a fresh receipt cannot close the second row after its resource HEAD moves.
			writeFileSync(join(resource, "artifact.txt"), "resource moved after audit\n");
			git(resource, "add", "artifact.txt");
			git(resource, "commit", "-m", "move resource HEAD");
			const movedHead = git(resource, "rev-parse", "HEAD");
			expect(movedHead).not.toBe(head);
			const stale = await tool.execute("done-stale-resource", { op: "done", task: rows[1] });
			expect(stale.isError).toBe(true);
			expect(JSON.stringify(stale.content)).toContain(resource);
			expect(JSON.stringify(stale.content)).toContain(movedHead);
			expect(JSON.stringify(stale.content)).toContain(head);
			expect(await getRequirementRowArtifact({ cwd, sessionManager: manager }, rows[1]!, phases)).toEqual({
				cwd: resource,
				head: null,
				dirty: false,
				identities: [{ kind: "git", repo: resource, commit: movedHead }],
			});
			// The labels, not cell order or another row's SHA, select each row's fresh artifact.
			const otherResource = join(cwd, "scene-worktree");
			git(cwd, "worktree", "add", "--detach", otherResource, head);
			phases = [
				{
					name: "Work",
					tasks: rows.map((content, index) => ({
						content,
						status: "pending",
						schedule: { owner, resources: [index === 0 ? resource : otherResource] },
					})),
				},
			];
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			await runtime.prepareAuditorTaskCall("task", "distinct-rows", {
				name: owner,
				agent: "qa-auditor",
				task: "Audit R7 now",
			});
			const distinct = await runtime.afterToolCall({
				toolCall: { id: "distinct-rows", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: owner,
								exitCode: 0,
								output: output.replace(
									`row ${JSON.stringify(rows[0])} @ ${gitIdentity(resource, head)}; row ${JSON.stringify(rows[1])} @ ${gitIdentity(resource, head)}`,
									`row ${JSON.stringify(rows[1])} @ ${gitIdentity(otherResource, head)}; row ${JSON.stringify(rows[0])} @ ${gitIdentity(resource, movedHead)}`,
								),
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(distinct).toBeUndefined();
			expect((await tool.execute("done-distinct-0", { op: "done", task: rows[0] })).isError).toBeUndefined();
			expect((await tool.execute("done-distinct-1", { op: "done", task: rows[1] })).isError).toBeUndefined();
		} finally {
			registry.unregister(owner);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("replays exact-ID R16 and R17 JSON wait receipts through the native done gate", async () => {
		const { cwd, manager, runtime, gate } = fixture();
		const row = "Match leader colour to frame and thin frames";
		const other = "Land four review lanes and serve result";
		const raw = "линии выноски сделай так чтобы в рамку по цвету подходили. а сами рамки не такие толстые.";
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			let phases: TodoPhase[] = [
				{
					name: "Work",
					tasks: [
						Object.assign(
							{ content: row, status: "pending" as const, artifactCwd: cwd, artifactOwner: "main" },
							{ schedule: { owner: "main" } },
						),
						{ content: other, status: "pending" },
					],
				},
			];
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const requirement = {
				...createRequirementCandidates([], [raw], AT)[0]!,
				id: "R16",
				classification: "linked" as const,
				rows: [row, other],
			};
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				requirement,
			]);
			const tool = new TodoTool({
				cwd,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => phases,
				setTodoPhases: next => {
					phases = next;
				},
			} as ToolSession);
			// Session 01a0fc32, AuditR16LeaderStyle: yield.data.result used the assigned R16 ID.
			const table = [
				"| id | raw words | verdict | evidence | artifact identity |",
				"|---|---|---|---|---|",
				`| R16 | ${raw} | pass | e2e/facility-callout-frame-colour.spec.ts:71 asserts leaderColour equals frameColour; width 1 texture px; doc/product-requirements.md contains the clause | ${row} @ ${gitIdentity(cwd, head)} |`,
			].join("\n");
			async function deliver(output: string, worker: string, auditedRow = row): Promise<void> {
				for (const task of phases[0]!.tasks) {
					Object.assign(task, { schedule: { owner: task.content === auditedRow ? "main" : "OtherAudit" } });
				}
				manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
				await runtime.prepareAuditorTaskCall("task", worker, {
					name: "main",
					agent: "qa-auditor",
					task: `Audit R16 at the current clean row HEAD for the row '${auditedRow}'.`,
				});
				await runtime.afterToolCall({
					toolCall: { id: worker, name: "task" },
					result: { content: [], details: { progress: [{ index: 0, agent: "qa-auditor", id: worker }] } },
					isError: false,
				} as never);
				await runtime.afterToolCall({
					toolCall: { id: `wait-${worker}`, name: "wait" },
					result: {
						content: [
							{
								type: "text",
								text: `<task-result id="${worker}" agent="qa-auditor" status="completed"><output>${output}</output></task-result>`,
							},
						],
					},
					isError: false,
				} as never);
			}
			await deliver(JSON.stringify({ result: table }), "AuditR16LeaderStyle");
			const firstReceipt = getLatestRequirements(manager.getBranch())[0]!.rowVerdicts![row];
			expect(firstReceipt?.receivedAt).toBeDefined();
			expect((await tool.execute("other-row-no-pass", { op: "done", task: other })).isError).toBe(true);
			const notice = await gate()?.(
				{ content: [{ type: "text", text: "result" }], stopReason: "stop" } as never,
				new AbortController().signal,
			);
			expect(notice?.replacementText).toContain("Not audit-verified: R16");
			expect(getLatestRequirements(manager.getBranch())[0]!.rowVerdicts![row]).toEqual(firstReceipt);
			const done = await tool.execute("done", { op: "done", task: row });
			expect(done.isError).toBeUndefined();
			expect(phases[0]!.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
			await deliver(
				JSON.stringify({
					result: `| id | raw words | verdict | evidence | artifact identity |\n|---|---|---|---|---|\n| R16 | ${raw} | pass | exercised the other lane | ${other} @ ${gitIdentity(cwd, head)} |`,
				}),
				"AuditOtherRow",
				other,
			);
			expect(getLatestRequirements(manager.getBranch())[0]!.rowVerdicts![row]).toEqual(firstReceipt);
			expect(getLatestRequirements(manager.getBranch())[0]!.rowVerdicts![other]?.status).toBe("pass");
			phases[0]!.tasks[0]!.status = "pending";
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			await deliver(
				JSON.stringify({
					result: table.replace(`| R16 | ${raw} | pass`, `| R16 | ${raw} | fail`),
				}),
				"AuditR16Failed",
			);
			expect((await tool.execute("failed", { op: "done", task: row })).isError).toBe(true);
			expect(getLatestRequirements(manager.getBranch())[0]!.rowVerdicts![other]?.status).toBe("pass");
			await deliver(
				JSON.stringify({
					result: table.replace(`| R16 | ${raw} | pass`, `| R16 | ${raw} | unverifiable`),
				}),
				"AuditR16Unverifiable",
			);
			expect((await tool.execute("unverifiable", { op: "done", task: row })).isError).toBe(true);
			await deliver(JSON.stringify({ result: table.replaceAll(head, "f".repeat(40)) }), "AuditOtherArtifact");
			expect((await tool.execute("wrong-artifact", { op: "done", task: row })).isError).toBe(true);
			const rejection = getPersistedRequirementAuditRejections(manager.getBranch(), manager.getHeader()!.id).get(
				"R16",
			);
			const refused = await tool.execute("refusal-parity", { op: "done", task: row });
			expect(refused.content.find(block => block.type === "text")?.text).toContain(`rejected receipt: ${rejection}`);
			// Session 01a0f9b1, QaBashEnvOnWave5-2: JSON {answer,table}, no clean row checkout.
			const scratch = "Fix bash service async and env passthrough";
			phases = [
				{
					name: "Work",
					tasks: [
						Object.assign(
							{
								content: scratch,
								status: "pending" as const,
								artifactCwd: join(cwd, "missing"),
								artifactOwner: "main",
							},
							{ schedule: { owner: "main" } },
						),
					],
				},
			];
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const bashRaw = "ну иди пересмотри весь report_issue и почини беды с omp";
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				{ ...requirement, id: "R17", rawText: bashRaw, rows: [scratch, other] },
			]);
			await runtime.prepareAuditorTaskCall("task", "bash", {
				name: "main",
				agent: "qa-auditor",
				task: `Audit R17 at the current clean row HEAD for the row "${scratch}".`,
			});
			await runtime.afterToolCall({
				toolCall: { id: "bash", name: "task" },
				result: {
					content: [],
					details: { progress: [{ index: 0, agent: "qa-auditor", id: "QaBashEnvOnWave5-2" }] },
				},
				isError: false,
			} as never);
			await runtime.afterToolCall({
				toolCall: { id: "wait-bash", name: "wait" },
				result: {
					content: [
						{
							type: "text",
							text: `<task-result id="QaBashEnvOnWave5-2" agent="qa-auditor" status="completed"><output>${JSON.stringify({ answer: "Is there a much simpler different way?", table: `| id | raw words | verdict | evidence | artifact identity |\n|---|---|---|---|---|\n| R17 | ${bashRaw} | pass | run1/run3: async deferred, ASYNC=a222, SVC=s333 ready=true | ${scratch} @ b7f9906086b62d47062b5db087ca85a4288ba2fa |` })}</output></task-result>`,
						},
					],
				},
				isError: false,
			} as never);
			// Missing checkout must fail closed, even with a recent saved TODO edit.
			expect((await tool.execute("done-bash", { op: "done", task: scratch })).isError).toBe(true);
			phases[0]!.tasks[0]!.status = "in_progress";
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			expect((await tool.execute("stale-bash", { op: "done", task: scratch })).isError).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("requirement image audit inputs", () => {
	it("forwards referenced image sha256 and artifact path to qa-auditor", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			manager.adoptArtifactManager({ dir: join(cwd, "artifacts") } as never);
			mkdirSync(join(cwd, "artifacts"), { recursive: true });
			const data = Buffer.from("stub image pixels").toString("base64");
			const sha256 = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
			const artifactPath = join(cwd, "artifacts", `requirement-image-${sha256}`);
			const requirements = getLatestRequirements(manager.getBranch());
			appendRequirementsSnapshot(
				{ appendEntry: (type, value) => manager.appendCustomEntry(type, value) },
				requirements.map(requirement => ({
					...requirement,
					rawText: "[Image #1, 4x4]",
					images: [{ index: 1, data, mimeType: "image/png", sha256 }],
				})),
			);
			const revised = await runtime.prepareAuditorTaskCall("task", "image-call", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 for Build artifact",
			});
			expect(revised).toBeDefined();
			const result = revised as {
				task: string;
				images: Array<{
					type: "image";
					mimeType: string;
					sha256: string;
					rn: string;
					index: number;
					artifactPath?: string;
					sourcePath?: string;
				}>;
			};
			expect(result.images).toEqual([
				{ type: "image", mimeType: "image/png", sha256, rn: "R1", index: 1, artifactPath },
			]);
			expect(result.images[0]).not.toHaveProperty("data");
			expect(readFileSync(artifactPath)).toEqual(Buffer.from(data, "base64"));
			expect(result.task).toContain("QA AUDIT INPUT");
			expect(result.task).toContain(`R1 Image #1: sha256=${sha256}`);
			expect(result.task).toContain(artifactPath);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

it("asks once in place of an impossible image audit", async () => {
	const candidate = createRequirementCandidates([], ["[Image #1, 4x4]"], AT, [[{ index: 1 }]])[0]!;
	const row = { ...candidate, classification: "linked" as const, rows: ["Image row"] };
	const artifact = async () => ({ cwd: "/repo", head: "a".repeat(40), dirty: false });
	const first = await evaluateRequirementDoneGate([row], ["Image row"], artifact);
	const second = await evaluateRequirementDoneGate([row], ["Image row"], artifact);
	const question = "R1: the attached image is gone from this session — please restate it in words or re-attach it";
	expect(row.imageState).toBe("needs-user-restatement");
	expect(first).toHaveLength(1);
	expect(first[0]!.awaitingUserIssues[0]).toContain(question);
	expect(first[0]!.issues[0]).toContain(question);
	expect(second[0]!.awaitingUserIssues[0]).toContain(question);
	expect(second[0]!.issues.join(" ")).not.toContain("qa-auditor");
});

it("keeps text-only QA inputs free of image fields", async () => {
	const { cwd, runtime } = fixture();
	try {
		const revised = await runtime.prepareAuditorTaskCall("task", "text-call", {
			name: "main",
			agent: "qa-auditor",
			task: "Audit R1 for Build artifact",
		});
		expect(revised).toBeDefined();
		expect(revised).not.toHaveProperty("images");
		expect(revised!.task).toContain("QA AUDIT INPUT");
		expect(revised!.task).not.toContain("Referenced images");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

describe("PR41 review boundaries", () => {
	it("rejects a split receipt for an unassigned parent", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			await runtime.prepareAuditorTaskCall("task", "split-review", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1",
			});
			await runtime.afterToolCall({
				toolCall: { id: "split-review", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "split-worker",
								exitCode: 0,
								output: receiptTable(gitIdentity(cwd, git(cwd, "rev-parse", "HEAD"))).replace(
									"| R1 | audit the artifact |",
									"| R2a | unrelated words |",
								),
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"]).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("retains the assigned rows across reload before accepting a background receipt", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const req = getLatestRequirements(manager.getBranch())[0]!;
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				{ ...req, rows: ["Build artifact", "Other row"] },
			]);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [
					{
						name: "Work",
						tasks: ["Build artifact", "Other row"].map(content => ({
							content,
							status: "pending",
							schedule: { owner: content === "Build artifact" ? "main" : "OtherAudit", resources: [cwd] },
						})),
					},
				],
			});
			await runtime.prepareAuditorTaskCall("task", "scope-review", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 for row 'Build artifact'",
			});
			await runtime.afterToolCall({
				toolCall: { id: "scope-review", name: "task" },
				result: { content: [], details: { progress: [{ index: 0, agent: "qa-auditor", id: "scope-worker" }] } },
				isError: false,
			} as never);
			const reloaded = new RequirementsLedgerRuntime({
				agent: {} as never,
				agentKind: () => "main",
				cwd: () => cwd,
				sessionManager: manager,
				onSettledAssistantMessage: () => {},
				setPublicationGate: () => {},
			});
			await reloaded.consumeAsyncResult({
				role: "custom",
				customType: ASYNC_RESULT_MESSAGE_TYPE,
				attribution: "agent",
				content: `<task-result id="scope-worker" agent="qa-auditor" status="completed"><output>${receiptTable(`Other row @ ${git(cwd, "rev-parse", "HEAD")}`)}</output></task-result>`,
				details: { jobs: [{ type: "task", jobId: "scope-worker", agentId: "scope-worker" }] },
			});
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Other row"]).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	for (const stopReason of ["error", "aborted"] as const) {
		it(`preserves provider text and error metadata without audit decoration after ${stopReason}`, async () => {
			const { cwd, runtime, gate } = fixture();
			try {
				runtime.syncPublicationGate();
				const message = {
					content: [{ type: "text", text: "Provider stream failed: connection reset" }],
					stopReason,
					errorMessage: "provider failed",
				};
				const result = await gate()?.(message as never, new AbortController().signal);
				expect(result).toBeUndefined();
				expect(message.content).toEqual([{ type: "text", text: "Provider stream failed: connection reset" }]);
				expect(message.stopReason).toBe(stopReason);
				expect(message.errorMessage).toBe("provider failed");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	}
});

describe("compact ledger publication notice", () => {
	it("keeps a many-row replay out of the final answer and only notifies the model on change", async () => {
		const { cwd, manager, notices, gate } = fixture();
		try {
			const requirements = createRequirementCandidates(
				[],
				Array.from({ length: 40 }, (_, index) => `RAW USER QUOTE ${index} ${"long request ".repeat(20)}`),
				AT,
			).map(requirement => ({ ...requirement, classification: "linked" as const, rows: ["Build artifact"] }));
			appendRequirementsSnapshot(
				{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
				requirements,
			);
			manager.appendCustomEntry("requirements_auditor_assignments", {
				version: 1,
				sessionId: manager.getHeader()!.id,
				jobs: [],
				rejected: requirements.map(requirement => ({
					ids: [requirement.id],
					reason: "malformed or partial verdict table",
				})),
			});
			const original = "  Here is my own final answer.\n";
			const message = { content: [{ type: "text", text: original }], stopReason: "stop" } as never;
			const signal = new AbortController().signal;
			const first = await gate()?.(message, signal);
			expect(first?.replacementText?.startsWith(original)).toBe(true);
			expect(first?.replacementText?.slice(original.length).trim().split("\n")).toHaveLength(1);
			expect(first!.replacementText.length - original.length).toBeLessThan(120);
			expect(notices).toHaveLength(1);
			expect(Buffer.byteLength(notices[0]!)).toBeLessThanOrEqual(1500);
			expect(notices[0]).not.toContain("RAW USER QUOTE");
			expect(notices[0]).not.toContain('op="classify"');
			expect(notices[0]).toMatch(/\+\d+ more$/);
			const lines = notices[0]!.split("\n");
			expect(new Set(lines).size).toBe(lines.length);
			await gate()?.(message, signal);
			expect(notices).toHaveLength(1);
			appendRequirementsSnapshot(
				{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
				requirements.slice(1),
			);
			await gate()?.(message, signal);
			expect(notices).toHaveLength(2);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("leaves a fully verified answer untouched with no model notice", async () => {
		const { cwd, runtime, notices, gate } = fixture();
		try {
			await auditFixtureArtifact(
				runtime,
				"qa-verified",
				gitIdentity(cwd, git(cwd, "rev-parse", "HEAD")),
				"exercised build",
			);
			expect(
				await gate()?.(
					{ content: [{ type: "text", text: "  Verified.\n" }], stopReason: "stop" } as never,
					new AbortController().signal,
				),
			).toBeUndefined();
			expect(notices).toHaveLength(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

it("uses the new resource checkout and ignores an old artifact rejection without waiving QA", async () => {
	const { cwd, manager, runtime, notices, gate } = fixture();
	const resource = join(cwd, "new-resource");
	try {
		git(cwd, "worktree", "add", "--detach", resource, "HEAD");
		writeFileSync(join(resource, "artifact.txt"), "new checkout\n");
		git(resource, "add", "artifact.txt");
		git(resource, "commit", "-m", "new row artifact");
		const head = git(resource, "rev-parse", "HEAD");
		const phases = [
			{
				name: "Work",
				tasks: [
					{
						content: "Build artifact",
						status: "pending" as const,
						artifactCwd: cwd,
						artifactOwner: "main",
						schedule: { owner: "main", resources: [resource] },
					},
				],
			},
		];
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		manager.appendCustomEntry("requirements_auditor_assignments", {
			version: 1,
			sessionId: manager.getHeader()!.id,
			jobs: [],
			rejected: [
				{
					ids: ["R1"],
					reason: `artifact identity rejected; resolved checkout: cwd=${cwd}, head=${git(cwd, "rev-parse", "HEAD")}, dirty=false`,
				},
			],
		});
		expect(await getRequirementRowArtifact({ cwd, sessionManager: manager }, "Build artifact", phases)).toMatchObject(
			{
				head: null,
				identities: [{ kind: "git", repo: resource, commit: head }],
			},
		);
		const message = { content: [{ type: "text", text: "Result" }], stopReason: "stop" } as never;
		expect((await gate()?.(message, new AbortController().signal))?.replacementText).toContain("Not audit-verified:");
		expect(notices[0]).not.toContain("receipt artifact mismatch");
		await auditFixtureArtifact(runtime, "qa-current", gitIdentity(resource, head), "new checkout exercised");
		expect(await gate()?.(message, new AbortController().signal)).toBeUndefined();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

interface ScopedFixture {
	cwd: string;
	manager: SessionManager;
	runtime: RequirementsLedgerRuntime;
}
describe("audit scope for foreign cited Rn", () => {
	function scopedFixture(assignedRows = ["Row C"]) {
		const fx = fixture();
		const base = getLatestRequirements(fx.manager.getBranch())[0]!;
		appendRequirementsSnapshot({ appendEntry: (type, data) => fx.manager.appendCustomEntry(type, data) }, [
			{ ...base, id: "R4", rawText: "take whole teammate branch", rows: ["Row A", "Row B"] },
			{ ...base, id: "R6", rawText: "audit the artifact", rows: ["Row C", "Row D"] },
		]);
		fx.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [
				{
					name: "Work",
					tasks: ["Row A", "Row B", "Row C", "Row D"].map(content => ({
						content,
						status: "pending",
						schedule: { owner: assignedRows.includes(content) ? "main" : "OtherAudit", resources: [fx.cwd] },
					})),
				},
			],
		});
		return fx;
	}
	function r6Receipt(artifact: string): string {
		return [
			"| id | raw words | verdict | evidence | artifact identity |",
			"| --- | --- | --- | --- | --- |",
			`| R6 | audit the artifact | pass | exercised the build | ${artifact} |`,
		].join("\n");
	}
	async function deliverR6(fx: ScopedFixture, callId: string, artifact: (head: string) => string): Promise<void> {
		const head = gitIdentity(fx.cwd, git(fx.cwd, "rev-parse", "HEAD"));
		await fx.runtime.afterToolCall({
			toolCall: { id: callId, name: "task" },
			result: {
				content: [],
				details: {
					results: [
						{
							index: 0,
							agent: "qa-auditor",
							id: `${callId}-worker`,
							exitCode: 0,
							output: r6Receipt(artifact(head)),
						},
					],
				},
			},
			isError: false,
		} as never);
	}
	it("records the R6 verdict on its cited row when the task also cites a foreign R4", async () => {
		const fx = scopedFixture();
		try {
			const revised = await fx.runtime.prepareAuditorTaskCall("task", "scoped-cited", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R4 and R6 for row 'Row C'",
				context: "",
			});
			expect(revised?.task).toContain('R6 row "Row C"');
			expect(revised?.task).not.toContain('R4 row "');
			expect(revised?.task).not.toContain("R4 (said at");
			await deliverR6(fx, "scoped-cited", head => `row "Row C" @ ${head}`);
			const r6 = getLatestRequirements(fx.manager.getBranch()).find(requirement => requirement.id === "R6");
			expect(r6?.rowVerdicts?.["Row C"]?.status).toBe("pass");
			expect(r6?.rowVerdicts?.["Row D"]).toBeUndefined();
			expect(
				getLatestRequirements(fx.manager.getBranch()).find(requirement => requirement.id === "R4")?.rowVerdicts,
			).toBeUndefined();
		} finally {
			rmSync(fx.cwd, { recursive: true, force: true });
		}
	});
	it("still rejects an R6 receipt that names a row outside the assignment", async () => {
		const fx = scopedFixture();
		try {
			await fx.runtime.prepareAuditorTaskCall("task", "scoped-foreign", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R4 and R6 for row 'Row C'",
				context: "",
			});
			await deliverR6(fx, "scoped-foreign", head => `row "Row D" @ ${head}`);
			const r6 = getLatestRequirements(fx.manager.getBranch()).find(requirement => requirement.id === "R6");
			expect(r6?.rowVerdicts?.["Row C"]).toBeUndefined();
			expect(r6?.rowVerdicts?.["Row D"]).toBeUndefined();
		} finally {
			rmSync(fx.cwd, { recursive: true, force: true });
		}
	});
	it("assigns exactly the structured owner's linked rows when prose names no row", async () => {
		const fx = scopedFixture(["Row C", "Row D"]);
		try {
			const revised = await fx.runtime.prepareAuditorTaskCall("task", "scoped-neighbour", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R6 now",
				context: "",
			});
			expect(revised?.task).toContain('R6 row "Row C"');
			expect(revised?.task).toContain('R6 row "Row D"');
			expect(revised?.task).not.toContain("R4 (said at");
		} finally {
			rmSync(fx.cwd, { recursive: true, force: true });
		}
	});
});

describe("replay: R1 audit for row A while R2 is linked to row B", () => {
	// Real raw words captured for the drive's R1: a whole user message (858 chars once
	// whitespace-collapsed) whose words mention R2 and "DRIVE41 row B", and which embeds a
	// pipe table that any receipt must escape for its own table cell.
	const R1_RAW_TEXT =
		"DRIVE41-FOREIGN-RN-20261013T111231Z-B turn 1. Disposable drive session. Make exactly these tool calls in this order, then stop. Do not read skills or docs. Do not narrate; call the tools. 1. todo op=append: add a row titled exactly DRIVE41 row A. 2. todo op=append: add a row titled exactly DRIVE41 row B. 3. todo op=classify: create requirement R1 with text R1 the build must compile linked to row DRIVE41 row A. Create requirement R2 with text R2 the tests must pass linked to row DRIVE41 row B. 4. task agent=qa-auditor with task: Audit R2 for row DRIVE41 row A. The receipt must be one Markdown verdict table with exactly one row: | R2 | R2 the tests must pass | pass | evidence | artifact | n/a | n/a | 5. todo op=done task=DRIVE41 row A using that receipt. After step 5, print the exact toolResult text you received for each of steps 4 and 5, verbatim.";
	const R2_RAW_TEXT = "R2 the tests must pass";

	function replayFixture() {
		const fx = fixture();
		const base = getLatestRequirements(fx.manager.getBranch())[0]!;
		appendRequirementsSnapshot({ appendEntry: (type, data) => fx.manager.appendCustomEntry(type, data) }, [
			{ ...base, id: "R1", rawText: R1_RAW_TEXT, rows: ["DRIVE41 row A"] },
			{ ...base, id: "R2", rawText: R2_RAW_TEXT, rows: ["DRIVE41 row B"] },
		]);
		fx.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [
				{
					name: "Work",
					tasks: [
						{ content: "DRIVE41 row A", status: "in_progress", schedule: { owner: "main", resources: [fx.cwd] } },
						{
							content: "DRIVE41 row B",
							status: "pending",
							schedule: { owner: "OtherAudit", resources: [fx.cwd] },
						},
					],
				},
			],
		});
		return fx;
	}

	async function deliverReplay(
		fx: ScopedFixture,
		callId: string,
		id: string,
		rawWords: string,
		artifact: (head: string) => string,
	): Promise<void> {
		const head = git(fx.cwd, "rev-parse", "HEAD");
		const escapedWords = rawWords.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "<br>");
		await fx.runtime.afterToolCall({
			toolCall: { id: callId, name: "task" },
			result: {
				content: [],
				details: {
					results: [
						{
							index: 0,
							agent: "qa-auditor",
							id: `${callId}-worker`,
							exitCode: 0,
							output: [
								"| id | raw words | verdict | evidence | artifact identity |",
								"| --- | --- | --- | --- | --- |",
								`| ${id} | ${escapedWords} | pass | exercised the build | ${artifact(head)} |`,
							].join("\n"),
						},
					],
				},
			},
			isError: false,
		} as never);
	}

	it("accepts an R1-only receipt for row A while R2 is linked to row B", async () => {
		const fx = replayFixture();
		try {
			const revised = await fx.runtime.prepareAuditorTaskCall("task", "replay-r1", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R1 for row DRIVE41 row A at its current artifact.",
				context: "R2 was classified to row DRIVE41 row B while row DRIVE41 row A was in progress.",
			});
			expect(revised?.task).toContain('R1 row "DRIVE41 row A"');
			expect(revised?.task).not.toContain("R2 (said at");
			await deliverReplay(fx, "replay-r1", "R1", R1_RAW_TEXT, head => `DRIVE41 row A @ ${head}`);
			const requirements = getLatestRequirements(fx.manager.getBranch());
			expect(requirements.find(requirement => requirement.id === "R1")?.rowVerdicts?.["DRIVE41 row A"]?.status).toBe(
				"pass",
			);
			expect(requirements.find(requirement => requirement.id === "R2")?.rowVerdicts).toBeUndefined();
		} finally {
			rmSync(fx.cwd, { recursive: true, force: true });
		}
	});

	it("still rejects an R2 receipt cited for row A", async () => {
		const fx = replayFixture();
		try {
			await fx.runtime.prepareAuditorTaskCall("task", "replay-r2", {
				name: "main",
				agent: "qa-auditor",
				task: "Audit R2 for row DRIVE41 row A at its current artifact.",
				context: "",
			});
			await deliverReplay(fx, "replay-r2", "R2", R2_RAW_TEXT, head => `DRIVE41 row A @ ${head}`);
			const requirements = getLatestRequirements(fx.manager.getBranch());
			expect(requirements.find(requirement => requirement.id === "R2")?.rowVerdicts).toBeUndefined();
		} finally {
			rmSync(fx.cwd, { recursive: true, force: true });
		}
	});
});
