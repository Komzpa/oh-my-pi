// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
// Rows only the user can unblock, while the user is away: they wait for the user's return with the
// chief's own proposal, they do not stall the session, and the user gets them first on return.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatPlanForecast, formatTaskForecast, formatTaskForecastDisplay } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import {
	forecastPlanWithUserWaits as forecastTodoPlan,
	getPlanningIssuesWithUserWaits as getTodoPlanningIssues,
} from "./todo-schedule-away";
import todoDispatch, { decideTodoDispatch } from "./todo_dispatch";

const APPROVE = "Approve the load-test budget";
const DEPLOY = "Deploy the load test with the budget";
const COPY = "Copy the dashboard JSON";
const RESTART = "Restart the flaky service";
const VERIFY = "Verify the service after restart";
const RUNNING = "Draft the report";
const SHIPPED = "Ship the capacity table";
const APPROVE_BLOCKER = "waits for user: approve the 3m budget proposal: approve 3m, because the load test fits in it with 20% headroom";

function row(content: string, status: string, dependencies: string[], now: number, extra: Record<string, unknown> = {}) {
	return {
		content,
		status,
		...extra,
		schedule: {
			dependencies,
			resources: [content],
			...(extra.owner ? { owner: extra.owner } : {}),
			...(extra.finishedAt ? { finishedAt: extra.finishedAt, startedAt: (extra.finishedAt as number) - 60_000 } : {}),
			estimate: { optimisticSeconds: 300, likelySeconds: 600, pessimisticSeconds: 900, confidence: "medium", basis: "away fixture", updatedAt: now - 60_000 },
		},
	};
}

function plan(now: number) {
	return [
		{
			name: "Work",
			tasks: [
				row(APPROVE, "blocked", [], now, { blocker: APPROVE_BLOCKER }),
				row(DEPLOY, "pending", [APPROVE], now),
				row(COPY, "blocked", [], now, { blocker: "waits for user: the Copy JSON from the dashboard only the user can open" }),
				row(RESTART, "blocked", [], now, { blocker: "service returns 502 after deploy" }),
				row(VERIFY, "pending", [RESTART], now),
			],
		},
	];
}

const sdk = { forecastTodoPlan, formatPlanForecast, formatTaskForecast };

function decide(phases: unknown, presence: "away" | "watching" | "firefighting", now: number, forecast = forecastTodoPlan) {
	return decideTodoDispatch(
		{
			phases,
			jobs: { running: [], recent: [], nonJobAgents: [] },
			isMainSession: true,
			taskEnabled: true,
			now,
			capacity: 4,
			dispatchGateAvailable: true,
			deadline: { goalId: "goal-1", deadlineAt: now + 6 * 3_600_000 },
			presence,
		},
		{ ...sdk, forecastTodoPlan: forecast },
	);
}

test("1. a row waiting for the user shows as waits for you with the chief's proposal, not needs unblock", () => {
	const now = Date.now();
	const forecast = forecastTodoPlan(plan(now), { now });
	const byContent = new Map(forecast.rows.map((r) => [r.content, r]));
	const waiting = formatTaskForecastDisplay(byContent.get(APPROVE)!, now);
	console.log(`HUD waiting row: ${APPROVE} · ${waiting}`);
	expect(waiting.startsWith("waits for you: approve the 3m budget · proposal: approve 3m")).toBe(true);
	expect(waiting).not.toContain("needs unblock");
	expect(formatTaskForecastDisplay(byContent.get(APPROVE)!, now, true)).toContain("20% headroom");
	expect(formatTaskForecastDisplay(byContent.get(COPY)!, now)).toContain("no proposal yet");
	expect(formatTaskForecast(byContent.get(APPROVE)!, now)).toContain("waits for you: approve the 3m budget");
	// Neighbour: a row blocked on a service keeps the recovery label.
	expect(formatTaskForecastDisplay(byContent.get(RESTART)!, now)).toStartWith("needs unblock: service returns 502");
});

test("2. a row waiting for the user without a proposal gets one notice: fill in your own proposal first", () => {
	const now = Date.now();
	const issues = getTodoPlanningIssues(plan(now)).filter((issue) => issue.code === "user-wait-without-proposal");
	expect(issues.map((issue) => issue.task)).toEqual([COPY]);
	expect(issues[0]!.message).toContain("fill in your own proposal first");
	expect(issues[0]!.message).toContain("not a user blocker: fix the doc or comment");
	// A host whose forecast predates user waits still gets the notice from the dispatcher.
	const oldHost = (phases: unknown, options: unknown) => {
		const result = forecastTodoPlan(phases, options);
		return { ...result, planningIssues: result.planningIssues.filter((issue) => issue.code !== "user-wait-without-proposal") };
	};
	const decision = decide(plan(now), "away", now, oldHost);
	expect(decision.alarms.filter((alarm) => alarm.startsWith("user-wait-without-proposal:"))).toEqual([`user-wait-without-proposal:${JSON.stringify(COPY)}`]);
	expect(forecastTodoPlan(plan(now), { now }).rows.find((r) => r.content === COPY)!.planningIssues?.[0]?.code).toBe("user-wait-without-proposal");
});

