// @ts-nocheck -- fixture rows are the live wire shape, not the typed TODO model.
import { beforeEach, expect, test } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	classifyTodoDisplayRow,
	forecastTodoPlan,
	formatPlanForecast,
	formatTaskForecast,
	renderTodoPlanDisplay,
	todoRowAfterWorker,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import live from "./fixtures/dc-rowclose-1645.json";
import gateNotices from "./gate-notices.md" with { type: "text" };
import {
	checkRowAudits,
	parseRowAuditVerdicts,
	planRowAudits,
	resetRowAuditsForTest,
	ROW_AUDIT_CAP,
} from "./row_audit";
import { decideTodoDispatch } from "./todo_dispatch";

const REPO = "/home/user/proj/sunbim/datacenter-decision-graph";
const titles = live.phases.flatMap(phase => phase.tasks.map(task => task.content));
const COLLATERAL = titles.find(title => title.startsWith('Collateral for "Integrate finished lanes'));
/** Verified by the delivery critic already running for this exact executor run. */
const CRITIC = "Power source rows: no red keyboard-focus frame";
/** Delivered rows the runtime audit batch owns. */
const AUDITED = [
	COLLATERAL,
	"Power source rows: remove red selection frame and grey boxes",
	"PR 112: rebase onto main after PR 111 merge and fix",
	"UX graph: no other-package or runtime-only concrete edges",
	"Mau standup transcript into plans, requirements, knowledgebase",
	"Land focus, UX graph, standup patches on PR 112",
	"Integrate finished lanes onto consolidated branch",
];
const DELIVERED = [...AUDITED, CRITIC];
const NEEDS_WORKER = [
	"Mac call: attribute 30 fps drop untraced",
	"Facility orbit paints 30 fps: labels stop blocking frames",
	"Diagnose leader crossings after Facility rotation",
];

const clone = () => structuredClone(live.phases);
const runningJobs = live.running.map(id => ({
	id,
	agentId: id,
	type: "task",
	status: "running",
	label: id,
	startTime: live.now - 60_000,
}));

function replay(phases = live.phases) {
	const decision = decideTodoDispatch(
		{
			phases,
			jobs: { running: runningJobs, recent: [] },
			isMainSession: true,
			taskEnabled: true,
			now: live.now,
			capacity: 0,
		},
		{ forecastTodoPlan, formatPlanForecast, formatTaskForecast },
	);
	const workers = runningJobs.map(job => ({ id: job.id, startedAt: job.startTime }));
	const owners = new Map(
		phases
			.flatMap(phase => phase.tasks)
			.filter(task => live.running.includes(task.schedule?.owner))
			.map(task => [task.content, workers.find(worker => worker.id === task.schedule.owner)]),
	);
	const states = new Map(
		phases
			.flatMap(phase => phase.tasks)
			.map(task => [task.content, classifyTodoDisplayRow(task, phases, { workers, owners }).state]),
	);
	const display = renderTodoPlanDisplay(
		phases,
		{ workers, owners },
		{ now: live.now, width: 200, paint: (_tone, text) => text },
	);
	return { decision, states, display };
}

function harness(phases = clone(), heads: Record<string, string> = { [REPO]: "c64ec5fe6".padEnd(40, "0") }) {
	const launches: Array<{
		task: string;
		agent: string;
		resolve: (output: unknown) => void;
		reject: (error: Error) => void;
	}> = [];
	const rows = () => phases.flatMap(phase => phase.tasks);
	const ctx = {
		cwd: "/project",
		sessionManager: { getHeader: () => ({ id: "dc-session" }) },
		getAsyncJobSnapshot: () => ({ running: runningJobs, recent: [] }),
		getTodoPhases: () => phases,
		// Mirrors the host callback: a passing audit closes the row.
		updateTodoSchedule: (task: string, patch: Record<string, unknown>) => {
			const row = rows().find(candidate => candidate.content === task);
			if (!row) return false;
			row.schedule = { ...row.schedule, ...structuredClone(patch) };
			if (patch.audit?.verdict === "pass" && (row.status === "pending" || row.status === "in_progress"))
				row.status = "completed";
			return true;
		},
		runRowAudit: (task: string, agent: string) =>
			new Promise((resolve, reject) => {
				launches.push({
					task,
					agent,
					resolve: output => resolve({ details: { results: [{ output: JSON.stringify(output) }] } }),
					reject,
				});
			}),
	};
	const check = () =>
		checkRowAudits(ctx, { now: () => live.now, readHead: async repo => heads[repo], agent: "qa-auditor" });
	const settle = async (index: number, output: unknown) => {
		launches[index].resolve(output);
		for (let i = 0; i < 5; i++) await Bun.sleep(0);
	};
	return { phases, rows, ctx, launches, check, settle, heads };
}

