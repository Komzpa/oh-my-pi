import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { expect, test } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { forecastTodoPlan, formatTaskForecastDisplay } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { ReviewAnswerPoller, pendingReviewVersion } from "./todo_review_opener";
import saved from "./fixtures/review-answers/answers.json";
import manifest from "./fixtures/review-answers/cards.json";
import hashes from "./fixtures/review-answers/content-shas.json";
import snapshot from "./fixtures/review-answers/dc-phases.json";

const title = "Use grid: row opens explainer panel, small inline toggle";
const cardId = "pr111-use-grid-explainer-panel";

function harness(phases: TodoPhase[], taskTitle = title) {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("user_todo_edit", { phases });
	let current = structuredClone(phases);
	const tool = () =>
		new TodoTool({
			cwd: "/tmp",
			settings: Settings.isolated(),
			sessionManager: manager,
			getSessionFile: () => null,
			getTodoPhases: () => current,
			setTodoPhases: (next: TodoPhase[]) => {
				current = next;
			},
		} as unknown as ToolSession);
	return {
		manager,
		ctx: {
			getTodoPhases: () => current,
			applyReviewPageAnswer: (answer: Parameters<TodoTool["applyReviewPageAnswer"]>[0]) =>
				tool().applyReviewPageAnswer(answer),
		},
		row: () => current.flatMap(phase => phase.tasks).find(row => row.content === taskTitle)!,
		restart: () => {
			current = getLatestTodoPhasesFromEntries(manager.getBranch());
		},
	};
}

function server() {
	let answers: Record<string, unknown> = structuredClone(saved);
	let fail = false;
	let slow = false;
	let sha = hashes[cardId];
	let cards = structuredClone(manifest.cards);
	let requests = 0;
	const http = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests++;
			if (slow) await Bun.sleep(100);
			if (fail) return new Response("unavailable", { status: 503 });
			const path = new URL(request.url).pathname;
			if (path.endsWith("api/answers")) return Response.json(answers);
			if (path.endsWith("cards.json")) return Response.json({ cards });
			return new Response(
				Object.entries(hashes)
					.map(([id, hash]) => `<article data-id="${id}" data-sha="${id === cardId ? sha : hash}"></article>`)
					.join(""),
			);
		},
	});
	return {
		url: `http://127.0.0.1:${http.port}/review/pr111/`,
		setAnswer(answer: string, note = "") {
			answers = { ...saved, [cardId]: { answer, note, content_sha: hashes[cardId] } };
		},
		stale() {
			sha = "new-published-content";
		},
		fail() {
			fail = true;
		},
		slow() {
			slow = true;
		},
		ambiguous() {
			cards = [...cards, { ...cards[0], id: "another-card" }];
		},
		requests: () => requests,
		close: () => http.stop(true),
	};
}

function phases(url: string): TodoPhase[] {
	const data = structuredClone(snapshot.data.phases) as TodoPhase[];
	for (const row of data.flatMap(phase => phase.tasks)) if (row.schedule?.reviewPage) row.schedule.reviewPage = url;
	return data;
}

test("replay DC 18:56 and saved 07:49 owner acceptance: close once, clear HUD and survive restart", async () => {
	const stub = server();
	const h = harness(phases(stub.url));
	try {
		expect(h.row().schedule?.review).toBe("user");
		const poller = new ReviewAnswerPoller();
		await Promise.all([poller.poll(h.ctx), poller.poll(h.ctx)]);
		const requests = stub.requests();
		await poller.poll(h.ctx);
		expect(stub.requests()).toBe(requests);
		expect(h.row().status).toBe("completed");
		expect(h.row().schedule?.review).toBe("accepted");
		expect(h.row().schedule?.progress?.evidence).toContain(
			"owner accepted on review page at 2026-11-06T07:49:41.801Z",
		);
		expect(h.row().schedule?.handoffPending).toBe(false);
		const display = forecastTodoPlan([{ name: "Result", tasks: [h.row()] }], { now: Date.now() });
		expect(formatTaskForecastDisplay(display.rows[0], Date.now())).not.toContain("awaiting your review");
		expect(await pendingReviewVersion(stub.url, title)).toBeUndefined();
		const entries = h.manager.getBranch().length;
		h.restart();
		await new ReviewAnswerPoller().poll(h.ctx);
		expect(h.manager.getBranch().length).toBe(entries);
		expect(h.row().schedule?.reviewAnswers).toHaveLength(1);
		// A republished user-review marker must not reapply this revision's receipt.
		h.row().schedule!.review = "user";
		await new ReviewAnswerPoller().poll(h.ctx);
		expect(h.manager.getBranch().length).toBe(entries);
	} finally {
		stub.close();
		await h.manager.close();
	}
});

for (const answer of ["redo", "drop"] as const)
	test(`${answer} applies the owner's correction through the native review transition`, async () => {
		const stub = server();
		stub.setAnswer(answer, "The switch still clips at 720 px");
		const h = harness(phases(stub.url));
		try {
			await new ReviewAnswerPoller().poll(h.ctx);
			expect(h.row().status).toBe(answer === "redo" ? "pending" : "abandoned");
			expect(h.row().schedule?.review).toBe(answer);
			expect(h.row().schedule?.progress?.evidence).toContain("The switch still clips at 720 px");
			if (answer === "redo") {
				expect(h.row().schedule?.executor).toBeUndefined();
				expect(h.row().schedule?.reviewSummary).toBe("The switch still clips at 720 px");
			}
			h.restart();
			expect(h.row().schedule?.review).toBe(answer);
		} finally {
			stub.close();
			await h.manager.close();
		}
	});

for (const failure of ["stale", "fail", "slow", "ambiguous"] as const)
	test(`${failure} answer never changes the row`, async () => {
		const stub = server();
		stub[failure]();
		const h = harness(phases(stub.url));
		const before = structuredClone(h.row());
		const notices: string[] = [];
		try {
			await new ReviewAnswerPoller().poll(h.ctx, row => notices.push(row), true, failure === "slow" ? 20 : 3000);
			expect(h.row()).toEqual(before);
			if (failure === "stale") expect(notices).toContain(title);
		} finally {
			stub.close();
			await h.manager.close();
		}
	});

test("recorded card slug wins over a renamed row; blank redo leaves the decision open", async () => {
	const stub = server();
	stub.setAnswer("redo");
	const data = phases(stub.url);
	const row = data.flatMap(phase => phase.tasks).find(row => row.content === title)!;
	row.schedule!.reviewCard = cardId;
	row.content = "Renamed source details";
	const h = harness(data, row.content);
	try {
		await new ReviewAnswerPoller().poll(h.ctx);
		expect(h.row().schedule?.review).toBe("user");
		stub.setAnswer("accept");
		await new ReviewAnswerPoller().poll(h.ctx);
		expect(h.row().schedule?.review).toBe("accepted");
	} finally {
		stub.close();
		await h.manager.close();
	}
});
