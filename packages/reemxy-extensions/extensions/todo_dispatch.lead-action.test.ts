// @ts-nocheck -- exercises registered hooks with disposable plan state.
import { expect, test, vi } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { convertToLlm } from "../../coding-agent/src/session/messages";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { leadActionPending } from "./todo_dispatch";
import { holdsWriteCustody } from "./dispatch_preflight";

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
	let provider;
	const activeTools = ["todo", "task", "read", "wait"];
	const api = {
		on: (name, hook) => hooks.set(name, hook),
		getActiveTools: () => activeTools,
		appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
		sendMessage: () => {},
		pi: { ...schedule, getLatestTodoPhasesFromEntries, readGoalDeadline: () => undefined, agentPauseGate: { paused: false } },
		registerSoftToolRequirementProvider: value => { provider = value; },
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
	return { hooks, ctx, journal, phases, activeTools, requirement: () => provider?.(ctx), demand: () => provider?.demand?.(ctx), pauseGate: api.pi.agentPauseGate };
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

 test("resource schedule result steers the existing worker once without stopping it", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	const messages = [];
	registry.register({ id: "Pipes", displayName: "Pipes", kind: "sub", session: { isStreaming: true, steer: async text => { messages.push(text); } } });
	try {
		const h = await harness([{ content: "Fix pipes", status: "in_progress", schedule: { owner: "Pipes", resources: ["/new-worktree"] } }]);
		await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule", updates: [{ task: "Fix pipes", resources: ["/new-worktree"] }] }, details: { op: "schedule" }, content: [] }, h.ctx);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('/new-worktree');
		expect(messages[0]).toContain('running worker immediately');
		expect(messages[0]).not.toMatch(/kill|redispatch/);
	} finally { spy.mockRestore(); }
});


test("scope changes preserve yielded ownership without waking the old worker", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	const messages = [];
	registry.register({ id: "OldGate", displayName: "OldGate", kind: "sub", status: "idle", session: { isStreaming: false, steer: async text => { messages.push(text); registry.setStatus("OldGate", "running"); } } });
	try {
		const row = { content: "Repair component", status: "in_progress", schedule: { owner: "OldGate", resources: ["/project/new.ts"], executor: { workerId: "OldGate", outcome: "completed", finishedAt: NOW } } };
		const h = await harness([row]);
		await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule", updates: [{ task: row.content, resources: row.schedule.resources }] }, details: { op: "schedule" }, content: [] }, h.ctx);
		expect(messages).toEqual([]);
		expect(registry.get("OldGate").status).toBe("idle");
		expect(holdsWriteCustody(row)).toBe(false);
		// A stale registry status alone cannot turn an administrative edit into a new turn.
		registry.setStatus("OldGate", "running");
		await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule", updates: [{ task: row.content, resources: [] }] }, details: { op: "schedule" }, content: [] }, h.ctx);
		expect(messages).toEqual([]);
		expect(holdsWriteCustody(row)).toBe(false);
	} finally { spy.mockRestore(); }
});

test("scope changes notify the current live continuation instead of the historical executor", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	const messages = [];
	for (const id of ["OldGate", "NewCoder"]) registry.register({ id, displayName: id, kind: "sub", session: { isStreaming: true, steer: async (text, _images, options) => { messages.push({ id, text, options }); } } });
	try {
		const row = { content: "Repair component", status: "in_progress", schedule: { owner: "NewCoder", resources: [], executor: { workerId: "OldGate", outcome: "completed", finishedAt: NOW } } };
		const h = await harness([row]);
		await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule", updates: [{ task: row.content, resources: [] }] }, details: { op: "schedule" }, content: [] }, h.ctx);
		expect(messages.map(message => message.id)).toEqual(["NewCoder"]);
	expect(messages[0].options).toEqual({ passive: true });
		expect(messages[0].text).toContain("[]");
		// IRC can legitimately resume the same owner after a historical terminal attempt.
		h.phases[0].tasks[0].schedule.owner = "OldGate";
		await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule", updates: [{ task: row.content, resources: [] }] }, details: { op: "schedule" }, content: [] }, h.ctx);
		expect(messages.map(message => message.id)).toEqual(["NewCoder", "OldGate"]);
		expect(holdsWriteCustody(h.phases[0].tasks[0])).toBe(true);
		// Finishing the row revokes even an otherwise live owner's grant.
		h.phases[0].tasks[0].status = "completed";
		await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule", updates: [{ task: row.content, resources: [] }] }, details: { op: "schedule" }, content: [] }, h.ctx);
		expect(messages.map(message => message.id)).toEqual(["NewCoder", "OldGate"]);
	} finally { spy.mockRestore(); }
});


