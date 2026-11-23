import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoSchedule, TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import planCritic, {
	actionObserved,
	chiefCriticFixes,
	compactBindingHistory,
	criticInterval,
	parsePlanVerdict,
	PLAN_CRITIC_ENTRY,
	type Binding,
	type CriticOwnerRunState,
	type PlanAction,
	type PlanVerdict,
} from "./plan_critic";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
const action: PlanAction = {
	id: "cut-wait",
	severity: "blocker",
	kind: "cut_dependency",
	row: "Collateral",
	dependency: "Labels",
	reason: "independent preview",
	next: "Cut the Labels wait",
};
const verdict: PlanVerdict = {
	converging: false,
	criticalPathBlocker: "Labels",
	falseDependencies: [{ row: action.row, dependency: "Labels", reason: action.reason }],
	split: [],
	cut: [],
	escalate: [],
	actions: [action],
};
const makePlan = (): TodoScheduleInput => [
	{
		name: "work",
		tasks: [
			{ content: "Labels", status: "in_progress" },
			{ content: "Collateral", status: "pending", schedule: { dependencies: ["Labels"] } },
		],
	},
];
function harness(saved: Array<Record<string, unknown>> = [], response: PlanVerdict = verdict) {
	let plan = makePlan();
	let owners: CriticOwnerRunState[] = [];
	const handlers = new Map<string, Handler>();
	const entries = [...saved];
	const notices: Array<{ content: string; details: { escalated: boolean } }> = [];
	let interval: (() => void) | undefined;
	let pollMs = 0;
	let tool:
		| {
				execute(
					id: string,
					params: Record<string, string>,
					signal: undefined,
					update: undefined,
					ctx: ExtensionContext,
				): Promise<unknown>;
		  }
		| undefined;
	const run = vi.fn(async (_task: string, _signal: unknown, subject: string) => {
		expect(subject).toBe("Plan");
		return { details: { results: [{ output: JSON.stringify(response) }] } };
	});
	const ctx = {
		getTodoPhases: () => plan,
		updateTodoSchedule: (task: string, patch: Partial<TodoSchedule>) => {
			plan = plan.map(phase => ({ ...phase, tasks: phase.tasks.map(row =>
				row.content === task ? { ...row, schedule: { ...row.schedule, ...patch } } : row) }));
			return true;
		},
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		sessionManager: { getHeader: () => ({ id: "test" }), getBranch: () => entries },
		runDeliveryCritic: run,
		setInterval: (fn: () => void, ms: number) => {
			pollMs = ms;
			interval = fn;
			return 1;
		},
		clearTimer: () => {},
	} as unknown as ExtensionContext;
	planCritic({
		typebox: { Type },
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (value: typeof tool) => {
			tool = value;
		},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() }),
		sendMessage: (message: (typeof notices)[number]) => notices.push(message),
	} as unknown as ExtensionAPI, () => owners);
	return {
		ctx,
		plan: () => plan,
		entries,
		notices,
		run,
		tool: () => tool!,
		owners: (next: CriticOwnerRunState[]) => { owners = next; },
		set: (next: TodoScheduleInput) => {
			plan = next;
		},
		event: (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx),
		wake: () => interval?.(),
		pollMs: () => pollMs,
	};
}
const settle = async () => {
	await Bun.sleep(0);
};