test("3. while away, a waiting row raises no recovery alarm, leaves the ETA, and its dependent proceeds on the proposal", () => {
	const now = Date.now();
	const away = decide(plan(now), "away", now);
	expect(away.alarms).not.toContain(`blocked-recovery:${JSON.stringify(APPROVE)}:${JSON.stringify(APPROVE_BLOCKER)}`);
	expect(away.dispatchableReady!.map((r) => r.content)).toContain(DEPLOY);
	expect(away.forecast!.rows.map((r) => r.content)).not.toContain(APPROVE);
	expect(away.forecast!.rows.find((r) => r.content === DEPLOY)!.resourceFinish).toBeNumber();
	expect(away.prompt).toContain(`${JSON.stringify(DEPLOY)} on proposal of ${JSON.stringify(APPROVE)}`);
	expect(away.onProposal).toEqual([[DEPLOY, [APPROVE]]]);
	const watching = decide(plan(now), "watching", now);
	expect(away.forecast!.unresolvedCount).toBe(watching.forecast!.unresolvedCount - 2);
	// The HUD forecast for an away user marks the dependent and keeps the parked row in place.
	const hud = forecastTodoPlan(plan(now), { now, userAway: true });
	expect(hud.rows.map((r) => r.content)).toEqual([APPROVE, DEPLOY, COPY, RESTART, VERIFY]);
	expect(hud.rows[0]!.parked).toBe(true);
	expect(formatTaskForecastDisplay(hud.rows[0]!, now)).toStartWith("waits for you:");
	expect(formatTaskForecastDisplay(hud.rows[1]!, now)).toContain("on proposal");
	expect(hud.unresolvedCount).toBe(away.forecast!.unresolvedCount);
});

test("3. negative control: while the user watches, a waiting row is recovered as today and holds its dependent", () => {
	const now = Date.now();
	for (const presence of ["watching", "firefighting"] as const) {
		const decision = decide(plan(now), presence, now);
		expect(decision.alarms).toContain(`blocked-recovery:${JSON.stringify(APPROVE)}:${JSON.stringify(APPROVE_BLOCKER)}`);
		expect(decision.dispatchableReady!.map((r) => r.content)).not.toContain(DEPLOY);
		expect(decision.prompt).not.toContain("on proposal of");
		expect(decision.awayWorkList ?? []).toEqual([]);
	}
});

test("3. neighbour: while away, a row blocked on a service still raises recovery and holds its dependent", () => {
	const now = Date.now();
	const decision = decide(plan(now), "away", now);
	expect(decision.alarms).toContain(`blocked-recovery:${JSON.stringify(RESTART)}:${JSON.stringify("service returns 502 after deploy")}`);
	expect(decision.alarms).toContain(`blocked-recovery:${JSON.stringify(COPY)}:${JSON.stringify("waits for user: the Copy JSON from the dashboard only the user can open")}`);
	expect(decision.dispatchableReady!.map((r) => r.content)).not.toContain(VERIFY);
});

const minutesAgo = (now: number, minutes: number) => {
	const at = now - minutes * 60_000;
	return { type: "message", timestamp: new Date(at).toISOString(), message: { role: "user", content: "go", timestamp: at } };
};

