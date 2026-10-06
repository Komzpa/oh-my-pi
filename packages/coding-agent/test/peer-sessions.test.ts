import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { Agent, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { PeersTool, type PeersToolDetails } from "@oh-my-pi/pi-coding-agent/tools/peers";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import {
	type PeerSessionPublication,
	type PeerSessionSnapshot,
	listPeerSessions,
	readShellReplies,
	publishPeerSession,
	resolvePeerSession,
	sendPeerMessage,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { runPeerSendCommand } from "@oh-my-pi/pi-coding-agent/cli/peers-cli";
import type { LoadMCPConfigsResult } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager, type MCPLoadResult } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { reloadMCPServers } from "@oh-my-pi/pi-coding-agent/mcp/reload";
import { callTool } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { TOOL_NAME, TOOL_RESULT } from "./fixtures/delayed-tool-mcp";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { getMCPConfigPath, prompt } from "@oh-my-pi/pi-utils";
import ircIncomingTemplate from "../src/prompts/system/irc-incoming.md" with { type: "text" };
import * as peersCli from "../src/cli/peers-cli";

const cleanupDirs: string[] = [];
const publications: PeerSessionPublication[] = [];
const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];

afterEach(async () => {
	for (const pub of publications.splice(0)) await pub.close();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const dir of cleanupDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const base = path.resolve(import.meta.dir, "../../../tmp");
	await fs.mkdir(base, { recursive: true });
	const dir = await fs.mkdtemp(path.join(base, "omp-peer-"));
	cleanupDirs.push(dir);
	return dir;
}

function fakeSession(outcome: "injected" | "woken", seen: IrcMessage[]): AgentSession {
	return {
		customCommands: [],
		slashCommands: [],
		promptTemplates: [],
		deliverIrcMessage: async (message: IrcMessage) => {
			seen.push(message);
			return outcome;
		},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

async function publishFixture(
	dir: string,
	options: {
		sessionId: string | (() => string);
		cwd: string;
		title?: string;
		outcome?: "injected" | "woken";
		agentId?: string;
		command?: (args: string) => void;
		commandName?: string;
		deliver?: (message: IrcMessage) => Promise<"injected" | "woken">;
		reloadMCP?: () => Promise<MCPLoadResult>;
	},
): Promise<{ delivered: IrcMessage[]; snapshot: PeerSessionSnapshot; registry: AgentRegistry; irc: IrcBus }> {
	const registry = new AgentRegistry();
	const delivered: IrcMessage[] = [];
	const agentId = options.agentId ?? MAIN_AGENT_ID;
	let session = fakeSession(options.outcome ?? "woken", delivered);
	if (options.command || options.reloadMCP) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi =>
				pi.registerCommand(options.commandName ?? "known-command", {
					handler: async args => options.command?.(args),
				}),
			options.cwd,
			new EventBus(),
			runtime,
			"peer-command-fixture",
		);
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(options.cwd);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: createMockModel({ responses: [] }).stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			reloadOwnedMcpManager: options.reloadMCP,
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, options.cwd, sessionManager, modelRegistry),
		});
		session.deliverIrcMessage = fakeSession(options.outcome ?? "woken", delivered).deliverIrcMessage;
		sessions.push(session);
	}
	if (options.deliver) {
		session.deliverIrcMessage = async message => {
			delivered.push(message);
			return options.deliver!(message);
		};
	}
	registry.register({
		id: agentId,
		displayName: agentId,
		kind: agentId === MAIN_AGENT_ID ? "main" : "sub",
		session,
	});
	const irc = new IrcBus(registry);
	const pub = await publishPeerSession({
		dir,
		sessionId: options.sessionId,
		cwd: options.cwd,
		title: () => options.title ?? null,
		mainAgentId: MAIN_AGENT_ID,
		registry,
		irc,
	});
	publications.push(pub);
	const sessionId = typeof options.sessionId === "string" ? options.sessionId : options.sessionId();
	const snapshot = (await listPeerSessions({ dir })).find(peer => peer.sessionId === sessionId);
	if (!snapshot) throw new Error("published peer session was not listed");
	return { delivered, snapshot, registry, irc };
}

