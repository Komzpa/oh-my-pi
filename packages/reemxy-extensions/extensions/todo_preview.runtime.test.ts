// @ts-nocheck -- exercises registered extension hooks with a disposable session journal.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch from "./todo_dispatch";
import { PREVIEW_ENTRY_TYPE } from "./todo_preview";

const roots = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function harness(enabled) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-hooks-"));
	roots.push(cwd);
	const git = (...args) => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
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
	git("checkout", "-qb", "rename-worker");
	git("commit", "--allow-empty", "-qm", "rename");
	const commit = git("rev-parse", "HEAD");
	git("checkout", "--detach", base);
	const asked = Date.now() - 30 * 60_000;
	let phases = [
		{
			name: "Tasks",
			tasks: [
				{
					content: "Rename Racks and rows",
					status: "in_progress",
					schedule: {
						firstRequirementAt: asked,
						owner: "Gate",
						dependencies: [],
						executor: {
							workerId: "Rename",
							agentProfile: "coder",
							startedAt: asked,
							gitCommits: [{ commit, repoPath: cwd }],
						},
					},
				},
				{
					content: "Full-suite landing gate",
					status: "in_progress",
					schedule: {
						owner: "Gate",
						executor: { workerId: "Gate", agentProfile: "gate-runner", startedAt: asked },
					},
				},
			],
		},
	];
	const journal = [];
	const sent = [];
	const hooks = new Map();
	const timers = [];
	const api = {
		on: (name, hook) => hooks.set(name, hook),
		getActiveTools: () => ["todo", "task", "read"],
		appendEntry: (customType, data) => journal.push({ type: "custom", customType, data }),
		sendMessage: msg => sent.push(msg),
		pi: { ...schedule, getLatestTodoPhasesFromEntries, agentPauseGate: { paused: false } },
		registerSoftToolRequirementProvider: () => {},
	};
	await todoDispatch(api);
	const ctx = {
		cwd,
		getTodoPreviewConfig: () => ({ enabled, paths: [cwd], thresholdMinutes: 30 }),
		sessionManager: {
			getHeader: () => ({ id: "preview-hooks" }),
			getBranch: () => journal,
			getBranchMatching: predicate => journal.filter(predicate),
			getLatestBranchMatching: predicate => journal.findLast(predicate),
			getSessionFile: () => undefined,
		},
		getTodoPhases: () => structuredClone(phases),
		setTodoPhases: next => {
			phases = next;
		},
		updateTodoSchedule: (task, patch) => {
			const row = phases[0].tasks.find(row => row.content === task);
			if (!row) return false;
			row.schedule = { ...row.schedule, ...patch };
			return true;
		},
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 20,
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}),
		setInterval: fn => {
			timers.push(fn);
			return {};
		},
		clearInterval: () => {},
		clearTimer: () => {},
	};
	return { git, commit, hooks, ctx, journal, sent, timers, phases: () => phases };
}

test("runtime rename replay refuses gate scheduling and unrelated dispatch, journals actual preview visibility and clears refusal", async () => {
	const h = await harness(true);
	const call = h.hooks.get("tool_call");
	const scheduleRefusal = await call(
		{
			toolName: "todo",
			input: {
				op: "schedule",
				updates: [{ task: "Rename Racks and rows", dependencies: ["Full-suite landing gate"] }],
			},
		},
		h.ctx,
	);
	expect(scheduleRefusal?.reason).toContain("Refusing todo schedule");
	const unrelated = { toolName: "task", input: { tasks: [{ agent: "coder", task: "Another feature" }] } };
	expect((await call(unrelated, h.ctx))?.reason).toContain("preview-not-visible");
	const integration = await call(
		{
			toolName: "task",
			input: {
				tasks: [
					{
						name: "PublishPreview",
						agent: "coder",
						task: "Rename Racks and rows",
						previewIntegration: { task: "Rename Racks and rows", kind: "integration" },
					},
				],
			},
		},
		h.ctx,
	);
	expect(integration?.reason).toBeUndefined();
	expect(h.phases()[0].tasks[0].schedule.previewPending).toBe(true);
	h.git("merge", "--ff-only", h.commit);
	await call({ toolName: "read", input: { path: "README.md" } }, h.ctx);
	const record = h.journal.filter(entry => entry.customType === PREVIEW_ENTRY_TYPE).at(-1).data.records[0];
	expect(record.visibleAt).toBeNumber();
	expect(record.previewPath).toBe(h.ctx.cwd);
	expect(h.phases()[0].tasks[0].schedule.visibleAt).toBe(record.visibleAt);
	expect((await call(unrelated, h.ctx))?.reason ?? "").not.toContain("preview-not-visible");
});