test("critic receives the current requirement diff with its exact quote, excluding another revision's receipt", async () => {
	const row = "Edit PRD levels";
	const saved = [
		{ type: "custom", customType: "requirements_ledger", data: { requirements: [{ id: "R1", rows: [row], rawText: "solar should not block levels", text: "levels never refused" }] } },
		{ type: "custom", customType: "requirement-diff-audit", data: { row, head: "current", delivery: "d1", diffs: [{ before: "Solar blocks levels", after: "Levels never refused", widening: true }] } },
		{ type: "custom", customType: "requirement-diff-audit", data: { row, head: "stale", delivery: "d0", diffs: [{ after: "STALE DIFF" }] } },
	];
	const h = harness(saved, { ...verdict, converging: true, actions: [] });
	h.set([{ name: "work", tasks: [{ content: row, status: "pending", schedule: { audit: {
		head: "current", delivery: "d1", repoPath: "/p", startedAt: 1, verdict: "fail", agent: "qa-auditor", at: 2,
	} } }] }]);
	h.event("session_start");
	await settle();
	const input = h.run.mock.calls[0]![0];
	expect(input).toContain("solar should not block levels");
	expect(input).toContain("Levels never refused");
	expect(input).not.toContain("STALE DIFF");
});
afterEach(() => vi.restoreAllMocks());
describe("plan critic runtime binding", () => {
	test("successful dependency mutation closes an action; prose and failed tools cannot", async () => {
		const h = harness();
		h.event("session_start");
		await settle();
		expect(h.run).toHaveBeenCalledTimes(1);
		h.event("before_agent_start", { prompt: "I fixed it" });
		expect(h.event("tool_call", { toolName: "wait", toolCallId: "wait" })).toMatchObject({ block: true });
		h.event("tool_call", { toolName: "todo", toolCallId: "bad" });
		h.event("tool_result", { toolName: "todo", toolCallId: "bad", isError: true });
		expect(h.event("tool_call", { toolName: "yield", toolCallId: "yield" })).toMatchObject({ block: true });
		h.event("tool_call", { toolName: "todo", toolCallId: "good" });
		const changed = makePlan();
		changed[0]!.tasks[1]!.schedule!.dependencies = [];
		h.set(changed);
		h.event("tool_result", { toolName: "todo", toolCallId: "good", isError: false });
		expect(h.event("tool_call", { toolName: "wait", toolCallId: "ok" })).toBeUndefined();
		const binding = h.entries.at(-1)!.data as Binding;
		expect(binding.addressed[action.id]!.toolCallId).toBe("good");
	});
	test("unaddressed verdict is delivered once across 35 wakes and session restart", async () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const h = harness();
		h.event("session_start");
		await settle();
		vi.spyOn(Date, "now").mockReturnValue(now + 45 * 60_000);
		expect(h.notices[0]!.details.escalated).toBe(false);
		for (let i = 0; i < 35; i++) { h.wake(); h.event("agent_end"); h.event("before_agent_start"); }
		expect(h.notices).toHaveLength(1);
		expect(chiefCriticFixes(h.ctx)).toEqual([{ row: "Collateral", action: "Unblock", severity: -1 }]);
		const restored = harness(h.entries);
		restored.event("session_start");
		await settle();
		expect(restored.run).not.toHaveBeenCalled();
		expect(restored.notices).toHaveLength(0);
		expect(restored.event("tool_call", { toolName: "wait", toolCallId: "r" })).toMatchObject({ block: true });
		const binding = restored.entries.filter(entry => entry.customType === PLAN_CRITIC_ENTRY).at(-1)!.data as Binding;
		await expect(
			restored
				.tool()
				.execute(
					"reject",
					{ verdictId: binding.id, actionId: action.id, decision: "reject", reason: "" },
					undefined,
					undefined,
					restored.ctx,
				),
		).rejects.toThrow();
		await restored.tool().execute(
			"reject",
			{
				verdictId: binding.id,
				actionId: action.id,
				decision: "reject",
				reason: "Labels changes the coordinate contract",
			},
			undefined,
			undefined,
			restored.ctx,
		);
		expect(restored.event("tool_call", { toolName: "wait", toolCallId: "r2" })).toBeUndefined();
	});
	test("converging verdict permits waiting and repeats only after the configured interval", async () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const h = harness([], {
			...verdict,
			converging: true,
			criticalPathBlocker: null,
			falseDependencies: [],
			actions: [],
		});
		h.event("session_start");
		await settle();
		h.event("before_agent_start");
		await settle();
		expect(h.run).toHaveBeenCalledTimes(1);
		expect(h.event("tool_call", { toolName: "wait", toolCallId: "ok" })).toBeUndefined();
		vi.spyOn(Date, "now").mockReturnValue(now + 45 * 60_000 - 1);
		h.wake();
		await settle();
		expect(h.run).toHaveBeenCalledTimes(1);
		vi.spyOn(Date, "now").mockReturnValue(now + 45 * 60_000);
		h.wake();
		await settle();
		expect(h.run).toHaveBeenCalledTimes(2);
	});
	test("completed or worker sessions never spawn critics", async () => {
		const h = harness();
		h.set([]);
		h.event("session_start");
		await settle();
		expect(h.run).not.toHaveBeenCalled();
	});
	test("fresh reviewer input excludes transcripts and coalesces concurrent wakes", async () => {
		const h = harness([{ type: "message", message: { role: "assistant", content: "PRIVATE-TRANSCRIPT-SENTINEL" } }]);
		h.event("session_start");
		h.event("before_agent_start");
		await settle();
		expect(h.run).toHaveBeenCalledTimes(1);
		expect(h.run.mock.calls[0]![0]).not.toContain("PRIVATE-TRANSCRIPT-SENTINEL");
		h.event("agent_end");
		expect(h.notices).toHaveLength(1);
	});
	test("new churn triggers a review after the minimum cadence", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const h = harness([], {
			...verdict,
			converging: true,
			criticalPathBlocker: null,
			falseDependencies: [],
			actions: [],
		});
		h.event("session_start");
		await settle();
		const next = makePlan();
		next[0]!.tasks[0]!.schedule = { cumulativeReestimateCount: 2 };
		h.set(next);
		h.event("tool_result", { toolName: "todo", toolCallId: "new", isError: false });
		await settle();
		expect(h.run).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(now + 30 * 60_000);
		h.wake();
		await settle();
		expect(h.run).toHaveBeenCalledTimes(2);
		h.event("before_agent_start");
		await settle();
		expect(h.run).toHaveBeenCalledTimes(2);
	});
	test("malformed verdicts cannot erase obligations", () => {
		expect(parsePlanVerdict({ ...verdict, converging: true })).toBeUndefined();
		expect(parsePlanVerdict({ ...verdict, actions: [action, action] })).toBeUndefined();
		expect(criticInterval(undefined)).toBe(45 * 60_000);
		expect(() => criticInterval("0")).toThrow();
	});
	test("unrelated mutations never count as executing a critic action", () => {
		expect(actionObserved(action, makePlan(), makePlan())).toBe(false);
		const changed = makePlan();
		changed[0]!.tasks[0]!.status = "completed";
		expect(actionObserved(action, makePlan(), changed)).toBe(false);
	});
});

 test("an empty startup followed by restored churn is reviewed by the next minute poll", async () => {
	const h = harness([], { ...verdict, converging: true, actions: [] });
	h.set([]);
	await h.event("session_start");
	await settle();
	expect(h.run).not.toHaveBeenCalled();
	const plan = makePlan();
	plan[0]!.tasks[0]!.schedule = { cumulativeReestimateCount: 5 };
	h.set(plan);
	expect(h.pollMs()).toBeLessThanOrEqual(60_000);
	h.wake();
	await settle();
	expect(h.run).toHaveBeenCalledTimes(1);
});

