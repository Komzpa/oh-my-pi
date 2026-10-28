// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { sessionContextEntryMetadata, type SessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { execFileSync } from "node:child_process";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { noticeDigest } from "./todo_dispatch";

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
			const dependencies = task.schedule?.dependencies ?? [];
			return {
				content: task.content,
				status,
				owner: task.schedule?.owner ?? null,
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

async function noticeHarness(phases: WaitTestPhase[], deadlineAt: number, initialJobs: unknown[] = [], forecastLeadMs = 0, forecastOverride = undefined, restoredEntries: unknown[] = []) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notices: Array<{ customType: string; content: string; delivery?: { triggerTurn?: boolean; interruptWait?: boolean; deliverAs?: string } }> = [];
	const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [...restoredEntries];
	const intervals: Array<() => void | Promise<void>> = [];
	const timeouts: Array<() => void | Promise<void>> = [];
	let recent = initialJobs;
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "wait"],
		appendEntry: (customType: string, data?: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: { customType: string; content: string }, delivery) => notices.push({ ...message, delivery }),
		pi: {
			forecastTodoPlan: (phases, options) => forecastOverride ? forecastOverride(phases, options) : forecastTodoPlan(phases, { ...options, now: options.now + forecastLeadMs }),
			formatPlanForecast,
			formatTaskForecast,
			getLatestTodoPhasesFromEntries,
			readGoalDeadline: () => ({ goalId: "notice-test", deadlineAt }),
			agentPauseGate: { paused: false },
		},
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctx = {
		cwd: "/tmp/todo-notice-test",
		sessionManager: {
			getHeader: () => ({ id: "notice-root" }),
			...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }, ...entries]),
			getSessionFile: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [], recent, nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 20,
		hasPendingMessages: () => false,
		isIdle: () => true,
		setInterval: (callback: () => void | Promise<void>) => {
			intervals.push(callback);
			return callback;
		},
		clearInterval: () => undefined,
		setTimeout: (callback: () => void | Promise<void>) => {
			timeouts.push(callback);
			return callback;
		},
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	await handlers.get("session_start")!({}, ctx);
	return {
		handlers,
		ctx,
		notices,
		entries,
		setRecent: (jobs: unknown[]) => {
			recent = jobs;
		},
		tick: async () => {
			await intervals.at(-1)?.();
		},
		fireIdleWake: async () => {
			await timeouts.at(-1)?.();
		},
		shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
	};
}

const humanQuestion = () => ({
	type: "message",
	message: {
		role: "user", attribution: "user", steering: true,
		content: [{ type: "text", text: "сука а ты можешь быстрее?:???????" }],
		timestamp: Date.parse("2026-10-24T04:23:16.412Z"),
	},
});

test("an unanswered human message refuses every wait with its timestamp and text, while reads stay allowed", async () => {
	const h = await noticeHarness([], Date.now() + 3600_000);
	try {
		h.entries.push(humanQuestion());
		h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "I should reply" }, { type: "toolCall", name: "read", arguments: {} }] } });
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx);
			expect(result?.block).toBe(true);
			expect(result.reason).toContain("2026-10-24T04:23:16.000Z");
			expect(result.reason).toContain("сука а ты можешь быстрее?:???????");
		}
		expect(await h.handlers.get("tool_call")!({ toolName: "read", input: { path: "README.md" } }, h.ctx)).toBeUndefined();
	} finally { h.shutdown(); }
});

test("published assistant text answers the human, but a newer human turn requires another reply", async () => {
	const h = await noticeHarness([], Date.now() + 3600_000);
	try {
		h.entries.push(humanQuestion());
		h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Checking the final test; about two minutes left." }] } });
		h.entries.push({ type: "custom", customType: "notice", data: {} });
		expect(await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx)).toBeUndefined();
		h.entries.push(humanQuestion());
		expect((await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx))?.block).toBe(true);
	} finally { h.shutdown(); }
});

test("injected peer messages and synthetic notices do not require human replies", async () => {
	const h = await noticeHarness([], Date.now() + 3600_000);
	try {
		h.entries.push({ type: "message", message: { role: "custom", customType: "irc:incoming", attribution: "agent", content: "worker result" } });
		h.entries.push({ type: "message", message: { ...humanQuestion().message, attribution: "agent" } });
		h.entries.push({ type: "message", message: { ...humanQuestion().message, synthetic: true } });
		expect(await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx)).toBeUndefined();
	} finally { h.shutdown(); }
});

test("a worker's unanswered brief does not block wait or stop", async () => {
	const h = await noticeHarness([], Date.now() + 3600_000);
	try {
		h.ctx.sessionManager.getHeader = () => ({ id: "worker", parentSession: "/parent.jsonl" });
		h.entries.push(humanQuestion());
		expect(await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx)).toBeUndefined();
		expect(await h.handlers.get("session_stop")!({}, h.ctx)).toBeUndefined();
	} finally { h.shutdown(); }
});

test("empty stop and unpublished drafts keep the human unanswered until final text reaches history", async () => {
	const h = await noticeHarness([], Date.now() + 3600_000);
	try {
		h.entries.push(humanQuestion());
		// A pre-publication draft (including a completion claim rejected by a rewrite hook)
		// is not in canonical history. Streamed text likewise cannot discharge the reply.
		await h.handlers.get("message_update")?.({ message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }, h.ctx);
		h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "  " }] } });
		expect((await h.handlers.get("session_stop")!({}, h.ctx))?.decision).toBe("block");
		expect((await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx))?.block).toBe(true);
		h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Verification is pending; checking it now." }] } });
		expect(await h.handlers.get("session_stop")!({}, h.ctx)).toBeUndefined();
	} finally { h.shutdown(); }
});

test("healthy worker telemetry does not wake the chief on a plan tick", async () => {
	const previousLane = process.env.OMP_LANE_UNIT;
	delete process.env.OMP_LANE_UNIT;
	const now = Date.now();
	const phases = chainedPlan(1, now);
	const h = await noticeHarness(phases, now + 24 * 60 * 60_000, [], 60 * 60_000);
	h.ctx.getAsyncJobSnapshot = () => ({
		running: [{ id: "worker-a", type: "task", status: "running", label: "worker-a", startTime: now }],
		recent: [], nonJobAgents: [],
	});
	try {
		await h.tick();
		await h.tick();
		expect(h.notices.filter(notice => !notice.customType.startsWith("todo-gate-"))).toEqual([]);
		// A newly unstaffed ready row is still actionable and must wake the chief.
		h.ctx.getAsyncJobSnapshot = () => ({ running: [], recent: [], nonJobAgents: [] });
		await h.tick();
		expect(h.notices.some(notice => notice.content.includes("problem(s)"))).toBe(true);
	} finally {
		h.shutdown();
		if (previousLane === undefined) delete process.env.OMP_LANE_UNIT;
		else process.env.OMP_LANE_UNIT = previousLane;
	}
});

