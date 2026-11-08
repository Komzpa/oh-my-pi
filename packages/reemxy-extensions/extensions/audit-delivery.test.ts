import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { classifyTodoDisplayRow } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { patchTodoSchedule } from "../../coding-agent/src/session/todo-schedule-patch";
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

test("delivery runtime completes later-only commit and creates follow-up outside push dependencies", async () => {
	const h = harness();
	await h.audit([later]);
	expect(h.row().status).toBe("completed");
	const followUp = h.phases().flatMap(phase => phase.tasks).find(row => row.content === "Audit follow-up: Commit candidate");
	expect(followUp?.schedule?.progress?.evidence).toContain(later.action);
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


test("follow-ups from separate delivery rows share a single addressable Later phase", () => {
	let phases: TodoPhase[] = [{ name: "Delivery", tasks: [
		{ content: "Commit candidate", status: "completed" },
		{ content: "Push candidate", status: "completed" },
	] }];
	for (const task of ["Commit candidate", "Push candidate"]) {
		phases = patchTodoSchedule(phases, task, { auditFollowUps: [`Add coverage for ${task}`] })!;
	}
	expect(phases.filter(phase => phase.name === "Later").map(phase => phase.tasks.map(row => row.content)))
		.toEqual([["Audit follow-up: Commit candidate", "Audit follow-up: Push candidate"]]);
	expect(phases[1]!.tasks.every(row => row.schedule?.dependencies?.length === 0)).toBe(true);
});

test("new findings on a follow-up stay actionable without nested audit rows", () => {
	let phases: TodoPhase[] = [{ name: "Delivery", tasks: [{ content: "Ship candidate", status: "completed" }] }];
	phases = patchTodoSchedule(phases, "Ship candidate", { auditFollowUps: ["first finding"] }, 1)!;
	phases = patchTodoSchedule(phases, "Audit follow-up: Ship candidate", { auditFollowUps: ["second finding"] }, 2)!;
	const followUps = phases.flatMap(phase => phase.tasks).filter(row => row.content.startsWith("Audit follow-up: "));
	expect(followUps).toHaveLength(1);
	expect(followUps[0]!.notes).toEqual(["first finding", "second finding"]);
	expect(followUps[0]!.status).toBe("pending");
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

test("a later audit on the original row retains previous follow-up evidence", () => {
	let phases: TodoPhase[] = [{ name: "Delivery", tasks: [{ content: "Ship", status: "completed" }] }];
	phases = patchTodoSchedule(phases, "Ship", { auditFollowUps: ["first finding"] }, 1)!;
	phases = patchTodoSchedule(phases, "Audit follow-up: Ship", { auditFollowUps: ["second finding"] }, 2)!;
	phases = patchTodoSchedule(phases, "Ship", { auditFollowUps: ["first finding", "third finding"] }, 3)!;
	const followUps = phases.flatMap(phase => phase.tasks).filter(row => row.content === "Audit follow-up: Ship");
	expect(followUps).toHaveLength(1);
	expect(followUps[0]!.notes).toEqual(["first finding", "second finding", "third finding"]);
	expect(followUps[0]!.schedule?.progress?.evidence).toBe("first finding\nsecond finding\nthird finding");
});