test("a continued lead with parentSession runs; a depth-zero task child does not", async () => {
	const h = harness();
	vi.spyOn(h.ctx.sessionManager, "getHeader").mockReturnValue({ type: "session", id: "continued", cwd: "/fixture", timestamp: new Date().toISOString(), parentSession: "old-lead", continuationOf: "old-lead" });
	await h.event("session_start");
	await settle();
	expect(h.run).toHaveBeenCalledTimes(1);
	const child = harness();
	child.ctx.agent.kind = "sub";
	await child.event("session_start");
	await settle();
	expect(child.run).not.toHaveBeenCalled();
});

test("repeated empty-plan polls log one debug and warning for their skip reason", async () => {
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
	const h = harness();
	h.set([]);
	await h.event("session_start");
	for (let i = 0; i < 10; i++) h.wake();
	expect(warn.mock.calls.filter(call => call[1]?.reason === "tick:no-open-rows")).toHaveLength(1);
	expect(debug.mock.calls.filter(call => call[1]?.reason === "tick:no-open-rows")).toHaveLength(1);
	expect(h.run).not.toHaveBeenCalled();
});

async function rejectCurrent(h: ReturnHarness, reason = 'Owner: “Levels never refused”; e2e/facility-floor-buttons.spec.ts:680-701') {
	const binding = h.entries.filter(entry => entry.customType === PLAN_CRITIC_ENTRY).at(-1)!.data as Binding;
	await h.tool().execute("reject", { verdictId: binding.id, actionId: action.id, decision: "reject", reason }, undefined, undefined, h.ctx);
}
type ReturnHarness = {
	entries: Array<Record<string, unknown>>;
	tool: () => { execute(id: string, params: Record<string, string>, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<unknown> };
	ctx: ExtensionContext;
};

test("unchanged rejected action with a new id stays addressed after restart without waking the lead", async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const h = harness();
	await h.event("session_start");
	await settle();
	await rejectCurrent(h);
	clock.mockReturnValue(now + 45 * 60_000);
	const restored = harness(h.entries, { ...verdict, actions: [{ ...action, id: "new-id" }] });
	await restored.event("session_start");
	await settle();
	expect(restored.run).toHaveBeenCalledTimes(1);
	expect(restored.notices).toHaveLength(0);
	expect(restored.event("tool_call", { toolName: "wait", toolCallId: "ok" })).toBeUndefined();
	const latest = restored.entries.at(-1)!.data as Binding;
	expect(latest.addressed["new-id"]?.reason).toStartWith("previously rejected: ");
	expect(restored.run.mock.calls[0]![0]).toContain("e2e/facility-floor-buttons.spec.ts:680-701");
});

