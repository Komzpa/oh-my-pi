// @ts-nocheck -- registered runtime hooks with a disposable plan.
import { expect, test } from "bun:test";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch from "./todo_dispatch";
async function harness(rows) {
	const phases = [{ name: "Follow-ups", tasks: rows }];
	const journal = [];
	const notices = [];
	const hooks = new Map();
	const api = {
		on: (name, hook) => hooks.set(name, hook),
		getActiveTools: () => ["todo", "task", "read", "wait"],
		appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
		sendMessage: (message, options) => notices.push({ ...message, delivery: options }),
		pi: {
			...schedule,
			getLatestTodoPhasesFromEntries,
			readGoalDeadline: () => undefined,
			agentPauseGate: { paused: false },
		},
		registerSoftToolRequirementProvider: () => {},
	};
	await todoDispatch(api, { reviewPageProbe: async () => 200, reviewPageOpener: () => {} });
	const ctx = {
		cwd: process.cwd(),
		getTodoPreviewConfig: () => ({ enabled: false, paths: [], thresholdMinutes: 15 }),
		sessionManager: {
			getHeader: () => ({ id: "lead-action" }),
			getBranch: () => journal,
			getBranchMatching: predicate => journal.filter(predicate),
			getLatestBranchMatching: predicate => journal.findLast(predicate),
			getSessionFile: () => undefined,
		},
		getTodoPhases: () => structuredClone(phases),
		updateTodoSchedule: () => true,
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 20,
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}),
		setInterval: () => ({}),
		clearInterval: () => {},
		clearTimer: () => {},
	};
	return { hooks, ctx, notices, phases };
}

const failed = {
	content: "Repair power source frame",
	status: "in_progress",
	schedule: {
		owner: "ContinentalSnail",
		progress: { evidence: "Previous frame attempt failed; repair remains open" },
		dependencies: [],
		executor: { workerId: "ContinentalSnail", startedAt: 1, finishedAt: 2, outcome: "failed" },
	},
};
const fresh = { content: "New orbit decoration", status: "pending", schedule: { dependencies: [] } };
test("staffing is the first notice each turn and new rows cannot jump failed workers", async () => {
	const h = await harness([structuredClone(failed), structuredClone(fresh)]);
	await h.hooks.get("turn_start")({}, h.ctx);
	expect(h.notices[0].customType).toBe("todo-gate-staffing");
	expect(h.notices[0].content).toContain("ContinentalSnail");
	h.notices.length = 0;
	await h.hooks.get("turn_start")({}, h.ctx);
	expect(h.notices[0].customType).toBe("todo-gate-staffing");
	const invoke = input => h.hooks.get("tool_call")({ toolName: "task", input }, h.ctx);
	const denied = await invoke({ name: "NewOrbit", task: fresh.content, agent: "task" });
	expect(denied?.block).toBe(true);
	expect(denied.reason).toContain("ContinentalSnail");
	const allowed = await invoke({ name: "ContinentalSnail", row: failed.content, task: failed.content, agent: "task" });
	expect(allowed?.reason ?? "").not.toContain("Staff ");
	// Actual cap full: no free slot exists, so this priority gate is inactive.
	h.ctx.getTaskMaxConcurrency = () => 1;
	h.ctx.getAsyncJobSnapshot = () => ({
		running: [{ id: "Busy", label: "Other work", type: "task", status: "running" }],
		recent: [],
		nonJobAgents: [],
	});
	const full = await invoke({ name: "NewOrbit", task: fresh.content, agent: "task" });
	expect(full?.reason ?? "").not.toContain("Staff ");
});

test("a batch that staffs every priority row may also staff a new row; a partial batch names only the missing rows", async () => {
	const second = structuredClone(failed);
	second.content = "Repair cooling trunks";
	second.schedule.owner = "CoolingTrunks";
	second.schedule.executor = { workerId: "CoolingTrunks", startedAt: 1, finishedAt: 2, outcome: "failed" };
	const h = await harness([structuredClone(failed), second, structuredClone(fresh)]);
	await h.hooks.get("turn_start")({}, h.ctx);
	const invoke = input => h.hooks.get("tool_call")({ toolName: "task", input }, h.ctx);
	const full = await invoke({
		agent: "task",
		tasks: [
			{ name: "ContinentalSnail", row: failed.content, task: failed.content },
			{ name: "CoolingTrunks", row: second.content, task: second.content },
			{ name: "NewOrbit", row: fresh.content, task: fresh.content },
		],
	});
	expect(full?.reason ?? "").not.toContain("Staff ");
	const partial = await invoke({
		agent: "task",
		tasks: [
			{ name: "ContinentalSnail", row: failed.content, task: failed.content },
			{ name: "NewOrbit", row: fresh.content, task: fresh.content },
		],
	});
	expect(partial?.block).toBe(true);
	expect(partial.reason).toContain("Repair cooling trunks");
	expect(partial.reason).not.toContain(`Staff "Repair power source frame"`);
});

