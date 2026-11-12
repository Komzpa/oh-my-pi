// @ts-nocheck -- exercises registered hooks with disposable plan state.
import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch from "./todo_dispatch";
import * as reviewPages from "./todo_review_opener";
import { STATE_ENTRY } from "./deadlines";

const roots = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function harness({ worker = false, lane = false, autoOpen, preview = false, thresholdMinutes = 15 } = {}) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-red-row-hooks-"));
	roots.push(cwd);
	const asked = Date.now() - 30 * 60_000;
	const phases = [
		{
			name: "Delivery",
			tasks: ["Brag video inventory", "Finance manifest drift"].map((content, index) => ({
				content,
				status: "in_progress",
				schedule: {
					owner: `Worker${index}`,
					dependencies: [],
					resources: [],
					startedAt: asked,
					estimateRevision: 1,
					firstRequirementAt: asked,
					estimate: {
						optimisticSeconds: 30,
						likelySeconds: 60,
						pessimisticSeconds: 90,
						confidence: "medium",
						basis: "Live overdue rows",
						updatedAt: asked,
					},
				},
			})),
		},
	];
	// A real goal without a due time keeps this fixture outside automatic plan deadlines.
	const journal = [{ type: "mode_change", mode: "goal", data: {
		goal: { id: "red-row-goal", status: "active", createdAt: Date.now() },
	} }];
	const hooks = new Map();
	const opened = [];
	let jobs = [];
	const api = {
		on: (name, hook) => hooks.set(name, hook),
		getActiveTools: () => ["todo", "task", "read", "wait"],
		appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
		sendMessage: () => {},
		pi: { ...schedule, getLatestTodoPhasesFromEntries, agentPauseGate: { paused: false } },
		registerSoftToolRequirementProvider: () => {},
	};
	const previousLane = process.env.OMP_LANE_UNIT;
	try {
		if (lane) process.env.OMP_LANE_UNIT = "omp-red-row-test";
		await todoDispatch(api, { reviewPageProbe: async () => 200, reviewPageOpener: url => opened.push(url) });
	} finally {
		if (previousLane === undefined) delete process.env.OMP_LANE_UNIT;
		else process.env.OMP_LANE_UNIT = previousLane;
	}
	const ctx = {
		cwd,
		getTodoPreviewConfig: () => ({
			enabled: preview,
			paths: [],
			thresholdMinutes,
			...(autoOpen === undefined ? {} : { openReviewPages: autoOpen }),
		}),
		sessionManager: {
			getHeader: () => ({ id: `red-hooks-${path.basename(cwd)}`, ...(worker ? { parentSession: "lead" } : {}) }),
			getBranch: () => journal,
			getBranchMatching: predicate => journal.filter(predicate),
			getLatestBranchMatching: predicate => journal.findLast(predicate),
			getSessionFile: () => undefined,
		},
		getTodoPhases: () => structuredClone(phases),
		updateTodoSchedule: (content, patch) => {
			const row = phases[0].tasks.find(row => row.content === content);
			if (!row) return false;
			row.schedule = { ...row.schedule, ...patch };
			return true;
		},
		getAsyncJobSnapshot: () => ({ running: jobs, recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 20,
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}),
		setInterval: () => ({}),
		clearInterval: () => {},
		clearTimer: () => {},
	};
	return {
		phases,
		hooks,
		ctx,
		opened,
		setJobs: next => {
			jobs = next;
		},
	};
}

for (const boundary of ["wait", "session_stop"]) {
	test(`${boundary}: unrelated background work cannot hide overdue Brag and Finance; live owners alone cannot clear refusal`, async () => {
		const h = await harness();
		h.setJobs([{ id: "bg_6", label: "unrelated background job", type: "bash", status: "running" }]);
		const run = () =>
			boundary === "wait"
				? h.hooks.get("tool_call")({ toolName: "wait", input: {} }, h.ctx)
				: h.hooks.get("session_stop")({}, h.ctx);
		const refused = await run();
		// No active deadline: unstaffed overdue rows are refused as red rows, not as a deadline miss.
		expect(refused?.reason).toContain("ready work lacks a distinct running worker");
		expect(refused.reason).not.toContain("expected deadline miss");
		for (const row of h.phases[0].tasks) expect(refused.reason).toContain(row.content);
		h.setJobs(
			h.phases[0].tasks.map(row => ({
				id: row.schedule.owner,
				label: row.schedule.owner,
				agentId: row.schedule.owner,
				type: "task",
				status: "running",
			})),
		);
		// Without an active user deadline, waiting on the rows' own live workers is correct.
		expect((await run())?.reason ?? "").not.toContain("WAIT/STOP REFUSED");
		// With an active user deadline and no recent re-plan, live owners alone do not clear it.
		const at = Math.floor(Date.now() / 1_000);
		h.ctx.sessionManager.getBranch().push({ type: "custom", customType: STATE_ENTRY, data: { version: 1, goalId: "user", goalStartedAt: at - 7_200, timezone: "UTC", active: true, stages: [], baselineDeadlineAt: at + 600, userConstraint: { messageId: "m", quote: "by 22:00", recordedAt: at - 7_200 } } });
		expect((await run())?.reason).toContain(boundary === "wait" ? "WAIT/STOP REFUSED" : "STOP REFUSED");
		for (const row of h.phases[0].tasks) row.schedule.postDeadline = true;
		expect((await run())?.reason ?? "").not.toContain("WAIT/STOP REFUSED");
	});
}

