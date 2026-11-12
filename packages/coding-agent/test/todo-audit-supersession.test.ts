import { TodoTool, archiveTodoPhases } from "../src/tools/todo";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { expect, test } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { patchTodoSchedule } from "../src/session/todo-schedule-patch";

test("legacy replay pins the parent delivery rather than losing its lineage", () => {
	const phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [
				{
					content: "Deliver",
					status: "completed",
					schedule: {
						executor: {
							workerId: "worker",
							startedAt: 1,
							gitCommits: [{ commit: "a1".repeat(20), repoPath: "/repo" }],
						},
					},
				},
			],
		},
	];
	const result = patchTodoSchedule(phases, "Deliver", { auditFollowUps: ["Check doc/product.md"] }, 1, {
		legacyFollowUps: true,
	})!;
	const row = result.flatMap(phase => phase.tasks).find(task => task.content.startsWith("Audit follow-up:"))!;
	expect(row.schedule?.auditOrigin).toMatchObject({ parent: "Deliver", commit: "a1".repeat(20), repoPath: "/repo" });
});

test("a one-shot retarget that cannot verify closes dropped rather than returning to the backlog", () => {
	const phases: TodoPhase[] = [
		{
			name: "Later",
			tasks: [
				{
					content: "Audit follow-up: Deliver",
					notes: ["Check doc/product.md"],
					status: "pending",
					schedule: {
						auditOrigin: { parent: "Deliver", commit: "a1".repeat(20), supersededAt: 1, resolution: "retarget" },
					},
				},
			],
		},
	];
	const result = patchTodoSchedule(
		phases,
		"Audit follow-up: Deliver",
		{
			audit: { delivery: "[]", head: "a1".repeat(20), repoPath: "/repo", startedAt: 2, verdict: "inconclusive" },
			auditFollowUps: ["retry"],
		},
		3,
	)!;
	expect(result.flatMap(phase => phase.tasks)).toHaveLength(1);
	expect(result[0]!.tasks[0]!.status).toBe("abandoned");
	expect(result[0]!.tasks[0]!.notes).toContain("Check doc/product.md");
});

test("model superseded drop accepts delivered rows and archives the finding and reason", async () => {
	let phases: TodoPhase[] = [
		{
			name: "Later",
			tasks: [
				{
					content: "Audit follow-up: Deliver",
					notes: ["Original finding"],
					status: "pending",
					schedule: {
						executor: { workerId: "worker", startedAt: 1, finishedAt: 2, outcome: "completed" },
						auditOrigin: { parent: "Deliver", supersededAt: 3, resolution: "retarget" },
					},
				},
			],
		},
	];
	const tool = new TodoTool({
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	} as ToolSession);
	const reason = "superseded: origin/old merged/removed; finding not carried forward";
	await tool.execute("drop", { op: "drop", task: "Audit follow-up: Deliver", reason });
	const row = phases[0]!.tasks[0]!;
	expect(row.status).toBe("abandoned");
	expect(row.notes).toContain(reason);
	row.schedule!.finishedAt = 1;
	phases[0]!.tasks.push(
		...Array.from({ length: 50 }, (_, i) => ({
			content: `Done ${i}`,
			status: "completed" as const,
			schedule: { finishedAt: i + 2 },
		})),
	);
	const archived = archiveTodoPhases(phases, 100)
		.archivedPhases.flatMap(phase => phase.tasks)
		.find(task => task.content === row.content)!;
	expect(archived.notes).toEqual(["Original finding", reason]);
});

test("new delivery advice stays on the origin while legacy follow-up history stays closed", () => {
	const oldCommit = "a1".repeat(20);
	let phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [
				{
					content: "Deliver",
					status: "completed",
					schedule: {
						executor: { workerId: "old", startedAt: 1, gitCommits: [{ commit: oldCommit, repoPath: "/repo" }] },
					},
				},
			],
		},
	];
	phases = patchTodoSchedule(phases, "Deliver", { auditFollowUps: ["old finding"] }, 1, { legacyFollowUps: true })!;
	const follow = phases.flatMap(phase => phase.tasks).find(row => row.content === "Audit follow-up: Deliver")!;
	follow.status = "abandoned";
	follow.schedule!.auditOrigin = { ...follow.schedule!.auditOrigin!, supersededAt: 2, resolution: "accept" };
	phases = patchTodoSchedule(phases, "Deliver", { auditFollowUps: ["old finding", "late old finding"] })!;
	expect(phases.flatMap(phase => phase.tasks).find(row => row.content === follow.content)!.status).toBe("abandoned");
	phases = patchTodoSchedule(phases, "Deliver", {
		executor: { workerId: "new", startedAt: 3, gitCommits: [{ commit: "b2".repeat(20), repoPath: "/repo" }] },
	})!;
	phases = patchTodoSchedule(phases, "Deliver", { auditFollowUps: ["new unresolved finding"] })!;
	const next = phases.flatMap(phase => phase.tasks).find(row => row.content === follow.content)!;
	expect(next.status).toBe("abandoned");
	expect(next.notes).not.toContain("new unresolved finding");
	expect(phases[0]!.tasks[0]!.notes).toContain("new unresolved finding");
	expect(next.notes).toContain("old finding");
	expect(next.schedule?.auditOrigin?.commit).toBe(oldCommit);
	expect(next.schedule?.auditOrigin?.supersededAt).toBe(2);
	const recursive = patchTodoSchedule(phases, next.content, { auditFollowUps: ["check again"] })!;
	expect(recursive.flatMap(phase => phase.tasks)).toHaveLength(2);
});
