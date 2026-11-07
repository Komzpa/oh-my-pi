import { todoWorkAttempts } from "@oh-my-pi/pi-tui/tools/todo-schedule";
/** Ordinary-routing regression coverage: completed rows without a real rework reason dispatch normally. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";
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

function completedPhase(missing: readonly string[] = []): TodoPhase[] {
	const executor: Record<string, unknown> = {
		workerId: OWNER,
		agentProfile: "task",
		startedAt: 100,
		finishedAt: 200,
		outcome: "completed",
		resolvedModel: MODEL,
		thinkingLevel: "medium",
	};
	for (const key of missing) delete executor[key];
	return [
		{
			name: "Video craft",
			tasks: [
				{
					content: ROW,
					status: "in_progress",
					schedule: {
						dependencies: [],
						owner: OWNER,
						executor: executor as unknown as TodoSchedule["executor"],
					},
				},
			],
		},
	];
}
function createSession(initial: TodoPhase[]): { session: ToolSession; phases: () => TodoPhase[] } {
	let current = initial;
	const bus = new EventBus();
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "tools.approvalMode": "yolo" }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		eventBus: bus,
		subagentEventBus: bus,
		getTodoPhases: () => current,
		setTodoPhases: (next: TodoPhase[]) => {
			current = next;
		},
		persistTodoPhases: () => {},
		getArtifactsDir: () => "/tmp",
	} as unknown as ToolSession;
	return { session, phases: () => current };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("task ordinary routing without a rework reason", () => {
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

	it("treats a blank rework reason on a completed row as ordinary routing", async () => {
		const harness = createSession(completedPhase());
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);

		const result = await tool.execute("blank-rework", {
			agent: "task",
			name: OWNER,
			task: "Improve the cut.",
			rework: " \t",
		} as TaskParams);

		expect(run).toHaveBeenCalledTimes(1);
		expect(result.details?.results?.[0]?.exitCode).toBe(0);
		expect(text(result)).not.toContain("requires a one-line");
	});

	it("dispatches a completed row with missing model and effort ordinarily when no rework is requested", async () => {
		const harness = createSession(completedPhase(["resolvedModel", "thinkingLevel"]));
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);

		const result = await tool.execute("missing-model", {
			agent: "task",
			name: OWNER,
			task: "Improve the cut.",
		} as TaskParams);

		expect(run).toHaveBeenCalledTimes(1);
		expect(result.details?.results?.[0]?.exitCode).toBe(0);
		expect(text(result)).not.toContain("Cannot redispatch");
	});

	it("retries a worker that failed before any model ran with ordinary routing", async () => {
		const phases = completedPhase();
		const executor = phases[0]!.tasks[0]!.schedule!.executor!;
		executor.outcome = "failed";
		delete executor.resolvedModel;
		delete executor.thinkingLevel;
		const harness = createSession(phases);
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? OWNER));
		const tool = await TaskTool.create(harness.session);

		const result = await tool.execute("failed-missing-model", {
			agent: "task",
			name: OWNER,
			task: "Retry the cut.",
		} as TaskParams);

		expect(run).toHaveBeenCalledTimes(1);
		expect(result.details?.results?.[0]?.exitCode).toBe(0);
		expect(text(result)).not.toContain("Cannot redispatch");
	});
	it("short harness deaths trip the durable row breaker without spending a model work attempt", async () => {
		const phases = completedPhase();
		delete phases[0]!.tasks[0]!.schedule!.executor;
		const harness = createSession(phases);
		const notices: string[] = [];
		harness.session.steer = message => {
			notices.push(message.content);
		};
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.subagentEventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: options.id,
				agent: "task",
				row: ROW,
				taskText: ROW,
				status: "started",
				at: Date.now(),
			});
			return makeResult(options.id ?? OWNER, {
				exitCode: 1,
				error: "harness resource conflict: holder AuditPower",
				durationMs: 47,
			});
		});
		const tool = await TaskTool.create(harness.session);
		for (let i = 0; i < 3; i++)
			await tool.execute(`death-${i}`, {
				agent: "task",
				name: harness.phases()[0]!.tasks[0]!.schedule!.owner,
				row: ROW,
				task: ROW,
			});
		const row = harness.phases()[0]!.tasks[0]!;
		expect(row).toMatchObject({ status: "blocked" });
		expect(todoWorkAttempts(row.schedule!.attemptHistory)).toHaveLength(0);
		expect(row.schedule!.attemptHistory).toHaveLength(3);
		expect(notices).toHaveLength(1);
		await tool.execute("fourth", { agent: "task", name: row.schedule!.owner, row: ROW, task: ROW });
		expect(run).toHaveBeenCalledTimes(3);
	});
});