test("seven unrelated successful plan results do not append seven duplicate bindings", async () => {
	const h = harness();
	await h.event("session_start");
	await settle();
	const count = h.entries.length;
	for (let i = 0; i < 7; i++) {
		h.event("tool_call", { toolName: "todo", toolCallId: String(i) });
		h.event("tool_result", { toolName: "todo", toolCallId: String(i), isError: false });
	}
	expect(h.entries).toHaveLength(count);
	const next = makePlan();
	next[0]!.tasks[1]!.schedule!.dependencies = [];
	h.event("tool_call", { toolName: "todo", toolCallId: "changed" });
	h.set(next);
	h.event("tool_result", { toolName: "todo", toolCallId: "changed", isError: false });
	expect(h.entries).toHaveLength(count + 1);
});

for (const change of ["attempts", "reestimates", "audit", "head"] as const) {
	test(`changed ${change} allows a rejected row action to wake the lead again`, async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const h = harness();
		const original = makePlan();
		original[0]!.tasks[1]!.schedule!.audit = { repoPath: "/fixture", head: "old-head", delivery: "d1", startedAt: 1, verdict: "pass", agent: "qa-auditor", at: 2 };
		h.set(original);
		await h.event("session_start");
		await settle();
		await rejectCurrent(h);
		clock.mockReturnValue(now + 45 * 60_000);
		const restored = harness(h.entries);
		const plan = structuredClone(original);
		const schedule = plan[0]!.tasks[1]!.schedule!;
		if (change === "reestimates") schedule.cumulativeReestimateCount = 3;
		if (change === "attempts") schedule.attemptHistory = [{ attemptId: "worker", workerName: "worker", resolvedModel: "fixture", effort: "low", deliverablePaths: [], startedAt: 1, finishedAt: 2, durationMs: 1, terminalStatus: "failed" }];
		if (change === "audit") schedule.audit!.verdict = "fail";
		if (change === "head") schedule.audit!.head = "new-head";
		restored.set(plan);
		await restored.event("session_start");
		await settle();
		expect(restored.notices).toHaveLength(1);
		expect(restored.event("tool_call", { toolName: "wait", toolCallId: "blocked" })).toMatchObject({ block: true });
	});
}


