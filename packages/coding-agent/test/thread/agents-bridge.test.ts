import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { captureSubagentsForRestart } from "../../src/task/restart-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { AgentsProbe, AgentsProbeGlobals } from "../fixtures/agents-bridge-worker";

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function startWorker(): Promise<{ worker: SubagentWorker; probe: AgentsProbe }> {
	const probe = Promise.withResolvers<AgentsProbe>();
	const probeService: ThreadService = {
		name: "agents-probe",
		globals: (): AgentsProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/agents-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return { worker, probe: await probe.promise };
}

/**
 * Poll a condition fed by another thread (mirror patches, worker-side state).
 * There is no in-process clock to fake across a real worker; this waits on the
 * condition itself, never a guessed duration.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function liveRef(id: string): AgentRef {
	const ref = AgentRegistry.global().get(id);
	if (!ref) throw new Error(`no ref ${id}`);
	return ref;
}

function mirrorOf(session: AgentSessionHandle | null | undefined): RemoteAgentSession {
	if (!(session instanceof RemoteAgentSession)) throw new Error("expected a worker session mirror");
	return session;
}

async function mainSession(id: string): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: id,
	});
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
	});
	return session;
}

it("a running worker reads the parent's updated TODO resources over the real peer bridge", async () => {
	const session = await mainSession("ScopeLead");
	AgentRegistry.global().register({ id: "ScopeLead", displayName: "ScopeLead", kind: "main", session });
	const { probe } = await startWorker();
	const phases = [
		{
			name: "Work",
			tasks: [
				{ content: "Fix pipes", status: "in_progress" as const, schedule: { owner: "Pipes", resources: ["/old"] } },
			],
		},
	];
	session.setTodoPhases(phases);
	expect(await probe.peerResources("ScopeLead")).toEqual(["/old"]);
	phases[0]!.tasks[0]!.schedule.resources = ["/replacement"];
	session.setTodoPhases(phases);
	expect(await probe.peerResources("ScopeLead")).toEqual(["/replacement"]);
});

it("delivers hidden next-turn notices to a worker-homed session", async () => {
	const { probe } = await startWorker();
	await probe.open("W1", {});
	const mirror = mirrorOf(liveRef("W1").session);
	await mirror.sendCustomMessage(
		{ customType: "repeated-status-notice", content: "Already delivered", display: false, attribution: "agent" },
		{ deliverAs: "nextTurn", triggerTurn: false },
	);
	expect(await probe.localCustomTypes("W1")).toContain("repeated-status-notice");
	expect(mirror.isStreaming).toBe(false);
	await mirror.prompt("continue");
	expect(await probe.localCustomTypes("W1")).toContain("repeated-status-notice");
});

it("changes a worker-homed fast tier and refuses control by a different parent", async () => {
	const { probe } = await startWorker();
	await probe.open("W1", {});
	const ref = liveRef("W1");
	ref.parentId = "Lead";
	const mirror = mirrorOf(ref.session);
	const unsubscribe = mirror.subscribe(() => {});
	cleanups.push(unsubscribe);
	const model = mirror.model;
	if (!model) throw new Error("worker model missing");
	expect(await AgentRegistry.global().setSubagentFastMode("Other", "W1", true)).toBe(false);
	expect(mirror.effectiveServiceTier(model)).not.toBe("priority");
	expect(await AgentRegistry.global().setSubagentFastMode("Lead", "W1", true)).toBe(true);
	expect(mirror.effectiveServiceTier(model)).toBe("priority");
	expect(await mirror.setFastMode(false)).toBe(true);
	expect(mirror.effectiveServiceTier(model)).not.toBe("priority");
});

it("worker publication RPC fences main-thread restart capture until published", async () => {
	const { probe } = await startWorker();
	await probe.open("PublicationWorker", {});
	const ref = liveRef("PublicationWorker");
	const root = await mainSession("PublicationLead");
	AgentRegistry.global().register({
		id: "PublicationLead",
		displayName: "PublicationLead",
		kind: "main",
		session: root,
	});
	ref.parentId = "PublicationLead";
	// No persistence is needed: the pending fence must run before transcript
	// validation, and an accepted idle child needs no continuation snapshot.
	root.sessionManager.getSessionFile = () => "/fixture/publication-root.jsonl";
	expect(await probe.publication("PublicationWorker", "pending", 123)).toBe(true);
	expect(ref.lifecycle?.resultPublication).toBe("pending");
	await expect(captureSubagentsForRestart(root, { deadlineAt: Date.now() })).rejects.toThrow(
		"publication is still pending",
	);
	expect(await probe.publication("PublicationWorker", "published", 123)).toBe(true);
	expect(ref.lifecycle?.resultPublication).toBe("published");
	expect(ref.lifecycle?.acceptedAt).toBeNumber();
	await captureSubagentsForRestart(root);
});

describe("agent bridging across subagent workers", () => {
	it("drains and releases a worker journal through the restart owner", async () => {
		const { probe } = await startWorker();
		using temp = TempDir.createSync("omp-restart-worker-");
		await probe.openPersisted("RestartWorker", temp.path());
		const remote = mirrorOf(liveRef("RestartWorker").session);
		await remote.prompt("work before restart");
		const lease = remote.beginRestartDrain();
		await remote.sendRestartNotice({ customType: "restart-queued", content: "checkpoint pending", display: true });
		await lease.waitForQuiescence();
		await remote.flushRestartJournal();
		const entries = await remote.getRestartBranchEntries();
		expect(entries.some(entry => entry.type === "message" && entry.message.role === "user")).toBe(true);
		expect(remote.isStreaming).toBe(false);
		lease.release();
		expect(await remote.prompt("continue after cancelled restart")).toBe(true);
		await waitFor(() => !remote.isStreaming);
		expect(
			remote.messages.some(message => message.role === "custom" && message.customType === "restart-queued"),
		).toBe(true);
	});

	it("mirrors a real worker-homed AgentSession on main: streaming, run state, events, messages", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { gated: true });
		const ref = liveRef("W1");
		const remote = mirrorOf(ref.session);
		expect(remote.instanceKey).toBe(key);
		expect(remote.home).toBe(worker.threadId);
		expect(key.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(worker.load).toBe(1);

		const runStates: string[] = [];
		remote.subscribeRunState(state => runStates.push(state));
		const events: string[] = [];
		remote.subscribe(event => events.push(event.type));

		const prompting = remote.prompt("hello from main");
		await waitFor(() => remote.isStreaming && ref.status === "running");
		expect(remote.runStartedAt).toBeNumber();

		await probe.openGate();
		expect(await prompting).toBe(true);
		await waitFor(() => !remote.isStreaming && ref.status === "idle");
		const roles = remote.messages.map(message => message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
		expect(remote.agent.state.messages).toBe(remote.messages);
		expect(remote.getSessionStats().assistantMessages).toBeGreaterThan(0);
		expect(runStates).toEqual(["running", "idle"]);
		expect(events).toContain("agent_end");
	});

	it("republishes the message mirror after a history rewrite that keeps both endpoints", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		await probe.prompt("W1", "first");
		await probe.prompt("W1", "second");
		await waitFor(() => remote.messages.length >= 4);

		// Pruning rebuilds the runtime history with new interior content but the same first/last objects.
		await probe.rewriteInterior("W1", "pruned");
		await probe.prompt("W1", "third");

		await waitFor(() => remote.messages.length >= 6);
		const interior = remote.messages[1];
		expect(interior?.role === "assistant" ? interior.content : undefined).toEqual([{ type: "text", text: "pruned" }]);
	});

	it("fails a worker's registry CAS against a stale main ref generation", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const before = await probe.grab("W1");
		const registry = AgentRegistry.global();
		const replaced = registry.register({
			id: "W1",
			displayName: "W1",
			kind: "sub",
			session: liveRef("W1").session,
			status: "idle",
		});
		expect(replaced.generation).not.toBe(before);

		expect(await probe.cas("W1", "running")).toEqual({ grabbed: false, fresh: true, canonical: true });
		expect(registry.get("W1")?.status).toBe("running");
		expect(await probe.manages()).toBe(true);
	});

	it("lets a worker read a main-homed session through one canonical peer handle", async () => {
		const { probe } = await startWorker();
		const main = await mainSession("Main");
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: main,
			status: "running",
		});

		const report = await probe.peer("Main");
		expect(report).toEqual({
			isPeer: true,
			key: main.instanceKey,
			isStreaming: false,
			messageCount: 0,
			sessionFile: undefined,
			canonical: true,
			casBySession: true,
		});
		expect(liveRef("Main").status).toBe("idle");

		await probe.peerSubscribe("Main");
		expect(await probe.peerPrompt("Main", "hello from a worker")).toEqual({ accepted: true });
		expect(main.messages.map(message => message.role)).toContain("assistant");
		await waitFor(async () => {
			const seen = await probe.peerSeen();
			return seen.events.includes("agent_end") && seen.runStates.includes("idle");
		});
		expect((await probe.peerSeen()).runStates).toEqual(["running", "idle"]);
	});

	it("delivers an IRC message from main into a worker-homed session", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);

		const receipt = await IrcBus.global().send({ from: "Main", to: "W1", body: "ping from main" });
		expect(["injected", "woken"]).toContain(receipt.outcome);
		await waitFor(async () => (await probe.localCustomTypes("W1")).includes("irc:incoming"));
		await waitFor(() =>
			remote.messages.some(message => message.role === "custom" && message.customType === "irc:incoming"),
		);
	});

	it("queues IRC behind a worker child's brief and releases only the owning session's reservation", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", { initialPromptPending: true });
		await probe.open("Other", {});
		const ref = liveRef("W1");
		const remote = mirrorOf(ref.session);
		expect(await probe.clearInitialPromptPending("W1", "Other")).toBe(false);
		const receipt = await IrcBus.global().send({ from: "Main", to: "W1", body: "after the brief" });
		expect(receipt.outcome).toBe("injected");
		expect(await probe.localCustomTypes("W1")).toEqual([]);
		await probe.prompt("W1", "initial brief");
		await waitFor(() => remote.messages.some(message => message.role === "custom"));
		expect(remote.messages.map(message => message.role)).toEqual(["user", "assistant", "custom", "assistant"]);
		expect(await probe.clearInitialPromptPending("W1", "W1")).toBe(true);
		expect(ref.initialPromptPending).toBe(false);
		AgentRegistry.global().setStatus("W1", "running", ref);
		const wake = await IrcBus.global().send({ from: "Main", to: "W1", body: "a later turn" });
		expect(wake.outcome).toBe("woken");
	});

	it("detaches refs and rejects in-flight commands when the worker dies", async () => {
		const { worker, probe } = await startWorker();
		await probe.open("Parked", { sessionFile: "/tmp/agents-bridge-parked.jsonl", gated: true });
		await probe.open("Lost", {});
		await probe.adopt("Parked");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("Parked"));
		const parked = liveRef("Parked");
		const lost = liveRef("Lost");
		const remote = mirrorOf(parked.session);

		const pending = remote.prompt("never answered");
		await waitFor(() => remote.isStreaming);
		worker.terminate("killed by test");

		await expect(pending).rejects.toThrow(worker.threadId);
		expect(remote.closed).toBe(true);
		expect(parked.session).toBeNull();
		expect(parked.status).toBe("parked");
		expect(lost.session).toBeNull();
		expect(lost.status).toBe("aborted");
		// The adoption (and its release hook) survives; only the dead worker's warm reviver is gone.
		expect(lifecycle.has("Parked")).toBe(true);
		await expect(lifecycle.ensureLive("Parked")).rejects.toThrow("no reviver registered");
		await expect(remote.prompt("again")).rejects.toThrow(worker.threadId);
		await remote.dispose();
	});

	it("parks a worker-homed session and warm-revives it through the worker's reviver", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { sessionFile: "/tmp/agents-bridge-revive.jsonl" });
		await probe.adopt("W1");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("W1"));
		const ref = liveRef("W1");
		const first = mirrorOf(ref.session);

		await lifecycle.park("W1");
		expect(ref.status).toBe("parked");
		expect(ref.session).toBeNull();
		expect(first.closed).toBe(true);
		expect(await probe.disposed(key)).toBe(true);

		const revived = mirrorOf(await lifecycle.ensureLive("W1"));
		expect(revived).not.toBe(first);
		expect(revived.instanceKey.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(liveRef("W1").session).toBe(revived);
		expect(liveRef("W1").status).toBe("idle");
		expect(worker.load).toBe(1);
	});
});

describe("peer commands across worker threads", () => {
	it("executes on each target's home thread and preserves shell reply history", async () => {
		const { probe } = await startWorker();
		await probe.open("PeerWorker", {});
		const remote = mirrorOf(liveRef("PeerWorker").session);
		expect(await remote.executePeerSlashCommand("/rename Worker title")).toMatchObject({ outcome: "executed" });
		expect(await remote.executePeerSlashCommand("/session info")).toMatchObject({
			outcome: "executed",
			reason: expect.stringContaining("Title: Worker title"),
		});
		const main = await mainSession("PeerMain");
		AgentRegistry.global().register({
			id: "PeerMain",
			displayName: "PeerMain",
			kind: "main",
			session: main,
			sessionFile: null,
			status: "idle",
		});
		expect(await probe.peerCommand("PeerMain", "/rename Main title")).toMatchObject({ outcome: "executed" });
		expect(main.sessionManager.getSessionName()).toBe("Main title");
		expect(await remote.executePeerSlashCommand("/unknown-peer-command")).toBeNull();
		await IrcBus.global().send({ from: "shell:fixture", to: "PeerWorker", body: "hello" });
		expect(await probe.shellReplyTarget("PeerWorker")).toBe("shell:fixture");
	});
});
