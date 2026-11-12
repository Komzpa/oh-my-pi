import { expect, test } from "bun:test";
import {
	classifyTodoDisplayRow,
	forecastTodoPlan,
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
	expect(display.lines[0]).toContain("13 open — 0 working · 3 auditing");
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
	).toBe("handoff pending");
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

test("settled rows queue audits or need a worker; stuck names why nothing can act", () => {
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
	expect(classifyTodoDisplayRow(delivered, input, idle).state).toBe("audit queued");
	expect(classifyTodoDisplayRow(findings, input, idle)).toEqual({
		state: "needs worker",
		reason: "findings",
		previous: "Probe",
	});
	expect(classifyTodoDisplayRow(findings, input, { ...idle, capacityFull: true })).toMatchObject({
		state: "waiting",
		reason: "cap full",
		previous: "Probe",
	});
	expect(classifyTodoDisplayRow(dependent, input, idle)).toEqual({
		state: "stuck",
		reason: "blocked dependency blocked",
	});
	const display = renderTodoPlanDisplay(input, idle, { now: 0, width: 120, paint });
	expect(display.lines[0]).toContain("1 audit queued");
	expect(display.lines[0]).toContain("1 need worker · 2 stuck");
	expect(display.lines.join("\n")).toContain("findings — needs worker: findings · after Probe");
	expect(display.lines.join("\n")).toContain("blocked — stuck: awaiting vendor reply");
	const full = renderTodoPlanDisplay(input, { ...idle, capacityFull: true }, { now: 0, width: 120, paint });
	expect(full.lines[0]).toContain("1 waiting");
	expect(full.lines[0]).toContain("2 stuck");
	const capacityRow = full.lines.find(line => line.includes("findings —"))!;
	expect(capacityRow).toContain("waiting for a worker slot · after Probe");
	expect(capacityRow).not.toContain("<warning>");
	expect(capacityRow).not.toContain("undefined");
	expect(full.lines.join("\n")).toContain("blocked — stuck: awaiting vendor reply");
});

test("a crash continuation is visibly working under its new worker id", () => {
	const worker = { id: "ContinentalSnail-2", startedAt: 1 };
	const input: TodoScheduleInput = [
		{
			name: "Work",
			tasks: [
				{
					content: "Power source",
					status: "in_progress",
					schedule: { owner: worker.id, executor: { workerId: worker.id, startedAt: 1, resumedAfterCrash: true } },
				},
			],
		},
	];
	const output = renderTodoPlanDisplay(
		input,
		{ workers: [worker], owners: new Map([["Power source", worker]]) },
		{ now: 2, paint },
	);
	expect(output.lines.join("\n")).toContain("working · ContinentalSnail-2 (resumed after crash)");
});

test("rows with a live worker are highlighted; idle rows stay dim; owner rows warn", () => {
	const display = renderTodoPlanDisplay(phases, context, { now: 363264, archived: 444, paint });
	const auditing = display.lines.filter(line => line.includes("— auditing ·"));
	expect(auditing.length).toBe(3);
	for (const line of auditing) expect(line.startsWith("<accent>")).toBe(true);
	for (const line of display.lines.filter(line => line.includes("☐") && line.includes("— needs you")))
		expect(line.startsWith("<warning>")).toBe(true);
});

test("working rows name each worker's profile and model", () => {
	const task = { content: "Row with worker", status: "in_progress", schedule: { executor: { workerId: "W-1" } } };
	const worker = { id: "W-1", agent: "ui-coder", model: "gpt-6.1-terra:low", startedAt: 0 };
	const display = renderTodoPlanDisplay(
		[{ name: "Stage", tasks: [task] }] as never,
		{ workers: [worker], owners: new Map([["Row with worker", worker]]) },
		{ now: 3 * 60_000, width: 200, paint },
	);
	const row = display.lines.find(line => line.includes("Row with worker"))!;
	expect(row).toContain("W-1 (ui-coder) gpt-6.1-terra:low 3m");
});

