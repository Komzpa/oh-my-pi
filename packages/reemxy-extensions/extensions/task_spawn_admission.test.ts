import { todoWorkAttempts } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { type } from "@oh-my-pi/omptype";
import { createRouterState, routeSubagentSpawn } from "./agent_router";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
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
	const session = {
		cwd: dir,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true, "task.maxConcurrency": 1 }),
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
		{ name: "PrCaptures", agent: "task", row: "Captures", task: `Captures\nWrite ${target}`, resources: [target] },
		{
			name: "Independent",
			agent: "task",
			row: "Independent",
			task: `Independent\nWrite ${path.join(dir, "independent.ts")}`,
			resources: [path.join(dir, "independent.ts")],
		},
	];
	return { dir, target, phases, state, jobs, run, session, tool, items };
}

function textOf(result: { content: { type: string; text?: string }[] }) {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

test("conflict queues without an attempt or capacity slot, then runs after release", async () => {
	const f = await fixture();
	const result = await f.tool.execute("mixed", { context: "paths", tasks: f.items });
	expect(result.isError).not.toBe(true);
	expect(result.details?.progress?.find(item => item.id === "PrCaptures")?.stage).toContain("Holder-1");
	expect(f.phases[0].tasks[1].schedule?.resourceWait).toEqual({ row: "Holder", workerId: "Holder-1" });
	await f.jobs.getJob("Independent")!.promise;
	expect(f.run).toHaveBeenCalledTimes(1);
	expect(f.phases[0].tasks[1].schedule?.attemptHistory ?? []).toHaveLength(0);
	f.phases[0].tasks[0].status = "completed";
	await f.jobs.getJob("PrCaptures")!.promise;
	expect(f.run).toHaveBeenCalledTimes(2);
	expect(f.phases[0].tasks[1].schedule?.resourceWait).toBeUndefined();
	expect(f.phases[0].tasks[1].schedule?.attemptHistory ?? []).toHaveLength(0);
});

test("cancelling a resource waiter clears its persisted wait without recording an attempt", async () => {
	const f = await fixture();
	await f.tool.execute("cancel-waiter", { context: "shared path", tasks: [f.items[0]] });
	expect(f.phases[0].tasks[1].schedule?.resourceWait?.workerId).toBe("Holder-1");
	expect(f.jobs.cancel("PrCaptures")).toBe(true);
	await f.jobs.getJob("PrCaptures")!.promise;
	expect(f.phases[0].tasks[1].schedule?.resourceWait).toBeUndefined();
	expect(f.phases[0].tasks[1].schedule?.attemptHistory ?? []).toHaveLength(0);
	expect(f.run).not.toHaveBeenCalled();
});

test("restart while waiting for a resource records an interruption, not a failed work attempt", async () => {
	const f = await fixture();
	await f.tool.execute("restart-waiter", { context: "shared path", tasks: [f.items[0]] });
	expect(f.phases[0].tasks[1].schedule?.resourceWait?.workerId).toBe("Holder-1");
	f.jobs.cancelAll(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
	await f.jobs.waitForAll();
	const row = f.phases[0].tasks[1];
	expect(row.schedule?.resourceWait).toBeUndefined();
	expect(row.schedule?.executor?.outcome).toBe("aborted");
	expect(row.schedule?.attemptHistory).toHaveLength(1);
	expect(row.schedule?.attemptHistory?.[0].interruption).toBe("restart");
	expect(todoWorkAttempts(row.schedule?.attemptHistory)).toHaveLength(0);
	expect(f.run).not.toHaveBeenCalled();
});

for (const streamed of [false, true])
	test(`${streamed ? "adopted streamed" : "fresh"} queued progress follows the holder and clears before running`, async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const holderChanged = Promise.withResolvers<void>();
		const originalRun = f.run.getMockImplementation()!;
		f.run.mockImplementation(async options => {
			entered.resolve();
			await finish.promise;
			return originalRun(options);
		});
		cleanups.push(async () => {
			finish.resolve();
		});
		const args = { context: "shared path", tasks: [f.items[0]] };
		if (streamed) {
			const admitted = Promise.withResolvers<void>();
			const emit = f.session.emitBeforeSubagentSpawn!;
			f.session.emitBeforeSubagentSpawn = async (event, signal) => {
				const result = await emit(event, signal);
				if (event.phase === "admission") admitted.resolve();
				return result;
			};
			const sink: SpeculativeOperationSink = {
				maxInFlight: 2,
				admit: async () => undefined,
				authorizeLaunch: async () => ({ allowed: true }),
				close: () => {},
			};
			const call: AgentToolCall = { type: "toolCall", id: "wait-progress", name: "task", arguments: {} };
			const stream = await f.tool.speculation.stream!.open({ coordinator: sink, parentToolCallId: call.id });
			if (!stream) throw new Error("Speculation unavailable");
			stream.update(call, JSON.stringify(args));
			stream.finalize({ toolCall: call, args });
			await admitted.promise;
		}
		await f.tool.execute("wait-progress", args, undefined, update => {
			if (update.details?.progress?.[0]?.stage?.includes("Holder-2")) holderChanged.resolve();
		});
		f.phases[0].tasks[0].schedule!.owner = "Holder-2";
		await holderChanged.promise;
		const job = f.jobs.getJob("PrCaptures")!;
		expect((job.latestDetails as TaskToolDetails | undefined)?.progress?.[0]?.stage).toContain("Holder-2");
		f.phases[0].tasks[0].status = "completed";
		await entered.promise;
		// Let the started continuation publish the running snapshot.
		await Bun.sleep(0);
		expect((job.latestDetails as TaskToolDetails | undefined)?.progress?.[0]?.stage).toBeUndefined();
		expect((job.latestDetails as TaskToolDetails | undefined)?.progress?.[0]?.status).toBe("running");
		finish.resolve();
		await job.promise;
	});

for (const release of ["released", "narrowed"] as const)
	test(`${release} claim uses current resources; both items spawn`, async () => {
		const f = await fixture();
		f.phases[0].tasks[0].schedule = {
			owner: "Holder-1",
			resources: release === "released" ? [] : [path.join(f.dir, "other.ts")],
			progress: { at: Date.now(), evidence: `Claim ${release}; shared.ts released.` },
		};
		const result = await f.tool.execute("free", { context: "Independent assigned paths", tasks: f.items });
		expect(textOf(result)).toContain("Spawned 2 background agents");
		expect(textOf(result)).not.toContain("REFUSED");
		expect(result.details?.progress?.map(item => item.id)).toEqual(["PrCaptures", "Independent"]);
	});

test("claim acquired after admission still fails through runtime gate", async () => {
	const f = await fixture();
	f.phases[0].tasks[0].schedule!.resources = [];
	const acquire = Promise.withResolvers<void>();
	const admitted = Promise.withResolvers<void>();
	const emit = f.session.emitBeforeSubagentSpawn!;
	f.session.emitBeforeSubagentSpawn = async (event, signal) => {
		if (!event.phase) {
			admitted.resolve();
			await acquire.promise;
		}
		return emit(event, signal);
	};
	const result = await f.tool.execute("late", { context: "Independent assigned paths", tasks: [f.items[0]] });
	expect(textOf(result)).toContain("Spawned agent `PrCaptures`");
	await admitted.promise;
	f.phases[0].tasks[0].schedule!.resources = [f.target];
	acquire.resolve();
	const job = f.jobs.getJob("PrCaptures")!;
	await job.promise;
	expect(job.status).toBe("failed");
	expect(JSON.stringify(job)).toContain("held by row");
	expect(f.run).not.toHaveBeenCalled();
});

test("streamed conflicting item cannot launch speculatively before dispatch", async () => {
	const f = await fixture();
	const sink: SpeculativeOperationSink = {
		maxInFlight: 2,
		admit: async () => undefined,
		authorizeLaunch: async () => ({ allowed: true }),
		close: () => {},
	};
	const call: AgentToolCall = { type: "toolCall", id: "streamed", name: "task", arguments: {} };
	const streamed = await f.tool.speculation.stream!.open({ coordinator: sink, parentToolCallId: call.id });
	if (!streamed) throw new Error("Speculation unavailable");
	const args = { context: "Independent assigned paths", tasks: [f.items[0]] };
	streamed.update(call, JSON.stringify(args));
	streamed.finalize({ toolCall: call, args });
	await (streamed as TaskLaunchSession).adopt([]);
	expect(f.run).not.toHaveBeenCalled();
	expect(f.state.spawns.size).toBe(0);
	const result = await f.tool.execute(call.id, args);
	expect(result.isError).not.toBe(true);
	expect(f.jobs.getRunningJobs()).toHaveLength(1);
	f.phases[0].tasks[0].status = "completed";
	await f.jobs.waitForAll();
});

test("non-resource deterministic gate also refuses before job registration", async () => {
	const f = await fixture();
	f.session.emitBeforeSubagentSpawn = async () => ({ block: true, reason: "Prerequisite missing" });
	const result = await f.tool.execute("other-gate", { context: "Independent assigned paths", tasks: [f.items[1]] });
	expect(textOf(result)).toStartWith("REFUSED: no worker was spawned for Independent: Prerequisite missing");
	expect(f.jobs.getJob("Independent")).toBeUndefined();
	expect(f.run).not.toHaveBeenCalled();
});

test("synchronous fallback waits for release and runs both items", async () => {
	const f = await fixture();
	f.session.settings = Settings.isolated({ "async.enabled": false, "task.batch": true });
	const pending = f.tool.execute("sync", { context: "Independent paths", tasks: f.items });
	await Bun.sleep(20);
	f.phases[0].tasks[0].status = "completed";
	const result = await pending;
	expect(result.details?.results.map(item => item.id)).toEqual(["PrCaptures", "Independent"]);
	expect(f.run).toHaveBeenCalledTimes(2);
	expect(f.jobs.getRunningJobs()).toHaveLength(0);
});

test("ROOT reader and four disjoint or unscoped writers all start; reader keeps shell without mutation tools", async () => {
	const f = await fixture();
	f.phases[0].tasks = ["Audit", "Alpha", "Beta", "Gamma", "Delta"].map(content => ({
		content,
		status: "pending",
		schedule: content === "Audit" ? { resources: [f.dir] } : {},
	}));
	const tasks = f.phases[0].tasks.map((row, index) => ({
		name: row.content,
		row: row.content,
		task: row.content,
		agent: "task",
		readOnly: index === 0,
		...(index === 1 || index === 2 ? { resources: [path.join(f.dir, `${row.content}.ts`)] } : {}),
	}));
	const validated = f.tool.parameters({
		context: `Background checkout ${f.dir}`,
		tasks: tasks.map(item => ({ ...item, solutionSpace: "bounded" })),
	});
	if (validated instanceof type.errors) throw new Error(validated.summary);
	const result = await f.tool.execute("root-reader", validated);
	expect(textOf(result)).not.toContain("REFUSED");
	expect(result.details?.progress?.map(item => item.id)).toEqual(tasks.map(item => item.name));
	for (const item of tasks) await f.jobs.getJob(item.name)?.promise;
	expect(f.run).toHaveBeenCalledTimes(5);
	const audit = f.run.mock.calls.find(([options]) => options.id === "Audit")![0];
	expect(audit.agent.tools).toContain("bash");
	expect(audit.agent.tools).not.toContain("edit");
	expect(audit.agent.tools).not.toContain("ast_edit");
	expect(audit.agent.tools).not.toContain("write");
	expect(audit.restrictToolNames).toBe(true);
	expect(audit.enableMCP).toBe(false);
	expect(f.phases[0].tasks[0].schedule?.ownerReadOnly).toEqual({ owner: "Audit", readOnly: true });
});

test("explicit item scope narrows a broad row; second same-file writer queues until the first finishes", async () => {
	const f = await fixture();
	f.phases[0].tasks = ["Alpha", "Beta"].map(content => ({
		content,
		status: "pending",
		schedule: { resources: [f.dir] },
	}));
	const result = await f.tool.execute("narrow", {
		context: `Background ${f.dir}`,
		tasks: [
			{ name: "Alpha", row: "Alpha", task: "Alpha", resources: [f.target] },
			{ name: "Beta", row: "Beta", task: "Beta", resources: [f.target] },
		],
	});
	expect(result.isError).not.toBe(true);
	expect(f.jobs.getJob("Beta")).toBeDefined();
	expect(f.phases[0].tasks[0].schedule?.resources).toEqual([f.target]);
	await f.jobs.waitForAll();
	expect(f.run).toHaveBeenCalledTimes(2);
});

test("item scope outside the canonical row is refused without changing ownership", async () => {
	const f = await fixture();
	f.phases[0].tasks[1].schedule = { resources: [f.target] };
	const result = await f.tool.execute("escape", {
		context: "Scope boundary",
		tasks: [{ ...f.items[0], resources: [path.join(f.dir, "outside.ts")] }],
	});
	expect(textOf(result)).toContain("resources exceed row");
	expect(f.jobs.getRunningJobs()).toHaveLength(0);
	expect(f.phases[0].tasks[1].schedule?.owner).toBeUndefined();
});

for (const agent of ["qa-auditor", "observer"])
	test(`${agent} ROOT reading does not acquire a write claim`, async () => {
		const f = await fixture();
		f.phases[0].tasks[0].schedule!.resources = [];
		f.phases[0].tasks[1].schedule = { resources: [f.dir] };
		const result = await f.tool.execute("role-read", {
			context: "Read and implement independently",
			tasks: [
				{ name: "Reader", agent, row: "Captures", task: "Captures" },
				{ name: "Writer", row: "Independent", task: "Independent", resources: [f.target] },
			],
		});
		expect(textOf(result)).not.toContain("REFUSED");
		await f.jobs.getJob("Reader")?.promise;
		await f.jobs.getJob("Writer")?.promise;
		expect(f.run).toHaveBeenCalledTimes(2);
		const reader = f.run.mock.calls.find(([options]) => options.id === "Reader")![0];
		if (agent === "qa-auditor") expect(reader.agent.tools).toEqual(["read", "bash"]);
		else expect(reader.agent.tools).not.toContain("bash");
		expect(reader.restrictToolNames).toBe(true);
		expect(f.phases[0].tasks[1].schedule?.ownerReadOnly).toEqual({ owner: "Reader", readOnly: true });
	});

test("several ROOT waiters drain without deadlock or failed attempts", async () => {
	const f = await fixture();
	f.phases[0].tasks = [
		f.phases[0].tasks[0],
		...["Alpha", "Beta", "Gamma"].map(content => ({
			content,
			status: "pending" as const,
			schedule: { resources: [f.dir] },
		})),
	];
	f.phases[0].tasks[0].schedule!.resources = [f.dir];
	const result = await f.tool.execute("replay", {
		context: "shared ROOT",
		tasks: ["Alpha", "Beta", "Gamma"].map(name => ({ name, row: name, task: name, resources: [f.dir] })),
	});
	expect(result.details?.progress).toHaveLength(3);
	expect(f.run).not.toHaveBeenCalled();
	expect(f.phases[0].tasks.slice(1).every(row => row.schedule?.resourceWait?.row === "Holder")).toBe(true);
	f.phases[0].tasks[0].status = "completed";
	await Promise.all(f.jobs.getRunningJobs().map(job => job.promise));
	expect(f.run).toHaveBeenCalledTimes(3);
	expect(
		f.phases[0].tasks.slice(1).every(row => !row.schedule?.attemptHistory?.length && !row.schedule?.resourceWait),
	).toBe(true);
});

for (const shutdown of [true, false])
	test(
		shutdown
			? "shutdown records a restart interruption instead of a failed work attempt"
			: "explicit cancellation remains a work attempt",
		async () => {
			const f = await fixture();
			const entered = Promise.withResolvers<void>();
			f.run.mockImplementation(async options => {
				entered.resolve();
				while (!options.signal?.aborted) await Bun.sleep(5);
				return {
					index: 0,
					id: options.id,
					agent: "task",
					agentSource: "bundled",
					task: "Independent",
					exitCode: 1,
					aborted: true,
					error: "The operation was aborted.",
					output: "",
					stderr: "",
					truncated: false,
					durationMs: 1000,
					tokens: 0,
					requests: 0,
				};
			});
			await f.tool.execute("shutdown", { context: "restart probe", tasks: [{ ...f.items[1], row: "Independent" }] });
			await entered.promise;
			f.jobs.cancelAll(undefined, shutdown ? ASYNC_JOB_MANAGER_SHUTDOWN_REASON : undefined);
			await f.jobs.waitForAll();
			const row = f.phases[0].tasks[2];
			expect(row.schedule?.attemptHistory).toHaveLength(1);
			expect(row.schedule?.attemptHistory?.[0].interruption).toBe(shutdown ? "restart" : undefined);
			expect(todoWorkAttempts(row.schedule?.attemptHistory)).toHaveLength(shutdown ? 0 : 1);
			if (shutdown) expect(row.schedule?.executor?.outcome).toBe("aborted");
		},
	);

test("failed job registration clears the row's resource wait without recording a worker attempt", async () => {
	const f = await fixture();
	await f.jobs.dispose({ timeoutMs: 100 });
	const result = await f.tool.execute("registration-failure", { context: "shared path", tasks: [f.items[0]] });
	expect(textOf(result)).toContain("Failed to start background task job");
	expect(f.jobs.getJob("PrCaptures")).toBeUndefined();
	expect(f.phases[0].tasks[1].schedule?.resourceWait).toBeUndefined();
	expect(f.phases[0].tasks[1].schedule?.attemptHistory ?? []).toEqual([]);
	expect(f.run).not.toHaveBeenCalled();
});