test("repeated retro and checkpoint notices do not send another chief turn", async () => {
	const previousLane = process.env.OMP_LANE_UNIT;
	delete process.env.OMP_LANE_UNIT;
	let now = Date.now();
	const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
	try {
		const phases = chainedPlan(1, now);
		const row = phases[0]!.tasks[0]!;
		row.status = "pending";
		row.schedule.owner = undefined;
		row.schedule.dependencies = [];
		row.schedule.resources = [];
		const h = await noticeHarness(phases, now + 24 * 60 * 60_000);
		try {
			await h.tick();
			expect(h.notices.filter(notice => notice.customType === "todo-plan-check")).toHaveLength(1);
			// The harness lead is idle: a plan problem wakes it instead of waiting for the user.
			expect(h.notices.find(notice => notice.customType === "todo-plan-check")?.delivery).toMatchObject({ triggerTurn: true });
			// A queued older plan check is replaced by the newer snapshot, never read stale.
			expect(h.notices.find(notice => notice.customType === "todo-plan-check")?.details).toMatchObject({ supersedesQueued: true });
			now += 11 * 60_000;
			await h.tick();
			expect(h.notices.filter(notice => notice.customType === "todo-plan-check")).toHaveLength(1);
			// The unchanged problem list is re-delivered once, 30 minutes after the first delivery.
			now += 20 * 60_000;
			await h.tick();
			expect(h.notices.filter(notice => notice.customType === "todo-plan-check")).toHaveLength(2);
			const silent = h.entries.filter(entry => entry.customType === "todo-dispatch-silent-notice");
			expect(silent.filter(entry => entry.data?.kind === "todo-plan-check")).toHaveLength(0);
		} finally {
			h.shutdown();
		}
		const retroPhases = chainedPlan(1, now);
		const retroRow = retroPhases[0]!.tasks[0]!;
		retroRow.status = "pending";
		retroRow.schedule.owner = undefined;
		retroRow.schedule.dependencies = [];
		retroRow.schedule.resources = [];
		const retro = await noticeHarness(retroPhases, now + 24 * 60 * 60_000);
		try {
			await retro.handlers.get("tool_result")!(
				{
					toolName: "todo",
					toolCallId: "retro-init",
					isError: false,
					content: [],
					details: { phases: retroPhases },
				},
				retro.ctx,
			);
			// Incident-only retros: completing the only row with no incident sends no
			// retro notice. Reopening it does, once, with the incident named.
			retroRow.status = "completed";
			await retro.tick();
			expect(retro.notices.filter((notice) => notice.content.includes("retrospective due"))).toHaveLength(0);
			retroRow.status = "pending";
			await retro.tick();
			const reopened = retro.notices.filter((notice) => notice.content.includes("retrospective due"));
			expect(reopened).toHaveLength(1);
			expect(reopened[0]?.content).toContain("retrospective due (reopened row)");
			now += 11 * 60_000;
			await retro.tick();
			expect(retro.notices.filter((notice) => notice.content.includes("retrospective due"))).toHaveLength(1);
		} finally {
			retro.shutdown();
		}
	} finally {
		nowSpy.mockRestore();
		if (previousLane === undefined) delete process.env.OMP_LANE_UNIT;
		else process.env.OMP_LANE_UNIT = previousLane;
	}
});

test("an identical due notice is suppressed but a new worker failure wakes chief", async () => {
	const previousLane = process.env.OMP_LANE_UNIT;
	delete process.env.OMP_LANE_UNIT;
	try {
		const now = Date.now();
		const phases = chainedPlan(1, now);
		const row = phases[0]!.tasks[0]!;
		row.status = "pending";
		row.schedule.owner = undefined;
		row.schedule.dependencies = [];
		row.schedule.resources = [];
		const h = await noticeHarness(phases, now - 60_000);
		try {
			await h.handlers.get("agent_end")!({}, h.ctx);
			await h.fireIdleWake();
			expect(h.notices.filter(notice => !notice.customType.startsWith("todo-gate-"))).toHaveLength(1);
			await h.handlers.get("agent_end")!({}, h.ctx);
			await h.fireIdleWake();
			expect(h.notices.filter(notice => !notice.customType.startsWith("todo-gate-"))).toHaveLength(1);
			h.setRecent([
				{
					id: "failed-new-worker",
					type: "task",
					status: "failed",
					agentId: "worker-new",
					label: "Build verification",
				},
			]);
			await h.handlers.get("agent_end")!({}, h.ctx);
			await h.fireIdleWake();
			expect(h.notices.filter(notice => !notice.customType.startsWith("todo-gate-"))).toHaveLength(2);
			expect(h.notices.filter(notice => !notice.customType.startsWith("todo-gate-"))[1]?.customType).toBe("agent-focus-gym-eval-sandbox-wake");
		} finally {
			h.shutdown();
		}
	} finally {
		if (previousLane === undefined) delete process.env.OMP_LANE_UNIT;
		else process.env.OMP_LANE_UNIT = previousLane;
	}
});

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
		pi: {
			forecastTodoPlan,
			formatPlanForecast,
			formatTaskForecast,
			getLatestTodoPhasesFromEntries,
			readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 3_600_000 }),
		},
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctx = {
		cwd: "/tmp/todo-wait-test",
		sessionManager: {
			getHeader: () => ({ id: "wait-once" }),
			...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }]),
			getSessionFile: () => undefined,
		},
		getAsyncJobSnapshot: () => ({
			running,
			recent: [],
			nonJobAgents: running.map(job => ({ id: job.agentId, live: true })),
		}),
		getTaskMaxConcurrency: () => 20,
		hasPendingMessages: () => false,
		isIdle: () => false,
		setTimeout: () => ({}),
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	const result = await handlers.get("tool_call")!(
		{ toolName: "wait", toolCallId: "wait-on-chained-work", input: {} },
		ctx,
	);
	expect(result).toBeUndefined();
});

async function waitOnReadyRowWithStaleOwner(
	completeReadyRow = false,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "todo-wait-ready-"));
	try {
		const now = Date.now();
		const phases = chainedPlan(6, now);
		let latestPhases = phases;
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
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
			getActiveTools: () => ["task", "todo", "wait"],
			pi: {
				forecastTodoPlan,
				formatPlanForecast,
				formatTaskForecast,
				getLatestTodoPhasesFromEntries: () => latestPhases,
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
				...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }]),
				getSessionFile: () => undefined,
			},
			getAsyncJobSnapshot: () => ({
				running,
				recent: [],
				nonJobAgents: running.map(job => ({ id: job.agentId, live: true })),
			}),
			getTaskMaxConcurrency: () => 20,
			hasPendingMessages: () => false,
			isIdle: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		const wait = handlers.get("tool_call")!;
		if (completeReadyRow) await wait({ toolName: "wait", toolCallId: "before-complete", input: {} }, ctx);
		if (completeReadyRow) {
			latestPhases = phases.map(phase => ({
				...phase,
				tasks: phase.tasks.map(task => (task === ready ? { ...task, status: "completed" } : task)),
			}));
		}
		return (await wait({ toolName: "wait", toolCallId: "ready", input: {} }, ctx)) as
			| { block?: boolean; reason?: string }
			| undefined;
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
test("wait sees a row completed in the same batch", async () => {
	const result = await waitOnReadyRowWithStaleOwner(true);
	expect(result?.block).not.toBe(true);
});

