import { checkRowAudits } from "./row_audit";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { todoRowAfterWorker, forecastTodoPlan, getTodoPlanningIssues } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "../../coding-agent/src/tools/todo";
import { patchTodoSchedule } from "../../coding-agent/src/session/todo-schedule-patch";
import { auditLineage, checkableAuditFinding, reconcileSupersededAudit } from "./audit-supersession";
import {
	readGitIntegrationState,
	decideTodoDispatch,
	leadActionPending,
	supersededAuditDropRefusal,
} from "./todo_dispatch";
import { planChurnRows, waitChainDemands, waitChainRejection } from "./lead_time_notes";

const sha = "a1".repeat(20);
const parent: TodoItem = {
	content: "Deliver",
	status: "completed",
	schedule: {
		executor: { workerId: "worker", startedAt: 1, gitCommits: [{ commit: sha, repoPath: "/repo" }] },
	},
};
const follow: TodoItem = {
	content: "Audit follow-up: Deliver",
	status: "pending",
	notes: ["Check doc/product.md"],
	schedule: { dependencies: [], resources: ["doc/product.md"] },
};

test("legacy follow-up retains the delivery target and recovers it from its parent", () => {
	const phases = patchTodoSchedule([{ name: "Ship", tasks: [parent] }], "Deliver", { auditFollowUps: follow.notes }, 1, {
		legacyFollowUps: true,
	})!;
	const created = phases.flatMap(phase => phase.tasks).find(row => row.content === follow.content)!;
	expect(created.schedule?.auditOrigin?.commit).toBe(sha);
	expect(created.schedule?.auditOrigin?.parent).toBe("Deliver");
	expect(auditLineage(follow, [parent, follow])).toEqual(created.schedule?.auditOrigin);
	const push = { ...parent, content: "Push: run project gates and push origin/old" };
	expect(auditLineage({ ...follow, content: `Audit follow-up: ${push.content}` }, [push])?.branch).toBe("old");
});

test("retarget is one read-only audit, failing or inconclusive results drop and preserve findings", () => {
	const origin = auditLineage(follow, [parent])!;
	const row = reconcileSupersededAudit(follow, origin, sha, true, 10);
	expect(row.schedule?.readOnly).toBe(true);
	expect(row.schedule?.auditOrigin?.retargetHead).toBe(sha);
	expect(row.notes?.join(" ")).toContain("verify on current HEAD; do not look for the old PR/branch");
	expect(todoRowAfterWorker(row)).toMatchObject({ kind: "verify", via: "audit" });
	expect(reconcileSupersededAudit(row, row.schedule!.auditOrigin!, sha, true, 11)).toBe(row);
	for (const verdict of ["fail", "inconclusive"] as const) {
		const result = patchTodoSchedule(
			[{ name: "Check", tasks: [row] }],
			row.content,
			{
				audit: { verdict, head: sha, repoPath: "/repo", delivery: "[]", startedAt: 11 },
				auditFollowUps: ["Another audit"],
			},
			12,
		)!;
		expect(result.flatMap(phase => phase.tasks)).toHaveLength(1);
		const closed = result[0]!.tasks[0]!;
		expect(closed.status).toBe("abandoned");
		expect(closed.schedule?.progress?.evidence).toStartWith("superseded:");
		expect(closed.notes).toContain("Check doc/product.md");
		expect(todoRowAfterWorker(closed)).toBeUndefined();
	}
});

test("push-only and uncheckable findings are accepted without losing delivered evidence", () => {
	for (const origin of [
		{ parent: "Push: run project gates and push origin/old", remote: "origin", branch: "old" },
		{ parent: "Deliver", commit: sha },
	]) {
		const row = reconcileSupersededAudit(
			{ ...follow, schedule: parent.schedule },
			origin,
			sha,
			origin.parent.startsWith("Push:"),
			10,
		);
		expect(row.status).toBe("abandoned");
		expect(row.schedule?.executor).toEqual(parent.schedule?.executor);
		expect(leadActionPending(row)).toBe(false);
		expect(row.notes).toContain("Check doc/product.md");
	}
});

