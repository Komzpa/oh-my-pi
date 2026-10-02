import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

const cleanupDirs: string[] = [];
const publications: PeerSessionPublication[] = [];

afterEach(async () => {
	for (const pub of publications.splice(0)) await pub.close();
	for (const dir of cleanupDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-peer-sessions-"));
	cleanupDirs.push(dir);
	return dir;
}

function fakeSession(outcome: "injected" | "woken", seen: IrcMessage[]): AgentSession {
	return {
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
	},
): Promise<{ delivered: IrcMessage[]; snapshot: PeerSessionSnapshot }> {
	const registry = new AgentRegistry();
	const delivered: IrcMessage[] = [];
	const agentId = options.agentId ?? MAIN_AGENT_ID;
	registry.register({
		id: agentId,
		displayName: agentId,
		kind: agentId === MAIN_AGENT_ID ? "main" : "sub",
		session: fakeSession(options.outcome ?? "woken", delivered),
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
	const [snapshot] = await listPeerSessions({ dir });
	if (!snapshot) throw new Error("published peer session was not listed");
	return { delivered, snapshot };
}

describe("peer sessions", () => {
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

		expect(receipt).toEqual({
			status: "delivered",
			outcome: "woken",
			target: snapshot.instanceId,
			agent: MAIN_AGENT_ID,
		});
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({
			from: "shell",
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
