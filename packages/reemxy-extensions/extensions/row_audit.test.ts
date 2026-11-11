// @ts-nocheck -- fixture rows are the live wire shape, not the typed TODO model.
import coolingYields from "./fixtures/row-audit-cooling-yields.json";
import { afterAll, beforeEach, expect, test } from "bun:test";
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
import auditStall from "./fixtures/auditstall-1855.json";
import gateNotices from "./gate-notices.md" with { type: "text" };
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import divineRoadrunner from "./fixtures/row-audit-divine-roadrunner.json";
import {
	checkRowAudits,
	parseRowAuditVerdicts,
	planRowAudits,
	registryAuditor,
	resetRowAuditsForTest,
	ROW_AUDIT_CAP,
	settleRowAuditVerdict,
} from "./row_audit";
import { renderLeadRowInstructions } from "./lead-row-instructions";
import { decideTodoDispatch } from "./todo_dispatch";

const recordedRepo = live.phases[0].tasks[0].artifactCwd;
const fixtureRoot = mkdtempSync(join(tmpdir(), "row-audit-checkouts-"));
const REPO = join(fixtureRoot, "delivery");
expect(Bun.spawnSync(["git", "init", "-q", REPO]).exitCode).toBe(0);
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
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
	"Power source rows: title size and indent match sibling rows",
];
const DELIVERED = [...AUDITED, CRITIC];
const NEEDS_WORKER = [
	"Mac call: attribute 30 fps drop untraced",
	"Facility orbit paints 30 fps: labels stop blocking frames",
	"Diagnose leader crossings after Facility rotation",
];

const clone = () => {
	const phases = structuredClone(live.phases);
	// The historical checkout is fixture metadata, not a checkout on this host.
	// Keep its root and nested collateral scopes bound to one disposable repo.
	for (const row of phases.flatMap(phase => phase.tasks)) {
		row.artifactCwd = row.artifactCwd?.replace(recordedRepo, REPO);
		if (row.schedule?.resources)
			row.schedule.resources = row.schedule.resources.map(resource => resource.replace(recordedRepo, REPO));
		if (row.schedule?.audit?.repoPath)
			row.schedule.audit.repoPath = row.schedule.audit.repoPath.replace(recordedRepo, REPO);
	}
	return phases;
};
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

const ran = [{ command: "bunx playwright test e2e/facility-decisions-list.spec.ts", exitCode: 0 }];
const verdict = (row: string, value: string, findings = "checked at HEAD") => ({
	row,
	verdict: value,
	findings,
	checks: ran,
	issues: value === "fail" ? [{ kind: "product_regression", severity: "blocker", evidence: findings }] : [],
});

function harness(
	phases = clone(),
	heads: Record<string, string> = { [REPO]: "c64ec5fe6".padEnd(40, "0") },
	auditor: string | null = "qa-auditor",
) {
	const launches: Array<{
		task: string;
		agent: string;
		resolve: (output: unknown) => void;
		abort: () => void;
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
		runRowAudit: (task: string, agent: string, _signal, onStarted, subject, assignedRows, onResult) => {
			expect(subject).toBeTruthy();
			expect(task).toContain(subject.split(" ")[0]);
			onStarted?.("HelpfulVole");
			return new Promise((resolve, reject) => {
				launches.push({
					task,
					agent,
					onResult,
					resolve: output => resolve({ details: { results: [{ output: JSON.stringify(output) }] } }),
					abort: () => resolve({ details: { results: [{ aborted: true, exitCode: 1 }] } }),
					reject,
				});
			});
		},
	};
	const options = {
		now: () => live.now,
		readHead: async (repo: string) => heads[repo],
		resolveAuditor: async () => auditor ?? undefined,
		requirementsFor: (row: string) =>
			row === AUDITED[1] ? ["R242: no red frame on Power source rows at 1440 and 430"] : [],
		fileExists: () => false,
	};
	const check = () => checkRowAudits(ctx, options);
	const settle = async (index: number, output: unknown) => {
		launches[index].resolve(output);
		for (let i = 0; i < 5; i++) await Bun.sleep(0);
	};
	const abort = async (index: number) => {
		launches[index].abort();
		for (let i = 0; i < 5; i++) await Bun.sleep(0);
	};
	return { phases, rows, ctx, launches, check, settle, abort, heads, options };
}

