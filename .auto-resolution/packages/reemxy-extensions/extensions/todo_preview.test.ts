import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { formatTaskForecastDisplay, forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import {
	overduePreviewRows,
	previewCommits,
	previewDispatchRefusal,
	previewReason,
	previewPlanProblem,
	previewScheduleRefusal,
	refreshPreviewVisibility,
	visualPreviewRow,
} from "./todo_preview";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const asked = Date.UTC(2026, 9, 31, 15, 49);
const sha = "a".repeat(40);
const config = { enabled: true, paths: ["/preview"], thresholdMinutes: 30 };
function plan(commit = sha): TodoScheduleInput {
	return [
		{
			name: "Rename",
			tasks: [
				{
					content: "Rename Network rooms",
					status: "in_progress",
					schedule: {
						firstRequirementAt: asked,
						owner: "Gate",
						dependencies: [],
						executor: {
							workerId: "Rename",
							agentProfile: "coder",
							startedAt: asked,
							gitCommits: [{ commit, repoPath: "/worker" }],
						},
					},
				},
				{
					content: "Full-suite gate",
					status: "in_progress",
					schedule: {
						owner: "Gate",
						executor: { workerId: "Gate", agentProfile: "gate-runner", startedAt: asked },
					},
				},
			],
		},
	];
}

test("rename commit at T+20 remains invisible behind gate at T+30; preview ancestry clears the blocking dispatch", async () => {
	const phases = plan();
	const records = await refreshPreviewVisibility(phases, config, [], asked + 20 * 60_000, async () => false);
	expect(overduePreviewRows(phases, records, config, asked + 29 * 60_000)).toEqual([]);
	const late = overduePreviewRows(phases, records, config, asked + 30 * 60_000);
	expect(late.map(row => row.content)).toEqual(["Rename Network rooms"]);
	expect(previewDispatchRefusal({ tasks: [{ agent: "gate-runner", task: "Rename Network rooms" }] }, late)).toContain(
		"Plan problem ignored: preview-not-visible",
	);
	expect(
		previewDispatchRefusal(
			{
				tasks: [
					{
						agent: "gate-runner",
						task: "Rename Network rooms",
						previewIntegration: { task: "Rename Network rooms", kind: "refresh" },
					},
				],
			},
			late,
		),
	).toBeUndefined();
	expect(
		previewScheduleRefusal(
			{ op: "schedule", updates: [{ task: "Rename Network rooms", owner: "Gate" }] },
			phases,
			records,
			new Map([["Gate", "gate-runner"]]),
		),
	).toContain("refresh the preview");
	expect(
		previewScheduleRefusal(
			{
				op: "schedule",
				updates: [{ task: "Rename Network rooms", owner: "Integrator", dependencies: ["Full-suite gate"] }],
			},
			phases,
			records,
			new Map(),
		),
	).toContain("batch afterwards");
	const visible = await refreshPreviewVisibility(phases, config, records, asked + 31 * 60_000, async () => true);
	expect(visible[0]?.visibleAt).toBe(asked + 31 * 60_000);
	expect(overduePreviewRows(phases, visible, config, asked + 150 * 60_000)).toEqual([]);
	expect(
		previewScheduleRefusal(
			{ op: "schedule", updates: [{ task: "Rename Network rooms", owner: "Gate" }] },
			phases,
			visible,
			new Map([["Gate", "gate-runner"]]),
		),
	).toBeUndefined();
	expect(
		(await refreshPreviewVisibility(phases, config, visible, asked + 90 * 60_000, async () => true))[0]?.visibleAt,
	).toBe(visible[0]?.visibleAt);
});

test("setting off never probes or creates visibility obligations; structured reason lifts the obligation", async () => {
	const phases = plan();
	const disabled = { ...config, enabled: false };
	expect(
		await refreshPreviewVisibility(phases, disabled, [], asked + 40 * 60_000, async () => {
			throw new Error("must not probe");
		}),
	).toEqual([]);
	expect(overduePreviewRows(phases, [], disabled, asked + 40 * 60_000)).toEqual([]);
	const reason = previewReason({
		previewReason: { task: "Rename Network rooms", kind: "external-blocker", detail: "Preview owner unavailable" },
	});
	expect(reason?.reason.kind).toBe("external-blocker");
	expect(
		overduePreviewRows(
			phases,
			[{ task: "Rename Network rooms", commit: sha, reason: reason!.reason }],
			config,
			asked + 40 * 60_000,
		),
	).toEqual([]);
	expect(
		previewReason({ previewReason: { task: "Rename Network rooms", kind: "whatever", detail: "skip" } }),
	).toBeUndefined();
});

test("only structured git identities qualify, never a worker's prose", () => {
	const row = plan()[0]!.tasks[0]!;
	row.schedule!.executor!.gitCommits = [];
	row.schedule!.resources = [`worker says commit ${sha}`, `git:/worker@${sha}`];
	expect(previewCommits(row)).toEqual([sha]);
	row.schedule!.resources = [`worker says commit ${sha}`];
	expect(previewCommits(row)).toEqual([]);
});

test("actual preview HEAD moving to worker commit records the first observed visibility", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-"));
	roots.push(root);
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", root, ...args], {
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	git("init", "-q");
	git("commit", "--allow-empty", "-qm", "baseline");
	const base = git("rev-parse", "HEAD");
	git("commit", "--allow-empty", "-qm", "rename");
	const commit = git("rev-parse", "HEAD");
	git("checkout", "--detach", base);
	const phases = plan(commit);
	const cfg = { ...config, paths: [root] };
	const invisible = await refreshPreviewVisibility(phases, cfg, [], asked + 30 * 60_000);
	expect(invisible[0]?.visibleAt).toBeUndefined();
	git("merge", "--ff-only", commit);
	const visible = await refreshPreviewVisibility(phases, cfg, invisible, asked + 32 * 60_000);
	expect(visible[0]?.visibleAt).toBe(asked + 32 * 60_000);
	expect(visible[0]?.previewPath).toBe(root);
});