test("superseded checks create no staffing, churn or wait-chain demand", () => {
	const row = reconcileSupersededAudit(follow, auditLineage(follow, [parent])!, sha, true, 10);
	row.schedule!.cumulativeReestimateCount = 8;
	const phases: TodoPhase[] = [
		{
			name: "Check",
			tasks: [row, { content: "Consumer", status: "pending", schedule: { dependencies: [row.content] } }],
		},
	];
	expect(planChurnRows(phases)).toEqual([]);
	expect(waitChainDemands(phases)).toEqual([]);
	const decision = decideTodoDispatch(
		{ phases: [{ name: "Check", tasks: [row] }], jobs: null, isMainSession: true, taskEnabled: true, now: 10 },
		{ forecastTodoPlan, getTodoPlanningIssues, formatPlanForecast: () => "", formatTaskForecast: () => "" },
	);
	expect(decision.dispatchableReady ?? []).toEqual([]);
});

test("git proof distinguishes removed, merged, unmerged and unknown targets; unmerged follow-up is unchanged", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "audit-superseded-"));
	const git = async (...args: string[]) => (await $`git -C ${root} ${args}`.quiet()).text().trim();
	try {
		await git("init", "-b", "main");
		await git("config", "user.name", "test");
		await git("config", "user.email", "test@example.com");
		await Bun.write(path.join(root, "doc/product.md"), "contract");
		await git("add", ".");
		await git("commit", "-m", "base");
		const base = await git("rev-parse", "HEAD");
		await git("clone", "--bare", root, path.join(root, "remote.git"));
		await git("remote", "add", "origin", path.join(root, "remote.git"));
		await git("checkout", "-b", "topic");
		await Bun.write(path.join(root, "doc/product.md"), "changed");
		await git("commit", "-am", "topic");
		const commit = await git("rev-parse", "HEAD");
		await git("push", "origin", "topic");
		const target = { parent: "Deliver", remote: "origin", branch: "topic", commit, repoPath: root };
		const phasesForDrop = [
			{ name: "Later", tasks: [{ ...follow, schedule: { auditOrigin: { ...target, supersededAt: 1 } } }] },
		];
		const drop = { op: "drop", task: follow.content, reason: "superseded: forged claim" };
		expect(await supersededAuditDropRefusal(drop, phasesForDrop, root)).toContain("unmerged");
		expect(await supersededAuditDropRefusal(drop, [], root, phasesForDrop)).toContain("unmerged");
		expect(
			await supersededAuditDropRefusal({ ...drop, reason: "ordinary cancellation" }, phasesForDrop, root),
		).toBeUndefined();
		const live = await readGitIntegrationState(root, Date.now(), process.env, true, target);
		expect(live?.targetMerged).not.toBe(true);
		expect(live?.pushTargetMissing).not.toBe(true);
		const phases = [{ name: "Later", tasks: [follow] }];
		expect(
			patchTodoSchedule(phases, follow.content, { auditFollowUps: ["more"] })!.flatMap(phase => phase.tasks),
		).toHaveLength(1);
		expect(phases[0]!.tasks[0]).toBe(follow);
		expect(
			(await readGitIntegrationState(root, Date.now(), process.env, true, { ...target, commit: base }))
				?.targetMerged,
		).toBe(true);
		await git("push", "origin", "--delete", "topic");
		expect(await supersededAuditDropRefusal(drop, phasesForDrop, root)).toBeUndefined();
		expect((await readGitIntegrationState(root, Date.now(), process.env, true, target))?.pushTargetMissing).toBe(
			true,
		);
		await git("remote", "set-url", "origin", path.join(root, "absent.git"));
		const unknown = await readGitIntegrationState(root, Date.now(), process.env, true, target);
		expect(unknown?.pushTargetMissing).toBeUndefined();
		expect(unknown?.targetMerged).toBeUndefined();
		expect(await supersededAuditDropRefusal(drop, phasesForDrop, root)).toContain("unavailable");
		expect(await checkableAuditFinding({ ...follow, schedule: {} }, root)).toBe(false);
		expect(await checkableAuditFinding(follow, root)).toBe(true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("the runtime auditor consumes a retarget once and never retries an inconclusive finding", async () => {
	const row = reconcileSupersededAudit(follow, auditLineage(follow, [parent])!, sha, true, 10);
	let phases: TodoPhase[] = [{ name: "Check", tasks: [row] }];
	let calls = 0;
	const finished = Promise.withResolvers<void>();
	const ctx = {
		cwd: "/repo",
		sessionManager: { getHeader: () => ({ id: "superseded-runtime" }) },
		getTodoPhases: () => phases,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		updateTodoSchedule: (task: string, patch: Partial<TodoSchedule>) => {
			phases = patchTodoSchedule(phases, task, patch, 12)!;
			if (phases[0]!.tasks[0]!.status === "abandoned") finished.resolve();
			return true;
		},
		runRowAudit: async () => {
			calls++;
			return {
				details: {
					results: [
						{
							output: JSON.stringify({
								rows: [
									{
										row: follow.content,
										verdict: "inconclusive",
										findings: "missing fixture",
										checks: [],
										screenshots: [],
									},
								],
							}),
						},
					],
				},
			};
		},
	} as unknown as ExtensionContext;
	const options = { readHead: async () => sha, resolveAuditor: async () => "qa-auditor", requirementsFor: () => [] };
	expect(await checkRowAudits(ctx, options)).toBe(1);
	await finished.promise;
	expect(await checkRowAudits(ctx, options)).toBe(0);
	expect(calls).toBe(1);
	expect(phases[0]!.tasks[0]!.status).toBe("abandoned");
});

test("a new runtime audit cannot erase an accepted refusal for the same dependency graph", async () => {
	let phases: TodoPhase[] = [
		{
			name: "Ship",
			tasks: [
				{
					content: "Head",
					status: "pending",
					schedule: {
						readOnly: true,
						cumulativeReestimateCount: 4,
						progress: { at: 3, evidence: "later progress" },
					},
				},
				...Array.from({ length: 4 }, (_, i) => ({
					content: `Dependent ${i}`,
					status: "pending" as const,
					schedule: { dependencies: [i ? `Dependent ${i - 1}` : "Head"] },
				})),
			],
		},
	];
	const demand = waitChainDemands(phases)[0]!;
	const evidence = `Dependency review ${demand.key}:\n${demand.edges.map(edge => `${edge.task} <- ${edge.dependency}: required output`).join("\n")}`;
	phases = getLatestTodoPhasesFromEntries([
		{
			type: "custom",
			id: "initial",
			parentId: null,
			timestamp: new Date(3).toISOString(),
			customType: "user_todo_edit",
			data: { phases },
		},
		{
			type: "message",
			id: "refusal",
			parentId: "initial",
			timestamp: new Date(3).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "schedule",
				content: [],
				isError: false,
				timestamp: 3,
				toolName: "todo",
				details: {
					edit: {
						v: 1,
						kind: "op",
						op: "schedule",
						at: 3,
						params: { op: "schedule", updates: [{ task: "Head", evidence }] },
					},
				},
			},
		},
	]);
	phases = patchTodoSchedule(phases, "Head", {
		executor: {
			workerId: "done",
			startedAt: 1,
			finishedAt: 2,
			outcome: "completed",
			gitCommits: [{ commit: sha, repoPath: "/repo" }],
		},
		audit: { delivery: "old", head: "old", repoPath: "/repo", startedAt: 1, verdict: "inconclusive", evidence },
		progress: { at: 3, evidence: "later audit result" },
	})!;
	const output = Promise.withResolvers<unknown>();
	const ctx = {
		cwd: "/repo",
		sessionManager: { getHeader: () => ({ id: "refusal-relaunch" }) },
		getTodoPhases: () => phases,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		updateTodoSchedule: (task: string, patch: Partial<TodoSchedule>) => {
			phases = patchTodoSchedule(phases, task, patch)!;
			return true;
		},
		runRowAudit: () => output.promise,
	} as unknown as ExtensionContext;
	expect(waitChainRejection(demand, phases)).toBe(evidence);
	expect(
		await checkRowAudits(ctx, {
			readHead: async () => sha,
			containsCommit: async (repoPath, commit, head) => repoPath === "/repo" && commit === sha && head === sha,
			resolveAuditor: async () => "qa-auditor",
			requirementsFor: () => [],
		}),
	).toBe(1);
	phases = patchTodoSchedule(phases, "Head", {
		progress: { at: 4, evidence: `Dependency review ${demand.key}: incomplete later update` },
	})!;
	const resumed = JSON.parse(JSON.stringify(phases)) as TodoPhase[];
	expect(waitChainRejection(demand, resumed)).toBe(evidence);
	delete resumed[0]!.tasks[0]!.schedule!.executor;
	resumed[0]!.tasks[4]!.schedule!.dependencies!.push("Head");
	const changed = waitChainDemands(resumed)[0]!;
	expect(changed.key).not.toBe(demand.key);
	expect(waitChainRejection(changed, resumed)).toBeUndefined();
	output.resolve({});
});