test("capacity reports zero when no authenticated worker profile can start", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const now = Date.now();
	const phases = chainedPlan(1, now);
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "wait"],
		pi: {
			forecastTodoPlan,
			formatPlanForecast,
			formatTaskForecast,
			getLatestTodoPhasesFromEntries,
			readGoalDeadline: () => undefined,
		},
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctx = {
		cwd: "/tmp/todo-wait-capacity-test",
		sessionManager: {
			getHeader: () => ({ id: "capacity-zero" }),
			...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }]),
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
	const result = (await handlers.get("context")!({ messages: [] }, ctx)) as { messages?: Array<{ content: string }> };
	expect(result?.messages?.at(-1)?.content).toContain("Task cap=0");
	const route = "codex-lb/gpt-6-luna";
	const separator = route.indexOf("/");
	const onlyModel = { provider: route.slice(0, separator), id: route.slice(separator + 1) };
	const oneProviderCtx = {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getHeader: () => ({ id: "capacity-one" }) },
		models: {
			list: () => [onlyModel],
			resolve: (spec: string) =>
				spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") === route ? onlyModel : undefined,
		},
	} as unknown as ExtensionContext;
	const oneResult = (await handlers.get("context")!({ messages: [] }, oneProviderCtx)) as {
		messages?: Array<{ content: string }>;
	};
	expect(oneResult?.messages?.at(-1)?.content).toContain("Task cap=1");
});

test("PLAN CHECK puts stale no-commit workers first and never aborts them", async () => {
	const worktrees = [0, 1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "todo-worker-tree-")));
	const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "todo-worker-session-"));
	const sessionFile = path.join(sessions, "main.jsonl");
	fs.mkdirSync(path.join(sessions, "main"));
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
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
			getLatestTodoPhasesFromEntries,
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
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			session: { sessionManager: { getCwd: () => worktrees[index] }, abort: () => aborted.push(id) } as never,
		});
	for (const id of ["worker-a", "worker-b", "worker-c"])
		fs.writeFileSync(
			path.join(sessions, "main", `${id}.jsonl`),
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bun run build" } }] } })}\n`,
		);
	let tick: (() => void | Promise<void>) | undefined;
	const ctx = {
		cwd: worktrees[0],
		sessionManager: {
			getHeader: () => ({ id: "no-commit" }),
			...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }]),
			getSessionFile: () => sessionFile,
		},
		getAsyncJobSnapshot: () => ({
			running,
			recent: [],
			nonJobAgents: running.map(job => ({ id: job.agentId, live: true })),
		}),
		getTaskMaxConcurrency: () => 3,
		hasPendingMessages: () => false,
		isIdle: () => true,
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
			getLatestTodoPhasesFromEntries,
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
			...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }]),
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
	const result = (await handlers.get("context")!({ messages: [] }, ctx)) as { messages?: Array<{ content: string }> };
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
		const running = [
			{
				id: "task-1",
				agentId: "worker-a",
				type: "task" as const,
				status: "running" as const,
				label: runningTask!.content,
				startTime: now,
			},
		];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
			getActiveTools: () => ["task", "todo", "wait"],
			pi: {
				forecastTodoPlan,
				formatPlanForecast,
				formatTaskForecast,
				getLatestTodoPhasesFromEntries,
				readGoalDeadline: () => undefined,
			},
			appendEntry: () => undefined,
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		await todoDispatch(api);
		const ctx = {
			cwd,
			sessionManager: {
				getHeader: () => ({ id: "wait-dedup" }),
				...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }]),
				getSessionFile: () => undefined,
			},
			getAsyncJobSnapshot: () => ({ running, recent: [], nonJobAgents: [{ id: "worker-a", live: true }] }),
			getTaskMaxConcurrency: () => 20,
			hasPendingMessages: () => false,
			isIdle: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		const callWait = async () =>
			(await handlers.get("tool_call")!({ toolName: "wait", toolCallId: "dedup", input: {} }, ctx)) as
				| { block?: boolean; reason?: string }
				| undefined;
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

