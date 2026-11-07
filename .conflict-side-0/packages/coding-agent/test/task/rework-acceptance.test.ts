/** Observable task-tool acceptance coverage for retry and rework routing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as reflectionModule from "@oh-my-pi/pi-coding-agent/task/rework-reflection";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import { applyOpsToPhases } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPersistedEdit, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const ROW = "Render the accepted cut";
const OWNER = "RenderCut";
const OPENAI = "codex-lb/gpt-6-luna";
const MODEL = "anthropic/claude-sonnet-4";
const XAI = "openrouter/x-ai/grok-5";
/** The agent's own chain: three vendors, one model each. */
const CHAIN = [OPENAI, MODEL, XAI];
const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
	model: CHAIN,
};
const attempt = (model: string, n: number, extra: Record<string, unknown> = {}) => ({
	attemptId: `old${n}:${n}`,
	workerName: `old${n}`,
	resolvedModel: model,
	effort: "medium",
	startedAt: n,
	finishedAt: n + 1,
	durationMs: 1,
	terminalStatus: "completed" as const,
	deliverablePaths: [],
	rejectionReason: `Rejection ${n}.`,
	...extra,
});

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

function createSession(initial: TodoPhase[] = []): {
	session: ToolSession;
	phases: () => TodoPhase[];
	setPhases: (value: TodoPhase[]) => void;
	edits: TodoPersistedEdit[];
} {
	let current = initial;
	const edits: TodoPersistedEdit[] = [];
	const bus = new EventBus();
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"tools.approvalMode": "yolo",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		eventBus: bus,
		subagentEventBus: bus,
		getTodoPhases: () => current,
		setTodoPhases: (next: TodoPhase[]) => {
			current = next;
		},
		persistTodoPhases: (_next: TodoPhase[], edit?: TodoPersistedEdit) => {
			if (edit) edits.push(edit);
		},
		getArtifactsDir: () => "/tmp",
	} as unknown as ToolSession;
	return {
		session,
		phases: () => current,
		setPhases: value => {
			current = value;
		},
		edits,
	};
}
function seededPhase(
	outcome: "failed" | "aborted" | "completed",
	history: NonNullable<TodoPhase["tasks"][number]["schedule"]>["attemptHistory"] = [],
	executor: {
		owner?: string;
		workerId?: string;
		startedAt?: number;
		finishedAt?: number;
		resolvedModel?: string;
		thinkingLevel?: string;
	} = {},
): TodoPhase[] {
	return [
		{
			name: "Video craft",
			tasks: [
				{
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
				},
			],
		},
	];
}

