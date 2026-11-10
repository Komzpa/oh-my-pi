// @ts-nocheck -- replay registered extension hooks with frozen session state.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { readGoalDeadline } from "@oh-my-pi/pi-coding-agent/goals/deadlines";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { decideTodoDispatch } from "./todo_dispatch";
import * as deadlines from "./deadlines";
import { renderDeadlineReminder } from "./goal_deadlines";
import replay from "./fixtures/missed-demand-replay.json";

afterEach(() => {
	Date.now.mockRestore?.();
});

async function harness(entries = structuredClone(replay.entries), now = replay.now) {
	spyOn(Date, "now").mockReturnValue(now);
	const phases = getLatestTodoPhasesFromEntries(entries);
	const hooks = new Map();
	const sent = [];
	const jobs = { running: [], recent: [], nonJobAgents: [] };
	const ctx = {
		cwd: "/tmp/missed-demand-replay",
		sessionManager: {
			getHeader: () => ({ id: "dc-replay" }),
			getBranch: () => entries,
			getBranchMatching: p => entries.filter(p),
			getLatestBranchMatching: p => entries.findLast(p),
			getSessionFile: () => undefined,
		},
		getTodoSnapshot: () => phases,
		getTodoPhases: () => phases,
		getAsyncJobSnapshot: () => jobs,
		getTaskMaxConcurrency: () => 6,
		getTodoPreviewConfig: () => ({ enabled: false, openReviewPages: false }),
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
	await todoDispatch({
		on: (name, fn) => hooks.set(name, fn),
		getActiveTools: () => ["todo", "task"],
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: message => sent.push(message),
		pi: { ...schedule, readGoalDeadline, getLatestTodoPhasesFromEntries, agentPauseGate: { paused: false } },
	});
	const receipt = () => entries.findLast(e => e.customType === "todo-dispatch-action-demand")?.data;
	return { phases, hooks, ctx, jobs, entries, sent, receipt };
}

test("DC resume arms the already missed auto anchor and starts idle age before any turn or timer", async () => {
	const h = await harness();
	// This is the actual host/extension reader mismatch, without a stubbed deadline.
	expect(readGoalDeadline(h.entries, h.ctx.cwd)).toBeUndefined();
	expect(deadlines.readGoalDeadline(h.entries, h.ctx.cwd)?.deadlineAt).toBe(1794045428000);
	expect(
		renderDeadlineReminder(
			deadlines.rehydrateDeadlineState(h.entries),
			Math.floor(replay.now / 1000),
			undefined,
			h.phases,
		),
	).toContain("MISSED");
	await h.hooks.get("session_start")({}, h.ctx);
	expect(h.receipt()?.recovery.pending).toMatchObject({ kind: "deadline", deadline: 1794045428000, at: replay.now });
	expect(
		h.receipt().recovery.idleSince["Cooling pipes: consolidated realistic trunks, warm and cold both shown"],
	).toBe(replay.now);
	const key = h.receipt().recovery.pending.key;
	await h.hooks.get("turn_start")({}, h.ctx);
	const action = h.sent.findLast(e => e.customType === "todo-dispatch-action-required").content;
	expect(action).toContain("Reconcile the returned result for Collateral");
	expect(action).toContain("agent://LeadersOrbitOnly-2");
	expect(action).toMatch(/read the full worker output and named evidence/i);
	expect(action).toMatch(/preserve unmet acceptance/i);
	expect(action).toMatch(/retirement is not success/i);
	expect(action).not.toMatch(/split or cut scope|split\/cut\/abandon/i);
	expect(action).toContain("anchored deadline is MISSED or SLIPPED");
	await h.hooks.get("turn_end")({}, h.ctx);
	const resumed = await harness(h.entries, replay.now + 600001);
	await resumed.hooks.get("session_start")({}, resumed.ctx);
	expect(resumed.receipt().recovery.pending.key).toBe(key);
	expect(
		resumed.receipt().recovery.idleSince["Cooling pipes: consolidated realistic trunks, warm and cold both shown"],
	).toBe(replay.now);
});

test("DC idle observation clears when its row is staffed; spare slots alone cannot make a live row idle", async () => {
	const h = await harness();
	await h.hooks.get("session_start")({}, h.ctx);
	const cooling = h.phases.flatMap(p => p.tasks).find(r => r.content.startsWith("Cooling pipes:"));
	cooling.schedule.owner = "CoolingTrunksJourney-17";
	cooling.schedule.executor = { workerId: "CoolingTrunksJourney-17", startedAt: replay.now + 1 };
	h.jobs.running.push({
		id: "CoolingTrunksJourney-17",
		label: cooling.content,
		type: "task",
		status: "running",
		startTime: replay.now + 1,
	});
	await h.hooks.get("turn_start")({}, h.ctx);
	expect(h.receipt().recovery.idleSince[cooling.content]).toBeUndefined();
	const decision = decideTodoDispatch(
		{
			phases: h.phases,
			jobs: h.jobs,
			isMainSession: true,
			capacity: 6,
			startableCapacity: 6,
			taskEnabled: true,
			now: replay.now,
		},
		schedule,
	);
	expect(decision.dispatchableReady.some(r => r.content === cooling.content)).toBe(false);
});

test("DC load with no deadline still ages ready work and demands staffing after ten minutes beside CHURN", async () => {
	// A focused goal without a deadline keeps this case about idle recovery;
	// the calibrated auto forecast may now legitimately create a deadline otherwise.
	const entries = structuredClone(replay.entries).slice(1);
	entries.push({
		type: "custom",
		customType: "pi-goal-state",
		data: { goal: { id: "idle-goal", createdAt: replay.now, status: "active" } },
	});
	const h = await harness(entries);
	await h.hooks.get("session_start")({}, h.ctx);
	expect(h.receipt().recovery.pending).toBeUndefined();
	expect(
		h.receipt().recovery.idleSince["Cooling pipes: consolidated realistic trunks, warm and cold both shown"],
	).toBe(replay.now);
	const resumed = await harness(h.entries, replay.now + 600000);
	await resumed.hooks.get("session_start")({}, resumed.ctx);
	expect(resumed.receipt().recovery.pending.kind).toBe("idle");
	await resumed.hooks.get("turn_start")({}, resumed.ctx);
	expect(resumed.sent.findLast(e => e.customType === "todo-dispatch-action-required").content).toContain(
		"at least 10 minutes",
	);
});

test("DC scope recovery remains satisfied on reload within the answered slip step", async () => {
	const h = await harness();
	await h.hooks.get("session_start")({}, h.ctx);
	await h.hooks.get("turn_start")({}, h.ctx);
	h.phases.flatMap(p => p.tasks).find(r => r.content.startsWith("Cooling pipes:")).status = "abandoned";
	await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "update" }, content: [], isError: false }, h.ctx);
	const satisfied = h.receipt().recovery.satisfied;
	expect(satisfied).toMatch(/^deadline:1794045428000:/);
	expect(h.receipt().recovery.pending).toBeUndefined();
	// Persist the observed TODO state as the host would before reloading.
	h.entries.push({ type: "custom", customType: "user_todo_edit", data: { phases: h.phases } });
	const resumed = await harness(h.entries);
	await resumed.hooks.get("session_start")({}, resumed.ctx);
	expect(resumed.receipt().recovery.satisfied).toBe(satisfied);
	expect(resumed.receipt().recovery.pending).toBeUndefined();
});
