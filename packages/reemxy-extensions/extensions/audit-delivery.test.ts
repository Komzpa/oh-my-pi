import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { classifyTodoDisplayRow } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { buildTodoSchedulePatchEdit, patchTodoSchedule } from "../../coding-agent/src/session/todo-schedule-patch";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "../../coding-agent/src/tools/todo";
import type { SessionEntry } from "../../coding-agent/src/session/session-entries";
import { queueDeliveryCritic } from "./delivery_critic";

let serial = 0;
function harness() {
	let phases: TodoPhase[] = [{ name: "Delivery", tasks: [
		{ content: "Commit candidate", status: "in_progress", schedule: { executor: { workerId: "Builder", startedAt: 1, finishedAt: 2, outcome: "completed", gitCommits: [{ commit: "a".repeat(40), repoPath: "/project" }] } } },
		{ content: "Push candidate", status: "pending", schedule: { dependencies: ["Commit candidate"] } },
		{ content: "Merge PR", status: "pending", schedule: { dependencies: ["Push candidate"] } },
	] }];
	let findings: object[] = [];
	let launches = 0;
	const ctx = {
		cwd: "/project", sessionManager: { getHeader: () => ({ id: `severity-${serial}` }) },
		getTodoPhases: () => phases,
		updateTodoSchedule: (task: string, patch: Partial<TodoSchedule>) => { phases = patchTodoSchedule(phases, task, patch)!; return true; },
		setTimeout: () => 1, clearTimer: () => {},
		runDeliveryCritic: async () => { launches++; return { details: { results: [{ output: JSON.stringify({ verdict: findings.length ? "defects" : "clean", findings }) }] } }; },
	} as unknown as ExtensionContext;
	serial++;
	return {
		row: () => phases[0]!.tasks[0]!, phases: () => phases, launches: () => launches,
		async audit(next: object[]) {
			findings = next;
			const row = phases[0]!.tasks[0]!;
			queueDeliveryCritic(ctx, row, "", async () => {});
			await Bun.sleep(0);
		},
		repair(round: number) {
			const row = phases[0]!.tasks[0]!;
			row.status = "in_progress";
			row.schedule!.executor = { ...row.schedule!.executor!, workerId: `Builder-${round}`, startedAt: round * 10, finishedAt: round * 10 + 1 };
		},
	};
}
const later = { kind: "test_shape", severity: "later", evidence: "Add boundary coverage", action: "Add the empty-result fixture" };
const blocker = { kind: "collateral_defect", severity: "blocker", evidence: "Save loses records", action: "Repair persistence and rerun Save test" };

test("delivery runtime keeps later-only advice on the completed delivery without growing mandatory work", async () => {
	const h = harness();
	await h.audit([later]);
	expect(h.row().status).toBe("completed");
	expect(h.phases().flatMap(phase => phase.tasks)).toHaveLength(3);
	expect(h.row().notes).toContain(later.action);
	expect(h.row().schedule?.auditFollowUps).toContain(later.action);
	expect(h.phases()[0]!.tasks[1]!.schedule!.dependencies).toEqual(["Commit candidate"]);
});

test("delivery runtime blocks regressions but a clean repair completes without another audit", async () => {
	const h = harness();
	await h.audit([blocker]);
	expect(h.row().schedule!.deliveryCritic?.verdict).toBe("defects");
	h.repair(2);
	await h.audit([]);
	expect(h.row().status).toBe("completed");
	expect(h.launches()).toBe(2);
});

test("delivery runtime caps blocker repairs and preserves the blocker list for the user", async () => {
	const h = harness();
	for (let round = 1; round <= 3; round++) { if (round > 1) h.repair(round); await h.audit([blocker, later]); }
	expect(h.row().schedule!.auditEscalation).toContain(blocker.evidence);
	expect(classifyTodoDisplayRow(h.row(), h.phases(), { workers: [], owners: new Map() }).state).toBe("handoff pending");
	h.repair(4);
	await h.audit([blocker]);
	expect(h.launches()).toBe(3);
});


test("advice on separate deliveries preserves work counts and accepted state", () => {
	let phases: TodoPhase[] = [{ name: "Delivery", tasks: [
		{ content: "Commit candidate", status: "completed", schedule: { review: "accepted", finishedAt: 7 } },
		{ content: "Push candidate", status: "completed" },
	] }];
	for (const task of ["Commit candidate", "Push candidate"]) {
		phases = patchTodoSchedule(phases, task, { auditFollowUps: [`Add coverage for ${task}`] })!;
	}
	expect(phases).toHaveLength(1);
	expect(phases[0]!.tasks).toHaveLength(2);
	for (const row of phases[0]!.tasks) {
		expect(row.status).toBe("completed");
		expect(row.notes).toEqual([`Add coverage for ${row.content}`]);
	}
	expect(phases[0]!.tasks[0]!.schedule).toMatchObject({ review: "accepted", finishedAt: 7 });
});

