// @ts-nocheck -- registered runtime hooks with a disposable plan.
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch from "./todo_dispatch";
export async function harness(rows) {
	const phases = [{ name: "Follow-ups", tasks: rows }];
	const journal = [];
	const notices = [];
	const hooks = new Map();
	const api = {
		on: (name, hook) => hooks.set(name, hook),
		getActiveTools: () => ["todo", "task", "read", "wait", "ask"],
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
	return { hooks, ctx, notices, phases, journal };
}
