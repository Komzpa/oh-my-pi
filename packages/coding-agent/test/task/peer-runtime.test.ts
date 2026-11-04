import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { listeningPorts, PeerRuntime } from "@oh-my-pi/pi-coding-agent/task/peer-runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});
it("actual SDK write produces a clash, gates yield, and accepts a structured agreement", async () => {
	using temp = TempDir.createSync("omp-peer-sdk-");
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
		expect((await yieldTool.execute("disjoint", { data: { ready: true } })).details?.status).toBe("success");
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
	using temp = TempDir.createSync("omp-peer-git-");
	const root = path.resolve(temp.path());
	// Fixture setup: the native VCS adapter has no repository initialization API.
	const init = Bun.spawnSync(["git", "init", "-q", "--initial-branch=main", root]);
	expect(init.exitCode).toBe(0);
	const file = path.join(root, "src/existing.txt");
	await Bun.write(file, "pre-existing dirty work");
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
