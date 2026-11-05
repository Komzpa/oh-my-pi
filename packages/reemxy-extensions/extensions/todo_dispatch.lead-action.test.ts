// @ts-nocheck -- exercises registered hooks with disposable plan state.
import { expect, test } from "bun:test";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { leadActionPending } from "./todo_dispatch";

const NOW = 1793896333299;
// Live DC rows 2026-11-05 21:45 +04, schedule fields copied from the session journal.
const liveRows = () => [
	{
		content: "Investigate lost asks: site yard to inputs, floor count",
		status: "blocked",
		blocker: "Audited PASS (AuditLostAsksTrace); done gate demands UI screenshot pair for a research answer (tool bug reported)",
		schedule: { owner: "AuditLostAsksTrace", dependencies: [], executor: { workerId: "TraceLostSiteYardFloorsAsks", agentProfile: "researcher", startedAt: 1793895759812, finishedAt: 1793895765054, outcome: "completed" } },
	},
	{
		content: "Substation: reference-based look, clickable with panel",
		status: "blocked",
		blocker: "Built e50412f07 unpushed; push paused pending Darafei's priority call after Max-feedback readout",
		schedule: { owner: "qa-auditor-8", dependencies: [], executor: { workerId: "qa-auditor-8", agentProfile: "qa-auditor", startedAt: 1793894782450, finishedAt: 1793894789739, outcome: "completed" } },
	},
	{
		content: "Archive 2026-11-05 sync transcript (Max, Aleksandra)",
		status: "blocked",
		blocker: "Delivered and audited pass; the todo done gate demands a screenshot pair for a markdown file (tool bug reported)",
		schedule: {
			owner: "AuditTranscript",
			dependencies: [],
			executor: { workerId: "AuditTranscriptFile", agentProfile: "qa-auditor", startedAt: 1793890619263, finishedAt: 1793890621212, outcome: "failed" },
			attemptHistory: [{ attemptId: "a1", workerName: "AuditTranscriptFile", resolvedModel: "m", effort: "medium", startedAt: 1793890000000, finishedAt: 1793890607587, durationMs: 607587, terminalStatus: "completed", deliverablePaths: ["AuditTranscriptFile.md"] }],
		},
	},
];

test("live self-blocked rows are the lead's own action; neighbours are not", () => {
	for (const row of liveRows()) expect(leadActionPending(row)).toBe(true);
	const [lost] = liveRows();
	// Neighbour: the same row while its owner is still running is a real wait.
	expect(leadActionPending(lost, new Set(["AuditLostAsksTrace"]))).toBe(false);
	// Neighbour: a row handed to the user for review waits on the user, not the lead.
	expect(leadActionPending({ ...lost, schedule: { ...lost.schedule, review: "user" } })).toBe(false);
	// Neighbour: a failed worker with no delivered attempt has nothing to push or close.
	expect(leadActionPending({ ...lost, schedule: { ...lost.schedule, executor: { ...lost.schedule.executor, outcome: "failed" } } })).toBe(false);
	// Neighbour: an external wait owner is someone else's action.
	expect(leadActionPending({ ...lost, schedule: { ...lost.schedule, owner: "unit:ci-run-812.service" } })).toBe(false);
});

async function harness(rows) {
	const phases = [{ name: "Follow-ups", tasks: rows }];
	const journal = [];
	const hooks = new Map();
	const api = {
		on: (name, hook) => hooks.set(name, hook),
		getActiveTools: () => ["todo", "task", "read", "wait"],
		appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
		sendMessage: () => {},
		pi: { ...schedule, getLatestTodoPhasesFromEntries, readGoalDeadline: () => undefined, agentPauseGate: { paused: false } },
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
	return { hooks, ctx };
}

test("block is refused on a delivered row and names the lead's own action", async () => {
	for (const row of liveRows()) {
		const pending = { ...structuredClone(row), status: "in_progress" };
		delete pending.blocker;
		const h = await harness([pending]);
		const refused = await h.hooks.get("tool_call")({ toolName: "todo", input: { op: "block", task: row.content, reason: row.blocker.slice(0, 160) } }, h.ctx);
		expect(refused?.block).toBe(true);
		expect(refused.reason).toContain("Refusing block");
		expect(refused.reason).toContain(JSON.stringify(row.content));
		expect(refused.reason).toContain('review:"user"');
		expect(refused.reason).toContain('op="done"');
	}
});

test("negative control: block on a row without a delivered result still passes", async () => {
	const row = { content: "Waiting on CI", status: "in_progress", schedule: { owner: "Coder", dependencies: [] } };
	const h = await harness([row]);
	const result = await h.hooks.get("tool_call")({ toolName: "todo", input: { op: "block", task: row.content, reason: "CI run 812 still queued on the runner" } }, h.ctx);
	expect(result?.reason ?? "").not.toContain("Refusing block");
});
