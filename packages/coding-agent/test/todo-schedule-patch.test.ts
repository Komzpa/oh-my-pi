import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { TodoSchedulePatchPersistedEdit } from "@oh-my-pi/pi-tui/tools/todo";
import type { SessionEntry } from "../src/session/session-entries";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "../src/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TodoTracker, type TodoTrackerHost } from "../src/session/todo-tracker";
import { buildTodoSchedulePatchEdit, patchTodoSchedule } from "../src/session/todo-schedule-patch";
import { Settings } from "../src/config/settings";
import { TaskTool } from "../src/task";
import * as discovery from "../src/task/discovery";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../src/task/types";
import type { ToolSession } from "../src/tools";
import { EventBus } from "../src/utils/event-bus";

afterEach(() => mock.restore());

it("worker lifecycle deltas do not clone archived row payloads or mutate earlier snapshots", async () => {
	const tracker = new TodoTracker({} as TodoTrackerHost);
	const phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: Array.from({ length: 520 }, (_, index) => ({
				content: `row-${index}`,
				status: index < 479 ? "completed" : "pending",
				notes: ["archived evidence ".repeat(1024)],
				schedule: { owner: `worker-${index}`, dependencies: [], resources: [] },
			})),
		},
	];
	tracker.setPhases(phases);
	spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
	const eventBus = new EventBus();
	await TaskTool.create({
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		eventBus,
		getTodoPhases: () => tracker.phases,
		getTodoSnapshot: () => tracker.snapshot,
		setTodoPhases: (next: TodoPhase[]) => tracker.setPhases(next),
		persistTodoPhases: () => {},
		registerDisposeCallback: () => {},
	} as unknown as ToolSession);
	const initial = tracker.snapshot;
	const original = globalThis.structuredClone;
	let bytes = 0;
	const clone = spyOn(globalThis, "structuredClone").mockImplementation(value => {
		bytes += JSON.stringify(value).length;
		return original(value);
	});
	for (let worker = 479; worker < 499; worker++) {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: `worker-${worker}`,
			agent: "task",
			row: `row-${worker}`,
			status: "started",
			at: 1,
		});
	}
	expect(bytes).toBeLessThan(400_000);
	expect(clone.mock.calls.length).toBeLessThan(100);
	expect(initial[0]!.tasks[479]!.status).toBe("pending");
	expect(tracker.snapshot[0]!.tasks[479]!.status).toBe("in_progress");
	expect(tracker.snapshot[0]!.tasks[0]).toBe(initial[0]!.tasks[0]);
});

it("annotation patches isolate caller input and preserve executor history and previous snapshots", () => {
	const tracker = new TodoTracker({} as TodoTrackerHost);
	tracker.setPhases([
		{
			name: "Ship",
			tasks: [
				{
					content: "Deliver",
					status: "in_progress",
					schedule: {
						owner: "Worker",
						dependencies: [],
						resources: [],
						executor: { workerId: "Worker", startedAt: 1 },
					},
				},
			],
		},
	]);
	const previous = tracker.snapshot;
	const patch = { progress: { at: 1, evidence: "half done" } };
	const updated = patchTodoSchedule(previous, "Deliver", patch)!;
	tracker.setPhases(updated);
	patch.progress.evidence = "caller changed";
	expect(previous[0]!.tasks[0]!.schedule?.progress).toBeUndefined();
	expect(tracker.snapshot[0]!.tasks[0]!.schedule?.progress).toEqual({ at: 1, evidence: "half done" });
	expect(tracker.snapshot[0]!.tasks[0]!.schedule?.executor?.workerId).toBe("Worker");
	expect(patchTodoSchedule(previous, "missing", patch)).toBeUndefined();
	expect(patchTodoSchedule([...previous, ...previous], "Deliver", patch)).toBeUndefined();
});

it("resume replays annotation deltas with the same completion transition as live updates", () => {
	const initial: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [
				{
					content: "Deliver",
					status: "in_progress",
					schedule: {
						executor: { workerId: "Worker", startedAt: 1, outcome: "completed" },
					},
				},
			],
		},
	];
	const entries: SessionEntry[] = [
		{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: initial } } as SessionEntry,
	];
	const edit: TodoSchedulePatchPersistedEdit = {
		v: 1,
		kind: "schedule_patch",
		task: "Deliver",
		at: 123,
		patch: {
			audit: { verdict: "pass", at: 123, delivery: "Worker:1", repoPath: "/fixture", head: "abc", startedAt: 122 },
		},
	};
	entries.push({ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { edit } } as SessionEntry);
	const live = patchTodoSchedule(initial, edit.task, edit.patch, edit.at)!;
	expect(live[0]!.tasks[0]!.status).toBe("completed");
	expect(live[0]!.tasks[0]!.schedule?.finishedAt).toBe(123);
	expect(getLatestTodoPhasesFromEntries(entries)).toEqual(live);
	expect(JSON.stringify(edit).length).toBeLessThan(512);
});