test("a stopped audit is not relaunched for the same delivery and head", async () => {
	const delivered = clone()
		.flatMap(phase => phase.tasks)
		.find(row => row.content === AUDITED[1]);
	const h = harness([{ name: "Stopped audit", tasks: [delivered] }]);
	expect(await h.check()).toBe(1);
	await h.abort(0);
	expect(delivered.schedule.audit).toMatchObject({
		verdict: "unavailable",
		cancelled: true,
		findings: "audit worker stopped before a verdict",
	});
	expect(await h.check()).toBe(0);
	expect(h.launches).toHaveLength(1);

	h.heads[REPO] = "new-head";
	expect(await h.check()).toBe(1);
	expect(h.launches).toHaveLength(2);
});

beforeEach(() => resetRowAuditsForTest());

test("DC 16:45 replay: delivered rows verify, finished-without-change rows need a worker, nothing is stuck", () => {
	const after = replay();
	expect(after.decision.dispatchableReady.map(row => row.content).sort()).toEqual([...NEEDS_WORKER].sort());
	for (const content of DELIVERED) expect(after.states.get(content)).toBe("audit queued");
	for (const content of NEEDS_WORKER) expect(after.states.get(content)).toBe("needs worker");
	expect(after.display.lines[0]).toContain("9 audit queued");
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
	expect(notice).toContain("Mac call: attribute 30 fps drop untraced");
	expect(notice).toContain("read the row's result");
	expect(notice).toContain("Use task only for the unmet delta");
	expect(after.decision.verifyingRows.sort()).toEqual([...DELIVERED].sort());
});

test("DC replay launches one batched audit per head, persists it first, and a reload does not duplicate it", async () => {
	const h = harness();
	expect(await h.check()).toBe(1);
	expect(h.launches).toHaveLength(1);
	expect(h.launches[0].agent).toBe("qa-auditor");
	expect(h.launches[0].task).toContain("Linked requirement: R242: no red frame on Power source rows at 1440 and 430");
	expect(h.launches[0].task).toContain("context only, not proof");
	expect(h.launches[0].task).toContain("Recorded evidence (commits and checks to re-run at HEAD): f1ee6e909 in ROOT");
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
	expect(replay(h.phases).states.get(DELIVERED[0])).toBe("audit queued");
});

test("audit pass closes the row; audit fail returns it to needs worker carrying the findings", async () => {
	const h = harness();
	await h.check();
	await h.settle(0, {
		rows: [
			verdict(AUDITED[1], "pass", "frame and boxes absent at 1440/430; spec 70/70"),
			verdict(AUDITED[3], "fail", "Settings->Facility edge still listed (KnowledgeGraphApp.tsx:8588)"),
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
	// A row the auditor did not answer is neither passed nor failed: it stays verifying.
	const silent = h.rows().find(row => row.content === AUDITED[0]);
	expect(silent.status).toBe("in_progress");
	// It was recorded inconclusive and immediately relaunched once (attempt 2).
	expect(silent.schedule.audit).toMatchObject({ verdict: "pending", attempts: 2 });
	expect(todoRowAfterWorker(silent)).toMatchObject({ kind: "verify", via: "audit" });
	const decision = replay(h.phases).decision;
	const staffed = decision.dispatchableReady.find(row => row.content === AUDITED[3]);
	expect(staffed).toMatchObject({ previous: "UxGraphEdges", reason: "audit-failed" });
	expect(decision.dispatchableReady.some(row => row.content === AUDITED[1])).toBe(false);
	// Inconclusive rows were relaunched once naming the missing piece; settled rows were not.
	expect(h.launches).toHaveLength(5); // omitted rows retry singly, up to the cap
	expect(h.launches[1].task).not.toContain(JSON.stringify(AUDITED[1]));
	expect(h.launches[1].task).not.toContain(JSON.stringify(AUDITED[3]));
	expect(h.launches[1].task.match(/- Row:/g)).toHaveLength(1);
});

test("a head move while the audit runs discards its verdicts and re-audits once at the new head", async () => {
	const h = harness();
	await h.check();
	h.heads[REPO] = "56651dc53".padEnd(40, "0");
	await h.settle(0, { rows: AUDITED.map(row => verdict(row, "pass", "ok")) });
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
		const repo = join(fixtureRoot, `batch-${index}`);
		expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
		row.artifactCwd = repo;
		if (row.schedule.resources)
			row.schedule.resources = row.schedule.resources.map(resource => resource.replace(REPO, repo));
	});
	const heads = Object.fromEntries(rows.map((row, index) => [row.artifactCwd, String(index).padStart(40, "a")]));
	const h = harness(phases, heads);
	expect(await h.check()).toBe(ROW_AUDIT_CAP);
	expect(h.launches).toHaveLength(ROW_AUDIT_CAP);
	expect(await h.check()).toBe(0);
	await h.settle(0, { rows: [verdict(rows[0].content, "pass", "ok")] });
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
		agent: "qa-auditor",
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
		[{ row: "a", verdict: "pass", findings: "ok", checks: [], screenshots: [] }],
	);
	expect(parseRowAuditVerdicts('{"rows":[{"row":"a","verdict":"maybe"}]}')).toBeUndefined();
	expect(parseRowAuditVerdicts("no json")).toBeUndefined();
});