test("context replaces consumed dispatcher snapshots and duplicate wake-only replies without losing work", async () => {
	const h = await harness([]);
	const wake = (text, extra = {}) => ({ role: "custom", customType: "todo-dispatch-action-required", content: text, display: false, attribution: "agent", timestamp: 1, ...extra });
	const reply = text => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 2 });
	const human = { role: "user", content: "Real request", timestamp: 0 };
	const firstReply = reply("Unchanged status");
	const lastReply = reply("Unchanged status");
	const changedReply = reply("New finding");
	const latestWake = wake("Current demand");
	const call = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }], timestamp: 3 };
	const result = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Useful result" }], isError: false, timestamp: 4 };
	const input = [human, wake("Old demand"), firstReply, wake("Newer demand"), lastReply, wake("Latest earlier demand"), changedReply, call, result, latestWake];
	const before = structuredClone(input);
	const shaped = await h.hooks.get("context")({ messages: input }, h.ctx);
	expect(shaped.messages).toEqual([human, lastReply, changedReply, call, result]);
	// Model projection must not rewrite the journal/transcript objects it received.
	expect(input).toEqual(before);
});

test("context keeps replies separated by real input, peer notices, visible notices and tool work", async () => {
	const h = await harness([]);
	const wake = () => ({ role: "custom", customType: "todo-dispatch-action-required", content: "Demand", display: false, attribution: "agent", timestamp: 1 });
	const reply = () => ({ role: "assistant", content: [{ type: "text", text: "Same text" }], stopReason: "stop", timestamp: 2 });
	const boundaries = [
		{ role: "user", content: "New human request", timestamp: 3 },
		{ role: "custom", customType: "irc:incoming", content: "Peer result", attribution: "agent", display: false, timestamp: 3 },
		{ role: "custom", customType: "todo-dispatch-action-required", content: "Visible notice", attribution: "agent", display: true, timestamp: 3 },
		{ role: "custom", customType: "todo-dispatch-action-required", content: "User notice", attribution: "user", display: false, timestamp: 3 },
		{ role: "custom", customType: "todo-dispatch-ignored", content: "User-authored feedback", attribution: "user", display: true, timestamp: 3 },
		{ role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "todo", arguments: { op: "view" } }], timestamp: 3 },
		{ role: "toolResult", toolCallId: "call-2", toolName: "todo", content: [{ type: "text", text: "Plan" }], timestamp: 3 },
	];
	for (const boundary of boundaries) {
		const earlier = reply();
		const later = reply();
		const latest = wake();
		const shaped = await h.hooks.get("context")({ messages: [wake(), earlier, boundary, latest, later] }, h.ctx);
		expect(shaped.messages).toEqual([earlier, boundary, later]);
	}
});

