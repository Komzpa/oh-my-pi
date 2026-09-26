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
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
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

function createSession(initial: TodoPhase[] = []): { session: ToolSession; phases: () => TodoPhase[]; setPhases: (value: TodoPhase[]) => void } {
	let current = initial;
	const bus = new EventBus();
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.reworkLadder": [":high"] }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		eventBus: bus,
		subagentEventBus: bus,
		getTodoPhases: () => current,
		setTodoPhases: (next: TodoPhase[]) => { current = next; },
		persistTodoPhases: () => {},
		getArtifactsDir: () => "/tmp",
	} as unknown as ToolSession;
	return { session, phases: () => current, setPhases: value => { current = value; } };
}

function seededPhase(outcome: "failed" | "aborted" | "completed", history: NonNullable<TodoPhase["tasks"][number]["schedule"]>["attemptHistory"] = []): TodoPhase[] {
	return [{
		name: "Video craft",
		tasks: [{
			content: ROW,
			status: "in_progress",
			schedule: {
				dependencies: [],
				owner: OWNER,
				executor: {
					workerId: OWNER,
					agentProfile: "task",
					startedAt: 100,
					finishedAt: 200,
					outcome,
					resolvedModel: MODEL,
					thinkingLevel: "medium",
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

	it("advances completed rework on the same session and keeps ordinary rows on ordinary routing", async () => {
		const harness = createSession();
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? OWNER));
		vi.spyOn(reflectionModule, "captureReworkReflection").mockResolvedValue({ answer: "Use a simpler cut path." });
		const tool = await TaskTool.create(harness.session);

		const first = await tool.execute("ordinary-first", { agent: "task", name: OWNER, task: "Render the cut." } as TaskParams);
		const firstRecord = first.details?.results[0];
		expect(firstRecord?.id).toBe(OWNER);
		expect(run.mock.calls[0]![0].assignment).toContain("Is there a much simpler different way?");
		expect(run.mock.calls[0]![0].context).toBeUndefined();
		expect(text(first)).not.toContain("Previous attempts:");

		harness.setPhases(seededPhase("completed"));
		const rework = await tool.execute("rework", {
			agent: "task", name: OWNER, task: "Improve the render.", rework: "The motion blur obscures the subject.",
		} as TaskParams);

		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[1]![0].id).toBe(OWNER);
		expect(run.mock.calls[1]![0].thinkingLevel).toBe("high");
		expect(run.mock.calls[1]![0].modelOverride).toEqual([MODEL]);
		expect(run.mock.calls[1]![0].context).toContain("Rejection reason: The motion blur obscures the subject.");
		expect(run.mock.calls[1]![0].assignment).toContain("Is there a much simpler different way?");
		expect(text(rework)).toContain("Previous attempts:");
		expect(text(rework)).toContain("Rejection reason: The motion blur obscures the subject.");
		expect(harness.phases()[0]!.tasks[0]!.schedule!.attemptHistory?.[0]?.rejectionReason).toBe("The motion blur obscures the subject.");
	});
});