test("wait preview gap is refused once per revision even with live owners", async () => {
	const h = await harness({ preview: true, thresholdMinutes: 30 });
	for (const row of h.phases[0].tasks) {
  row.schedule.firstRequirementAt = Date.now() - 16 * 60_000;
  row.schedule.startedAt = Date.now();
  row.schedule.estimate.updatedAt = Date.now();
 }
	h.setJobs(
		h.phases[0].tasks.map(row => ({
			id: row.schedule.owner,
			label: row.schedule.owner,
			agentId: row.schedule.owner,
			type: "task",
			status: "running",
		})),
	);
	const run = () => h.hooks.get("tool_call")({ toolName: "wait", input: {} }, h.ctx);
	expect((await run())?.reason).toContain("preview is overdue");
	expect((await run())?.reason ?? "").not.toContain("preview is overdue");
	h.phases[0].tasks[0].schedule.estimateRevision++;
	expect((await run())?.reason).toContain("Brag video inventory");
});

test("lead default opens a 200 review URL once and opens its replacement", async () => {
	const h = await harness();
	vi.spyOn(reviewPages, "pendingReviewVersion").mockResolvedValue("unanswered-card-version");
	const row = h.phases[0].tasks[0];
	row.schedule.review = "user";
	row.schedule.reviewPage = "https://review.example/first";
	const poll = () => h.hooks.get("tool_call")({ toolName: "read", input: {} }, h.ctx);
	await poll();
	await poll();
	expect(h.opened).toEqual(["https://review.example/first"]);
	row.schedule.reviewPage = "https://review.example/second";
	// Staffing controls remain available after two zero-active reads.
	await h.hooks.get("tool_call")({ toolName: "todo", input: { op: "schedule", updates: [] } }, h.ctx);
	expect(h.opened).toEqual(["https://review.example/first", "https://review.example/second"]);
});

for (const mode of [{ worker: true }, { lane: true }, { autoOpen: false }]) {
	test(`review opener respects ${JSON.stringify(mode)}`, async () => {
		const h = await harness(mode);
		h.phases[0].tasks[0].schedule.reviewPage = "https://review.example/private";
		await h.hooks.get("tool_call")({ toolName: "read", input: {} }, h.ctx);
		expect(h.opened).toEqual([]);
	});
}