test("retired approach loses its stale demand while full worker feedback reaches the next model request", async () => {
	const retired = { content: "Prove old route", status: "abandoned", schedule: { owner: "OldProof", dependencies: [] } };
	const h = await harness([retired]);
	const oldWake = { role: "custom", customType: "todo-dispatch-action-required", content: "Dispatch OldProof again", display: false, attribution: "agent", timestamp: 1 };
	const finding = "Cooling proof reached inventory assertions; createCoolingCircuitRoutes failed: mergeGeometries undefined.index. Retain helper deltas and repair route geometry.";
	const feedback = { role: "custom", customType: "async-result", content: `<task-result id="OldProof">${finding}</task-result>`, display: true, attribution: "agent", timestamp: 2 };
	const oldIgnored = { ...oldWake, customType: "todo-dispatch-ignored", content: "Staff the already closed OldProof now", display: true };
	const input = [oldWake, oldIgnored, feedback];
	const shaped = await h.hooks.get("context")({ messages: input }, h.ctx);
	expect(shaped.messages).toEqual([feedback]);
	expect(shaped.messages[0]).toBe(feedback);
	const mock = createMockModel({ handler: { content: ["Use the concrete route finding"] } });
	const agent = new Agent({ initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: shaped.messages }, convertToLlm, streamFn: mock.stream });
	await agent.prompt("Continue using the worker findings");
	expect(JSON.stringify(mock.calls.at(-1).context.messages)).toContain(finding);
	expect(JSON.stringify(mock.calls.at(-1).context.messages)).not.toContain("Dispatch OldProof again");
	// Independent remaining work gets fresh advice, never the retired target.
	h.phases[0].tasks.push({ content: "Repair route geometry", status: "pending", schedule: { dependencies: [] } });
	const next = await h.hooks.get("context")({ messages: input }, h.ctx);
	expect(next.messages.find(message => message.customType === oldWake.customType)?.content).toContain("Repair route geometry");
	expect(next.messages).toContain(feedback);
	expect(input).toEqual([oldWake, oldIgnored, feedback]);
});


test("repeated no-action demand survives reads and releases after actual work", async () => {
	const rows = [
		{ content: "Check repair", status: "in_progress", schedule: { dependencies: [], reestimateCount: 6, estimateRevision: 7 } },
		{ content: "Publish repair", status: "pending", schedule: { dependencies: ["Check repair"] } },
		{ content: "Install repair", status: "pending", schedule: { dependencies: ["Publish repair"] } },
	];
	const h = await harness(rows);
	await h.hooks.get("turn_start")({}, h.ctx);
	// Non-mutating calls cannot clear the no-action streak.
	for (let index = 0; index < 3; index++) {
		await h.hooks.get("tool_call")({ toolName: "read", toolCallId: `read-${index}`, input: { path: "a.txt" } }, h.ctx);
		await h.hooks.get("turn_end")({}, h.ctx);
		await h.hooks.get("turn_start")({}, h.ctx);
		if (index < 2) expect(h.requirement()).toBeUndefined();
	}
	const requirement = h.requirement();
	expect(requirement?.escalationToolChoice).toBe("required");
	for (const name of ["read", "todo", "task", "bash"]) expect(requirement.satisfies({ name })).toBe(true);
	// A pause and an unavailable active tool never force a model request.
	h.pauseGate.paused = true;
	expect(h.requirement()).toBeUndefined();
	h.pauseGate.paused = false;
	h.activeTools.splice(h.activeTools.indexOf("task"), 1);
	expect(h.requirement()).toBeUndefined();
	h.activeTools.push("task");
	// Evaluating advisory demand first must not consume the human-input recovery boundary.
	await h.hooks.get("input")({ source: "interactive", text: "Use this updated request" }, h.ctx);
	h.demand();
	expect(h.requirement()).toBeUndefined();
	for (let index = 0; index < 3; index++) {
		await h.hooks.get("turn_end")({}, h.ctx);
		await h.hooks.get("turn_start")({}, h.ctx);
	}
	expect(h.requirement()?.escalationToolChoice).toBe("required");
	await h.hooks.get("tool_call")({ toolName: "read", toolCallId: "native-read", input: { path: "a.txt" } }, h.ctx);
	expect(h.requirement()?.escalationToolChoice).toBe("required");
	rows[1].schedule.dependencies = [];
	await h.hooks.get("tool_result")({ toolName: "todo", input: { op: "schedule" }, isError: false, content: [] }, h.ctx);
	expect(h.requirement()).toBeUndefined();
	await h.hooks.get("turn_end")({}, h.ctx);
	await h.hooks.get("turn_start")({}, h.ctx);
	expect(h.requirement()).toBeUndefined();
});
