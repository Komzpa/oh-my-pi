import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import * as structured from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { revivePersistedSubagent, type PersistedReviveSpec } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { persistTaskWorkspace } from "@oh-my-pi/pi-coding-agent/task/workspace";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { VerifiedTaskWorkspace } from "@oh-my-pi/pi-tui/tools/task";

let root: string;
let repo: string;
let read: string;
let sessionFile: string;
let record: VerifiedTaskWorkspace;
const reachedOpen = new Error("verified workspace reached transcript open");

beforeEach(async () => {
	const tmp = path.join(import.meta.dir, "../../../../.tmp");
	await fs.mkdir(tmp, { recursive: true });
	root = await fs.mkdtemp(path.join(tmp, "workspace-reentry-"));
	repo = path.join(root, "repo");
	await fs.mkdir(repo);
	await $`git init -q ${repo}`.quiet();
	// Fixture-only identity; no author settings in the implementation checkout are changed.
	await $`git -C ${repo} config user.name "Workspace fixture"`.quiet();
	await $`git -C ${repo} config user.email fixture@example.invalid`.quiet();
	await $`git -C ${repo} commit -q --allow-empty -m base`.quiet();
	const head = (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
	read = path.join(root, "input.txt");
	await Bun.write(read, "required input");
	sessionFile = path.join(root, "worker.jsonl");
	record = { repo, cwd: repo, head, reads: [read], resources: [repo] };
	await persistTaskWorkspace(sessionFile, record);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

function revive(): Promise<unknown> {
	// The open sentinel bounds this test before unrelated session/model setup.
	const spec = { id: "worker", displayName: "worker", sessionFile } as PersistedReviveSpec;
	return revivePersistedSubagent(spec, {} as AgentRef);
}

it("opens the persisted worker only while its verified base and read inputs remain valid", async () => {
	const open = vi.spyOn(SessionManager, "open").mockRejectedValue(reachedOpen);
	await expect(revive()).rejects.toBe(reachedOpen);
	expect(open).toHaveBeenCalledTimes(1);

	await fs.rm(read);
	open.mockClear();
	await expect(revive()).rejects.toThrow("reads: expected an existing path");
	expect(open).not.toHaveBeenCalled();
});

it("refuses a moved checkout HEAD before reopening a child session", async () => {
	const open = vi.spyOn(SessionManager, "open").mockRejectedValue(reachedOpen);
	await $`git -C ${repo} commit -q --allow-empty -m moved`.quiet();
	const actual = (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
	await expect(revive()).rejects.toThrow(
		`workspace.path HEAD: expected ${record.head}; actual ${JSON.stringify(actual)}`,
	);
	expect(open).not.toHaveBeenCalled();
});

it("admits legacy isolation using the child checkout and keeps its prompt and result grants identical", async () => {
	const child = path.join(root, "isolated");
	vi.spyOn(structured, "openIsolatedWorkspace").mockReturnValue(async source => {
		await vcs.clone(source, child);
		return {
			dir: child,
			cleanup: async () => {},
			retain: async () => {
				throw new Error("unexpected retention");
			},
		};
	});
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ name: "task", description: "Worker", systemPrompt: "Worker", source: "bundled" }],
		projectAgentsDir: null,
	});
	const admissions: VerifiedTaskWorkspace[] = [];
	const session = {
		cwd: repo,
		hasUI: false,
		settings: Settings.isolated({
			"task.batch": false,
			"async.enabled": false,
			"task.structured": false,
			"task.isolation.enabled": true,
			"task.isolation.merge": "patch",
			"task.isolation.apply": false,
		}),
		getSessionFile: () => path.join(root, "parent.jsonl"),
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		emitBeforeSubagentSpawn: async (event: { verifiedWorkspace?: VerifiedTaskWorkspace }) => {
			if (event.verifiedWorkspace) admissions.push(event.verifiedWorkspace);
		},
	} as unknown as ToolSession;
	vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
		expect(options.cwd).toBe(child);
		expect(options.worktree).toBe(child);
		expect(options.verifiedWorkspace).toMatchObject({ cwd: child, repo, resources: [child] });
		expect(options.task.startsWith("<verified_task_workspace>")).toBe(true);
		expect(options.task).toContain(JSON.stringify(options.verifiedWorkspace));
		return {
			index: 0,
			id: options.id,
			agent: "task",
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
	});
	const tool = await TaskTool.create(session);
	const result = await tool.executeBlocking("legacy-isolation", {
		name: "Legacy",
		task: "Inspect checkout",
		solutionSpace: "Bounded",
		isolated: true,
	});
	expect(admissions.length).toBeGreaterThan(0);
	for (const workspace of admissions) expect(workspace).toMatchObject({ cwd: child, resources: [child] });
	expect(result.details?.results[0]?.verifiedWorkspace).toEqual(admissions[0]);
	expect(result.details?.results[0]?.checkoutCwd).toBe(child);
});
