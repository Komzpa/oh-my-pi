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
		sendMessage: message => notices.push(message),
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
