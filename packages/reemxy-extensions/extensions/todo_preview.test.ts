import { afterEach, expect, test } from "bun:test";
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
	previewScheduleRefusal,
	refreshPreviewVisibility,
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
	expect(previewDispatchRefusal({ tasks: [{ agent: "coder", task: "Unrelated change" }] }, late)).toContain(
		"Plan problem ignored: preview-not-visible",
	);
	expect(
		previewDispatchRefusal(
			{ tasks: [{ previewIntegration: { task: "Rename Network rooms", kind: "refresh" } }] },
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
