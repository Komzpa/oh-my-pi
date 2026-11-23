import { afterAll, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	TodoTool,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { todoAuditResourcesKey } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkRowAudits,
	planRowAudits,
	resetRowAuditsForTest,
	rowAuditRepository,
	rowAuditTask,
	type RowAuditRow,
} from "./row_audit";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "audit-identity-"));
const delivery = path.join(fixture, "delivery"),
	stale = path.join(fixture, "stale");
for (const repo of [delivery, stale]) {
	fs.mkdirSync(repo);
	expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
}
fs.mkdirSync(path.join(delivery, "lib"));
fs.writeFileSync(path.join(delivery, "lib", "present.ts"), "export const value = 1;\n");
const head = "c1".repeat(20),
	oldHead = "b2".repeat(20);
const heads = new Map([
	[delivery, head],
	[stale, oldHead],
]);
function delivered(resources: string[]): RowAuditRow {
	return {
		content: "Deliver implementation",
		status: "in_progress",
		artifactCwd: stale,
		schedule: {
			resources,
			progress: { at: 2, evidence: `Published ${head}` },
			executor: { workerId: "Producer", startedAt: 1, finishedAt: 2, outcome: "completed" },
		},
	};
}
const plan = (row: RowAuditRow) =>
	planRowAudits(
		[row],
		heads,
		stale,
		() => false,
		() => false,
	);
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));

for (const [name, resources] of [
	["existing file", [path.join(delivery, "lib/present.ts")]],
	["new file", [path.join(delivery, "lib/future.ts")]],
	["subdirectory", [path.join(delivery, "lib")]],
	["multiple files", [path.join(delivery, "lib/present.ts"), path.join(delivery, "lib/future.ts")]],
	["matching pin and file", [`git:${delivery}@${head}`, path.join(delivery, "lib/present.ts")]],
] as const)
	test(`restored ${name} delivery audits its checkout instead of stale artifact cwd`, () => {
		const row = JSON.parse(JSON.stringify(delivered([...resources]))) as RowAuditRow;
		const batches = plan(row);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toMatchObject({ repoPath: delivery, head });
		expect(batches[0]!.rows[0]!.schedule?.resources).toEqual([...resources]);
		expect(rowAuditTask(batches[0]!)).toContain(`ROOT=${delivery}`);
	});

for (const [name, resources] of [
	["files from different repositories", [path.join(delivery, "lib/present.ts"), path.join(stale, "other.ts")]],
	["pin conflicts with file checkout", [`git:${stale}@${oldHead}`, path.join(delivery, "lib/present.ts")]],
	["two revision pins", [`git:${delivery}@${head}`, `git:${delivery}@${oldHead}`]],
] as const)
	test(`${name} blocks without falling back to artifact cwd`, async () => {
		resetRowAuditsForTest();
		const row = delivered([...resources]);
		expect(plan(row)).toHaveLength(0);
		expect(rowAuditRepository(row, stale)).toHaveProperty("blocker");
		let launches = 0;
		const reads: string[] = [];
		const ctx = {
			cwd: stale,
			sessionManager: { getHeader: () => ({ id: `identity-${name}` }) },
			getTodoPhases: () => [{ name: "Delivery", tasks: [row] }],
			updateTodoSchedule: (
				_content: string,
				patch: { audit: NonNullable<NonNullable<RowAuditRow["schedule"]>["audit"]> },
			) => {
				Object.assign(row.schedule!, patch);
				return true;
			},
			runRowAudit: () => {
				launches++;
			},
		} as unknown as ExtensionContext;
		expect(
			await checkRowAudits(ctx, {
				readHead: async repo => {
					reads.push(repo);
					return heads.get(repo);
				},
			}),
		).toBe(0);
		expect(launches).toBe(0);
		expect(reads).toEqual([]);
		expect(row.schedule?.audit).toMatchObject({
			verdict: "inconclusive",
			attempts: 2,
			resourcesKey: todoAuditResourcesKey(row.schedule),
		});
		expect(row.schedule?.audit?.findings).toContain("Audit repository is ambiguous");
		expect(row.schedule?.audit?.findings).toMatch(/split|keep one/);
	});

