// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { execFileSync } from "node:child_process";
import todoDispatch from "./todo_dispatch";

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
				ready: (status === "pending" || status === "in_progress") && dependencies.every(dependency => {
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

test("wait is allowed when open rows depend on running work or user approval", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const now = Date.now();
	const phases = chainedPlan(6, now);
	const tasks = phases[0]!.tasks;
	for (let index = 0; index < 3; index++) {
		const task = tasks[index]!;
		task.content = `Running row ${index + 1}`;
		task.status = "in_progress";
		task.schedule.dependencies = [];
		task.schedule.resources = [];
		task.schedule.owner = `worker-${index + 1}`;
	}
	tasks[3]!.content = "Row A waits for running work";
	tasks[3]!.status = "pending";
	tasks[3]!.schedule.dependencies = ["Running row 1"];
	tasks[3]!.schedule.resources = [];
	tasks[4]!.content = "Row B waits for user approval";
	tasks[4]!.status = "pending";
	tasks[4]!.schedule.dependencies = ["Approve chief proposal"];
	tasks[4]!.schedule.resources = [];
	tasks[5]!.content = "Approve chief proposal";
	tasks[5]!.status = "blocked";
	tasks[5]!.blocker = "Awaiting user approval of the chief's recorded proposal";
	tasks[5]!.schedule.dependencies = [];
	tasks[5]!.schedule.resources = [];
	const running = tasks.slice(0, 3).map((task, index) => ({
		id: `task-${index + 1}`,
		agentId: task.schedule.owner,
		type: "task" as const,
		status: "running" as const,
		label: task.content,
		startTime: now,
	}));
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "wait"],
		pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, getLatestTodoPhasesFromEntries: () => phases, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }) },
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctx = {
		cwd: "/tmp/todo-wait-test",
		sessionManager: {
			getHeader: () => ({ id: "wait-once" }),
			getBranch: () => [{ type: "custom", customType: "user_todo_edit", data: { phases } }],
			getSessionFile: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running, recent: [], nonJobAgents: running.map(job => ({ id: job.agentId, live: true })) }),
		getTaskMaxConcurrency: () => 20,
		hasPendingMessages: () => false,
		isIdle: () => false,
		setTimeout: () => ({}),
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	const result = await handlers.get("tool_call")!({ toolName: "wait", toolCallId: "wait-on-chained-work", input: {} }, ctx);
	expect(result).toBeUndefined();
});

