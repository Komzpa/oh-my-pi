/**
 * Re-staffing a TODO row under its owner's name collides with the settled job
 * that already holds the id, so the worker becomes `<name>-2`. The row must
 * name the new worker by the time the task call returns, and the result must
 * say so; otherwise the caller spends a turn correcting the owner by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createSessionDefaults } from "../helpers/session-defaults";
import { classifyTodoDisplayRow } from "@oh-my-pi/pi-tui/tools/todo-schedule";
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
		eventBus: new EventBus(),
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

	it("binds a newly named row before the spawn result and executor startup", async () => {
		const gate = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?");
		});
		const manager = createManager();
		const edits: TodoPersistedEdit[] = [];
		const { session, owner } = createSession(manager, plan("OldOwner"), edits);
		const tool = await TaskTool.create(session);
		try {
			await tool.execute("new-row", {
				agent: "task",
				name: "LeadersRotationProof",
				row: ROW,
				task: "Run the proof.",
			} as TaskParams);
			expect(owner()).toBe("LeadersRotationProof");
			const phases = session.getTodoPhases!();
			const row = phases[0]!.tasks[0]!;
			const workers = manager.getRunningJobs().map(job => ({ id: job.agentId ?? job.id }));
			const ownerWorker = workers.find(worker => worker.id === row.schedule?.owner);
			expect(
				classifyTodoDisplayRow(row, phases, {
					workers,
					owners: new Map(ownerWorker ? [[row.content, ownerWorker]] : []),
				}).state,
			).toBe("working");
			expect(session.getTodoPhases!()[0]!.tasks[0]!.schedule?.executor).toMatchObject({
				workerId: "LeadersRotationProof",
			});
			expect(edits.some(edit => edit.kind === "executor")).toBe(true);
		} finally {
			gate.resolve();
		}
	});

	it("keeps a row executor and owner through an autonomous IRC reply and records activity", async () => {
		const manager = createManager();
		const edits: TodoPersistedEdit[] = [];
		const phases = plan("CoolingTrunksBuild-8");
		phases[0]!.tasks[0]!.schedule!.executor = { workerId: "CoolingTrunksBuild-8", startedAt: 100 };
		const { session } = createSession(manager, phases, edits);
		const notes: unknown[] = [];
		session.sessionManager = {
			appendCustomEntry: (kind: string, data: unknown) => {
				notes.push({ kind, data });
			},
		} as unknown as ToolSession["sessionManager"];
		await TaskTool.create(session);
		let observer: ((records: unknown[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const worker = {
			...createSessionDefaults(),
			getToolByName: () => undefined,
			getLastAssistantMessage: () => ({
				role: "assistant",
				content: [{ type: "text", text: "Acknowledged." }],
				stopReason: "stop",
			}),
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			trackIrcReply: () => {},
			setIrcWakeTurnObserver: (value: typeof observer) => {
				observer = value;
			},
		} as unknown as AgentSession;
		attachIrcWakeTurnMonitor(worker, {
			id: "CoolingTrunksBuild-8",
			structured: false,
			agent: { name: "task", description: "Task", systemPrompt: "Run", source: "bundled" },
			eventBus: session.eventBus,
		});
		session.eventBus!.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "CoolingTrunksBuild-8",
			agent: "task",
			status: "started",
			at: 100,
		});
		edits.length = 0;
		const before = structuredClone(session.getTodoPhases!());
		const finish = observer!([]);
		for (const listener of listeners)
			listener({ type: "message_end", message: createAssistantMessage("Acknowledged.") });
		await finish?.();
		expect(session.getTodoPhases!()).toEqual(before);
		expect(edits).toEqual([]);
		const current = session.getTodoPhases!();
		const row = current[0]!.tasks[0]!;
		const live = { id: "CoolingTrunksBuild-8" };
		expect(
			classifyTodoDisplayRow(row, current, { workers: [live], owners: new Map([[row.content, live]]) }).state,
		).toBe("working");
		// The real assignment can still finish after the conversational turn.
		session.eventBus!.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: live.id,
			agent: "task",
			status: "completed",
			at: 200,
		});
		expect(session.getTodoPhases!()[0]!.tasks[0]!.schedule?.executor).toMatchObject({
			startedAt: 100,
			finishedAt: 200,
			outcome: "completed",
		});
		expect(notes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "task_worker_activity",
					data: expect.objectContaining({ status: "completed" }),
				}),
			]),
		);
	});

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
	it("relinks the row when a parent prefix pushes the respawn to -3", async () => {
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		const manager = createManager();
		const edits: TodoPersistedEdit[] = [];
		const { session, owner } = createSession(manager, plan("RenderR7ZoompanMix"), edits);
		// Subagent sessions allocate hierarchical ids; both earlier bumps are
		// taken so this respawn lands on `Parent.RenderR7ZoompanMix-3`.
		const outputManager = new AgentOutputManager(() => null, { parentPrefix: "Parent" });
		await outputManager.allocate("RenderR7ZoompanMix");
		await outputManager.allocate("RenderR7ZoompanMix");
		session.agentOutputManager = outputManager;
		const tool = await TaskTool.create(session);

		const second = await tool.execute("tc-2", {
			agent: "task",
			name: "RenderR7ZoompanMix",
			task: "Render it again.",
		} as TaskParams);

		expect(text(second)).toContain("Spawned agent `Parent.RenderR7ZoompanMix-3`");
		expect(owner()).toBe("Parent.RenderR7ZoompanMix-3");
		expect(text(second)).toContain("already names an earlier job");
	});

	it("refuses a duplicate worker while the requested row owner is still running", async () => {
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

		try {
			expect(text(second)).toContain("REFUSED: no worker was spawned");
			expect(text(second)).toContain("reserved by RenderR7ZoompanMix");
			expect(text(second)).not.toContain("Spawned agent");
			expect(owner()).toBe("RenderR7ZoompanMix");
			expect(manager.getRunningJobs()).toHaveLength(1);
		} finally {
			gate.resolve();
		}
		await Promise.all(manager.getAllJobs().map(job => job.promise));
		expect(executorModule.runSubprocess).toHaveBeenCalledTimes(1);
	});
});