test("unresolved relative file resources report the missing checkout instead of stale cwd", () => {
	const row = delivered(["lib/present.ts"]);
	expect(plan(row)).toHaveLength(0);
	expect(rowAuditRepository(row, stale)).toMatchObject({
		blocker: expect.stringContaining("supply absolute checkout/file paths"),
	});
});

fs.mkdirSync(path.join(fixture, "evidence"));
fs.writeFileSync(path.join(fixture, "evidence", "audit.json"), "{}\n");
for (const resource of [
	path.join(fixture, "evidence", "audit.json"),
	path.join(fixture, "removed-checkout", "src", "implementation.ts"),
])
	test(`unbound resource ${path.relative(fixture, resource)} cannot select stale artifact cwd`, () => {
		const row = JSON.parse(JSON.stringify(delivered([resource]))) as RowAuditRow;
		expect(plan(row)).toHaveLength(0);
		expect(rowAuditRepository(row, stale)).toMatchObject({
			blocker: expect.stringContaining("no source checkout"),
		});
	});

test("wrong revision pin never audits the current checkout instead", () => {
	expect(plan(delivered([`git:${delivery}@${oldHead}`]))).toHaveLength(0);
});

for (const pinned of [false, true])
	test(`external evidence output preserves ${pinned ? "pinned" : "file-scoped"} source checkout`, () => {
		const evidence = path.join(fixture, "evidence", "audit.json");
		const row = delivered([
			...(pinned ? [`git:${delivery}@${head}`] : [path.join(delivery, "lib/present.ts")]),
			evidence,
		]);
		expect(plan(row)[0]).toMatchObject({ repoPath: delivery, head });
		expect(plan(row)[0]!.rows[0]!.schedule?.resources).toContain(evidence);
	});

test("commit receipt in a different source checkout blocks instead of following file resources", () => {
	const row = delivered([path.join(delivery, "lib/present.ts")]);
	row.schedule!.executor!.gitCommits = [{ repoPath: stale, commit: oldHead }];
	expect(plan(row)).toHaveLength(0);
	expect(rowAuditRepository(row, stale)).toHaveProperty("blocker");
});

function git(repo: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode).toBe(0);
	return result.stdout.toString().trim();
}

test("current head must contain every recorded delivery commit before an audit can launch", async () => {
	git(
		delivery,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"first",
	);
	const deliveredHead = git(delivery, "rev-parse", "HEAD");
	git(
		delivery,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"second",
	);
	const currentHead = git(delivery, "rev-parse", "HEAD");
	git(
		stale,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"other repository",
	);
	const missingHead = git(stale, "rev-parse", "HEAD");
	const tree = git(delivery, "rev-parse", "HEAD^{tree}");
	const unrelatedHead = git(
		delivery,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit-tree",
		tree,
		"-m",
		"unrelated history",
	);
	for (const [commit, accepted] of [
		[deliveredHead, true],
		[currentHead, true],
		[unrelatedHead, false],
		[missingHead, false],
	] as const) {
		resetRowAuditsForTest();
		const row = delivered([path.join(delivery, "lib/present.ts")]);
		row.schedule!.executor!.gitCommits = [
			{ repoPath: delivery, commit: deliveredHead },
			{ repoPath: delivery, commit },
		];
		let launches = 0;
		const ctx = {
			cwd: stale,
			sessionManager: { getHeader: () => ({ id: `receipt-${commit}` }) },
			getTodoPhases: () => [{ name: "Delivery", tasks: [row] }],
			updateTodoSchedule: (_content: string, patch: object) => {
				Object.assign(row.schedule!, patch);
				return true;
			},
			runRowAudit: () => {
				launches++;
			},
		} as unknown as ExtensionContext;
		expect(
			await checkRowAudits(ctx, { readHead: async () => currentHead, resolveAuditor: async () => undefined }),
		).toBe(0);
		expect(launches).toBe(0);
		expect(row.schedule?.audit?.verdict).toBe(accepted ? "unavailable" : "inconclusive");
		if (!accepted)
			expect(row.schedule?.audit?.findings).toContain(
				commit === missingHead ? "Cannot verify delivery commit" : "is not contained",
			);
	}
});