test("DivineRoadrunner replay: a yield of unverified 'fail' verdicts is inconclusive, never needs worker", async () => {
	// Live 17:30: the gate-runner fallback read transcripts, ran only `git rev-parse HEAD`, and failed every row.
	const yielded = parseRowAuditVerdicts(JSON.stringify(divineRoadrunner));
	expect(yielded).toHaveLength(7);
	for (const item of yielded) expect(settleRowAuditVerdict(item).verdict).toBe("inconclusive");
	expect(
		settleRowAuditVerdict({ ...yielded[0], checks: [{ command: "git rev-parse HEAD", exitCode: 0 }] }).verdict,
	).toBe("inconclusive");
	const audited = AUDITED.filter(content => yielded.some(item => item.row === content));
	const h = harness([
		{
			name: "Inconclusive",
			tasks: clone()
				.flatMap(phase => phase.tasks)
				.filter(row => audited.includes(row.content))
				.map(row => ({ ...row, schedule: { ...row.schedule, dependencies: [] } })),
		},
	]);
	await h.check();
	await h.settle(0, divineRoadrunner);
	expect(h.launches).toHaveLength(2); // relaunched once with the missing piece named
	expect(h.launches[1].task).toContain(
		'Previous audit was inconclusive: "fail" without a check or screenshot at HEAD',
	);
	await h.settle(1, divineRoadrunner);
	expect(h.launches).toHaveLength(2); // a second inconclusive goes to the lead, not a third launch
	expect(await h.check()).toBe(0);
	const after = replay(h.phases);
	for (const content of audited) {
		expect(after.states.get(content)).toBe("needs worker");
		expect(after.decision.dispatchableReady.some(row => row.content === content)).toBe(true);
	}
	const powerLine = after.display.lines.find(line => line.includes("Power source rows:"));
	expect(powerLine).toContain("needs worker: audit-inconclusive");
	const notice = prompt.render(gateNotices, { audit: true, rows: '"row" (inconclusive: x)' });
	expect(notice).toContain("read their findings and make one discriminating check");
	expect(notice).toContain("Reuse unchanged valid product evidence");
	// A newly identified executable check reopens the audit; administration does not.
	const row = h.rows().find(candidate => candidate.content === AUDITED[1]);
	row.schedule.progress = { at: live.now + 1, evidence: "Handoff administration; prerequisite unchanged" };
	expect(await h.check()).toBe(0);
	row.schedule.progress = { at: live.now + 1, evidence: "f1ee6e909: run bunx playwright test e2e/power-rows.spec.ts" };
	row.schedule.materialInputs = { criterion: row.content, receipts: ["git:f1ee6e909/check:bunx-playwright-e2e-power-rows"], prerequisites: [] };
	expect(await h.check()).toBe(1);
	expect(h.launches[2].task).toContain(JSON.stringify(AUDITED[1]));
});

test("no auditor profile: nothing launches, never a gate-runner substitute, rows show auditor unavailable", async () => {
	const h = harness(undefined, undefined, null);
	expect(await h.check()).toBe(0);
	expect(h.launches).toHaveLength(0);
	for (const content of AUDITED) {
		const row = h.rows().find(candidate => candidate.content === content);
		expect(row.schedule.audit).toMatchObject({ verdict: "unavailable", agent: "qa-auditor" });
	}
	const after = replay(h.phases);
	expect(after.display.lines.join("\n")).toContain(
		"Mau standup transcript into plans, requirements, knowledgebase — audit queued: auditor unavailable",
	);
	expect(after.decision.dispatchableReady.some(row => AUDITED.includes(row.content))).toBe(false);
});

