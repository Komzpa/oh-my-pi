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
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	getPersistedRequirementAuditRejections,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
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

function receiptTable(head: string): string {
	return [
		"| id | raw words | verdict | evidence | artifact identity |",
		"| --- | --- | --- | --- | --- |",
		`| R1 | audit the artifact | pass | exercised the build | ${head} |`,
	].join("\n");
}

describe("requirements ledger auditor binding", () => {
	it("appends audit inputs to qa-auditor tasks and records a complete receipt", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			const revised = await runtime.prepareAuditorTaskCall("task", "call-1", {
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
						results: [{ index: 0, agent: "qa-auditor", id: "worker-1", exitCode: 0, output: receiptTable(head) }],
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
								output: receiptTable(head),
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
			const envelope = `<task-result id="worker-async" agent="qa-auditor" status="completed"><output>${JSON.stringify({ report: receiptTable(head) })}</output></task-result>`;
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
		const { cwd, manager, runtime, gate } = fixture();
		try {
			await runtime.prepareAuditorTaskCall("task", "call-invalid", {
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
			expect(JSON.stringify(notice)).toContain(
				"R1 needs a fresh qa-auditor pass; rejected receipt: R1: malformed or partial verdict table",
			);
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("stales a pass after a new row commit", async () => {
		const { cwd, manager, runtime, gate } = fixture();
		try {
			const head = git(cwd, "rev-parse", "HEAD");
			await runtime.prepareAuditorTaskCall("task", "call-4", {
				agent: "qa-auditor",
				task: "Audit R1 please",
				context: "",
			});
			await runtime.afterToolCall({
				toolCall: { id: "call-4", name: "task" },
				result: {
					content: [],
					details: {
						results: [{ index: 0, agent: "qa-auditor", id: "worker-1", exitCode: 0, output: receiptTable(head) }],
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
			// Publication refuses the stale row without erasing its durable evidence.
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"]?.status).toBe("pass");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("accepts the dispatch-time HEAD after a clean row advance and rejects unrelated SHAs", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const boundHead = git(cwd, "rev-parse", "HEAD");
			await runtime.prepareAuditorTaskCall("task", "call-bound-head", {
				agent: "qa-auditor",
				task: "Audit R1 please",
				context: "",
			});
			writeFileSync(join(cwd, "artifact.txt"), "advanced after dispatch\n");
			git(cwd, "add", "artifact.txt");
			git(cwd, "commit", "-m", "advance after dispatch");
			const accepted = await runtime.afterToolCall({
				toolCall: { id: "call-bound-head", name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: "worker-bound",
								exitCode: 0,
								output: receiptTable(boundHead),
							},
						],
					},
				},
				isError: false,
			} as never);
			expect(accepted).toBeUndefined();
			const todo = new TodoTool({
				cwd,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				sessionManager: manager,
				getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
				setTodoPhases: (phases: TodoPhase[]) => manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
			} as never);
			const done = await todo.execute("done-bound-head", { op: "done", task: "Build artifact" } as never);
			expect(done.isError).toBeUndefined();
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]?.status).toBe("completed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects an auditor receipt citing a SHA outside the dispatch/current HEADs", async () => {
		const { cwd, manager, runtime } = fixture();
		try {
			await runtime.prepareAuditorTaskCall("task", "call-unrelated-head", {
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
								output: receiptTable("f".repeat(40)),
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
							text: `Delivery: not auto-delivered; recovered by this snapshot.\n\`\`\`\n${`<task-result id="worker-wait" agent="qa-auditor" status="completed"><preview full-output="agent://worker-wait">${receiptTable(head)}</preview></task-result>`}\n\`\`\``,
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
							JSON.stringify({ result: receiptTable(head) }),
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
							text: `Delivery: not auto-delivered; recovered by this snapshot.\n\`\`\`\n${envelope("worker-wait-bad", "scout", JSON.stringify({ result: receiptTable(head) }))}\n\`\`\``,
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
	function overdueFixture(phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>) {
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
		const { cwd, runtime, gate } = overdueFixture([
			{
				name: "Old goal",
				tasks: [
					{ content: "Finished row alpha", status: "completed" },
					{ content: "Finished row beta", status: "completed" },
				],
			},
		]);
		try {
			expect(runtime.refuseOverdueCandidate("read")).toBeUndefined();
			expect(runtime.refuseOverdueCandidate("grep")).toBeUndefined();
			expect(runtime.refuseOverdueCandidate("peers")).toBeUndefined();
			expect(runtime.refuseOverdueCandidate("ask")).toBeUndefined();
			expect(runtime.refuseOverdueCandidate("todo")).toBeUndefined();
			const refusal = runtime.refuseOverdueCandidate("bash");
			expect(refusal?.block).toBe(true);
			expect(refusal?.reason).toContain('op="append"');
			expect(refusal?.reason).not.toContain("Finished row alpha");
			expect(refusal?.reason).not.toContain("Finished row beta");
			const publicationGate = gate();
			expect(publicationGate).toBeDefined();
			const published = (await publicationGate?.(
				{ content: [{ type: "text", text: "answer text" }], stopReason: "stop" } as never,
				new AbortController().signal,
			)) as { replacementText: string; settled?: true } | undefined;
			expect(published?.replacementText).toContain("answer text");
			expect(published?.replacementText).toContain('op="append"');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("lists only the open row in the remedy when one row is still open", () => {
		const { cwd, runtime } = overdueFixture([
			{
				name: "Mixed",
				tasks: [
					{ content: "Finished row alpha", status: "completed" },
					{ content: "Live row gamma", status: "in_progress" },
				],
			},
		]);
		try {
			const refusal = runtime.refuseOverdueCandidate("bash");
			expect(refusal?.block).toBe(true);
			expect(refusal?.reason).toContain("Live row gamma");
			expect(refusal?.reason).not.toContain("Finished row alpha");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps message text with tool calls unchanged while requirements stay open", async () => {
		const { cwd, gate } = overdueFixture([
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
			expect(first?.replacementText).toContain("Blocked:");
			expect(await gate()?.(message, signal)).toBeUndefined();
			expect(first?.replacementText).toContain("Press Archive on both cards");
			expect(first?.replacementText).toContain("card-a");
			expect(first?.replacementText).toContain("card-b");
			expect(getLatestRequirements(manager.getBranch())[0]?.rowVerdicts?.["Build artifact"]).toBeUndefined();
			manager.appendMessage({ role: "user", content: "I have not pressed Archive yet", timestamp: Date.now() });
			expect((await gate()?.(message, signal))?.replacementText).toContain("Press Archive on both cards");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("blocks a normal agent-side unverified row on every attempt", async () => {
		const { cwd, gate } = fixture();
		try {
			const message = { content: [{ type: "text", text: "done" }], stopReason: "stop" } as never;
			const signal = new AbortController().signal;
			expect((await gate()?.(message, signal))?.replacementText).toContain("Blocked:");
			expect((await gate()?.(message, signal))?.replacementText).toContain("Blocked:");
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
				artifact: head,
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
			expect((await gate()?.(message, signal))?.replacementText).toContain("Press Archive");
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
								schedule: { owner: "main", resources: [cwd] },
								awaitingUser: { action: "Press Archive", ids: ["card-a"] },
							},
						],
					},
				],
			});
			const requirement = getLatestRequirements(manager.getBranch())[0]!;
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				{
					...requirement,
					rowVerdicts: {
						"Build artifact": {
							status: "pass",
							evidence: "Archive exercised",
							artifact: git(cwd, "rev-parse", "HEAD"),
							workerId: "qa-after",
							auditor: "qa-auditor",
							receivedAt: new Date(Date.now() + 1000).toISOString(),
						},
					},
				},
			]);
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
				head,
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
			await runtime.prepareAuditorTaskCall("task", owner, { agent: "qa-auditor", task: "Audit R7 now" });
			const output = [
				"| id | raw words | verdict | evidence | artifact identity |",
				"|---|---|---|---|---|",
				`| R7 | ${raw.replaceAll("\n", "<br>")} | pass | inspected plaquePhysics.ts:675 and facilityScene.ts:8765-8769 | ${rows[0]} @ ${head}; ${rows[1]} @ ${head} |`,
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
					`${row} @ ${head}`,
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
			expect(JSON.stringify(stale.content)).toContain("dirty=false");
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
			await runtime.prepareAuditorTaskCall("task", "distinct-rows", { agent: "qa-auditor", task: "Audit R7 now" });
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
									`${rows[0]} @ ${head}; ${rows[1]} @ ${head}`,
									`${rows[1]} @ ${head}; ${rows[0]} @ ${movedHead}`,
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

	it("replays R16 sub-id and R17 JSON wait receipts through the native done gate", async () => {
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
						{ content: row, status: "pending", artifactCwd: cwd, artifactOwner: "main" },
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
			// Session 01a0fc32, AuditR16LeaderStyle: yield.data.result used R16e/f/g.
			const table = [
				"| id | raw words | verdict | evidence | artifact identity |",
				"|---|---|---|---|---|",
				`| R16e | линии выноски сделай так чтобы в рамку по цвету подходили | pass | e2e/facility-callout-frame-colour.spec.ts:71 asserts leaderColour equals frameColour | ${row} @ ${head} |`,
				`| R16f | а сами рамки не такие толстые | pass | e2e/facility-callout-frame-colour.spec.ts:67-68 asserts width 1 texture px | ${row} @ ${head} |`,
				`| R16g | check that the requirement clause is written in doc/product-requirements.md. | pass | doc/product-requirements.md contains the clause | ${row} @ ${head} |`,
			].join("\n");
			async function deliver(output: string, worker: string, auditedRow = row): Promise<void> {
				await runtime.prepareAuditorTaskCall("task", worker, {
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
			expect(JSON.stringify(notice)).toContain(other);
			expect(getLatestRequirements(manager.getBranch())[0]!.rowVerdicts![row]).toEqual(firstReceipt);
			const done = await tool.execute("done", { op: "done", task: row });
			expect(done.isError).toBeUndefined();
			expect(phases[0]!.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
			await deliver(
				JSON.stringify({
					result: `| id | raw words | verdict | evidence | artifact identity |\n|---|---|---|---|---|\n| R16 | ${raw} | pass | exercised the other lane | ${other} @ ${head} |`,
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
					result: table.replace(
						"| R16f | а сами рамки не такие толстые | pass",
						"| R16f | а сами рамки не такие толстые | fail",
					),
				}),
				"AuditR16Failed",
			);
			expect((await tool.execute("failed", { op: "done", task: row })).isError).toBe(true);
			expect(getLatestRequirements(manager.getBranch())[0]!.rowVerdicts![other]?.status).toBe("pass");
			await deliver(
				JSON.stringify({
					result: table.replace(
						"| R16f | а сами рамки не такие толстые | pass",
						"| R16f | а сами рамки не такие толстые | unverifiable",
					),
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
						{ content: scratch, status: "pending", artifactCwd: join(cwd, "missing"), artifactOwner: "main" },
					],
				},
			];
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const bashRaw = "ну иди пересмотри весь report_issue и почини беды с omp";
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				{ ...requirement, id: "R17", rawText: bashRaw, rows: [scratch, other] },
			]);
			await runtime.prepareAuditorTaskCall("task", "bash", {
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
			expect((await tool.execute("done-bash", { op: "done", task: scratch })).isError).toBeUndefined();
			phases[0]!.tasks[0]!.status = "in_progress";
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			expect((await tool.execute("stale-bash", { op: "done", task: scratch })).isError).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
