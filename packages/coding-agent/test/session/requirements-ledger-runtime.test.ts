import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
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
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

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
			const verdict = getLatestRequirements(manager.getBranch())[0]?.verdict;
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
			expect(getLatestRequirements(manager.getBranch())[0]?.verdict).toBeUndefined();
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
			const envelope = `<task-result id="worker-async" agent="qa-auditor" status="completed"><output>${JSON.stringify({ result: receiptTable(head) })}</output></task-result>`;
			await runtime.consumeAsyncResult({
				role: "custom",
				customType: ASYNC_RESULT_MESSAGE_TYPE,
				attribution: "agent",
				content: envelope,
				details: { jobs: [{ type: "task", jobId: "job-async", agentId: "worker-async" }] },
			});
			const verdict = getLatestRequirements(manager.getBranch())[0]?.verdict;
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
			expect(getLatestRequirements(manager.getBranch())[0]?.verdict).toBeUndefined();
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
			expect(getLatestRequirements(manager.getBranch())[0]?.verdict?.status).toBe("pass");
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
			expect(getLatestRequirements(manager.getBranch())[0]?.verdict).toBeUndefined();
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
							text: `Delivery: not auto-delivered; recovered by this snapshot.\n\`\`\`\n${envelope("worker-wait", "qa-auditor", JSON.stringify({ result: receiptTable(head) }))}\n\`\`\``,
						},
					],
				},
				isError: false,
			} as never);
			const verdict = getLatestRequirements(manager.getBranch())[0]?.verdict;
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
			const verdict = getLatestRequirements(manager.getBranch())[0]?.verdict;
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
			expect(getLatestRequirements(manager.getBranch())[0]?.verdict).toBeUndefined();
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