test("TODO displays live asked-to-visible and freezes the measured duration", () => {
	const phases = plan();
	const schedule = phases[0]!.tasks[0]!.schedule!;
	schedule.previewTracked = true;
	schedule.previewPending = true;
	let row = forecastTodoPlan(phases, { now: asked + 30 * 60_000 }).rows[0]!;
	expect(formatTaskForecastDisplay(row, asked + 30 * 60_000)).toContain("asked→visible 30m (live)");
	expect(formatTaskForecastDisplay(row, asked + 30 * 60_000)).toContain("commit not visible");
	schedule.visibleAt = asked + 32 * 60_000;
	schedule.previewPending = false;
	row = forecastTodoPlan(phases, { now: asked + 150 * 60_000 }).rows[0]!;
	expect(formatTaskForecastDisplay(row, asked + 150 * 60_000)).toContain("asked→visible 32m");
	expect(formatTaskForecastDisplay(row, asked + 150 * 60_000)).not.toContain("(live)");
});

test("a journaled terminal receipt is still probed when the row no longer retains its executor commit", async () => {
	const phases = plan();
	phases[0]!.tasks[0]!.schedule!.executor!.gitCommits = [];
	const records = await refreshPreviewVisibility(
		phases,
		config,
		[{ task: "Rename Network rooms", commit: sha }],
		asked + 35 * 60_000,
		async () => true,
	);
	expect(records[0]?.visibleAt).toBe(asked + 35 * 60_000);
});

