import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { expect, test } from "bun:test";
import {
	CRITIC_TIMEOUT_MS,
	parseDeliveryVerdict,
	queueDeliveryCritic,
	resetDeliveryCriticTimers,
	recordDeliveryVerdict,
	type DeliveryVerdict,
} from "./delivery_critic";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { forecastTodoPlan, formatTaskForecastDisplay } from "@oh-my-pi/pi-tui/tools/todo-schedule";

let serial = 0;
function harness(outcome: "completed" | "failed" = "completed", preview = false) {
	// DC screenshot row: completed rack sizing must be inspected without delaying the release worker.
	const row = {
		content: "Rack tiles fit panel height at 1568, no scrollbar",
		status: "completed" as const,
		schedule: {
			executor: {
				workerId: "RackInputHeight-2",
				startedAt: 1,
				finishedAt: 2,
				outcome,
				gitCommits: preview ? [] : [{ commit: "a".repeat(40), repoPath: "/project" }],
			},
			...(preview ? { reviewPage: "https://preview.example/rack" } : {}),
		} as TodoSchedule,
	};
	const deferred = Promise.withResolvers<{ details: { results: Array<{ output: string }> } }>();
	let calls = 0;
	let timeout: (() => void) | undefined;
	let delay = 0;
	const records: DeliveryVerdict[] = [];
	const sessionId = `critic-${++serial}`;
	const ctx = {
		cwd: "/project",
		sessionManager: { getHeader: () => ({ id: sessionId }) },
		getTodoPhases: () => [{ name: "Final handoff", tasks: [row] }],
		updateTodoSchedule: (_task: string, patch: Partial<TodoSchedule>) => {
			row.schedule = { ...row.schedule, ...patch };
			return true;
		},
		setTimeout: (fn: () => void, ms: number) => {
			timeout = fn;
			delay = ms;
			return 1;
		},
		clearTimer: () => {},
		runDeliveryCritic: (brief: string, _signal: unknown, subject: string) => {
			expect(subject).toBe(`Delivery ${row.content}`);
			calls++;
			expect(brief).toContain(row.content);
			expect(brief.startsWith("Read skill://stakeholder-shadow to END OF FILE and apply it")).toBe(true);
			return deferred.promise;
		},
	} as unknown as ExtensionContext;
	const record = async (_row: unknown, verdict: DeliveryVerdict) => {
		records.push(verdict);
	};
	const queue = (now = 10, previewPath?: string) => queueDeliveryCritic(ctx, row, "", record, now, previewPath);
	const finish = async (verdict: DeliveryVerdict) => {
		deferred.resolve({ details: { results: [{ output: JSON.stringify(verdict) }] } });
		await deferred.promise;
		await Bun.sleep(0);
	};
	return { row, ctx, queue, finish, records, calls: () => calls, timeout: () => timeout?.(), delay: () => delay };
}

test("completed commit queues once even with repeated completion and changed preview", async () => {
	const h = harness();
	h.queue();
	h.row.schedule.reviewPage = "https://preview.example/new";
	h.queue();
	expect(h.calls()).toBe(1);
	expect(h.row.schedule.review).toBeUndefined();
	expect(h.row.schedule.handoffPending).toBe(false);
	await h.finish({ verdict: "clean", findings: [] });
});
test("evidenced defect becomes redo with the critic evidence as the next brief addendum", async () => {
	const h = harness();
	h.queue();
	await h.finish({
		verdict: "defects",
		findings: [
			{
				kind: "collateral_defect",
				severity: "blocker",
				evidence: "Rack panel at 1568 clips the accepted scrollbar-free controls, image 33",
			},
		],
	});
	expect(h.row.schedule.review).toBe("redo");
	expect(h.row.schedule.handoffPending).toBe(false);
	expect(h.row.schedule.progress?.evidence).toContain("Rack panel at 1568");
	expect(h.records[0]?.verdict).toBe("defects");
});
test("preview-only delivery joins the batch after clean and displays the verdict", async () => {
	const h = harness("completed", true);
	h.row.schedule.decision = "owner";
	h.row.schedule.reviewPage = undefined;
	h.queue(10, "https://preview.example/rack");
	await h.finish({ verdict: "clean", findings: [] });
	expect(h.row.schedule.handoffPending).toBe(true);
	expect(h.row.schedule.review).toBe("user");
	const forecast = forecastTodoPlan([{ name: "Work", tasks: [h.row] }], { now: Date.now() }).rows[0]!;
	expect(formatTaskForecastDisplay(forecast, Date.now())).toContain("shadow: clean");
	expect(h.records).toHaveLength(1);
});
test("15-minute timeout releases owner decision while keeping the pending verdict", () => {
	const h = harness();
	h.row.schedule.decision = "owner";
	h.queue();
	expect(h.delay()).toBe(CRITIC_TIMEOUT_MS);
	h.timeout();
	expect(h.row.schedule.review).toBe("user");
	expect(h.row.schedule.handoffPending).toBe(true);
	expect(h.row.schedule.deliveryCritic?.verdict).toBe("pending");
});
test("failed attempt and completed report without commit or preview never spawn a critic", () => {
	const h = harness("failed");
	expect(h.queue()).toBe(false);
	expect(h.calls()).toBe(0);
	const report = harness();
	report.row.schedule.executor!.gitCommits = [];
	expect(report.queue()).toBe(false);
	expect(report.calls()).toBe(0);
});
test("thin input and unevidenced defects cannot send a row to redo; legacy findings default to later", () => {
	expect(parseDeliveryVerdict({ verdict: "defects", findings: [{ kind: "thin_input", evidence: "crop" }] })).toEqual({
		verdict: "clean",
		findings: [],
	});
	expect(
		parseDeliveryVerdict({ verdict: "defects", findings: [{ kind: "requirement_violation", evidence: "" }] }),
	).toBeUndefined();
	expect(
		parseDeliveryVerdict({ verdict: "clean", findings: [{ kind: "contradicts_decision", evidence: "source" }] })?.verdict,
	).toBe("clean");
});