test("the auditor is resolved through the agent registry, not by file presence next to the extension", async () => {
	const home = mkdtempSync(join(tmpdir(), "row-audit-home-"));
	const bare = mkdtempSync(join(tmpdir(), "row-audit-bare-"));
	expect(await registryAuditor(bare, home)).toBeUndefined();
	const project = mkdtempSync(join(tmpdir(), "row-audit-project-"));
	mkdirSync(join(project, ".omp", "agents"), { recursive: true });
	writeFileSync(
		join(project, ".omp", "agents", "qa-auditor.md"),
		"---\nname: qa-auditor\ndescription: Audit delivered rows at HEAD.\ntools: read, bash\n---\nAudit.\n",
	);
	expect(await registryAuditor(project, home)).toBe("qa-auditor");
});

test("verdicts from the old gate-runner fallback are void: those rows reopen to verifying and are re-audited", async () => {
	const phases = clone();
	const bogus = phases.flatMap(phase => phase.tasks).filter(row => AUDITED.slice(0, 4).includes(row.content));
	for (const row of bogus) {
		const { workerId, startedAt, finishedAt } = row.schedule.executor;
		row.schedule.audit = {
			delivery: JSON.stringify([workerId, startedAt, finishedAt]),
			repoPath: REPO,
			head: "c64ec5fe6".padEnd(40, "0"),
			startedAt: live.now - 1,
			verdict: "fail",
			agent: "gate-runner",
			findings: "Missing HEAD acceptance evidence.",
			at: live.now - 1,
		};
	}
	const states = replay(phases).states;
	for (const row of bogus) {
		expect(todoRowAfterWorker(row)).toMatchObject({ kind: "verify", via: "audit" });
		expect(states.get(row.content)).toBe("audit queued");
	}
	const h = harness(phases);
	expect(await h.check()).toBe(1);
	expect(h.launches[0].agent).toBe("qa-auditor");
	for (const row of bogus) expect(h.launches[0].task).toContain(JSON.stringify(row.content));
});

test("every row in a running batched audit names its verifier in the HUD", async () => {
	const h = harness();
	await h.check();
	const worker = { id: "HelpfulVole", agent: "qa-auditor", startedAt: live.now };
	const display = renderTodoPlanDisplay(
		h.phases,
		{ workers: [worker], owners: new Map() },
		{ now: live.now, paint: (_tone, text) => text },
	);
	for (const content of AUDITED) {
		expect(h.rows().find(row => row.content === content).schedule.audit.workerId).toBe("HelpfulVole");
		const state = classifyTodoDisplayRow(
			h.rows().find(row => row.content === content),
			h.phases,
			{ workers: [worker], owners: new Map() },
		);
		expect(state).toMatchObject({ state: "verifying", worker: { id: "HelpfulVole" } });
	}
	expect(display.lines.filter(line => line.includes("verifying · HelpfulVole"))).toHaveLength(AUDITED.length);
});

test("new deliveries at the same head launch concurrently without duplicating a row or exceeding the cap", async () => {
	const delivered = clone()
		.flatMap(phase => phase.tasks)
		.find(row => row.content === AUDITED[1]);
	const h = harness([{ name: "Concurrent", tasks: [delivered] }]);
	for (let index = 0; index < ROW_AUDIT_CAP; index++) {
		if (index)
			h.phases[0].tasks.push({
				...structuredClone(delivered),
				content: `delivered ${index}`,
				schedule: { ...structuredClone(delivered.schedule), audit: undefined },
			});
		expect(await h.check()).toBe(1);
		expect(await h.check()).toBe(0);
	}
	h.phases[0].tasks.push({
		...structuredClone(delivered),
		content: "over cap",
		schedule: { ...structuredClone(delivered.schedule), audit: undefined },
	});
	expect(await h.check()).toBe(0);
	expect(h.launches).toHaveLength(ROW_AUDIT_CAP);
	for (const launch of h.launches) expect(launch.task.match(/- Row:/g)).toHaveLength(1);
	await h.settle(0, { rows: [verdict(delivered.content, "pass")] });
	expect(await h.check()).toBe(1);
	expect(h.launches.at(-1).task).toContain('"over cap"');
});

