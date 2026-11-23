import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { VcsStatusOptions } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { checkPeerSessionHandover, listeningPorts, PeerRuntime } from "@oh-my-pi/pi-coding-agent/task/peer-runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});
it("actual SDK write produces a clash, gates yield, and accepts a structured agreement", async () => {
	using temp = TempDir.createSync("@omp-peer-sdk-");
	const root = path.resolve(temp.path());
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	const previous = AgentRegistry.global();
	const registry = new AgentRegistry();
	AgentRegistry.installGlobal(registry);
	try {
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		for (const id of ["WriterA", "ReviewerB"]) {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				agentId: id,
				parentTaskPrefix: id,
				parentAgentId: "parent",
				modelRegistry,
				model: getBundledModel("openai", "gpt-4o-mini"),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "plan.enabled": false }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["write", "yield"],
				requireYieldTool: true,
				peerCoordination: {
					task: id === "WriterA" ? "Implement" : "Review",
					profile: "task",
					scope: { root: root, paths: id === "WriterA" ? ["src"] : ["evidence"] },
					touched: [],
				},
			});
			sessions.push(session);
			vi.spyOn(session.agent, "prompt");
		}
		const writer = sessions[0];
		await Bun.sleep(0);
		expect(writer.agent.prompt).not.toHaveBeenCalled();
		expect(
			writer.agent.state.messages.some(
				message => message.role === "custom" && message.customType === "peer-coordination",
			),
		).toBe(true);
		const write = writer.getToolByName("write")!;
		await write.execute("write-owned", { path: path.join(root, "src/out.txt"), content: "owned" });
		const yieldTool = writer.getToolByName("yield")!;
		expect(await checkPeerSessionHandover(writer)).toBeUndefined();
		await write.execute("write-evidence", { path: path.join(root, "evidence/out.txt"), content: "proof" });
		expect(await Bun.file(path.join(root, "evidence/out.txt")).text()).toBe("proof");
		await expect(yieldTool.execute("refused", { data: { ready: true } })).rejects.toThrow("Handover refused");
		const deconfliction = [
			{
				peer: "ReviewerB",
				resource: `path:${path.join(root, "evidence/out.txt")}`,
				agreement: "Reviewer uses a separate directory",
			},
		];
		const accepted = await yieldTool.execute("accepted", { data: { ready: true }, deconfliction });
		expect(accepted.details).toMatchObject({ status: "success", deconfliction });
	} finally {
		for (const session of sessions.splice(0)) await session.dispose();
		AgentRegistry.installGlobal(previous);
		authStorage.close();
	}
});
it("observes edits to initially dirty files without blaming siblings for a shared branch change", async () => {
	using temp = TempDir.createSync("@omp-peer-git-");
	const root = path.resolve(temp.path());
	// Fixture setup: the native VCS adapter has no repository initialization API.
	const init = Bun.spawnSync(["git", "init", "-q", "--initial-branch=main", root]);
	expect(init.exitCode).toBe(0);
	const file = path.join(root, "src/existing.txt");
	const restored = path.join(root, "src/restored.txt");
	await Bun.write(file, "clean");
	await Bun.write(restored, "clean");
	expect(Bun.spawnSync(["git", "-C", root, "add", "src"]).exitCode).toBe(0);
	expect(
		Bun.spawnSync([
			"git",
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"baseline",
		]).exitCode,
	).toBe(0);
	await Bun.write(file, "pre-existing dirty work");
	await Bun.write(restored, "pre-existing dirty work");
	const registry = new AgentRegistry();
	for (const id of ["a", "b"])
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "parent",
			session: null,
			status: "running",
			history: {
				peerCoordination: {
					task: "Work",
					profile: "task",
					scope: { root, paths: ["src"], branch: "main" },
					touched: [],
				},
			},
		});
	const session = { subscribe: () => () => {}, sendCustomMessage: async () => false } as unknown as AgentSession;
	const runtime = new PeerRuntime(session, "a", root, registry);
	try {
		await runtime.initialize();
		const commit = Bun.spawnSync([
			"git",
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--allow-empty",
			"-qm",
			"lead commit",
		]);
		expect(commit.exitCode).toBe(0);
		expect(await runtime.checkHandover(undefined)).toBeUndefined();
		await Bun.write(file, "changed by the worker without a write hook");
		expect(await runtime.checkHandover(undefined)).toContain(`path:${file}`);
		expect(Bun.spawnSync(["git", "-C", root, "restore", "src/restored.txt"]).exitCode).toBe(0);
		expect(await Bun.file(restored).text()).toBe("clean");
		expect(await runtime.checkHandover(undefined)).toContain(`path:${restored}`);
	} finally {
		runtime.dispose();
	}
});
it.skipIf(process.platform !== "linux")("attributes a real listening TCP port only to its owning process", async () => {
	const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	try {
		expect(await listeningPorts([process.pid])).toContain(listener.port!);
		expect(await listeningPorts([2147483647])).not.toContain(listener.port!);
	} finally {
		listener.stop(true);
	}
});