test("am/cherry-picked patches survive deleted worker worktrees and require every row commit", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-patches-"));
	roots.push(root);
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", root, ...args], {
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		});
		if (result.exitCode) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	git("init", "-q");
	git("commit", "--allow-empty", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	const worker = path.join(root, "worker");
	git("worktree", "add", "-qb", "worker", worker);
	await Bun.write(path.join(worker, "one"), "first patch\n");
	git("-C", worker, "add", "one");
	git("-C", worker, "commit", "-qm", "one");
	const one = git("-C", worker, "rev-parse", "HEAD");
	await Bun.write(path.join(worker, "two"), "second patch\n");
	git("-C", worker, "add", "two");
	git("-C", worker, "commit", "-qm", "two");
	const two = git("-C", worker, "rev-parse", "HEAD");
	git("worktree", "remove", worker);
	git("commit", "--allow-empty", "-qm", "lead unrelated");
	git("cherry-pick", one);
	expect(git("rev-parse", "HEAD")).not.toBe(one);
	const phases = plan(one);
	const row = phases[0]!.tasks[0]!;
	row.schedule!.firstRequirementAt = Date.now() - 60_000;
	row.schedule!.executor!.gitCommits = [
		{ commit: one, repoPath: worker },
		{ commit: two, repoPath: worker },
	];
	const cfg = { ...config, paths: [root] };
	const partial = await refreshPreviewVisibility(phases, cfg, [], Date.now());
	expect(partial.map(record => record.visibleAt !== undefined)).toEqual([true, false]);
	expect(overduePreviewRows(phases, partial, { ...cfg, thresholdMinutes: 0 }, Date.now())).toEqual([row]);
	await Bun.write(path.join(root, "second.patch"), git("format-patch", "-1", "--stdout", two) + "\n");
	git("am", path.join(root, "second.patch"));
	const complete = await refreshPreviewVisibility(phases, cfg, partial, Date.now());
	expect(complete.every(record => record.visibleAt !== undefined)).toBe(true);
	// A squash does not have either individual patch identity; an explicit lead receipt proves it.
	git("reset", "--soft", base);
	git("commit", "-qm", "squashed landing");
	const squash = git("rev-parse", "HEAD");
	const unmatched = await refreshPreviewVisibility(phases, cfg, [], Date.now());
	expect(unmatched.some(record => record.visibleAt !== undefined)).toBe(false);
	row.schedule!.resources = [`git:${root}@${squash}`];
	const landed = await refreshPreviewVisibility(phases, cfg, unmatched, Date.now());
	expect(landed.map(record => record.commit)).toEqual([squash]);
	expect(landed[0]?.visibleAt).toBeDefined();
});

test("no identity has no measured delay and partial visibility remains a plan problem", () => {
	const phases = plan();
	const row = phases[0]!.tasks[0]!;
	row.schedule!.executor!.gitCommits = [];
	Object.assign(row.schedule!, { previewTracked: true, previewPending: true, previewIdentityMissing: true });
	const forecast = forecastTodoPlan(phases, { now: asked + 30 * 60_000 }).rows[0]!;
	expect(formatTaskForecastDisplay(forecast, asked + 30 * 60_000)).toContain("asked→visible: no commit");
	const overdue = overduePreviewRows(phases, [], config, asked + 30 * 60_000);
	expect(previewDispatchRefusal({ tasks: [{ agent: "gate-runner", task: row.content }] }, overdue)).toBeUndefined();
	expect(previewPlanProblem(overdue)).toContain("no commit identity");
	Object.assign(row.schedule!, { previewIdentityMissing: false, previewPartial: true });
	expect(
		formatTaskForecastDisplay(forecastTodoPlan(phases, { now: asked + 30 * 60_000 }).rows[0]!, asked + 30 * 60_000),
	).toContain("partially visible");
});

test("invisible rows accept maintenance; explicit gate assignment accepts its documented reason escape", async () => {
	const phases = plan();
	const records = await refreshPreviewVisibility(phases, config, [], asked, async () => false);
	const task = phases[0]!.tasks[0]!.content;
	const profiles = new Map([["Gate", "gate-runner"]]);
	for (const update of [
		{ task, owner: "Coder" },
		{ task, estimate: { likelySeconds: 100 } },
		{ task, review: "user", evidence: "delivered", status: "in_progress" },
	])
		expect(previewScheduleRefusal({ op: "schedule", updates: [update] }, phases, records, profiles)).toBeUndefined();
	const input = { op: "schedule", updates: [{ task, owner: "Gate" }] };
	expect(previewScheduleRefusal(input, phases, records, profiles)).toContain("previewReason={task:");
	const previewReason = { task, kind: "deferred", deferUntil: Date.now() + 60_000, detail: "Preview unavailable until landing" };
	expect(previewScheduleRefusal({ ...input, previewReason }, phases, records, profiles)).toBeUndefined();
	expect(
		previewScheduleRefusal(
			input,
			phases,
			records.map(record => ({ ...record, reason: { kind: "deferred" as const, deferUntil: Date.now() + 60_000, detail: "Deferred" } })),
			profiles,
		),
	).toBeUndefined();
	expect(previewDispatchRefusal({ tasks: [{ agent: "coder", task }] }, [phases[0]!.tasks[0]!])).toBeUndefined();
	expect(
		previewDispatchRefusal({ tasks: [{ agent: "gate-runner", task: "Other gate" }] }, [phases[0]!.tasks[0]!]),
	).toBeUndefined();
	phases[0]!.tasks[0]!.schedule!.executor!.gitCommits = [];
	expect(previewScheduleRefusal(input, phases, [], profiles)).toBeUndefined();
	expect(
		previewDispatchRefusal({ tasks: [{ agent: "coder", task: "Another feature" }] }, [phases[0]!.tasks[0]!]),
	).toBeUndefined();
});

