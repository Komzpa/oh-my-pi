// @ts-nocheck -- exercises registered hooks with disposable plan state.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch from "./todo_dispatch";

const roots = [];
afterEach(async () => {
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
	const journal = [];
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
	test(`${boundary}: unrelated background work cannot hide overdue Brag and Finance; exact live owners clear refusal`, async () => {
		const h = await harness();
		h.setJobs([{ id: "bg_6", label: "unrelated background job", type: "bash", status: "running" }]);
		const run = () =>
			boundary === "wait"
				? h.hooks.get("tool_call")({ toolName: "wait", input: {} }, h.ctx)
				: h.hooks.get("session_stop")({}, h.ctx);
		const refused = await run();
		expect(refused?.reason).toContain("open rows need a live owner");
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
		expect((await run())?.reason ?? "").not.toContain("open rows need a live owner");
	});
}

test("wait preview gap is refused once per revision even with live owners", async () => {
	const h = await harness({ preview: true, thresholdMinutes: 30 });
	for (const row of h.phases[0].tasks) row.schedule.firstRequirementAt = Date.now() - 16 * 60_000;
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
	const row = h.phases[0].tasks[0];
	row.schedule.reviewPage = "https://review.example/first";
	const poll = () => h.hooks.get("tool_call")({ toolName: "read", input: {} }, h.ctx);
	await poll();
	await poll();
	expect(h.opened).toEqual(["https://review.example/first"]);
	row.schedule.reviewPage = "https://review.example/second";
	await poll();
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
