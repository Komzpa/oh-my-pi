import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "omp-ledger-runtime-"));
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "tester@example.invalid");
	git(cwd, "config", "user.name", "Ledger Runtime Test");
	writeFileSync(join(cwd, "artifact.txt"), "audited\n");
	git(cwd, "add", "artifact.txt");
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
			const envelope = `<task-result id="worker-async" agent="qa-auditor" status="completed"><output>\n${receiptTable(head)}\n</output></task-result>`;
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
});
