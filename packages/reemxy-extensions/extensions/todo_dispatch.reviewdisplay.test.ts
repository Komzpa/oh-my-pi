// @ts-nocheck -- replay frozen production rows through runtime hooks and the shared forecast.
import { expect, test, spyOn } from "bun:test";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import * as todos from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { idleUserReviewRefusal } from "./todo_dispatch";
import { probeReviewPage } from "./todo_review_opener";
import {
	forecastTodoPlan,
	formatPlanForecastDisplay,
	formatTaskForecastDisplay,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { isClosedTodo } from "@oh-my-pi/pi-tui/tools/todo";
import live from "./fixtures/reviewdisplay-dc-live.json";
const now = Date.parse("2026-11-05T14:23:00Z");
const url = "http://localhost:8767/review/dc/";

test("DC delivered legacy status is closed consistently; a late undelivered neighbour stays overdue", () => {
	const phases = structuredClone(live);
	// Restore deferred live work to exercise the overdue negative control.
	phases[0].tasks[1].schedule.postDeadline = false;
	const delivered = phases[0].tasks[0];
	delivered.schedule.reviewPage = url;
	delivered.schedule.handoffPending = false;
	delivered.schedule.audit = {
		delivery: schedule.todoRowDeliveryKey(delivered.schedule),
		repoPath: "/repo",
		head: "h",
		startedAt: now,
		agent: "qa-auditor",
		verdict: "pass",
	};
	const forecast = forecastTodoPlan(phases, { now });
	expect(isClosedTodo(delivered)).toBe(true);
	expect(forecast.rows[0].status).toBe("completed");
	expect(forecast.rows[0].overdue).toBe(false);
	expect(formatTaskForecastDisplay(forecast.rows[0], now)).toContain(`awaiting your review → ${url}`);
	const display = formatPlanForecastDisplay(forecast, now);
	expect(display).toContain("1 awaiting your review");
	expect(display).toContain("1 overdue");
	expect(forecast.rows[1].overdue).toBe(true);
	expect(forecast.rows[2].status).toBe("completed");
	expect(formatTaskForecastDisplay(forecast.rows[2], now)).not.toContain("awaiting your review");
	delivered.status = "completed";
	expect(forecastTodoPlan(phases, { now }).rows[0].overdue).toBe(false);
});

test("DC missing handoff repeatedly gates waits during CI, ordinary completion is unaffected", async () => {
	const jobs = { running: [{ status: "running" }], recent: [] };
	const seen = new Set();
	for (let i = 0; i < 2; i++)
		expect(await idleUserReviewRefusal(live, jobs, seen)).toContain(live[0].tasks[0].content);
	expect(await idleUserReviewRefusal([{ name: "Done", tasks: [live[0].tasks[2]] }], jobs, seen)).toBeUndefined();
});

test("admission and opener require the published matching result card, then open once", async () => {
	const row = live[0].tasks[0];
	let landed = "Commit abc — row: Another row";
	const fetch = spyOn(globalThis, "fetch").mockImplementation(async input =>
		String(input).endsWith("cards.json")
			? Response.json({ cards: [{ disposition: { kind: "delivered-change" }, landed }] })
			: String(input).endsWith("api/answers")
				? Response.json({})
				: new Response("page"),
	);
	try {
		const handlers = new Map();
		const entries = [];
		const opened = [];
		let current = structuredClone(live);
		current[0].tasks[0].status = "completed";
		delete current[0].tasks[0].schedule.review;
		const api = {
			on: (name, fn) => handlers.set(name, fn),
			getActiveTools: () => ["todo"],
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			sendMessage: () => {},
			registerSoftToolRequirementProvider: () => {},
			pi: { ...schedule, ...todos },
		};
		await todoDispatch(api, { reviewPageOpener: value => opened.push(value) });
		const ctx = {
			cwd: process.cwd(),
			getTodoPhases: () => current,
			updateTodoSchedule: (task, patch) => {
				const target = current.flatMap(phase => phase.tasks).find(row => row.content === task);
				if (!target) return false;
				Object.assign(target.schedule, patch);
				return true;
			},
			sessionManager: {
				getHeader: () => ({ id: "review-test" }),
				getBranch: () => [],
				getBranchMatching: () => [],
				getLatestBranchMatching: predicate => entries.findLast(predicate),
			},
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
			getTaskMaxConcurrency: () => 20,
			getLastAssistantText: () => "",
			isIdle: () => false,
			hasPendingMessages: () => false,
			setTimeout: () => ({}),
			clearTimer: () => {},
			setInterval: () => ({}),
			clearInterval: () => {},
		};
		const event = {
			toolName: "todo",
			input: { op: "schedule", updates: [{ task: row.content, review: "user", reviewPage: url }] },
		};
		const missing = { toolName: "todo", input: { op: "schedule", updates: [{ task: row.content, review: "user" }] } };
		expect((await handlers.get("tool_call")(missing, ctx)).block).toBe(true);
		expect(current[0].tasks[0].schedule.reviewPagePending).toBe(true);
		expect((await handlers.get("tool_call")({ toolName: "wait", input: {} }, ctx)).reason).toContain(
			"Handoff pending",
		);
		expect(formatTaskForecastDisplay(forecastTodoPlan(current, { now }).rows[0], now)).toContain("handoff pending");
		expect((await handlers.get("tool_call")(event, ctx)).reason).toContain("422");
		expect(
			(
				await handlers.get("tool_call")(
					{
						toolName: "todo",
						input: {
							op: "init",
							phases: [
								{
									name: "Review",
									tasks: [{ content: row.content, status: "completed", schedule: { review: "user" } }],
								},
							],
						},
					},
					ctx,
				)
			).reason,
		).toContain("missing review page");
		expect(await probeReviewPage("http://localhost:8800/review/dc/", row.content)).toBe(400);
		landed = `Commit abc — row: ${row.content}`;
		expect(await probeReviewPage(url, row.content)).toBe(200);
		current = [
			{
				name: "Review",
				tasks: [
					{
						...row,
						status: "in_progress",
						schedule: { ...row.schedule, reviewPage: url, reviewPagePending: true },
					},
				],
			},
		];
		expect((await handlers.get("tool_call")(event, ctx))?.block).not.toBe(true);
		expect((await handlers.get("tool_call")(event, ctx))?.block).not.toBe(true);
		expect(opened).toEqual([url]);
		await todoDispatch(api, { reviewPageOpener: value => opened.push(value) });
		expect((await handlers.get("tool_call")(event, ctx))?.block).not.toBe(true);
		expect(opened).toEqual([url]);
		expect(current[0].tasks[0].schedule.reviewPagePending).toBeUndefined();
		expect(await idleUserReviewRefusal(current, { running: [], recent: [] }, new Set())).toBeUndefined();
	} finally {
		fetch.mockRestore();
	}
});
