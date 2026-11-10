import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";

const ROW = "Build source-bound evidence";
const PRODUCER = "BuildEvidence";
const AUDITOR = "AuditEvidence";
const history = [
	{
		attemptId: "admission:BuildEvidence:10:0",
		workerName: PRODUCER,
		resolvedModel: "unresolved",
		effort: "unresolved",
		startedAt: 10,
		finishedAt: 10,
		durationMs: 0,
		terminalStatus: "failed" as const,
		deliverablePaths: [],
		infraFailureError: "resources exceed the declared row scope",
		infraFailureLine: "infra failure: resources exceed the declared row scope",
	},
];
afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

test("failed producer admission must not rename a new QA role as another producer attempt", async () => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: ["task", "qa-auditor"].map(name => ({
			name,
			description: name,
			systemPrompt: "Isolated fixture.",
			source: "bundled" as const,
			model: ["openai/gpt-5"],
		})),
		projectAgentsDir: null,
	});
	const calls: Array<{ id: string; agent: string }> = [];
	vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
		const id = options.id ?? "missing";
		calls.push({ id, agent: options.agent.name });
		return {
			index: 0,
			id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: ROW,
			assignment: "fixture",
			exitCode: 0,
			output: "Fixture done.",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
			resolvedModel: "openai/gpt-5",
			resolvedModelIdentity: "openai/gpt-5",
		};
	});
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-audit-name-fixture-"));
	const disposers: Array<() => void> = [];
	async function run(name: string, agent: string, withHistory: boolean, readOnly = agent === "qa-auditor") {
		let phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{
						content: ROW,
						status: "pending",
						schedule: { dependencies: [], attemptHistory: withHistory ? history : [] },
					},
				],
			},
		];
		const bus = new EventBus();
		const session = {
			cwd: dir,
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": false, "tools.approvalMode": "yolo" }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			eventBus: bus,
			subagentEventBus: bus,
			getTodoPhases: () => phases,
			setTodoPhases: (next: TodoPhase[]) => {
				phases = next;
			},
			persistTodoPhases: () => {},
			getArtifactsDir: () => dir,
			registerDisposeCallback: (cb: () => void) => disposers.push(cb),
		} as unknown as ToolSession;
		const tool = await TaskTool.create(session);
		const before = calls.length;
		const result = await tool.execute(`fixture-${name}-${withHistory}`, {
			name,
			agent,
			row: ROW,
			task: "Run isolated fixture.",
			readOnly,
		} as TaskParams);
		if (calls.length !== before + 1)
			throw new Error(`Expected one executor call, got ${calls.length - before}: ${JSON.stringify(result)}`);
		expect(calls.at(-1)!.agent).toBe(agent);
		return calls.at(-1)!.id;
	}
	try {
		expect(await run(AUDITOR, "qa-auditor", false)).toBe(AUDITOR);
		expect(await run(PRODUCER, "task", true)).toBe("BuildEvidence-2");
		expect(await run("RenamedProducer", "task", true)).toBe("BuildEvidence-2");
		// A producer retry stays in its lineage; the newly requested QA role is not one.
		expect(await run(AUDITOR, "qa-auditor", true)).toMatch(/^AuditEvidence(?:-\d+)?$/);
		expect(await run(AUDITOR, "qa-auditor", true, false)).toMatch(/^AuditEvidence(?:-\d+)?$/);
	} finally {
		for (const cb of disposers) cb();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("constructing the SDK advisor toolset must not journal one worker activity twice", async () => {
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
	const bus = new EventBus();
	const dispose: Array<() => void> = [];
	const notes: Array<{ kind: string; data: unknown }> = [];
	const primary = {
		cwd: "/tmp/ugolyok-omp-regression-evidence-20261110/isolated-discovery-fixture",
		settings: Settings.isolated({ "async.enabled": true }),
		eventBus: bus,
		subagentEventBus: bus,
		getSessionId: () => "primary",
		getAgentId: () => "main",
		getTodoPhases: () => [],
		setTodoPhases: () => {},
		persistTodoPhases: () => {},
		registerDisposeCallback: (callback: () => void) => dispose.push(callback),
		sessionManager: {
			appendCustomEntry: (kind: string, data: unknown) => notes.push({ kind, data }),
		},
	} as unknown as ToolSession;
	const emit = (at: number) =>
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "ExistingWorker",
			agent: "task",
			status: "started",
			followUpTurn: true,
			at,
		});
	const expected = (at: number) => [
		{
			kind: "task_worker_activity",
			data: {
				workerId: "ExistingWorker",
				status: "started",
				at,
				taskText: undefined,
			},
		},
	];
	try {
		await TaskTool.create(primary);
		emit(100);
		expect(notes).toEqual(expected(100));
		notes.length = 0;
		// sdk.ts creates every built-in for its advisor by spreading the primary
		// ToolSession, overriding identity but sharing bus, journal and TODO hooks.
		const advisor: ToolSession = {
			...primary,
			getSessionId: () => "primary-advisor",
			getAgentId: () => "advisor",
		};
		await TaskTool.create(advisor);
		emit(200);
		expect(notes).toEqual(expected(200));
	} finally {
		for (const callback of dispose) callback();
		notes.length = 0;
		emit(300);
		expect(notes).toEqual([]);
	}
});

test("reinitialization retains every worker and independent journal, and cleanup hands recording to a remaining tool", async () => {
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
	const bus = new EventBus();
	const records: unknown[][] = [[], []];
	const disposers: Array<() => void> = [];
	function session(index: number): ToolSession {
		return {
			cwd: "/tmp/harness-lifecycle-independent",
			settings: Settings.isolated({}),
			eventBus: bus,
			subagentEventBus: bus,
			getTodoPhases: () => [],
			setTodoPhases: () => {},
			persistTodoPhases: () => {},
			registerDisposeCallback: (callback: () => void) => disposers.push(callback),
			sessionManager: { appendCustomEntry: (_kind: string, data: unknown) => records[index]!.push(data) },
		} as unknown as ToolSession;
	}
	const primary = session(0);
	const emit = (id: string, at: number) =>
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: "task",
			status: "started",
			followUpTurn: true,
			at,
		});
	try {
		await TaskTool.create(primary);
		await TaskTool.create(primary);
		await TaskTool.create({ ...primary, getAgentId: () => "advisor" });
		await TaskTool.create(session(1));
		emit("FirstWorker", 1);
		emit("SecondWorker", 1);
		const expected = ["FirstWorker", "SecondWorker"].map(workerId => ({
			workerId,
			status: "started",
			at: 1,
			taskText: undefined,
		}));
		expect(records[0]).toEqual(expected);
		expect(records[1]).toEqual(expected);
		disposers[0]!();
		emit("FirstWorker", 2);
		expect(records[0]).toEqual([
			...expected,
			{ workerId: "FirstWorker", status: "started", at: 2, taskText: undefined },
		]);
		for (const dispose of disposers) dispose();
		emit("AfterCleanup", 3);
		expect(records.map(record => record.length)).toEqual([3, 3]);
		await TaskTool.create(primary);
		emit("AfterRebuild", 4);
		expect(records[0]!.at(-1)).toEqual({ workerId: "AfterRebuild", status: "started", at: 4, taskText: undefined });
		expect(records[1]).toHaveLength(3);
	} finally {
		for (const dispose of disposers) dispose();
	}
});