async function waitOnReadyRowWithStaleOwner(): Promise<{ block?: boolean; reason?: string } | undefined> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "todo-wait-ready-"));
	try {
		const now = Date.now();
		const phases = chainedPlan(6, now);
		const tasks = phases[0]!.tasks;
		for (let index = 0; index < 5; index++) {
			const task = tasks[index]!;
			task.content = index === 4 ? "Existing review handoff" : `Running row ${index + 1}`;
			task.status = "in_progress";
			task.schedule.dependencies = [];
			task.schedule.resources = [];
			task.schedule.owner = index === 4 ? "AuthorReviewManifest-2" : `worker-${index + 1}`;
		}
		const ready = tasks[5]!;
		ready.content = "Author full-screen review manifest with CSS deltas";
		ready.status = "in_progress";
		ready.schedule.dependencies = [];
		ready.schedule.resources = [];
		ready.schedule.owner = "AuthorReviewManifest";
		const running = tasks.slice(0, 5).map((task, index) => ({
			id: `task-${index + 1}`,
			agentId: task.schedule.owner,
			type: "task" as const,
			status: "running" as const,
			label: task.content,
			startTime: now,
		}));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
			getActiveTools: () => ["task", "todo", "wait"],
			pi: {
				forecastTodoPlan,
				formatPlanForecast,
				formatTaskForecast,
				getLatestTodoPhasesFromEntries: () => phases,
				readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }),
			},
			appendEntry: () => undefined,
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		await todoDispatch(api);
		const ctx = {
			cwd,
			sessionManager: {
				getHeader: () => ({ id: "wait-ready" }),
				getBranch: () => [{ type: "custom", customType: "user_todo_edit", data: { phases } }],
				getSessionFile: () => undefined,
			},
			getAsyncJobSnapshot: () => ({
				running,
				recent: [],
				nonJobAgents: running.map((job) => ({ id: job.agentId, live: true })),
			}),
			getTaskMaxConcurrency: () => 20,
			hasPendingMessages: () => false,
			isIdle: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		return await handlers.get("tool_call")!({ toolName: "wait", toolCallId: "ready", input: {} }, ctx) as { block?: boolean; reason?: string } | undefined;
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("one ready row does not imply spare machine capacity", async () => {
	const result = await waitOnReadyRowWithStaleOwner();
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("Author full-screen review manifest with CSS deltas");
	expect(result?.reason).not.toMatch(/\b\d+ of \d+ possible worker/);
});

test("a dead scheduled owner prompts conditional owner repair", async () => {
	const result = await waitOnReadyRowWithStaleOwner();
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain('owner="AuthorReviewManifest"');
	expect(result?.reason).toContain("not running");
	expect(result?.reason).toContain("todo schedule");
	expect(result?.reason).toContain("otherwise start");
});

test("capacity reports zero when no authenticated worker profile can start", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const now = Date.now();
	const phases = chainedPlan(1, now);
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "wait"],
		pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, getLatestTodoPhasesFromEntries: () => phases, readGoalDeadline: () => undefined },
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctx = {
		cwd: "/tmp/todo-wait-capacity-test",
		sessionManager: {
			getHeader: () => ({ id: "capacity-zero" }),
			getBranch: () => [{ type: "custom", customType: "user_todo_edit", data: { phases } }],
			getSessionFile: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 20,
		models: { resolve: () => undefined, list: () => [] },
		hasPendingMessages: () => false,
		isIdle: () => false,
		setTimeout: () => ({}),
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	const result = await handlers.get("context")!({ messages: [] }, ctx) as { messages?: Array<{ content: string }> };
	expect(result?.messages?.at(-1)?.content).toContain("Task cap=0");
	const onlyInklingModel = { provider: "openrouter", id: "thinkingmachines/inkling:free" };
	const oneProviderCtx = {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getHeader: () => ({ id: "capacity-one" }) },
		models: {
			list: () => [onlyInklingModel],
			resolve: (spec: string) => spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") === "openrouter/thinkingmachines/inkling:free" ? onlyInklingModel : undefined,
		},
	} as unknown as ExtensionContext;
	const oneResult = await handlers.get("context")!({ messages: [] }, oneProviderCtx) as { messages?: Array<{ content: string }> };
	expect(oneResult?.messages?.at(-1)?.content).toContain("Task cap=1");
});


