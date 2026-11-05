import { describe, expect, it } from "bun:test";
import {
	archiveTodoPhases,
	forecastTodoLivePlan,
	getLatestTodoArchiveFromEntries,
	getLatestTodoPhasesFromEntries,
	TodoTool,
	withTodoArchive,
} from "../../src/tools/todo";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import type { SessionEntry } from "../../src/session/session-entries";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import fixture from "../fixtures/dc-plancompact.json";
import {
	estimateFloorRefusal,
	pruneSprintState,
	readPersistedSprintState,
} from "../../../reemxy-extensions/extensions/todo_dispatch";

const phases = fixture.phases as TodoPhase[];
const now = Date.parse("2026-11-05T18:55:10.765Z");
const open = (list: TodoPhase[]) =>
	list.flatMap(phase => phase.tasks).filter(task => task.status !== "completed" && task.status !== "abandoned");

describe("DC plan compaction", () => {
	it("preserves live rows, prerequisite results, deadline math and estimate-floor decisions", () => {
		const compacted = archiveTodoPhases(structuredClone(phases), now);
		expect(compacted.archivedPhases.flatMap(phase => phase.tasks).length).toBeGreaterThan(300);
		expect(open(compacted.phases)).toEqual(open(phases));
		const options = { now, capacity: 4, deadlineAt: now + 3600_000 };
		const before = forecastTodoPlan(phases, options);
		const after = forecastTodoLivePlan(compacted.phases, compacted.archivedPhases, options);
		const live = new Set(compacted.phases.flatMap(phase => phase.tasks).map(task => task.content));
		expect(after).toEqual({ ...before, rows: before.rows.filter(row => live.has(row.content)) });
		const updates = open(phases).map(task => ({
			task: task.content,
			estimate: { likelySeconds: 1, basis: "new attempt" },
		}));
		const floors = { profiles: new Map<string, number[]>(), all: [600_000, 900_000] };
		expect(estimateFloorRefusal(updates, after.rows, floors, now)).toEqual(
			estimateFloorRefusal(updates, before.rows, floors, now),
		);
		const all = withTodoArchive(compacted.phases, compacted.archivedPhases);
		expect(new Map(all.flatMap(phase => phase.tasks).map(task => [task.content, task]))).toEqual(
			new Map(phases.flatMap(phase => phase.tasks).map(task => [task.content, task])),
		);
		const tasks = phases.flatMap(phase => phase.tasks);
		const state = readPersistedSprintState([
			{
				type: "custom",
				customType: "todo-dispatch-sprint-state",
				data: {
					version: 1,
					seenRows: tasks.map(task => task.content),
					rowStatuses: Object.fromEntries(tasks.map(task => [task.content, task.status])),
					workerFinishes: tasks
						.filter(task => task.status === "completed")
						.map(task => ({ jobId: task.content, id: task.content, row: task.content, at: now - 86400_000 })),
				},
			},
		]);
		expect(
			pruneSprintState(state, new Set(all.flatMap(phase => phase.tasks).map(task => task.content)), now),
		).toEqual(pruneSprintState(state, new Set(tasks.map(task => task.content)), now));
	});

	it("retains review, handoff and open-row dependency neighbours while archiving ordinary closed rows", () => {
		const rows = structuredClone(phases)
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "completed")
			.slice(0, 60);
		for (const row of rows) row.schedule = { finishedAt: now - 1000 };
		rows[0]!.schedule!.review = "user";
		rows[1]!.schedule!.handoffPending = true;
		rows[2]!.schedule!.reviewPagePending = true;
		const pending = {
			content: "dependent",
			status: "pending" as const,
			schedule: { dependencies: [rows[3]!.content] },
		};
		const result = archiveTodoPhases([{ name: "DC", tasks: [...rows, pending] }], now);
		const live = result.phases.flatMap(phase => phase.tasks);
		expect(live).toEqual([...rows.slice(0, 4), ...rows.slice(-10), pending]);
		expect(result.archivedPhases.flatMap(phase => phase.tasks)).toHaveLength(46);
	});

	it("persists compaction on closure, looks up archived content, accepts legacy archived deliveries and reloads", async () => {
		let live = structuredClone(phases);
		const entries: SessionEntry[] = [
			{
				type: "custom",
				customType: "user_todo_edit",
				data: { phases: live },
				id: "initial",
				parentId: null,
				timestamp: new Date(now).toISOString(),
			} as SessionEntry,
		];
		// The real session loader migrates legacy accepted rows before the tool sees them.
		live = getLatestTodoPhasesFromEntries(entries);
		const loaded = structuredClone(live);
		const session = {
			cwd: "/tmp/plancompact-test",
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getTodoPhases: () => live,
			setTodoPhases: (next: TodoPhase[]) => {
				live = next;
			},
			sessionManager: { getBranch: () => entries },
		} as unknown as ToolSession;
		const persist = (edit: unknown) =>
			entries.push({
				type: "custom",
				customType: "user_todo_edit",
				data: { edit },
				id: String(entries.length),
				parentId: entries.at(-1)!.id,
				timestamp: new Date(now).toISOString(),
			} as SessionEntry);
		const tool = new TodoTool(session);
		const closed = await tool.execute("close", { op: "done", task: open(live)[0]!.content });
		expect(closed.isError).not.toBe(true);
		expect(closed.details?.edit?.kind).toBe("archive");
		const legacyArchive = structuredClone(closed.details?.edit);
		if (legacyArchive?.kind !== "archive") throw new Error("Expected compaction event");
		// Older archivers hid completed deliveries before their user review was accepted.
		const delivery = legacyArchive.archivedPhases[0]!.tasks[0]!;
		delivery.schedule = { ...delivery.schedule, review: "user" };
		persist(legacyArchive);
		expect(closed.content[0]).toMatchObject({ text: expect.stringContaining("closed rows archived (done ") });
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(live);
		const archived = getLatestTodoArchiveFromEntries(entries).flatMap(phase => phase.tasks)[0]!;
		const ordinary = await tool.execute("totals", { op: "view" });
		const total = loaded.flatMap(phase => phase.tasks).length;
		const closedCount = total - open(loaded).length + 1;
		expect(ordinary.content[0]).toMatchObject({
			text: expect.stringContaining(`Overall: ${closedCount}/${total} done`),
		});
		expect(archived.schedule?.review).toBe("user");
		const found = await tool.execute("get", { op: "view", task: archived.content });
		expect(found.content[0]).toMatchObject({ text: expect.stringContaining(archived.content) });
		const accepted = await tool.execute("accept", {
			op: "schedule",
			updates: [{ task: archived.content, review: "accepted" }],
		});
		expect(accepted.isError).not.toBe(true);
		persist(accepted.details?.edit);
		const restored = withTodoArchive(
			getLatestTodoPhasesFromEntries(entries),
			getLatestTodoArchiveFromEntries(entries),
		).flatMap(phase => phase.tasks);
		expect(restored.find(task => task.content === archived.content)).toMatchObject({
			status: "completed",
			schedule: { review: "accepted" },
		});
		expect(restored.filter(task => task.content === archived.content)).toHaveLength(1);
	});
});