describe("peer sessions", () => {
	it("CF67 resolves bare shell writes from the received sender and rejects ambiguous or unknown targets", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-bare-shell", cwd: dir });
		const bus = spyOn(IrcBus, "global").mockReturnValue(target.irc);
		const session = {
			cwd: dir,
			hasUI: false,
			agentRegistry: target.registry,
			getAgentId: () => MAIN_AGENT_ID,
			getSessionId: () => "sess-bare-shell",
			settings: Settings.isolated(),
		} as ToolSession;
		const handler = new AgentProtocolHandler({ dir });
		const write = (to: string) => handler.write(parseInternalUrl(`agent://${to}`), "pong", { session });
		try {
			const sent = await sendPeerMessage({
				registry: { dir },
				from: { kind: "shell" },
				target: target.snapshot.instanceId,
				text: "ping",
			});
			const address = sent.replyTo!.replace("agent://", "");
			const message = target.delivered[0]!;
			const visible = prompt.render(ircIncomingTemplate, { from: message.from, message: message.body });
			expect((await write("shell")).isError).toBe(false);
			expect(visible).toContain(`reply: write agent://${address}`);
			expect(await readShellReplies(address, { dir })).toEqual([
				expect.objectContaining({ text: "pong", from: "peer:sess-bare-shell" }),
			]);
			const unknown = await write("missing-non-shell-agent");
			expect(unknown.isError).toBe(true);
			const unknownText = unknown.content[0];
			expect(unknownText?.type === "text" ? unknownText.text : "").toContain(
				'Unknown agent "missing-non-shell-agent"',
			);
			const second = await sendPeerMessage({
				registry: { dir },
				from: { kind: "shell" },
				target: target.snapshot.instanceId,
				text: "second ping",
			});
			const ambiguous = await write("shell");
			expect(ambiguous.isError).toBe(true);
			const ambiguousContent = ambiguous.content[0];
			const ambiguousText = ambiguousContent?.type === "text" ? ambiguousContent.text : "";
			expect(ambiguousText).toContain(address);
			expect(ambiguousText).toContain(second.replyTo!.replace("agent://", ""));
			expect(ambiguousText).not.toContain("roster");
			expect(await readShellReplies(second.replyTo!.replace("agent://", ""), { dir })).toEqual([]);
		} finally {
			bus.mockRestore();
		}
	});

	it("keeps SDK peer identity and replies live across new and resumed conversations, fencing old generations", async () => {
		const dir = await tempDir();
		const previousDir = process.env.OMP_PEER_SESSIONS_DIR;
		process.env.OMP_PEER_SESSIONS_DIR = dir;
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const sessionManager = SessionManager.create(dir, path.join(dir, "sessions"));
		await sessionManager.ensureOnDisk();
		const originalId = sessionManager.getSessionId();
		const originalFile = sessionManager.getSessionFile()!;
		let session: AgentSession | undefined;
		try {
			({ session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				toolNames: [],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				rules: [],
				workspaceTree: { rootPath: dir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				publishPeerSession: true,
			}));
			const replies: IrcMessage[] = [];
			session.deliverIrcMessage = fakeSession("woken", replies).deliverIrcMessage;
			const first = await resolvePeerSession(`peer:${originalId}`, { dir });
			const metaName = (await fs.readdir(dir)).find(name => name.endsWith(".json"));
			if (!metaName) throw new Error("missing SDK publication metadata");
			const metadata = JSON.parse(await fs.readFile(path.join(dir, metaName), "utf8")) as {
				endpoint: string;
				token: string;
			};
			const staleSend = async (generation: number): Promise<unknown> => {
				const result = Promise.withResolvers<unknown>();
				const socket = net.createConnection(metadata.endpoint);
				let response = "";
				socket.setEncoding("utf8");
				socket.setTimeout(1500, () => socket.destroy(new Error("fixture IPC timed out")));
				socket.on("error", result.reject);
				socket.on("data", chunk => {
					response += chunk;
				});
				socket.on("end", () => {
					try {
						result.resolve(JSON.parse(response));
					} catch (error) {
						result.reject(error);
					}
				});
				socket.on("connect", () =>
					socket.write(
						`${JSON.stringify({
							v: 1,
							token: metadata.token,
							op: "send",
							instanceId: first.instanceId,
							generation,
							from: { kind: "shell" },
							text: "stale conversation message",
						})}\n`,
					),
				);
				return result.promise;
			};
			const target = await publishFixture(dir, { sessionId: "sess-transition-target", cwd: dir });
			let previous = first;
			for (const transition of [() => session!.newSession(), () => session!.switchSession(originalFile)]) {
				expect(await transition()).toBe(true);
				const currentId = sessionManager.getSessionId();
				const current = await resolvePeerSession(`peer:${currentId}`, { dir });
				expect(current.instanceId).toBe(first.instanceId);
				expect(current.generation).toBe(previous.generation + 1);
				await expect(resolvePeerSession(`peer:${previous.sessionId}`, { dir })).rejects.toMatchObject({
					code: "not_found",
				});
				expect(await staleSend(previous.generation)).toMatchObject({ ok: false, error: "stale_generation" });
				const receipt = await sendPeerMessage({
					registry: { dir },
					target: target.snapshot.instanceId,
					text: `status from ${currentId}?`,
					from: { kind: "session", sessionId: currentId, cwd: dir },
				});
				expect(receipt.status).toBe("delivered");
				const reply = await new AgentProtocolHandler({ dir }).write(
					parseInternalUrl(`agent://${target.delivered.at(-1)!.from}`),
					"reply to current conversation",
					{
						session: {
							cwd: dir,
							hasUI: false,
							agentRegistry: target.registry,
							getAgentId: () => MAIN_AGENT_ID,
							getSessionId: () => "sess-transition-target",
							settings: Settings.isolated(),
						} as ToolSession,
					},
				);
				expect(reply.isError).toBe(false);
				expect(replies.at(-1)?.body).toContain("reply to current conversation");
				previous = current;
			}
			expect(replies).toHaveLength(2);
			session.deliverIrcMessage = async () => {
				throw new Error("fixture live handoff failed");
			};
			const failed = await sendPeerMessage({
				registry: { dir },
				from: { kind: "shell" },
				target: first.instanceId,
				text: "recover through existing wait",
			});
			expect(failed.status).toBe("failed");
			const waited = await new WaitTool({
				cwd: dir,
				settings: Settings.isolated({ "launch.enabled": false }),
				agentRegistry: AgentRegistry.global(),
				getAgentId: () => MAIN_AGENT_ID,
			} as ToolSession).execute("recover-peer-handoff", {});
			expect(waited.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("recover through existing wait") }),
			]);
			expect(IrcBus.global().take(MAIN_AGENT_ID)).toBeUndefined();
		} finally {
			await session?.dispose();
			if (previousDir === undefined) delete process.env.OMP_PEER_SESSIONS_DIR;
			else process.env.OMP_PEER_SESSIONS_DIR = previousDir;
		}
		expect((await listPeerSessions({ dir })).some(peer => peer.sessionId === originalId)).toBe(false);
	});

	it("dispatches one accepted request only once when trailing chunks arrive during a slow slash command", async () => {
		const dir = await tempDir();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const target = await publishFixture(dir, {
			sessionId: "sess-chunked-command",
			cwd: dir,
			command: async () => {
				calls++;
				started.resolve();
				await release.promise;
			},
		});
		const metaName = (await fs.readdir(dir)).find(name => name.endsWith(".json"));
		const metadata = JSON.parse(await fs.readFile(path.join(dir, metaName!), "utf8")) as {
			endpoint: string;
			token: string;
		};
		const receipt = Promise.withResolvers<unknown>();
		receipt.promise.catch(() => {});
		const socket = net.createConnection(metadata.endpoint);
		let response = "";
		socket.setEncoding("utf8");
		socket.on("error", receipt.reject);
		socket.on("data", chunk => {
			response += chunk;
		});
		socket.on("end", () => {
			try {
				receipt.resolve(JSON.parse(response));
			} catch (error) {
				receipt.reject(error);
			}
		});
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			socket.on("connect", () =>
				socket.write(
					`${JSON.stringify({
						v: 1,
						token: metadata.token,
						op: "send",
						instanceId: target.snapshot.instanceId,
						generation: target.snapshot.generation,
						from: { kind: "shell", id: "a".repeat(32) },
						text: "/known-command",
					})}\n`,
				),
			);
			await started.promise;
			// Move beyond the sender limit so it cannot conceal duplicate dispatch.
			now += 1001;
			socket.write("trailing bytes");
			await Bun.sleep(30);
			expect(calls).toBe(1);
			release.resolve();
			expect(await receipt.promise).toMatchObject({ ok: true, receipt: { status: "delivered" } });
		} finally {
			clock.mockRestore();
			release.resolve();
			socket.destroy();
		}
	});

	it("reserves a sender slot during pending delivery and releases it after a failed handoff", async () => {
		const dir = await tempDir();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const target = await publishFixture(dir, {
			sessionId: "sess-pending-send",
			cwd: dir,
			deliver: async () => {
				if (++calls === 1) {
					started.resolve();
					await release.promise;
					throw new Error("handoff failed");
				}
				return "woken";
			},
		});
		const request = {
			registry: { dir },
			target: target.snapshot.instanceId,
			text: "one sender",
			from: { kind: "session" as const, sessionId: "sess-same-sender", cwd: dir },
		};
		const first = sendPeerMessage(request);
		try {
			await started.promise;
			await expect(sendPeerMessage(request)).rejects.toMatchObject({ code: "rate_limited" });
			expect(calls).toBe(1);
			release.resolve();
			expect(await first).toMatchObject({ status: "failed", reason: "handoff failed" });
			expect(await sendPeerMessage(request)).toMatchObject({ status: "delivered" });
			expect(calls).toBe(2);
		} finally {
			release.resolve();
			await first;
		}
	});

	it("releases a failed sender reservation when the transport rejects", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-rejected-send", cwd: dir });
		const rejected = spyOn(target.irc, "send").mockRejectedValueOnce(new Error("fixture transport rejected"));
		try {
			const request = {
				registry: { dir },
				target: target.snapshot.instanceId,
				text: "retry after rejection",
				from: { kind: "session" as const, sessionId: "sess-rejected-sender", cwd: dir },
			};
			await expect(sendPeerMessage(request)).rejects.toMatchObject({ code: "delivery_uncertain" });
			expect(await sendPeerMessage(request)).toMatchObject({ status: "delivered" });
		} finally {
			rejected.mockRestore();
		}
	});

	it("does not let an old generation's failed delivery release the new generation's sender reservation", async () => {
		const dir = await tempDir();
		let identity = "sess-before-transition";
		let calls = 0;
		const oldStarted = Promise.withResolvers<void>();
		const newStarted = Promise.withResolvers<void>();
		const oldRelease = Promise.withResolvers<void>();
		const newRelease = Promise.withResolvers<void>();
		const target = await publishFixture(dir, {
			sessionId: () => identity,
			cwd: dir,
			deliver: async () => {
				if (++calls === 1) {
					oldStarted.resolve();
					await oldRelease.promise;
					throw new Error("old conversation failed");
				}
				if (calls === 2) {
					newStarted.resolve();
					await newRelease.promise;
				}
				return "woken";
			},
		});
		const request = {
			registry: { dir },
			target: target.snapshot.instanceId,
			text: "stable sender across target transition",
			from: { kind: "session" as const, sessionId: "sess-generation-sender", cwd: dir },
		};
		const oldSend = sendPeerMessage(request);
		let newSend: Promise<unknown> | undefined;
		try {
			await oldStarted.promise;
			identity = "sess-after-transition";
			expect((await resolvePeerSession(`peer:${identity}`, { dir })).generation).toBe(
				target.snapshot.generation + 1,
			);
			newSend = sendPeerMessage(request);
			await newStarted.promise;
			oldRelease.resolve();
			expect(await oldSend).toMatchObject({ status: "failed" });
			await expect(sendPeerMessage(request)).rejects.toMatchObject({ code: "rate_limited" });
			expect(calls).toBe(2);
			newRelease.resolve();
			expect(await newSend).toMatchObject({ status: "delivered" });
		} finally {
			oldRelease.resolve();
			newRelease.resolve();
			await oldSend;
			await newSend;
		}
	});

	it("accepts a decoded 16 KiB escaped-newline message and rejects one byte over the decoded limit", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-large-message", cwd: dir });
		const text = `x${"\n".repeat(16 * 1024 - 1)}`;
		expect(Buffer.byteLength(text)).toBe(16 * 1024);
		expect(Buffer.byteLength(JSON.stringify(text))).toBeGreaterThan(24 * 1024);
		const receipt = await sendPeerMessage({
			registry: { dir },
			from: { kind: "shell" },
			target: target.snapshot.instanceId,
			text,
		});
		expect(receipt.status).toBe("delivered");
		expect(target.delivered[0]?.body).toBe(`${text}\n\n[from shell]`);
		await expect(
			sendPeerMessage({
				registry: { dir },
				from: { kind: "shell" },
				target: target.snapshot.instanceId,
				text: `${text}x`,
			}),
		).rejects.toMatchObject({ code: "invalid_message" });
		expect(target.delivered).toHaveLength(1);
	});

	it("returns exit code one for failed delivery receipts in both JSON and human CLI output", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, {
			sessionId: "sess-cli-refusal",
			cwd: dir,
			command: () => {
				throw new Error("command refused by fixture");
			},
		});
		for (const json of [true, false]) {
			for (const request of [{ text: "hello", agent: "unknown-agent" }, { text: "/known-command" }]) {
				const output: string[] = [];
				const errors: string[] = [];
				const code = await runPeerSendCommand(
					{
						target: target.snapshot.instanceId,
						registry: { dir },
						json,
						...request,
					},
					line => output.push(line),
					line => errors.push(line),
				);
				expect(code).toBe(1);
				if (json) {
					expect(JSON.parse(output.join("\n"))).toMatchObject({ status: "failed" });
					expect(errors).toEqual([]);
				} else {
					expect(errors[0]).toStartWith("failed:");
					expect(output).toEqual([]);
				}
			}
		}
	});
	it("peer /mcp reload connects and exposes an actual tool rather than refreshing command metadata", async () => {
		const dir = await tempDir();
		const manager = new MCPManager(dir, null, async () => ({
			configs: {
				fixture: {
					type: "stdio",
					command: process.execPath,
					args: [path.join(import.meta.dir, "fixtures/delayed-tool-mcp.ts")],
				},
			},
			sources: {},
			exaApiKeys: [],
		}));
		const mounted = Promise.withResolvers<void>();
		manager.setOnToolsChanged(async tools => {
			if (!tools.length) return;
			await sessions.at(-1)!.refreshMCPTools(tools);
			mounted.resolve();
		});
		try {
			const target = await publishFixture(dir, {
				sessionId: "sess-mcp-reload",
				cwd: dir,
				reloadMCP: async () => {
					const session = sessions.at(-1)!;
					return reloadMCPServers(session, manager, session.settings);
				},
			});
			const receipt = await sendPeerMessage({
				target: target.snapshot.instanceId,
				text: "/mcp reload",
				from: { kind: "shell" },
				registry: { dir },
			});
			expect(receipt.outcome).toBe("executed");
			await mounted.promise;
			expect(manager.getConnectedServers()).toEqual(["fixture"]);
			expect(manager.getTools()).toHaveLength(1);

			expect(sessions.at(-1)!.getToolByName(manager.getTools()[0]!.name)).toBeDefined();
			const connection = await manager.waitForConnection("fixture");
			expect((await callTool(connection, TOOL_NAME)).content).toEqual([{ type: "text", text: TOOL_RESULT }]);
		} finally {
			await manager.disconnectAll();
		}
	}, 5000);

	it("refuses peer MCP reload on an unowned runtime and while a target turn is in flight", async () => {
		const dir = await tempDir();
		const unowned = await publishFixture(dir, { sessionId: "sess-no-runtime", cwd: dir, command: () => {} });
		const refusal = await sendPeerMessage({
			target: unowned.snapshot.instanceId,
			text: "/mcp reload",
			from: { kind: "shell" },
			registry: { dir },
		});
		expect(refusal.status).toBe("failed");
		expect(refusal.reason).toContain("does not own an MCP runtime");
		let calls = 0;
		const busy = await publishFixture(dir, {
			sessionId: "sess-busy-runtime",
			cwd: dir,
			reloadMCP: async () => {
				calls++;
				return { tools: [], errors: new Map(), connectedServers: [], exaApiKeys: [] };
			},
		});
		const session = sessions.at(-1)!;
		session.agent.state.isStreaming = true;
		try {
			const receipt = await sendPeerMessage({
				target: busy.snapshot.instanceId,
				text: "/mcp reload",
				from: { kind: "shell" },
				registry: { dir },
			});
			expect(receipt.status).toBe("failed");
			expect(receipt.reason).toContain("idle session");
			expect(calls).toBe(0);
		} finally {
			session.agent.state.isStreaming = false;
		}
	});

	it("coalesces concurrent owned MCP reloads without disconnecting twice", async () => {
		const dir = await tempDir();
		const pending = Promise.withResolvers<MCPLoadResult>();
		let calls = 0;
		await publishFixture(dir, {
			sessionId: "sess-coalesced-runtime",
			cwd: dir,
			reloadMCP: () => {
				calls++;
				return pending.promise;
			},
		});
		const session = sessions.at(-1)!;
		const first = session.reloadMCPRuntime();
		const second = session.reloadMCPRuntime();
		expect(first).toBe(second);
		expect(calls).toBe(1);
		pending.resolve({ tools: [], errors: new Map(), connectedServers: [], exaApiKeys: [] });
		await first;
	});

	it("drains transports when the target is disposed while MCP config discovery is pending", async () => {
		const dir = await tempDir();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const manager = new MCPManager(dir, null, async (): Promise<LoadMCPConfigsResult> => {
			started.resolve();
			await release.promise;
			return {
				configs: {
					fixture: {
						type: "stdio",
						command: process.execPath,
						args: [path.join(import.meta.dir, "fixtures/many-tools-mcp.ts")],
					},
				},
				sources: {},
				exaApiKeys: [],
			};
		});
		await publishFixture(dir, {
			sessionId: "sess-disposed-reload",
			cwd: dir,
			reloadMCP: () => {
				const session = sessions.at(-1)!;
				return reloadMCPServers(session, manager, session.settings);
			},
		});
		const session = sessions.at(-1)!;
		const pending = session.reloadMCPRuntime();
		try {
			await started.promise;
			await session.dispose();
			release.resolve();
			await expect(pending).rejects.toThrow("disposed during MCP reload");
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			release.resolve();
			await manager.disconnectAll();
		}
	}, 5000);

	it("does not let paused old startup discovery resurrect a server after peer reload", async () => {
		const dir = await tempDir();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let loads = 0;
		const fixture = {
			type: "stdio" as const,
			command: process.execPath,
			args: [path.join(import.meta.dir, "fixtures/many-tools-mcp.ts")],
		};
		const manager = new MCPManager(dir, null, async (): Promise<LoadMCPConfigsResult> => {
			if (++loads === 1) {
				started.resolve();
				await release.promise;
				return { configs: { removed: fixture }, sources: {}, exaApiKeys: [] };
			}
			return { configs: { current: fixture }, sources: {}, exaApiKeys: [] };
		});
		await publishFixture(dir, {
			sessionId: "sess-startup-reload",
			cwd: dir,
			reloadMCP: () => {
				const session = sessions.at(-1)!;
				return reloadMCPServers(session, manager, session.settings);
			},
		});
		const startup = manager.discoverAndConnect();
		const startupOutcome = startup.then(
			() => "unexpectedly connected",
			error => String(error),
		);
		try {
			await started.promise;
			await sessions.at(-1)!.reloadMCPRuntime();
			await manager.waitForConnection("current");
			release.resolve();
			expect(await startupOutcome).toContain("superseded by disconnect/reload");
			expect(manager.getConnectedServers()).toEqual(["current"]);
			expect(manager.getTools().every(tool => tool.mcpServerName === "current")).toBe(true);
		} finally {
			release.resolve();
			await startupOutcome;
			await manager.disconnectAll();
		}
	}, 5000);

	it("delivers a shell reply to the address advertised by the incoming footer and reads it from the CLI inbox", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-shell-reply", cwd: dir });
		const sent: string[] = [];
		expect(
			await runPeerSendCommand(
				{ target: target.snapshot.instanceId, text: "status?", json: true, registry: { dir } },
				line => sent.push(line),
			),
		).toBe(0);
		const message = target.delivered[0]!;
		const footer = prompt.render(ircIncomingTemplate, {
			from: message.from,
			message: message.body,
			relayOnStop: false,
		});
		const address = footer.match(/path: "(agent:\/\/[^"\s]+)"/)?.[1];
		expect(address).toBeTruthy();
		const result = await new AgentProtocolHandler({ dir }).write(parseInternalUrl(address!), "shell answer", {
			session: {
				cwd: dir,
				hasUI: false,
				agentRegistry: target.registry,
				getAgentId: () => MAIN_AGENT_ID,
				getSessionId: () => "sess-shell-reply",
				settings: Settings.isolated(),
			} as ToolSession,
		});
		expect(result.isError).toBe(false);
		const receipt = JSON.parse(sent.join("\n"));
		expect(receipt.replyTo).toBe(address);
		const inbox: string[] = [];
		expect(
			await peersCli.runPeerInboxCommand(
				{ address: receipt.replyTo.replace("agent://", ""), json: true, registry: { dir } },
				line => inbox.push(line),
			),
		).toBe(0);
		expect(JSON.parse(inbox.join("\n")).replies).toEqual([
			expect.objectContaining({ text: "shell answer", from: "peer:sess-shell-reply" }),
		]);
		if (process.platform !== "win32") {
			const id = message.from.replace("shell:", "");
			expect((await fs.stat(path.join(dir, "shell-inboxes"))).mode & 0o077).toBe(0);
			expect((await fs.stat(path.join(dir, "shell-inboxes", `${id}.jsonl`))).mode & 0o077).toBe(0);
		}
	});

	it("still rejects an unknown agent id with a clear error", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-negative", cwd: dir });
		const result = await new AgentProtocolHandler({ dir }).write(
			parseInternalUrl("agent://missing-agent"),
			"answer",
			{
				session: {
					cwd: dir,
					hasUI: false,
					agentRegistry: target.registry,
					getAgentId: () => MAIN_AGENT_ID,
					getSessionId: () => "sess-negative",
					settings: Settings.isolated(),
				} as ToolSession,
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining('Unknown agent "missing-agent"') }),
		]);
	});

	it("keeps replies readable from another CLI process after the shell sender exits", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-exited-shell", cwd: dir });
		const cli = path.resolve(import.meta.dir, "../src/cli.ts");
		const run = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, cli, "peers", ...args], {
				cwd: dir,
				env: { ...process.env, OMP_PEER_SESSIONS_DIR: dir },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(stderr).toBe("");
			expect(exit).toBe(0);
			return JSON.parse(stdout);
		};
		const sent = await run("send", target.snapshot.instanceId, "answer after I exit", "--json");
		const result = await new AgentProtocolHandler({ dir }).write(parseInternalUrl(sent.replyTo), "durable answer", {
			session: {
				cwd: dir,
				hasUI: false,
				agentRegistry: target.registry,
				getAgentId: () => MAIN_AGENT_ID,
				getSessionId: () => "sess-exited-shell",
				settings: Settings.isolated(),
			} as ToolSession,
		});
		expect(result.isError).toBe(false);
		const address = sent.replyTo.replace("agent://", "");
		const firstRead = await run("inbox", address, "--json");
		expect(firstRead.replies).toHaveLength(1);
		expect(firstRead.replies[0].text).toBe("durable answer");
		expect(await run("inbox", address, "--json")).toEqual(firstRead);
	});

	it("rejects an unknown shell inbox rather than creating one", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-missing-shell", cwd: dir });
		const address = `shell:${"a".repeat(32)}`;
		const result = await new AgentProtocolHandler({ dir }).write(parseInternalUrl(`agent://${address}`), "answer", {
			session: {
				cwd: dir,
				hasUI: false,
				agentRegistry: target.registry,
				getAgentId: () => MAIN_AGENT_ID,
				settings: Settings.isolated(),
			} as ToolSession,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: `unknown shell reply address: ${address}` });
		const lines: string[] = [];
		expect(
			await peersCli.runPeerInboxCommand({ address, json: true, registry: { dir } }, line => lines.push(line)),
		).toBe(1);
		expect(JSON.parse(lines[0]!)).toMatchObject({ error: "not_found" });
	});

	it("delivers a shell message to an idle peer through the target IRC bus", async () => {
		const dir = await tempDir();
		const { delivered, snapshot } = await publishFixture(dir, {
			sessionId: "sess-sunbim",
			cwd: "/home/kom/proj/sunbim/datacenter-decision-graph",
			title: "Sunbim main",
			outcome: "woken",
		});

		const receipt = await sendPeerMessage({
			registry: { dir },
			from: { kind: "shell" },
			target: "sunbim",
			text: "status?",
		});

		expect(receipt).toMatchObject({
			status: "delivered",
			outcome: "woken",
			target: snapshot.instanceId,
			agent: MAIN_AGENT_ID,
		});
		expect(delivered).toHaveLength(1);
		expect(receipt.replyTo).toBe(`agent://${delivered[0]!.from}`);
		expect(delivered[0]).toMatchObject({
			from: expect.stringMatching(/^shell:[a-f0-9]{32}$/),
			to: MAIN_AGENT_ID,
			body: "status?\n\n[from shell]",
		});
	});

	it("delivers a peer-session sender to a busy target as an IRC aside", async () => {
		const dir = await tempDir();
		const { delivered } = await publishFixture(dir, {
			sessionId: "sess-busy",
			cwd: "/tmp/busy-project",
			title: "Busy target",
			outcome: "injected",
		});

		const receipt = await sendPeerMessage({
			registry: { dir },
			from: { kind: "session", sessionId: "sess-sender", cwd: "/tmp/sender" },
			target: "busy",
			text: "background note",
		});

		expect(receipt.status).toBe("delivered");
		expect(receipt.outcome).toBe("injected");
		expect(delivered[0]?.from).toBe("peer:sess-sender");
		expect(delivered[0]?.body).toBe("background note\n\n[from session sess-sender cwd /tmp/sender]");
	});

	it("executes a registered peer slash command with arguments instead of injecting IRC", async () => {
		const dir = await tempDir();
		const calls: string[] = [];
		const { snapshot, delivered } = await publishFixture(dir, {
			sessionId: "sess-command",
			cwd: dir,
			command: args => calls.push(args),
		});
		const receipt = await sendPeerMessage({
			registry: { dir },
			from: { kind: "shell" },
			target: snapshot.instanceId,
			text: "/known-command exact arguments",
		});
		expect(calls).toEqual(["exact arguments"]);
		expect(receipt).toMatchObject({ status: "delivered", outcome: "executed" });
		expect(delivered).toHaveLength(0);
	});

	it("dispatches an exact registered namespaced command before builtin colon shorthand", async () => {
		const dir = await tempDir();
		const calls: string[] = [];
		const { snapshot, delivered } = await publishFixture(dir, {
			sessionId: "sess-namespaced-command",
			cwd: dir,
			commandName: "mcp:foo",
			command: args => calls.push(args),
		});
		const receipt = await sendPeerMessage({
			registry: { dir },
			from: { kind: "shell" },
			target: snapshot.instanceId,
			text: "/mcp:foo exact arguments",
		});
		expect(calls).toEqual(["exact arguments"]);
		expect(receipt).toMatchObject({ status: "delivered", outcome: "executed" });
		expect(delivered).toHaveLength(0);
	});

	it("reports command refusal instead of claiming injected delivery", async () => {
		const dir = await tempDir();
		const { snapshot } = await publishFixture(dir, {
			sessionId: "sess-refused",
			cwd: dir,
			command: () => {
				throw new Error("command refused by fixture");
			},
		});
		const receipt = await sendPeerMessage({
			registry: { dir },
			from: { kind: "shell" },
			target: snapshot.instanceId,
			text: "/known-command",
		});
		expect(receipt).toMatchObject({ status: "failed", reason: "command refused by fixture" });
	});

	it("routes the advertised agent://peer:<senderId> reply back over peer transport", async () => {
		const dir = await tempDir();
		const sender = await publishFixture(dir, { sessionId: "sess-sender", cwd: path.join(dir, "sender") });
		const target = await publishFixture(dir, { sessionId: "sess-target", cwd: path.join(dir, "target") });
		await sendPeerMessage({
			registry: { dir },
			from: { kind: "session", sessionId: "sess-sender", cwd: dir },
			target: target.snapshot.instanceId,
			text: "status?",
		});
		const replyTo = target.delivered[0]!.from;
		const result = await new AgentProtocolHandler({ dir }).write(
			parseInternalUrl(`agent://${replyTo}`),
			"reply from target",
			{
				session: {
					cwd: dir,
					hasUI: false,
					agentRegistry: target.registry,
					getAgentId: () => MAIN_AGENT_ID,
					getSessionId: () => "sess-target",
					settings: Settings.isolated(),
				} as ToolSession,
			},
		);
		expect(result.isError).toBe(false);
		expect(sender.delivered[0]).toMatchObject({
			from: "peer:sess-target",
			body: `reply from target\n\n[from session sess-target cwd ${dir}]`,
		});
	});

	it("keeps an unregistered slash name in IRC rather than executing a partial match", async () => {
		const dir = await tempDir();
		const { snapshot, delivered } = await publishFixture(dir, { sessionId: "sess-unknown", cwd: dir });
		const receipt = await sendPeerMessage({
			registry: { dir },
			from: { kind: "shell" },
			target: snapshot.instanceId,
			text: "/known-command-extra args",
		});
		expect(receipt).toMatchObject({ status: "delivered", outcome: "woken" });
		expect(delivered[0]?.body).toBe("/known-command-extra args\n\n[from shell]");
	});

	it("resolves exact ids, unique prefixes, cwd fragments, titles, and reports ambiguity with candidates", async () => {
		const dir = await tempDir();
		const first = await publishFixture(dir, {
			sessionId: "sess-alpha",
			cwd: "/work/alpha",
			title: "Alpha parser",
		});
		await publishFixture(dir, { sessionId: "sess-beta", cwd: "/work/beta", title: "Beta parser" });

		expect((await resolvePeerSession(first.snapshot.instanceId, { dir })).instanceId).toBe(first.snapshot.instanceId);
		expect((await resolvePeerSession(first.snapshot.instanceId.slice(0, 10), { dir })).sessionId).toBe("sess-alpha");
		expect((await resolvePeerSession("/work/beta", { dir })).sessionId).toBe("sess-beta");
		expect((await resolvePeerSession("Alpha", { dir })).sessionId).toBe("sess-alpha");
		await expect(resolvePeerSession("parser", { dir })).rejects.toMatchObject({
			name: "PeerSessionError",
			code: "ambiguous",
		});
	});

	it("ignores and prunes a dead-pid entry", async () => {
		const dir = await tempDir();
		const deadPid = Bun.spawnSync([process.execPath, "-e", ""]).pid;
		await Bun.write(
			path.join(dir, "dead.json"),
			JSON.stringify({
				version: 1,
				instanceId: "deadbeef",
				pid: deadPid,
				endpoint: path.join(dir, "dead.sock"),
				createdAt: Date.now(),
				token: "token",
			}),
		);

		expect(await listPeerSessions({ dir })).toEqual([]);
		expect(await fs.readdir(dir)).not.toContain("dead.json");
	});

	it("creates owner-only registry and socket permissions", async () => {
		if (process.platform === "win32") return;
		const dir = await tempDir();
		const { snapshot } = await publishFixture(dir, { sessionId: "sess-perms", cwd: "/tmp/perms" });
		const dirStat = await fs.stat(dir);
		expect(dirStat.mode & 0o077).toBe(0);
		const files = await fs.readdir(dir);
		const socket = files.find(name => name.endsWith(".sock"));
		expect(socket).toBeTruthy();
		const socketStat = await fs.stat(path.join(dir, socket!));
		expect(socketStat.mode & 0o077).toBe(0);
		expect(snapshot.sessionId).toBe("sess-perms");
	});

	it("CLI send reports unknown targets as failure and sets a nonzero-style receipt", async () => {
		const dir = await tempDir();
		const lines: string[] = [];
		const code = await runPeerSendCommand(
			{ target: "missing", text: "hello", registry: { dir }, json: true },
			line => lines.push(line),
			line => lines.push(`ERR:${line}`),
		);

		expect(code).toBe(1);
		expect(JSON.parse(lines.find(line => line.startsWith("{")) ?? "{}")).toMatchObject({
			status: "failed",
			reason: "not_found",
		});
	});
});

