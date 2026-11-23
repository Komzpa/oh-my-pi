import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

it("nested launch reuses the live roster without reading sibling sessions or the root journal", async () => {
	using dir = TempDir.createSync("@omp-nested-roster-");
	const rootFile = dir.join("lead.jsonl");
	const parentFile = dir.join("lead", "Parent.jsonl");
	const childFile = dir.join("lead", "Parent", "Parent.Child.jsonl");
	const header = JSON.stringify({ type: "session", version: 3, id: "fixture", cwd: dir.path() });
	const init = JSON.stringify({ type: "session_init", id: "init", systemPrompt: "fixture", task: "review" });
	// Remote handles expose session-manager identity, but no local lifecycle index.
	const handle = (file: string) =>
		({
			instanceKey: "another-thread:fixture",
			sessionManager: { getSessionFile: () => file },
		}) as unknown as AgentSession;
	await Bun.write(rootFile, `${header}\n${JSON.stringify({ type: "custom", data: "x".repeat(128 * 1024 * 1024) })}\n`);
	await Bun.write(parentFile, `${header}\n${init}\n`);
	for (let batch = 0; batch < 128; batch++) {
		await Promise.all(
			Array.from({ length: 64 }, (_, i) =>
				Bun.write(dir.join("lead", `Sibling${batch * 64 + i}.jsonl`), `${header}\n${init}\n`),
			),
		);
	}
	const registry = AgentRegistry.global();
	for (const [id, file] of [
		[MAIN_AGENT_ID, rootFile],
		["Parent", parentFile],
	]) {
		registry.register({
			id,
			displayName: id,
			kind: id === MAIN_AGENT_ID ? "main" : "sub",
			status: "running",
			session: handle(file),
			sessionFile: file,
		});
	}
	registry.register({
		id: "KnownPeer",
		displayName: "KnownPeer",
		kind: "sub",
		status: "parked",
		session: null,
		sessionFile: dir.join("lead", "KnownPeer.jsonl"),
	});
	const peer = registry.get("KnownPeer");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	const manager = SessionManager.inMemory(dir.path());
	vi.spyOn(manager, "getSessionFile").mockReturnValue(childFile);
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
	let openedAt = 0;
	let rosterMs = Infinity;
	let maxGapMs = 0;
	let tickAt = 0;
	let timer: Timer | undefined;
	vi.spyOn(SessionManager, "open").mockImplementation(async () => {
		openedAt = tickAt = performance.now();
		timer = setInterval(() => {
			const now = performance.now();
			maxGapMs = Math.max(maxGapMs, now - tickAt);
			tickAt = now;
		}, 5);
		return manager;
	});
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async () => {
		rosterMs = performance.now() - openedAt;
		maxGapMs = Math.max(maxGapMs, performance.now() - tickAt);
		throw new Error("fixture reached SDK after roster");
	});
	const readdir = vi.spyOn(fs.promises, "readdir");
	const get = vi.spyOn(registry, "get");
	let rootReads = 0;
	const visit = sessionLoader.visitEntriesFromFileStream;
	vi.spyOn(sessionLoader, "visitEntriesFromFileStream").mockImplementation((...args) => {
		if (args[0] === rootFile) rootReads++;
		return visit(...args);
	});
	try {
		const result = await runSubprocess({
			cwd: dir.path(),
			artifactsDir: path.dirname(childFile),
			id: "Parent.Child",
			parentAgentId: "Parent",
			taskDepth: 1,
			agent: { name: "task", description: "fixture", systemPrompt: "fixture", source: "bundled" },
			task: "fixture",
			index: 0,
			authStorage: auth,
			settings: Settings.isolated({ "task.prewalk": false }),
			enableLsp: false,
			enableMCP: false,
		});
		expect(result.stderr).toContain("fixture reached SDK after roster");
		console.info(
			JSON.stringify({
				fixture: "8192 siblings, nested parent, 128 MiB root",
				rosterMs,
				maxGapMs,
				readdirs: readdir.mock.calls.length,
				registryGets: get.mock.calls.length,
				rootReads,
			}),
		);
		expect(rosterMs).toBeLessThanOrEqual(200);
		expect(maxGapMs).toBeLessThan(100);
		expect(readdir).not.toHaveBeenCalled();
		expect(rootReads).toBe(0);
		expect(registry.get("KnownPeer")).toBe(peer);
	} finally {
		clearInterval(timer);
		await auth.close();
	}
}, 30_000);
