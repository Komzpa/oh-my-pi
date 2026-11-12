// @ts-nocheck -- exercises registered hooks with disposable plan state.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch from "./todo_dispatch";
import { readGoalDeadline, STATE_ENTRY } from "./deadlines";

// Live DC 2026-11-05 21:45 +04: reemxy-goal-deadlines had active=false, yet these rows still
// rendered "after deadline" and were never dispatched.
const LIVE_ROWS = [
	"Plan-click: classify rerun keys, fix new ones",
	"Plan-click: golden, rebase on 21f168566, gates, push",
	"Adaptive Levels: N-level layout and admission",
	"Adaptive Levels: dry coolers on roof, routing",
	"Adaptive Levels: battery rooms and stairs per level",
	"Adaptive Levels: Level 1-4 and Roof inspection views",
];
const START = 1793877275;
const liveInactive = { version: 1, goalId: "auto-todo-plan", goalStartedAt: START, timezone: "Asia/Tbilisi", active: false, auto: true, autoPlanKey: "[]", stages: [] };

const roots = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function harness(deadlineState) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-post-deadline-"));
	roots.push(cwd);
	const now = Date.now();
	const phases = [
		{
			name: "Follow-ups",
			tasks: [...LIVE_ROWS, "Regular row"].map((content, index) => ({
				content,
				status: index === 0 ? "in_progress" : "pending",
				schedule: {
					owner: `Worker${index}`,
					dependencies: [],
					...(index < LIVE_ROWS.length ? { postDeadline: true } : {}),
					estimate: { optimisticSeconds: 600, likelySeconds: 1200, pessimisticSeconds: 1800, confidence: "medium", basis: "live", updatedAt: now },
				},
			})),
		},
	];
	const journal = deadlineState ? [{ type: "custom", customType: STATE_ENTRY, data: deadlineState }] : [];
	const hooks = new Map();
	const messages = [];
	const api = {
		on: (name, hook) => hooks.set(name, hook),
		getActiveTools: () => ["todo", "task", "read", "wait"],
		appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
		sendMessage: message => messages.push(message),
		pi: { ...schedule, getLatestTodoPhasesFromEntries, readGoalDeadline, agentPauseGate: { paused: false } },
		registerSoftToolRequirementProvider: () => {},
	};
	await todoDispatch(api, { reviewPageProbe: async () => 200, reviewPageOpener: () => {} });
	const ctx = {
		cwd,
		getTodoPreviewConfig: () => ({ enabled: false, paths: [], thresholdMinutes: 15 }),
		sessionManager: {
			getHeader: () => ({ id: `post-deadline-${path.basename(cwd)}` }),
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
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 20,
		getLastAssistantText: () => "",
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}),
		setInterval: () => ({}),
		clearInterval: () => {},
		clearTimer: () => {},
	};
	return { phases, hooks, ctx, messages };
}

const released = messages => messages.filter(message => message.customType === "todo-post-deadline-released");
const flagged = phases => phases[0].tasks.filter(row => row.schedule.postDeadline).map(row => row.content);

test("an inactive deadline returns every after-deadline row to the normal queue with one visible note", async () => {
	const h = await harness(liveInactive);
	expect(readGoalDeadline(h.ctx.sessionManager.getBranch(), h.ctx.cwd, { includePaused: true })).toBeUndefined();
	expect(flagged(h.phases)).toEqual(LIVE_ROWS);
	await h.hooks.get("turn_end")({}, h.ctx);
	expect(flagged(h.phases)).toEqual([]);
	const notes = released(h.messages);
	expect(notes).toHaveLength(1);
	expect(notes[0].display).toBe(true);
	for (const row of LIVE_ROWS) expect(notes[0].content).toContain(JSON.stringify(row));
	expect(notes[0].content).not.toContain("Regular row");
	// Back in the normal queue: the forecast schedules them instead of deferring them.
	const forecast = schedule.forecastTodoPlan(h.phases, { now: Date.now() });
	for (const row of LIVE_ROWS) expect(forecast.rows.some(entry => entry.content === row)).toBe(true);
	// One note, not one per turn.
	await h.hooks.get("turn_end")({}, h.ctx);
	expect(released(h.messages)).toHaveLength(1);
});

test("a removed deadline also clears the flags on session start", async () => {
	const h = await harness(undefined);
	await h.hooks.get("session_start")({}, h.ctx);
	expect(flagged(h.phases)).toEqual([]);
	expect(released(h.messages)).toHaveLength(1);
});

test("negative control: an active deadline keeps the after-deadline flags", async () => {
	const active = { ...liveInactive, active: true, baselineDeadlineAt: Math.floor(Date.now() / 1_000) + 3_600 };
	const h = await harness(active);
	expect(readGoalDeadline(h.ctx.sessionManager.getBranch(), h.ctx.cwd, { includePaused: true })).toBeDefined();
	await h.hooks.get("turn_end")({}, h.ctx);
	expect(flagged(h.phases)).toEqual(LIVE_ROWS);
	expect(released(h.messages)).toHaveLength(0);
});
