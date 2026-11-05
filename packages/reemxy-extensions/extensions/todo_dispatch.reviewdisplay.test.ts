// @ts-nocheck -- replay frozen production rows through runtime hooks and the shared forecast.
import { expect, test, spyOn } from "bun:test";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import * as todos from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { idleUserReviewRefusal } from "./todo_dispatch";
import { openReviewPages, probeReviewPage } from "./todo_review_opener";
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
	const forecast = forecastTodoPlan(phases, { now });
	expect(isClosedTodo(delivered)).toBe(true);
	expect(forecast.rows[0].status).toBe("completed");
	expect(forecast.rows[0].overdue).toBe(false);
	expect(formatTaskForecastDisplay(forecast.rows[0], now)).toContain(`awaiting your review → ${url}`);
	expect(formatPlanForecastDisplay(forecast, now)).toStartWith("1 awaiting your review");
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
			: new Response("page"),
	);
	try {
		const handlers = new Map();
		await todoDispatch({
			on: (name, fn) => handlers.set(name, fn),
			getActiveTools: () => ["todo", "task"],
			registerSoftToolRequirementProvider: () => {},
			pi: { ...schedule, ...todos },
		});
		const ctx = { getTodoPhases: () => live, sessionManager: { getHeader: () => ({ id: "review-test" }) } };
		const event = {
			toolName: "todo",
			input: { op: "schedule", updates: [{ task: row.content, review: "user", reviewPage: url }] },
		};
		expect((await handlers.get("tool_call")(event, ctx)).reason).toContain("422");
		expect(await probeReviewPage("http://localhost:8800/review/dc/", row.content)).toBe(400);
		landed = `Commit abc — row: ${row.content}`;
		expect(await probeReviewPage(url, row.content)).toBe(200);
		// Non-main hooks continue beyond admission; a rejected page above stopped at the admission boundary.
		const opened = [];
		const seen = new Set();
		const phases = [{ name: "Review", tasks: [{ ...row, schedule: { ...row.schedule, reviewPage: url } }] }];
		await openReviewPages(phases, seen, probeReviewPage, value => opened.push(value));
		await openReviewPages(phases, seen, probeReviewPage, value => opened.push(value));
		expect(opened).toEqual([url]);
		expect(await idleUserReviewRefusal(phases, { running: [], recent: [] }, new Set())).toBeUndefined();
	} finally {
		fetch.mockRestore();
	}
});