test("reviewer history deduplicates bindings, keeps the latest three and bounds UTF-8 bytes", () => {
	const bindings: Binding[] = Array.from({ length: 5 }, (_, i) => ({
		id: String(i), at: i, verdict, addressed: { [action.id]: { reason: `reject: reason-${i}` } }, wakes: 1,
	}));
	const recent = JSON.parse(compactBindingHistory(bindings)) as Array<{ id: string }>;
	expect(recent.map(item => item.id)).toEqual(["4", "3", "2"]);
	bindings[4]!.addressed[action.id]!.reason = "reject: " + "Я".repeat(4096);
	const bounded = compactBindingHistory(bindings);
	expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(4096);
	expect(JSON.parse(bounded)).toEqual([{ id: "4", actions: [], omittedActions: 1 }]);
});

test("a rejection never suppresses a different action kind on the same row", async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const h = harness();
	await h.event("session_start"); await settle(); await rejectCurrent(h);
	clock.mockReturnValue(now + 45 * 60_000);
	const restored = harness(h.entries, { ...verdict, actions: [{ ...action, kind: "dispatch" }] });
	await restored.event("session_start"); await settle();
	expect(restored.notices).toHaveLength(1);
});


test("escalations cannot become fake owner questions or self-addressed lead demands", async () => {
	const h = harness([], { ...verdict, actions: [{ ...action, kind: "escalate", next: "Ask the lead: choose the checkout" }] });
	await h.event("session_start"); await settle();
	for (let i = 0; i < 35; i++) h.event("agent_end");
	expect(h.notices).toEqual([]);
	expect(chiefCriticFixes(h.ctx)).toEqual([]);
	expect(h.event("tool_call", { toolName: "wait", toolCallId: "ok" })).toBeUndefined();
});

test("critic projection drops a completed or deleted own row and is hidden from children", async () => {
	const h = harness();
	await h.event("session_start"); await settle();
	expect(chiefCriticFixes(h.ctx)).toEqual([{ row: "Collateral", action: "Unblock" }]);
	const next = makePlan(); next[0]!.tasks[1]!.status = "completed"; h.set(next);
	expect(chiefCriticFixes(h.ctx)).toEqual([]);
	const unblocked = makePlan(); unblocked[0]!.tasks[1]!.schedule!.dependencies = []; h.set(unblocked);
	expect(chiefCriticFixes(h.ctx)).toEqual([]);
	h.set(makePlan()); h.ctx.agent.kind = "sub";
	expect(chiefCriticFixes(h.ctx)).toEqual([]);
});

for (const shape of ["released worker", "abandoned reassigned row", "changed owner"] as const) {
	test(`stale ${shape} auto-closes without a lead rejection or another delivery`, async () => {
		const h = harness();
		h.owners([{ content: "Collateral", owner: "CoolingEvidence-2", running: true }]);
		await h.event("session_start"); await settle();
		const next = makePlan();
		if (shape === "released worker") h.owners([{ content: "Collateral", owner: "CoolingEvidence-2", running: false, outcome: "completed" }]);
		if (shape === "abandoned reassigned row") {
			next[0]!.tasks[1]!.status = "abandoned";
			next[0]!.tasks = [...next[0]!.tasks, { content: "GestureLabels replacement", status: "in_progress", schedule: { owner: "GestureLabels-3" } }];
		}
		if (shape === "changed owner") next[0]!.tasks[1]!.schedule!.owner = "Replacement-3";
		h.set(next);
		h.event("agent_end");
		expect(h.notices).toHaveLength(1);
		expect(h.event("tool_call", { toolName: "wait", toolCallId: "released" })).toBeUndefined();
		const latest = h.entries.filter(entry => entry.customType === PLAN_CRITIC_ENTRY).at(-1)!.data as Binding;
		expect(latest.addressed[action.id]?.reason).toStartWith("auto-closed:");
		expect(chiefCriticFixes(h.ctx)).toEqual([]);
	});
}

