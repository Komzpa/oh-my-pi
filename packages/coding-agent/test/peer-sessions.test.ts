import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
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
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import {
	type PeerSessionPublication,
	type PeerSessionSnapshot,
	listPeerSessions,
	publishPeerSession,
	resolvePeerSession,
	sendPeerMessage,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
import { runPeerSendCommand } from "@oh-my-pi/pi-coding-agent/cli/peers-cli";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { prompt } from "@oh-my-pi/pi-utils";
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
		sessionId: string;
		cwd: string;
		title?: string;
		outcome?: "injected" | "woken";
		agentId?: string;
		command?: (args: string) => void;
	},
): Promise<{ delivered: IrcMessage[]; snapshot: PeerSessionSnapshot; registry: AgentRegistry }> {
	const registry = new AgentRegistry();
	const delivered: IrcMessage[] = [];
	const agentId = options.agentId ?? MAIN_AGENT_ID;
	let session = fakeSession(options.outcome ?? "woken", delivered);
	if (options.command) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => pi.registerCommand("known-command", { handler: async args => options.command?.(args) }),
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
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, options.cwd, sessionManager, modelRegistry),
		});
		session.deliverIrcMessage = fakeSession(options.outcome ?? "woken", delivered).deliverIrcMessage;
		sessions.push(session);
	}
	registry.register({
		id: agentId,
		displayName: agentId,
		kind: agentId === MAIN_AGENT_ID ? "main" : "sub",
		session,
	});
	const pub = await publishPeerSession({
		dir,
		sessionId: options.sessionId,
		cwd: options.cwd,
		title: () => options.title ?? null,
		mainAgentId: MAIN_AGENT_ID,
		registry,
		irc: new IrcBus(registry),
	});
	publications.push(pub);
	const snapshot = (await listPeerSessions({ dir })).find(peer => peer.sessionId === options.sessionId);
	if (!snapshot) throw new Error("published peer session was not listed");
	return { delivered, snapshot, registry };
}

describe("peer sessions", () => {
	it("delivers a shell reply to the address advertised by the incoming footer and reads it from the CLI inbox", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-shell-reply", cwd: dir });
		const sent: string[] = [];
		expect(await runPeerSendCommand(
			{ target: target.snapshot.instanceId, text: "status?", json: true, registry: { dir } },
			line => sent.push(line),
		)).toBe(0);
		const message = target.delivered[0]!;
		const footer = prompt.render(ircIncomingTemplate, { from: message.from, message: message.body, relayOnStop: false });
		const address = footer.match(/path: "(agent:\/\/[^"\s]+)"/)?.[1];
		expect(address).toBeTruthy();
		const result = await new AgentProtocolHandler({ dir }).write(parseInternalUrl(address!), "shell answer", {
			session: {
				cwd: dir, hasUI: false, agentRegistry: target.registry,
				getAgentId: () => MAIN_AGENT_ID, getSessionId: () => "sess-shell-reply", settings: Settings.isolated(),
			} as ToolSession,
		});
		expect(result.isError).toBe(false);
		const receipt = JSON.parse(sent.join("\n"));
		expect(receipt.replyTo).toBe(address);
		const inbox: string[] = [];
		expect(await peersCli.runPeerInboxCommand(
			{ address: receipt.replyTo.replace("agent://", ""), json: true, registry: { dir } },
			line => inbox.push(line),
		)).toBe(0);
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
		const result = await new AgentProtocolHandler({ dir }).write(parseInternalUrl("agent://missing-agent"), "answer", {
			session: {
				cwd: dir, hasUI: false, agentRegistry: target.registry,
				getAgentId: () => MAIN_AGENT_ID, getSessionId: () => "sess-negative", settings: Settings.isolated(),
			} as ToolSession,
		});
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('Unknown agent "missing-agent"') })]);
	});

	it("keeps replies readable from another CLI process after the shell sender exits", async () => {
		const dir = await tempDir();
		const target = await publishFixture(dir, { sessionId: "sess-exited-shell", cwd: dir });
		const cli = path.resolve(import.meta.dir, "../src/cli.ts");
		const run = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, cli, "peers", ...args], {
				cwd: dir, env: { ...process.env, OMP_PEER_SESSIONS_DIR: dir }, stdout: "pipe", stderr: "pipe",
			});
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
			]);
			expect(stderr).toBe("");
			expect(exit).toBe(0);
			return JSON.parse(stdout);
		};
		const sent = await run("send", target.snapshot.instanceId, "answer after I exit", "--json");
		const result = await new AgentProtocolHandler({ dir }).write(parseInternalUrl(sent.replyTo), "durable answer", {
			session: {
				cwd: dir, hasUI: false, agentRegistry: target.registry,
				getAgentId: () => MAIN_AGENT_ID, getSessionId: () => "sess-exited-shell", settings: Settings.isolated(),
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
				cwd: dir, hasUI: false, agentRegistry: target.registry,
				getAgentId: () => MAIN_AGENT_ID, settings: Settings.isolated(),
			} as ToolSession,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: `unknown shell reply address: ${address}` });
		const lines: string[] = [];
		expect(await peersCli.runPeerInboxCommand({ address, json: true, registry: { dir } }, line => lines.push(line))).toBe(1);
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