test("a coder owning a suite row is still eligible to own an invisible feature", async () => {
	const phases = plan();
	const gate = phases[0]!.tasks[1]!;
	gate.schedule!.owner = "Coder";
	gate.schedule!.executor!.agentProfile = "coder";
	const records = await refreshPreviewVisibility(phases, config, [], asked, async () => false);
	expect(
		previewScheduleRefusal(
			{ op: "schedule", updates: [{ task: "Rename Network rooms", owner: "Coder" }] },
			phases,
			records,
			new Map([["Coder", "coder"]]),
		),
	).toBeUndefined();
});

// Live DC 2026-11-05: "Refusing idle/wait: preview is overdue for 'Consolidate lane branches into
// one branch'", a rebaser's git integration with nothing to show.
describe("preview gate exempts non-visual rows by behaviour", () => {
	const now = 1_793_900_700_000;
	const config = { enabled: true, thresholdMinutes: 15, paths: ["/home/kom/proj/sunbim/datacenter-decision-graph"] };
	const row = (content: string, schedule: Record<string, unknown>) => ({
		content,
		status: "in_progress" as const,
		schedule: { dependencies: [], firstRequirementAt: now - 60 * 60_000, ...schedule },
	});
	const consolidate = row("Consolidate lane branches into one branch", {
		resources: ["/home/kom/proj/sunbim/datacenter-decision-graph/tmp/consolidated-2026-11-05"],
		executor: { workerId: "ConsolidateBranches-2", agentProfile: "rebaser", startedAt: now - 30_000 },
	});
	const transcript = row("Archive 2026-11-05 sync transcript (Max, Aleksandra)", {
		resources: ["/home/kom/proj/sunbim/datacenter-decision-graph/tmp/followup-pr-2026-11-05/doc/research/transcripts/2026-11-05-xmova-sync.raw.md"],
	});
	const uiRow = row("Facility 2D: too much empty space around site", {
		resources: ["/home/kom/proj/sunbim/datacenter-decision-graph/tmp/facility-empty-space"],
		executor: { workerId: "BuildingSquare-2", agentProfile: "ui-coder", startedAt: now - 30_000 },
	});
	test("a rebaser branch row and a docs-file row are exempt", () => {
		expect(visualPreviewRow(consolidate, config.paths)).toBe(false);
		expect(visualPreviewRow(transcript, config.paths)).toBe(false);
		expect(overduePreviewRows([{ name: "Work", tasks: [consolidate, transcript] }], [], config, now)).toEqual([]);
	});
	test("negative control: a UI row's overdue preview still gates", () => {
		expect(visualPreviewRow(uiRow, config.paths)).toBe(true);
		expect(overduePreviewRows([{ name: "Work", tasks: [uiRow] }], [], config, now).map(r => r.content)).toEqual([uiRow.content]);
	});
	test("neighbour: a non-visual profile touching UI files or the preview checkout is visual", () => {
		const touchesUi = row("Rebase plan panel", { resources: ["src/ui/PlanPanel.tsx"], executor: { workerId: "R", agentProfile: "rebaser", startedAt: now } });
		const previewCheckout = row("Land in preview", { resources: [config.paths[0]], executor: { workerId: "G", agentProfile: "git-pr-owner", startedAt: now } });
		expect(visualPreviewRow(touchesUi, config.paths)).toBe(true);
		expect(visualPreviewRow(previewCheckout, config.paths)).toBe(true);
	});
});
