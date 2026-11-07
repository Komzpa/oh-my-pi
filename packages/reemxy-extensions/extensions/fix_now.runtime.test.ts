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

const row = content => ({ content, status: "pending", schedule: { dependencies: [], estimateMinutes: 10 } });
test("chief repeats bounded FIX NOW after every result, then removes resolved rows and uses USER supervisor", async () => {
	const h = await harness([row("Cooling trunks"), row("Power source"), row("Render frame")]);
	for (const toolName of ["read", "task", "wait", "bash"]) {
		const result = await h.hooks.get("tool_result")(
			{
				toolName,
				toolCallId: toolName,
				input: {},
				content: [{ type: "text", text: "receipt" }],
				isError: toolName === "task",
			},
			h.ctx,
		);
		const tail = result.content.at(-1).text;
		expect(tail).toStartWith("FIX NOW:");
		expect(tail).toContain("Cooling trunks");
		expect(tail).toContain("Power source");
		expect(tail).not.toMatch(/authoriz|approv|permission/i);
	}
	h.phases[0].tasks[0].status = "completed";
	const messages = [{ role: "custom", customType: "requirements-gate-notice", content: "Advice above" }];
	const shaped = await h.hooks.get("context")({ messages }, h.ctx);
	expect(shaped.messages[0].content).toStartWith("Advice above");
	expect(shaped.messages[0].content).toContain("FIX NOW:");
	expect(shaped.messages[0].content).not.toContain("Cooling trunks");
	const supervisors = shaped.messages.filter(message => message.runtimeSupervisor);
	expect(supervisors).toHaveLength(1);
	expect(supervisors[0].role).toBe("user");
	expect(supervisors[0].content[0].text).toStartWith("Runtime supervisor (not Darafei): FIX NOW:");
	expect(supervisors[0].content[0].text).not.toMatch(/authoriz|approv|permission/i);
	const repeated = await h.hooks.get("context")({ messages: shaped.messages }, h.ctx);
	expect(repeated.messages.filter(message => message.runtimeSupervisor)).toHaveLength(1);
	for (const task of h.phases[0].tasks) task.status = "completed";
	const clean = await h.hooks.get("context")({ messages: repeated.messages }, h.ctx);
	expect(clean.messages.filter(message => message.runtimeSupervisor)).toHaveLength(0);
	expect(clean.messages[0].content).toBe("Advice above");
});

test("subagent never gets chief FIX NOW tails or supervisor", async () => {
	const h = await harness([row("Chief row")]);
	h.ctx.sessionManager.getHeader = () => ({ id: "child", parentSession: "lead" });
	const result = await h.hooks.get("tool_result")(
		{ toolName: "read", input: {}, content: [{ type: "text", text: "receipt" }] },
		h.ctx,
	);
	expect(result?.content?.at(-1)?.text ?? "").not.toContain("FIX NOW:");
	const shaped = await h.hooks.get("context")({ messages: [] }, h.ctx);
	expect(shaped.messages).toEqual([]);
});

test("clean chief with no open plan gets no block on either surface", async () => {
	const h = await harness([]);
	const messages = [{ role: "user", content: "hello" }];
	const shaped = await h.hooks.get("context")({ messages }, h.ctx);
	expect(shaped.messages).toBe(messages);
	const result = await h.hooks.get("tool_result")(
		{ toolName: "read", input: {}, content: [{ type: "text", text: "receipt" }] },
		h.ctx,
	);
	expect(result?.content?.at(-1)?.text ?? "").not.toContain("FIX NOW:");
});
