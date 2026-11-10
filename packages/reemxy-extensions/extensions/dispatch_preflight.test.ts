import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { applyTodoExecutorObservation } from "@oh-my-pi/pi-coding-agent/tools/todo-executor";
import agentRouter, { requestResourceScope } from "./agent_router";
import { workerToolPreflight, type HostResourceProbes, type TestProcess } from "./dispatch_preflight";
const ctx = { cwd: "/project", agent: { kind: "sub" } } as ExtensionContext;
const low = {
	meminfo: async () => "MemTotal: 999999 kB\nMemFree: 1 kB\nMemAvailable: 4194304 kB\n",
	processes: async (): Promise<TestProcess[]> => [],
};
const call = (toolName: string, input: unknown, context = ctx, probes: HostResourceProbes = low) =>
	workerToolPreflight({ toolName, input }, context, probes);

test("write behavior blocks outside cwd without telltale prose and cannot be bypassed by retry", async () => {
	for (let retry = 0; retry < 3; retry++)
		expect((await call("write", { path: "/elsewhere/a", content: "plain" }))?.reason).toContain(
			"add /elsewhere/a to row",
		);
	expect(await call("write", { path: "a", content: "Write roots: /elsewhere. Run playwright test" })).toBeUndefined();
	expect(await call("read", { path: "/elsewhere/a" })).toBeUndefined();
	expect(await call("write", { path: "agent://Main", content: "help" })).toBeUndefined();
	expect(await call("edit", { path: "../project-other/a" })).toMatchObject({ block: true });
	expect(
		await call("write", { path: "/elsewhere/a" }, { ...ctx, agent: { kind: "main" } } as ExtensionContext),
	).toBeUndefined();
});
test("known bash write operands are checked; mention-only commands pass", async () => {
	expect(await call("bash", { command: "touch /elsewhere/a" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "cp a /elsewhere/b" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "echo 'touch /elsewhere/a playwright test'" })).toBeUndefined();
	expect(await call("bash", { command: "touch local" })).toBeUndefined();
});
test("symlink escapes and edit rename targets are blocked", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-"));
	try {
		await fs.symlink(os.tmpdir(), path.join(dir, "escape"));
		const context = { ...ctx, cwd: dir };
		expect(await call("write", { path: "escape/new" }, context)).toMatchObject({ block: true });
		expect(await call("edit", { path: "local", edits: [{ rename: "../outside" }] }, context)).toMatchObject({
			block: true,
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("actual test launch probes fresh resources on each attempt; matching words alone do not", async () => {
	let count = 0;
	const probes = {
		...low,
		meminfo: async () => {
			count++;
			return count < 3 ? "MemAvailable: 4194304 kB\n" : "MemAvailable: 99999999 kB\n";
		},
	};
	expect(await call("bash", { command: "echo 'playwright browser full-suite'" }, ctx, probes)).toBeUndefined();
	expect(count).toBe(0);
	for (let i = 0; i < 2; i++)
		expect((await call("bash", { command: "bun test" }, ctx, probes))?.reason).toContain("4.00 GiB (4194304 KiB)");
	expect(await call("bash", { command: "bun test" }, ctx, probes)).toBeUndefined();
	expect(count).toBe(3);
});
test("three same-project suites admit a fourth with RAM capacity of at least four", async () => {
	const probes = {
		meminfo: async () => "MemAvailable: 58720256 kB\n", // 56 GiB, floor 8 => N=12
		cpus: () => 32,
		processes: async () => [42, 43, 44].map(pid => ({ pid, cwd: "/project/tests", command: "bun test" })),
	};
	expect(await call("bash", { command: "npx playwright test" }, ctx, probes)).toBeUndefined();
	expect(await call("browser", { action: "open" }, ctx, probes)).toBeUndefined();
	const full = { ...probes, cpus: () => 3 };
	const refused = await call("bash", { command: "bun test" }, ctx, full);
	expect(refused?.reason).toContain("N=3");
	expect(refused?.reason).toContain("PIDs 42, 43, 44");
	expect(refused?.reason).toContain("running count is below N");
	expect(
		await call("bash", { command: "bun test" }, ctx, {
			...full,
			processes: async () => (await probes.processes()).slice(1),
		}),
	).toBeUndefined();
	expect(await call("bash", { command: "bun test" }, { ...ctx, cwd: "/other" }, full)).toBeUndefined();
});

test("RAM below the floor refuses an idle project", async () => {
	expect((await call("bash", { command: "bun test" }))?.reason).toContain("minimum=8 GiB");
});

test("low VRAM refuses hardware perf while functional e2e still runs", async () => {
	const probes = {
		...low,
		meminfo: async () => "MemAvailable: 58720256 kB\n",
		cpus: () => 32,
		gpuFreeMiB: async () => [1000, 700],
	};
	const refused = await call(
		"bash",
		{ command: "OMP_TEST_GPU=1 npx playwright test e2e/frame-cap.spec.ts" },
		ctx,
		probes,
	);
	expect(refused?.reason).toContain("additional GPU slots=0");
	expect(refused?.reason).toContain("[1000,700]");
	expect(await call("bash", { command: "npx playwright test e2e/functional.spec.ts" }, ctx, probes)).toBeUndefined();
	expect(await call("bash", { command: "npx playwright test e2e/timing.spec.ts" }, ctx, probes)).toMatchObject({
		block: true,
	});
	expect(
		await call("bash", { command: "OMP_TEST_GPU=1 npx playwright test" }, ctx, {
			...probes,
			gpuFreeMiB: async () => [3072, 700],
		}),
	).toBeUndefined();
	const unknown = {
		...probes,
		gpuFreeMiB: async (): Promise<number[]> => {
			throw new Error("probe failed");
		},
	};
	expect(await call("bash", { command: "OMP_TEST_GPU=1 npx playwright test" }, ctx, unknown)).toMatchObject({
		block: true,
	});
	expect(await call("bash", { command: "npx playwright test e2e/functional.spec.ts" }, ctx, unknown)).toBeUndefined();
});

test("shell redirections and changed cwd resolve targets, quoted mentions remain inert", async () => {
	expect(await call("bash", { command: "echo data >/elsewhere/a" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "echo data 2>&1" })).toBeUndefined();
	expect(await call("bash", { command: "echo data 2>&-" })).toBeUndefined();
	expect(await call("bash", { command: "echo data >&/elsewhere/a" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "cd /elsewhere && touch a" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "echo '> /elsewhere/a'" })).toBeUndefined();
	expect(await call("bash", { command: "cd /project && echo data >local" })).toBeUndefined();
	expect(await call("bash", { command: "env CI=1 timeout 30 bash -lc 'npm run test'" })).toMatchObject({
		block: true,
	});
});

test("descriptor duplication is not a file outside an explicitly scoped worktree", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({ id: "Lead", displayName: "Lead", kind: "main", session: {
		activeToolExecutionUpdates() {}, getTodoPhases: () => [{ name: "Work", tasks: [{
			content: "Run checks", status: "in_progress", schedule: { owner: "Gate", resources: ["/isolated"] },
		}] }],
	} as unknown as AgentSessionHandle });
	const context = { cwd: "/project", agent: { kind: "sub", id: "Gate", parentId: "Lead" } } as ExtensionContext;
	try {
		expect(await call("bash", { command: "echo ok 2>&1" }, context)).toBeUndefined();
		expect(await call("bash", { command: "echo ok >&/elsewhere/file" }, context)).toMatchObject({ block: true });
	} finally {
		spy.mockRestore();
	}
});

test("bash writes resolve against the tool cwd and still enforce the assigned scope", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({ id: "Lead", displayName: "Lead", kind: "main", session: {
		activeToolExecutionUpdates() {}, getTodoPhases: () => [{ name: "Work", tasks: [{
			content: "Run gates", status: "in_progress", schedule: { owner: "Gate", resources: ["/isolated"] },
		}] }],
	} as unknown as AgentSessionHandle });
	const context = { cwd: "/project", agent: { kind: "sub", id: "Gate", parentId: "Lead" } } as ExtensionContext;
	try {
		expect(await call("bash", { command: "mkdir -p tmp", cwd: "/isolated" }, context)).toBeUndefined();
		expect(await call("bash", { command: "mkdir -p tmp", cwd: "../isolated" }, context)).toBeUndefined();
		expect((await call("bash", { command: "mkdir -p tmp", cwd: "/elsewhere" }, context))?.reason)
			.toContain("add /elsewhere/tmp to row");
		expect((await call("bash", { command: "mkdir -p tmp", cwd: "/" }, context))?.reason)
			.toContain("add /project/tmp to row");
		expect((await call("bash", { command: "mkdir -p tmp", cwd: "~" }, context))?.reason)
			.toContain(`add ${os.homedir()}/tmp to row`);
		expect((await call("bash", { command: "mkdir -p tmp" }, context))?.reason)
			.toContain("add /project/tmp to row");
	} finally {
		spy.mockRestore();
	}
});

test("registered tool hook checks launch state and file target before execution", async () => {
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
	agentRouter(
		{
			on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
				handlers.set(name, handler),
		} as unknown as ExtensionAPI,
		low,
	);
	const hook = handlers.get("tool_call")!;
	expect(await hook({ toolName: "bash", input: { command: "bun test" } }, ctx)).toMatchObject({ block: true });
	expect(await hook({ toolName: "write", input: { path: "/elsewhere/a", content: "plain" } }, ctx)).toMatchObject({
		block: true,
	});
	expect(await hook({ toolName: "bash", input: { command: "echo 'bun test'" } }, ctx)).toBeUndefined();
});

test("a managed browser launch checks RAM while attaching an existing browser does not", async () => {
	expect(await call("browser", { action: "open" })).toMatchObject({ block: true });
	expect(await call("browser", { action: "open", app: { cdp_url: "http://localhost:9222" } })).toBeUndefined();
	expect(await call("browser", { action: "call", chain: [{ method: "title", args: [] }] })).toBeUndefined();
});

test("patch payload targets cannot escape through pathless edit formats", async () => {
	expect(
		await call("edit", { input: "*** Begin Patch\n*** Add File: /elsewhere/a\n+hello\n*** End Patch" }),
	).toMatchObject({ block: true });
	expect(await call("edit", { input: "[/elsewhere/a]\n1: update" })).toMatchObject({ block: true });
});

test("a running worker reads live parent resources on every write, including revocation", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	let resources = ["/project"];
	const manager = SessionManager.inMemory();
	const todo = new TodoTool({
		cwd: "/project",
		settings: Settings.isolated(),
		sessionManager: manager,
		getSessionFile: () => null,
		getTodoPhases: () => [
			{
				name: "Work",
				tasks: [{ content: "Fix pipes", status: "in_progress", schedule: { owner: "Pipes", resources } }],
			},
		],
		setTodoPhases: (phases: TodoPhase[]) => {
			resources = phases[0]!.tasks[0]!.schedule!.resources!;
		},
	} as unknown as ToolSession);
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: {
			activeToolExecutionUpdates() {},
			getTodoPhases: () => [
				{
					name: "Work",
					tasks: [{ content: "Fix pipes", status: "in_progress", schedule: { owner: "Pipes", resources } }],
				},
			],
		} as unknown as AgentSessionHandle,
	});
	try {
		const context = { ...ctx, agent: { kind: "sub", id: "Pipes", parentId: "Lead" } } as ExtensionContext;
		const denied = await call("write", { path: "/new-worktree/a" }, context);
		expect(denied?.reason).toContain(
			'add /new-worktree/a to row "Fix pipes" resources via todo schedule; applies to the running worker',
		);
		expect(denied?.reason).not.toMatch(/kill|redispatch/);
		await todo.execute("live-scope", {
			op: "schedule",
			updates: [{ task: "Fix pipes", resources: ["/new-worktree"] }],
		});
		expect(await call("write", { path: "/new-worktree/a" }, context)).toBeUndefined();
		expect(await call("write", { path: "/project/a" }, context)).toMatchObject({ block: true });
		resources = ["ambiguous"];
		expect((await call("write", { path: "/new-worktree/a" }, context))?.reason).toContain(
			"replacement absolute worktree path",
		);
	} finally {
		await manager.close();
		spy.mockRestore();
	}
});

