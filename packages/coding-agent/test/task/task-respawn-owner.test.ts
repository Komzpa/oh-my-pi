/**
 * Re-staffing a TODO row under its owner's name collides with the settled job
 * that already holds the id, so the worker becomes `<name>-2`. The row must
 * name the new worker by the time the task call returns, and the result must
 * say so; otherwise the caller spends a turn correcting the owner by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { TodoPersistedEdit, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

const ROW = "Render r7 with working zoompan and remastered mix";
const OTHER_ROW = "Creative owner accepts or rejects r7 cut";

function plan(owner: string): TodoPhase[] {
	return [
		{
			name: "Video craft",
			tasks: [
				{ content: ROW, status: "in_progress", schedule: { dependencies: [], owner } },
				{ content: OTHER_ROW, status: "pending", schedule: { dependencies: [ROW], owner: "ReviewCut" } },
			],
		},
	];
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Render it.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function createSession(manager: AsyncJobManager, phases: TodoPhase[], edits: TodoPersistedEdit[]) {
	let current = phases;
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		getTodoPhases: () => current,
		setTodoPhases: (next: TodoPhase[]) => {
			current = next;
		},
		persistTodoPhases: (_next: TodoPhase[], edit?: TodoPersistedEdit) => {
			if (edit) edits.push(edit);
		},
	} as unknown as ToolSession;
	return { session, owner: () => current[0]!.tasks[0]!.schedule?.owner };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("task respawn keeps the TODO owner linked", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "Task agent", systemPrompt: "Run work", source: "bundled" }],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	it("moves the row from the settled job to its -2 respawn before the call returns", async () => {
		const gate = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (options.id !== "RenderR7ZoompanMix") await gate.promise;
			return makeResult(options.id ?? "?", options.id === "RenderR7ZoompanMix" ? { aborted: true } : {});
		});
		const manager = createManager();
		const edits: TodoPersistedEdit[] = [];
		const { session, owner } = createSession(manager, plan("RenderR7ZoompanMix"), edits);
		const tool = await TaskTool.create(session);

		const first = await tool.execute("tc-1", {
			agent: "task",
			name: "RenderR7ZoompanMix",
			task: "Render it.",
		} as TaskParams);
		// Neighbour: a first spawn keeps its plain name and leaves the row alone.
		expect(text(first)).toContain("Spawned agent `RenderR7ZoompanMix`");
		expect(text(first)).not.toContain("already names an earlier job");
		await manager.getJob(first.details!.async!.jobId!)!.promise;
		expect(owner()).toBe("RenderR7ZoompanMix");

		const second = await tool.execute("tc-2", {
			agent: "task",
			name: "RenderR7ZoompanMix",
			task: "Render it again.",
		} as TaskParams);

		expect(text(second)).toContain("Spawned agent `RenderR7ZoompanMix-2`");
		expect(owner()).toBe("RenderR7ZoompanMix-2");
		expect(text(second)).toContain(
			`\`RenderR7ZoompanMix\` already names an earlier job, so this worker is \`RenderR7ZoompanMix-2\`; TODO row "${ROW}" now names \`RenderR7ZoompanMix-2\` as owner.`,
		);

		// The owner change is a replayable edit: a resumed session sees the same owner.
		const entries = edits.map(
			(edit, index) =>
				({
					type: "custom",
					customType: USER_TODO_EDIT_CUSTOM_TYPE,
					data: { edit },
					id: `e${index + 1}`,
					parentId: index === 0 ? "base" : `e${index}`,
					timestamp: "2026-09-26T18:00:27.000Z",
				}) as SessionEntry,
		);
		const base = {
			type: "custom",
			customType: USER_TODO_EDIT_CUSTOM_TYPE,
			data: { phases: plan("RenderR7ZoompanMix") },
			id: "base",
			parentId: null,
			timestamp: "2026-09-26T17:58:00.000Z",
		} as unknown as SessionEntry;
		const replayed = getLatestTodoPhasesFromEntries([base, ...entries]);
		expect(replayed[0]!.tasks[0]!.schedule?.owner).toBe("RenderR7ZoompanMix-2");
		expect(replayed[0]!.tasks[1]!.schedule?.owner).toBe("ReviewCut");
		gate.resolve();
	});

	it("leaves the row with the requested owner while that owner is still running", async () => {
		const gate = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?");
		});
		const manager = createManager();
		const edits: TodoPersistedEdit[] = [];
		const { session, owner } = createSession(manager, plan("RenderR7ZoompanMix"), edits);
		const tool = await TaskTool.create(session);

		await tool.execute("tc-1", { agent: "task", name: "RenderR7ZoompanMix", task: "Render it." } as TaskParams);
		const second = await tool.execute("tc-2", {
			agent: "task",
			name: "RenderR7ZoompanMix",
			task: "A parallel helper.",
		} as TaskParams);

		expect(text(second)).toContain("Spawned agent `RenderR7ZoompanMix-2`");
		expect(text(second)).not.toContain("already names an earlier job");
		expect(owner()).toBe("RenderR7ZoompanMix");
		gate.resolve();
	});
});
