import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { reserveRestoringAgents } from "@oh-my-pi/pi-coding-agent/registry/restoring-agents";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { createRouterState, routeSubagentSpawn } from "./agent_router";
import { holdsWriteCustody, workerToolPreflight } from "./dispatch_preflight";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

async function fixture(maxConcurrency = 2) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-admission-"));
	const stateFile = path.join(dir, "router.jsonl");
	const target = path.join(dir, "shared.ts");
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "Holder", status: "in_progress", schedule: { owner: "Holder-1", resources: [target] } },
				{ content: "Captures", status: "pending", schedule: {} },
				{ content: "Independent", status: "pending", schedule: {} },
			],
		},
	];
	const state = createRouterState();
	const ctx = {
		cwd: dir,
		getTodoPhases: () => phases,
		updateTodoSchedule: (title, update) => {
			const row = phases[0].tasks.find(row => row.content === title)!;
			row.schedule = { ...row.schedule, ...update };
			return true;
		},
	} as ExtensionContext;
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	cleanups.push(async () => {
		await jobs.dispose({ timeoutMs: 1000 });
		await fs.rm(dir, { recursive: true, force: true });
	});
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [
			{ name: "task", description: "Task", systemPrompt: "Task", source: "bundled" },
			{
				name: "qa-auditor",
				description: "Audit",
				systemPrompt: "Audit",
				source: "bundled",
				tools: ["read", "bash"],
			},
			{ name: "observer", description: "Read", systemPrompt: "Read", source: "bundled", tools: ["read", "grep"] },
		],
		projectAgentsDir: null,
	});
	const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => ({
		index: options.index,
		id: options.id,
		agent: "task",
		agentSource: "bundled",
		task: "work",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	}));
	const eventBus = new EventBus();
	const session = {
		eventBus,
		subagentEventBus: eventBus,
		sessionManager: SessionManager.inMemory(dir),
		cwd: dir,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true, "task.maxConcurrency": maxConcurrency }),
		getSessionFile: () => null,
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases.splice(0, phases.length, ...next);
		},
		persistTodoPhases: () => {},
		getSessionSpawns: () => "*",
		asyncJobManager: jobs,
		emitBeforeSubagentSpawn: async event => routeSubagentSpawn(event, ctx, state, { stateFile }),
	} as ToolSession;
	const tool = await TaskTool.create(session);
	const items = [
		{ name: "PrCaptures", agent: "task", row: "Captures", task: `Captures\nWrite ${target}` },
		{
			name: "Independent",
			agent: "task",
			row: "Independent",
			task: `Independent\nWrite ${path.join(dir, "independent.ts")}`,
		},
	];
	return { dir, target, phases, state, jobs, run, session, tool, items, ctx, eventBus };
}

test("duplicate batch writers cannot overwrite one exact row or both enter worker execution", async () => {
	const f = await fixture();
	f.phases[0]!.tasks[0]!.status = "completed";
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const started: string[] = [];
	const run = f.run.getMockImplementation()!;
	f.run.mockImplementation(async options => {
		started.push(options.id);
		entered.resolve();
		await release.promise;
		return run(options);
	});
	try {
		const result = await f.tool.execute("duplicates", {
			context: "same exact row",
			tasks: [
				{ name: "ProduceEvidence", agent: "task", row: "Captures", task: "Captures", resources: [f.target] },
				{ name: "ProduceEvidenceAgain", agent: "task", row: "Captures", task: "Captures", resources: [f.target] },
			],
		});
		await entered.promise;
		expect(started.length).toBeLessThanOrEqual(1);
		expect(started).toEqual(["ProduceEvidence"]);
		expect(JSON.stringify(result.content)).toContain("reserved by ProduceEvidence");
		expect(f.phases[0]!.tasks[1]!.schedule?.owner).toBe("ProduceEvidence");
		expect(f.phases[0]!.tasks[1]!.schedule?.attemptHistory ?? []).toEqual([]);
	} finally {
		release.resolve();
		await f.jobs.waitForAll();
	}
});

