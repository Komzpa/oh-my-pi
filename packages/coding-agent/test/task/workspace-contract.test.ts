import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-contract-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	const git = (cwd: string, ...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	for (const repo of [a, b]) {
		await fs.mkdir(repo);
		git(repo, "init", "-q");
		await fs.writeFile(path.join(repo, "input.txt"), repo);
		git(repo, "add", ".");
		git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "first");
	}
	const base = await vcs.requireGit(b).headSha();
	await fs.writeFile(path.join(b, "later.txt"), "later");
	git(b, "add", ".");
	git(b, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "second");
	const headA = await vcs.requireGit(a).headSha();
	const headB = await vcs.requireGit(b).headSha();
	if (!base || !headA || !headB) throw new Error("Fixture repositories must have committed HEADs");
	expect(await vcs.requireGit(a).resolveRef(`${base}^{commit}`)).toBeNull();
	const phases = [
		{
			name: "Work",
			tasks: [
				{
					content: "Unrelated",
					status: "in_progress",
					schedule: { owner: "Requester", resources: [path.join(a, "owned")] },
				},
			],
		},
	];
	const running: AsyncJobSnapshot["running"] = [];
	const extensionDir = path.resolve(import.meta.dir, "../../../reemxy-extensions/extensions");
	const loaded = await loadExtensions(
		[path.join(extensionDir, "agent_router.ts"), path.join(extensionDir, "todo_dispatch.ts")],
		a,
		new EventBus(),
	);
	expect(loaded.errors).toEqual([]);
	const settings = Settings.isolated({ "task.batch": true, "async.enabled": false });
	const manager = SessionManager.inMemory(a);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		a,
		manager,
		{} as ModelRegistry,
		undefined,
		settings,
		undefined,
		() => ({ running, recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } }),
		undefined,
		undefined,
		() => phases as never,
		undefined,
		undefined,
		() => phases as never,
	);
	runner.initialize(
		{
			getActiveTools: () => ["task"],
			appendEntry: (customType: string, data?: unknown) => manager.appendCustomEntry(customType, data),
		} as never,
		{} as never,
	);
	const registry = new AgentRegistry();
	const steer = vi.fn(async () => {});
	registry.register({
		id: "Lead",
		kind: "main",
		displayName: "Lead",
		session: { getTodoPhases: () => phases, steer } as never,
	});
	registry.register({
		id: "Requester",
		kind: "sub",
		parentId: "Lead",
		displayName: "Requester",
		session: { getTodoPhases: () => [] } as never,
	});
	const scopeTool = runner.getRegisteredTool("resource_scope");
	expect(scopeTool).toBeDefined();
	const requested = path.join(a, "requested");
	const scopeResult = await scopeTool!.definition.execute("scope", { paths: [requested] }, undefined, undefined, {
		cwd: a,
		agent: { kind: "sub", id: "Requester", parentId: "Lead" },
		agentRegistry: registry,
	} as never);
	expect(scopeResult.details).toMatchObject({ status: "pending" });
	expect(steer).toHaveBeenCalledTimes(1);
	expect(phases[0]!.tasks[0]!.schedule.resources).toEqual([path.join(a, "owned")]);
	const events: Record<string, unknown>[] = [];
	const previous = process.env.OMP_AGENT_ROUTER_STATE;
	const previousWorktrees = process.env.OMP_WORKTREE_DIR;
	process.env.OMP_AGENT_ROUTER_STATE = path.join(root, "router.jsonl");
	process.env.OMP_WORKTREE_DIR = path.join(root, "worktrees");
	cleanups.push(async () => {
		if (previous === undefined) delete process.env.OMP_AGENT_ROUTER_STATE;
		else process.env.OMP_AGENT_ROUTER_STATE = previous;
		if (previousWorktrees === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = previousWorktrees;
	});
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ name: "task", description: "Task", systemPrompt: "Task", source: "bundled" }],
		projectAgentsDir: null,
	});
	const session = {
		cwd: a,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getTodoPhases: () => phases,
		emitBeforeSubagentSpawn: async (event: Record<string, unknown>, signal: AbortSignal) => {
			events.push(event);
			return runner.emitBeforeSubagentSpawn(event as never, signal);
		},
	} as unknown as ToolSession;
	const seen: { id: string; cwd: string; head: string }[] = [];
	const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
		const head = await vcs.requireGit(options.cwd).headSha();
		if (!head) throw new Error("Prepared child checkout must have a committed HEAD");
		seen.push({ id: options.id, cwd: options.cwd, head });
		return {
			index: options.index,
			id: options.id,
			agent: "task",
			agentSource: "bundled",
			task: options.task,
			assignment: options.assignment ?? "",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
	});
	const native = await TaskTool.create(session);
	const tool = new ExtensionToolWrapper(
		{
			name: native.name,
			label: native.label,
			description: native.description,
			parameters: native.parameters,
			execute: native.execute.bind(native),
		},
		runner,
	);
	return { a, b, base, headA, headB, git, phases, events, run, seen, running, tool };
}

