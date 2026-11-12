import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	getLatestTodoArchiveFromEntries,
	getLatestTodoPhasesFromEntries,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { TodoPersistedEdit, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

function heavyTodoPlan(rowCount: number): TodoPhase[] {
	return [
		{
			name: "Sunbim task lanes",
			tasks: Array.from({ length: rowCount }, (_, index) => ({
				content: `Task ${String(index + 1).padStart(3, "0")} with retained schedule history`,
				status: index === 0 ? ("in_progress" as const) : ("pending" as const),
				schedule: {
					dependencies:
						index === 0 ? [] : [`Task ${String(index).padStart(3, "0")} with retained schedule history`],
					owner: "Main",
					resources: ["native-todo", `lane-${index % 9}`],
					estimate: {
						optimisticSeconds: 60,
						likelySeconds: 180,
						pessimisticSeconds: 420,
						confidence: "high" as const,
						basis: "Large-plan regression basis retaining enough text to model Sunbim schedule history.",
						updatedAt: 1_790_217_111_019 + index,
					},
					progress: {
						at: 1_790_217_111_019 + index,
						evidence: "Large-plan regression evidence retaining enough text to model repeated progress history.",
					},
				},
			})),
		},
	];
}

function createSession(
	phases: TodoPhase[],
	writes: Array<{ phases?: TodoPhase[]; edit?: TodoPersistedEdit }>,
	eventBus: EventBus,
): ToolSession {
	let current = phases;
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		eventBus,
		getTodoPhases: () => current,
		setTodoPhases: (next: TodoPhase[]) => {
			current = next;
		},
		persistTodoPhases: (next: TodoPhase[], edit?: TodoPersistedEdit) => {
			writes.push(edit ? { edit } : { phases: next });
		},
		registerDisposeCallback: vi.fn(),
	} as unknown as ToolSession;
}

function compactEntry(edit: TodoPersistedEdit, id: string, parentId: string): SessionEntry {
	return {
		type: "custom",
		customType: USER_TODO_EDIT_CUSTOM_TYPE,
		data: { edit },
		id,
		parentId,
		timestamp: "2026-09-25T13:00:01.000Z",
	} as SessionEntry;
}