test("an omitted row retries once alone, then asks for proof instead of a third audit", async () => {
	const delivered = clone()
		.flatMap(phase => phase.tasks)
		.filter(row => AUDITED.slice(0, 2).includes(row.content));
	const h = harness([{ name: "Omission", tasks: delivered }]);
	await h.check();
	await h.settle(0, { rows: [verdict(delivered[0].content, "pass")] });
	expect(h.launches).toHaveLength(2);
	expect(h.launches[1].task.match(/- Row:/g)).toHaveLength(1);
	expect(delivered[1].schedule.audit).toMatchObject({ verdict: "pending", attempts: 2 });
	await h.settle(1, { rows: [] });
	expect(await h.check()).toBe(0);
	expect(h.launches).toHaveLength(2);
	expect(todoRowAfterWorker(delivered[1])).toMatchObject({ kind: "needs-worker", reason: "audit-inconclusive" });
});

test("the lead gate names an unsent review page and the evidence worker's missing check", () => {
	const page = "http://localhost:8767/review/grid/";
	const delivered = {
		content: "Use grid",
		status: "completed",
		schedule: { review: "user", handoffPending: true, reviewPage: page },
	};
	const missing = clone()
		.flatMap(phase => phase.tasks)
		.find(row => row.content === AUDITED[1]);
	missing.schedule.audit = {
		delivery: JSON.stringify([
			missing.schedule.executor.workerId,
			missing.schedule.executor.startedAt,
			missing.schedule.executor.finishedAt,
		]),
		repoPath: REPO,
		head: "h",
		startedAt: live.now,
		at: live.now,
		agent: "qa-auditor",
		verdict: "inconclusive",
		attempts: 2,
		findings: "produce screenshot at 430px",
	};
	const phases = [{ name: "Gate", tasks: [delivered, missing] }];
	const text = renderLeadRowInstructions(phases, { workers: [], owners: new Map() }, { now: live.now });
	expect(text).toContain(`send review page ${page} for rows "Use grid"`);
	expect(text).toContain("produce screenshot at 430px");
	expect(text).toContain("start one capable worker only for genuinely remaining implementation");
});

test("a new worker delivery invalidates the previous pass and starts a fresh audit", async () => {
	const delivered = clone()
		.flatMap(phase => phase.tasks)
		.find(row => row.content === AUDITED[1]);
	const h = harness([{ name: "New delivery", tasks: [delivered] }]);
	await h.check();
	await h.settle(0, { rows: [verdict(delivered.content, "pass")] });
	delivered.status = "in_progress";
	delivered.schedule.executor = {
		...delivered.schedule.executor,
		workerId: "EvidenceWorker",
		startedAt: live.now + 1,
		finishedAt: live.now + 2,
	};
	expect(await h.check()).toBe(1);
	expect(delivered.schedule.audit).toMatchObject({ verdict: "pending", attempts: 1 });
});

test("18:55 HUD replay: six idle deliveries have zero phantom verifiers and launch only within capacity", async () => {
	const phases = structuredClone(auditStall);
	// The recorded absolute paths may now be separate worktrees on the host.
	// Keep this lifecycle replay independent of the host's current checkout layout.
	const sourceRoot = phases[0].tasks[0].artifactCwd;
	const repo = mkdtempSync(join(tmpdir(), "audit-replay-"));
	expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
	for (const row of phases.flatMap(phase => phase.tasks)) {
		row.artifactCwd = row.artifactCwd?.replace(sourceRoot, repo);
		row.schedule.audit.repoPath = row.schedule.audit.repoPath?.replace(sourceRoot, repo);
		row.schedule.resources = row.schedule.resources?.map(resource => resource.replace(sourceRoot, repo));
	}
	const before = replay(phases);
	expect([...before.states.values()].filter(state => state === "verifying")).toHaveLength(0);
	const h = harness(
		phases,
		Object.fromEntries(phases[0].tasks.flatMap(row => [[row.artifactCwd, row.schedule.audit.head], ...(row.schedule.resources ?? []).filter(path => path.startsWith("/")).map(path => [path, row.schedule.audit.head])])),
	);
	expect(await h.check()).toBe(1); // exhausted missing-verdict rows now return to staffing
	expect(await h.check()).toBe(0);
	const workers = [{ id: "HelpfulVole", agent: "qa-auditor" }];
	for (const row of h.rows()) {
		const state = classifyTodoDisplayRow(row, phases, { workers, owners: new Map() });
		if (state.state === "verifying") expect(row.schedule.audit.workerId).toBe("HelpfulVole");
	}
	expect(h.rows().filter(row => todoRowAfterWorker(row)?.kind === "needs-worker")).toHaveLength(5);
});

