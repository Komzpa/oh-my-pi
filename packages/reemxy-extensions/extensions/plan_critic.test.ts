import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import planCritic, {
	actionObserved,
	criticInterval,
	parsePlanVerdict,
	PLAN_CRITIC_ENTRY,
	type Binding,
	type PlanAction,
	type PlanVerdict,
} from "./plan_critic";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
const action: PlanAction = {
	id: "cut-wait",
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
	const run = vi.fn(async (_task: string) => ({ details: { results: [{ output: JSON.stringify(response) }] } }));
	const ctx = {
		getTodoPhases: () => plan,
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
	} as unknown as ExtensionAPI);
	return {
		ctx,
		entries,
		notices,
		run,
		tool: () => tool!,
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
	test("unaddressed verdict escalates on next wake and survives session restart", async () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const h = harness();
		h.event("session_start");
		await settle();
		vi.spyOn(Date, "now").mockReturnValue(now + 45 * 60_000);
		expect(h.notices[0]!.details.escalated).toBe(false);
		h.wake();
		expect(h.notices.at(-1)!.details.escalated).toBe(true);
		const restored = harness(h.entries);
		restored.event("session_start");
		await settle();
		expect(restored.run).not.toHaveBeenCalled();
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
		vi.spyOn(Date, "now").mockReturnValue(now + 61 * 60_000);
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
		expect(h.notices.at(-1)!.details.escalated).toBe(true);
	});
	test("new churn triggers a review immediately inside the periodic interval", async () => {
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
