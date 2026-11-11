import { afterEach, describe, expect, it, vi } from "bun:test";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { PeerCoordination, type PeerCoordinationState } from "@oh-my-pi/pi-coding-agent/task/peer-coordination";
import { collectIrcPeerRoster } from "@oh-my-pi/pi-coding-agent/task/executor";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";

const monitors: PeerCoordination[] = [];
afterEach(() => {
	for (const monitor of monitors.splice(0)) monitor.dispose();
	vi.restoreAllMocks();
});
const state = (paths: string[]): PeerCoordinationState => ({
	task: "Review rendering",
	profile: "reviewer",
	scope: { root: "/repo", paths },
	touched: [],
});
function fixture() {
	const registry = new AgentRegistry();
	const register = (id: string, paths: string[]) =>
		registry.register({
			id,
			displayName: "task",
			kind: "sub",
			parentId: "parent",
			session: null,
			status: "running",
			history: { peerCoordination: state(paths) },
		});
	register("a", ["src/a"]);
	register("b", ["evidence"]);
	const bus = new IrcBus(registry);
	const notices: string[] = [];
	const monitor = new PeerCoordination(registry, "a", bus, text => notices.push(text));
	monitors.push(monitor);
	monitor.flush();
	const tool = new YieldTool({
		cwd: "/repo",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		hasUI: false,
		settings: Settings.isolated(),
		checkPeerHandover: async entries =>
			monitor.checkHandover(entries as { peer: string; resource: string; agreement: string }[]),
	});
	return { registry, register, bus, notices, monitor, tool };
}
async function send(bus: IrcBus, from: string, to: string, progress = false) {
	// A real bus waiter gives a successful receipt without starting a provider turn.
	const received = bus.wait(to, {}, 1000);
	await bus.send({ from, to, body: "Shared resource agreement", progress });
	await received;
}

describe("peer coordination", () => {
	it.each([false, true])("task dispatch preserves ownership for clash detection (batch=%s)", async batch => {
		const f = fixture();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "Worker", systemPrompt: "Work", source: "bundled" }],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			f.registry.setHistory("b", { peerCoordination: { ...state([]), scope: options.peerScope ?? {} } });
			f.monitor.touch(["path:/repo/evidence/out.png"]);
			const refusal = f.monitor.checkHandover();
			return {
				index: 0,
				id: options.id,
				agent: "task",
				agentSource: "bundled",
				task: options.task,
				exitCode: refusal ? 1 : 0,
				output: refusal ?? "ready",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			};
		});
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				"task.peerAwareness": true,
				"task.batch": batch,
				"async.enabled": false,
				"task.isolation.enabled": false,
				"plan.enabled": false,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		});
		const item = { name: "Review", task: "Review evidence", scope: { root: "/repo", paths: ["evidence"] } };
		const result = await tool.execute("dispatch", batch ? { context: "Review", tasks: [item] } : item);
		expect(result.details?.results[0].exitCode).toBe(1);
		expect(result.details?.results[0].output).toContain("path:/repo/evidence/out.png");
	});
	it("shows bounded task/profile/scope only when awareness is enabled", () => {
		const f = fixture();
		const row = collectIrcPeerRoster(f.registry, "a", undefined, true).peers.find(peer => peer.id === "b");
		expect(row?.task).toBe("Review rendering");
		expect(row?.profile).toBe("reviewer");
		expect(row?.scope).toContain("evidence");
		expect(collectIrcPeerRoster(f.registry, "a").peers[0].task).toBeUndefined();
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			peerAwareness: true,
		}).toJsonSchema();
		expect(JSON.stringify(schema)).toContain('"scope"');
		expect(
			JSON.stringify(getTaskSchema({ isolationEnabled: false, batchEnabled: false }).toJsonSchema()),
		).not.toContain('"scope"');
	});
	it("coalesces sibling joins/leaves and ignores activity-only turns", async () => {
		const f = fixture();
		f.register("c", ["screens"]);
		f.register("d", ["ports"]);
		await Promise.resolve();
		expect(f.notices).toHaveLength(1);
		expect(f.notices[0]).toContain("agent://c");
		expect(f.notices[0]).toContain("agent://d");
		f.registry.setActivity("c", "reading");
		f.registry.setActivity("d", "reading");
		await Promise.resolve();
		expect(f.notices).toHaveLength(1);
		f.registry.setStatus("c", "idle");
		f.registry.setStatus("d", "parked");
		await Promise.resolve();
		expect(f.notices).toHaveLength(2);
		expect(f.notices[1]).toContain("left");
		expect(f.notices[1]).toContain("screens");
	});
	it("overlap emits one notice and blocks real yield until a direct send and reply", async () => {
		const f = fixture();
		f.monitor.touch(["path:/repo/evidence/../evidence/screen.png"]);
		expect(f.notices).toHaveLength(1);
		expect(f.notices[0]).toContain("agent://b");
		await expect(f.tool.execute("first", { data: { done: true } })).rejects.toThrow("Handover refused");
		await expect(f.tool.execute("retry", { data: { done: true } })).rejects.toThrow("Handover refused");
		await send(f.bus, "a", "b");
		await send(f.bus, "b", "a", true);
		await expect(f.tool.execute("progress", { data: { done: true } })).rejects.toThrow("Handover refused");
		await send(f.bus, "b", "a");
		expect((await f.tool.execute("resolved", { data: { done: true } })).details?.status).toBe("success");
		expect(f.notices).toHaveLength(1);
	});
	it("peer finishing releases the refusal", async () => {
		const f = fixture();
		f.monitor.touch(["path:/repo/evidence/out"]);
		await expect(f.tool.execute("first", { data: "ready" })).rejects.toThrow("Handover refused");
		f.registry.setStatus("b", "idle");
		expect((await f.tool.execute("finished", { data: "ready" })).details?.status).toBe("success");
	});
	it("structured agreement releases the matching clash and travels in yield details", async () => {
		const f = fixture();
		f.monitor.touch(["path:/repo/evidence/out"]);
		const deconfliction = [
			{ peer: "b", resource: "path:/repo/evidence/out", agreement: "Review uses a separate evidence directory" },
		];
		const result = await f.tool.execute("agreed", { data: "ready", deconfliction });
		expect(result.details?.deconfliction).toEqual(deconfliction);
	});
	it("disjoint paths and path-prefix lookalikes produce no notice or refusal", async () => {
		const f = fixture();
		f.monitor.touch(["path:/repo/src/a", "path:/repo/evidence-old/out"]);
		expect(f.notices).toEqual([]);
		expect((await f.tool.execute("done", { data: "ready" })).details?.status).toBe("success");
	});
	it("detects touched/touched overlap and ignores another parent's worker", () => {
		const f = fixture();
		f.registry.setHistory("b", { peerCoordination: { ...state([]), touched: ["port:43001"] } });
		f.monitor.touch(["port:43001"]);
		expect(f.monitor.checkHandover()).toContain("port:43001");
		f.registry.register({
			id: "unrelated",
			displayName: "task",
			kind: "sub",
			parentId: "elsewhere",
			session: {} as AgentSessionHandle,
			history: { peerCoordination: state(["src/a"]) },
		});
		f.monitor.touch(["path:/repo/src/a"]);
		expect(f.notices.join("\n")).not.toContain("unrelated");
	});
});