test("prepared foreign checkout and claims ignore prose and unrelated rows", async () => {
	const f = await fixture();
	const result = await f.tool.execute("foreign", {
		context: "work",
		tasks: [
			{
				name: "Foreign",
				agent: "task",
				task: `worktree: ${f.a} cwd=${f.a} root: ${f.a}`,
				workspace: { repo: f.b, base: f.base },
				reads: [path.join(f.b, "input.txt")],
			},
		],
	} as never);
	expect(result.isError).not.toBe(true);
	expect(f.run).toHaveBeenCalledTimes(1);
	const options = f.run.mock.calls[0]![0];
	expect(f.seen[0]?.head).toBe(f.base);
	expect(options.cwd).not.toBe(f.a);
	const record = {
		repo: f.b,
		cwd: options.cwd,
		head: f.base,
		reads: [path.join(f.b, "input.txt")],
		resources: [options.cwd],
	};
	expect(f.events.at(-1)?.verifiedWorkspace).toEqual(record);
	expect(options.verifiedWorkspace).toEqual(record);
	expect(options.task.startsWith("<verified_task_workspace>\n")).toBe(true);
	expect(options.task).toContain(JSON.stringify(record));
	expect(result.details?.results.find(item => item.id === "Foreign")?.verifiedWorkspace).toEqual(record);
	expect(await vcs.requireGit(f.a).headSha()).toBe(f.headA);
	expect(f.git(f.a, "status", "--porcelain")).toBe("");
	expect(await fs.readFile(path.join(f.a, "input.txt"), "utf8")).toBe(f.a);
});

test.each(["MissingBase", "WrongHead", "MissingRead"] as const)(
	"%s is refused while a valid sibling runs",
	async name => {
		const f = await fixture();
		const missing = path.join(f.b, "missing.txt");
		const cases = {
			MissingBase: {
				item: { name, agent: "task", task: "work", workspace: { repo: f.b, base: "missing-commit" } },
				message: `workspace.base: expected a commit available in ${f.b}; actual "missing-commit". Remedy: use bash to run git -C ${JSON.stringify(f.b)} fetch origin "missing-commit".`,
			},
			WrongHead: {
				item: { name, agent: "task", task: "work", workspace: { repo: f.b, base: f.base, path: f.b } },
				message: `workspace.path HEAD: expected ${f.base}; actual "${f.headB}". Remedy: use bash to run git -C ${JSON.stringify(f.b)} worktree add --detach <new-absolute-path> ${f.base}.`,
			},
			MissingRead: {
				item: { name, agent: "task", task: "work", workspace: { repo: f.b, base: f.base }, reads: [missing] },
				message: `reads: expected an existing path; actual ${JSON.stringify(missing)}. Remedy: use bash to run stat -- ${JSON.stringify(missing)} and supply an existing path.`,
			},
		};
		const result = await f.tool.execute("invalid", {
			context: "work",
			tasks: [cases[name].item, { name: "Valid", agent: "task", task: "work", resources: [] }],
		} as never);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain(name);
		expect(text).toContain(cases[name].message);
		expect(f.run.mock.calls.map(call => call[0].id)).toEqual(["Valid"]);
		expect(f.events.some(event => event.spawnKey === name)).toBe(false);
		expect(result.details?.results.find(item => item.id === name && item.exitCode === 0)).toBeUndefined();
		expect(result.details?.progress?.find(item => item.id === name)?.status).not.toBe("completed");
	},
);

test("registered router refuses a second writer in the same checkout", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const implementation = f.run.getMockImplementation()!;
	f.run.mockImplementation(async options => {
		entered.resolve();
		await release.promise;
		return implementation(options);
	});
	const first = f.tool.execute("first", {
		context: "work",
		tasks: [{ name: "First", agent: "task", task: "write", resources: [f.a] }],
	} as never);
	try {
		await entered.promise;
		f.running.push({ id: "First", type: "task", status: "running", startTime: Date.now(), label: "First" });
		const second = await f.tool.execute("second", {
			context: "work",
			tasks: [{ name: "Second", agent: "task", task: "write", resources: [f.a] }],
		} as never);
		expect(JSON.stringify(second)).toContain("First");
		expect(f.run).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		await first;
	}
});
