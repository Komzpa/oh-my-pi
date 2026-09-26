/** Observable task-tool acceptance coverage for retry and rework routing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as reflectionModule from "@oh-my-pi/pi-coding-agent/task/rework-reflection";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPersistedEdit, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const ROW = "Render the accepted cut";
const OWNER = "RenderCut";
const MODEL = "anthropic/claude-sonnet-4";
const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: ROW,
		assignment: "Render the cut.",
		exitCode: 0,
		output: "Rendered and checked the cut.\n\nFinal report paragraph.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		resolvedModel: `${MODEL}:medium`,
		resolvedModelIdentity: MODEL,
		resolvedThinkingLevel: "medium" as SingleResult["resolvedThinkingLevel"],
		...overrides,
	};
}

function createSession(
	initial: TodoPhase[] = [],
	ladder: readonly string[] = [":high"],
): { session: ToolSession; phases: () => TodoPhase[]; setPhases: (value: TodoPhase[]) => void; edits: TodoPersistedEdit[] } {
	let current = initial;
	const edits: TodoPersistedEdit[] = [];
	const bus = new EventBus();
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.reworkLadder": [...ladder] }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		eventBus: bus,
		subagentEventBus: bus,
		getTodoPhases: () => current,
		setTodoPhases: (next: TodoPhase[]) => { current = next; },
		persistTodoPhases: (_next: TodoPhase[], edit?: TodoPersistedEdit) => { if (edit) edits.push(edit); },
		getArtifactsDir: () => "/tmp",
	} as unknown as ToolSession;
	return { session, phases: () => current, setPhases: value => { current = value; }, edits };
}
function seededPhase(
	outcome: "failed" | "aborted" | "completed",
	history: NonNullable<TodoPhase["tasks"][number]["schedule"]>["attemptHistory"] = [],
	executor: { owner?: string; workerId?: string; startedAt?: number; finishedAt?: number; resolvedModel?: string; thinkingLevel?: string } = {},
): TodoPhase[] {
	return [{
		name: "Video craft",
		tasks: [{
			content: ROW,
			status: "in_progress",
			schedule: {
				dependencies: [],
				owner: executor.owner ?? OWNER,
				executor: {
					workerId: executor.workerId ?? OWNER,
					agentProfile: "task",
					startedAt: executor.startedAt ?? 100,
					finishedAt: executor.finishedAt ?? 200,
					outcome,
					resolvedModel: executor.resolvedModel ?? MODEL,
					thinkingLevel: executor.thinkingLevel ?? "medium",
				},
				attemptHistory: history,
			},
		}],
	}];
}


function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.type === "text" ? part.text ?? "" : "").join("\n");
}

describe("task rework acceptance", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("keeps an infrastructure retry on its current rung without rejection history", async () => {
		const existing = [{
			attemptId: `${OWNER}:100`, workerName: OWNER, resolvedModel: MODEL, effort: "medium",
			startedAt: 100, finishedAt: 200, durationMs: 100, terminalStatus: "failed",
			deliverablePaths: [], infraFailureError: "HTTP 402 payment required",
			infraFailureLine: "attempt 1 failed: HTTP 402 payment required",
		}];
		const harness = createSession(seededPhase("failed", existing));
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);

		const result = await tool.execute("retry", { agent: "task", name: OWNER, task: "Retry the render." } as TaskParams);

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]![0].exactThinkingLevel).toBe("medium");
		expect(run.mock.calls[0]![0].modelOverride).toEqual([MODEL]);
		expect(run.mock.calls[0]![0].context).toBe("attempt 1 failed: HTTP 402 payment required");
		expect(text(result)).not.toContain("Previous attempts:");
		expect(text(result)).not.toContain("Rejection reason:");
		expect(harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory).toEqual(existing);
	});

	it("advances completed rework in the same worker session and preserves ordinary routing", async () => {
		const harness = createSession();
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? OWNER));
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			const effort = options.thinkingLevel ?? "medium";
			return makeResult(options.id, {
				resolvedModel: `${MODEL}:${effort}`,
				resolvedModelIdentity: MODEL,
				resolvedThinkingLevel: effort as SingleResult["resolvedThinkingLevel"],
			});
		});
		vi.spyOn(reflectionModule, "captureReworkReflection").mockResolvedValue({ answer: "Use a simpler cut path." });
		const tool = await TaskTool.create(harness.session);

		const first = await tool.execute("ordinary-first", { agent: "task", name: OWNER, task: "Render the cut." } as TaskParams);
		expect(first.details?.results[0]?.id).toBe(OWNER);
		expect(run).toHaveBeenCalledTimes(1);
		expect(text(first)).not.toContain("Previous attempts:");
		expect(run.mock.calls[0]![0].context).toBeUndefined();

		harness.setPhases(seededPhase("completed"));
		const rework = await tool.execute("rework", {
			agent: "task", name: OWNER, task: "Improve the render.", rework: "The motion blur obscures the subject.",
		} as TaskParams);
		const resumed = followUp.mock.calls[0]![0];
		expect(run).toHaveBeenCalledTimes(1);
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(resumed.id).toBe(OWNER);
		expect(resumed.thinkingLevel).toBe("high");
		expect(resumed.message).toContain("Previous attempts:");
		expect(resumed.message).toContain("Rejection reason: The motion blur obscures the subject.");
		expect(rework.details?.results[0]?.id).toBe(OWNER);
		expect(rework.details?.results[0]?.resolvedModelIdentity).toBe(MODEL);
		expect(harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory?.[0]?.rejectionReason).toBe("The motion blur obscures the subject.");
	});
	it("refuses completed rework without a single-line rejection reason", async () => {
		const harness = createSession(seededPhase("completed"));
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);

		const missing = await tool.execute("missing-reason", { agent: "task", name: OWNER, task: "Improve the cut." } as TaskParams);
		const multiline = await tool.execute("multiline-reason", {
			agent: "task", name: OWNER, task: "Improve the cut.", rework: "first line\nsecond line",
		} as TaskParams);
		const blank = await tool.execute("blank-reason", {
			agent: "task", name: OWNER, task: "Improve the cut.", rework: " \t",
		} as TaskParams);

		expect(text(missing)).toContain("requires a one-line");
		expect(text(multiline)).toContain("requires a one-line");
		expect(text(blank)).toContain("requires a one-line");
		expect(run).not.toHaveBeenCalled();
	});

	it("passes the prior report paragraph when reflection has no answer", async () => {
		const harness = createSession();
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? OWNER));
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => makeResult(options.id));
		vi.spyOn(reflectionModule, "captureReworkReflection").mockResolvedValue({ noAnswerReason: "worker returned no reflection answer" });
		const tool = await TaskTool.create(harness.session);

		await tool.execute("first", { agent: "task", name: OWNER, task: "Render the cut." } as TaskParams);
		harness.setPhases(seededPhase("completed", [], {
			owner: OWNER, workerId: OWNER, startedAt: 100, finishedAt: 200, resolvedModel: MODEL, thinkingLevel: "medium",
		}));
		await tool.execute("rework", {
			agent: "task", name: OWNER, task: "Improve the cut.", rework: "The crop still hides the subject.",
		} as TaskParams);

		const message = followUp.mock.calls[0]![0].message;
		expect(message).toContain("Worker reflection: no answer (worker returned no reflection answer)");
		expect(message).toContain("Final report paragraph: Final report paragraph.");
		expect(message).toContain("Rejection reason: The crop still hides the subject.");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("replays two rejections into the third rung and blocks after the final rung", async () => {
		const ladder = [":low", ":medium", ":high", "codex-lb/gpt-6-sol:medium"];
		const harness = createSession([], ladder);
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const resolvedModelIdentity = options.modelOverride?.[0] ?? MODEL;
			const resolvedThinkingLevel = options.thinkingLevel ?? options.exactThinkingLevel ?? "high";
			return makeResult(options.id ?? OWNER, {
				resolvedModel: `${resolvedModelIdentity}:${resolvedThinkingLevel}`,
				resolvedModelIdentity,
				resolvedThinkingLevel: resolvedThinkingLevel as SingleResult["resolvedThinkingLevel"],
			});
		});
		vi.spyOn(reflectionModule, "captureReworkReflection").mockResolvedValue({ answer: "Use the simpler crop." });
		const tool = await TaskTool.create(harness.session);
		const seed = await tool.execute("seed-session", {
			agent: "task", name: OWNER, task: "Seed the previous worker session.",
		} as TaskParams);
		const firstWorkerId = seed.details?.results[0]?.id ?? OWNER;
		const now = Date.now();
		const neighborHistory = [{
			attemptId: "neighbor:50",
			workerName: "NeighborWorker",
			resolvedModel: MODEL,
			effort: "high",
			startedAt: 50,
			finishedAt: 60,
			durationMs: 10,
			terminalStatus: "completed" as const,
			deliverablePaths: ["neighbor.md"],
			rejectionReason: "Neighbor rejection.",
			reflectionAnswer: "Do not copy this row.",
		}];
		const base = seededPhase("completed", [{
			attemptId: "older:100",
			workerName: "OlderWorker",
			resolvedModel: MODEL,
			effort: "medium",
			startedAt: 100,
			finishedAt: 200,
			durationMs: 100,
			terminalStatus: "completed",
			deliverablePaths: ["older-output.md"],
			rejectionReason: "First rejection.",
			reflectionAnswer: "Simplify the crop.",
			finalReportParagraph: "Original report end.",
		}], {
			owner: firstWorkerId,
			workerId: firstWorkerId,
			startedAt: 300,
			finishedAt: 400,
			resolvedModel: MODEL,
			thinkingLevel: "high",
		});
		base[0]!.tasks.push({ content: "Unrelated neighboring row", status: "completed", schedule: { attemptHistory: neighborHistory } });
		harness.setPhases(base);
		harness.edits.length = 0;

		const third = await tool.execute("third-dispatch", {
			agent: "task", name: firstWorkerId, task: "Improve the cut again.", rework: "Second rejection.",
		} as TaskParams);
		const thirdDispatch = run.mock.calls[1]![0];
		const previousAttempts = thirdDispatch.context ?? "";
		const firstReason = previousAttempts.indexOf("First rejection.");
		const secondReason = previousAttempts.indexOf("Second rejection.");
		expect(thirdDispatch.modelOverride).toEqual(["codex-lb/gpt-6-sol"]);
		expect(thirdDispatch.thinkingLevel ?? thirdDispatch.exactThinkingLevel).toBe("medium");
		expect(previousAttempts).toContain("Previous attempts:");
		expect(previousAttempts).toContain("Worker: OlderWorker");
		expect(previousAttempts).toContain(`Resolved model:effort: ${MODEL}:medium`);
		expect(previousAttempts).toContain("Started: 1970-01-01T00:00:00.100Z");
		expect(previousAttempts).toContain("Finished: 1970-01-01T00:00:00.200Z");
		expect(previousAttempts).toContain("Duration: 100 ms");
		expect(previousAttempts).toContain("Status: completed");
		expect(previousAttempts).toContain("Deliverable paths: older-output.md");
		expect(previousAttempts).toContain("Worker reflection: Simplify the crop.");
		expect(previousAttempts).toContain("Final report paragraph: Original report end.");
		expect(previousAttempts).toContain("Worker reflection: Use the simpler crop.");
		expect(previousAttempts).not.toContain("NeighborWorker");
		expect(previousAttempts).not.toContain("Neighbor rejection.");
		expect(firstReason).toBeGreaterThanOrEqual(0);
		expect(secondReason).toBeGreaterThan(firstReason);
		expect(harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory).toHaveLength(2);
		expect(harness.edits.filter(edit => edit.kind === "attempt")).toHaveLength(1);
		expect(harness.phases()[0]!.tasks[1]!.schedule?.attemptHistory).toEqual(neighborHistory);

		const snapshot = {
			type: "custom",
			customType: USER_TODO_EDIT_CUSTOM_TYPE,
			data: { phases: base },
			id: "snapshot",
			parentId: null,
			timestamp: new Date(now).toISOString(),
		} as SessionEntry;
		const replayEntries = [snapshot, ...harness.edits.map((edit, index) => ({
			type: "custom" as const,
			customType: USER_TODO_EDIT_CUSTOM_TYPE,
			data: { edit },
			id: `edit-${index}`,
			parentId: index === 0 ? "snapshot" : `edit-${index - 1}`,
			timestamp: new Date(now + index + 1).toISOString(),
		} as SessionEntry))];
		expect(getLatestTodoPhasesFromEntries(replayEntries)).toEqual(harness.phases());

		const thirdWorkerId = third.details?.results[0]?.id ?? firstWorkerId;
		harness.setPhases(seededPhase("completed", harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory, {
			owner: thirdWorkerId,
			workerId: thirdWorkerId,
			startedAt: 500,
			finishedAt: 600,
			resolvedModel: "codex-lb/gpt-6-sol",
			thinkingLevel: "medium",
		}));
		const top = await tool.execute("top-rung", {
			agent: "task", name: thirdWorkerId, task: "Improve the cut once more.", rework: "Third rejection.",
		} as TaskParams);
		const topText = text(top);
		expect(topText).toContain("Rework circuit breaker");
		expect(topText).toContain("First rejection.");
		expect(topText).toContain("Second rejection.");
		expect(topText).toContain("Third rejection.");
		expect(harness.phases()[0]!.tasks[0]!.status).toBe("blocked");
		expect(harness.phases()[0]!.tasks[0]!.blocker).toContain("waits for user");
		expect(run).toHaveBeenCalledTimes(2);
		const waiting = await tool.execute("after-top-rung", {
			agent: "task", name: thirdWorkerId, task: "Retry after circuit breaker.", rework: "Fourth rejection.",
		} as TaskParams);
		expect(text(waiting)).toContain("ladder is exhausted");
		expect(text(waiting)).not.toContain("Rework circuit breaker");
		expect(run).toHaveBeenCalledTimes(2);
	});
});
