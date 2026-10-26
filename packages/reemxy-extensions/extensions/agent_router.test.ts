// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	sessionContextEntryMetadata,
	type SessionContextEntryMetadata,
} from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import agentRouter, {
	countLiveWorkerModels,
	createRouterState,
	recordAsyncResultOutcome,
	recordRetryFallbackApplied,
	recordTaskOutcome,
	routeSubagentSpawn,
} from "./agent_router";

const CODER_CHAIN = ["codex-lb/gpt-6-luna:medium", "anthropic/claude-sonnet-5-5"];

// Core resolves models; the router only gates writers and records spawns/outcomes.
const MODEL_SPECS = [
	"codex-lb/gpt-6-luna:medium",
	"anthropic/claude-sonnet-5-5",
	"codex-lb/gpt-6.1-sol:high",
	"xai-oauth/grok-4.6",
];

function branchMock(getBranch: () => unknown[]) {
	return {
		getBranch,
		getBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) =>
			getBranch().filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
		getLatestBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) =>
			getBranch().findLast(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
	};
}

function ctx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	const models = MODEL_SPECS.map(spec => {
		const base = spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "");
		const slash = base.indexOf("/");
		return { provider: base.slice(0, slash), id: base.slice(slash + 1) };
	});
	const sessionManager =
		overrides.sessionManager instanceof SessionManager
			? overrides.sessionManager
			: {
					getHeader: () => ({ id: "session-1" }),
					...branchMock(overrides.sessionManager?.getBranch?.bind(overrides.sessionManager) ?? (() => [])),
					...overrides.sessionManager,
				};
	return {
		models: {
			list: () => models,
			resolve: (spec: string) =>
				models.find(
					model => `${model.provider}/${model.id}` === spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, ""),
				),
		},
		...overrides,
		sessionManager,
	} as unknown as ExtensionContext;
}

function tempStateFile(): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "omp-agent-router-"));
	return { dir, file: join(dir, "spawns.jsonl") };
}

