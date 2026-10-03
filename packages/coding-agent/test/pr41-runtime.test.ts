import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ASYNC_RESULT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

function fixture(customAuditor = false) {
	const cwd = mkdtempSync(join(tmpdir(), "omp-pr41-runtime-"));
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
		version: 1,
		requirements: createRequirementCandidates([], ["audit the artifact"]),
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Work", tasks: [{ content: "Build artifact", status: "pending" }] }],
	});
	const linked = classifyRequirement(getLatestRequirements(manager.getBranch()), "R1", "linked", {
		rows: ["Build artifact"],
	});
	if ("error" in linked) throw new Error(linked.error);
	appendRequirementsSnapshot(
		{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
		linked.requirements,
	);
	if (customAuditor) {
		mkdirSync(join(cwd, ".omp", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".omp", "agents", "qa-auditor.md"),
			"---\nname: qa-auditor\ndescription: Custom profile\n---\nDo custom QA.\n",
		);
	}
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => cwd,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
		setPublicationGate: () => {},
	});
	return { cwd, manager, runtime };
}

describe("PR 41 requirements-ledger runtime", () => {
	it("does not capture slash commands as requirement candidates", () => {
		const { cwd, manager, runtime } = fixture();
		try {
			const before = getLatestRequirements(manager.getBranch());
			runtime.captureCandidate("  /help");
			expect(getLatestRequirements(manager.getBranch())).toEqual(before);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not grant the bundled auditor receipt to a project profile with the same name", async () => {
		const { cwd, manager, runtime } = fixture(true);
		try {
			const result = await runtime.prepareAuditorTaskCall("task", "call-custom", {
				agent: "qa-auditor",
				task: "Audit R1",
			});
			expect(result).toBeUndefined();
			const outcome = await runtime.afterToolCall({
				toolCall: { id: "call-custom", name: "task" },
				result: { content: [], details: {} },
				isError: false,
			} as never);
			expect(JSON.stringify(outcome).replaceAll('\\"', '"')).toContain(
				'Call task with agent="qa-auditor", task="Audit R1 at the current clean row HEAD". Then retry',
			);
			expect(
				manager
					.getBranch()
					.some(entry => entry.type === "custom" && entry.customType === "requirements_auditor_assignments"),
			).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("persists async rejection details before consuming a pending auditor", async () => {
		const { cwd, manager, runtime } = fixture();
		const previousHome = process.env.HOME;
		process.env.HOME = cwd;
		try {
			await runtime.prepareAuditorTaskCall("task", "call-async", {
				agent: "qa-auditor",
				task: "Audit R1",
			});
			await runtime.afterToolCall({
				toolCall: { id: "call-async", name: "task" },
				result: { content: [], details: { progress: [{ index: 0, agent: "qa-auditor", id: "worker-async" }] } },
				isError: false,
			} as never);
			await runtime.consumeAsyncResult({
				role: "custom",
				customType: ASYNC_RESULT_MESSAGE_TYPE,
				attribution: "agent",
				content: "missing task-result envelope",
				details: { jobs: [{ type: "task", jobId: "job-async", agentId: "worker-async" }] },
			});
			const rejection = manager
				.getBranch()
				.find(
					entry =>
						entry.type === "custom" &&
						entry.customType === "requirements_auditor_assignments" &&
						JSON.stringify(entry).includes("async result was incomplete"),
				);
			expect(rejection).toBeDefined();
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("rechecks a persisted plan generation changed during freshness inspection", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omp-pr41-row-"));
		const changedCwd = mkdtempSync(join(tmpdir(), "omp-pr41-plan-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git("init", "--initial-branch=main");
		git("config", "user.email", "tester@example.invalid");
		git("config", "user.name", "PR 41 Runtime Test");
		writeFileSync(join(cwd, "artifact.txt"), "audited\n");
		git("add", "artifact.txt");
		git("commit", "-m", "audited artifact");
		const head = git("rev-parse", "HEAD");
		const manager = SessionManager.inMemory();
		const candidate = createRequirementCandidates([], ["audit the artifact"]);
		const linked = classifyRequirement(candidate, "R1", "linked", { rows: ["Build artifact"] });
		if ("error" in linked) throw new Error(linked.error);
		const requirements = linked.requirements.map(requirement => ({
			...requirement,
			verdict: {
				status: "pass" as const,
				evidence: "observed",
				artifact: head,
				workerId: "worker",
				auditor: "qa-auditor" as const,
			},
		}));
		const appendEntry = (customType: string, data?: unknown) => manager.appendCustomEntry(customType, data);
		appendRequirementsSnapshot({ appendEntry }, requirements);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [
				{
					name: "Work",
					tasks: [{ content: "Build artifact", status: "pending", schedule: { owner: "main", resources: [cwd] } }],
				},
			],
		});
		let gate: ((message: never, signal: AbortSignal) => Promise<unknown>) | undefined;
		let settled = 0;
		new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => cwd,
			sessionManager: manager,
			onSettledAssistantMessage: () => settled++,
			setPublicationGate: next => {
				gate = next as typeof gate;
			},
		});
		try {
			const publication = gate?.(
				{ content: [{ type: "text", text: "done" }], stopReason: "stop" } as never,
				new AbortController().signal,
			);
			queueMicrotask(() =>
				manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
					phases: [
						{
							name: "Work",
							tasks: [
								{
									content: "Build artifact",
									status: "pending",
									schedule: { owner: "main", resources: [changedCwd] },
								},
							],
						},
					],
				}),
			);
			const result = await publication;
			expect(result).toEqual({ replacementText: "" });
			expect(settled).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(changedCwd, { recursive: true, force: true });
		}
	});
});
