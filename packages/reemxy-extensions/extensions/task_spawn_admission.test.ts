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
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { convertToLlm } from "../../coding-agent/src/session/messages";
import { convertWithHarnessNotices } from "../../coding-agent/src/session/harness-notices";
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
	const phases: TodoScheduleInput = [
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
		agents: [{ name: "task", description: "Task", systemPrompt: "Task", source: "bundled" }],
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
