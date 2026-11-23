// @ts-nocheck -- runtime job fixtures exercise admission state.
import { expect, test, spyOn } from "bun:test";
import { idleUserReviewRefusal } from "./todo_dispatch";

const idle = { running: [], recent: [] };
const plan = (schedule = {}, content = "Decision") => [
	{
		name: "Work",
		tasks: [{ content, status: "blocked", blocker: "awaiting the user decision", schedule }],
	},
];

test("blocked external work is not mistaken for a user decision", async () => {
	const rows = plan({ review: "user" }, "Do / Leave / Other?");
	rows[0].tasks[0].blocker = "CI queue is full";
	expect(await idleUserReviewRefusal(rows, idle, new Set())).toBeUndefined();
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
	expect(await idleUserReviewRefusal(rows, idle, seen, down)).toContain("503");
	expect(probes).toBe(2); // Recheck now, even after the same refusal was already delivered.
	expect(await idleUserReviewRefusal(rows, idle, seen, async () => 404)).toContain("404");
	expect(await idleUserReviewRefusal(rows, idle, seen, async () => 200)).toBeUndefined();
	rows[0].tasks.push({
		content: "Second",
		status: "blocked",
		blocker: "awaiting the user decision",
		schedule: { review: "user" },
	});
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

test("default probe requires a matching delivered card on the publisher port", async () => {
	let status = 200;
	const fetch = spyOn(globalThis, "fetch").mockImplementation(async input =>
		String(input).endsWith("cards.json") ? Response.json({ cards: [{ disposition: { kind: "delivered-change" }, landed: "Commit abc — row: Decision" }] }) : new Response("page", { status }));
	try {
		const rows = plan({ review: "user", reviewPage: "http://localhost:8767/review/a/" });
		expect(await idleUserReviewRefusal(rows, idle, new Set())).toBeUndefined();
		status = 404;
		expect(await idleUserReviewRefusal(rows, idle, new Set())).toContain("404");
	} finally { fetch.mockRestore(); }
});

test("live unfinished review rows do not demand decision pages before delivery", async () => {
	const rows = [
		{
			name: "Work",
			tasks: [
				{
					content: "Finance manifest drift: refresh and precommit green",
					status: "in_progress",
					schedule: { review: "user", owner: "PrecommitGreen" },
				},
				{
					content: "Brag video: inventory user-visible changes since 2026-10-29",
					status: "in_progress",
					schedule: { review: "user", owner: "BragRerender" },
				},
				{
					content: "Final full gate and push of the branch",
					status: "in_progress",
					schedule: { review: "user", owner: "Main" },
				},
				{
					content: "Adaptive layout: heat pipes reach heat plant",
					status: "pending",
					schedule: { review: "user" },
				},
			],
		},
	];
	expect(await idleUserReviewRefusal(rows, idle, new Set())).toBeUndefined();
});

test("delivered and visible review rows still require a page even after closure", async () => {
	for (const delivery of [
		{ status: "completed", schedule: {} },
		{ status: "in_progress", schedule: { firstDeliveredAt: 123 } },
		{ status: "in_progress", schedule: { visibleAt: 123 } },
		{ status: "in_progress", schedule: { reviewSummary: "Delivered result" } },
		{ status: "in_progress", schedule: { attemptHistory: [{ deliverablePaths: ["result.html"] }] } },
	]) {
		const rows = [
			{
				name: "Work",
				tasks: [{ content: "Delivered result", ...delivery, schedule: { ...delivery.schedule, review: "user" } }],
			},
		];
		expect(await idleUserReviewRefusal(rows, idle, new Set())).toContain("missing review page");
	}
});

test("an abandoned result no longer demands a user decision", async () => {
	const rows = plan({ review: "user", firstDeliveredAt: 123 });
	rows[0].tasks[0].status = "abandoned";
	expect(await idleUserReviewRefusal(rows, idle, new Set())).toBeUndefined();
});

test("running CI cannot postpone a missing handoff", async () => {
	expect(
		await idleUserReviewRefusal(
			plan({ review: "user" }),
			{ ...idle, running: [{ status: "running", type: "bash" }] },
			new Set(),
		),
	).toContain("Handoff pending");
});