test("OMP_LANE_UNIT suppresses chief gates, retros and continuation nudges", async () => {
	const previousLane = process.env.OMP_LANE_UNIT;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "todo-dispatch-lane-unit-"));
	const now = Date.now();
	const phases = chainedPlan(1, now);
	const row = phases[0]!.tasks[0]!;
	row.status = "pending";
	row.schedule.dependencies = [];
	row.schedule.owner = undefined;
	const branch: unknown[] = [
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases } } },
	];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let providerRegistered = false;
	let timers = 0;
	const sent: unknown[] = [];
	try {
		try {
			process.env.OMP_LANE_UNIT = "";
			await todoDispatch({
				on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
					handlers.set(event, handler),
				getActiveTools: () => ["task", "todo", "wait"],
				registerSoftToolRequirementProvider: () => {
					providerRegistered = true;
				},
				appendEntry: () => undefined,
				sendMessage: (message: unknown) => {
					sent.push(message);
				},
				pi: {
					forecastTodoPlan,
					formatPlanForecast,
					formatTaskForecast,
					getLatestTodoPhasesFromEntries,
					readGoalDeadline: () => ({ goalId: "lane-goal", deadlineAt: now + 3_600_000 }),
					agentPauseGate: { paused: false },
				},
			} as unknown as ExtensionAPI);
		} finally {
			if (previousLane === undefined) delete process.env.OMP_LANE_UNIT;
			else process.env.OMP_LANE_UNIT = previousLane;
		}
		const ctx = {
			cwd,
			sessionManager: { getHeader: () => ({ id: "lane-root" }), ...branchMock(() => branch) },
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
			getTaskMaxConcurrency: () => 16,
			isIdle: () => true,
			hasPendingMessages: () => false,
			setTimeout: () => {
				timers += 1;
				return {};
			},
			clearTimer: () => undefined,
			setInterval: () => {
				timers += 1;
				return {};
			},
			clearInterval: () => undefined,
		} as unknown as ExtensionContext;
		handlers.get("session_start")!({}, ctx);
		handlers.get("input")!({ source: "user", content: "No, that is wrong" }, ctx);
		const wait = (await handlers.get("tool_call")!({ toolName: "wait", toolCallId: "lane-wait", input: {} }, ctx)) as
			| { block?: boolean }
			| undefined;
		const context = await handlers.get("context")!({ messages: [] }, ctx);
		const todoResult = await handlers.get("tool_result")!(
			{
				toolName: "todo",
				toolCallId: "lane-todo",
				isError: false,
				content: [],
				details: { phases },
			},
			ctx,
		);
		await handlers.get("agent_end")!({}, ctx);
		expect(providerRegistered).toBe(false);
		expect(wait).toBeUndefined();
		expect(context).toBeUndefined();
		expect(todoResult).toBeUndefined();
		expect(timers).toBe(0);
		expect(sent).toHaveLength(0);
	} finally {
		if (previousLane === undefined) delete process.env.OMP_LANE_UNIT;
		else process.env.OMP_LANE_UNIT = previousLane;
		handlers.get("session_shutdown")?.({}, {
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		} as unknown as ExtensionContext);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

async function stuckWorkerHarness(options: { filesAgeMs: number; elapsedMs: number; bulkFiles?: number }) {
	const sessionId = `plantick-${process.pid}-${Math.random().toString(36).slice(2)}`;
	const traceFile = path.join(os.homedir(), ".local", "state", "omp-todo-dispatch", `${sessionId}.gate.jsonl`);
	const tree = fs.mkdtempSync(path.join(os.tmpdir(), "todo-plantick-tree-"));
	const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "todo-plantick-session-"));
	const sessionFile = path.join(sessions, "main.jsonl");
	fs.mkdirSync(path.join(sessions, "main"));
	const now = Date.now();
	const file = path.join(tree, "work.txt");
	fs.writeFileSync(file, "x");
	const at = new Date(now - options.filesAgeMs);
	fs.utimesSync(file, at, at);
	if (options.bulkFiles) {
		// A tree larger than the mtime walk's entry budget: the walk is cut off, so its newest mtime is a lower bound.
		const bulk = path.join(tree, "bulk");
		fs.mkdirSync(bulk);
		for (let i = 0; i < options.bulkFiles; i += 1) {
			const f = path.join(bulk, `f${i}.txt`);
			fs.writeFileSync(f, "x");
			fs.utimesSync(f, at, at);
		}
	}
	fs.writeFileSync(
		path.join(sessions, "main", "worker-a.jsonl"),
		`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "wait", arguments: {} }] } })}\n`,
	); // session file is fresh: the worker is alive but only waiting
	const phases = chainedPlan(2, now);
	const running = [{ id: "worker-a", agentId: "worker-a", type: "task" as const, status: "running" as const, label: "Row 1", startTime: now - options.elapsedMs }];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const sent: string[] = [];
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
		pi: {
			forecastTodoPlan,
			formatPlanForecast,
			formatTaskForecast,
			getLatestTodoPhasesFromEntries,
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
	registry.register({ id: "worker-a", displayName: "worker-a", kind: "sub", session: { sessionManager: { getCwd: () => tree }, abort: () => undefined } as never });
	const ticks: Array<() => void | Promise<void>> = [];
	const ctx = {
		cwd: tree,
		sessionManager: {
			getHeader: () => ({ id: sessionId }),
			...branchMock(() => [{ type: "custom", customType: "user_todo_edit", data: { phases } }]),
			getSessionFile: () => sessionFile,
		},
		getAsyncJobSnapshot: () => ({ running, recent: [], nonJobAgents: [{ id: "worker-a", live: true }] }),
		getTaskMaxConcurrency: () => 3,
		hasPendingMessages: () => true, // stuck true must not silence the ticker
		isIdle: () => true,
		setTimeout: () => ({}),
		setInterval: (callback: () => void | Promise<void>) => {
			ticks.push(callback);
			return {};
		},
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	await handlers.get("session_start")!({}, ctx);
	const cleanup = () => {
		handlers.get("session_shutdown")?.({}, ctx);
		vi.restoreAllMocks();
		for (const dir of [tree, sessions]) fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(traceFile, { force: true });
	};
	const trace = () => {
		return fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
	};
	return { handlers, ctx, ticks, sent, cleanup, trace, running, phases, workerFile: path.join(sessions, "main", "worker-a.jsonl") };
}

test("plan tick flags an alive-but-waiting worker whose worktree is quiet, escalates, and ignores a stuck pending flag", async () => {
	const h = await stuckWorkerHarness({ filesAgeMs: 40 * 60_000, elapsedMs: 40 * 60_000 });
	try {
		await h.ticks.at(-1)!();
		const text = h.sent.join("\n");
		expect(text).toContain("suspect: Row 1 · worker-a · 40");
		expect(text).toContain("no file change in its worktree for 40 min");
		expect(text).toContain("STILL STUCK over 30 min");
		expect(text).toContain("write agent://worker-a asking for done/left with a receipt, or stop it");
		expect(h.trace().some(row => row.plantick === "sent")).toBe(true);
	} finally {
		h.cleanup();
	}
}, 60_000);

test("plan tick never prints a quiet-worktree age from a cut-off mtime walk", async () => {
	const h = await stuckWorkerHarness({ filesAgeMs: 40 * 60_000, elapsedMs: 40 * 60_000, bulkFiles: 4100 });
	try {
		await h.ticks.at(-1)!();
		const text = h.sent.join("\n");
		expect(text).not.toContain("no file change in its worktree");
		expect(text).not.toMatch(/for \d{4,} min/);
	} finally {
		h.cleanup();
	}
}, 60_000);

test("plan tick negative control: a worker whose worktree changed recently is not a suspect", async () => {
	const h = await stuckWorkerHarness({ filesAgeMs: 60_000, elapsedMs: 40 * 60_000 });
	try {
		await h.ticks.at(-1)!();
		expect(h.sent.join("\n")).not.toContain("suspect:");
		expect(h.trace().length).toBeGreaterThan(0); // the silent tick still says why
	} finally {
		h.cleanup();
	}
}, 60_000);

test("plan ticker is re-armed on a turn when no tick ran for three minutes", async () => {
	const h = await stuckWorkerHarness({ filesAgeMs: 60_000, elapsedMs: 40 * 60_000 });
	const realNow = Date.now.bind(Date);
	try {
		const armed = h.ticks.length;
		await h.handlers.get("turn_start")!({}, h.ctx);
		expect(h.ticks.length).toBe(armed); // fresh: no re-arm
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + 4 * 60_000);
		await h.handlers.get("turn_start")!({}, h.ctx);
		expect(h.ticks.length).toBe(armed + 1);
		expect(h.trace().some(row => row.plantick === "ticker-rearmed")).toBe(true);
	} finally {
		h.cleanup();
	}
}, 60_000);

function actionable(reason: string, target: string) {
	const first = reason.split("\n")[0];
	expect(first.length).toBeLessThanOrEqual(100);
	expect(first).toContain(target);
	expect(first).not.toMatch(/^(Blocked:|Stop waiting:|Refusing|todo done is blocked until)/);
}

test("a genuine Main message announces reply-before-wait once before either refusal", async () => {
	const h = await noticeHarness([], Date.now() + 3600_000);
	try {
		const entry = humanQuestion();
		await h.handlers.get("message_start")?.({ message: entry.message }, h.ctx);
		h.entries.push(entry);
		const notices = () => h.notices.filter(notice => notice.customType === "todo-gate-user-reply");
		expect(notices()).toHaveLength(1);
		expect(notices()[0].content).toContain("before any wait/stop");
		const refusal = await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx);
		actionable(refusal.reason, "2026-10-24T04:23:16.000Z");
		expect((await h.handlers.get("session_stop")!({}, h.ctx)).decision).toBe("block");
		expect(notices()).toHaveLength(1);
		h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Two checks left; finishing them now." }] } });
		expect(await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx)).toBeUndefined();
	} finally { h.shutdown(); }
});

test("appended incomplete rows announce the exact schedule batch before any work can be refused", async () => {
	const h = await noticeHarness([], Date.now() + 3600_000);
	try {
		const phases = [{ name: "New scope", tasks: [{ content: "Publish cobalt tile", status: "pending" }] }];
		await h.handlers.get("tool_result")!({ toolName: "todo", input: { op: "append" }, content: [], details: { phases }, isError: false }, h.ctx);
		const notices = h.notices.filter(notice => notice.customType === "todo-gate-schedule");
		expect(notices).toHaveLength(1);
		expect(notices[0].content).toContain('task:"Publish cobalt tile"');
		expect(notices[0].content).toContain('op:"schedule"');
		expect(notices[0].content).toContain("dependencies:[]");
		expect(notices[0].content).toContain("optimisticSeconds:O");
		const callShape = notices[0].content.split("\n")[1].split("; use actual")[0].replace("Call todo ", "");
		const schedule = Bun.JSON5.parse(callShape.replace(/:O\b/g, ":10").replace(/:L\b/g, ":20").replace(/:P\b/g, ":30"));
		expect(schedule).toMatchObject({ op: "schedule", updates: [{ task: "Publish cobalt tile", dependencies: [], estimate: { optimisticSeconds: 10, likelySeconds: 20, pessimisticSeconds: 30 } }] });
		expect(notices[0].content).toContain("non-read work is refused");
		expect(notices[0].content.split("\n")).toHaveLength(2);
		await h.handlers.get("tool_result")!({ toolName: "todo", content: [], details: { phases }, isError: false }, h.ctx);
		expect(h.notices.filter(notice => notice.customType === "todo-gate-schedule")).toHaveLength(1);
	} finally { h.shutdown(); }
});

