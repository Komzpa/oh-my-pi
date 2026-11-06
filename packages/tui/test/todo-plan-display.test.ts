import { expect, test } from "bun:test";
import {
	classifyTodoDisplayRow,
	formatTodoDisplayEta,
	renderTodoPlanDisplay,
	type TodoDisplayContext,
	type TodoScheduleInput,
} from "../src/tools/todo-schedule";
import live from "./fixtures/plandisplay-dc.json";

const phases = live.phases as TodoScheduleInput;
const workers = [
	{ id: "AuditMaxTheme", agent: "qa-auditor", startedAt: 0 },
	{ id: "AuditMacPerf-3", agent: "qa-auditor", startedAt: 0 },
];
const context: TodoDisplayContext = {
	workers,
	owners: new Map(),
	requirements: live.requirements,
	auditors: new Map(live.auditors.flatMap(job => job.rows.map(row => [row, job.workerId] as const))),
};
const paint = (tone: string, text: string): string => `<${tone}>${text}</${tone}>`;

test("DC rows show actual auditors without warning and never infer UseGrid liveness from prose", () => {
	const display = renderTodoPlanDisplay(phases, context, { now: 363264, archived: 444, paint });
	expect(display.lines[0]).toContain("13 open — 0 working · 0 waiting · 3 auditing");
	expect(display.lines[0]).toContain("461 closed (444 archived)");
	for (const line of display.lines.filter(line => line.includes("— auditing")))
		expect(line).not.toContain("<warning>");
	expect(display.lines.join("\n")).not.toContain("waiting on UseGrid");
});

test("seven structured dependencies share one live job group; a dead executor remains stuck", () => {
	const tasks = phases
		.flatMap(phase => phase.tasks)
		.filter(row => row.status === "blocked")
		.slice(0, 7)
		.map(row => ({ ...row, schedule: { ...row.schedule, dependencies: ["UseGrid-3"] } }));
	const worker = { id: "UseGrid-3", startedAt: 0 };
	const input = [{ name: "Follow-ups", tasks }];
	const display = renderTodoPlanDisplay(input, { workers: [worker], owners: new Map() }, { now: 47 * 60000, paint });
	expect(display.lines[0]).toContain("7 open — 0 working · 7 waiting");
	expect(display.lines.filter(line => line.includes("7 waiting on UseGrid-3 (running 47m)"))).toHaveLength(1);
	expect(display.lines.filter(line => line.includes("☐"))).toHaveLength(7);
	expect(display.lines.join("\n")).not.toContain("<warning>");
	expect(classifyTodoDisplayRow(tasks[0]!, input, { workers: [], owners: new Map() }).state).toBe("stuck");
});

test("review and audit pass require a lead action; stale ETA is overdue", () => {
	const row = { content: "deliver", status: "blocked" as const, schedule: { owner: "dead" } };
	const input = [{ name: "Delivery", tasks: [row] }];
	expect(
		classifyTodoDisplayRow(row, input, {
			workers: [],
			owners: new Map(),
			requirements: [
				{ classification: "linked", rows: [row.content], rowVerdicts: { deliver: { status: "pass" } } },
			],
		}).state,
	).toBe("ready to close");
	expect(
		classifyTodoDisplayRow({ ...row, schedule: { review: "user", reviewPagePending: true } }, input, context).state,
	).toBe("needs you");
	expect(formatTodoDisplayEta(0, 5 * 60000)).toBe("overdue 5m");
	expect(formatTodoDisplayEta(10 * 60000, 5 * 60000)).toStartWith("ETA ");
});

test("a live worker keeps a blocked row neutral and a narrow title leaves the state visible", () => {
	const worker = { id: "live-worker", startedAt: 0 };
	const task = {
		content: "A very long title ".repeat(20),
		status: "blocked" as const,
		blocker: "old blocker prose",
		schedule: { owner: worker.id },
	};
	const input = [{ name: "Work", tasks: [task] }];
	const display = renderTodoPlanDisplay(
		input,
		{ workers: [worker], owners: new Map([[task.content, worker]]) },
		{ now: 60000, width: 90, paint },
	);
	const line = display.lines.find(line => line.includes("☐"))!;
	expect(line).toContain("— working · live-worker 1m");
	expect(line).not.toContain("<warning>");
	expect(display.lines[0]).toContain("1 open — 1 working");
});

test("settled rows are verifying or need a worker; stuck names why nothing can act", () => {
	const executor = { workerId: "Fix-2", startedAt: 1, finishedAt: 2, outcome: "completed" as const };
	const delivered = {
		content: "delivered",
		status: "in_progress" as const,
		schedule: { owner: "Fix-2", executor, progress: { at: 2, evidence: "landed in 54b0302ad" } },
	};
	const findings = {
		content: "findings",
		status: "in_progress" as const,
		schedule: {
			owner: "Probe",
			executor: { ...executor, workerId: "Probe" },
			progress: { at: 2, evidence: "answered" },
		},
	};
	const blocked = { content: "blocked", status: "blocked" as const, blocker: "awaiting vendor reply" };
	const dependent = { content: "dependent", status: "pending" as const, schedule: { dependencies: ["blocked"] } };
	const input = [{ name: "Work", tasks: [delivered, findings, blocked, dependent] }];
	const idle = { workers: [], owners: new Map() };
	expect(classifyTodoDisplayRow(delivered, input, idle).state).toBe("verifying");
	expect(classifyTodoDisplayRow(findings, input, idle)).toEqual({
		state: "needs worker",
		reason: "findings",
		previous: "Probe",
	});
	expect(classifyTodoDisplayRow(findings, input, { ...idle, capacityFull: true })).toMatchObject({
		state: "stuck",
		reason: "cap full",
	});
	expect(classifyTodoDisplayRow(dependent, input, idle)).toEqual({
		state: "stuck",
		reason: "blocked dependency blocked",
	});
	const display = renderTodoPlanDisplay(input, idle, { now: 0, width: 120, paint });
	expect(display.lines[0]).toContain("1 verifying");
	expect(display.lines[0]).toContain("1 need worker · 2 stuck");
	expect(display.lines.join("\n")).toContain("findings — needs worker: findings · after Probe");
	expect(display.lines.join("\n")).toContain("blocked — stuck: awaiting vendor reply");
});