test("fresh action gains chief priority after two lead turns without repeating its notification", async () => {
	const h = harness();
	await h.event("session_start"); await settle();
	h.event("agent_end");
	expect(chiefCriticFixes(h.ctx)[0]?.severity).toBeUndefined();
	h.event("agent_end");
	const fixes = chiefCriticFixes(h.ctx);
	expect(fixes).toEqual([{ row: "Collateral", action: "Unblock", severity: -1 }]);
	for (let i = 0; i < 35; i++) h.event("agent_end");
	expect(h.notices).toHaveLength(1);
});

test("a row changed while reviewer runs is closed before its first notification", async () => {
	const h = harness();
	const response = Promise.withResolvers<{ details: { results: Array<{ output: string }> } }>();
	h.run.mockImplementation(async () => response.promise);
	await h.event("session_start"); await settle();
	const next = makePlan(); next[0]!.tasks[1]!.status = "completed"; h.set(next);
	response.resolve({ details: { results: [{ output: JSON.stringify(verdict) }] } });
	await settle();
	expect(h.notices).toEqual([]);
	const latest = h.entries.filter(entry => entry.customType === PLAN_CRITIC_ENTRY).at(-1)!.data as Binding;
	expect(latest.addressed[action.id]?.reason).toContain("completed");
});

test("changed row regenerates a verdict from current ownership instead of replaying it", async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const h = harness();
	await h.event("session_start"); await settle();
	const originalId = (h.entries.filter(entry => entry.customType === PLAN_CRITIC_ENTRY).at(-1)!.data as Binding).id;
	const next = makePlan(); next[0]!.tasks[1]!.schedule!.owner = "NewOwner-3"; h.set(next);
	clock.mockReturnValue(now + 30 * 60_000);
	h.wake(); await settle();
	expect(h.run).toHaveBeenCalledTimes(2);
	expect(h.run.mock.calls[1]![0]).toContain("NewOwner-3");
	const latest = h.entries.filter(entry => entry.customType === PLAN_CRITIC_ENTRY).at(-1)!.data as Binding;
	expect(latest.id).not.toBe(originalId);
	expect(h.notices).toHaveLength(2);
});

test("a persisted failed critic attempt cannot be retried on resume before the cadence", async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const h = harness([{ type: "custom", customType: `${PLAN_CRITIC_ENTRY}-attempt`, data: { at: now - 60_000 } }]);
	await h.event("session_start"); await settle();
	expect(h.run).not.toHaveBeenCalled();
	clock.mockReturnValue(now + 29 * 60_000);
	h.wake(); await settle();
	expect(h.run).toHaveBeenCalledTimes(1);
});

test("later plan actions never create a binding wait refusal", async () => {
	const h = harness([], { ...verdict, actions: [{ ...action, severity: "later" }] });
	await h.event("session_start"); await settle();
	expect(h.event("tool_call", { toolName: "wait", toolCallId: "later" })).toBeUndefined();
	expect(chiefCriticFixes(h.ctx)).toEqual([]);
});


test("multiple later plan actions on one row retain every executable follow-up", async () => {
	const next = ["Add empty-result coverage", "Clarify the export label"];
	const h = harness([], { ...verdict, actions: next.map((value, index) => ({
		...action, id: `later-${index}`, severity: "later", next: value,
	})) });
	await h.event("session_start"); await settle();
	expect(h.plan()[0]!.tasks[1]!.schedule!.auditFollowUps).toEqual(next);
	expect(h.event("tool_call", { toolName: "wait", toolCallId: "later-actions" })).toBeUndefined();
});