test("the HUD shows the residual forecast and leaves worker risk in the detailed view", () => {
	const now = Date.UTC(2026, 10, 6, 19, 0);
	const input: TodoScheduleInput = [
		{
			name: "Stage",
			tasks: [
				{
					content: "Delivery row",
					status: "in_progress",
					schedule: {
						dependencies: [],
						resources: ["shared"],
						owner: "Worker-1",
						startedAt: now,
						estimate: {
							optimisticSeconds: 600,
							likelySeconds: 600,
							pessimisticSeconds: 600,
							updatedAt: now,
							confidence: "high",
							basis: "observed delivery duration",
						},
					},
				},
				{
					content: "Acceptance after delivery",
					status: "pending",
					schedule: {
						dependencies: ["Delivery row"],
						resources: ["shared"],
						estimate: {
							optimisticSeconds: 7200,
							likelySeconds: 7200,
							pessimisticSeconds: 7200,
							updatedAt: now,
							confidence: "high",
							basis: "observed acceptance duration",
						},
					},
				},
			],
		},
	];
	const forecast = forecastTodoPlan(input, {
		now,
		deadlineAt: now + 2 * 3600_000,
		capacity: 1,
		executableCapacity: 1,
	});
	forecast.risk = {
		p50Finish: now + 20 * 60_000,
		p80Finish: now + 30 * 60_000,
		p90Finish: now + 40 * 60_000,
		onTimeProbability: 0.4,
		samples: 100,
		criticalRows: [],
	};
	const finish = forecast.autoDeadlineForecast?.finish;
	expect(finish).toBeGreaterThan(now + 2 * 3600_000);
	const clock = (at: number) =>
		new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	const display = renderTodoPlanDisplay(
		input,
		{ workers: [], owners: new Map() },
		{ now, width: 1000, forecast, paint },
	);
	expect(display.lines.join("\n")).toContain(`ETA ${clock(finish!)}`);
	expect(display.lines.join("\n")).toContain(`due ${clock(forecast.deadlineAt!)}`);
	expect(display.lines.join("\n")).not.toContain("Worker-attempt diagnostic");
	const detail = renderTodoPlanDisplay(input, { workers: [], owners: new Map() }, { now, forecast, paint });
	expect(detail.lines.join("\n")).toContain(`Worker-attempt diagnostic ${clock(forecast.risk.p80Finish)}`);
	expect(display.lines[0]).not.toContain("P(on time)");
});

test("narrow HUD keeps the task and live owner ahead of attempt diagnostics", () => {
	const worker = { id: "RepairScene-22", agent: "ui-coder", model: "example-model:high", startedAt: 0 };
	const task = {
		content: "Repair scene controls and selection",
		status: "in_progress" as const,
		schedule: { owner: worker.id, firstRequirementAt: 0, executor: { workerId: worker.id, startedAt: 0 } },
	};
	const input = [{ name: "Delivery", tasks: [task] }];
	const display = renderTodoPlanDisplay(
		input,
		{ workers: [worker], owners: new Map([[task.content, worker]]) },
		{ now: 1200 * 60000, width: 100, paint: (_tone, text) => text },
	);
	const row = display.lines.find(line => line.includes("☐"))!;
	expect(row).toContain("Repair scene controls");
	expect(row).toContain("— working");
	expect(row).toContain(worker.id);
	expect(Bun.stringWidth(row)).toBeLessThanOrEqual(100);
	expect(display.lines[0]).not.toContain("0 auditing");
	expect(display.lines[0]).not.toContain("0 handoff pending");
	const detail = renderTodoPlanDisplay(
		input,
		{ workers: [worker], owners: new Map() },
		{
			now: 1200 * 60000,
			paint: (_tone, text) => text,
		},
	);
	expect(detail.lines.join("\n")).toContain("queue/downtime unknown");
});

test("bounded HUD separates the forecast and keeps its due time ahead of diagnostic prose", () => {
	const now = Date.UTC(2026, 10, 11, 12);
	const input: TodoScheduleInput = [
		{
			name: "Delivery",
			tasks: [{ content: "Await source", status: "blocked", blocker: "Source authorization is missing" }],
		},
	];
	const forecast = forecastTodoPlan(input, { now, deadlineAt: now - 3600000, executableCapacity: 1 });
	forecast.unknownGates = ["Unchanged diagnostic detail ".repeat(30)];
	const display = renderTodoPlanDisplay(
		input,
		{ workers: [], owners: new Map() },
		{ now, width: 100, forecast, paint: (_tone, text) => text },
	);
	const line = display.lines.find(line => line.startsWith("Current ETA unknown"));
	expect(line).toBeDefined();
	expect(line).toContain("due ");
	expect(line).toContain("overdue 1h0m");
	expect(Bun.stringWidth(line!)).toBeLessThanOrEqual(100);
	expect(display.lines[0]).not.toContain("Unchanged diagnostic");
});
