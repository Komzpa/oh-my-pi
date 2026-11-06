// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { sessionContextEntryMetadata, type SessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { execFileSync } from "node:child_process";
import todoDispatch, { bashWriteEffects, normalizeWrittenPath } from "./todo_dispatch";

function branchMock(getBranch: () => unknown[]) {
	return {
		getBranch,
		getBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) => getBranch().filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
		getLatestBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) => getBranch().findLast(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
	};
}

type WaitTestTask = {
	content: string;
	status: "pending" | "in_progress" | "blocked";
	blocker?: string;
	schedule: {
		dependencies: string[];
		owner?: string;
		resources: string[];
		estimate: {
			optimisticSeconds: number;
			likelySeconds: number;
			pessimisticSeconds: number;
			confidence: "medium";
			basis: string;
			updatedAt: number;
		};
	};
};
type WaitTestPhase = { name: string; tasks: WaitTestTask[] };

function chainedPlan(rows: number, now: number) {
	return [
		{
			name: "Wait chain",
			tasks: Array.from({ length: rows }, (_, index) => ({
				content: `Row ${index + 1}`,
				status: index === 0 ? "in_progress" : "pending",
				schedule: {
					dependencies: index === 0 ? [] : [`Row ${index}`],
					owner: index === 0 ? "worker-a" : undefined,
					resources: [`lane-${index % 4}`],
					estimate: {
						optimisticSeconds: 60,
						likelySeconds: 180,
						pessimisticSeconds: 420,
						confidence: "medium",
						basis: "wait acknowledgement fixture",
						updatedAt: now,
					},
				},
			})),
		},
	];
}
function formatPlanForecast(): string {
	return "fixture";
}
function formatTaskForecast(): string {
	return "fixture";
}
function forecastTodoPlan(phases: WaitTestPhase[], { now }: { now: number }) {
	const tasks = phases.flatMap(phase => phase.tasks);
	const statusByContent = new Map(tasks.map(task => [task.content, task.status] as const));
	return {
		rows: tasks.map(task => {
			const status = task.status;
			const dependencies = task.schedule.dependencies;
			return {
				content: task.content,
				status,
				owner: task.schedule.owner ?? null,
				ready:
					(status === "pending" || status === "in_progress") &&
					dependencies.every(dependency => {
						const prerequisite = statusByContent.get(dependency);
						return prerequisite === "completed" || prerequisite === "abandoned";
					}),
				earliestStart: now,
				earliestFinish: now,
				latestStart: now,
				latestFinish: now,
				resourceStart: now,
				resourceFinish: now,
				expectedResourceFinish: now,
				fixedPathP95Finish: now,
				totalFloatSeconds: 0,
				freeFloatSeconds: 0,
				critical: false,
				criticalityKnown: true,
				overdue: false,
				stale: false,
			};
		}),
		issues: [],
		planningIssues: [],
		earliestFinish: now,
		resourceFinish: now,
		knownWorkFinish: now,
	};
}