function startupFixture(root: string) {
	root = path.resolve(root);
	expect(Bun.spawnSync(["git", "init", "-q", "--initial-branch=main", root]).exitCode).toBe(0);
	const registry = new AgentRegistry();
	for (const id of ["early", "peer"])
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "parent",
			session: null,
			status: "running",
			history: { peerCoordination: { task: "work", profile: "test", scope: { root, paths: ["src"] }, touched: [] } },
		});
	let emit: (event: AgentSessionEvent) => void = () => {};
	const session = {
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			emit = listener;
			return () => {
				emit = () => {};
			};
		},
		sendCustomMessage: async () => false,
	} as unknown as AgentSession;
	const repository = vcs.requireGit(root);
	const status = Promise.withResolvers<string>();
	let signal: AbortSignal | undefined;
	const statusSpy = vi.fn((_options: VcsStatusOptions, value?: unknown) => {
		signal = value as AbortSignal;
		return status.promise;
	});
	const observed = new Proxy(repository, {
		get(target, key) {
			if (key === "statusPorcelain") return statusSpy;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	vi.spyOn(vcs, "git").mockReturnValue(observed);
	const runtime = new PeerRuntime(session, "early", root, registry);
	return {
		registry,
		runtime,
		status,
		statusSpy,
		signal: () => signal,
		emit: (event: AgentSessionEvent) => emit(event),
	};
}
it("disposal aborts pending baseline and prevents late attribution or further repository work", async () => {
	using temp = TempDir.createSync("@omp-peer-dispose-");
	const fixture = startupFixture(temp.path());
	const initialization = fixture.runtime.initialize();
	fixture.runtime.dispose();
	expect(fixture.signal()?.aborted).toBe(true);
	await Bun.write(temp.join("src/late.txt"), "late");
	fixture.runtime.touch("src/late.txt");
	// Deliberately emulate a backend that resolves after cancellation.
	fixture.status.resolve("?? src/late.txt\0");
	await initialization;
	expect(await fixture.runtime.checkHandover(undefined)).toBeUndefined();
	expect(fixture.registry.get("early")?.history?.peerCoordination?.touched).toEqual([]);
	expect(fixture.statusSpy).toHaveBeenCalledTimes(1);
});
it("reconciles early unhooked edits and deletions without attributing untouched dirty or sibling paths (opt-in watcher)", async () => {
	const previousWatch = process.env.OMP_PEER_STARTUP_WATCH;
	process.env.OMP_PEER_STARTUP_WATCH = "1";
	try {
		using temp = TempDir.createSync("@omp-peer-early-");
		const fixture = startupFixture(temp.path());
		await Bun.write(temp.join(".gitignore"), "src/ignored.txt\n");
		await Bun.write(temp.join("src/dirty.txt"), "old dirty");
		await Bun.write(temp.join("src/untouched.txt"), "untouched dirty");
		await Bun.write(temp.join("src/deleted.txt"), "delete me");
		await Bun.write(temp.join("sibling/out.txt"), "sibling");
		const initialization = fixture.runtime.initialize();
		try {
			fixture.emit({
				type: "tool_execution_start",
				toolCallId: "shell",
				toolName: "bash",
				args: { command: "fixture" },
			});
			await Bun.write(temp.join("src/dirty.txt"), "early shell edit without mutation hook");
			await fs.rm(temp.join("src/deleted.txt"));
			await Bun.write(temp.join("src/new.txt"), "created after cached status snapshot");
			await Bun.write(temp.join("src/ignored.txt"), "ignored output");
			await Bun.write(temp.join("sibling/out.txt"), "other worker");
			await Bun.sleep(30);
			fixture.status.resolve("?? src/dirty.txt\0?? src/untouched.txt\0 D src/deleted.txt\0?? sibling/out.txt\0");
			await initialization;
			expect(fixture.registry.get("early")?.history?.peerCoordination?.touched.toSorted()).toEqual(
				[
					`path:${path.resolve(temp.join("src/deleted.txt"))}`,
					`path:${path.resolve(temp.join("src/dirty.txt"))}`,
					`path:${path.resolve(temp.join("src/new.txt"))}`,
				].toSorted(),
			);
			expect(await fixture.runtime.checkHandover(undefined)).toContain("src/dirty.txt");
		} finally {
			fixture.runtime.dispose();
		}
	} finally {
		if (previousWatch === undefined) delete process.env.OMP_PEER_STARTUP_WATCH;
		else process.env.OMP_PEER_STARTUP_WATCH = previousWatch;
	}
});