test("parallel calls and rebuilt TaskTools reserve the same journal row before an admission hook yields", async () => {
	const f = await fixture();
	f.phases[0]!.tasks[0]!.status = "completed";
	const secondTool = await TaskTool.create({ ...f.session });
	const admitting = Promise.withResolvers<void>();
	const releaseAdmission = Promise.withResolvers<void>();
	const emit = f.session.emitBeforeSubagentSpawn!;
	let first = true;
	f.session.emitBeforeSubagentSpawn = async (event, signal) => {
		if (first) {
			first = false;
			admitting.resolve();
			await releaseAdmission.promise;
		}
		return emit(event, signal);
	};
	const spawn = { name: "First", agent: "task", row: "Captures", task: "Captures", resources: [f.target] };
	const pending = f.tool.execute("first-call", { context: "same journal", tasks: [spawn] });
	try {
		await admitting.promise;
		const duplicate = await secondTool.execute("other-call", {
			context: "same journal",
			tasks: [{ ...spawn, name: "Second" }],
		});
		expect(duplicate.isError).toBe(true);
		expect(JSON.stringify(duplicate.content)).toContain("reserved by First");
		expect(f.run).not.toHaveBeenCalled();
	} finally {
		releaseAdmission.resolve();
		await pending;
		await f.jobs.waitForAll();
	}
	expect(f.run).toHaveBeenCalledTimes(1);
});

for (const change of ["completed", "abandoned", "removed", "reassigned"] as const)
	test(`capacity-queued row ${change} never starts and releases its permit`, async () => {
		const f = await fixture(1);
		f.phases[0]!.tasks[0]!.status = "completed";
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const started: string[] = [];
		const run = f.run.getMockImplementation()!;
		f.run.mockImplementation(async options => {
			started.push(options.id);
			if (options.id === "PrCaptures") {
				entered.resolve();
				await release.promise;
			}
			return run(options);
		});
		try {
			await f.tool.execute("queued", { context: "independent rows", tasks: f.items });
			await entered.promise;
			expect(started).toEqual(["PrCaptures"]);
			const obsolete = f.phases[0]!.tasks[2]!;
			if (change === "removed") f.phases[0]!.tasks.splice(2, 1);
			else if (change === "reassigned") obsolete.schedule!.owner = "Replacement";
			else obsolete.status = change;
			release.resolve();
			await f.jobs.waitForAll();
			expect(started).toEqual(["PrCaptures"]);
			expect(f.jobs.getJob("Independent")?.status).toBe("failed");
			if (change === "reassigned") expect(f.phases[0]!.tasks[2]!.schedule?.owner).toBe("Replacement");
			// A following independent row still acquires the only permit.
			f.phases[0]!.tasks.push({ content: "Neighbor", status: "pending", schedule: {} });
			await f.tool.execute("neighbor", {
				context: "valid row",
				tasks: [
					{ name: "Neighbor", row: "Neighbor", task: "Neighbor", resources: [path.join(f.dir, "neighbor.ts")] },
				],
			});
			await f.jobs.waitForAll();
			expect(started).toEqual(["PrCaptures", "Neighbor"]);
		} finally {
			release.resolve();
			await f.jobs.waitForAll();
		}
	});

test("independent writer rows occupy both available slots concurrently", async () => {
	const f = await fixture(2);
	f.phases[0]!.tasks[0]!.status = "completed";
	const bothEntered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const started: string[] = [];
	const run = f.run.getMockImplementation()!;
	f.run.mockImplementation(async options => {
		started.push(options.id);
		if (started.length === 2) bothEntered.resolve();
		await release.promise;
		return run(options);
	});
	try {
		await f.tool.execute("parallel", { context: "disjoint resources", tasks: f.items });
		await bothEntered.promise;
		expect(started.sort()).toEqual(["Independent", "PrCaptures"]);
	} finally {
		release.resolve();
		await f.jobs.waitForAll();
	}
});

for (const failure of ["admission", "registration"] as const)
	test(`${failure} failure rolls back its unstarted row claim and allows a retry`, async () => {
		const f = await fixture();
		f.phases[0]!.tasks[0]!.status = "completed";
		if (failure === "registration")
			vi.spyOn(f.jobs, "register").mockImplementationOnce(() => {
				throw new Error("registration failed");
			});
		else {
			const emit = f.session.emitBeforeSubagentSpawn!;
			vi.spyOn(f.session, "emitBeforeSubagentSpawn").mockImplementationOnce(async (event, signal) => {
				await emit(event, signal);
				throw new Error("admission failed");
			});
		}
		await f.tool.execute("fail", { context: "rollback", tasks: [{ ...f.items[0], resources: [f.target] }] });
		expect(f.run).not.toHaveBeenCalled();
		expect(f.phases[0]!.tasks[1]!.schedule?.owner).toBeUndefined();
		expect(f.phases[0]!.tasks[1]!.schedule?.resources).toBeUndefined();
		await f.tool.execute("retry", { context: "same row", tasks: [{ ...f.items[0], resources: [f.target] }] });
		await f.jobs.waitForAll();
		expect(f.run).toHaveBeenCalledTimes(1);
	});