describe("PR23 transport and approval regressions", () => {
	it("recovers ordered valid inbox records without consuming mixed corrupt and partial lines", async () => {
		const dir = await tempDir();
		const id = "a".repeat(32);
		const inbox = path.join(dir, "shell-inboxes", `${id}.jsonl`);
		const first = { from: "peer:first", text: "first reply", createdAt: 1 };
		const second = { from: "peer:second", text: "second reply", createdAt: 2 };
		const last = { from: "peer:last", text: "last reply", createdAt: 3 };
		const partial = JSON.stringify(last);
		const bytes = [
			JSON.stringify(first),
			'{"broken":',
			"null",
			"{}",
			"[]",
			JSON.stringify({ ...first, createdAt: "wrong" }),
			JSON.stringify({ ...first, text: "" }),
			JSON.stringify(second),
			partial.slice(0, -2),
		].join("\n");
		await fs.mkdir(path.dirname(inbox), { recursive: true });
		await fs.writeFile(inbox, bytes);
		for (const json of [false, true]) {
			const output: string[] = [];
			expect(
				await peersCli.runPeerInboxCommand({ address: `shell:${id}`, json, registry: { dir } }, line =>
					output.push(line),
				),
			).toBe(0);
			if (json) expect(JSON.parse(output.join("\n")).replies).toEqual([first, second]);
			else expect(output).toEqual(["peer:first: first reply", "peer:second: second reply"]);
		}
		expect(await readShellReplies(`shell:${id}`, { dir })).toEqual([first, second]);
		expect(await fs.readFile(inbox, "utf8")).toBe(bytes);
		await fs.appendFile(inbox, `${partial.slice(-2)}\n`);
		expect(await readShellReplies(`shell:${id}`, { dir })).toEqual([first, second, last]);
		await expect(readShellReplies(`shell:${"b".repeat(32)}`, { dir })).rejects.toMatchObject({ code: "not_found" });
		const target = await publishFixture(dir, { sessionId: "inbox-sender-control", cwd: dir });
		expect(
			(
				await sendPeerMessage({
					registry: { dir },
					from: { kind: "shell", id },
					target: target.snapshot.instanceId,
					text: "still usable",
				})
			).status,
		).toBe("delivered");
	});

	it("reports an uncertain command timeout and late effects without automatically retrying", async () => {
		const dir = await tempDir();
		const release = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		let started = 0;
		let effects = 0;
		const target = await publishFixture(dir, {
			sessionId: "delayed-review-command",
			cwd: dir,
			command: async () => {
				started++;
				await release.promise;
				if (++effects === 2) completed.resolve();
			},
		});
		const args = {
			registry: { dir, timeoutMs: 100 },
			from: { kind: "session" as const, sessionId: "same-caller", cwd: dir },
			target: target.snapshot.instanceId,
			text: "/known-command",
		};
		try {
			const output: string[] = [];
			expect(await runPeerSendCommand({ ...args, json: true }, line => output.push(line))).toBe(1);
			expect(JSON.parse(output.join("\n"))).toMatchObject({ status: "uncertain", reason: "delivery_uncertain" });
			expect(started).toBe(1);
			await expect(sendPeerMessage(args)).rejects.toMatchObject({ code: "rate_limited" });
			await Bun.sleep(1005);
			expect(started).toBe(1); // There is no automatic transport retry.
			await expect(sendPeerMessage(args)).rejects.toMatchObject({
				code: "delivery_uncertain",
				message: expect.stringContaining("Do not retry"),
			});
			expect(started).toBe(2); // Rate limits do not provide idempotency.
			release.resolve();
			await completed.promise;
			expect(effects).toBe(2); // Both accepted handlers can finish after client timeout.
		} finally {
			release.resolve();
		}
	});

	it("gates actual PeersTool actions through the extension wrapper and resolver", async () => {
		const dir = await tempDir();
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner(
			[],
			runtime,
			dir,
			SessionManager.inMemory(dir),
			new ModelRegistry(authStorage),
		);
		const tool = new PeersTool({ cwd: dir } as ToolSession);
		const execute = spyOn(tool, "execute").mockImplementation(async (_id, params) => ({
			content: [{ type: "text", text: "synthetic effect" }],
			details: { action: params.action },
		}));
		const wrapped = new ExtensionToolWrapper<typeof tool.parameters, PeersToolDetails>(tool, runner);
		const context = (mode: "always-ask" | "yolo", policy?: "allow" | "deny" | "prompt"): AgentToolContext => ({
			sessionManager: SessionManager.inMemory(dir),
			modelRegistry: new ModelRegistry(authStorage),
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated({
				"tools.approvalMode": mode,
				...(policy ? { "tools.approval": { peers: policy } } : {}),
			}),
		});
		const send = { action: "send" as const, target: "fixture", message: "/known-command" };
		expect(resolveApproval(tool, { action: "list" }, "always-ask")).toMatchObject({ tier: "read", policy: "allow" });
		expect(resolveApproval(tool, send, "always-ask")).toMatchObject({ tier: "write", policy: "prompt" });
		await wrapped.execute("list", { action: "list" }, undefined, undefined, context("always-ask"));
		expect(execute).toHaveBeenCalledTimes(1);
		await expect(wrapped.execute("send", send, undefined, undefined, context("always-ask"))).rejects.toThrow(
			"requires approval",
		);
		for (const action of [{ action: "list" as const }, send]) {
			await expect(wrapped.execute("deny", action, undefined, undefined, context("yolo", "deny"))).rejects.toThrow(
				"blocked by user policy",
			);
			await expect(
				wrapped.execute("prompt", action, undefined, undefined, context("yolo", "prompt")),
			).rejects.toThrow("requires approval");
		}
		expect(execute).toHaveBeenCalledTimes(1);
		await wrapped.execute("allow", send, undefined, undefined, context("always-ask", "allow"));
		expect(execute).toHaveBeenCalledTimes(2);
		const revised = await loadExtensionFromFactory(
			pi =>
				pi.on("tool_call", event => {
					if (event.toolName === "peers") return { input: send };
				}),
			dir,
			new EventBus(),
			runtime,
			"peer-approval-rewrite",
		);
		const revisedRunner = new ExtensionRunner(
			[revised],
			runtime,
			dir,
			SessionManager.inMemory(dir),
			new ModelRegistry(authStorage),
		);
		await expect(
			new ExtensionToolWrapper<typeof tool.parameters, PeersToolDetails>(tool, revisedRunner).execute(
				"rewrite",
				{ action: "list" },
				undefined,
				undefined,
				context("always-ask"),
			),
		).rejects.toThrow("requires approval");
		expect(execute).toHaveBeenCalledTimes(2);
		execute.mockRestore();
	});

	it("executes one authorized registered command through the actual PeersTool wrapper", async () => {
		const dir = await tempDir();
		const previous = Bun.env.OMP_PEER_SESSIONS_DIR;
		Bun.env.OMP_PEER_SESSIONS_DIR = dir;
		let effects = 0;
		try {
			const target = await publishFixture(dir, {
				sessionId: "approval-target",
				cwd: dir,
				command: () => {
					effects++;
				},
			});
			const authStorage = await AuthStorage.create(":memory:");
			authStorages.push(authStorage);
			const runner = new ExtensionRunner(
				[],
				new ExtensionRuntime(),
				dir,
				SessionManager.inMemory(dir),
				new ModelRegistry(authStorage),
			);
			const tool = new PeersTool({ cwd: dir, getSessionId: () => "approval-caller" } as ToolSession);
			const wrapped = new ExtensionToolWrapper<typeof tool.parameters, PeersToolDetails>(tool, runner);
			const params = { action: "send" as const, target: target.snapshot.instanceId, message: "/known-command" };
			const context = (settings: Settings): AgentToolContext => ({
				settings,
				sessionManager: SessionManager.inMemory(dir),
				modelRegistry: new ModelRegistry(authStorage),
				model: undefined,
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort: () => {},
			});
			for (const policy of [undefined, "deny", "prompt"] as const) {
				const settings = Settings.isolated({
					"tools.approvalMode": "always-ask",
					...(policy ? { "tools.approval": { peers: policy } } : {}),
				});
				await expect(
					wrapped.execute(`blocked-${policy}`, params, undefined, undefined, context(settings)),
				).rejects.toThrow();
				expect(effects).toBe(0);
			}
			const settings = Settings.isolated({
				"tools.approvalMode": "always-ask",
				"tools.approval": { peers: "allow" },
			});
			const result = await wrapped.execute("approved", params, undefined, undefined, context(settings));
			expect(result.details?.receipt).toMatchObject({ status: "delivered", outcome: "executed" });
			expect(effects).toBe(1);
		} finally {
			if (previous === undefined) delete Bun.env.OMP_PEER_SESSIONS_DIR;
			else Bun.env.OMP_PEER_SESSIONS_DIR = previous;
		}
	});
});