test("delivery ledger appends kind and evidence in the tasks-loop prediction shape", async () => {
	const dir = TempDir.createSync("shadow-ledger-");
	try {
		const h = harness();
		await recordDeliveryVerdict(
			h.row,
			{
				verdict: "defects",
				findings: [
					{ kind: "contradicts_decision", evidence: "corpus decision 11-05 forbids removing accepted labels" },
				],
			},
			path.join(dir.path(), "predictions.jsonl"),
		);
		const entry = JSON.parse((await Bun.file(path.join(dir.path(), "predictions.jsonl")).text()).trim());
		expect(entry.kind).toBe("delivery");
		expect(entry.choice).toBe("redo");
		expect(entry.landed.row).toBe(h.row.content);
		expect(entry.findings[0].text).toContain("corpus decision 11-05");
	} finally {
		dir.removeSync();
	}
});

test("restored pending critic keeps its deadline and never starts a second task", () => {
	const h = harness();
	h.queue(10);
	h.row.schedule.decision = "owner";
	resetDeliveryCriticTimers(h.ctx);
	h.queue(10 + 60000);
	expect(h.calls()).toBe(1);
	expect(h.delay()).toBe(CRITIC_TIMEOUT_MS - 60000);
	h.timeout();
	expect(h.row.schedule.handoffPending).toBe(true);
});
test("late defect from a superseded attempt is recorded without reopening the new attempt", async () => {
	const h = harness();
	h.queue();
	h.row.schedule.executor!.startedAt = 3;
	await h.finish({
		verdict: "defects",
		findings: [{ kind: "requirement_violation", evidence: "old rack output violates width" }],
	});
	expect(h.records).toHaveLength(1);
	expect(h.row.schedule.review).toBeUndefined();
});

for (const review of ["accepted", "redo", "drop"] as const)
	test(`a saved owner ${review} decision survives a pending critic and its timeout`, async () => {
		const h = harness();
		h.queue();
		h.row.schedule.review = review;
		h.row.schedule.reviewAnswers = ["page/card/sha/answer"];
		h.row.schedule.handoffPending = false;
		h.timeout();
		await h.finish({ verdict: "clean", findings: [] });
		expect(h.row.schedule.review).toBe(review);
		expect(h.row.schedule.handoffPending).toBe(false);
		if (review !== "redo") expect(h.queue()).toBe(false);
	});

for (const answered of [false, true])
	test(`critic clean and timeout do not ask about ${answered ? "answered content" : "an owner-specified cosmetic fix"}`, async () => {
		const h = harness();
		if (answered) {
			h.row.schedule.decision = "owner";
			h.row.schedule.reviewAnswers = ["page/card/hash/accept"];
		}
		h.queue();
		h.timeout();
		expect(h.row.schedule.review).toBeUndefined();
		expect(h.row.schedule.handoffPending).toBe(false);
		await h.finish({ verdict: "clean", findings: [] });
		expect(h.row.schedule.review).toBeUndefined();
		expect(h.row.schedule.handoffPending).toBe(false);
	});