// IRC-restored children are live without AsyncJobManager task entries.
test("turn_start keeps three restored row owners working despite stale failed executor records", async () => {
	const rows = Array.from({ length: 3 }, (_, i) => ({
		content: `restored row ${i}`,
		status: "in_progress",
		schedule: {
			owner: `Restored-${i}`,
			dependencies: [],
			executor: { workerId: `Restored-${i}`, startedAt: 1, finishedAt: 2, outcome: "failed" },
		},
	}));
	const h = await harness(rows);
	h.ctx.getAsyncJobSnapshot = () => ({
		running: [],
		recent: [],
		nonJobAgents: rows.map(row => ({ id: row.schedule.owner, live: true })),
	});
	await h.hooks.get("turn_start")({}, h.ctx);
	expect(h.notices.filter(notice => notice.customType === "todo-gate-staffing")).toEqual([]);
});

test("task refuses a restored live row owner and admits replacement only after the owner stops", async () => {
	const row = structuredClone(failed);
	row.schedule.progress = { evidence: "Worker failed; power source frame remains open" };
	const h = await harness([row]);
	let live = true;
	h.ctx.getAsyncJobSnapshot = () => ({ running: [], recent: [], nonJobAgents: [{ id: failed.schedule.owner, live }] });
	const invoke = input => h.hooks.get("tool_call")({ toolName: "task", input }, h.ctx);
	for (const item of [
		{ name: "Replacement", row: failed.content, task: failed.content, agent: "task" },
		{ name: "Replacement", task: `Continue ${failed.content}`, agent: "task" },
		{ tasks: [{ name: "Replacement", row: failed.content, task: failed.content, agent: "task" }] },
	]) {
		const denied = await invoke(item);
		expect(denied?.block).toBe(true);
		expect(denied.reason).toContain(failed.schedule.owner);
		expect(denied.reason).toContain("Steer");
	}
	live = false;
	const allowed = await invoke({ name: "ContinentalSnail", row: failed.content, task: failed.content, agent: "task" });
	expect(allowed?.block).not.toBe(true);
});

// Startup can queue the warning before the restart controller revives children.
test("context withdraws a startup staffing warning after its owners are restored", async () => {
	const h = await harness([structuredClone(failed)]);
	await h.hooks.get("turn_start")({}, h.ctx);
	const stale = h.notices.find(notice => notice.customType === "todo-gate-staffing");
	expect(stale).toBeDefined();
	h.ctx.getAsyncJobSnapshot = () => ({
		running: [],
		recent: [],
		nonJobAgents: [{ id: failed.schedule.owner, live: true }],
	});
	const user = { role: "user", content: "continue", timestamp: 1 };
	const result = await h.hooks.get("context")({ messages: [user, { ...stale, role: "custom" }] }, h.ctx);
	expect(result.messages.filter(message => !message.runtimeSupervisor)).toEqual([user]);
	expect(result.messages.filter(message => message.runtimeSupervisor).map(message => message.content[0].text).join("\n")).not.toContain("Staff");
});

test("task also refuses a row owned by an ordinary running job", async () => {
	const h = await harness([structuredClone(failed)]);
	h.ctx.getAsyncJobSnapshot = () => ({
		running: [
			{
				id: "job",
				agentId: failed.schedule.owner,
				type: "task",
				status: "running",
				label: failed.content,
				startTime: Date.now(),
			},
		],
		recent: [],
	});
	const result = await h.hooks.get("tool_call")(
		{ toolName: "task", input: { name: "Replacement", row: failed.content, task: failed.content, agent: "task" } },
		h.ctx,
	);
	expect(result?.block).toBe(true);
	expect(result.reason).toContain(failed.schedule.owner);
});

// The runtime queue consumes supersedes; content digests must not become subject keys.
test("busy lead staffing bursts use one replacement key and changed staffing replaces that subject", async () => {
	const h = await harness([structuredClone(failed)]);
	for (let i = 0; i < 20; i++) await h.hooks.get("turn_start")({}, h.ctx);
	const notices = h.notices.filter(notice => notice.customType === "todo-gate-staffing");
	expect(notices).toHaveLength(20);
	const key = notices[0].delivery.supersedes;
	expect(typeof key).toBe("string");
	expect(notices.every(notice => notice.delivery.supersedes === key)).toBe(true);
	h.phases[0].tasks.push(structuredClone(fresh));
	await h.hooks.get("turn_start")({}, h.ctx);
	const changed = h.notices.findLast(notice => notice.customType === "todo-gate-staffing");
	expect(changed.content).toContain(fresh.content);
	expect(changed.content).not.toBe(notices[0].content);
	expect(changed.delivery.supersedes).toBe(key);
});