function readJsonl(file: string): Array<Record<string, unknown>> {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

function toolCallHandler(): (event: unknown, ctx: ExtensionContext) => unknown {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	agentRouter({
		setLabel: () => undefined,
		on: (event, handler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI);
	return handlers.get("tool_call")!;
}

describe("agent router", () => {
	test("writes spawn JSONL with requested stats fields", async () => {
		const { dir, file } = tempStateFile();
		try {
			const now = () => new Date("2026-09-24T18:00:00.000Z");
			routeSubagentSpawn(
				{ agent: "workhorse", spawnKey: "work-1", patterns: ["a/one", "b/two"] },
				ctx(),
				createRouterState(),
				{ stateFile: file, now },
			);
			expect(readJsonl(file)).toEqual([
				{
					kind: "spawn",
					spawnKey: "work-1",
					at: "2026-09-24T18:00:00.000Z",
					sessionId: "session-1",
					agent: "workhorse",
					chosen: "a/one",
					order: ["a/one", "b/two"],
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("blocks a second non-isolated writer while allowing isolation", async () => {
		const { dir, file } = tempStateFile();
		try {
			const state = createRouterState();
			let running: Array<{ id: string; agentId: string; type: string; status: string }> = [];
			const context = ctx({ getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }) });
			const first = await routeSubagentSpawn(
				{ agent: "coder", spawnKey: "writer-1", isolated: false },
				context,
				state,
				{ stateFile: file },
			);
			expect(first?.block).toBeUndefined();

			running = [{ id: "writer-1", agentId: "writer-1", type: "task", status: "running" }];
			const blocked = await routeSubagentSpawn(
				{ agent: "ui-coder", spawnKey: "writer-2", isolated: false },
				context,
				state,
				{ stateFile: file },
			);
			expect(blocked).toMatchObject({ block: true });
			expect(blocked?.reason).toContain("writer-1");
			expect(blocked?.reason).toContain("isolated: true");

			const isolated = await routeSubagentSpawn(
				{ agent: "ui-coder", spawnKey: "writer-isolated", isolated: true },
				context,
				state,
				{ stateFile: file },
			);
			expect(isolated?.block).not.toBe(true);
			await recordTaskOutcome(
				{ toolName: "wait", details: { jobs: [{ id: "writer-1", status: "completed", durationMs: 100 }] } },
				context,
				state,
				{ stateFile: file },
			);
			running = [];
			const afterCompletion = await routeSubagentSpawn(
				{ agent: "workhorse", spawnKey: "writer-3", isolated: false },
				context,
				state,
				{ stateFile: file },
			);
			expect(afterCompletion?.block).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps long file paths and worker ids actionable in the first line", async () => {
		const { dir, file } = tempStateFile();
		try {
			const call = toolCallHandler();
			const longPath = `src/${"very-long-directory-".repeat(8)}target-file.txt`;
			const write = await call({ toolName: "write", input: { path: longPath, content: "" } }, ctx({ cwd: dir }));
			const writeAction = write.reason.split("\n", 1)[0];
			expect(writeAction.length).toBeLessThanOrEqual(100);
			expect(writeAction).toContain("replace: true");
			expect(writeAction).toContain("target-file.txt");
			expect(write.reason).toContain(longPath);

			const longId = `writer-${"x".repeat(120)}-end-92`;
			const state = createRouterState();
			const context = ctx({
				getAsyncJobSnapshot: () => ({
					running: [{ id: longId, type: "task", status: "running" }],
					recent: [],
					delivery: {},
				}),
			});
			routeSubagentSpawn({ agent: "coder", spawnKey: longId }, ctx(), state, { stateFile: file });
			const blocked = routeSubagentSpawn({ agent: "coder", spawnKey: "second-writer" }, context, state, {
				stateFile: file,
			});
			const writerAction = blocked.reason.split("\n", 1)[0];
			expect(writerAction.length).toBeLessThanOrEqual(100);
			expect(writerAction).toContain("writer-");
			expect(writerAction).toContain("end-92");
			expect(blocked.reason).toContain(longId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("incoming git-pr-owner bypasses the checkout gate while file writers stay gated", async () => {
		const { dir, file } = tempStateFile();
		try {
			const state = createRouterState();
			let running: Array<{ id: string; agentId: string; type: string; status: string }> = [];
			const context = ctx({ getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }) });
			const first = await routeSubagentSpawn(
				{ agent: "coder", spawnKey: "writer-1", isolated: false },
				context,
				state,
				{ stateFile: file },
			);
			expect(first?.block).toBeUndefined();
			running = [{ id: "writer-1", agentId: "writer-1", type: "task", status: "running" }];
			// A second file writer is still refused while the coder runs.
			const blocked = await routeSubagentSpawn(
				{ agent: "ui-coder", spawnKey: "writer-2", isolated: false },
				context,
				state,
				{ stateFile: file },
			);
			expect(blocked).toMatchObject({ block: true });
			// git-pr-owner only finalizes VCS state (commit/PR/push) after edits
			// land, so it must not deadlock on the still-running coder.
			const owner = await routeSubagentSpawn(
				{ agent: "git-pr-owner", spawnKey: "pr-1", isolated: false },
				context,
				state,
				{ stateFile: file },
			);
			expect(owner?.block).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("grievance 467: coder beside a running git-pr-owner is admitted on disjoint paths, refused on overlap", async () => {
		const { dir, file } = tempStateFile();
		try {
			const repo = join(dir, "shared-repo");
			mkdirSync(repo);
			execFileSync("git", ["init", "-q", repo]);
			const tasks = [
				{
					content: "Finalize owner work",
					status: "in_progress",
					schedule: { owner: "owner-1", resources: [`${repo}/src/owner.ts:source-writer`] },
				},
				{
					content: "Edit disjoint file",
					status: "pending",
					schedule: { owner: "coder-disjoint", resources: [`${repo}/src/coder.ts:source-writer`] },
				},
				{
					content: "Edit overlapping file",
					status: "pending",
					schedule: { owner: "coder-overlap", resources: [`${repo}/src/owner.ts:source-writer`] },
				},
			];
			let running = [];
			const context = ctx({
				sessionManager: {
					getHeader: () => ({ id: "session-1" }),
					getBranch: () => [
						{
							type: "message",
							message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } },
						},
					],
				},
				getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
			});
			const state = createRouterState();
			const spawn = (agent: string, spawnKey: string) =>
				routeSubagentSpawn({ agent, spawnKey }, context, state, {
					stateFile: file,
					latestTodo: getLatestTodoPhasesFromEntries,
				});
			expect((await spawn("git-pr-owner", "owner-1"))?.block).toBeUndefined();
			running = [{ id: "owner-1", type: "task", status: "running" }];
			expect((await spawn("coder", "coder-disjoint"))?.block).toBeUndefined();
			const overlap = await spawn("coder", "coder-overlap");
			expect(overlap?.block).toBe(true);
			expect(overlap?.reason).toContain("owner-1");
			const firstLine = overlap?.reason.split("\n", 1)[0] ?? "";
			expect(firstLine.length).toBeLessThanOrEqual(100);
			expect(firstLine).toContain("owner-1");
			expect(firstLine).toContain("git-pr-owner");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("unowned batch coders scope from spawn row title and lane path", async () => {
		const { dir, file } = tempStateFile();
		try {
			const laneA = join(dir, "lane-a");
			const laneB = join(dir, "lane-b");
			for (const repo of [laneA, laneB]) {
				mkdirSync(repo);
				execFileSync("git", ["init", "-q", repo]);
			}
			const tasks = [
				{ content: "# Row: Fix alpha lane", status: "pending", schedule: { resources: [`${laneA}`] } },
				{ content: "# Row: Fix beta lane", status: "pending", schedule: { resources: [`${laneB}`] } },
			];
			let running: Array<Record<string, string>> = [];
			const context = ctx({
				cwd: laneA,
				sessionManager: {
					getHeader: () => ({ id: "session-1" }),
					getBranch: () => [
						{
							type: "message",
							message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } },
						},
					],
				},
				getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
			});
			const state = createRouterState();
			const spawn = (spawnKey: string, assignment: string) =>
				routeSubagentSpawn({ agent: "coder", spawnKey, assignment }, context, state, {
					stateFile: file,
					latestTodo: getLatestTodoPhasesFromEntries,
				});
			const first = await spawn("batch-unowned-1", `# Row: Fix alpha lane\nLane: ${laneA}\nDo the work.`);
			expect(first?.block).toBeUndefined();
			running = [{ id: "batch-unowned-1", type: "task", status: "running" }];
			const second = await spawn("batch-unowned-2", `# Row: Fix beta lane\nLane: ${laneB}\nDo the work.`);
			expect(second?.block).toBeUndefined();
			const controlState = createRouterState();
			let controlRunning: Array<Record<string, string>> = [];
			const controlContext = ctx({
				cwd: laneA,
				sessionManager: {
					getHeader: () => ({ id: "session-1" }),
					getBranch: () => [
						{
							type: "message",
							message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } },
						},
					],
				},
				getAsyncJobSnapshot: () => ({ running: controlRunning, recent: [], delivery: {} }),
			});
			const controlFirst = await routeSubagentSpawn(
				{
					agent: "coder",
					spawnKey: "control-1",
					assignment: `# Row: Fix alpha lane\nLane: ${laneA}\nDo the work.`,
				},
				controlContext,
				controlState,
				{ stateFile: file, latestTodo: getLatestTodoPhasesFromEntries },
			);
			expect(controlFirst?.block).toBeUndefined();
			controlRunning = [{ id: "control-1", type: "task", status: "running" }];
			const controlSecond = await routeSubagentSpawn(
				{
					agent: "coder",
					spawnKey: "control-2",
					assignment: `# Row: Fix alpha lane\nLane: ${laneA}\nDo the follow-up.`,
				},
				controlContext,
				controlState,
				{ stateFile: file, latestTodo: getLatestTodoPhasesFromEntries },
			);
			expect(controlSecond?.block).toBe(true);
			expect(controlSecond?.reason).toContain("control-1");
			expect(controlSecond?.reason).toContain("coder targets");
			expect(controlSecond?.reason).toContain(laneA);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("checkout writer scopes allow disjoint repositories and refuse every active collision", async () => {
		const { dir, file } = tempStateFile();
		try {
			const native = join(dir, "native-clone");
			const tasksLoop = join(dir, "tasks-loop");
			for (const repo of [native, tasksLoop]) {
				mkdirSync(repo);
				execFileSync("git", ["init", "-q", repo]);
			}
			const alias = join(dir, "native-alias");
			symlinkSync(native, alias);
			const row = (owner: string, resources: string[]) => ({
				content: `Work for ${owner}`,
				status: "in_progress",
				schedule: { owner, resources },
			});
			const plan = [
				{
					name: "Repair",
					tasks: [
						row("native-writer", [`repo:${native}/src/native.ts:source-writer`]),
						row("tasks-writer", [`${tasksLoop}:updater-writer`]),
					],
				},
			];
			let running = [];
			const context = ctx({
				cwd: tasksLoop,
				sessionManager: {
					getHeader: () => ({ id: "session-1" }),
					getBranch: () => [
						{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } },
					],
				},
				getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
			});
			const state = createRouterState();
			const spawn = (spawnKey: string) =>
				routeSubagentSpawn({ agent: "coder", spawnKey, isolated: false }, context, state, {
					stateFile: file,
					latestTodo: getLatestTodoPhasesFromEntries,
				});
			expect((await spawn("native-writer"))?.block).toBeUndefined();
			running = [{ id: "native-writer", type: "task", status: "running" }];
			expect((await spawn("tasks-writer"))?.block).toBeUndefined();
			running.push({ id: "tasks-writer", type: "task", status: "running" });
			for (const resource of [
				native,
				`${native}/src/native.ts`,
				`checkout:${alias}/src/native.ts:source-writer`,
				`${native}/src`,
				tasksLoop,
				`path:${tasksLoop}/other.ts`,
				`repository:${tasksLoop}:source-writer`,
			]) {
				plan[0].tasks.push(row("third-writer", [resource]));
				const result = await spawn("third-writer");
				expect(result?.block).toBe(true);
				expect(result?.reason).toContain(resource.includes("tasks-loop") ? "tasks-writer" : "native-writer");
				plan[0].tasks.pop();
			}
			for (const [index, resource] of [
				`${native}/another.ts:git-owner`,
				`checkout:${alias}/src/file.ts:source-writer`,
			].entries()) {
				const spawnKey = `disjoint-writer-${index}`;
				plan[0].tasks.push(row(spawnKey, [resource]));
				expect((await spawn(spawnKey))?.block).toBeUndefined();
				plan[0].tasks.pop();
			}
			plan[0].tasks.push(row("third-writer", [native, tasksLoop]));
			expect((await spawn("third-writer"))?.block).toBe(true);
			expect(
				readJsonl(file)
					.filter(record => record.kind === "spawn")
					.map(record => record.checkoutScopes),
			).toEqual([
				[`${native}\0src/native.ts`],
				[`${tasksLoop}\0.`],
				[`${native}\0another.ts`],
				[`${native}\0src/file.ts`],
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("checkout writer scopes stay frozen when the canonical plan changes", async () => {
		const { dir, file } = tempStateFile();
		try {
			const original = join(dir, "original");
			const changed = join(dir, "changed");
			for (const repo of [original, changed]) {
				mkdirSync(repo);
				execFileSync("git", ["init", "-q", repo]);
			}
			const tasks = [
				{ content: "Original", status: "in_progress", schedule: { owner: "writer-1", resources: [original] } },
			];
			let running = [];
			const context = ctx({
				sessionManager: {
					getHeader: () => ({ id: "session-1" }),
					getBranch: () => [
						{
							type: "message",
							message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } },
						},
					],
				},
				getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
			});
			const state = createRouterState();
			const spawn = (spawnKey: string, latestTodo = getLatestTodoPhasesFromEntries) =>
				routeSubagentSpawn({ agent: "coder", spawnKey }, context, state, { stateFile: file, latestTodo });
			expect((await spawn("writer-1"))?.block).toBeUndefined();
			running = [{ id: "writer-1", type: "task", status: "running" }];
			tasks[0].schedule.resources = [changed];
			tasks.push({ content: "Next", status: "pending", schedule: { owner: "writer-2", resources: [original] } });
			expect((await spawn("writer-2"))?.block).toBe(true);
			tasks[1].schedule.resources = [changed];
			expect((await spawn("writer-2"))?.block).toBeUndefined();
			expect([...state.spawns.values()][0].checkoutScopes).toEqual([`${original}\0.`]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("checkout writer scopes require exact canonical ownership and keep unknown active writers conservative", async () => {
		const { dir, file } = tempStateFile();
		try {
			const original = join(dir, "original");
			const other = join(dir, "other");
			for (const repo of [original, other]) {
				mkdirSync(repo);
				execFileSync("git", ["init", "-q", repo]);
			}
			const tasks = [
				{ content: "Original", status: "in_progress", schedule: { owner: "writer-1", resources: [original] } },
			];
			let running = [];
			const context = ctx({
				sessionManager: {
					getHeader: () => ({ id: "session-1" }),
					getBranch: () => [
						{
							type: "message",
							message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } },
						},
					],
				},
				getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
			});
			const state = createRouterState();
			const spawn = (spawnKey: string, latestTodo = getLatestTodoPhasesFromEntries) =>
				routeSubagentSpawn({ agent: "coder", spawnKey }, context, state, { stateFile: file, latestTodo });
			await spawn("writer-1");
			running = [{ id: "writer-1", type: "task", status: "running" }];
			symlinkSync(join(dir, "missing-target"), join(other, "broken-alias"));
			for (const [owner, resources] of [
				["writer-2-2", [other]],
				["writer-2", []],
				["writer-2", ["other:source-writer"]],
				["writer-2", [other, "ambiguous"]],
				["writer-2", [join(other, "broken-alias", "file.ts")]],
			]) {
				tasks.push({ content: `Write to ${other}`, status: "pending", schedule: { owner, resources } });
				expect((await spawn("writer-2"))?.block).toBe(true);
				tasks.pop();
			}
			tasks.push({
				content: "Write outside any repo",
				status: "pending",
				schedule: { owner: "writer-2", resources: [join(dir, "not-a-repo")] },
			});
			expect((await spawn("writer-2"))?.block).toBeUndefined();
			tasks.pop();
			tasks.push({ content: "Known", status: "pending", schedule: { owner: "writer-2", resources: [other] } });
			expect(
				(
					await spawn("writer-2", () => {
						throw new Error("unavailable");
					})
				)?.block,
			).toBe(true);
			expect(
				(await routeSubagentSpawn({ agent: "coder", spawnKey: "writer-2" }, context, state, { stateFile: file }))
					?.block,
			).toBe(true);
			const unknownState = createRouterState();
			running = [];
			await routeSubagentSpawn({ agent: "coder", spawnKey: "writer-1" }, context, unknownState, { stateFile: file });
			running = [{ id: "writer-1", type: "task", status: "running" }];
			expect(
				(
					await routeSubagentSpawn({ agent: "coder", spawnKey: "writer-2" }, context, unknownState, {
						stateFile: file,
						latestTodo: getLatestTodoPhasesFromEntries,
					})
				)?.block,
			).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("checkout writer scopes use the host latest TODO getter and current branch", async () => {
		const { dir, file } = tempStateFile();
		const previousStateFile = process.env.OMP_AGENT_ROUTER_STATE;
		try {
			process.env.OMP_AGENT_ROUTER_STATE = file;
			const repositories = [join(dir, "native"), join(dir, "tasks-loop")];
			for (const repo of repositories) {
				mkdirSync(repo);
				execFileSync("git", ["init", "-q", repo]);
			}
			const branch = [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "todo",
						details: {
							phases: [
								{
									name: "Work",
									tasks: repositories.map((repo, index) => ({
										content: `Work ${index}`,
										status: "in_progress",
										schedule: { owner: `writer-${index}`, resources: [repo] },
									})),
								},
							],
						},
					},
				},
				{ type: "message", message: { role: "assistant", content: "Unrelated history" } },
			];
			let reads = 0;
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
			const api = {
				setLabel: () => undefined,
				pi: {
					getLatestTodoPhasesFromEntries: (entries: unknown[]) => {
						expect(entries).toEqual([branch[0]]);
						reads += 1;
						return getLatestTodoPhasesFromEntries(entries);
					},
				},
				on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
					handlers.set(event, handler),
			} as unknown as ExtensionAPI;
			agentRouter(api);
			let running = [];
			const context = ctx({
				sessionManager: { getHeader: () => ({ id: "session-1" }), getBranch: () => branch },
				getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
			});
			expect(
				await handlers.get("before_subagent_spawn")!({ agent: "coder", spawnKey: "writer-0" }, context),
			).toBeUndefined();
			running = [{ id: "writer-0", type: "task", status: "running" }];
			expect(
				await handlers.get("before_subagent_spawn")!({ agent: "workhorse", spawnKey: "writer-1" }, context),
			).toBeUndefined();
			expect(reads).toBe(2);
		} finally {
			if (previousStateFile === undefined) delete process.env.OMP_AGENT_ROUTER_STATE;
			else process.env.OMP_AGENT_ROUTER_STATE = previousStateFile;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("leaves unknown agents untouched", async () => {
		const { dir, file } = tempStateFile();
		try {
			const result = await routeSubagentSpawn(
				{ agent: "nonexistent", spawnKey: "unknown-1" },
				ctx(),
				createRouterState(),
				{ stateFile: file },
			);
			expect(result).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("capacity counts unique authenticated model routes", async () => {
		const model = { provider: "codex-lb", id: "gpt-6-luna" };
		expect(await countLiveWorkerModels(ctx({ models: { list: () => [], resolve: () => undefined } }))).toBe(0);
		expect(await countLiveWorkerModels(ctx({ models: { list: () => [model, model], resolve: () => model } }))).toBe(
			1,
		);
		expect(await countLiveWorkerModels(ctx())).toBe(MODEL_SPECS.length);
	});

	test("records exact settled wait job outcome once", async () => {
		const { dir, file } = tempStateFile();
		try {
			const state = createRouterState();
			const context = ctx();
			await routeSubagentSpawn({ agent: "coder", spawnKey: "CoderResult" }, context, state, { stateFile: file });
			const waitEvent = {
				toolName: "wait",
				details: {
					jobs: [
						{ id: "CoderResult", type: "task", status: "running", durationMs: 100 },
						{
							id: "CoderResult",
							type: "task",
							status: "completed",
							durationMs: 500,
							resolvedModel: "kimi-code/k3:high",
						},
					],
				},
			};
			const rows = await recordTaskOutcome(waitEvent, context, state, { stateFile: file });
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("completed");
			expect(rows[0]?.resolvedModel).toBe("kimi-code/k3:high");
			expect(await recordTaskOutcome(waitEvent, context, state, { stateFile: file })).toEqual([]);
			expect(readJsonl(file)).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("records a correlated task outcome with job id and resolved model when observable", async () => {
		const { dir, file } = tempStateFile();
		try {
			const state = createRouterState();
			const context = ctx();
			routeSubagentSpawn({ agent: "coder", spawnKey: "spawn-1", patterns: CODER_CHAIN }, context, state, {
				stateFile: file,
				now: () => new Date("2026-09-24T18:00:00.000Z"),
			});
			const rows = await recordTaskOutcome(
				{
					toolName: "task",
					toolCallId: "call-1",
					isError: false,
					details: {
						async: { state: "completed", jobId: "task-coder", type: "task" },
						results: [
							{
								agent: "coder",
								exitCode: 0,
								durationMs: 1234,
								resolvedModel: "deepseek/deepseek-v4-pro:high",
							},
						],
					},
				},
				context,
				state,
				{ stateFile: file, now: () => new Date("2026-09-24T18:00:02.000Z") },
			);
			expect(rows).toEqual([
				{
					kind: "outcome",
					spawnKey: "spawn-1",
					jobId: "task-coder",
					at: "2026-09-24T18:00:02.000Z",
					sessionId: "session-1",
					agent: "coder",
					chosen: CODER_CHAIN[0],
					order: CODER_CHAIN,
					status: "completed",
					durationMs: 1234,
					resolvedModel: "deepseek/deepseek-v4-pro:high",
					fallbackReason: "unrecorded",
				},
			]);
			expect(readJsonl(file)).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("records core fallback reason when resolved model differs from the router pick", async () => {
		const { dir, file } = tempStateFile();
		try {
			const state = createRouterState();
			const context = ctx();
			const first = "kimi-code/kimi-for-coding-highspeed:low";
			routeSubagentSpawn(
				{ agent: "scout", spawnKey: "fallback-1", patterns: [first, "deepseek/deepseek-v4-flash:low"] },
				context,
				state,
				{
					stateFile: file,
				},
			);
			recordRetryFallbackApplied(
				{
					from: first,
					to: "deepseek/deepseek-v4-flash:low",
					role: "fallback",
					reason: "Usage preflight: available quota is at or below the 10% reserve.",
				},
				state,
				{ now: () => new Date("2026-09-24T18:00:01.000Z") },
			);
			const rows = await recordTaskOutcome(
				{
					toolName: "task",
					isError: false,
					details: {
						results: [
							{
								agent: "scout",
								exitCode: 0,
								durationMs: 123,
								resolvedModel: "deepseek/deepseek-v4-flash:low",
							},
						],
					},
				},
				context,
				state,
				{ stateFile: file, now: () => new Date("2026-09-24T18:00:02.000Z") },
			);
			expect(rows[0]?.fallbackReason).toBe("Usage preflight: available quota is at or below the 10% reserve.");
			expect(readJsonl(file)[1]?.fallbackReason).toBe(
				"Usage preflight: available quota is at or below the 10% reserve.",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("does not invent an outcome when two pending spawns share the same agent and no exact key is visible", async () => {
		const { dir, file } = tempStateFile();
		try {
			const state = createRouterState();
			const context = ctx();
			await routeSubagentSpawn({ agent: "coder", spawnKey: "spawn-1" }, context, state, { stateFile: file });
			await routeSubagentSpawn({ agent: "coder", spawnKey: "spawn-2" }, context, state, { stateFile: file });
			const rows = await recordTaskOutcome(
				{
					toolName: "task",
					isError: false,
					details: { results: [{ agent: "coder", exitCode: 0, durationMs: 10 }] },
				},
				context,
				state,
				{ stateFile: file },
			);
			expect(rows).toEqual([]);
			expect(readJsonl(file)).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("extension registers spawn, fallback and result handlers", () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = {
			setLabel: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		agentRouter(api);
		expect(handlers.has("before_subagent_spawn")).toBe(true);
		expect(handlers.has("retry_fallback_applied")).toBe(true);
		expect(handlers.has("tool_result")).toBe(true);
	});

	test("announces file guard at session start and active writer once after async spawn", async () => {
		const { dir, file } = tempStateFile();
		const previousStatePath = process.env.OMP_AGENT_ROUTER_STATE;
		const handlers = new Map<string, Function>();
		const messages: Array<{ customType: string; content: string }> = [];
		let running = false;
		process.env.OMP_AGENT_ROUTER_STATE = file;
		try {
			execFileSync("git", ["init", "-q", dir]);
			const api = {
				setLabel: () => undefined,
				on: (event: string, handler: Function) => handlers.set(event, handler),
				sendMessage: (message: { customType: string; content: string }) => messages.push(message),
			} as unknown as ExtensionAPI;
			agentRouter(api);
			const context = ctx({
				cwd: dir,
				getAsyncJobSnapshot: () => ({
					running: running ? [{ id: "WriterR92", type: "task", status: "running" }] : [],
					recent: [],
					delivery: {},
				}),
			});
			handlers.get("session_start")!({}, context);
			handlers.get("session_start")!({}, context);
			expect(messages).toHaveLength(1);
			expect(messages[0]?.content).toContain(dir);
			expect(messages[0]?.content).toContain("replace: true");
			const writeGate = await handlers.get("tool_call")!(
				{ toolName: "write", input: { path: "draft.txt", content: "" } },
				context,
			);
			expect(writeGate?.block).toBe(true);
			expect(messages[0]?.content).toContain("empty or tiny tracked-file writes require replace: true");

			handlers.get("before_subagent_spawn")!({ agent: "coder", spawnKey: "WriterR92", patterns: [] }, context);
			const started = {
				toolName: "task",
				isError: false,
				details: {
					async: { state: "running", jobId: "job-r92" },
					progress: [{ id: "WriterR92", agent: "coder", status: "running" }],
				},
			};
			running = true;
			handlers.get("tool_result")!(started, context);
			handlers.get("tool_result")!(started, context);
			expect(messages).toHaveLength(2);
			expect(messages[1]?.content).toContain("WriterR92");
			expect(messages[1]?.content).toContain("No overlapping writer");
			expect(messages[1]?.content.split("\n")).toHaveLength(2);
			const gate = handlers.get("before_subagent_spawn")!(
				{ agent: "coder", spawnKey: "WriterR93", patterns: [] },
				context,
			);
			expect(gate?.block).toBe(true);
			expect(messages[1]?.content).toContain("until it settles");
		} finally {
			if (previousStatePath === undefined) delete process.env.OMP_AGENT_ROUTER_STATE;
			else process.env.OMP_AGENT_ROUTER_STATE = previousStatePath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("extension follows a late core fallback with the actual routed model in UI", () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const notifications: Array<{ message: string; type?: string }> = [];
		const api = {
			setLabel: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		agentRouter(api);
		handlers.get("retry_fallback_applied")?.(
			{
				from: "kimi-code/kimi-for-coding-highspeed:low",
				to: "deepseek/deepseek-v4-flash:low",
				role: "fallback",
				reason: "Usage preflight: available quota is at or below the 10% reserve.",
			},
			ctx({
				ui: {
					notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
				},
			} as Partial<ExtensionContext>),
		);
		expect(notifications).toEqual([
			{
				message:
					"routed: actual model deepseek/deepseek-v4-flash:low (fallback from kimi-code/kimi-for-coding-highspeed:low; Usage preflight: available quota is at or below the 10% reserve.)",
				type: "warning",
			},
		]);
	});
	test("refuses empty writes unless the call explicitly confirms replacement", async () => {
		const { dir } = tempStateFile();
		try {
			const call = toolCallHandler();
			const context = ctx({ cwd: dir });
			const refused = await call({ toolName: "write", input: { path: "empty.txt", content: "" } }, context);
			expect(refused).toMatchObject({ block: true });
			expect(refused.reason).toContain("empty.txt");
			expect(refused.reason).toContain("empty");
			const action = refused.reason.split("\n", 1)[0] ?? "";
			expect(action).toBe("Pass replace: true for empty.txt.");
			expect(action.length).toBeLessThanOrEqual(100);
			expect(
				await call({ toolName: "write", input: { path: "empty.txt", content: "", replace: true } }, context),
			).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("refuses tiny writes to tracked files but allows normal in-repository writes", async () => {
		const { dir } = tempStateFile();
		try {
			execFileSync("git", ["init", "-q"], { cwd: dir });
			writeFileSync(join(dir, "tracked.txt"), "x".repeat(1_000));
			execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
			const call = toolCallHandler();
			const context = ctx({ cwd: dir });
			const refused = await call({ toolName: "write", input: { path: "tracked.txt", content: "tiny" } }, context);
			expect(refused).toMatchObject({ block: true });
			expect(refused.reason).toContain("tracked.txt");
			expect(refused.reason).toContain("5%");
			const action = refused.reason.split("\n", 1)[0] ?? "";
			expect(action).toBe("Pass replace: true to shrink tracked.txt.");
			expect(action.length).toBeLessThanOrEqual(100);
			expect(
				await call({ toolName: "write", input: { path: "tracked.txt", content: "tiny", replace: true } }, context),
			).toBeUndefined();
			expect(
				await call({ toolName: "write", input: { path: "new.txt", content: "normal in-repo write" } }, context),
			).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writes and edits outside the session repository pass: sessions work on other repositories from tasks-loop", async () => {
		const { dir } = tempStateFile();
		try {
			const call = toolCallHandler();
			const context = ctx({ cwd: dir, model: { id: "gpt-6-luna", provider: "test" } as ExtensionContext["model"] });
			const outside = join(dir, "..", "outside-file.txt");
			for (const toolName of ["write", "edit"]) {
				expect(await call({ toolName, input: { path: outside, content: "content" } }, context)).toBeUndefined();
			}
			const empty = await call({ toolName: "write", input: { path: outside, content: "" } }, context);
			expect(empty).toMatchObject({ block: true });
			expect(empty.reason).toContain("empty");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unknown-scope holder only blocks writers in the session-cwd repo", async () => {
		const { dir, file } = tempStateFile();
		try {
			const repoA = join(dir, "repo-a");
			const repoB = join(dir, "repo-b");
			for (const repo of [repoA, repoB]) {
				mkdirSync(repo);
				execFileSync("git", ["init", "-q", repo]);
			}
			const tasks = [
				{
					content: "Holder with no resource paths",
					status: "in_progress",
					schedule: { owner: "holder-1", resources: [] },
				},
			];
			let running: Array<{ id: string; type: string; status: string }> = [];
			const context = ctx({
				cwd: repoA,
				sessionManager: {
					getHeader: () => ({ id: "session-1" }),
					getBranch: () => [
						{
							type: "message",
							message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } },
						},
					],
				},
				getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
			});
			const state = createRouterState();
			const spawn = (spawnKey: string) =>
				routeSubagentSpawn({ agent: "coder", spawnKey, isolated: false }, context, state, {
					stateFile: file,
					latestTodo: getLatestTodoPhasesFromEntries,
				});
			expect((await spawn("holder-1"))?.block).toBeUndefined();
			running = [{ id: "holder-1", type: "task", status: "running" }];
			tasks.push({
				content: "Other repo work",
				status: "pending",
				schedule: { owner: "other-1", resources: [`${repoB}/src/other.ts:source-writer`] },
			});
			expect((await spawn("other-1"))?.block).toBeUndefined();
			tasks.pop();
			tasks.push({
				content: "Outside any repo",
				status: "pending",
				schedule: { owner: "tmp-1", resources: [join(dir, "scratch", "newfile.ts")] },
			});
			expect((await spawn("tmp-1"))?.block).toBeUndefined();
			tasks.pop();
			tasks.push({
				content: "Same repo work",
				status: "pending",
				schedule: { owner: "same-1", resources: [`${repoA}/src/same.ts:source-writer`] },
			});
			expect((await spawn("same-1"))?.block).toBe(true);
			tasks.pop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writer refusal names the holder repo and points at row resources", async () => {
		const { dir, file } = tempStateFile();
		try {
			const repoA = join(dir, "repo-a");
			mkdirSync(repoA);
			execFileSync("git", ["init", "-q", repoA]);
			const tasks = [
				{
					content: "Holder with no resource paths",
					status: "in_progress",
					schedule: { owner: "holder-1", resources: [] },
				},
				{
					content: "Same repo work",
					status: "pending",
					schedule: { owner: "same-1", resources: [`${repoA}/src/same.ts:source-writer`] },
				},
			];
			let running: Array<{ id: string; type: string; status: string }> = [];
			const context = ctx({
				cwd: repoA,
				sessionManager: {
					getHeader: () => ({ id: "session-1" }),
					getBranch: () => [
						{
							type: "message",
							message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } },
						},
					],
				},
				getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
			});
			const state = createRouterState();
			const spawn = (spawnKey: string) =>
				routeSubagentSpawn({ agent: "coder", spawnKey, isolated: false }, context, state, {
					stateFile: file,
					latestTodo: getLatestTodoPhasesFromEntries,
				});
			expect((await spawn("holder-1"))?.block).toBeUndefined();
			running = [{ id: "holder-1", type: "task", status: "running" }];
			const refused = await spawn("same-1");
			expect(refused).toMatchObject({ block: true });
			expect(refused?.reason).toContain("holder-1");
			expect(refused?.reason).toContain(repoA);
			expect(refused?.reason).toContain("Put the other repo path in this row's resources");
			expect(refused?.reason).toContain(`isolated: true isolates only ${repoA}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("a failed async-result delivery with no wait is recorded once", async () => {
	const { dir, file } = tempStateFile();
	try {
		const t0 = new Date("2026-10-21T06:52:40.000Z");
		const state = createRouterState();
		const context = ctx();
		const opts = { stateFile: file, now: () => t0 };
		routeSubagentSpawn(
			{ agent: "qa-auditor", spawnKey: "AuditR22ScmBody", isolated: true, patterns: ["codex-lb/gpt-6-luna:high"] },
			context,
			state,
			opts,
		);
		const message = {
			role: "custom",
			customType: "async-result",
			content: `<system-notice>\n<task-result id="AuditR22ScmBody" agent="qa-auditor" status="failed (exit 1)" duration="457ms">\n<output>\nboom\n</output>\n</task-result>\n</system-notice>`,
			details: { jobs: [{ jobId: "AuditR22ScmBody", status: "failed", durationMs: 457 }] },
		};
		const rows = await recordAsyncResultOutcome(message, context, state, opts);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ spawnKey: "AuditR22ScmBody", status: "failed", durationMs: 457 });
		expect(readJsonl(file).filter(row => row.kind === "outcome")).toHaveLength(1);
		// Delivered twice: no duplicate row.
		expect(await recordAsyncResultOutcome(message, context, state, opts)).toHaveLength(0);
		// Negative control: a different message type records nothing.
		expect(await recordAsyncResultOutcome({ ...message, customType: "other" }, context, state, opts)).toHaveLength(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("/brrrr session preset", () => {
	function brrrrHandler(extra: Record<string, unknown>) {
		let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		agentRouter({
			setLabel: () => undefined,
			on: () => undefined,
			registerCommand: (name: string, command: { handler: typeof handler }) => {
				if (name === "brrrr") handler = command.handler;
			},
			...extra,
		} as unknown as ExtensionAPI);
		const notes: string[] = [];
		const context = { ui: { notify: (message: string) => notes.push(message) } } as unknown as ExtensionContext;
		return { run: (args: string) => handler!(args, context), notes };
	}

	test("applies the brrrr preset and clears it on off", async () => {
		const applied: string[] = [];
		const { run, notes } = brrrrHandler({
			applySessionModelPreset: async (name: string) => (applied.push(name), { kind: "switched" }),
			clearSessionModelPreset: () => "brrrr",
		});
		await run("");
		expect(applied).toEqual(["brrrr"]);
		expect(notes.at(-1)).toBe("brrrr on");
		await run("off");
		expect(notes.at(-1)).toContain("brrrr off");
	});

	test.each([
		{ kind: "unavailable", reason: "default model `anthropic/claude-opus-5-5` is not available" },
		{ kind: "unavailable", reason: "no credentials for anthropic/claude-opus-5-5" },
		{ kind: "invalid", reason: "preset default role must be a model selector" },
		{ kind: "failed", reason: "model switch rejected", shadowed: [] },
	])("reports the canonical $kind reason through the registered command", async result => {
		const { run, notes } = brrrrHandler({
			applySessionModelPreset: async () => result,
			clearSessionModelPreset: () => undefined,
		});
		await run("");
		expect(notes).toEqual([`brrrr: preset not applied (${result.kind}: ${result.reason})`]);
	});

	test("reports a missing preset and an unsupported build without acting", async () => {
		const missing = brrrrHandler({
			applySessionModelPreset: async () => ({ kind: "missing" }),
			clearSessionModelPreset: () => undefined,
		});
		await missing.run("");
		expect(missing.notes.at(-1)).toContain("not applied (missing");
		const old = brrrrHandler({});
		await old.run("");
		expect(old.notes.at(-1)).toContain("unavailable in this build");
	});
});