type Worker = { id: string; sessionCwd: string; calls: Array<{ name: string; arguments: Record<string, unknown> }>; minutesRunning: number };

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
const commitAgo = (cwd: string, message: string, minutesAgo: number) => {
	const date = new Date(Date.now() - minutesAgo * 60_000).toISOString();
	fs.writeFileSync(path.join(cwd, `${message}.txt`), message);
	git(cwd, "add", ".");
	execFileSync("git", ["commit", "-qm", message, "--date", date], { cwd, env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
};

// Runs two PLAN CHECK ticks over live workers whose session cwd is the lead checkout and returns what the
// chief was told and which steering messages the workers got.
async function planCheckFor(workers: Worker[]) {
	const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "todo-nocommit-session-"));
	const sessionFile = path.join(sessions, "main.jsonl");
	fs.mkdirSync(path.join(sessions, "main"));
	const now = Date.now();
	const phases = chainedPlan(workers.length, now);
	const tasks = phases[0]!.tasks;
	for (const [index, worker] of workers.entries()) {
		tasks[index]!.status = "in_progress";
		tasks[index]!.schedule.owner = worker.id;
		tasks[index]!.schedule.dependencies = [];
		fs.writeFileSync(
			path.join(sessions, "main", `${worker.id}.jsonl`),
			worker.calls.map(call => `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", ...call }] } })}\n`).join(""),
		);
	}
	const running = workers.map((worker, index) => ({
		id: worker.id,
		agentId: worker.id,
		type: "task" as const,
		status: "running" as const,
		label: `Row ${index + 1}`,
		startTime: now - worker.minutesRunning * 60_000,
	}));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const sent: string[] = [];
	const nudges: Array<{ id: string; content: string }> = [];
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
		pi: {
			forecastTodoPlan,
			formatPlanForecast,
			formatTaskForecast,
			getLatestTodoPhasesFromEntries: () => phases,
			readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }),
			sendMessage: (message: { content: string }) => sent.push(message.content),
		},
		registerSoftToolRequirementProvider: () => undefined,
		appendEntry: () => undefined,
		sendMessage: (message: { content: string }) => sent.push(message.content),
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	for (const worker of workers)
		registry.register({ id: worker.id, displayName: worker.id, kind: "sub", session: { sessionManager: { getCwd: () => worker.sessionCwd }, abort: () => undefined } as never });
	let tick: (() => void | Promise<void>) | undefined;
	const ctx = {
		cwd: workers[0]!.sessionCwd,
		sessionManager: {
			getHeader: () => ({ id: "nocommit-worktree" }),
			...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }]),
			getSessionFile: () => sessionFile,
		},
		getAsyncJobSnapshot: () => ({ running, recent: [], nonJobAgents: running.map(job => ({ id: job.agentId, live: true })) }),
		getTaskMaxConcurrency: () => workers.length,
		hasPendingMessages: () => false,
		isIdle: () => true,
		sendAgentMessage: async (id: string, content: string) => {
			nudges.push({ id, content });
			return { delivered: true, text: `sent to ${id}` };
		},
		setTimeout: () => ({}),
		setInterval: (callback: () => void | Promise<void>) => {
			tick = callback;
			return {};
		},
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	try {
		await handlers.get("session_start")!({}, ctx);
		await tick!();
		await Promise.resolve();
		await tick!();
		await Promise.resolve();
		return { text: sent.join("\n"), nudges: nudges.filter(nudge => nudge.content.startsWith("file overlap")) };
	} finally {
		handlers.get("session_shutdown")?.({}, ctx);
		vi.restoreAllMocks();
		fs.rmSync(sessions, { recursive: true, force: true });
	}
}

