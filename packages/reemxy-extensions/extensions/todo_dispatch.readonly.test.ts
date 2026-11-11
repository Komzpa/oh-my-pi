// @ts-nocheck -- exercise registered hooks with recorded task calls.
import { expect, test } from "bun:test";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import calls from "./fixtures/readonly-task-calls.json";
import todoDispatch from "./todo_dispatch";
function freeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freeze(child);
	return Object.freeze(value);
}
async function harness(rows) {
	const phases = [{ name: "Follow-ups", tasks: rows }];
	const patches = [];
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
		getTodoSnapshot: () => phases,
		getTodoPhases: () => {
			throw new Error("must use owner snapshot");
		},
		updateTodoSchedule: (task, patch) => {
			patches.push({ task, patch });
			return true;
		},
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 20,
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}),
		setInterval: () => ({}),
		clearInterval: () => {},
		clearTimer: () => {},
	};
	return { hooks, ctx, notices, phases, patches };
}

for (const {
	failedAt,
	call: [, input],
} of calls) {
	test(`recorded ${input.tasks.length}-task batch ${failedAt} preserves frozen review rows`, async () => {
		const h = await harness(
			input.tasks.map(item => ({
				content: item.row,
				status: "pending",
				schedule: {
					dependencies: [],
					review: "user",
					reviewPagePending: true,
					attemptHistory: [{ workerName: "Earlier", terminalStatus: "completed", finishedAt: 2, finalReportParagraph: "Previous delivery is ready for speculative review" }],
				},
			})),
		);
		freeze(h.phases);
		const before = structuredClone(h.phases);
		const args = freeze(structuredClone(input));
		const result = await h.hooks.get("tool_call")({ type: "tool_call", toolName: "task", input: args }, h.ctx);
		expect(h.patches).toEqual(input.tasks.map(item => ({ task: item.row, patch: { speculativeOn: item.row } })));
		expect(h.phases).toEqual(before);
		expect(Object.isFrozen(h.phases[0].tasks[0].schedule)).toBe(true);
		expect(args).toEqual(input);
		expect(result?.block).not.toBe(true);
		expect(result.input.tasks).toHaveLength(input.tasks.length);
		for (const item of result.input.tasks) {
			expect(item.task).toContain(`SPECULATIVE on ${item.row}:`);
			expect(item.task).toContain(item.row);
		}
	});
}

test("renamed rows inherit review metadata without writing either frozen row", async () => {
	const h = await harness([
		{
			content: "Old title",
			status: "abandoned",
			schedule: { resources: ["src/header.ts"], review: "redo", attemptHistory: [{ terminalStatus: "completed" }] },
		},
		{ content: "New title", status: "pending", schedule: { dependencies: [], resources: ["src/header.ts"] } },
	]);
	freeze(h.phases);
	const input = freeze({ agent: "task", row: "New title", task: "Repair header" });
	await h.hooks.get("tool_call")({ type: "tool_call", toolName: "task", input }, h.ctx);
	expect(h.patches[0]).toMatchObject({ task: "New title", patch: { review: "redo" } });
	expect(h.phases[0].tasks[1].schedule.review).toBeUndefined();
});

test("read-only audits leave frozen review metadata and task arguments untouched", async () => {
	const h = await harness([
		{ content: "Delivered", status: "pending", schedule: { review: "user", dependencies: [] } },
	]);
	freeze(h.phases);
	const input = freeze({
		agent: "reviewer",
		row: "Delivered",
		task: "Read-only audit of Delivered. Do not edit files.",
	});
	const result = await h.hooks.get("tool_call")({ type: "tool_call", toolName: "task", input }, h.ctx);
	expect(h.patches).toEqual([]);
	expect(result?.input).toBeUndefined();
});

test("registered dispatch refuses a retry without findings and attaches the previous same-row receipt", async () => {
	const row = { content: "PushFitCamera", status: "pending", schedule: {
		dependencies: [], estimate: { optimisticSeconds: 600, likelySeconds: 1200, pessimisticSeconds: 2400, confidence: "medium", basis: "Measured fixture", updatedAt: Date.now() },
		executor: { workerId: "PushFitCamera-10", finishedAt: 20, outcome: "failed" },
	} };
	const h = await harness([row]);
	const input = { agent: "task", row: row.content, task: "Fix and oracle are missing" };
	const dispatch = () => h.hooks.get("tool_call")({ type: "tool_call", toolName: "task", input }, h.ctx);
	expect((await dispatch()).reason).toContain("no previous attempt findings");
	row.schedule.attemptHistory = [{ attemptId: "10", workerName: "PushFitCamera-10", finishedAt: 20,
		terminalStatus: "failed", finalReportParagraph: "Fix and oracle already exist on cae9987d0; screenshot failed", rejectionReason: "camera clipped" }];
	row.blocker = "Which camera target?";
	const result = await dispatch();
	expect(result?.block).not.toBe(true);
	expect(result.input.task).toContain("cae9987d0");
	expect(result.input.task).toContain("camera clipped");
	expect(result.input.task).toContain("Which camera target?");
});