for (const activity of ["running", "restoring"] as const)
	test(`${activity} current owner keeps custody over stale historical failure, then settled idle releases it`, async () => {
		const f = await fixture();
		const row = f.phases[0]!.tasks[0]!;
		row.schedule!.executor = { workerId: "Holder-1", startedAt: 1, finishedAt: 2, outcome: "failed" };
		const registry = new AgentRegistry();
		vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: { activeToolExecutionUpdates() {}, getTodoPhases: () => f.phases } as never,
		});
		registry.register({
			id: "Holder-1",
			displayName: "Holder-1",
			kind: "sub",
			parentId: "Main",
			status: activity === "running" ? "running" : "parked",
			session: activity === "running" ? ({ isStreaming: true, activeToolExecutionUpdates() {} } as never) : null,
		});
		const releaseRestore =
			activity === "restoring" ? reserveRestoringAgents(registry, [{ id: "Holder-1", parentId: "Main" }]) : () => {};
		const worker = { cwd: f.dir, agent: { id: "Holder-1", parentId: "Main", kind: "sub" } } as ExtensionContext;
		try {
			f.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "Holder-1",
				agent: "task",
				status: "started",
				followUpTurn: true,
				at: Date.now(),
				taskText: "Continue Holder work",
			});
			expect(holdsWriteCustody(row)).toBe(true);
			expect(await workerToolPreflight({ toolName: "edit", input: { path: f.target } }, worker)).toBeUndefined();
			expect(
				(await workerToolPreflight({ toolName: "edit", input: { path: path.join(f.dir, "sibling.ts") } }, worker))
					?.block,
			).toBe(true);
			await f.tool.execute("challenger", { context: "shared output", tasks: [f.items[0]] });
			expect(f.phases[0]!.tasks[1]!.schedule?.resourceWait?.workerId).toBe("Holder-1");
			expect(f.run).not.toHaveBeenCalled();
			releaseRestore("Holder-1");
			registry.setStatus("Holder-1", "idle");
			expect(holdsWriteCustody(row)).toBe(false);
			expect((await workerToolPreflight({ toolName: "edit", input: { path: f.target } }, worker))?.block).toBe(true);
			await f.jobs.waitForAll();
			expect(f.run).toHaveBeenCalledTimes(1);
		} finally {
			releaseRestore("Holder-1");
		}
	});

test("a running historical executor with a different current row cannot regain its old write scope", async () => {
	const f = await fixture();
	const row = f.phases[0]!.tasks[0]!;
	row.schedule!.executor = { workerId: "Holder-1", startedAt: 1, finishedAt: 2, outcome: "failed" };
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({
		id: "Main",
		displayName: "Main",
		kind: "main",
		session: { activeToolExecutionUpdates() {}, getTodoPhases: () => f.phases } as never,
	});
	registry.register({
		id: "Holder-1",
		displayName: "Holder-1",
		kind: "sub",
		parentId: "Main",
		status: "running",
		session: { isStreaming: true, activeToolExecutionUpdates() {} } as never,
	});
	registry.setTodoRow("Holder-1", "A different assignment");
	expect(holdsWriteCustody(row)).toBe(false);
	for (const target of [f.target, path.join(f.dir, "sibling.ts")])
		expect(
			(
				await workerToolPreflight({ toolName: "write", input: { path: target } }, {
					cwd: f.dir,
					agent: { id: "Holder-1", parentId: "Main", kind: "sub" },
				} as ExtensionContext)
			)?.block,
		).toBe(true);
});

test("a row closed while admission yields never enters worker execution", async () => {
	const f = await fixture();
	f.phases[0]!.tasks[0]!.status = "completed";
	const emit = f.session.emitBeforeSubagentSpawn!;
	f.session.emitBeforeSubagentSpawn = async (event, signal) => {
		const result = await emit(event, signal);
		f.phases[0]!.tasks[1]!.status = "completed";
		return result;
	};
	const result = await f.tool.execute("closing-admission", { context: "current row", tasks: [f.items[0]] });
	await f.jobs.waitForAll();
	expect(result.isError).toBe(true);
	expect(f.run).not.toHaveBeenCalled();
	expect(f.jobs.getJob("PrCaptures")).toBeUndefined();
});