/** Every vendor of CHAIN is spent: two rejected attempts plus the completed one on the last vendor. */
function exhaustedPhase(): TodoPhase[] {
	return seededPhase("completed", [attempt(OPENAI, 1), attempt(MODEL, 2)], {
		resolvedModel: XAI,
		thinkingLevel: "high",
	});
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function wrapTask(tool: TaskTool, session: ToolSession, select?: () => Promise<string | undefined>) {
	return new ExtensionToolWrapper<TaskTool["parameters"], TaskToolDetails>(
		{
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			approval: tool.approval,
			formatApprovalDetails: tool.formatApprovalDetails.bind(tool),
			execute: tool.execute.bind(tool),
		},
		{
			hasHandlers: () => false,
			consumeToolCallEmitted: () => false,
			hasUI: () => select !== undefined,
			getUIContext: () => ({ select }),
			sessionSettings: session.settings,
			sessionId: "rework-acceptance",
			runScoped<T>(fn: () => T): T {
				return fn();
			},
		} as unknown as ExtensionRunner,
	);
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
	it("moves a rejected row to the next untried vendor using the whole attempt history", async () => {
		const harness = createSession();
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		vi.spyOn(reflectionModule, "captureReworkReflection").mockResolvedValue({ answer: "Change the approach." });
		const tool = await TaskTool.create(harness.session);
		await tool.execute("seed", { name: OWNER, task: ROW });
		harness.setPhases(seededPhase("completed", [], { resolvedModel: OPENAI }));
		await tool.execute("rework-1", { name: OWNER, task: ROW, rework: "The result is still wrong." });
		expect(run.mock.calls.at(-1)![0].modelOverride).toEqual([MODEL]);
		expect(run.mock.calls.at(-1)![0].exactThinkingLevel).toBeUndefined();
		// A same-vendor sibling route must not count as a new vendor: openai was tried first.
		harness.setPhases(seededPhase("completed", [attempt("openrouter/openai/gpt-5.6", 1)], { resolvedModel: MODEL }));
		await tool.execute("rework-2", { name: OWNER, task: ROW, rework: "Still wrong." });
		expect(run.mock.calls.at(-1)![0].modelOverride).toEqual([XAI]);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("refuses an exhausted top-rung redispatch without approval and names the split", async () => {
		const harness = createSession();
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const reflection = vi
			.spyOn(reflectionModule, "captureReworkReflection")
			.mockResolvedValue({ answer: "Change the approach." });
		const tool = await TaskTool.create(harness.session);
		await tool.execute("seed", { name: OWNER, task: ROW });
		harness.setPhases(exhaustedPhase());
		const params = { name: OWNER, task: ROW, rework: "The final result is wrong." };
		const select = vi.fn(async () => "Approve");
		const wrapped = wrapTask(tool, harness.session, select);
		const topRung = await wrapped.execute("top-rung", params);
		expect(text(topRung)).toContain("op=append");
		expect(topRung.details?.results).toEqual([]);
		harness.setPhases(
			applyOpsToPhases(harness.phases(), [
				{ op: "block", task: ROW, reason: "waits for user: Rework ladder exhausted." },
			]).phases,
		);
		const blockedTopRung = await wrapped.execute("blocked-top-rung", params);
		expect(text(blockedTopRung)).toContain("op=append");
		expect(blockedTopRung.details?.results).toEqual([]);
		harness.setPhases(applyOpsToPhases(harness.phases(), [{ op: "unblock", task: ROW }]).phases);
		const unblockedTopRung = await wrapped.execute("unblocked-top-rung", params);
		expect(text(unblockedTopRung)).toContain("op=append");
		expect(unblockedTopRung.details?.results).toEqual([]);
		expect(select).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
		expect(reflection).not.toHaveBeenCalled();
		expect(harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory).toEqual([attempt(OPENAI, 1), attempt(MODEL, 2)]);
	});

	it("dispatches a split child row right away after an exhausted refusal", async () => {
		const CHILD_A = "Render the opening cut";
		const CHILD_B = "Render the closing cut";
		const harness = createSession();
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		vi.spyOn(reflectionModule, "captureReworkReflection").mockResolvedValue({ answer: "Change the approach." });
		const tool = await TaskTool.create(harness.session);
		await tool.execute("seed", { name: OWNER, task: ROW });
		harness.setPhases(exhaustedPhase());
		const select = vi.fn(async () => "Approve");
		const wrapped = wrapTask(tool, harness.session, select);
		const refused = await wrapped.execute("top-rung", {
			name: OWNER,
			task: ROW,
			rework: "The final result is wrong.",
		});
		expect(text(refused)).toContain("op=append");
		expect(refused.details?.results).toEqual([]);
		const split = applyOpsToPhases(harness.phases(), [
			{ op: "append", phase: "Video craft", items: [CHILD_A, CHILD_B] },
			{ op: "drop", task: ROW },
		]);
		expect(split.errors).toEqual([]);
		harness.setPhases(split.phases);
		const child = await wrapped.execute("child-a", { name: "ChildOne", task: CHILD_A });
		expect(child.details?.results).toHaveLength(1);
		expect(run).toHaveBeenCalledTimes(2);
		expect(select).not.toHaveBeenCalled();
	});

	it("rejects mixed exhausted recovery before reflection or any dispatch", async () => {
		const harness = createSession(exhaustedPhase());
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const reflection = vi
			.spyOn(reflectionModule, "captureReworkReflection")
			.mockResolvedValue({ answer: "No launch expected." });
		const tool = await TaskTool.create(harness.session);
		const params = {
			context: "Shared work",
			tasks: [
				{ name: "FreshWorker", task: ROW },
				{ name: OWNER, task: ROW, rework: "Incorrect result." },
			],
		};
		const select = vi.fn(async () => "Approve");
		const mixedResult = await wrapTask(tool, harness.session, select).execute("mixed", params);
		expect(text(mixedResult)).toContain("op=append");
		expect(mixedResult.details?.results).toEqual([]);
		expect((await tool.execute("direct-mixed", params)).details?.results).toEqual([]);
		expect(select).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(reflection).not.toHaveBeenCalled();
	});

	it("re-dispatches an infrastructure failure on ordinary selection without spending its vendor", async () => {
		const existing = [
			attempt(MODEL, 1, {
				attemptId: `${OWNER}:100`,
				terminalStatus: "failed",
				rejectionReason: undefined,
				infraFailureError: "HTTP 402 payment required",
				infraFailureLine: "attempt 1 failed: HTTP 402 payment required",
			}),
		];
		const harness = createSession(seededPhase("failed", existing));
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);

		const result = await tool.execute("retry", {
			agent: "task",
			name: OWNER,
			task: "Retry the render.",
		} as TaskParams);

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]![0].modelOverride).toEqual(CHAIN);
		expect(run.mock.calls[0]![0].exactThinkingLevel).toBeUndefined();
		expect(run.mock.calls[0]![0].context).toBe("attempt 1 failed: HTTP 402 payment required");
		expect(text(result)).not.toContain("Previous attempts:");
		expect(harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory).toEqual(existing);
	});

	it("moves a model-attributable failure to the next untried vendor, counting all attempts", async () => {
		const history = [
			attempt(OPENAI, 1, { terminalStatus: "failed", rejectionReason: undefined, infraFailureError: "no report" }),
			attempt(XAI, 2, {
				terminalStatus: "failed",
				rejectionReason: undefined,
				infraFailureError: "429 rate limit",
				infraFailureLine: "attempt 2 failed: 429 rate limit",
			}),
		];
		// The current (third) attempt failed on anthropic with a model fault; xai only hit a rate limit.
		const phases = seededPhase("failed", [
			...history,
			attempt(MODEL, 3, { terminalStatus: "failed", rejectionReason: undefined, infraFailureError: "gave up" }),
		]);
		const harness = createSession(phases);
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);
		await tool.execute("retry", { agent: "task", name: OWNER, task: ROW } as TaskParams);
		expect(run.mock.calls[0]![0].modelOverride).toEqual([XAI]);
	});

	it("blocks a model-attributable failure once every vendor has failed", async () => {
		const failed = (model: string, n: number) =>
			attempt(model, n, { terminalStatus: "failed", rejectionReason: undefined, infraFailureError: "no report" });
		const harness = createSession(
			seededPhase("failed", [failed(OPENAI, 1), failed(MODEL, 2), failed(XAI, 3)], { resolvedModel: XAI }),
		);
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);
		const result = await tool.execute("retry", { agent: "task", name: OWNER, task: ROW } as TaskParams);
		expect(text(result)).toContain("op=append");
		expect(run).not.toHaveBeenCalled();
	});

	it.each(["failed", "aborted"] as const)(
		"leaves a %s attempt re-dispatched under another agent profile on that profile's ordinary routing",
		async outcome => {
			const strongAgent: AgentDefinition = {
				...taskAgent,
				name: "ui-coder-strong",
				model: ["codex-lb/gpt-6.1-sol:high"],
			};
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [taskAgent, strongAgent],
				projectAgentsDir: null,
			});
			const harness = createSession(seededPhase(outcome, [], { resolvedModel: OPENAI, thinkingLevel: "max" }));
			const run = vi
				.spyOn(executorModule, "runSubprocess")
				.mockImplementation(async options => makeResult(options.id ?? OWNER));
			const tool = await TaskTool.create(harness.session);
			await tool.execute("strong-retry", { agent: strongAgent.name, name: OWNER, task: ROW });
			expect(run).toHaveBeenCalledTimes(1);
			expect(run.mock.calls[0]![0].modelOverride).toEqual(["codex-lb/gpt-6.1-sol:high"]);
			expect(run.mock.calls[0]![0].context).toContain(`failed: ${outcome}`);
			expect(harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory).toEqual([]);
		},
	);

	it("re-dispatches completed rework on a fresh worker at the next vendor with the rejection context", async () => {
		const harness = createSession();
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const followUp = vi
			.spyOn(executorModule, "runSubagentFollowUpTurn")
			.mockImplementation(async options => makeResult(options.id, { output: "Use a simpler cut path." }));
		const tool = await TaskTool.create(harness.session);

		const first = await tool.execute("ordinary-first", {
			agent: "task",
			name: OWNER,
			task: "Render the cut.",
		} as TaskParams);
		expect(first.details?.results[0]?.id).toBe(OWNER);
		expect(run).toHaveBeenCalledTimes(1);
		expect(text(first)).not.toContain("Previous attempts:");
		expect(run.mock.calls[0]![0].context).toBeUndefined();

		harness.setPhases(seededPhase("completed", [], { resolvedModel: OPENAI }));
		const rework = await tool.execute("rework", {
			agent: "task",
			name: OWNER,
			task: "Improve the render.",
			rework: "The motion blur obscures the subject.",
		} as TaskParams);
		const reflection = followUp.mock.calls[0]![0];
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(reflection.id).toBe(OWNER);
		expect(reflection.message).toContain(
			"What was wrong with your approach, and what should the next attempt do differently?",
		);
		expect(reflection.message).toContain(
			"The chief rejected your completed attempt: The motion blur obscures the subject.",
		);
		expect(reflection.message).toContain('answer exactly: "Is there a much simpler different way?"');
		expect(run).toHaveBeenCalledTimes(2);
		const redispatch = run.mock.calls[1]![0];
		expect(redispatch.modelOverride).toEqual([MODEL]);
		expect(redispatch.exactThinkingLevel).toBeUndefined();
		expect(redispatch.context).toContain("Previous attempts:");
		expect(redispatch.context).toContain("Rejection reason: The motion blur obscures the subject.");
		expect(rework.details?.results[0]?.resolvedModelIdentity).toBe(MODEL);
		expect(harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory?.[0]?.rejectionReason).toBe(
			"The motion blur obscures the subject.",
		);
	});
	it("continues a completed phase normally while rejecting invalid explicit rework reasons", async () => {
		const harness = createSession(seededPhase("completed"));
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);

		const missing = await tool.execute("missing-reason", {
			agent: "task",
			name: OWNER,
			task: "Improve the cut.",
		} as TaskParams);
		const multiline = await tool.execute("multiline-reason", {
			agent: "task",
			name: OWNER,
			task: "Improve the cut.",
			rework: "first line\nsecond line",
		} as TaskParams);
		const blank = await tool.execute("blank-reason", {
			agent: "task",
			name: OWNER,
			task: "Improve the cut.",
			rework: " \t",
		} as TaskParams);

		expect(missing.details?.results?.[0]?.exitCode).toBe(0);
		expect(blank.details?.results?.[0]?.exitCode).toBe(0);
		expect(text(blank)).not.toContain("requires a one-line");
		expect(text(multiline)).toContain("requires a one-line");
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("passes the prior report paragraph when reflection has no answer", async () => {
		const harness = createSession();
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		vi.spyOn(reflectionModule, "captureReworkReflection").mockResolvedValue({
			noAnswerReason: "worker returned no reflection answer",
		});
		const tool = await TaskTool.create(harness.session);

		await tool.execute("first", { agent: "task", name: OWNER, task: "Render the cut." } as TaskParams);
		harness.setPhases(
			seededPhase("completed", [], {
				owner: OWNER,
				workerId: OWNER,
				startedAt: 100,
				finishedAt: 200,
				resolvedModel: MODEL,
				thinkingLevel: "medium",
			}),
		);
		await tool.execute("rework", {
			agent: "task",
			name: OWNER,
			task: "Improve the cut.",
			rework: "The crop still hides the subject.",
		} as TaskParams);

		const message = run.mock.calls[1]![0].context ?? "";
		expect(message).toContain("Worker reflection: no answer (worker returned no reflection answer)");
		expect(message).toContain("Final report paragraph: Final report paragraph.");
		expect(message).toContain("Rejection reason: The crop still hides the subject.");
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("replays ordered rejections durably and gates the final rung after restart", async () => {
		const harness = createSession();
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
			agent: "task",
			name: OWNER,
			task: "Seed the previous worker session.",
		} as TaskParams);
		const firstWorkerId = seed.details?.results[0]?.id ?? OWNER;
		const now = Date.now();
		const neighborHistory = [
			{
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
			},
		];
		const base = seededPhase(
			"completed",
			[
				{
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
				},
			],
			{
				owner: firstWorkerId,
				workerId: firstWorkerId,
				startedAt: 300,
				finishedAt: 400,
				resolvedModel: MODEL,
				thinkingLevel: "high",
			},
		);
		base[0]!.tasks.push({
			content: "Unrelated neighboring row",
			status: "completed",
			schedule: { attemptHistory: neighborHistory },
		});
		harness.setPhases(base);
		harness.edits.length = 0;

		const third = await tool.execute("third-dispatch", {
			agent: "task",
			name: firstWorkerId,
			task: "Improve the cut again.",
			rework: "Second rejection.",
		} as TaskParams);
		const thirdDispatch = run.mock.calls[1]![0];
		const previousAttempts = thirdDispatch.context ?? "";
		const firstReason = previousAttempts.indexOf("First rejection.");
		const secondReason = previousAttempts.indexOf("Second rejection.");
		expect(thirdDispatch.modelOverride).toEqual([OPENAI]);
		expect(thirdDispatch.exactThinkingLevel).toBeUndefined();
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
		const replayEntries = [
			snapshot,
			...harness.edits.map(
				(edit, index) =>
					({
						type: "custom" as const,
						customType: USER_TODO_EDIT_CUSTOM_TYPE,
						data: { edit },
						id: `edit-${index}`,
						parentId: index === 0 ? "snapshot" : `edit-${index - 1}`,
						timestamp: new Date(now + index + 1).toISOString(),
					}) as SessionEntry,
			),
		];
		expect(getLatestTodoPhasesFromEntries(replayEntries)).toEqual(harness.phases());

		const thirdWorkerId = third.details?.results[0]?.id ?? firstWorkerId;
		harness.setPhases(
			seededPhase("completed", [...harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory!, attempt(XAI, 9)], {
				owner: thirdWorkerId,
				workerId: thirdWorkerId,
				startedAt: 500,
				finishedAt: 600,
				resolvedModel: OPENAI,
				thinkingLevel: "medium",
			}),
		);
		const topParams = {
			agent: "task",
			name: thirdWorkerId,
			task: "Improve the cut once more.",
			rework: "Third rejection.",
		};
		const select = vi.fn(async () => "Approve");
		const topRung = await wrapTask(tool, harness.session, select).execute("top-rung", topParams);
		expect(text(topRung)).toContain("op=append");
		expect(topRung.details?.results).toEqual([]);
		expect(select).not.toHaveBeenCalled();
		const history = harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory!;
		expect(history.map(attempt => attempt.rejectionReason)).toEqual([
			"First rejection.",
			"Second rejection.",
			"Rejection 9.",
		]);
		expect(history[0]).toEqual(base[0]!.tasks[0]!.schedule!.attemptHistory![0]);
		expect(new Set(history.map(attempt => attempt.attemptId)).size).toBe(3);
		expect(run).toHaveBeenCalledTimes(2);
		const restoredHarness = createSession(structuredClone(harness.phases()));
		const restored = await TaskTool.create(restoredHarness.session);
		const afterRestart = await wrapTask(restored, restoredHarness.session, async () => "Deny").execute(
			"after-restart",
			topParams,
		);
		expect(text(afterRestart)).toContain("op=append");
		expect(afterRestart.details?.results).toEqual([]);
		expect(restoredHarness.phases()[0]!.tasks[0]!.schedule!.attemptHistory).toEqual(history);
		expect(run).toHaveBeenCalledTimes(2);
	});
});
