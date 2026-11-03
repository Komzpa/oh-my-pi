// @ts-nocheck -- runtime job fixtures exercise admission state.
import { expect, test } from "bun:test";
import { idleUserReviewRefusal } from "./todo_dispatch";

const idle = { running: [], recent: [] };
const plan = (schedule = {}, content = "Decision") => [
	{ name: "Work", tasks: [{ content, status: "blocked", schedule }] },
];

test("idle open work without a recorded decision refuses once, independent of wording", async () => {
	const seen = new Set<string>();
	const rows = plan({}, "Do / Leave / Other?");
	expect(await idleUserReviewRefusal(rows, idle, seen)).toContain("Record the decision as a todo row");
	expect(await idleUserReviewRefusal(rows, idle, seen)).toBeUndefined();
	expect(await idleUserReviewRefusal(plan({}, "Unremarkable title"), idle, seen)).toContain(
		"You are waiting on the user",
	);
	expect(
		await idleUserReviewRefusal(rows, { ...idle, running: [{ status: "running", type: "bash" }] }, new Set()),
	).toBeUndefined();
	expect(await idleUserReviewRefusal([], idle, new Set())).toBeUndefined();
	expect(await idleUserReviewRefusal(rows, undefined, new Set())).toBeUndefined();
});

test("every decision needs a live artifact and state changes permit a fresh refusal", async () => {
	const seen = new Set<string>();
	const rows = plan({ review: "user", reviewPage: "http://localhost/review/a" });
	let probes = 0;
	const down = async () => {
		probes++;
		return 503;
	};
	expect(await idleUserReviewRefusal(rows, idle, seen, down)).toContain("503");
	expect(await idleUserReviewRefusal(rows, idle, seen, down)).toBeUndefined();
	expect(probes).toBe(2); // Recheck now, even after the same refusal was already delivered.
	expect(await idleUserReviewRefusal(rows, idle, seen, async () => 404)).toContain("404");
	expect(await idleUserReviewRefusal(rows, idle, seen, async () => 200)).toBeUndefined();
	rows[0].tasks.push({ content: "Second", status: "blocked", schedule: { review: "user" } });
	expect(await idleUserReviewRefusal(rows, idle, seen, async () => 200)).toContain("Second");
});

test("owner decision uses todo ownership, and a prose URL cannot substitute for an artifact", async () => {
	expect(await idleUserReviewRefusal(plan({ owner: "user" }), idle, new Set())).toContain("missing review page");
	expect(
		await idleUserReviewRefusal(
			plan({ review: "user", reviewSummary: "http://localhost/review/a" }),
			idle,
			new Set(),
		),
	).toContain("missing review page");
	expect(
		await idleUserReviewRefusal(plan({ review: "user", reviewPage: "file:///review/a" }), idle, new Set()),
	).toContain("missing review page");
});

test("default HTTP probe admits 200 and refuses a page that has gone away", async () => {
	let status = 200;
	const server = Bun.serve({ port: 0, fetch: () => new Response("card", { status }) });
	try {
		const rows = plan({ review: "user", reviewPage: `${server.url}review/a` });
		expect(await idleUserReviewRefusal(rows, idle, new Set())).toBeUndefined();
		status = 404;
		expect(await idleUserReviewRefusal(rows, idle, new Set())).toContain("404");
	} finally {
		await server.stop(true);
	}
});