beforeEach(() => resetRowAuditsForTest());

test("DC 16:45 replay: delivered rows verify, finished-without-change rows need a worker, nothing is stuck", () => {
	const after = replay();
	expect(after.decision.dispatchableReady.map(row => row.content).sort()).toEqual([...NEEDS_WORKER].sort());
	for (const content of DELIVERED) expect(after.states.get(content)).toBe("verifying");
	for (const content of NEEDS_WORKER) expect(after.states.get(content)).toBe("needs worker");
	expect(after.display.lines[0]).toContain("8 verifying");
	expect(after.display.lines[0]).toContain("3 need worker");
	expect(after.display.lines[0]).toContain("0 stuck");
	// The aborted gate-runner row waits on its verifying dependency instead of being re-staffed.
	expect(after.states.get("Generated UX transition graph with dead ends and wrong returns")).toBe("waiting");
	const notice = prompt.render(gateNotices, {
		staffing: true,
		rows: after.decision.dispatchableReady.map(row => JSON.stringify(row.content)).join(", "),
		continuations: after.decision.dispatchableReady
			.map(row => `${JSON.stringify(row.content)} from agent://${row.previous} (${row.reason})`)
			.join("; "),
	});
	for (const content of DELIVERED) expect(notice).not.toContain(content);
	expect(notice).toContain('"Mac call: attribute 30 fps drop untraced" from agent://MacCallAttrib-3 (findings)');
	expect(after.decision.verifyingRows.sort()).toEqual([...DELIVERED].sort());
});

test("DC replay launches one batched audit per head, persists it first, and a reload does not duplicate it", async () => {
	const h = harness();
	expect(await h.check()).toBe(1);
	expect(h.launches).toHaveLength(1);
	expect(h.launches[0].agent).toBe("qa-auditor");
	for (const content of AUDITED) {
		expect(h.launches[0].task).toContain(JSON.stringify(content));
		expect(h.rows().find(row => row.content === content).schedule.audit.verdict).toBe("pending");
	}
	expect(h.launches[0].task).not.toContain(JSON.stringify(CRITIC));
	for (const content of NEEDS_WORKER) expect(h.launches[0].task).not.toContain(JSON.stringify(content));
	// Same process replay (session reload, turn_end, tool events): the batch is in flight.
	expect(await h.check()).toBe(0);
	expect(await h.check()).toBe(0);
	expect(h.launches).toHaveLength(1);
	// The display still shows the rows as verifying while their audit is pending.
	expect(replay(h.phases).states.get(DELIVERED[0])).toBe("verifying");
});

test("audit pass closes the row; audit fail returns it to needs worker carrying the findings", async () => {
	const h = harness();
	await h.check();
	await h.settle(0, {
		rows: [
			{ row: AUDITED[1], verdict: "pass", findings: "frame and boxes absent at 1440/430; spec 70/70" },
			{
				row: AUDITED[3],
				verdict: "fail",
				findings: "Settings->Facility edge still listed (KnowledgeGraphApp.tsx:8588)",
			},
		],
	});
	const pass = h.rows().find(row => row.content === AUDITED[1]);
	expect(pass.status).toBe("completed");
	expect(pass.schedule.audit.verdict).toBe("pass");
	const fail = h.rows().find(row => row.content === AUDITED[3]);
	expect(fail.status).toBe("in_progress");
	expect(todoRowAfterWorker(fail)).toEqual({
		kind: "needs-worker",
		reason: "audit-failed",
		worker: "UxGraphEdges",
		findings: "Settings->Facility edge still listed (KnowledgeGraphApp.tsx:8588)",
	});
	expect(fail.schedule.progress.evidence).toContain("audit fail at c64ec5fe6000");
	// A row the auditor did not answer is not passed.
	const silent = h.rows().find(row => row.content === AUDITED[0]);
	expect(silent.status).toBe("in_progress");
	expect(silent.schedule.audit.verdict).toBe("fail");
	const decision = replay(h.phases).decision;
	const staffed = decision.dispatchableReady.find(row => row.content === AUDITED[3]);
	expect(staffed).toMatchObject({ previous: "UxGraphEdges", reason: "audit-failed" });
	expect(decision.dispatchableReady.some(row => row.content === AUDITED[1])).toBe(false);
	// Settled rows are not audited again.
	expect(await h.check()).toBe(0);
});