test("PLAN CHECK puts stale no-commit workers first and never aborts them", async () => {
	const worktrees = [0, 1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "todo-worker-tree-")));
	const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "todo-worker-session-"));
	const sessionFile = path.join(sessions, "main.jsonl");
	fs.mkdirSync(path.join(sessions, "main"));
	const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
	for (const cwd of worktrees) {
		git(cwd, "init", "-q", "-b", "main");
		fs.writeFileSync(path.join(cwd, "file.txt"), "base\n");
		git(cwd, "add", "file.txt");
		git(cwd, "commit", "-qm", "base");
	}
	const oldDate = new Date(Date.now() - 18 * 60_000).toISOString();
	for (const index of [0, 2])
		execFileSync("git", ["commit", "--amend", "--no-edit", "--date", oldDate], {
			cwd: worktrees[index]!,
			encoding: "utf8",
			env: { ...gitEnv, GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate },
		});
	const now = Date.now();
	const phases = chainedPlan(3, now);
	const tasks = phases[0]!.tasks;
	tasks[1]!.status = "in_progress";
	tasks[1]!.schedule.owner = "worker-b";
	tasks[1]!.schedule.dependencies = [];
	tasks[2]!.status = "in_progress";
	tasks[2]!.schedule.owner = "worker-c";
	tasks[2]!.schedule.dependencies = [];
	const running = ["worker-a", "worker-b", "worker-c"].map((id, index) => ({
		id,
		agentId: id,
		type: "task" as const,
		status: "running" as const,
		label: `Row ${String.fromCharCode(65 + index)}`,
		startTime: now - (index === 2 ? 10 : 17) * 60_000,
	}));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const sent: string[] = [];
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
	const aborted: string[] = [];
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	for (const [index, id] of ["worker-a", "worker-b", "worker-c"].entries())
		registry.register({ id, displayName: id, kind: "sub", session: { sessionManager: { getCwd: () => worktrees[index] }, abort: () => aborted.push(id) } as never });
	for (const id of ["worker-a", "worker-b", "worker-c"])
		fs.writeFileSync(path.join(sessions, "main", `${id}.jsonl`), `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bun run build" } }] } })}\n`);
	let tick: (() => void | Promise<void>) | undefined;
	const ctx = {
		cwd: worktrees[0],
		sessionManager: {
			getHeader: () => ({ id: "no-commit" }),
			getBranch: () => [{ type: "custom", customType: "user_todo_edit", data: { phases } }],
			getSessionFile: () => sessionFile,
		},
		getAsyncJobSnapshot: () => ({ running, recent: [], nonJobAgents: running.map(job => ({ id: job.agentId, live: true })) }),
		getTaskMaxConcurrency: () => 3,
		hasPendingMessages: () => false,
		isIdle: () => true,
		setTimeout: () => ({}),
		setInterval: (callback: () => void | Promise<void>) => { tick = callback; return {}; },
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	try {
		await handlers.get("session_start")!({}, ctx);
		await tick!();
		await tick!();
		const text = sent.join("\n");
		expect(text).toContain("(1) suspect: Row 1 · worker-a · 17 · bash bun run build");
		expect(text).not.toContain("suspect: Row 2 · worker-b");
		expect(text).not.toContain("suspect: Row 3 · worker-c");
		expect(registry.get("worker-b")?.todoRow).toBe(tasks[1]!.content);
		expect(registry.get("worker-c")?.todoRow).toBe(tasks[2]!.content);
		expect(aborted).toEqual([]);
	} finally {
		handlers.get("session_shutdown")?.({}, ctx);
		vi.restoreAllMocks();
		for (const cwd of worktrees) fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(sessions, { recursive: true, force: true });
	}
}, 60_000);
test("dispatcher renders forecast and deadline times in the persisted goal timezone", async () => {
	const now = Date.UTC(2026, 8, 25, 19, 16);
	const phases = chainedPlan(1, now);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "wait"],
		pi: {
			forecastTodoPlan,
			formatPlanForecast: () => "P95=2026-09-25T19:16:00.000Z",
			formatTaskForecast,
			getLatestTodoPhasesFromEntries: () => phases,
			readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 60_000, timezone: "Asia/Tbilisi" }),
		},
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctx = {
		cwd: "/tmp/todo-wait-timezone-test",
		sessionManager: {
			getHeader: () => ({ id: "timezone" }),
			getBranch: () => [{ type: "custom", customType: "user_todo_edit", data: { phases } }],
			getSessionFile: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 1,
		models: { resolve: () => undefined, list: () => [] },
		hasPendingMessages: () => false,
		isIdle: () => false,
		setTimeout: () => ({}),
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	const result = await handlers.get("context")!({ messages: [] }, ctx) as { messages?: Array<{ content: string }> };
	const content = result.messages?.at(-1)?.content ?? "";
	expect(content).toContain("P95=2026-09-25 23:16:00 Asia/Tbilisi");
	expect(content).toContain("2026-09-25 23:17:00 Asia/Tbilisi");
	expect(content).not.toContain("19:16:00.000Z");
});

test("wait refusals deduplicate by rendered content across plan revisions", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "todo-wait-dedup-"));
	try {
		const now = Date.now();
		const phases = chainedPlan(2, now);
		const [runningTask, readyTask] = phases[0]!.tasks;
		readyTask!.schedule.dependencies = [];
		readyTask!.schedule.resources = [];
		const running = [{
			id: "task-1",
			agentId: "worker-a",
			type: "task" as const,
			status: "running" as const,
			label: runningTask!.content,
			startTime: now,
		}];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
			getActiveTools: () => ["task", "todo", "wait"],
			pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, getLatestTodoPhasesFromEntries: () => phases, readGoalDeadline: () => undefined },
			appendEntry: () => undefined,
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		await todoDispatch(api);
		const ctx = {
			cwd,
			sessionManager: {
				getHeader: () => ({ id: "wait-dedup" }),
				getBranch: () => [{ type: "custom", customType: "user_todo_edit", data: { phases } }],
				getSessionFile: () => undefined,
			},
			getAsyncJobSnapshot: () => ({ running, recent: [], nonJobAgents: [{ id: "worker-a", live: true }] }),
			getTaskMaxConcurrency: () => 20,
			hasPendingMessages: () => false,
			isIdle: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		const callWait = async () => await handlers.get("tool_call")!({ toolName: "wait", toolCallId: "dedup", input: {} }, ctx) as { block?: boolean; reason?: string } | undefined;
		const first = await callWait();
		expect(first?.block).toBe(true);
		readyTask!.schedule.estimate.updatedAt = now + 1;
		expect(await callWait()).toBeUndefined();
		readyTask!.content = "Different ready row";
		const changed = await callWait();
		expect(changed?.block).toBe(true);
		expect(changed?.reason).not.toBe(first?.reason);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