it("resume preserves explicitly cleared annotation fields across JSON persistence", () => {
	const phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [{ content: "Deliver", status: "pending", schedule: { visibleAt: 1, reviewSummary: "old" } }],
		},
	];
	const edit = buildTodoSchedulePatchEdit("Deliver", { visibleAt: undefined, reviewSummary: undefined }, 2);
	const entries = JSON.parse(
		JSON.stringify([
			{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases } },
			{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { edit } },
		]),
	) as SessionEntry[];
	const restored = getLatestTodoPhasesFromEntries(entries);
	expect(restored[0]!.tasks[0]!.schedule?.visibleAt).toBeUndefined();
	expect(restored[0]!.tasks[0]!.schedule?.reviewSummary).toBeUndefined();
	expect(phases[0]!.tasks[0]!.schedule?.visibleAt).toBe(1);
});

it("resume preserves and replaces the current worker's read-only claim", () => {
	const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Deliver", status: "pending", schedule: {} }] }];
	const reader = buildTodoSchedulePatchEdit(
		"Deliver",
		{
			owner: "reader",
			ownerReadOnly: { owner: "reader", readOnly: true },
		},
		1,
	);
	const writer = buildTodoSchedulePatchEdit(
		"Deliver",
		{
			owner: "writer",
			ownerReadOnly: { owner: "writer", readOnly: false },
		},
		2,
	);
	const entries = JSON.parse(
		JSON.stringify([
			{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases } },
			{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { edit: reader } },
			{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { edit: writer } },
		]),
	) as SessionEntry[];
	const restored = getLatestTodoPhasesFromEntries(entries)[0]!.tasks[0]!.schedule!;
	expect(restored.owner).toBe("writer");
	expect(restored.ownerReadOnly).toEqual({ owner: "writer", readOnly: false });
	expect(restored.readOnly).toBeUndefined();
});

it("resource patch reopens a previously auto-audited row while preserving its old verdict", () => {
	const a = "a1".repeat(20),
		b = "b2".repeat(20);
	const phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [
				{
					content: "Deliver",
					status: "completed",
					schedule: {
						resources: [`git:/work/delivery@${a}`],
						finishedAt: 3,
						executor: { workerId: "Worker", startedAt: 1, finishedAt: 2, outcome: "completed" },
						audit: {
							delivery: JSON.stringify(["Worker", 1, 2]),
							repoPath: "/work/delivery",
							head: a,
							startedAt: 3,
							verdict: "pass",
							agent: "qa-auditor",
						},
					},
				},
			],
		},
	];
	const result = patchTodoSchedule(phases, "Deliver", { resources: [`git:/work/delivery@${b}`] })!;
	expect(result[0]!.tasks[0]!.status).toBe("pending");
	expect(result[0]!.tasks[0]!.schedule!.audit!.resourcesKey).toBe(JSON.stringify([`git:/work/delivery@${a}`]));
	expect(phases[0]!.tasks[0]!.status).toBe("completed");
});

it("rebinding discards only the previous audit escalation and base", () => {
	const a = "a1".repeat(20),
		b = "b2".repeat(20);
	const phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [
				{
					content: "Deliver",
					status: "blocked",
					blocker: "old defect",
					schedule: {
						resources: [`git:/work/delivery@${a}`],
						auditBase: a,
						auditRounds: 3,
						auditEscalation: "old defect",
						review: "user",
						reviewSummary: "old defect",
						handoffPending: true,
						executor: { workerId: "Worker", startedAt: 1, finishedAt: 2, outcome: "completed" },
						audit: {
							delivery: JSON.stringify(["Worker", 1, 2]),
							repoPath: "/work/delivery",
							head: a,
							startedAt: 3,
							verdict: "fail",
							agent: "qa-auditor",
						},
					},
				},
			],
		},
	];
	const row = patchTodoSchedule(phases, "Deliver", { resources: [`git:/work/delivery@${b}`] })![0]!.tasks[0]!;
	expect(row.status).toBe("pending");
	expect(row.blocker).toBeUndefined();
	expect(row.schedule!.auditEscalation).toBeUndefined();
	expect(row.schedule!.auditBase).toBeUndefined();
	expect(row.schedule!.auditRounds).toBe(0);
	expect(row.schedule!.review).toBeUndefined();
	expect(row.schedule!.audit!.verdict).toBe("fail");
});
