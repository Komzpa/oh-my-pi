import { expect, spyOn, test } from "bun:test";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { openReviewPages } from "./todo_review_opener";

test("pending card claims survive restart, serialize concurrent checks, and admit changed content", async () => {
	const url = "http://localhost:8767/review/";
	const row = {
		content: "Delivery",
		status: "in_progress" as const,
		schedule: { review: "user" as const, reviewPage: url },
	};
	const phases = [{ name: "Review", tasks: [row] }];
	const calls: string[] = [];
	const claims = new Set<string>();
	let sha = "v1";
	let renderedHash = false;
	let answers = {};
	const fetch = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | Request | URL) =>
				String(input).endsWith("cards.json")
					? Response.json({
							cards: [
								{
									id: "card",
									content_sha: renderedHash ? undefined : sha,
									disposition: { kind: "delivered-change" },
									landed: { row: row.content },
								},
							],
						})
					: String(input).endsWith("api/answers")
						? Response.json(answers)
						: new Response(`<article data-id="card" data-sha="${sha}"></article>`),
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	const run = (opened = new Set(claims), tasks: TodoScheduleInput = phases) =>
		openReviewPages(
			tasks,
			opened,
			async () => 200,
			url => {
				calls.push(url);
			},
			key => {
				claims.add(key);
			},
		);
	try {
		const opened = new Set<string>();
		await Promise.all([run(opened), run(opened)]);
		expect(calls).toEqual([url]);
		await run();
		expect(calls).toEqual([url]);
		sha = "v2";
		answers = { card: { answer: "accept", content_sha: "v1" } };
		await run();
		expect(calls).toEqual([url, url]);
		answers = { card: { answer: "accept", content_sha: "v2" } };
		claims.clear();
		await run();
		expect(calls).toEqual([url, url]);
		renderedHash = true;
		sha = "v3";
		await run();
		expect(calls).toEqual([url, url, url]);
		answers = { card: { answer: "accept", content_sha: "v3" } };
		claims.clear();
		await run();
		expect(calls).toEqual([url, url, url]);
		answers = {};
		await run(new Set(), [{ name: "Review", tasks: [{ ...row, status: "completed" }] }]);
		await run(new Set(), [{ name: "Review", tasks: [{ ...row, status: "abandoned" }] }]);
		for (const review of ["accepted", "redo", "drop"] as const)
			await run(new Set(), [{ name: "Review", tasks: [{ ...row, schedule: { ...row.schedule, review } }] }]);
		await run(new Set(), [
			{ name: "Review", tasks: [{ ...row, schedule: { ...row.schedule, handoffPending: false } }] },
		]);
		expect(calls).toEqual([url, url, url]);
	} finally {
		fetch.mockRestore();
	}
});

test("a batch waits for every delivered card of the row and ignores other rows' answers", async () => {
	const url = "http://localhost:8767/review/batch/";
	const phases: TodoScheduleInput = [
		{
			name: "Review",
			tasks: [{ content: "Delivery", status: "in_progress", schedule: { review: "user", reviewPage: url } }],
		},
	];
	const cards = ["first", "second"].map(id => ({
		id,
		content_sha: "v1",
		disposition: { kind: "delivered-change" },
		landed: "Commit abc — row: Delivery",
	}));
	const answers: Record<string, { answer: string; content_sha: string }> = {
		first: { answer: "accept", content_sha: "v1" },
		unrelated: { answer: "drop", content_sha: "v1" },
	};
	const calls: string[] = [];
	const fetch = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | Request | URL) =>
				Response.json(String(input).endsWith("cards.json") ? { cards } : answers),
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	try {
		await openReviewPages(
			phases,
			new Set(),
			async () => 503,
			url => {
				calls.push(url);
			},
		);
		expect(calls).toEqual([]);
		await openReviewPages(
			phases,
			new Set(),
			async () => 200,
			url => {
				calls.push(url);
			},
		);
		expect(calls).toEqual([url]);
		answers.second = { answer: "redo", content_sha: "v1" };
		await openReviewPages(
			phases,
			new Set(),
			async () => 200,
			url => {
				calls.push(url);
			},
		);
		expect(calls).toEqual([url]);
	} finally {
		fetch.mockRestore();
	}
});