test("an unstaffed ready row announces staffing before wait and chief-work refusals", async () => {
	const now = Date.now();
	const phases = chainedPlan(3, now);
	for (const task of phases[0].tasks) { task.schedule.dependencies = []; task.schedule.owner = undefined; }
	const h = await noticeHarness(phases, now + 3600_000);
	try {
		const notices = () => h.notices.filter(notice => notice.customType === "todo-gate-staffing");
		expect(notices()).toHaveLength(1);
		expect(notices()[0].content).toContain('"Row 1"');
		expect(notices()[0].content).toContain("wait will be refused until staffed");
		const wait = await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx);
		actionable(wait.reason, "Row 1");
		const bash = await h.handlers.get("tool_call")!({ toolName: "bash", input: { command: "bun test" } }, h.ctx);
		actionable(bash.reason, "Row 1");
		expect(bash.reason.split("\n")[0]).toContain("task");
		expect(notices()).toHaveLength(1);
		h.setRecent(phases[0].tasks.map((task, index) => ({ id: `staff-${index}`, agentId: `staff-${index}`, type: "task", status: "running", label: task.content })));
	} finally { h.shutdown(); }
});

test("80-percent ETA notice and second-reestimate warning precede consistent schedule refusals", async () => {
	const previousLane = process.env.OMP_LANE_UNIT;
	delete process.env.OMP_LANE_UNIT;
	let now = Date.now();
	const origin = now;
	const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
	const phases = chainedPlan(1, now);
	const row = phases[0].tasks[0];
	row.content = "Polish amber chart";
	row.schedule.startedAt = origin;
	row.schedule.reestimateCount = 0;
	row.schedule.estimateRevision = 1;
	const forecast = (phases, options) => {
		const out = forecastTodoPlan(phases, options);
		Object.assign(out.rows[0], { startedAt: origin, resourceFinish: origin + 100_000, estimateUpdatedAt: origin,
			estimateRangeSeconds: { optimistic: 60, likely: 100, pessimistic: 140 },
			estimateRevision: row.schedule.estimateRevision, reestimateCount: row.schedule.reestimateCount,
			overdue: now > origin + 100_000 });
		return out;
	};
	const h = await noticeHarness(phases, now + 3600_000, [], 0, forecast);
	h.ctx.getAsyncJobSnapshot = () => ({ running: [{ id: "worker-a", type: "task", status: "running", label: row.content, startTime: origin - 3600_000 }], recent: [], nonJobAgents: [] });
	try {
		expect(h.notices.filter(n => n.customType === "todo-gate-eta")).toHaveLength(0);
		now = origin + 80_000;
		await h.tick();
		const eta = h.notices.filter(n => n.customType === "todo-gate-eta");
		expect(eta).toHaveLength(1);
		expect(eta[0].content).toContain('"Polish amber chart"');
		expect(eta[0].content).toContain("evidence + a new estimate");
		expect(eta[0].content).toContain("third same-owner reestimate is refused");
		now = origin + 101_000;
		const input = { op: "schedule", updates: [{ task: row.content, estimate: { likelySeconds: 200, updatedAt: now } }] };
		const missed = await h.handlers.get("tool_call")!({ toolName: "todo", input }, h.ctx);
		actionable(missed.reason, "Polish amber chart");
		expect(missed.reason).toContain("evidence");
		expect(await h.handlers.get("tool_call")!({ toolName: "todo", input: { ...input, updates: [{ ...input.updates[0], evidence: "Renderer now returns a partial artifact; integration remains." }] } }, h.ctx)).toBeUndefined();
		row.schedule.reestimateCount = 2;
		row.schedule.estimateRevision = 3;
		await h.handlers.get("tool_result")!({ toolName: "todo", content: [], details: { phases }, isError: false }, h.ctx);
		const caps = () => h.notices.filter(n => n.customType === "todo-gate-cap");
		expect(caps()).toHaveLength(1);
		expect(caps()[0].content).toContain("next same-owner reestimate is refused");
		expect(caps()[0].content).toContain("proc://worker-a/kill");
		const cap = await h.handlers.get("tool_call")!({ toolName: "todo", input }, h.ctx);
		actionable(cap.reason, "Polish amber chart");
		expect(cap.reason).toContain("proc://worker-a/kill");
		await h.tick();
		expect(caps()).toHaveLength(1);
		for (const notice of [...eta, ...caps()]) expect(notice.content.split("\n").length).toBeLessThanOrEqual(2);
	} finally { h.shutdown(); nowSpy.mockRestore(); if (previousLane === undefined) delete process.env.OMP_LANE_UNIT; else process.env.OMP_LANE_UNIT = previousLane; }
});


test("cap refusal blocks main wait through check-ins and owner edits until kill plus reassignment", async () => {
	const now = Date.now();
	const phases = chainedPlan(1, now);
	const row = phases[0].tasks[0];
	row.content = "Publish cobalt map";
	const forecast = (phases, options) => {
		const out = forecastTodoPlan(phases, options);
		Object.assign(out.rows[0], { estimateUpdatedAt: now, reestimateCount: 2,
			estimateRangeSeconds: { optimistic: 60, likely: 180, pessimistic: 420 } });
		return out;
	};
	const h = await noticeHarness(phases, now + 3600_000, [], 0, forecast);
	let running = [{ id: "worker-a", type: "task", status: "running", label: row.content, startTime: now }];
	h.ctx.getAsyncJobSnapshot = () => ({ running, recent: [], nonJobAgents: [] });
	const call = (toolName, input = {}) => h.handlers.get("tool_call")!({ toolName, input }, h.ctx);
	const killResult = (isError = false) => h.handlers.get("tool_result")!({ toolName: "write", isError,
		input: { path: "proc://worker-a/kill" }, content: [],
		details: { proc: { op: "cancel", cancelled: [{ id: "worker-a", status: "cancelled" }] } } }, h.ctx);
	try {
		const cap = await call("todo", { op: "schedule", updates: [{ task: row.content, estimate: { likelySeconds: 200 } }] });
		expect(cap?.block).toBe(true);
		const blocked = await call("wait");
		expect(blocked?.block).toBe(true);
		expect(blocked.reason.split("\n")[0]).toContain('Kill worker-a; reassign "Publish cobalt map" before wait.');
		expect(blocked.reason.split("\n")[0].length).toBeLessThanOrEqual(100);
		expect(await call("read", { path: "proc://worker-a" })).toBeUndefined();
		await call("write", { path: "agent://worker-a", content: "Report progress" });
		expect((await call("wait"))?.block).toBe(true);
		const header = h.ctx.sessionManager.getHeader;
		h.ctx.sessionManager.getHeader = () => ({ id: "child", parentSession: "main" });
		expect((await call("wait"))?.block).not.toBe(true);
		h.ctx.sessionManager.getHeader = header;
		row.schedule.owner = "worker-b";
		running.push({ ...running[0], id: "worker-b" });
		expect((await call("wait"))?.block).toBe(true); // renaming alone must not orphan the old worker
		await killResult(true);
		expect((await call("wait"))?.block).toBe(true);
		running = running.filter(job => job.id !== "worker-a");
		await killResult();
		expect((await call("wait"))?.block).not.toBe(true);
		const notices = h.notices.filter(n => n.customType === "todo-gate-recovery");
		expect(notices).toHaveLength(1);
		expect(notices[0].content).toContain("wait will be refused");
	} finally { h.shutdown(); }
});