test("runtime off has no preview journal, HUD metadata or dispatch obligation", async () => {
	const h = await harness(false);
	const result = await h.hooks.get("tool_call")(
		{ toolName: "task", input: { tasks: [{ agent: "coder", task: "Another feature" }] } },
		h.ctx,
	);
	expect(result?.reason ?? "").not.toContain("preview-not-visible");
	expect(h.journal.some(entry => entry.customType === PREVIEW_ENTRY_TYPE)).toBe(false);
	expect(h.phases()[0].tasks[0].schedule.previewTracked).toBeUndefined();
});

test("a failed todo call cannot waive preview dispatch; a successful structured reason can", async () => {
	const h = await harness(true);
	const call = h.hooks.get("tool_call");
	const input = {
		op: "view",
		previewReason: {
			task: "Rename Racks and rows",
			kind: "external-blocker",
			detail: "Preview temporarily unavailable",
		},
	};
	await call({ toolName: "todo", input }, h.ctx);
	await h.hooks.get("tool_result")(
		{ toolName: "todo", content: [], input, isError: true, details: { op: "view" } },
		h.ctx,
	);
	const dispatch = { toolName: "task", input: { tasks: [{ task: "Another feature", agent: "coder" }] } };
	expect((await call(dispatch, h.ctx))?.reason).toContain("preview-not-visible");
	await h.hooks.get("tool_result")(
		{ toolName: "todo", content: [], input, isError: false, details: { op: "view" } },
		h.ctx,
	);
	expect((await call(dispatch, h.ctx))?.reason ?? "").not.toContain("preview-not-visible");
	expect(h.journal.filter(entry => entry.customType === PREVIEW_ENTRY_TYPE).at(-1).data.records[0].reason.kind).toBe(
		"external-blocker",
	);
});

test("successful terminal branch receipt is attributed to the executor after schedule owner changes", async () => {
	const h = await harness(true);
	delete h.phases()[0].tasks[0].schedule.executor.gitCommits;
	await h.hooks.get("tool_result")(
		{
			toolName: "task",
			isError: false,
			details: {
				results: [
					{ id: "Rename", exitCode: 0, branchName: "rename-worker", branchBaseSha: h.git("rev-parse", "HEAD") },
				],
			},
		},
		h.ctx,
	);
	const records = h.journal.filter(entry => entry.customType === PREVIEW_ENTRY_TYPE).at(-1).data.records;
	expect(records[0].task).toBe("Rename Racks and rows");
	expect(records[0].commit).toBe(h.commit);
	expect(h.phases()[0].tasks[0].schedule.previewPending).toBe(true);
	h.git("merge", "--ff-only", h.commit);
	await h.hooks.get("tool_call")({ toolName: "read", input: {} }, h.ctx);
	expect(
		h.journal.filter(entry => entry.customType === PREVIEW_ENTRY_TYPE).at(-1).data.records[0].visibleAt,
	).toBeNumber();
});

test("the plan timer observes preview advancement without another tool event", async () => {
	const h = await harness(true);
	await h.hooks.get("session_start")({}, h.ctx);
	expect(h.timers.length).toBeGreaterThan(0);
	await h.timers.at(-1)();
	expect(h.phases()[0].tasks[0].schedule.previewPending).toBe(true);
	h.git("merge", "--ff-only", h.commit);
	await h.timers.at(-1)();
	expect(h.phases()[0].tasks[0].schedule.visibleAt).toBeNumber();
	h.hooks.get("session_shutdown")?.({}, h.ctx);
});

test("ordinary completed worker's resource checkout attributes one commit to both rename rows", async () => {
	const h = await harness(true);
	const row = h.phases()[0].tasks[0];
	delete row.schedule.executor.gitCommits;
	const workerPath = path.join(h.ctx.cwd, "worker-checkout");
	h.git("worktree", "add", workerPath, "rename-worker");
	row.schedule.resources = [workerPath];
	row.schedule.executor.outcome = "completed";
	row.schedule.executor.finishedAt = Date.now();
	h.phases()[0].tasks.push({
		content: "Rename Network rooms",
		status: "in_progress",
		schedule: { firstRequirementAt: row.schedule.firstRequirementAt, owner: "Rename", resources: [workerPath] },
	});
	await h.hooks.get("tool_call")({ toolName: "read", input: {} }, h.ctx);
	const records = h.journal.filter(entry => entry.customType === PREVIEW_ENTRY_TYPE).at(-1).data.records;
	expect(records.map(record => record.task).sort()).toEqual(["Rename Network rooms", "Rename Racks and rows"]);
	expect(records.every(record => record.commit === h.commit && record.visibleAt === undefined)).toBe(true);
	h.git("merge", "--ff-only", h.commit);
	await h.hooks.get("tool_call")({ toolName: "read", input: {} }, h.ctx);
	expect(
		h
			.phases()[0]
			.tasks.filter(row => row.content.startsWith("Rename"))
			.every(row => typeof row.schedule.visibleAt === "number"),
	).toBe(true);
});
