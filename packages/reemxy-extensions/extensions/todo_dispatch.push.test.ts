// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { expect, test, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	sessionContextEntryMetadata,
	type SessionContextEntryMetadata,
} from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch, { readGitIntegrationState } from "./todo_dispatch";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as childProcess from "node:child_process";

const sdk = {
	forecastTodoPlan,
	formatPlanForecast,
	formatTaskForecast,
	getLatestTodoPhasesFromEntries,
	agentPauseGate,
};

function git(cwd: string, env: Record<string, string>, ...args: string[]) {
	execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
}

// A lead must see a publication obligation without a goal or a fresh fetch.
test("live heads create one notice and priority push row, then a worker push clears both without fetch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "push-demand-"));
	try {
		const remote = join(dir, "remote.git");
		const work = join(dir, "work");
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
		const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		writeFileSync(join(work, "a"), "a");
		git(work, id, "add", "a");
		git(work, id, "commit", "-q", "-m", "base");
		git(work, id, "push", "-q", "-u", "origin", "HEAD");
		writeFileSync(join(work, "b"), "b");
		git(work, id, "add", "b");
		const old = new Date(Date.now() - 80 * 60_000).toISOString();
		git(work, { ...id, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old }, "commit", "-q", "-m", "local fix");

		let phases = [];
		const notices = [];
		const statuses = [];
		let tick;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		let provider: ((ctx: ExtensionContext) => unknown) | undefined;
		await todoDispatch({
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
			getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
			pi: { ...sdk, readGoalDeadline: () => undefined },
			registerSoftToolRequirementProvider: (
				p: ((ctx: ExtensionContext) => unknown) & { demand?: (ctx: ExtensionContext) => unknown },
			) => {
				provider = p.demand ?? p;
			},
			appendEntry: () => undefined,
			sendMessage: (message) => notices.push(message),
		} as unknown as ExtensionAPI);
		const branch: unknown[] = [];
		const ctx = {
			cwd: work,
			ui: { setStatus: (_key, value) => statuses.push(value) },
			getTodoSnapshot: () => phases,
			sessionManager: {
				getHeader: () => ({ id: "push-root" }),
				getBranch: () => branch,
				getBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) =>
					branch.filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
				getLatestBranchMatching: () => undefined,
				getSessionFile: () => undefined,
			},
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
			getTaskMaxConcurrency: () => 4,
			isIdle: () => false,
			hasPendingMessages: () => false,
			setInterval: (handler) => { tick = handler; return {}; },
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		AgentRegistry.global().register({ id: "push-fixture", kind: "main", session: {
			sessionManager: ctx.sessionManager,
			commitTodoPhases: (next) => { phases = next; },
		} });
		const sync = spyOn(childProcess, "spawnSync").mockImplementation(() => { throw new Error("sync git on main thread"); });
		try {
			await handlers.get("session_start")!({}, ctx);
			await tick();
			await handlers.get("context")!({ messages: [] }, ctx);
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(notices.filter(message => message.customType === "todo-unpushed")).toHaveLength(1);
			expect(phases.flatMap(phase => phase.tasks)).toHaveLength(1);
			expect(phases[0].tasks[0].content).toContain("project gates and push origin/");
			expect(phases[0].tasks[0].status).toBe("pending");
			expect(statuses.at(-1)).toMatch(/1 unpushed · oldest 80m/);
		} finally { sync.mockRestore(); }
		const worker = join(dir, "worker");
		git(work, id, "worktree", "add", "--detach", worker, "HEAD");
		git(worker, id, "-c", "remote.origin.fetch=", "push", "-q", "origin", "HEAD:refs/heads/worker-published");
		// A new remote branch deliberately leaves origin/<lead branch> stale.
		expect((await readGitIntegrationState(work, Date.now()))?.unpushed).toBe(0);
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		expect(phases[0].tasks[0].status).toBe("completed");
		expect(statuses.at(-1)).toBeUndefined();
		expect(notices.filter(message => message.customType === "todo-unpushed")).toHaveLength(1);
		git(work, id, "config", "omp.unpushedThresholdMinutes", "120");
		git(work, id, "--git-dir", remote, "update-ref", "-d", "refs/heads/worker-published");
		const below = await readGitIntegrationState(work, Date.now());
		expect(below?.unpushed).toBe(1);
		expect(below?.pushThresholdMs).toBe(120 * 60_000);
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		expect(phases[0].tasks[0].status).toBe("completed");
		git(work, id, "config", "omp.unpushedThresholdMinutes", "15");
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		expect(notices.filter(message => message.customType === "todo-unpushed")).toHaveLength(2);
		expect(phases.flatMap(phase => phase.tasks)).toHaveLength(1);
		expect(phases[0].tasks[0].status).toBe("pending");
		git(work, id, "remote", "set-url", "origin", join(dir, "missing.git"));
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		expect(phases[0].tasks[0].status).toBe("pending");
		git(work, id, "remote", "set-url", "origin", remote);
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		const demand = provider?.(ctx) as { reminder?: Array<{ content: string }> } | undefined;
		expect(demand?.reminder?.[0]?.content ?? "").toContain("UNPUSHED WORK: 1 commit(s)");
		handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		AgentRegistry.global().unregister("push-fixture");
		rmSync(dir, { recursive: true, force: true });
	}
});