test("advice on an accepted legacy follow-up preserves its history without reopening or nesting", () => {
	const history = [{ attemptId: "old", workerName: "old", resolvedModel: "fixture", effort: "low", terminalStatus: "completed" as const, startedAt: 1, finishedAt: 2, durationMs: 1, deliverablePaths: ["result.md"] }];
	const phases: TodoPhase[] = [{ name: "Later", tasks: [{
		content: "Audit follow-up: Ship candidate", status: "completed", notes: ["first finding"],
		schedule: { review: "accepted", finishedAt: 3, attemptHistory: history },
	}] }];
	const updated = patchTodoSchedule(phases, "Audit follow-up: Ship candidate", { auditFollowUps: ["second finding"] }, 4)!;
	const row = updated[0]!.tasks[0]!;
	expect(updated.flatMap(phase => phase.tasks)).toHaveLength(1);
	expect(row.notes).toEqual(["first finding", "second finding"]);
	expect(row.status).toBe("completed");
	expect(row.schedule).toMatchObject({ review: "accepted", finishedAt: 3, attemptHistory: history });
	expect(phases[0]!.tasks[0]!.notes).toEqual(["first finding"]);
});

test("follow-up escalation remains blocked and keeps the new finding", () => {
	let phases: TodoPhase[] = [{ name: "Later", tasks: [{ content: "Audit follow-up: Existing delivery", status: "in_progress", notes: ["earlier"] }] }];
	phases = patchTodoSchedule(phases, "Audit follow-up: Existing delivery", { auditEscalation: "needs decision", auditFollowUps: ["later finding"] }, 3)!;
	const row = phases[0]!.tasks[0]!;
	expect(phases[0]!.tasks).toHaveLength(1);
	expect(row.status).toBe("blocked");
	expect(row.blocker).toBe("needs decision");
	expect(row.notes).toEqual(["earlier", "later finding"]);
});

test("a later audit retains origin findings and leaves existing legacy follow-up history untouched", () => {
	const legacy: TodoPhase["tasks"][number] = {
		content: "Audit follow-up: Ship", status: "abandoned", notes: ["legacy finding", "superseded: old delivery"],
		schedule: { auditOrigin: { parent: "Ship", supersededAt: 2, resolution: "accept" }, progress: { at: 2, evidence: "legacy proof" } },
	};
	let phases: TodoPhase[] = [{ name: "Delivery", tasks: [{ content: "Ship", status: "completed", notes: ["delivery proof"] }, legacy] }];
	phases = patchTodoSchedule(phases, "Ship", { auditFollowUps: ["first finding"] }, 1)!;
	phases = patchTodoSchedule(phases, "Ship", { auditFollowUps: ["first finding", "third finding"] }, 3)!;
	expect(phases.flatMap(phase => phase.tasks)).toHaveLength(2);
	expect(phases[0]!.tasks[0]!.notes).toEqual(["delivery proof", "first finding", "third finding"]);
	expect(phases[0]!.tasks[0]!.status).toBe("completed");
	expect(phases[0]!.tasks[1]).toBe(legacy);
	expect(legacy.notes).toEqual(["legacy finding", "superseded: old delivery"]);
});

test("advice preserves a pending human approval and its criterion-bound evidence", () => {
	const phases: TodoPhase[] = [{ name: "Delivery", tasks: [{
		content: "Owner approval", status: "pending", notes: ["existing proof"],
		schedule: { decision: "owner", review: "user", handoffPending: true, reviewPage: "https://review.example/card", materialInputs: { criterion: "original acceptance", receipts: ["receipt-1"], prerequisites: [] } },
	}] }];
	const updated = patchTodoSchedule(phases, "Owner approval", { auditFollowUps: ["Try another layout later"] })!;
	const row = updated[0]!.tasks[0]!;
	expect(updated.flatMap(phase => phase.tasks)).toHaveLength(1);
	expect(row.status).toBe("pending");
	expect(row.schedule).toMatchObject(phases[0]!.tasks[0]!.schedule!);
	expect(row.notes).toEqual(["existing proof", "Try another layout later"]);
});

test("legacy delta replay retains already-generated follow-up evidence", () => {
	const entries = JSON.parse(JSON.stringify([
		{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: [{ name: "Delivery", tasks: [{ content: "Ship", status: "completed" }] }] } },
		{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { edit: { v: 1, kind: "schedule_patch", task: "Ship", at: 1, patch: { auditFollowUps: ["old advice"] } } } },
		{ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { edit: { v: 1, kind: "schedule_patch", task: "Audit follow-up: Ship", at: 2, patch: { progress: { at: 2, evidence: "Historical worker findings" } } } } },
	])) as SessionEntry[];
	const restored = getLatestTodoPhasesFromEntries(entries);
	const legacy = restored.flatMap(phase => phase.tasks).find(row => row.content === "Audit follow-up: Ship");
	expect(legacy?.schedule?.progress?.evidence).toBe("Historical worker findings");
	expect(legacy?.notes).toContain("old advice");
});


test("new advice deltas survive JSON replay without creating mandatory work", () => {
 const initial: TodoPhase[] = [{ name: "Delivery", tasks: [{ content: "Ship", status: "completed" }] }];
 const edit = buildTodoSchedulePatchEdit("Ship", { auditFollowUps: ["optional improvement"] }, 1);
 expect(edit.adviceOnly).toBe(true);
 const entries = JSON.parse(JSON.stringify([
  { type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: initial } },
  { type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { edit } },
 ])) as SessionEntry[];
 const restored = getLatestTodoPhasesFromEntries(entries);
 const rows = restored.flatMap(phase => phase.tasks);
 expect(rows).toHaveLength(1);
 expect(rows[0]!.status).toBe("completed");
 expect(rows[0]!.notes).toContain("optional improvement");
 expect(rows[0]!.schedule?.auditFollowUps).toEqual(["optional improvement"]);
});