describe("task todo persistence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a seance journal free of unrelated worker todo and activity events", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const bus = new EventBus();
		const writes: Array<{ phases?: TodoPhase[]; edit?: TodoPersistedEdit }> = [];
		const session = createSession(heavyTodoPlan(2), writes, bus);
		const append = vi.fn();
		Object.assign(session, {
			seanceSourceArtifactsDir: "/tmp/source",
			sessionManager: { appendCustomEntry: append },
		});
		await TaskTool.create(session);
		for (const followUpTurn of [false, true]) {
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "other-worker",
				agent: "task",
				status: "started",
				description: "Task 001 with retained schedule history",
				followUpTurn,
				at: Date.now(),
			});
		}
		expect(writes).toEqual([]);
		expect(append).not.toHaveBeenCalled();
	});

	it("persists task owner links as compact edits for a 300-row plan", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "Task agent", systemPrompt: "Run work", source: "bundled" }],
			projectAgentsDir: null,
		});
		const eventBus = new EventBus();
		const writes: Array<{ phases?: TodoPhase[]; edit?: TodoPersistedEdit }> = [];
		await TaskTool.create(createSession(heavyTodoPlan(300), writes, eventBus));

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Task001Owner",
			agent: "task",
			status: "started",
			description: "Task 001 with retained schedule history",
			at: 1_790_217_222_000,
		});

		expect(writes).toHaveLength(1);
		expect(writes[0]?.phases).toBeUndefined();
		expect(writes[0]?.edit).toMatchObject({ v: 1, kind: "executor" });
		expect(new TextEncoder().encode(JSON.stringify(writes[0])).length).toBeLessThan(1_500);
	});

	it("writes no row journal bytes for repeated IRC follow-up lifecycles", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "Task agent", systemPrompt: "Run work", source: "bundled" }],
			projectAgentsDir: null,
		});
		const bus = new EventBus();
		const writes: Array<{ phases?: TodoPhase[]; edit?: TodoPersistedEdit }> = [];
		await TaskTool.create(createSession(heavyTodoPlan(300), writes, bus));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "owner",
			agent: "task",
			status: "started",
			description: "Task 001 with retained schedule history",
			at: 100,
		});
		const journalBytes = () =>
			Buffer.byteLength(
				writes
					.map((write, index) =>
						JSON.stringify(compactEntry(write.edit!, `e${index}`, index ? `e${index - 1}` : "base")),
					)
					.join("\n") + "\n",
			);
		const bytes = journalBytes();
		for (let i = 0; i < 1000; i++) {
			for (const status of ["started", "aborted"])
				bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id: "owner",
					agent: "task",
					status,
					taskText: "IRC follow-up",
					at: 200 + i,
					followUpTurn: true,
				});
		}
		expect(journalBytes()).toBe(bytes);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.edit).toMatchObject({ observation: { row: "Task 001 with retained schedule history" } });
		expect(writes[0]?.edit).toMatchObject({ observation: { runningWorkerIds: ["owner"] } });
	});

	it("persists only the row owner's liveness and replays a completion without stealing that owner", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const bus = new EventBus();
		const writes: Array<{ phases?: TodoPhase[]; edit?: TodoPersistedEdit }> = [];
		const session = createSession(heavyTodoPlan(100), writes, bus);
		await TaskTool.create(session);
		for (let i = 0; i < 100; i++)
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: `worker-${i}`,
				agent: "task",
				status: "started",
				at: i,
				description: `Task ${String(i + 1).padStart(3, "0")} with retained schedule history`,
			});
		expect(writes).toHaveLength(100);
		for (const write of writes) {
			if (write.edit?.kind !== "executor") throw new Error("Missing executor edit");
			expect(write.edit.observation.runningWorkerIds?.length ?? 0).toBeLessThanOrEqual(1);
		}
		const base = structuredClone(session.getTodoPhases!());
		base[0].tasks[0].schedule!.owner = "worker-1";
		session.setTodoPhases!(base);
		writes.length = 0;
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "worker-0", agent: "task", status: "completed", at: 101 });
		const replayed = getLatestTodoPhasesFromEntries([
			{
				type: "custom",
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				id: "base",
				parentId: null,
				timestamp: "2026-11-07T00:00:00Z",
				data: { phases: base },
			},
			...writes.map((write, index) => compactEntry(write.edit!, `e${index}`, "base")),
		]);
		expect(replayed).toEqual(session.getTodoPhases!());
		expect(replayed?.[0].tasks[0].schedule?.owner).toBe("worker-1");
	});

	it("replays old full snapshots plus compact task owner links to the same plan", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "Task agent", systemPrompt: "Run work", source: "bundled" }],
			projectAgentsDir: null,
		});
		const base = heavyTodoPlan(300);
		const eventBus = new EventBus();
		const writes: Array<{ phases?: TodoPhase[]; edit?: TodoPersistedEdit }> = [];
		const session = createSession(base, writes, eventBus);
		await TaskTool.create(session);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Task001Owner",
			agent: "task",
			status: "started",
			description: "Task 001 with retained schedule history",
			at: 1_790_217_222_000,
		});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Task001Owner",
			agent: "task",
			status: "completed",
			resolvedModelIdentity: "openrouter/free",
			resolvedThinkingLevel: "low",
			at: 1_790_217_333_000,
		});

		const compactWrites = writes.map(write => write.edit);
		expect(compactWrites).toHaveLength(2);
		expect(compactWrites.every(Boolean)).toBe(true);
		const entries = [
			{
				type: "custom",
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: base },
				id: "base",
				parentId: null,
				timestamp: "2026-09-25T13:00:00.000Z",
			},
			compactEntry(compactWrites[0]!, "owner-start", "base"),
			compactEntry(compactWrites[1]!, "owner-done", "owner-start"),
		] as SessionEntry[];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(session.getTodoPhases!());
	});
	it("replays archived rows separately without rewriting historical snapshots or losing estimates and execution evidence", () => {
		const now = Date.parse("2026-09-25T13:10:00.000Z");
		const archivedTask = {
			content: "Completed task with retained evidence",
			status: "completed" as const,
			schedule: {
				finishedAt: now - 10 * 60_000,
				estimate: {
					optimisticSeconds: 30,
					likelySeconds: 60,
					pessimisticSeconds: 120,
					confidence: "high" as const,
					basis: "pre-archive estimate",
					updatedAt: now - 20 * 60_000,
				},
				executor: {
					workerId: "archive-fixture-worker",
					startedAt: now - 15 * 60_000,
					finishedAt: now - 10 * 60_000,
					outcome: "completed" as const,
				},
			},
		};
		const base: TodoPhase[] = [
			{ name: "Finished", tasks: [structuredClone(archivedTask)] },
			{ name: "Open", tasks: [{ content: "Still running", status: "in_progress" }] },
		];
		const archivedPhases: TodoPhase[] = [{ name: "Finished", tasks: [structuredClone(archivedTask)] }];
		const edit: TodoPersistedEdit = {
			v: 1,
			kind: "archive",
			at: now,
			operation: {
				v: 1,
				kind: "op",
				at: now,
				op: "block",
				params: { op: "block", task: "Still running", reason: "Waiting" },
			},
			archivedPhases,
		};
		const entries = [
			{
				type: "custom",
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: base },
				id: "base-archive-fixture",
				parentId: null,
				timestamp: new Date(now - 1_000).toISOString(),
			},
			compactEntry(edit, "archive-fixture", "base-archive-fixture"),
		] as SessionEntry[];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual([
			{ name: "Open", tasks: [{ content: "Still running", status: "blocked", blocker: "Waiting" }] },
		]);
		expect(getLatestTodoArchiveFromEntries(entries)).toEqual(archivedPhases);
		expect(getLatestTodoArchiveFromEntries(entries)[0]?.tasks[0]?.schedule?.estimate?.basis).toBe(
			"pre-archive estimate",
		);
		expect(getLatestTodoArchiveFromEntries(entries)[0]?.tasks[0]?.schedule?.executor?.workerId).toBe(
			"archive-fixture-worker",
		);
		// Historical event evidence remains available to consumers of the original full snapshot.
		expect((entries[0] as SessionEntry & { data: { phases: TodoPhase[] } }).data.phases).toEqual(base);
		expect(base[0]?.tasks[0]?.schedule?.estimate?.basis).toBe("pre-archive estimate");
	});
});