test("sixty-minute escalation refuses repeated waits, ignores lead check-ins, and accepts a newer worker yield", async () => {
	const h = await stuckWorkerHarness({ filesAgeMs: 70 * 60_000, elapsedMs: 70 * 60_000 });
	const call = (toolName, input = {}) => h.handlers.get("tool_call")!({ toolName, input }, h.ctx);
	try {
		await h.ticks.at(-1)!();
		expect(h.sent.join("\n")).toContain("STUCK over 60 min, stop it now");
		for (let i = 0; i < 2; i++) {
			const blocked = await call("wait");
			expect(blocked?.block).toBe(true);
			expect(blocked.reason.split("\n")[0]).toBe('Kill worker-a or get its new receipt before wait.');
		}
		expect(await call("read", { path: "proc://worker-a" })).toBeUndefined();
		await call("write", { path: "agent://worker-a", content: "done/left?" });
		expect((await call("wait"))?.block).toBe(true);
		fs.appendFileSync(h.workerFile, JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "yield", isError: false, timestamp: Date.now() + 1, content: [{ type: "text", text: "Artifact: cobalt.svg; proof passed" }] } }) + "\n");
		expect((await call("wait"))?.block).not.toBe(true);
		await h.ticks.at(-1)!();
		expect((await call("wait"))?.block).not.toBe(true);
		expect(h.sent.filter(text => text.includes("wait will be refused") && text.includes("worker-a"))).toHaveLength(1);
	} finally { h.cleanup(); }
}, 60_000);

test("cap recovery clears when its worker is gone and the row has a running new owner, without a kill", async () => {
	const now = Date.now();
	const phases = chainedPlan(1, now);
	const forecast = (phases, options) => {
		const out = forecastTodoPlan(phases, options);
		for (const row of out.rows) Object.assign(row, { estimateUpdatedAt: now, reestimateCount: 2 });
		return out;
	};
	const h = await noticeHarness(phases, now + 3600_000, [], 0, forecast);
	let running = [{ id: "worker-a", type: "task", status: "running", label: "Row 1", startTime: now }];
	h.ctx.getAsyncJobSnapshot = () => ({ running, recent: [], nonJobAgents: [] });
	const call = (toolName, input = {}) => h.handlers.get("tool_call")!({ toolName, input }, h.ctx);
	try {
		await call("todo", { op: "schedule", updates: [{ task: "Row 1", estimate: { updatedAt: now + 1 } }] });
		expect((await call("wait"))?.reason).toContain("reassign");
		// Live runtime 2026-10-28: after a restart the old worker was absent and its kill said "not found".
		phases[0].tasks[0].schedule.owner = "worker-b";
		running = [{ id: "worker-b", type: "task", status: "running", label: "Row 1", startTime: now }];
		expect((await call("wait"))?.reason ?? "").not.toContain("Kill worker-a");
	} finally { h.shutdown(); }
});

test("stuck escalation drops once its worker is gone from the job table without a kill or receipt", async () => {
	const h = await stuckWorkerHarness({ filesAgeMs: 70 * 60_000, elapsedMs: 70 * 60_000 });
	const call = () => h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx);
	try {
		await h.ticks.at(-1)!();
		expect((await call())?.block).toBe(true);
		// Live 2026-10-28: after a restart the escalated worker was absent from proc:// and recent,
		// and every wait on five live workers was refused until it was "killed".
		h.ctx.getAsyncJobSnapshot = () => ({ running: [], recent: [], nonJobAgents: [] });
		// The row is now merely unstaffed; the recovery demand on the vanished worker is gone.
		expect((await call())?.reason ?? "").not.toContain("Kill worker-a");
	} finally { h.cleanup(); }
}, 60_000);

test("stuck escalation clears on kill with a new running owner; a sub-hour quiet worker permits wait", async () => {
	const h = await stuckWorkerHarness({ filesAgeMs: 50 * 60_000, elapsedMs: 50 * 60_000 });
	const call = () => h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx);
	try {
		await h.ticks.at(-1)!();
		expect((await call())?.block).not.toBe(true);
		h.running[0].startTime -= 20 * 60_000;
		await h.ticks.at(-1)!();
		expect((await call())?.block).toBe(true);
		h.phases[0].tasks[0].schedule.owner = "worker-b";
		h.running.splice(0, 1, { ...h.running[0], id: "worker-b", agentId: "worker-b", startTime: Date.now() });
		await h.handlers.get("tool_result")!({ toolName: "write", input: { path: "proc://worker-a/kill" }, content: [], isError: false,
			details: { proc: { op: "cancel", cancelled: [{ id: "worker-a", status: "cancelled" }] } } }, h.ctx);
		expect((await call())?.block).not.toBe(true);
	} finally { h.cleanup(); }
}, 60_000);


test("cap recovery survives session restore, requires reassign after kill, and permits row closure or drop", async () => {
	const now = Date.now();
	const phases = chainedPlan(1, now);
	const forecast = (phases, options) => {
		const out = forecastTodoPlan(phases, options);
		for (const row of out.rows) Object.assign(row, { estimateUpdatedAt: now, reestimateCount: 2 });
		return out;
	};
	let h = await noticeHarness(phases, now + 3600_000, [], 0, forecast);
	let running = [{ id: "worker-a", type: "task", status: "running", label: "Row 1", startTime: now }];
	const snapshot = () => ({ running, recent: [], nonJobAgents: [] });
	const call = (toolName, input = {}) => h.handlers.get("tool_call")!({ toolName, input }, h.ctx);
	const cap = () => call("todo", { op: "schedule", updates: [{ task: "Row 1", estimate: { updatedAt: now + 1 } }] });
	h.ctx.getAsyncJobSnapshot = snapshot;
	try {
		await cap();
		expect((await call("wait"))?.block).toBe(true);
		await Promise.resolve();
		const entries = [...h.entries];
		h.shutdown();
		h = await noticeHarness(phases, now + 3600_000, [], 0, forecast, entries);
		h.ctx.getAsyncJobSnapshot = snapshot;
		expect((await call("wait"))?.block).toBe(true);
		running = [];
		await h.handlers.get("tool_result")!({ toolName: "write", isError: false, input: { path: "proc://worker-a/kill" }, content: [],
			details: { proc: { op: "cancel", cancelled: [{ id: "worker-a", status: "cancelled" }] } } }, h.ctx);
		expect((await call("wait"))?.reason).toContain("reassign");
		phases[0].tasks[0].status = "blocked";
		phases[0].tasks[0].blocker = "Waiting for map layout";
		expect((await call("wait"))?.reason).toContain("reassign");
		phases[0].tasks[0].status = "completed";
		expect((await call("wait"))?.block).not.toBe(true);
		phases[0].tasks[0].status = "in_progress";
		running = [{ id: "worker-a", type: "task", status: "running", label: "Row 1", startTime: now + 10 }];
		await cap();
		expect((await call("wait"))?.block).toBe(true);
		phases[0].tasks.splice(0, 1);
		expect((await call("wait"))?.block).not.toBe(true);
	} finally { h.shutdown(); }
});