test("timestamp-only evidence updates cannot restart an exhausted audit", async () => {
	const delivered = clone()
		.flatMap(phase => phase.tasks)
		.find(row => row.content === AUDITED[1]);
	const h = harness([{ name: "Same proof", tasks: [delivered] }]);
	await h.check();
	await h.settle(0, { rows: [verdict(delivered.content, "inconclusive", "run focused browser checks")] });
	await h.settle(1, { rows: [verdict(delivered.content, "inconclusive", "run focused browser checks")] });
	delivered.schedule.progress.at = live.now + 60_000;
	expect(await h.check()).toBe(0);
	expect(todoRowAfterWorker(delivered)).toMatchObject({ kind: "needs-worker" });
	delivered.schedule.progress.evidence = "Estimate updated; missing browser check unchanged";
	expect(await h.check()).toBe(0);
	expect(todoRowAfterWorker(delivered)).toMatchObject({ kind: "needs-worker" });
	delivered.schedule.progress.evidence = "New executable receipt at abc1234: bun test, exit 0";
	delivered.schedule.materialInputs = { criterion: delivered.content, receipts: ["git:abc1234/check:bun-test-exit-0"], prerequisites: [] };
	expect(await h.check()).toBe(1);
});


test("Cooling late corrected yield supersedes omitted only within its unchanged audit attempt", async () => {
	const valid = coolingYields[1].arguments.data;
	const row = structuredClone(clone().flatMap(phase => phase.tasks).find(row => row.content === AUDITED[1]));
	row.content = valid.rows[0].row;

	const h = harness([{ name: "Cooling", tasks: [row] }]);
	await h.check();
	expect(h.launches).toHaveLength(1);
	await h.settle(0, { rows: [{ row: row.content, verdict: "inconclusive", findings: "retry" }] });
	await h.settle(1, coolingYields[0].arguments.data);
	// Keep the same attempt: the old harness has already recorded its omitted result.
	const current = h.rows()[0];
	expect(current.schedule.audit.verdict).toBe("omitted");
	h.launches[1].onResult(valid);
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
	expect(current.schedule.audit.verdict).toBe("pass");
	expect(current.status).toBe("completed");
	expect(current.schedule.audit.attempts).toBe(2);
	const accepted = structuredClone(current.schedule);
	h.launches[1].onResult({ rows: [{ ...valid.rows[0], verdict: "fail" }] });
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
	expect(current.schedule).toEqual(accepted);
	// A newer delivery/attempt is outside this callback's authority.
	current.schedule.audit = { ...accepted.audit, verdict: "pending", startedAt: accepted.audit.startedAt + 1 };
	h.launches[1].onResult(valid);
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
	expect(current.schedule.audit.verdict).toBe("pending");
});

