import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ThreadService } from "@oh-my-pi/pi-coding-agent/thread/services";
import { agentsThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/agents";
import { identityThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/identity";
import { SubagentWorker } from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ScopeProbe, ScopeProbeGlobals } from "./fixtures/worker-scope-bridge";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function fixture(cwd: string) {
	AgentRegistry.resetGlobalForTests();
	const registry = new AgentRegistry();
	AgentRegistry.installGlobal(registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const mock = createMockModel({
		handler: () => {
			throw new Error("scope test must not invoke a model");
		},
	});
	const agent = new Agent({
		getApiKey: () => "test",
		initialState: { model, systemPrompt: [], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const auth = await AuthStorage.create(":memory:");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth),
		agentId: "ScopeLead",
	});
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
	});
	registry.register({ id: "ScopeLead", displayName: "ScopeLead", kind: "main", session });
	const ref = registry.register({
		id: "Reusable-20",
		displayName: "RequestedDifferentName",
		kind: "sub",
		parentId: "ScopeLead",
		status: "running",
		starting: true,
		session: null,
	});
	const row = {
		content: "Canonical product row",
		status: "in_progress" as const,
		schedule: {
			owner: "Reusable-20",
			resources: [cwd],
			executor: { workerId: "Reusable-20", startedAt: 1, finishedAt: 2, outcome: "completed" as const },
		},
	};
	session.setTodoPhases([{ name: "Work", tasks: [row] }]);
	const ready = Promise.withResolvers<ScopeProbe>();
	const probeService: ThreadService = {
		name: "scope-probe",
		globals: (): ScopeProbeGlobals => ({ ready: probe => ready.resolve(probe) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("./fixtures/worker-scope-bridge.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("scope test end"));
	await worker.ready;
	const probe = await ready.promise;
	await probe.open(cwd);
	const todo = new TodoTool({
		cwd,
		settings: Settings.isolated(),
		sessionManager: session.sessionManager,
		getSessionFile: () => null,
		getTodoPhases: () => session.getTodoPhases(),
		getTodoSnapshot: () => session.getTodoSnapshot(),
		setTodoPhases: (phases: TodoPhase[]) => session.setTodoPhases(phases),
		agentRegistry: registry,
	} as unknown as ToolSession);
	return { registry, ref, session, probe, todo };
}

test("lead scope grant reaches the same reused worker across the real thread bridge without another row or writer", async () => {
	using temp = TempDir.createSync(join(tmpdir(), "omp-scope-bridge-"));
	const cwd = join(temp.path(), "source");
	const receipt = join(temp.path(), "evidence", "receipt.txt");
	const product = join(cwd, "product.ts");
	await Bun.write(product, "product source stays unchanged\n");
	const { registry, ref, session, probe, todo } = await fixture(cwd);
	expect((await probe.write(receipt)).blocked).toBe(true);
	expect(await Bun.file(receipt).exists()).toBe(false);
	const request = await probe.request([receipt]);
	expect(request.status).toBe("pending");
	expect(request.action?.updates).toEqual([{ task: "Canonical product row", resources: [cwd, receipt] }]);
	await todo.execute("lead-scope-grant", { op: "schedule", updates: request.action!.updates });
	expect((await probe.request([receipt])).status).toBe("granted");
	expect(await probe.write(receipt)).toEqual({ blocked: false });
	expect(await Bun.file(receipt).text()).toBe("scope-bridge-receipt\n");
	expect(await Bun.file(product).text()).toBe("product source stays unchanged\n");
	expect(registry.get(ref.id)).toBe(ref);
	expect(registry.list().filter(agent => agent.kind === "sub")).toHaveLength(1);
	expect(session.getTodoSnapshot().flatMap(phase => phase.tasks)).toHaveLength(1);
	expect((await probe.write(join(temp.path(), "ungranted.txt"))).blocked).toBe(true);
});

test("bridge grants remain fenced by foreign custody, explicit revocation, and closed or reassigned rows", async () => {
	using temp = TempDir.createSync(join(tmpdir(), "omp-scope-revocation-"));
	const cwd = join(temp.path(), "source");
	const target = join(temp.path(), "evidence", "denied.txt");
	const { registry, session, probe, todo } = await fixture(cwd);
	await todo.execute("lead-scope-grant", {
		op: "schedule",
		updates: [{ task: "Canonical product row", resources: [target] }],
	});
	registry.register({
		id: "Other",
		displayName: "Other",
		kind: "sub",
		parentId: "ScopeLead",
		status: "running",
		starting: true,
		session: null,
	});
	const phases = structuredClone(session.getTodoSnapshot()) as TodoPhase[];
	phases[0]!.tasks.push({
		content: "Foreign live writer",
		status: "in_progress",
		schedule: {
			owner: "Other",
			resources: [target],
			executor: { workerId: "Other", startedAt: 1, finishedAt: 2, outcome: "completed" },
		},
	});
	session.setTodoPhases(phases);
	expect((await probe.request([target])).status).toBe("conflict");
	expect((await probe.write(target)).blocked).toBe(true);
	registry.setStatus("Other", "idle");
	expect((await probe.request([target])).status).toBe("granted");
	phases[0]!.tasks.pop();
	phases[0]!.tasks[0]!.schedule!.resources = [];
	session.setTodoPhases(phases);
	expect((await probe.write(target)).blocked).toBe(true);
	for (const transition of ["completed", "reassigned"] as const) {
		const next = structuredClone(phases);
		if (transition === "completed") next[0]!.tasks[0]!.status = "completed";
		else next[0]!.tasks[0]!.schedule!.owner = "Replacement";
		session.setTodoPhases(next);
		expect((await probe.request([target])).status).toBe("unavailable");
		expect((await probe.write(target)).blocked).toBe(true);
	}
	expect(await Bun.file(target).exists()).toBe(false);
});

test("a reused running handle cannot inherit its previous row after the canonical binding changes", async () => {
	using temp = TempDir.createSync(join(tmpdir(), "omp-row-binding-"));
	const cwd = join(temp.path(), "source");
	const target = join(cwd, "receipt.txt");
	const { registry, session, probe } = await fixture(cwd);
	registry.setTodoRow("Reusable-20", "Canonical product row");
	expect((await probe.request([target])).status).toBe("granted");
	registry.setTodoRow("Reusable-20", "Another canonical row");
	expect((await probe.request([target])).status).toBe("unavailable");
	expect((await probe.write(target)).blocked).toBe(true);
	registry.setTodoRow("Reusable-20", "Canonical product row");
	expect((await probe.request([target])).status).toBe("granted");
	const active = structuredClone(session.getTodoSnapshot()) as TodoPhase[];
	active[0]!.tasks[0]!.schedule!.executor = { workerId: "Reusable-20", startedAt: 3 };
	session.setTodoPhases(active);
	registry.setTodoRow("Reusable-20", "Another canonical row");
	expect((await probe.request([target])).status).toBe("unavailable");
	expect((await probe.write(target)).blocked).toBe(true);
	expect(session.getTodoSnapshot().flatMap(phase => phase.tasks)).toHaveLength(1);
	expect(await Bun.file(target).exists()).toBe(false);
});