describe("PR23 alternate peer entry points", () => {
	it("requires write approval for peer URLs while preserving intra-session coordination", () => {
		const tool = new WriteTool({
			cwd: "/tmp",
			settings: Settings.isolated(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		});
		expect(
			resolveApproval(tool, { path: "agent://peer:fixture", content: "/known-command" }, "always-ask"),
		).toMatchObject({ tier: "write", policy: "prompt" });
		for (const path of ["agent://Main", `agent://shell:${"a".repeat(32)}`]) {
			expect(resolveApproval(tool, { path, content: "coordination" }, "always-ask")).toMatchObject({
				tier: "read",
				policy: "allow",
			});
		}
	});

	for (const busy of [false, true]) {
		it(`rejects peer MCP config mutations without a host context before writing (busy=${busy})`, async () => {
			const dir = await tempDir();
			const file = getMCPConfigPath("project", dir);
			await Bun.write(
				file,
				JSON.stringify({ mcpServers: { fixture: { type: "http", url: "https://fixture.invalid/mcp" } } }),
			);
			const prior = await Bun.file(file).text();
			const target = await publishFixture(dir, { sessionId: `peer-config-${busy}`, cwd: dir, command: () => {} });
			const session = sessions.at(-1)!;
			session.agent.state.isStreaming = busy;
			try {
				for (const text of [
					"/mcp add added --url https://fixture.invalid/mcp",
					"/mcp remove fixture",
					"/mcp enable fixture",
					"/mcp disable fixture",
				]) {
					const receipt = await sendPeerMessage({
						registry: { dir },
						target: target.snapshot.instanceId,
						text,
						from: { kind: "shell" },
					});
					expect(receipt).toMatchObject({
						status: "failed",
						reason: expect.stringContaining("host command context"),
					});
					expect(await Bun.file(file).text()).toBe(prior);
				}
			} finally {
				session.agent.state.isStreaming = false;
			}
		});
	}
});

describe("PR23 uncertain shell replies", () => {
	it("retains the advertised inbox through lost acknowledgements in JSON and human CLI output", async () => {
		const dir = await tempDir();
		for (const json of [true, false]) {
			const release = Promise.withResolvers<void>();
			const completed = Promise.withResolvers<void>();
			const target = await publishFixture(dir, {
				sessionId: `uncertain-shell-${json}`,
				cwd: dir,
				deliver: async () => {
					await release.promise;
					completed.resolve();
					return "woken";
				},
			});
			try {
				const output: string[] = [];
				const errors: string[] = [];
				expect(
					await runPeerSendCommand(
						{ target: target.snapshot.instanceId, text: "status?", json, registry: { dir, timeoutMs: 100 } },
						line => output.push(line),
						line => errors.push(line),
					),
				).toBe(1);
				const replyTo: string | undefined = json
					? JSON.parse(output.join("\n")).replyTo
					: output.find(line => line.startsWith("Replies:"))?.match(/shell:[a-f0-9]{32}/)?.[0];
				expect(replyTo).toBeDefined();
				const address = json ? replyTo! : `agent://${replyTo}`;
				expect(address).toBe(`agent://${target.delivered[0]!.from}`);
				if (json)
					expect(JSON.parse(output.join("\n"))).toMatchObject({
						status: "uncertain",
						reason: "delivery_uncertain",
					});
				else expect(errors.join("\n")).toContain("Do not retry");
				const result = await new AgentProtocolHandler({ dir }).write(
					parseInternalUrl(address),
					"late acknowledgement",
					{
						session: {
							cwd: dir,
							hasUI: false,
							agentRegistry: target.registry,
							getAgentId: () => MAIN_AGENT_ID,
							getSessionId: () => "uncertain-replier",
							settings: Settings.isolated(),
						} as ToolSession,
					},
				);
				expect(result.isError).toBe(false);
				expect(await readShellReplies(address.replace("agent://", ""), { dir })).toEqual([
					expect.objectContaining({ text: "late acknowledgement" }),
				]);
			} finally {
				release.resolve();
				await completed.promise;
			}
		}
	});
});

describe("PR23 IRC reply routing to shell and peer inboxes", () => {
	it("routes an IRC send to an existing shell inbox", async () => {
		const dir = await tempDir();
		const previous = Bun.env.OMP_PEER_SESSIONS_DIR;
		Bun.env.OMP_PEER_SESSIONS_DIR = dir;
		try {
			const id = "a".repeat(32);
			const inbox = path.join(dir, "shell-inboxes", `${id}.jsonl`);
			await fs.mkdir(path.dirname(inbox), { recursive: true });
			await fs.writeFile(inbox, "", { mode: 0o600, flag: "wx" });
			const target = await publishFixture(dir, { sessionId: "irc-shell-route", cwd: dir });
			const receipt = await target.irc.send({
				from: MAIN_AGENT_ID,
				to: `shell:${id}`,
				body: "hello shell",
			});
			expect(receipt).toEqual({ to: `shell:${id}`, outcome: "injected" });
			expect(await readShellReplies(`shell:${id}`, { dir })).toEqual([
				expect.objectContaining({ text: "hello shell", from: MAIN_AGENT_ID }),
			]);
		} finally {
			if (previous === undefined) delete Bun.env.OMP_PEER_SESSIONS_DIR;
			else Bun.env.OMP_PEER_SESSIONS_DIR = previous;
		}
	});

	it("fails an IRC send to an unknown plain id with the Unknown agent message", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "irc-unknown-route", cwd: dir });
		const receipt = await target.irc.send({
			from: MAIN_AGENT_ID,
			to: "missing-agent",
			body: "hello",
		});
		expect(receipt).toEqual({
			to: "missing-agent",
			outcome: "failed",
			error: 'Unknown agent "missing-agent" — check the subagent roster or read history:// for known peers.',
		});
	});

	it.each(["injected", "woken"] as const)("routes an IRC send to a peer session inbox (%s)", async outcome => {
		const dir = await tempDir();
		const previous = Bun.env.OMP_PEER_SESSIONS_DIR;
		Bun.env.OMP_PEER_SESSIONS_DIR = dir;
		try {
			const source = await publishFixture(dir, { sessionId: "peer-route-src", cwd: dir, outcome });
			const dest = await publishFixture(dir, { sessionId: "peer-route-dst", cwd: dir });
			const senderManager = SessionManager.inMemory(dir);
			Object.assign(dest.registry.get(MAIN_AGENT_ID)!.session!, { sessionManager: senderManager });
			const senderId = senderManager.getSessionId();
			const receipt = await dest.irc.send({
				from: MAIN_AGENT_ID,
				to: `peer:${source.snapshot.sessionId}`,
				body: "hello peer",
			});
			expect(receipt).toEqual({ to: `peer:${source.snapshot.sessionId}`, outcome });
			expect(source.delivered).toHaveLength(1);
			expect(source.delivered[0]).toMatchObject({
				from: `peer:${senderId}`,
				body: expect.stringContaining("hello peer"),
				to: MAIN_AGENT_ID,
			});
		} finally {
			if (previous === undefined) delete Bun.env.OMP_PEER_SESSIONS_DIR;
			else Bun.env.OMP_PEER_SESSIONS_DIR = previous;
		}
	});

	it("maps a rejected peer delivery to a failed IRC receipt", async () => {
		const dir = await tempDir();
		const previous = Bun.env.OMP_PEER_SESSIONS_DIR;
		Bun.env.OMP_PEER_SESSIONS_DIR = dir;
		try {
			const target = await publishFixture(dir, {
				sessionId: "peer-route-rejected",
				cwd: dir,
				deliver: async () => {
					throw new Error("peer handoff rejected");
				},
			});
			const sender = await publishFixture(dir, { sessionId: "peer-route-sender", cwd: dir });
			Object.assign(sender.registry.get(MAIN_AGENT_ID)!.session!, { sessionManager: SessionManager.inMemory(dir) });
			const to = `peer:${target.snapshot.sessionId}`;
			expect(await sender.irc.send({ from: MAIN_AGENT_ID, to, body: "hello peer" })).toEqual({
				to,
				outcome: "failed",
				error: "peer handoff rejected",
			});
			expect(sender.irc.sentSince(MAIN_AGENT_ID, to, 0)).toBe(false);
		} finally {
			if (previous === undefined) delete Bun.env.OMP_PEER_SESSIONS_DIR;
			else Bun.env.OMP_PEER_SESSIONS_DIR = previous;
		}
	});
});
