import { expect, test } from "bun:test";
import { openReviewPages } from "./todo_review_opener";

test("opens a published review once per batch URL, retries a failed page, and admits changed URLs", async () => {
	const opened = new Set<string>();
	const calls: string[] = [];
	const row = { content: "Brag video inventory", status: "in_progress" as const, schedule: { reviewPage: "http://localhost:3141/review" } };
	const phases = [{ name: "Delivery", tasks: [row] }];
	let status = 503;
	const probe = async () => status;
	const open = (url: string) => { calls.push(url); };
	await openReviewPages(phases, opened, probe, open);
	expect(calls).toEqual([]);
	status = 200;
	await Promise.all([openReviewPages(phases, opened, probe, open), openReviewPages(phases, opened, probe, open)]);
	expect(calls).toEqual([row.schedule.reviewPage]);
	phases[0]!.tasks.push({ ...row, content: "Another delivered row" });
	await openReviewPages(phases, opened, probe, open);
	expect(calls).toHaveLength(1);
	row.schedule.reviewPage = "http://localhost:3141/review-v2";
	await openReviewPages(phases, opened, probe, open);
	expect(calls).toEqual(["http://localhost:3141/review", "http://localhost:3141/review-v2"]);
	row.schedule.reviewPage = "file:///private";
	await openReviewPages(phases, opened, probe, open);
	expect(calls).toHaveLength(2);
});
