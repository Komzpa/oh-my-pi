import { todoWorkAttempts } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { convertToLlm } from "../../coding-agent/src/session/messages";
import { convertWithHarnessNotices } from "../../coding-agent/src/session/harness-notices";
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
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
		getSessionFile: () => null,
		getTodoPhases: () => phases,
		getSessionSpawns: () => "*",
		asyncJobManager: jobs,
		emitBeforeSubagentSpawn: async event => routeSubagentSpawn(event, ctx, state, { stateFile }),
	} as ToolSession;
	const tool = await TaskTool.create(session);
	const items = [
		{ name: "PrCaptures", agent: "task", task: `Captures\nWrite ${target}` },
		{ name: "Independent", agent: "task", task: `Independent\nWrite ${path.join(dir, "independent.ts")}` },
	];
	return { dir, target, phases, state, jobs, run, session, tool, items };
}

function textOf(result: { content: { type: string; text?: string }[] }) {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

test("conflicting batch item is refused before job or executor ownership, while its sibling spawns", async () => {
	const f = await fixture();
	const result = await f.tool.execute("mixed", { context: "Independent assigned paths", tasks: f.items });
	const text = textOf(result);
	expect(text).toStartWith(
		`REFUSED: no worker was spawned for PrCaptures: resources ["${f.target}"] held by row "Holder" (owner Holder-1)`,
	);
	expect(text).toContain("Spawned agent `Independent`");
	expect(text).not.toContain("2 siblings");
	expect(text).not.toContain("spawned 2 generic");
	expect(f.jobs.getJob("PrCaptures")).toBeUndefined();
	expect(f.jobs.getJob("Independent")).toBeDefined();
	expect(result.details?.progress?.map(item => item.id)).toEqual(["Independent"]);
	expect(f.phases[0].tasks[1].schedule?.owner).toBeUndefined();
	await f.jobs.getJob("Independent")?.promise;
	expect(f.run).toHaveBeenCalledTimes(1);
	const messages = convertWithHarnessNotices(
		[
			{
				role: "toolResult",
				toolCallId: "mixed",
				toolName: "task",
				content: result.content,
				isError: false,
				timestamp: 1,
			},
		],
		"user",
		convertToLlm,
	);
	expect(
		messages.some(
			message => message.role === "user" && JSON.stringify(message).includes("no worker was spawned for PrCaptures"),
		),
	).toBe(true);
	expect(JSON.stringify(messages.find(message => message.role === "toolResult"))).toContain(
		"Spawned agent `Independent`",
	);
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

test("all-conflicting call has no job and is a harness refusal", async () => {
	const f = await fixture();
	const result = await f.tool.execute("blocked", { context: "Independent assigned paths", tasks: [f.items[0]] });
	expect(textOf(result)).toStartWith("REFUSED: no worker was spawned for PrCaptures:");
	expect(result.isError).toBe(true);
	expect(result.content[0]).toMatchObject({ harnessNotice: true });
	const converted = convertWithHarnessNotices(
		[
			{
				role: "toolResult",
				toolCallId: "blocked",
				toolName: "task",
				content: result.content,
				harnessNotice: result.harnessNotice,
				isError: true,
				timestamp: 1,
			},
		],
		"user",
		convertToLlm,
	);
	expect(converted.find(message => message.role === "toolResult")?.content).toEqual([
		{ type: "text", text: "REFUSED: tool did not run — see harness note" },
	]);
	expect(f.jobs.getJob("PrCaptures")).toBeUndefined();
	expect(f.run).not.toHaveBeenCalled();
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
	expect(textOf(result)).toStartWith("REFUSED: no worker was spawned for PrCaptures");
	expect(f.jobs.getRunningJobs()).toHaveLength(0);
});

test("non-resource deterministic gate also refuses before job registration", async () => {
	const f = await fixture();
	f.session.emitBeforeSubagentSpawn = async () => ({ block: true, reason: "Prerequisite missing" });
	const result = await f.tool.execute("other-gate", { context: "Independent assigned paths", tasks: [f.items[1]] });
	expect(textOf(result)).toStartWith("REFUSED: no worker was spawned for Independent: Prerequisite missing");
	expect(f.jobs.getJob("Independent")).toBeUndefined();
	expect(f.run).not.toHaveBeenCalled();
});

test("synchronous fallback refuses a conflicting item and runs its free sibling", async () => {
	const f = await fixture();
	f.session.settings = Settings.isolated({ "async.enabled": false, "task.batch": true });
	const result = await f.tool.execute("sync", { context: "Independent paths", tasks: f.items });
	expect(textOf(result)).toStartWith("REFUSED: no worker was spawned for PrCaptures:");
	expect(result.details?.results.map(item => item.id)).toEqual(["Independent"]);
	expect(f.run).toHaveBeenCalledTimes(1);
	expect(f.jobs.getRunningJobs()).toHaveLength(0);
});

test("ROOT reader and four disjoint or unscoped writers all start; reader tools cannot mutate", async () => {
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
	expect(audit.agent.tools).not.toContain("bash");
	expect(audit.agent.tools).not.toContain("write");
	expect(audit.restrictToolNames).toBe(true);
	expect(audit.enableMCP).toBe(false);
	expect(f.phases[0].tasks[0].schedule?.readOnly).toBe(true);
});

test("explicit item scope narrows a broad row; second same-file writer is refused before spawn", async () => {
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
	expect(textOf(result)).toStartWith("REFUSED: no worker was spawned for Beta:");
	expect(textOf(result)).toContain("tasks[].resources");
	expect(f.jobs.getJob("Beta")).toBeUndefined();
	expect(f.phases[0].tasks[0].schedule?.resources).toEqual([f.target]);
	await f.jobs.getJob("Alpha")?.promise;
	expect(f.run).toHaveBeenCalledTimes(1);
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
		expect(reader.agent.tools).not.toContain("bash");
		expect(reader.restrictToolNames).toBe(true);
		expect(f.phases[0].tasks[1].schedule?.readOnly).toBe(true);
	});

test("three identical admission conflicts block only that row, persist across tool recreation, and notify once", async () => {
	const f = await fixture();
	const notices: string[] = [];
	f.session.setTodoPhases = next => { f.phases.splice(0, f.phases.length, ...next); };
	f.session.persistTodoPhases = () => {};
	f.session.steer = message => { notices.push(message.content); };
	const item = { ...f.items[0], row: "Captures" };
	for (let i = 0; i < 3; i++) await f.tool.execute(`infra-${i}`, { context: "Capture", tasks: [item] });
	const row = f.phases[0].tasks[1];
	expect(row.status).toBe("blocked");
	expect(row.blocker).toContain("Holder-1");
	expect(row.schedule?.attemptHistory).toHaveLength(3);
	expect(todoWorkAttempts(row.schedule?.attemptHistory)).toHaveLength(0);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("proc://");
	const elevated = convertWithHarnessNotices([{ role: "custom", customType: "todo-infra-breaker", content: notices[0], display: false, timestamp: 1 }], "user", convertToLlm);
	expect(elevated.some(message => message.role === "user" && JSON.stringify(message).includes("Holder-1"))).toBe(true);
	const resumed = await TaskTool.create(f.session);
	const fourth = await resumed.execute("again", { context: "Capture", tasks: [{ ...item, name: "DifferentName" }] });
	expect(textOf(fourth)).toContain("Infra breaker");
	expect(row.schedule?.attemptHistory).toHaveLength(3);
	expect(notices).toHaveLength(1);
	expect(f.run).not.toHaveBeenCalled();
	expect(f.jobs.getJob("PrCaptures")).toBeUndefined();
});
