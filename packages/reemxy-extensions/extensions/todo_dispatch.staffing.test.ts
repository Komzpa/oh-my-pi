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

const estimate = { optimisticSeconds: 600, likelySeconds: 1200, pessimisticSeconds: 2400, confidence: "medium", basis: "Measured fixture", updatedAt: Date.now() };
const failed = {
	content: "Repair power source frame",
	status: "in_progress",
	schedule: {
		owner: "ContinentalSnail",
		progress: { evidence: "Previous frame attempt failed; repair remains open" },
		dependencies: [],
		estimate,
		executor: { workerId: "ContinentalSnail", startedAt: 1, finishedAt: 2, outcome: "failed" },
	},
};
const fresh = { content: "New orbit decoration", status: "pending", schedule: { dependencies: [], estimate } };
test("a settled executor running elsewhere does not own a reassigned row", async () => {
	const row = structuredClone(failed);
	row.schedule.owner = "Replacement";
	const h = await harness([row]);
	h.ctx.getAsyncJobSnapshot = () => ({ running: [{ id: "other-job", agentId: "ContinentalSnail", label: "Unrelated work", type: "task", status: "running" }], recent: [], nonJobAgents: [] });
	await h.hooks.get("turn_start")({}, h.ctx);
	expect(h.notices.find(notice => notice.customType === "todo-gate-staffing")?.content).toContain(row.content);
	const result = await h.hooks.get("tool_call")({ toolName: "task", input: { name: "Replacement", row: row.content, task: row.content, agent: "task" } }, h.ctx);
	expect(result?.reason ?? "").not.toContain("already has live owner");
	// A genuinely current replacement remains protected from duplicate dispatch.
	h.ctx.getAsyncJobSnapshot = () => ({ running: [{ id: "replacement-job", agentId: "Replacement", label: row.content, type: "task", status: "running" }], recent: [], nonJobAgents: [] });
	const duplicate = await h.hooks.get("tool_call")({ toolName: "task", input: { name: "Another", row: row.content, task: row.content, agent: "task" } }, h.ctx);
	expect(duplicate?.block).toBe(true);
	expect(duplicate.reason).toContain("Replacement");
});
test("staffing remains visible without blocking independent ready work", async () => {
	const h = await harness([structuredClone(failed), structuredClone(fresh)]);
	await h.hooks.get("turn_start")({}, h.ctx);
	const staffing = h.notices.filter(notice => notice.customType === "todo-gate-staffing");
	expect(staffing).toHaveLength(1);
	expect(staffing[0].content).toContain("ContinentalSnail");
	h.notices.length = 0;
	await h.hooks.get("turn_start")({}, h.ctx);
	expect(h.notices.filter(notice => notice.customType === "todo-gate-staffing")).toHaveLength(1);
	const invoke = input => h.hooks.get("tool_call")({ toolName: "task", input }, h.ctx);
	const denied = await invoke({ name: "NewOrbit", task: fresh.content, agent: "task" });
	expect(denied?.block).not.toBe(true);
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

test("ready tasks may dispatch even when another previously attempted row needs a worker", async () => {
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
	expect(partial?.block).not.toBe(true);
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

// The duplicate-spawn guard and the chief-work gate must consume the same live identity.
for (const source of ["registry", "registry-executor", "job-executor"]) test(`live staffing invalidates a warm decision (${source})`, async () => {
 const replacement = source !== "registry";
 const now = Date.now();
 const estimate = { optimisticSeconds: 60, likelySeconds: 90, pessimisticSeconds: 120, confidence: "medium", basis: "live ownership regression", updatedAt: now };
 const owner = replacement ? "Worker-old" : "Worker-new";
 const row = { content: "Current work", status: "in_progress", schedule: { owner, dependencies: [], resources: [], estimate, executor: { workerId: "Worker-new", startedAt: now } } };
 const h = await harness([row, ...[1, 2, 3].map(i => ({ content: `Dependent ${i}`, status: "pending", schedule: { dependencies: [row.content], resources: [], estimate } }))]);
 let live = false;
 h.ctx.getAsyncJobSnapshot = () => ({
  running: source === "job-executor" && live ? [{ id: "job-new", agentId: "Worker-new", type: "task", status: "running", label: row.content, startTime: now }] : [],
  recent: [], nonJobAgents: source === "job-executor" ? [] : [{ id: "Worker-new", live }],
 });
 const edit = () => h.hooks.get("tool_call")({ toolName: "edit", input: { path: "prompt.md", oldText: "zip", newText: "inline images" } }, h.ctx);
 try {
  expect((await edit())?.block).toBe(true);
  live = true;
  // Registry-backed activity can change without a task-job or TODO mutation.
  expect((await edit())?.block).not.toBe(true);
  const duplicate = await h.hooks.get("tool_call")({ toolName: "task", input: { name: "Replacement", row: row.content, task: row.content, agent: "task" } }, h.ctx);
  expect(duplicate?.block).toBe(true);
  expect(duplicate.reason).toContain("Worker-new");
  // An idle registration must not sustain ownership; the original gate returns.
  live = false;
  expect((await edit())?.block).toBe(true);
 } finally { h.hooks.get("session_shutdown")?.({}, h.ctx); }
});