for (const boundary of ["wait", "session_stop"]) {
	test(`${boundary}: 11:04 versus 10:00 refuses; honest reforecast stays blocked, full-scope staffing and safe overlap fit the fixed deadline`, async () => {
		for (const remedy of ["reforecast", "crash", "overlap"]) {
			const h = await harness();
			const now = Date.now();
			const due = Math.floor((now + 13 * 60_000) / 1000) * 1000;
			const start = due - 13 * 60_000;
			const row = (content, minutes, owner, dependencies = []) => ({
				content,
				status: "pending",
				schedule: {
					owner,
					dependencies,
					resources: [],
					estimate: {
						optimisticSeconds: minutes * 60,
						likelySeconds: minutes * 60,
						pessimisticSeconds: minutes * 60,
						confidence: "high",
						basis: "Live 09:47 / 10:00 / 11:04 plan",
						updatedAt: start,
					},
				},
			});
			h.phases[0].tasks = [
				row("Fix Adaptive 60 MW callout leaders", 8, "worker"),
				row("PDU B callout", 69, "worker", []),
			];
			// The canonical user constraint, not a todo operation, owns the due time.
			h.ctx.sessionManager
				.getBranch()
				.push({
					type: "custom",
					customType: STATE_ENTRY,
					data: {
						version: 1,
						goalId: "dc",
						goalStartedAt: start / 1000,
						timezone: "Asia/Tbilisi",
						active: true,
						baselineDeadlineAt: due / 1000,
						stages: [],
						userConstraint: { messageId: "user-due", quote: "by 10:00", recordedAt: start / 1000 },
					},
				});
			const run = () =>
				boundary === "wait"
					? h.hooks.get("tool_call")({ toolName: "wait", input: {} }, h.ctx)
					: h.hooks.get("session_stop")({}, h.ctx);
			const firstRefusal = await run();
			expect(firstRefusal?.reason).toContain("64m");
			expect(firstRefusal?.reason).toMatch(/reconcile the returned worker findings/i);
			expect(firstRefusal?.reason).toMatch(/do not.*cut requested scope or move the deadline/i);
			const repeated = await run();
			expect(repeated?.reason).toMatch(/WAIT\/STOP REFUSED.*reconcile the unfinished critical work/i);
			expect(repeated?.reason).toMatch(/new estimate alone does not finish it/i);
			if (remedy === "reforecast") {
				// Honest administration acknowledges the same required work; it is not delivery.
				h.phases[0].tasks[1].schedule.estimate.updatedAt = now;
				h.phases[0].tasks[1].schedule.estimate.basis = "Measured remaining 69 minutes; fixed due time cannot fit";
				const reforecastRefusal = await run();
				expect(boundary === "wait" ? reforecastRefusal?.block : reforecastRefusal?.decision === "block").toBe(true);
				expect(schedule.forecastTodoPlan(h.phases, { now, deadlineAt: due }).deadlineStatus).toBe("will-miss");
				expect(h.phases[0].tasks[1].schedule.estimate.likelySeconds).toBe(69 * 60);
			} else if (remedy === "crash") {
				// Nine independently staffed regions retain all 69 minutes of callout work.
				h.phases[0].tasks.splice(
					1,
					1,
					...Array.from({ length: 9 }, (_, i) => row(`PDU B region ${i}`, 69 / 9, `worker-${i}`)),
				);
			} else {
				// Evidence-based decomposition leaves two eight-minute dependent deliverables.
				h.phases[0].tasks[1].schedule.estimate = row("", 8, "").schedule.estimate;
				h.phases[0].tasks[1].schedule.owner = "second-worker";
				h.phases[0].tasks[1].schedule.dependencies = ["Fix Adaptive 60 MW callout leaders"];
				expect(schedule.forecastTodoPlan(h.phases, { now, deadlineAt: due }).deadlineStatus).toBe("will-miss");
				h.phases[0].tasks[1].schedule.dependencies = [];
				h.phases[0].tasks[1].schedule.progress = {
					at: now,
					evidence: "Independent callout inputs measured; overlap is safe",
				};
			}
			if (remedy !== "reforecast") {
				const repaired = await run();
				expect(repaired?.reason ?? "").not.toContain("WAIT/STOP REFUSED");
				expect(schedule.forecastTodoPlan(h.phases, { now, deadlineAt: due }).deadlineStatus).toBe("on-track");
			}
			expect(h.phases[0].tasks.every(task => task.status === "pending" && !task.schedule.postDeadline)).toBe(true);
			expect(
				h.ctx.sessionManager.getBranch().findLast(entry => entry.customType === STATE_ENTRY).data
					.baselineDeadlineAt,
			).toBe(due / 1000);
		}
	});
}

test("P95-only deadline risk permits wait", async () => {
 const h = await harness();
 const now = Date.now();
 h.phases[0].tasks.splice(1);
 const row = h.phases[0].tasks[0];
 row.schedule.startedAt = now;
 row.schedule.estimate = { optimisticSeconds: 60, likelySeconds: 600, pessimisticSeconds: 1800, confidence: "medium", basis: "Measured range", updatedAt: now };
 const due = Math.floor((now + 13 * 60_000) / 1000);
 h.ctx.sessionManager.getBranch().push({ type: "custom", customType: STATE_ENTRY, data: { version: 1, goalId: "dc", goalStartedAt: Math.floor(now / 1000), timezone: "UTC", active: true, baselineDeadlineAt: due, stages: [], userConstraint: { messageId: "user", quote: "fixed deadline", recordedAt: Math.floor(now / 1000) } } });
 expect(schedule.forecastTodoPlan(h.phases, { now, deadlineAt: due * 1000 }).deadlineStatus).toBe("at-risk");
 expect((await h.hooks.get("tool_call")({ toolName: "wait", input: {} }, h.ctx))?.reason ?? "").not.toContain("WAIT/STOP REFUSED");
});