test("TodoTool assignment, narrowed resources and replan restore the same audit identity", async () => {
	let phases = [{ name: "Delivery", tasks: [delivered([delivery])] }] as TodoPhase[];
	const session: ToolSession = {
		cwd: stale,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
	const tool = new TodoTool(session);
	const assigned = await tool.execute("assign", {
		op: "schedule",
		updates: [{ task: "Deliver implementation", owner: "Producer", resources: [delivery] }],
	});
	expect(assigned.isError).not.toBe(true);
	const resources = [
		`git:${delivery}@${head}`,
		path.join(delivery, "lib/present.ts"),
		path.join(delivery, "lib/future.ts"),
	];
	const narrowed = await tool.execute("narrow", {
		op: "schedule",
		updates: [{ task: "Deliver implementation", resources }],
	});
	expect(narrowed.isError).not.toBe(true);
	const replanned = await tool.execute("replan", {
		op: "init",
		list: [{ phase: "Verification", items: ["Deliver implementation", "Inspect evidence"] }],
	});
	expect(replanned.isError).not.toBe(true);
	const restored = getLatestTodoPhasesFromEntries([
		{
			type: "message",
			id: "replan",
			parentId: null,
			timestamp: "2026-11-10T12:00:00.000Z",
			message: {
				role: "toolResult",
				toolName: "todo",
				isError: false,
				content: replanned.content,
				details: replanned.details,
			},
		} as unknown as SessionEntry,
	]);
	expect(restored).toBeDefined();
	const disk = markdownToPhases(phasesToMarkdown(restored!));
	expect(disk.errors).toEqual([]);
	const row = disk.phases.flatMap(phase => phase.tasks).find(task => task.content === "Deliver implementation")!;
	expect(row.schedule?.resources).toEqual(resources);
	expect(row.schedule?.executor).toMatchObject({ workerId: "Producer", finishedAt: 2 });
	const batches = planRowAudits(
		[row],
		heads,
		stale,
		() => false,
		() => false,
	);
	expect(batches[0]).toMatchObject({ repoPath: delivery, head });
	const task = rowAuditTask(batches[0]!);
	expect(task).toContain(`ROOT=${delivery}`);
	expect(task).toContain(`HEAD=${head}`);
	for (const resource of resources) expect(task).toContain(resource);
	expect(task).toContain("agent://Producer");
});

for (const status of ["in_progress", "completed", "abandoned"] as const) {
	test(`replan preserves revoked grants and ${status} delivery without granting a new item`, async () => {
		const original = delivered([]);
		original.status = status;
		original.schedule!.startedAt = 1;
		if (status !== "in_progress") original.schedule!.finishedAt = 2;
		let phases: TodoPhase[] = [{ name: "Before", tasks: [original] }];
		const session: ToolSession = {
			cwd: stale,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
		};
		const result = await new TodoTool(session).execute("reorganize", {
			op: "init",
			list: [{ phase: "After", items: [original.content, "New independent item"] }],
		});
		expect(result.isError).not.toBe(true);
		expect(phases[0]!.tasks[0]).toEqual(original);
		expect(phases[0]!.tasks[0]).not.toBe(original);
		expect(phases[0]!.tasks[1]).toMatchObject({
			content: "New independent item",
			status: status === "in_progress" ? "pending" : "in_progress",
		});
		expect(phases[0]!.tasks[1]!.schedule?.resources).toBeUndefined();
		expect(phases[0]!.tasks[1]!.schedule?.executor).toBeUndefined();
	});
}
