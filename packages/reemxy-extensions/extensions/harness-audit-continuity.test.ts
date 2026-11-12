import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { expect, test } from "bun:test";
import {
	TODO_ROW_AUDITOR,
	todoAuditResourcesKey,
	todoRowAfterWorker,
	todoRowDeliveryKey,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { planRowAudits, rowAuditTask, type RowAuditRow } from "./row_audit";

const root = "/fixture/repo";
const head = "7554bbb4a94cb8af1cb79db5052ae62f156e5d95";
const recovered =
	"git diff 574fe2d635ef23e9c05c613386e3632c2f613ef6 e2635974e729b6a9c3a7850d3f79cbc4aa6daeab; complete output artifact://1659";
function fixture(): RowAuditRow {
	const row: RowAuditRow = {
		content: "Audit follow-up: Transform XMOVA Sync transcript into requirements",
		status: "in_progress",
		schedule: {
			materialInputs: { criterion: "criterion:v1", receipts: [], prerequisites: [] },
			resources: [`git:${root}@${head}`],
			executor: { workerId: "Producer", startedAt: 1, finishedAt: 2, outcome: "completed" },
			progress: { at: 3, evidence: recovered },
		},
	};
	row.schedule!.audit = {
		materialInputs: structuredClone(row.schedule!.materialInputs),
		delivery: todoRowDeliveryKey(row.schedule),
		repoPath: root,
		head,
		resourcesKey: todoAuditResourcesKey(row.schedule),
		startedAt: 4,
		at: 5,
		agent: TODO_ROW_AUDITOR,
		verdict: "inconclusive",
		attempts: 2,
		evidence: recovered,
		findings: "Owner-selected extraction revision still missing",
	};
	return row;
}
const plan = (row: RowAuditRow) =>
	planRowAudits(
		[row],
		new Map([[root, head]]),
		root,
		() => false,
		() => false,
	);

test("G06 administrative evidence cannot reopen two exhausted attempts", () => {
	const row = fixture();
	row.schedule!.progress = { at: 6, evidence: "Conditional estimate updated; same artifact and missing prerequisite" };
	expect(todoRowAfterWorker(row)).toMatchObject({ kind: "needs-worker", reason: "audit-inconclusive" });
});

test("G06 planner cannot reset exhausted budget for administration", () => {
	const row = fixture();
	row.schedule!.progress = { at: 6, evidence: "Conditional estimate updated; same artifact and missing prerequisite" };
	expect(plan(row)).toHaveLength(0);
});

test("G07 next handoff retains recovered immutable locator after progress overwrite", () => {
	const row = fixture();
	row.schedule!.materialInputs = { criterion: "criterion:v1", receipts: ["git:abc1234/check:1"], prerequisites: [] };
	row.schedule!.progress = { at: 6, evidence: "New executable receipt at abc1234: bun test, exit 0" };
	const batches = plan(row);
	expect(batches).toHaveLength(1);
	expect(rowAuditTask(batches[0]!)).toContain(recovered);
});

test("incompatible revision cannot carry previous recovered references", () => {
	const row = fixture();
	row.schedule!.audit!.head = "fdea52bf26f1950408df61ed8a78f7a2980a5f76";
	row.schedule!.materialInputs = { criterion: "criterion:v1", receipts: ["git:abc1234/check:1"], prerequisites: [] };
	row.schedule!.progress = { at: 6, evidence: "New executable receipt at abc1234: bun test, exit 0" };
	expect(rowAuditTask(plan(row)[0]!)).not.toContain(recovered);
});

test("new executable receipt remains auditable while timestamp alone does not", () => {
	const row = fixture();
	row.schedule!.progress!.at = 6;
	expect(plan(row)).toHaveLength(0);
	row.schedule!.materialInputs = { criterion: "criterion:v1", receipts: ["git:abc1234/check:1"], prerequisites: [] };
	row.schedule!.progress!.evidence = "New executable receipt at abc1234: bun test, exit 0";
	expect(plan(row)[0]!.rows[0]!.attempt).toBe(1);
});

for (const kind of ["criterion", "prerequisite"] as const) {
	test(`new ${kind} is auditable without new progress prose`, () => {
		const row = fixture();
		if (kind === "criterion") row.schedule!.materialInputs!.criterion = "criterion:v2";
		else row.schedule!.materialInputs!.prerequisites = ["receipt:available-source-v1"];
		expect(todoRowAfterWorker(row)).toMatchObject({ kind: "verify" });
		expect(plan(row)[0]!.rows[0]!.attempt).toBe(1);
		if (kind === "criterion") {
			row.schedule!.progress = { at: 9, evidence: "Criterion changed" };
			expect(rowAuditTask(plan(row)[0]!)).not.toContain(recovered);
		}
	});
}
test("legacy prose receipt is fail closed until explicitly migrated", () => {
	const row = fixture();
	delete row.schedule!.materialInputs;
	delete row.schedule!.audit!.materialInputs;
	row.schedule!.progress = { at: 9, evidence: "New executable receipt at abc1234: bun test, exit 0" };
	expect(plan(row)).toHaveLength(0);
});

for (const field of ["receipts", "prerequisites"] as const) {
	test(`removing ${field} alone does not reopen the exhausted audit budget`, () => {
		const row = fixture();
		row.schedule!.audit!.materialInputs![field] = ["receipt:previously-available"];
		// The same criterion has less evidence, not a newly available input.
		expect(todoRowAfterWorker(row)).toMatchObject({ kind: "needs-worker", reason: "audit-inconclusive" });
		expect(plan(row)).toHaveLength(0);
		row.schedule!.materialInputs![field] = ["receipt:replacement"];
		expect(plan(row)[0]!.rows[0]!.attempt).toBe(1);
	});
}

test("schedule writer retains material identity across administrative updates and persisted reload", async () => {
	const row = fixture();
	row.schedule!.dependencies = [];
	row.schedule!.estimate = {
		optimisticSeconds: 1,
		likelySeconds: 2,
		pessimisticSeconds: 3,
		confidence: "high",
		basis: "fixture",
		updatedAt: 1,
	};
	let phases: TodoPhase[] = [{ name: "Audit", tasks: [{ ...row, details: "", notes: [] }] }];
	const tool = new TodoTool({
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
		settings: Settings.isolated(),
	} as ToolSession);
	const materialInputs = { criterion: "criterion:v1", receipts: ["git:abc1234/check:1"], prerequisites: [] };
	await tool.execute("receipt", {
		op: "schedule",
		updates: [{ task: row.content, materialInputs, evidence: "Receipt published" }],
	});
	await tool.execute("admin", {
		op: "schedule",
		updates: [{ task: row.content, evidence: "Estimate administration" }],
	});
	const reloaded = JSON.parse(JSON.stringify(phases)) as TodoPhase[];
	expect(todoRowAfterWorker(reloaded[0]!.tasks[0]!)).toMatchObject({ kind: "verify" });
	expect(reloaded[0]!.tasks[0]!.schedule!.materialInputs).toEqual(materialInputs);
});

for (const verdict of ["pass", "fail"] as const) {
	for (const input of ["criterion", "receipts", "prerequisites", "removed receipt"] as const) {
		test(`changing ${input} invalidates a previous ${verdict} conclusion`, () => {
			const row = fixture();
			row.schedule!.audit!.verdict = verdict;
			if (input === "criterion") row.schedule!.materialInputs!.criterion = "criterion:v2";
			else if (input === "removed receipt") row.schedule!.audit!.materialInputs!.receipts = ["receipt:removed"];
			else row.schedule!.materialInputs![input] = ["receipt:new"];
			const restored = JSON.parse(JSON.stringify(row));
			expect(todoRowAfterWorker(restored)).toMatchObject({ kind: "verify", via: "audit" });
			expect(plan(restored)).toHaveLength(1);
		});
	}
}

test("unchanged material identities preserve a conclusion across evidence ordering and reload", () => {
	const row = fixture();
	row.schedule!.audit!.verdict = "pass";
	row.schedule!.materialInputs!.receipts = ["receipt:b", "receipt:a", "receipt:a"];
	row.schedule!.audit!.materialInputs!.receipts = ["receipt:a", "receipt:b"];
	const restored = JSON.parse(JSON.stringify(row));
	expect(todoRowAfterWorker(restored)).toBeUndefined();
	expect(plan(restored)).toHaveLength(0);
});

for (const verdict of ["pass", "fail"] as const) {
	test(`TodoTool criterion update and persisted reload retire the old ${verdict}`, async () => {
		const row = fixture();
		row.status = "completed";
		row.schedule!.dependencies = [];
		row.schedule!.audit!.verdict = verdict;
		let phases: TodoPhase[] = [{ name: "Audit", tasks: [{ ...row, details: "", notes: [] }] }];
		const tool = new TodoTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			settings: Settings.isolated(),
		} as ToolSession);
		const result = await tool.execute("criterion", {
			op: "schedule",
			updates: [
				{ task: row.content, materialInputs: { criterion: "criterion:v2", receipts: [], prerequisites: [] } },
			],
		});
		expect(result.isError).not.toBe(true);
		const restored = JSON.parse(JSON.stringify(phases))[0].tasks[0];
		expect(restored.schedule.materialInputs.criterion).toBe("criterion:v2");
		expect(todoRowAfterWorker(restored)).toMatchObject({ kind: "verify", via: "audit" });
		expect(plan(restored)).toHaveLength(1);
	});
}
