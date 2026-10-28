// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { expect, test } from "bun:test";
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
import todoDispatch from "./todo_dispatch";

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

// Live DC lead 2026-10-28: 36 commits sat unpushed for 8 hours and the owner had to ask three times.
// The session had no /goal, and the push demand only fired for goal sessions.
test("unpushed commits older than an hour demand a push without a goal", async () => {
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
		const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
		git(work, { ...id, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old }, "commit", "-q", "-m", "local fix");

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
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI);
		const branch: unknown[] = [];
		const ctx = {
			cwd: work,
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
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		await handlers.get("context")!({ messages: [] }, ctx);
		const demand = provider?.(ctx) as { reminder?: Array<{ content: string }> } | undefined;
		expect(demand?.reminder?.[0]?.content ?? "").toContain("UNPUSHED WORK: 1 commit(s)");
		handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