test("stuck wait requires a fresh successful yield or completed result, never old receipts or failed yields", async () => {
	const h = await stuckWorkerHarness({ filesAgeMs: 70 * 60_000, elapsedMs: 70 * 60_000 });
	const call = () => h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx);
	try {
		const old = Date.now() - 1000;
		fs.appendFileSync(h.workerFile, JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "yield", timestamp: old, content: [] } }) + "\n");
		await h.ticks.at(-1)!();
		expect((await call())?.block).toBe(true);
		fs.appendFileSync(h.workerFile, JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "yield", isError: true, timestamp: Date.now() + 1, content: [] } }) + "\n");
		expect((await call())?.block).toBe(true);
		const recent = [{ ...h.running[0], status: "completed", endTime: old }];
		h.ctx.getAsyncJobSnapshot = () => ({ running: h.running, recent, nonJobAgents: [] });
		expect((await call())?.block).toBe(true);
		recent[0].endTime = Date.now() + 1;
		h.running.splice(0);
		expect((await call())?.block).not.toBe(true);
	} finally { h.cleanup(); }
}, 60_000);


async function criticalSplitHarness({ capacity = 2, critical = true, model = "nvidia/nemotron-3.5-lightning:free", effort = "low", runningCritical = true, profile = "reviewer", projectPolicy, modelOverride, maxEffort, freeRole = "test-provider/nvidia/nemotron-3.5-lightning:free", defaultEffort = "high", recordIdentity = true } = {}) {
	const now = Date.now();
	const phases = chainedPlan(2, now);
	const [map, fix] = phases[0].tasks;
	map.content = "Map Litterbox screenshot defects to current HEAD";
	fix.content = "Fix Litterbox screenshot defects on Android";
	fix.schedule.dependencies = [map.content];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restaff-policy-"));
  if (projectPolicy) {
    fs.mkdirSync(path.join(cwd, ".omp", "agents"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".omp", "agents", `${profile}.md`), projectPolicy);
  }
  const settings = Settings.isolated({
    modelRoles: { free: freeRole, fast: "test-provider/capable-model", judgment: "test-provider/capable-model" },
    defaultThinkingLevel: defaultEffort,
    ...(modelOverride ? { "task.agentModelOverrides": { [profile]: modelOverride } } : {}),
    ...(maxEffort ? { "task.maxEffort": maxEffort } : {}),
  });
  const sessionManager = SessionManager.inMemory(cwd);
  if (recordIdentity) sessionManager.appendSessionInit({ agent: profile, systemPrompt: [], task: map.content, tools: [] });
  const models = [...new Set([model, "capable-model", "nvidia/nemotron-3.5-lightning:free"])].map(id => buildModel({
    provider: "test-provider", id, name: id, api: "openai-completions", baseUrl: "https://example.invalid",
    reasoning: true, thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] },
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
  }));
	const registry = new AgentRegistry();
	registry.register({ id: "worker-a", displayName: "worker-a", kind: "sub",
    session: { model: models.find(candidate => candidate.id === model), thinkingLevel: effort, settings, sessionManager,
      effectiveExtensionRoots: { explicit: [import.meta.dir], mode: "explicit-only", configured: [], configuredLevel: "user" } } });
	const registrySpy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	const forecast = (phases, options) => {
		const out = forecastTodoPlan(phases, options);
		for (const row of out.rows) row.critical = critical && (runningCritical || row.content === fix.content);
		return out;
	};
	const h = await noticeHarness(phases, now + 3600_000, [], 0, forecast);
	h.ctx.getTaskMaxConcurrency = () => capacity;
  h.ctx.cwd = cwd;
  h.ctx.modelRegistry = { getAvailable: () => models };
  const running = [{ id: "task-1", agentId: "worker-a", ownerId: "main", type: "task", status: "running", label: map.content, command: undefined, startTime: now, endTime: undefined }];
	h.ctx.getAsyncJobSnapshot = () => ({ running, recent: [], nonJobAgents: [] });
	const call = (toolName, input = {}) => h.handlers.get("tool_call")({ toolName, input }, h.ctx);
  return { ...h, phases, map, fix, running, call, settings, registry, cwd, shutdown: () => { h.shutdown(); registrySpy.mockRestore(); fs.rmSync(cwd, { recursive: true, force: true }); } };
}

test("critical split: Litterbox wait names both rows and the misrouted worker, once per revision", async () => {
	const h = await criticalSplitHarness();
	try {
		const result = await h.call("wait");
		expect(result?.block).toBe(true);
		expect(result.reason).toContain(h.map.content);
		expect(result.reason).toContain(h.fix.content);
		expect(result.reason).toContain("nvidia/nemotron-3.5-lightning:free");
		expect(result.reason).toMatch(/Restaff/i);
		expect(result.reason).toMatch(/required model/i);
		expect(result.reason).toMatch(/partial output/i);
		expect(result.reason).toContain("append");
		expect(await h.call("wait")).toBeUndefined();
		h.fix.schedule.resources = ["changed-scope"];
		expect((await h.call("wait"))?.block).toBe(true);
	} finally { h.shutdown(); }
});

test("critical split: an appended parallel row answers the refusal even after it is staffed", async () => {
	const h = await criticalSplitHarness({ capacity: 3 });
	try {
		expect((await h.call("wait"))?.block).toBe(true);
		expect((await h.call("todo", { op: "append", tasks: [{ content: "Prepare Android verification fixtures" }] }))?.block).not.toBe(true);
		const split = { ...h.fix, content: "Prepare Android verification fixtures", status: "pending", schedule: { ...h.fix.schedule, dependencies: [], owner: "fixture-worker" } };
		h.phases[0].tasks.push(split);
		expect((await h.call("wait"))?.block).toBe(true); // still needs a worker
		split.status = "in_progress";
		h.running.push({ ...h.running[0], id: "task-2", agentId: "fixture-worker", label: "Prepare Android verification fixtures" });
		expect(await h.call("wait")).toBeUndefined();
		expect(await h.call("wait")).toBeUndefined();
	} finally { h.shutdown(); }
});

test("critical split: dropping a dependency answers the refusal", async () => {
	const h = await criticalSplitHarness();
	try {
		expect((await h.call("wait"))?.block).toBe(true);
		h.fix.schedule.dependencies = [];
		h.fix.status = "in_progress";
		h.fix.schedule.owner = "worker-a";
		expect(await h.call("wait")).toBeUndefined();
	} finally { h.shutdown(); }
});

test("critical split: an honest idle-wait override lets an unsplittable chain wait", async () => {
	const h = await criticalSplitHarness();
	try {
		expect((await h.call("wait"))?.block).toBe(true);
		expect((await h.call("todo", { op: "schedule", updates: [], override: "idle-wait: both Android fixes require the worker's uncommitted defect map" }))?.block).not.toBe(true);
		expect(await h.call("wait")).toBeUndefined();
	} finally { h.shutdown(); }
});

test("critical split: zero free slots and a non-critical single worker allow wait", async () => {
	for (const options of [{ capacity: 1 }, { critical: false }]) {
		const h = await criticalSplitHarness(options);
		try { expect(await h.call("wait")).toBeUndefined(); }
		finally { h.shutdown(); }
	}
});