test("audits the repository bound by an exact git resource instead of lead cwd", () => {
	const sha = "a".repeat(40);
	const row = { content: "Inspect delivery", status: "in_progress", artifactCwd: "/work/lead", schedule: {
		resources: [`git:/work/delivery@${sha}`],
		executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const batches = planRowAudits([row], new Map([["/work/delivery", sha], ["/work/lead", "b".repeat(40)]]), "/work/lead", () => false, () => false);
	expect(batches).toHaveLength(1);
	expect(batches[0]!.repoPath).toBe("/work/delivery");
	expect(batches[0]!.head).toBe(sha);
});

test("audits a plain checkout resource instead of the stale artifact cwd", () => {
	const delivery = mkdtempSync(join(tmpdir(), "audit-checkout-"));
	const init = Bun.spawnSync(["git", "init", "-q", delivery]);
	expect(init.exitCode).toBe(0);
	const sha = "c1".repeat(20);
	const row = { content: "Published delivery", status: "in_progress", artifactCwd: "/work/old", schedule: {
		resources: [delivery],
		progress: { evidence: `Published ${sha}` },
		executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const batches = planRowAudits([row], new Map([[delivery, sha], ["/work/old", "b".repeat(40)]]), "/work/old", () => false, () => false);
	expect(batches).toHaveLength(1);
	expect(batches[0]!.repoPath).toBe(delivery);
	expect(batches[0]!.head).toBe(sha);
});

test("auto-auditor brief uses the checkout resource and its head", async () => {
	const delivery = mkdtempSync(join(tmpdir(), "audit-brief-checkout-"));
	expect(Bun.spawnSync(["git", "init", "-q", delivery]).exitCode).toBe(0);
	const sha = "e2".repeat(20);
	const row = { content: "Published delivery", status: "in_progress", artifactCwd: "/work/old", schedule: {
		resources: [delivery], progress: { evidence: `Published ${sha}` },
		executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { [delivery]: sha, "/work/old": "b2".repeat(20) });
	expect(await h.check()).toBe(1);
	expect(h.launches[0]!.task).toContain(`ROOT=${delivery}`);
	expect(h.launches[0]!.task).toContain(`HEAD=${sha}`);
	await h.abort(0);
});

test("a changed checkout cannot stand in for the pinned delivery revision", () => {
	const row = { content: "Verify pinned delivery", status: "in_progress", schedule: {
		resources: [`git:/work/delivery@${"a".repeat(40)}`],
		executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const batches = planRowAudits([row], new Map([["/work/delivery", "b".repeat(40)]]), "/work/lead", () => false, () => false);
	expect(batches).toHaveLength(0);
});

test("mismatched pinned delivery is visible and never launches an audit", async () => {
	const row = { content: "Verify pinned revision", status: "in_progress", schedule: {
		resources: [`git:/work/delivery@${"a".repeat(40)}`],
		executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { "/work/delivery": "b".repeat(40) });
	expect(await h.check()).toBe(0);
	expect(row.schedule.audit?.verdict).toBe("inconclusive");
	expect(row.schedule.audit?.findings).toContain("does not match checkout");
	expect(todoRowAfterWorker(row)).toMatchObject({ kind: "needs-worker", reason: "audit-inconclusive" });
	expect(await h.check()).toBe(0);
	expect(h.launches).toHaveLength(0);
});

test("rebinding the pinned commit while an audit runs discards the old verdict", async () => {
	const a = "a1".repeat(20), b = "b2".repeat(20);
	const row = { content: "Verify rebinding", status: "in_progress", schedule: {
		resources: [`git:/work/delivery@${a}`],
		executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { "/work/delivery": a });
	expect(await h.check()).toBe(1);
	row.schedule.resources = [`git:/work/delivery@${b}`];
	await h.settle(0, { rows: [verdict(row.content, "pass")] });
	expect(row.status).toBe("in_progress");
	expect(row.schedule.audit.verdict).toBe("pending");
	h.heads["/work/delivery"] = b;
	expect(await h.check()).toBe(1);
	await h.settle(1, { rows: [verdict(row.content, "pass")] });
	expect(row.schedule.audit.head).toBe(b);
	expect(row.status).toBe("completed");
});

test("a delayed failed audit cannot overwrite a newer audit after rebinding", async () => {
	const a = "a1".repeat(20), b = "b2".repeat(20);
	const row = { content: "Verify delayed error", status: "in_progress", schedule: {
		resources: [`git:/work/delivery@${a}`],
		executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { "/work/delivery": a });
	expect(await h.check()).toBe(1);
	row.schedule.resources = [`git:/work/delivery@${b}`];
	const newer = { ...row.schedule.audit, head: b, startedAt: row.schedule.audit.startedAt + 1 };
	row.schedule.audit = newer;
	h.launches[0].reject(new Error("delayed failure"));
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
	expect(row.schedule.audit).toEqual(newer);
});

test("rebinding during auditor resolution does not launch the old audit", async () => {
	const a = "a1".repeat(20), b = "b2".repeat(20);
	const row = { content: "Verify deferred resolution", status: "in_progress", schedule: {
		resources: [`git:/work/delivery@${a}`],
		executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { "/work/delivery": a });
	let release: (value: string) => void;
	const ready = new Promise<void>(resolve => {
		h.options.resolveAuditor = () => new Promise(done => { release = done; resolve(); });
	});
	const checking = h.check();
	await ready;
	row.schedule.resources = [`git:/work/delivery@${b}`];
	release!("qa-auditor");
	expect(await checking).toBe(0);
	expect(h.launches).toHaveLength(0);
});

test("checkout rebind while reading HEAD never launches an unmeasured checkout", async () => {
	const a = "a1".repeat(20), b = "b2".repeat(20);
	const row = { content: "Verify deferred head", status: "in_progress", schedule: {
		resources: [`git:/work/a@${a}`], executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { "/work/a": a, "/work/b": b });
	let release: (value: string) => void;
	const ready = new Promise<void>(resolve => {
		h.options.readHead = () => new Promise(done => { release = done; resolve(); });
	});
	const checking = h.check();
	await ready;
	row.schedule.resources = [`git:/work/b@${b}`];
	release!(a);
	expect(await checking).toBe(0);
	expect(h.launches).toHaveLength(0);
});

test("late missing-profile response cannot overwrite another running audit", async () => {
	const sha = "a1".repeat(20);
	const row = { content: "Verify late registry response", status: "in_progress", schedule: {
		resources: [`git:/work/delivery@${sha}`], executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { "/work/delivery": sha });
	let release: (value: undefined) => void;
	const ready = new Promise<void>(resolve => {
		h.options.resolveAuditor = () => new Promise(done => { release = done; resolve(); });
	});
	const first = h.check();
	await ready;
	h.options.resolveAuditor = async () => "qa-auditor";
	expect(await h.check()).toBe(1);
	const pending = structuredClone(row.schedule.audit);
	release!(undefined);
	expect(await first).toBe(0);
	expect(row.schedule.audit).toEqual(pending);
	await h.abort(0);
});

test("a changed pinned revision invalidates an earlier passing or failing audit", async () => {
	for (const outcome of ["pass", "fail"]) {
		resetRowAuditsForTest();
		const a = "a1".repeat(20), b = "b2".repeat(20);
		const row = { content: `Rebind after ${outcome}`, status: "in_progress", schedule: {
			resources: [`git:/work/delivery@${a}`], executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
		} };
		const h = harness([{ name: "Delivery", tasks: [row] }], { "/work/delivery": a });
		expect(await h.check()).toBe(1);
		await h.settle(0, { rows: [verdict(row.content, outcome)] });
		expect(row.schedule.audit.verdict).toBe(outcome);
		// The host reopens an automatically completed row when resources change.
		row.status = "in_progress";
		row.schedule.resources = [`git:/work/delivery@${b}`];
		h.heads["/work/delivery"] = b;
		expect(todoRowAfterWorker(row)).toMatchObject({ kind: "verify", via: "audit" });
		expect(await h.check()).toBe(1);
		await h.settle(1, { rows: [verdict(row.content, "pass")] });
		expect(row.schedule.audit.head).toBe(b);
		expect(row.status).toBe("completed");
	}
});

test("an in-flight audit cannot overwrite a human acceptance", async () => {
	const a = "a1".repeat(20);
	const row = { content: "Accept during audit", status: "in_progress", schedule: {
		resources: [`git:/work/delivery@${a}`], executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { "/work/delivery": a });
	expect(await h.check()).toBe(1);
	row.schedule.review = "accepted";
	const accepted = structuredClone(row.schedule);
	await h.settle(0, { rows: [verdict(row.content, "fail", "old finding")] });
	expect(row.schedule).toEqual(accepted);
});

test("a passed audit at the same SHA does not transfer to another plain checkout", async () => {
	const a = mkdtempSync(join(tmpdir(), "audit-old-root-")), b = mkdtempSync(join(tmpdir(), "audit-new-root-"));
	for (const repo of [a, b]) expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
	const sha = "a1".repeat(20);
	const row = { content: "Move checkout", status: "in_progress", schedule: {
		resources: [a], progress: { evidence: `Delivered ${sha}` }, executor: { workerId: "Reader", startedAt: 1, finishedAt: 2, outcome: "completed" },
	} };
	const h = harness([{ name: "Delivery", tasks: [row] }], { [a]: sha, [b]: sha });
	expect(await h.check()).toBe(1);
	await h.settle(0, { rows: [verdict(row.content, "pass")] });
	row.status = "in_progress";
	row.schedule.resources = [b];
	expect(todoRowAfterWorker(row)).toMatchObject({ kind: "verify" });
	expect(await h.check()).toBe(1);
	expect(h.launches[1].task).toContain(`ROOT=${b}`);
	await h.abort(1);
});
