import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	getLatestRequirements,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import {
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
	getLatestTodoPhasesFromEntries,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

/** Fixture-only: items carry runtime-lane schedule metadata the converged TodoItem omits (#92). */
type ScheduledTodoPhase = Omit<TodoPhase, "tasks"> & {
	tasks: (TodoItem & { schedule?: { owner?: string; resources?: string[] } })[];
};

const AT = "2026-09-28T12:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initGitRepo(cwd: string): void {
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "tester@example.invalid");
	git(cwd, "config", "user.name", "Worker Checkout Test");
	writeFileSync(join(cwd, "artifact.txt"), "audited\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "audited artifact");
}

function doneText(done: unknown): string {
	if (done && typeof done === "object" && "content" in done && Array.isArray(done.content)) {
		const parts: string[] = [];
		for (const part of done.content) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			)
				parts.push(part.text);
		}
		return parts.join("\n");
	}
	return "";
}

async function auditMainRow(options: { agent?: string; fail?: boolean; moveHeadAfterAudit?: boolean }) {
	const cwd = mkdtempSync(join(tmpdir(), "omp-worker-checkout-"));
	try {
		initGitRepo(cwd);
		const manager = SessionManager.inMemory(cwd);
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => cwd,
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			setPublicationGate: () => {},
		});
		const registry = AgentRegistry.global();
		const worker = `WorkerCheckoutQA-${cwd.slice(cwd.lastIndexOf("/") + 1)}`;
		const row = "Row completes after its worker leaves the registry";
		const raw = "Answer to toolu_01 [D1]: audit after worker exit";
		let phases: ScheduledTodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: row, status: "pending", artifactOwner: "main", schedule: { owner: worker, resources: [] } },
				],
			},
		];
		try {
			registry.register({
				id: worker,
				displayName: worker,
				kind: "sub",
				status: "idle",
				session: { sessionManager: { getCwd: () => cwd } } as never,
			});
			const head = git(cwd, "rev-parse", "HEAD");
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				{ ...createRequirementCandidates([], [raw], AT)[0]!, id: "R7", classification: "linked", rows: [row] },
			]);
			const agent = options.agent ?? "qa-auditor";
			await runtime.prepareAuditorTaskCall("task", worker, { name: worker, agent, task: "Audit R7 now" });
			const outputLines = [
				"| id | raw words | verdict | evidence | artifact identity |",
				"|---|---|---|---|---|",
				`| R7 | ${raw} | ${options.fail ? "fail" : "pass"} | inspected worker checkout | ${row} @ ${head} |`,
			];
			const output = outputLines.join("\n");
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: ["qa-auditor", "reviewer"].map(name => ({
					name,
					description: "Audit",
					systemPrompt: "Audit.",
					source: "bundled" as const,
				})),
				projectAgentsDir: null,
			} as never);
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (spawnOptions: unknown) => {
				let agentName = agent;
				if (spawnOptions && typeof spawnOptions === "object" && "agent" in spawnOptions) {
					const candidate = (spawnOptions as { agent: unknown }).agent;
					if (candidate && typeof candidate === "object" && "name" in candidate)
						agentName = String((candidate as { name: unknown }).name);
				}
				return {
					index: 0,
					id: worker,
					agent: agentName,
					agentSource: "bundled",
					task: "Audit R7 now",
					assignment: "",
					exitCode: 0,
					output,
					stderr: "",
					truncated: false,
					durationMs: 1,
					tokens: 0,
					requests: 1,
				} as never;
			});
			const taskTool = await TaskTool.create({
				cwd,
				hasUI: false,
				settings: Settings.isolated({ "task.isolation.enabled": false }),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				sessionManager: manager,
			} as unknown as ToolSession);
			const taskResult = await taskTool.execute(worker, { agent, task: "Audit R7 now", name: worker } as never);
			// The actual effective checkout is captured at the execution boundary and
			// travels with the result, so completion can bind the row after cleanup.
			let checkoutCwd: string | undefined;
			if (taskResult.details && typeof taskResult.details === "object" && "results" in taskResult.details) {
				const results = taskResult.details.results;
				if (Array.isArray(results) && results.length > 0) {
					const first = results[0];
					if (
						first &&
						typeof first === "object" &&
						"checkoutCwd" in first &&
						typeof first.checkoutCwd === "string"
					)
						checkoutCwd = first.checkoutCwd;
				}
			}
			// Drop the registry before acceptance: the row can only resolve through
			// the pre-execution binding, never a live registry lookup.
			registry.unregister(worker);
			const accepted = await runtime.afterToolCall({
				toolCall: { id: worker, name: "task" },
				result: taskResult,
				isError: false,
			} as never);
			if (options.moveHeadAfterAudit) {
				writeFileSync(join(cwd, "artifact.txt"), "moved after audit\n");
				git(cwd, "add", "artifact.txt");
				git(cwd, "commit", "-m", "move HEAD after audit");
			}
			const tool = new TodoTool({
				cwd,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => phases,
				setTodoPhases: (next: TodoPhase[]) => {
					phases = next;
				},
			} as unknown as ToolSession);
			const done = await tool.execute("done-main-row", { op: "done", task: row });
			const requirements = getLatestRequirements(manager.getBranch());
			return { done, requirements, accepted, checkoutCwd };
		} finally {
			vi.restoreAllMocks();
			registry.unregister(worker);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("non-isolated worker checkout binding", () => {
	it("completes a clean qa-auditor pass at HEAD after the worker leaves the registry", async () => {
		const { done, requirements, accepted, checkoutCwd } = await auditMainRow({});
		expect(accepted).toBeUndefined();
		const verdict = requirements.find(requirement => requirement.id === "R7")?.rowVerdicts?.[
			"Row completes after its worker leaves the registry"
		];
		expect(verdict?.status).toBe("pass");
		expect(verdict?.auditor).toBe("qa-auditor");
		expect(checkoutCwd).toBeDefined();
		expect(JSON.stringify(done.content)).not.toContain("unknown checkout for owner");
		expect(JSON.stringify(done.content)).not.toContain("checkout mapping unavailable");
		expect(done.isError).toBeUndefined();
	});
	it("rejects the row when HEAD moved after the audit", async () => {
		const { done } = await auditMainRow({ moveHeadAfterAudit: true });
		expect(done.isError).toBe(true);
		const text = doneText(done);
		expect(text).toContain("stale HEAD");
		expect(text).not.toContain("unknown checkout for owner");
		expect(text).not.toContain("checkout mapping unavailable");
	});
	it("rejects a non-QA pass", async () => {
		const { done } = await auditMainRow({ agent: "reviewer" });
		expect(done.isError).toBe(true);
		const text = doneText(done);
		expect(text).toContain("fresh qa-auditor pass");
		expect(text).not.toContain("unknown checkout for owner");
		expect(text).not.toContain("checkout mapping unavailable");
	});
	it("rejects a failed exact R7 receipt", async () => {
		const { done, requirements, accepted } = await auditMainRow({ fail: true });
		expect(done.isError).toBe(true);
		expect(accepted).toBeUndefined();
		expect(
			requirements.find(requirement => requirement.id === "R7")?.rowVerdicts?.[
				"Row completes after its worker leaves the registry"
			]?.status,
		).toBe("fail");
		const text = doneText(done);
		expect(text).toContain("R7");
		expect(text).not.toContain("unknown checkout for owner");
		expect(text).not.toContain("checkout mapping unavailable");
		expect(text).not.toContain("missing rows");
	});
	it("rejects an isolated gone worktree without a persisted binding even after a valid QA pass", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omp-worker-iso-"));
		const registry = AgentRegistry.global();
		const worker = `WorkerCheckoutIso-${cwd.slice(cwd.lastIndexOf("/") + 1)}`;
		const row = "Isolated gone worktree row";
		const raw = "Answer to toolu_02 [D1]: isolated worktree audit never ran";
		const isolated = join(cwd, "isolated-worktree");
		const phases: ScheduledTodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{
						content: row,
						status: "pending",
						artifactOwner: "main",
						// A legacy textual resource descriptor keeps this on the owner/check-out resolver.
						schedule: { owner: worker, resources: [`worktree: ${isolated}`] },
					},
				],
			},
		];
		try {
			initGitRepo(cwd);
			git(cwd, "worktree", "add", "--detach", isolated, "HEAD");
			const manager = SessionManager.inMemory(cwd);
			const runtime = new RequirementsLedgerRuntime({
				agent: {} as never,
				agentKind: () => "main",
				cwd: () => cwd,
				sessionManager: manager,
				onSettledAssistantMessage: () => {},
				setPublicationGate: () => {},
			});
			const head = git(cwd, "rev-parse", "HEAD");
			registry.register({
				id: worker,
				displayName: worker,
				kind: "sub",
				status: "idle",
				session: { sessionManager: { getCwd: () => isolated } } as never,
			});
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				{ ...createRequirementCandidates([], [raw], AT)[0]!, id: "R7", classification: "linked", rows: [row] },
			]);
			const output = [
				"| id | raw words | verdict | evidence | artifact identity |",
				"|---|---|---|---|---|",
				`| R7 | ${raw} | pass | inspected isolated checkout | ${row} @ ${head} |`,
			].join("\n");
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: ["qa-auditor"].map(name => ({
					name,
					description: "Audit",
					systemPrompt: "Audit.",
					source: "bundled" as const,
				})),
				projectAgentsDir: null,
			} as never);
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(
				async () =>
					({
						index: 0,
						id: worker,
						agent: "qa-auditor",
						agentSource: "bundled",
						task: "Audit R7 now",
						assignment: "",
						exitCode: 0,
						output,
						stderr: "",
						truncated: false,
						durationMs: 1,
						tokens: 0,
						requests: 1,
					}) as never,
			);
			const taskTool = await TaskTool.create({
				cwd,
				hasUI: false,
				settings: Settings.isolated({ "task.isolation.enabled": false }),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				sessionManager: manager,
			} as unknown as ToolSession);
			await runtime.prepareAuditorTaskCall("task", worker, {
				name: worker,
				agent: "qa-auditor",
				task: "Audit R7 now",
			});
			const taskResult = await taskTool.execute(worker, {
				agent: "qa-auditor",
				task: "Audit R7 now",
				name: worker,
			} as never);
			registry.unregister(worker);
			const accepted = await runtime.afterToolCall({
				toolCall: { id: worker, name: "task" },
				result: taskResult,
				isError: false,
			} as never);
			expect(accepted).toBeUndefined();
			const verdict = getLatestRequirements(manager.getBranch()).find(requirement => requirement.id === "R7")
				?.rowVerdicts?.[row];
			expect(verdict?.status).toBe("pass");
			// Lose the saved binding after valid QA, without changing the legacy resource declaration.
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]!.tasks[0]!.artifactCwd).toBeUndefined();
			git(cwd, "worktree", "remove", "--force", isolated);
			const tool = new TodoTool({
				cwd,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => phases,
				setTodoPhases: () => {},
			} as unknown as ToolSession);
			const done = await tool.execute("done-iso-gone", { op: "done", task: row });
			expect(done.isError).toBe(true);
			const text = doneText(done);
			expect(text).toContain("R7");
			expect(text).toContain("unresolved artifact");
			expect(text).not.toContain("has no verdict");
		} finally {
			vi.restoreAllMocks();
			registry.unregister(worker);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