test("critical split: a pending critical row behind a running non-critical row still refuses", async () => {
	const h = await criticalSplitHarness({ runningCritical: false, model: "capable-model", effort: "high" });
	try {
		const result = await h.call("wait");
		expect(result?.block).toBe(true);
		expect(result.reason).toContain(h.fix.content);
		expect(result.reason).toContain(h.map.content);
		expect(result.reason).not.toContain("Restaff");
	} finally { h.shutdown(); }
});
test("critical split: free models and low effort are each flagged in refusal and plan check", async () => {
	for (const options of [{ model: "nvidia/nemotron-3.5-lightning:free", effort: "high" }, { model: "capable-model", effort: "low" }]) {
		const h = await criticalSplitHarness(options);
		try {
			const result = await h.call("wait");
			expect(result?.block).toBe(true);
			expect(result.reason).toContain(options.model);
			expect(result.reason).toContain(options.effort);
			expect(result.reason).toMatch(/Restaff/i);
			expect(result.reason).toMatch(/required model/i);
			await h.tick();
			const check = h.notices.filter(n => n.customType === "todo-plan-check").at(-1)?.content ?? "";
			expect(check).toContain(h.map.content);
			expect(check).toContain(options.model);
			expect(check).toContain(options.effort);
			expect(check).toMatch(/Restaff/i);
		} finally { h.shutdown(); }
	}
});

test("critical split: a permitted mechanical low/free route never restaffs in refusal or plan check", async () => {
	const h = await criticalSplitHarness({ profile: "gate-runner" });
	try {
		const result = await h.call("wait");
		expect(result?.block).toBe(true);
		expect(result.reason).toContain(h.map.content);
		expect(result.reason).toContain(h.fix.content);
		expect(result.reason).not.toMatch(/Restaff/i);
		await h.tick();
		const check = h.notices.filter(n => n.customType === "todo-plan-check").at(-1)?.content ?? "";
		expect(check).toContain(h.map.content);
		expect(check).not.toMatch(/Restaff/i);
	} finally { h.shutdown(); }
});
const restaffPolicy = (name, selector, level = "low") => `---\nname: ${name}\ndescription: effective restaff control\nmodel: "${selector}"\n${level ? `thinking-level: ${level}\n` : ""}---\nRun the assigned check.\n`;
test.each([
  { name: "project reviewer overrides bundled policy", projectPolicy: restaffPolicy("reviewer", "@free"), warns: false },
  { name: "custom low/free role", profile: "custom-check", projectPolicy: restaffPolicy("custom-check", "@free"), warns: false },
  { name: "custom strong role", profile: "custom-check", projectPolicy: restaffPolicy("custom-check", "@judgment", "high"), warns: true },
  { name: "operator permits reviewer low/free", modelOverride: "@free:low", warns: false },
  { name: "operator requires gate-runner strong route", profile: "gate-runner", modelOverride: "@judgment:high", warns: true },
  { name: "low operator effort ceiling", model: "capable-model", maxEffort: "low", warns: false },
  { name: "high operator effort ceiling", model: "capable-model", maxEffort: "high", warns: true },
  { name: "free alias resolves to paid model", profile: "gate-runner", freeRole: "test-provider/capable-model:high", effort: "high", warns: true },
  { name: "compliant mixed-effort free fallback", modelOverride: "test-provider/capable-model:high,test-provider/nvidia/nemotron-3.5-lightning:free:low", warns: false },
  { name: "truly under-effort free fallback", modelOverride: "test-provider/capable-model:high,test-provider/nvidia/nemotron-3.5-lightning:free:high", warns: true },
  { name: "absent role effort inherits default", profile: "custom-check", projectPolicy: restaffPolicy("custom-check", "@judgment", ""), model: "capable-model", warns: true },
])("critical split: effective policy $name", async ({ name: _name, warns, ...options }) => {
  const h = await criticalSplitHarness(options);
  try {
    expect(h.registry.get("worker-a").history).toBeUndefined(); // no asynchronous roster hydration required
    expect(h.running[0]).not.toHaveProperty("agent");
    const refusal = await h.call("wait");
    expect(refusal?.block).toBe(true);
    expect(/Restaff/i.test(refusal.reason)).toBe(warns);
    await h.tick();
    const check = h.notices.filter(n => n.customType === "todo-plan-check").at(-1)?.content ?? "";
    expect(check).toContain(h.map.content);
    expect(/Restaff/i.test(check)).toBe(warns);
  } finally { h.shutdown(); }
});

test("critical split: missing running identity cannot invent a policy mismatch", async () => {
  const h = await criticalSplitHarness({ recordIdentity: false });
  try {
    expect((await h.call("wait"))?.reason).not.toMatch(/Restaff/i);
    await h.tick();
    expect(h.notices.filter(n => n.customType === "todo-plan-check").at(-1)?.content ?? "").not.toMatch(/Restaff/i);
  } finally { h.shutdown(); }
});



test("critical split: a lone running critical row with nothing parked behind it may wait", async () => {
	const h = await criticalSplitHarness({ model: "capable-model", effort: "high" });
	try {
		h.phases[0].tasks.pop();
		expect(await h.call("wait")).toBeUndefined();
	} finally { h.shutdown(); }
});

test("critical split: no forced split for external waits or multiple workers on the running row", async () => {
	for (const scenario of ["external", "multiple"]) {
		const h = await criticalSplitHarness({ capacity: 3, runningCritical: scenario === "multiple" });
		try {
			if (scenario === "external") h.fix.schedule.dependencies.push("external approval");
			else {
				h.phases[0].tasks.pop();
				h.running.push({ ...h.running[0], id: "worker-a-2", agentId: "other-worker" });
			}
			expect(await h.call("wait")).toBeUndefined();
		} finally { h.shutdown(); }
	}
});


test("critical split: completed prerequisites do not hide a pending critical wait", async () => {
	const h = await criticalSplitHarness({ runningCritical: false });
	try {
		const completed = { ...h.fix, content: "Fixture audit accepted", status: "completed", schedule: { ...h.fix.schedule, dependencies: [] } };
		h.phases[0].tasks.push(completed);
		h.fix.schedule.dependencies.push(completed.content);
		const result = await h.call("wait");
		expect(result?.block).toBe(true);
		expect(result.reason).toContain(h.fix.content);
		expect(result.reason).not.toContain(completed.content);
	} finally { h.shutdown(); }
});

test("critical split: switching sessions resets the once-per-plan acknowledgement", async () => {
	const h = await criticalSplitHarness();
	try {
		expect((await h.call("wait"))?.block).toBe(true);
		expect(await h.call("wait")).toBeUndefined();
		await h.handlers.get("session_switch")({}, h.ctx);
		expect((await h.call("wait"))?.block).toBe(true);
	} finally { h.shutdown(); }
});

test("recovery gates request wait interruption while startup advice stays passive", async () => {
 const now = Date.now();
 // A cap recovery outlives its worker; a stuck one only lives while its worker runs.
 const h = await noticeHarness(chainedPlan(1, now), now + 3600_000, [], 0, undefined, [{ type: "custom", customType: "todo-dispatch-sprint-state", data: {
  version: 1, recoveryWaits: [{ kind: "cap", row: "Row 1", owner: "worker-a", at: now - 1000 }]
 } }]);
 try {
  const info = h.notices.find(notice => notice.customType === "todo-gate-worker-names");
  const recovery = h.notices.find(notice => notice.customType === "todo-gate-recovery");
  expect(info?.delivery).toMatchObject({ deliverAs: "aside", triggerTurn: false, interruptWait: false });
  expect(recovery?.delivery).toMatchObject({ deliverAs: "aside", triggerTurn: false, interruptWait: true });
  expect((await h.handlers.get("tool_call")!({ toolName: "wait", input: {} }, h.ctx))?.block).toBe(true);
 } finally { h.shutdown(); }
});