async function session(phases: unknown[], branch: unknown[], running: Array<{ id: string; label: string }>) {
	const cwd = mkdtempSync(join(tmpdir(), "todo-away-"));
	const now = Date.now();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "wait"],
		pi: { ...sdk, getLatestTodoPhasesFromEntries: () => phases, readGoalDeadline: () => ({ goalId: "goal-1", deadlineAt: now + 6 * 3_600_000 }) },
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const jobs = running.map((job) => ({ id: job.id, agentId: job.id, type: "task", status: "running", label: job.label, startTime: now }));
	const ctx = {
		cwd,
		sessionManager: { getHeader: () => ({ id: "away-session" }), getBranch: () => branch, getSessionFile: () => undefined },
		getAsyncJobSnapshot: () => ({ running: jobs, recent: [], nonJobAgents: jobs.map((job) => ({ id: job.id, live: true })) }),
		getTaskMaxConcurrency: () => 20,
		hasPendingMessages: () => false,
		isIdle: () => false,
		setTimeout: () => ({}),
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	const wait = () => handlers.get("tool_call")!({ toolName: "wait", toolCallId: "w", input: {} }, ctx) as { block?: boolean; reason?: string } | undefined;
	const context = () => ((handlers.get("context")!({ messages: [] }, ctx) as { messages?: Array<{ content: string }> } | undefined)?.messages?.at(-1)?.content ?? "");
	return { handlers, ctx, wait, context, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function stuckPlan(now: number) {
	return [
		{
			name: "Work",
			tasks: [
				row(RUNNING, "in_progress", [], now, { owner: "DraftReport" }),
				row(COPY, "blocked", [], now, { blocker: "waits for user: the Copy JSON from the dashboard" }),
				row(RESTART, "blocked", [], now, { blocker: "service returns 502 after deploy" }),
				row(VERIFY, "pending", [RESTART], now),
				row(SHIPPED, "completed", [], now, { finishedAt: now - 10 * 60_000 }),
			],
		},
	];
}

test("4. away with nothing ready, wait is refused once with the ordered work list", async () => {
	const now = Date.now();
	const phases = stuckPlan(now);
	const s = await session(phases, [minutesAgo(now, 120)], [{ id: "DraftReport", label: RUNNING }]);
	try {
		const first = s.wait();
		expect(first?.block).toBe(true);
		const reason = first!.reason!;
		const order = ["without your proposal", "decompose the blocked rows", "why it cannot start now", "quality pass over recently finished rows"].map((needle) => reason.indexOf(needle));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(reason).toContain(JSON.stringify(COPY));
		expect(reason).toContain(`${JSON.stringify(RESTART)} (holds 1)`);
		expect(reason).toContain(JSON.stringify(VERIFY));
		expect(reason).toContain(JSON.stringify(SHIPPED));
		expect(s.wait()).toBeUndefined();
	} finally {
		s.cleanup();
	}
});

test("4. away with an empty work list, wait is allowed", async () => {
	const now = Date.now();
	const phases = [{ name: "Work", tasks: [row(RUNNING, "in_progress", [], now, { owner: "DraftReport" }), row(APPROVE, "blocked", [], now, { blocker: APPROVE_BLOCKER })] }];
	const s = await session(phases, [minutesAgo(now, 120)], [{ id: "DraftReport", label: RUNNING }]);
	try {
		expect(s.wait()).toBeUndefined();
	} finally {
		s.cleanup();
	}
});

test("4. negative control: while the user watches, wait behaves as today", async () => {
	const now = Date.now();
	const s = await session(stuckPlan(now), [minutesAgo(now, 1)], [{ id: "DraftReport", label: RUNNING }]);
	try {
		expect(s.wait()).toBeUndefined();
	} finally {
		s.cleanup();
	}
});

test("5. when the user writes while away, one notice lists the waiting rows with proposals first in the next turn", async () => {
	const now = Date.now();
	const branch: unknown[] = [minutesAgo(now, 120)];
	const s = await session(plan(now), branch, []);
	try {
		expect(s.context()).not.toContain("THE USER IS BACK");
		s.handlers.get("input")!({ type: "input", source: "interactive", text: "back" }, s.ctx);
		branch.push(minutesAgo(Date.now(), 0));
		const first = s.context();
		expect(first.startsWith("THE USER IS BACK")).toBe(true);
		expect(first).toContain(`${JSON.stringify(APPROVE)}: approve the 3m budget — your proposal: approve 3m`);
		expect(first).toContain(`proceeded on it: ${JSON.stringify(DEPLOY)}`);
		expect(first).toContain(`${JSON.stringify(COPY)}: the Copy JSON from the dashboard only the user can open — no proposal recorded`);
		expect(first).toContain("todo unblock");
		expect(first.split("\nROLE:")[0]).not.toContain(JSON.stringify(RESTART));
		// Same turn: still the one notice, not a second one.
		expect(s.context().split("THE USER IS BACK").length - 1).toBe(1);
		s.handlers.get("agent_end")!({}, s.ctx);
		expect(s.context()).not.toContain("THE USER IS BACK");
	} finally {
		s.cleanup();
	}
});

test("5. presence leaving away without a typed message also brings the notice, once", async () => {
	const now = Date.now();
	const branch: unknown[] = [minutesAgo(now, 120)];
	const s = await session(plan(now), branch, []);
	try {
		expect(s.context()).not.toContain("THE USER IS BACK");
		branch.push(minutesAgo(Date.now(), 0));
		expect(s.context()).toStartWith("THE USER IS BACK");
		s.handlers.get("agent_end")!({}, s.ctx);
		expect(s.context()).not.toContain("THE USER IS BACK");
	} finally {
		s.cleanup();
	}
});

test("5. negative control: a message while the user already watches brings no return notice", async () => {
	const now = Date.now();
	const branch: unknown[] = [minutesAgo(now, 1)];
	const s = await session(plan(now), branch, []);
	try {
		s.context();
		s.handlers.get("input")!({ type: "input", source: "interactive", text: "more" }, s.ctx);
		branch.push(minutesAgo(Date.now(), 0));
		expect(s.context()).not.toContain("THE USER IS BACK");
	} finally {
		s.cleanup();
	}
});