test("no-commit counter reads the worker's own worktree, not the lead checkout it was spawned from", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "todo-nocommit-wt-")));
	const lead = path.join(root, "lead");
	fs.mkdirSync(lead);
	git(lead, "init", "-q", "-b", "main");
	commitAgo(lead, "lead-base", 120);
	const fresh = path.join(root, "wt-fresh");
	const quiet = path.join(root, "wt-quiet");
	git(lead, "worktree", "add", "-q", "-b", "fresh", fresh);
	git(lead, "worktree", "add", "-q", "-b", "quiet", quiet);
	commitAgo(fresh, "worker-commit", 2);
	commitAgo(quiet, "worker-old-commit", 40);
	// The sunbim shape: the session cwd is the lead checkout; the worker cds into its worktree to commit.
	const commitCall = (cwd: string) => ({ name: "bash", arguments: { cwd, command: "git add file.ts && git commit -m 'work' && git log --oneline" } });
	try {
		const result = await planCheckFor([
			{ id: "worker-fresh", sessionCwd: lead, minutesRunning: 18, calls: [commitCall(fresh)] },
			{ id: "worker-quiet", sessionCwd: lead, minutesRunning: 18, calls: [commitCall(quiet)] },
		]);
		// Counter reset: its worktree commit is 2 minutes old. Negative control: a 40 minute old worktree commit still warns.
		expect(result.text).not.toContain("suspect: Row 1 · worker-fresh");
		expect(result.text).toContain("suspect: Row 2 · worker-quiet");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("worktree is found from an absolute edit path and from cd/git -C when no cwd argument is given", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "todo-nocommit-wt2-")));
	const lead = path.join(root, "lead");
	fs.mkdirSync(lead);
	git(lead, "init", "-q", "-b", "main");
	commitAgo(lead, "lead-base", 120);
	const byEdit = path.join(root, "wt-edit");
	const byCd = path.join(root, "wt-cd");
	git(lead, "worktree", "add", "-q", "-b", "edit", byEdit);
	git(lead, "worktree", "add", "-q", "-b", "cd", byCd);
	commitAgo(byEdit, "edit-commit", 1);
	commitAgo(byCd, "cd-commit", 1);
	try {
		const result = await planCheckFor([
			{ id: "worker-edit", sessionCwd: lead, minutesRunning: 20, calls: [{ name: "edit", arguments: { input: `[${path.join(byEdit, "src/a.ts")}#AB12]\nPUT 1.=1:\n+x` } }] },
			{ id: "worker-cd", sessionCwd: lead, minutesRunning: 20, calls: [{ name: "bash", arguments: { command: `cd ${byCd} && git add a.ts && git commit -qm x` } }] },
		]);
		expect(result.text).not.toContain("suspect:");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("overlap notice compares normalized file paths, not command words or same-named files in different worktrees", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "todo-overlap-wt-")));
	const lead = path.join(root, "lead");
	fs.mkdirSync(lead);
	git(lead, "init", "-q", "-b", "main");
	commitAgo(lead, "lead-base", 1);
	const treeA = path.join(root, "wt-a");
	const treeB = path.join(root, "wt-b");
	git(lead, "worktree", "add", "-q", "-b", "a", treeA);
	git(lead, "worktree", "add", "-q", "-b", "b", treeB);
	// Both commands end with the word `log`; both touch spec.ts, but in different worktrees; and one more file each shares a word.
	const call = (cwd: string, file: string) => ({ name: "bash", arguments: { cwd, command: `git add spec.ts ${file} && git commit -qm 'edit log' && git log --oneline` } });
	try {
		const quiet = await planCheckFor([
			{ id: "worker-a", sessionCwd: lead, minutesRunning: 3, calls: [call(treeA, "src/log.ts")] },
			{ id: "worker-b", sessionCwd: lead, minutesRunning: 3, calls: [call(treeB, "docs/log.md")] },
		]);
		expect(quiet.nudges).toEqual([]);
		expect(quiet.text).not.toContain("file overlap");
		// Positive control: the same real file in the same worktree is still an overlap.
		const clash = await planCheckFor([
			{ id: "worker-a", sessionCwd: lead, minutesRunning: 3, calls: [call(treeA, "src/log.ts")] },
			{ id: "worker-b", sessionCwd: lead, minutesRunning: 3, calls: [call(treeA, "src/log.ts")] },
		]);
		expect([...new Set(clash.nudges.map(nudge => nudge.id))].sort()).toEqual(["worker-a", "worker-b"]);
		expect(clash.nudges).toHaveLength(4); // spec.ts and src/log.ts, each told to both workers
		expect(clash.text).toContain(`file overlap: ${path.join(treeA, "src/log.ts")} written by worker-a and worker-b`);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("bashWriteEffects returns only git add pathspecs, resolved against the working directory", () => {
	const sunbim = `npx tsc -b && git rev-parse --show-toplevel && git add e2e/a.spec.ts && git commit --no-verify -m "test: log; git add decoy" && git show -s --format=fuller`;
	expect(bashWriteEffects(sunbim, "/wt/x").files).toEqual(["/wt/x/e2e/a.spec.ts"]);
	expect(bashWriteEffects("git add -A && git add . && git add -- 'dir/my file.ts' src/*.ts", "/wt/x").files).toEqual(["/wt/x/dir/my file.ts"]);
	expect(bashWriteEffects("cd /other/wt && git add a.ts; git -C /third add b.ts", "/wt/x")).toEqual({ files: ["/other/wt/a.ts", "/third/b.ts"], dirs: ["/other/wt", "/other/wt", "/third", "/third"] });
	expect(normalizeWrittenPath("src/../src/a.ts", "/wt/x")).toBe("/wt/x/src/a.ts");
	expect(normalizeWrittenPath("log", undefined)).toBe("log");
	expect(normalizeWrittenPath("https://example.com/a", "/wt")).toBeUndefined();
});
