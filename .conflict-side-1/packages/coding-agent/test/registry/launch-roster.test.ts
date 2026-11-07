import { expect, it } from "bun:test";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { resolveSubagentLaunchRoster } from "@oh-my-pi/pi-coding-agent/registry/launch-roster";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { collectIrcPeerRoster } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

function remoteSession(file: string): AgentSession {
	return {
		instanceKey: "other-thread:fixture",
		sessionManager: { getSessionFile: () => file },
	} as unknown as AgentSession;
}

it("nested roster keeps root siblings addressable and excludes a previous root's parked peers", async () => {
	using dir = TempDir.createSync("@omp-launch-roster-");
	const registry = new AgentRegistry();
	const root = dir.join("lead.jsonl");
	const parent = dir.join("lead", "Parent.jsonl");
	for (const [id, file] of [
		[MAIN_AGENT_ID, root],
		["Parent", parent],
	]) {
		registry.register({
			id,
			displayName: id,
			kind: id === MAIN_AGENT_ID ? "main" : "sub",
			status: "running",
			session: remoteSession(file),
			sessionFile: file,
		});
	}
	for (const [id, file] of [
		["Sibling", dir.join("lead", "Sibling.jsonl")],
		["Old", dir.join("previous", "Old.jsonl")],
	]) {
		registry.register({ id, displayName: id, kind: "sub", status: "parked", session: null, sessionFile: file });
	}
	const resolved = resolveSubagentLaunchRoster(registry, dir.join("lead", "Parent", "Child.jsonl"), "Parent");
	expect(resolved).toBe(root);
	expect(collectIrcPeerRoster(registry, "Child", resolved)).toMatchObject({ parkedCount: 1 });
	expect(registry.get("Sibling")?.sessionFile).toBe(dir.join("lead", "Sibling.jsonl"));
});

it.each(["root switched", "parent detached", "different child tree"])(
	"restores disk peers when %s prevents inherited roster reuse",
	async reason => {
		using dir = TempDir.createSync("@omp-launch-roster-fallback-");
		const registry = new AgentRegistry();
		const root = dir.join("lead.jsonl");
		const parent = dir.join("lead", "Parent.jsonl");
		const child = dir.join("lead", "Parent", "Child.jsonl");
		const sibling = dir.join("lead", "Sibling.jsonl");
		const transcript = `${JSON.stringify({ type: "session", version: 3, id: "fixture" })}\n${JSON.stringify({ type: "session_init", id: "init", task: "review", systemPrompt: "fixture" })}\n`;
		for (const file of [root, parent, child, sibling]) await Bun.write(file, transcript);
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			status: "running",
			session: remoteSession(reason === "root switched" ? dir.join("new.jsonl") : root),
			sessionFile: root,
		});
		registry.register({
			id: "Parent",
			displayName: "Parent",
			kind: "sub",
			status: "running",
			session:
				reason === "parent detached"
					? null
					: remoteSession(reason === "different child tree" ? dir.join("lead", "Elsewhere.jsonl") : parent),
			sessionFile: parent,
		});
		const inherited = resolveSubagentLaunchRoster(registry, child, "Parent");
		expect(inherited).toBeUndefined();
		const resolved = inherited ?? (await ensurePersistedRoster(registry, child));
		expect(resolved).toBe(root);
		expect(registry.get("Sibling")).toMatchObject({
			sessionFile: sibling,
			status: "parked",
			parentId: MAIN_AGENT_ID,
		});
	},
);