test("ROOT reader does not block writes; unscoped concurrent writes acquire one exact target", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{
					content: "Audit",
					status: "in_progress",
					schedule: { owner: "Audit", resources: ["/project"], readOnly: true },
				},
				{ content: "Alpha", status: "in_progress", schedule: { owner: "Alpha" } },
				{ content: "Beta", status: "in_progress", schedule: { owner: "Beta" } },
			],
		},
	];
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: { activeToolExecutionUpdates() {}, getTodoPhases: () => phases } as unknown as AgentSessionHandle,
	});
	const context = (id: string) => ({ ...ctx, agent: { kind: "sub", id, parentId: "Lead" } }) as ExtensionContext;
	try {
		const results = await Promise.all([
			call("write", { path: "shared.ts" }, context("Alpha")),
			call("edit", { path: "shared.ts" }, context("Beta")),
		]);
		expect(results.filter(result => result === undefined)).toHaveLength(1);
		expect(results.find(result => result?.block)?.reason).toContain("Write conflicts with worker");
		expect(await call("write", { path: "other.ts" }, context("Beta"))).toBeUndefined();
		expect((await call("write", { path: "audit.ts" }, context("Audit")))?.reason).toContain("Read-only row");
		phases[0]!.tasks[1]!.status = "completed";
		expect(await call("write", { path: "shared.ts" }, context("Beta"))).toBeUndefined();
	} finally {
		spy.mockRestore();
	}
});
test("lead scheduling a suffixed owner survives another executor's progress and grants only its absolute files", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	let phases: TodoPhase[] = [{ name: "Work", tasks: [{
		content: "Repair stakeholder scenario", status: "in_progress", schedule: {
			owner: "Scenario-5", workerIds: ["Scenario", "Scenario-4", "Scenario-5"],
			executor: { workerId: "Scenario-5", agentProfile: "reviewer", startedAt: 50 },
			resources: ["/isolated/scenario/doc/requirements.md", "/isolated/scenario/test-results"],
		},
	}] }];
	registry.register({ id: "Lead", displayName: "Lead", kind: "main", session: {
		activeToolExecutionUpdates() {}, getTodoPhases: () => phases,
	} as unknown as AgentSessionHandle });
	const context = { cwd: "/shared/project", agent: { kind: "sub", id: "Scenario-4", parentId: "Lead" } } as ExtensionContext;
	const target = "/isolated/scenario/doc/requirements.md";
	const manager = SessionManager.inMemory();
	const todo = new TodoTool({ cwd: context.cwd, settings: Settings.isolated(), sessionManager: manager,
		getSessionFile: () => null, getTodoPhases: () => phases,
		setTodoPhases: (updated: TodoPhase[]) => { phases = updated; },
	} as unknown as ToolSession);
	try {
		expect(await call("edit", { path: target }, context)).toMatchObject({ block: true });
		expect(await requestResourceScope(context, [target])).toMatchObject({ status: "unavailable" });
		await todo.execute("schedule-owner", { op: "schedule", updates: [{ task: "Repair stakeholder scenario", owner: "Scenario-4" }] });
		phases = applyTodoExecutorObservation(phases, {
			row: "Repair stakeholder scenario", workerId: "Scenario-5", agentProfile: "reviewer",
			startedAt: 50, resolvedModel: "test/model", runningWorkerIds: new Set(["Scenario-4", "Scenario-5"]),
		}) ?? phases;
		expect(await call("edit", { path: target }, context)).toBeUndefined();
		expect(await requestResourceScope(context, [target])).toMatchObject({ status: "granted" });
		expect(await call("write", { path: "/isolated/scenario/test-results/report.json" }, context)).toBeUndefined();
		for (const denied of ["/isolated/scenario/doc/other.md", "/shared/project/file.ts"])
			expect(await call("edit", { path: denied }, context)).toMatchObject({ block: true });
		const unmatched = { ...context, agent: { ...context.agent, id: "Scenario-6" } } as ExtensionContext;
		expect(await call("edit", { path: target }, unmatched)).toMatchObject({ block: true });
		expect(await requestResourceScope(unmatched, [target])).toMatchObject({ status: "unavailable" });
		await todo.execute("revoke-owner", { op: "schedule", updates: [{ task: "Repair stakeholder scenario", owner: "Replacement" }] });
		expect(await call("edit", { path: target }, context)).toMatchObject({ block: true });
		expect(await requestResourceScope(context, [target])).toMatchObject({ status: "unavailable" });
		const executor = { ...context, agent: { ...context.agent, id: "Scenario-5" } } as ExtensionContext;
		// Reassignment revokes the recorded old executor too; its stale receipt
		// cannot keep write authority after Main assigns Replacement.
		expect(await call("edit", { path: target }, executor)).toMatchObject({ block: true });
		expect(await requestResourceScope(executor, [target])).toMatchObject({ status: "unavailable" });
	} finally {
		await manager.close();
		spy.mockRestore();
	}
});