for (const outcome of ["failed", "aborted", undefined] as const) {
	test(`retained ${outcome ?? "unknown"} worker identity cannot discharge dispatch recovery`, async () => {
		const dispatch: PlanAction = { ...action, kind: "dispatch", dependency: undefined };
		const h = harness([], { ...verdict, actions: [dispatch] });
		const plan = makePlan();
		plan[0]!.tasks[1]!.schedule = { executor: { workerId: "Previous-1", startedAt: 1, outcome } };
		h.set(plan);
		h.owners([{ content: dispatch.row, owner: "Previous-1", running: false, outcome }]);
		await h.event("session_start"); await settle();
		expect(chiefCriticFixes(h.ctx)).toEqual([{ row: dispatch.row, action: "Staff" }]);
		expect(h.event("tool_call", { toolName: "wait", toolCallId: "blocked" })).toMatchObject({ block: true });
		// A successful task tool can still report a failed startup. A new ID is not evidence of a running worker.
		h.event("tool_call", { toolName: "task", toolCallId: "retry" });
		const retried = structuredClone(plan);
		retried[0]!.tasks[1]!.schedule!.executor = { workerId: "Retry-2", startedAt: 2, outcome: "failed" };
		h.set(retried);
		h.owners([{ content: dispatch.row, owner: "Retry-2", running: false, outcome: "failed" }]);
		h.event("tool_result", { toolName: "task", toolCallId: "retry", isError: false });
		expect(chiefCriticFixes(h.ctx)).toEqual([{ row: dispatch.row, action: "Staff" }]);
		expect(h.event("tool_call", { toolName: "wait", toolCallId: "still-blocked" })).toMatchObject({ block: true });
		// An actual live replacement closes staffing, preventing duplicate dispatch.
		h.owners([{ content: dispatch.row, owner: "Retry-2", running: true }]);
		expect(chiefCriticFixes(h.ctx)).toEqual([]);
		expect(h.event("tool_call", { toolName: "wait", toolCallId: "staffed" })).toBeUndefined();
	});
}

test("dispatch recovery closes on a completed outcome, not an unrelated live worker or stale completed receipt", async () => {
	const dispatch: PlanAction = { ...action, kind: "dispatch", dependency: undefined };
	const h = harness([], { ...verdict, actions: [dispatch] });
	const plan = makePlan();
	plan[0]!.tasks[1]!.schedule = { executor: { workerId: "Old-1", startedAt: 1, outcome: "completed" } };
	h.set(plan);
	h.owners([
		{ content: dispatch.row, owner: "Retry-2", running: false, outcome: "failed" },
		{ content: "Labels", owner: "Unrelated-3", running: true },
	]);
	await h.event("session_start"); await settle();
	expect(chiefCriticFixes(h.ctx)).toEqual([{ row: dispatch.row, action: "Staff" }]);
	expect(h.event("tool_call", { toolName: "wait", toolCallId: "no-proof" })).toMatchObject({ block: true });
	h.owners([{ content: dispatch.row, owner: "Retry-2", running: false, outcome: "completed" }]);
	expect(chiefCriticFixes(h.ctx)).toEqual([]);
	expect(h.event("tool_call", { toolName: "wait", toolCallId: "completed" })).toBeUndefined();
});


test("an authoritative unknown run supersedes a stale completed executor receipt", async () => {
	const dispatch: PlanAction = { ...action, kind: "dispatch", dependency: undefined };
	const h = harness([], { ...verdict, actions: [dispatch] });
	const plan = makePlan();
	plan[0]!.tasks[1]!.schedule = { executor: { workerId: "Old-1", startedAt: 1, outcome: "completed" } };
	h.set(plan);
	h.owners([{ content: dispatch.row, owner: "New-2", running: false }]);
	await h.event("session_start"); await settle();
	expect(chiefCriticFixes(h.ctx)).toEqual([{ row: dispatch.row, action: "Staff" }]);
	expect(h.event("tool_call", { toolName: "wait", toolCallId: "unknown" })).toMatchObject({ block: true });
	const before = makePlan();
	expect(actionObserved(dispatch, before, plan, { content: dispatch.row, owner: "New-2", running: false })).toBe(false);
});