test("a head move while the audit runs discards its verdicts and re-audits once at the new head", async () => {
	const h = harness();
	await h.check();
	h.heads[REPO] = "56651dc53".padEnd(40, "0");
	await h.settle(0, { rows: AUDITED.map(row => ({ row, verdict: "pass", findings: "ok" })) });
	for (const content of AUDITED) {
		const row = h.rows().find(candidate => candidate.content === content);
		expect(row.status).toBe("in_progress");
		expect(row.schedule.audit.verdict).toBe("pending");
	}
	expect(await h.check()).toBe(1);
	expect(await h.check()).toBe(0);
	expect(h.launches).toHaveLength(2);
	expect(h.launches[1].task).toContain(`HEAD=${"56651dc53".padEnd(40, "0")}`);
	for (const content of AUDITED) expect(h.launches[1].task).toContain(JSON.stringify(content));
});

test("a restart relaunches a pending audit exactly once", async () => {
	const h = harness();
	await h.check();
	resetRowAuditsForTest(); // new process: the in-process audit died with it
	expect(await h.check()).toBe(1);
	expect(await h.check()).toBe(0);
	expect(h.launches).toHaveLength(2);
});

test("batches split per repository head and stop at the auditor cap", async () => {
	const phases = clone();
	const rows = phases.flatMap(phase => phase.tasks).filter(row => AUDITED.includes(row.content));
	rows.forEach((row, index) => {
		row.artifactCwd = `/repo/${index}`;
	});
	const heads = Object.fromEntries(rows.map((_, index) => [`/repo/${index}`, String(index).padStart(40, "a")]));
	const h = harness(phases, heads);
	expect(await h.check()).toBe(ROW_AUDIT_CAP);
	expect(h.launches).toHaveLength(ROW_AUDIT_CAP);
	expect(await h.check()).toBe(0);
	await h.settle(0, { rows: [{ row: rows[0].content, verdict: "pass", findings: "ok" }] });
	expect(await h.check()).toBe(1);
});

test("aborted and lost workers need a worker; a lost audit of a delivered row is re-audited", () => {
	const row = (executor, evidence = "landed in 54b0302ad") => ({
		content: "row",
		status: "in_progress",
		schedule: { executor: { workerId: "W", startedAt: 1, ...executor }, progress: { at: 1, evidence } },
	});
	expect(todoRowAfterWorker(row({ finishedAt: 2, outcome: "aborted" }))).toMatchObject({
		kind: "needs-worker",
		reason: "aborted",
	});
	expect(todoRowAfterWorker(row({}))).toMatchObject({ kind: "needs-worker", reason: "lost" });
	expect(todoRowAfterWorker(row({ agentProfile: "qa-auditor" }))).toMatchObject({ kind: "verify", via: "audit" });
	expect(
		todoRowAfterWorker(row({ finishedAt: 2, outcome: "completed" }, "answered: use renderedFrame")),
	).toMatchObject({
		kind: "needs-worker",
		reason: "findings",
	});
	expect(todoRowAfterWorker(row({ finishedAt: 2, outcome: "completed", agentProfile: "profiler" }))).toMatchObject({
		kind: "needs-worker",
		reason: "findings",
	});
	expect(todoRowAfterWorker(row({ finishedAt: 2, outcome: "completed" }))).toMatchObject({
		kind: "verify",
		via: "audit",
	});
	// A new worker run invalidates the old failed audit: the new delivery is verified again.
	const failed = row({ finishedAt: 2, outcome: "completed" });
	failed.schedule.audit = {
		delivery: JSON.stringify(["W", 1, 2]),
		repoPath: "/r",
		head: "h",
		startedAt: 3,
		verdict: "fail",
		findings: "x",
	};
	expect(todoRowAfterWorker(failed)).toMatchObject({ kind: "needs-worker", reason: "audit-failed" });
	failed.schedule.executor = { workerId: "W-2", startedAt: 4, finishedAt: 5, outcome: "completed" };
	expect(todoRowAfterWorker(failed)).toMatchObject({ kind: "verify", via: "audit" });
	// Plan helper ignores rows verified by the live delivery critic.
	const critic = row({ finishedAt: 2, outcome: "completed" });
	critic.schedule.deliveryCritic = { key: JSON.stringify(["W", 1, 2]), startedAt: 3, verdict: "pending" };
	expect(todoRowAfterWorker(critic)).toMatchObject({ kind: "verify", via: "critic" });
	expect(
		planRowAudits(
			[critic],
			new Map(),
			"/r",
			() => false,
			() => false,
		),
	).toEqual([]);
});

test("audit verdict parser accepts fenced JSON and rejects malformed rows", () => {
	expect(parseRowAuditVerdicts('done\n```json\n{"rows":[{"row":"a","verdict":"pass","findings":"ok"}]}\n```')).toEqual(
		[{ row: "a", verdict: "pass", findings: "ok" }],
	);
	expect(parseRowAuditVerdicts('{"rows":[{"row":"a","verdict":"maybe"}]}')).toBeUndefined();
	expect(parseRowAuditVerdicts("no json")).toBeUndefined();
});
