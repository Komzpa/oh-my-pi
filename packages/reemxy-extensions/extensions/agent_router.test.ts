// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { describe, expect, test } from "bun:test";
	import { execFileSync } from "node:child_process";
	import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
	import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import agentRouter, {
	AGENT_POOLS,
	agentHasLiveModel,
	countLiveWorkerModels,
	createRouterState,
	recordRetryFallbackApplied,
	recordTaskOutcome,
	routeSubagentSpawn,
	type BeforeSubagentSpawnEvent,
	type ToolResultEvent,
} from "./agent_router";

function ctx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	const models = Object.values(AGENT_POOLS).flatMap(config => [...config.pool, ...config.fallbacks]).map(spec => {
		const base = spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "");
		const slash = base.indexOf("/");
		return { provider: base.slice(0, slash), id: base.slice(slash + 1) };
	});
	return {
		sessionManager: { getHeader: () => ({ id: "session-1" }) },
		models: {
			list: () => models,
			resolve: (spec: string) => models.find(model => `${model.provider}/${model.id}` === spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "")),
		},
		...overrides,
	} as unknown as ExtensionContext;
}

function ctxWithHealth(healthByKey: Record<string, { state: string; accounts: Array<Record<string, unknown>> }>): ExtensionContext {
	const base = ctx();
	return {
		...base,
		modelRegistry: {
			authStorage: {
				health: {
					model: async (provider: string, options: { modelId?: string }) =>
						healthByKey[`${provider}/${options.modelId}`] ?? healthByKey[provider] ?? { state: "unknown", accounts: [] },
				},
			},
		},
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

const THINKING_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_ORDER)[number];

const LATENCY_SENSITIVE_AGENT_LEVELS = {
	scout: "low",
	"gate-runner": "medium",
	"git-pr-owner": "medium",
	scribe: "low",
} as const satisfies Partial<Record<keyof typeof AGENT_POOLS, ThinkingLevel>>;

const MODEL_FLOORS: Record<string, ThinkingLevel> = {
	"deepseek/deepseek-v4-flash": "high",
	"openrouter/xiaomi/mimo-v2.6-flash": "high",
};

function modelSelectorBase(spec: string): string {
	const separator = spec.lastIndexOf(":");
	if (separator <= spec.indexOf("/")) return spec;
	return spec.slice(0, separator);
}

function modelLevel(spec: string): ThinkingLevel | undefined {
	const separator = spec.lastIndexOf(":");
	if (separator <= spec.indexOf("/")) return undefined;
	const level = spec.slice(separator + 1);
	return THINKING_ORDER.includes(level as ThinkingLevel) ? level as ThinkingLevel : undefined;
}

function levelIndex(level: ThinkingLevel): number {
	return THINKING_ORDER.indexOf(level);
}

function effectiveFloor(spec: string): ThinkingLevel | undefined {
	return MODEL_FLOORS[modelSelectorBase(spec)];
}

function canRunAtOrBelow(spec: string, intended: ThinkingLevel): boolean {
	const requested = modelLevel(spec);
	const floor = effectiveFloor(spec);
	const effective = floor && requested && levelIndex(requested) < levelIndex(floor) ? floor : requested ?? floor;
	return effective === undefined || levelIndex(effective) <= levelIndex(intended);
}


describe("agent router", () => {
	test("uniform crypto shuffle can cover every coder pool member as the chosen model", async () => {
		const seen = new Set<string>();
		const { dir, file } = tempStateFile();
		try {
			for (let i = 0; i < 600 && seen.size < AGENT_POOLS.coder.pool.length; i++) {
				const state = createRouterState();
				const result = await routeSubagentSpawn({ agent: "coder", spawnKey: `coder-${i}` }, ctx(), state, { stateFile: file });
				expect(result).toBeDefined();
				seen.add(result!.model[0]!);
			}
			expect(seen).toEqual(new Set(AGENT_POOLS.coder.pool));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("places the pool pick first, keeps remaining pool members shuffled, then appends fixed fallbacks", async () => {
		const { dir, file } = tempStateFile();
		try {
			const reversed = <T>(items: readonly T[]) => [...items].reverse();
			const result = await routeSubagentSpawn({ agent: "ui-coder", spawnKey: "ui-1" }, ctx(), createRouterState(), {
				stateFile: file,
				shuffle: reversed,
			});
			expect(result?.model).toEqual([...AGENT_POOLS["ui-coder"].pool].reverse().concat(AGENT_POOLS["ui-coder"].fallbacks));
			expect(result?.model).toContain("claude-bridge/claude-sonnet-5");
			expect(result?.model).not.toContain("anthropic/claude-sonnet-5:medium");
			expect(result?.note).toBe(`pool pick ${result?.model[0]} (eval)`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writes spawn JSONL with requested stats fields", async () => {
		const { dir, file } = tempStateFile();
		try {
			const now = () => new Date("2026-09-24T18:00:00.000Z");
			await routeSubagentSpawn({ agent: "workhorse", spawnKey: "work-1" }, ctx(), createRouterState(), {
				stateFile: file,
				now,
				shuffle: items => [...items],
			});
			expect(readJsonl(file)).toEqual([
				{
					kind: "spawn",
					spawnKey: "work-1",
					at: "2026-09-24T18:00:00.000Z",
					sessionId: "session-1",
					agent: "workhorse",
					chosen: AGENT_POOLS.workhorse.pool[0],
					order: [...AGENT_POOLS.workhorse.pool, ...AGENT_POOLS.workhorse.fallbacks],
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
			expect(first?.model).toBeDefined();

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
			recordTaskOutcome(
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
			expect(afterCompletion?.model).toBeDefined();
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
			const row = (owner: string, resources: string[]) => ({ content: `Work for ${owner}`, status: "in_progress", schedule: { owner, resources } });
			let plan = [{ name: "Repair", tasks: [row("native-writer", [`repo:${native}/src/native.ts:source-writer`]), row("tasks-writer", [`${tasksLoop}:updater-writer`])] }];
			let running = [];
			const context = ctx({ cwd: tasksLoop, sessionManager: { getHeader: () => ({ id: "session-1" }), getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: plan } } }] }, getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }) });
			const state = createRouterState();
			const spawn = (spawnKey: string) => routeSubagentSpawn({ agent: "coder", spawnKey, isolated: false }, context, state, { stateFile: file, latestTodo: getLatestTodoPhasesFromEntries });
			expect((await spawn("native-writer"))?.model).toBeDefined();
			running = [{ id: "native-writer", type: "task", status: "running" }];
			expect((await spawn("tasks-writer"))?.model).toBeDefined();
			running.push({ id: "tasks-writer", type: "task", status: "running" });
			for (const resource of [native, `${native}/another.ts:git-owner`, `checkout:${alias}/src/file.ts:source-writer`, tasksLoop, `path:${tasksLoop}/other.ts`, `repository:${tasksLoop}:source-writer`]) {
				plan[0].tasks.push(row("third-writer", [resource]));
				const result = await spawn("third-writer");
				expect(result?.block).toBe(true);
				expect(result?.reason).toContain(resource.includes("tasks-loop") ? "tasks-writer" : "native-writer");
				plan[0].tasks.pop();
			}
			plan[0].tasks.push(row("third-writer", [native, tasksLoop]));
			expect((await spawn("third-writer"))?.block).toBe(true);
			expect(readJsonl(file).filter(record => record.kind === "spawn").map(record => record.checkoutScopes)).toEqual([[native], [tasksLoop]]);
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
			const tasks = [{ content: "Original", status: "in_progress", schedule: { owner: "writer-1", resources: [original] } }];
			let running = [];
			const context = ctx({ sessionManager: { getHeader: () => ({ id: "session-1" }), getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } } }] }, getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }) });
			const state = createRouterState();
			const spawn = (spawnKey: string, latestTodo = getLatestTodoPhasesFromEntries) => routeSubagentSpawn({ agent: "coder", spawnKey }, context, state, { stateFile: file, latestTodo });
			expect((await spawn("writer-1"))?.model).toBeDefined();
			running = [{ id: "writer-1", type: "task", status: "running" }];
			tasks[0].schedule.resources = [changed];
			tasks.push({ content: "Next", status: "pending", schedule: { owner: "writer-2", resources: [original] } });
			expect((await spawn("writer-2"))?.block).toBe(true);
			tasks[1].schedule.resources = [changed];
			expect((await spawn("writer-2"))?.model).toBeDefined();
			expect([...state.spawns.values()][0].checkoutScopes).toEqual([original]);
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
			const tasks = [{ content: "Original", status: "in_progress", schedule: { owner: "writer-1", resources: [original] } }];
			let running = [];
			const context = ctx({ sessionManager: { getHeader: () => ({ id: "session-1" }), getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks }] } } }] }, getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }) });
			const state = createRouterState();
			const spawn = (spawnKey: string, latestTodo = getLatestTodoPhasesFromEntries) => routeSubagentSpawn({ agent: "coder", spawnKey }, context, state, { stateFile: file, latestTodo });
			await spawn("writer-1");
			running = [{ id: "writer-1", type: "task", status: "running" }];
			symlinkSync(join(dir, "missing-target"), join(other, "broken-alias"));
			for (const [owner, resources] of [["writer-2-2", [other]], ["writer-2", []], ["writer-2", ["other:source-writer"]], ["writer-2", [other, "ambiguous"]], ["writer-2", [join(dir, "not-a-repo")]], ["writer-2", [join(other, "broken-alias", "file.ts")]]]) {
				tasks.push({ content: `Write to ${other}`, status: "pending", schedule: { owner, resources } });
				expect((await spawn("writer-2"))?.block).toBe(true);
				tasks.pop();
			}
			tasks.push({ content: "Known", status: "pending", schedule: { owner: "writer-2", resources: [other] } });
			expect((await spawn("writer-2", () => { throw new Error("unavailable"); }))?.block).toBe(true);
			expect((await routeSubagentSpawn({ agent: "coder", spawnKey: "writer-2" }, context, state, { stateFile: file }))?.block).toBe(true);
			const unknownState = createRouterState();
			running = [];
			await routeSubagentSpawn({ agent: "coder", spawnKey: "writer-1" }, context, unknownState, { stateFile: file });
			running = [{ id: "writer-1", type: "task", status: "running" }];
			expect((await routeSubagentSpawn({ agent: "coder", spawnKey: "writer-2" }, context, unknownState, { stateFile: file, latestTodo: getLatestTodoPhasesFromEntries }))?.block).toBe(true);
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
			const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Work", tasks: repositories.map((repo, index) => ({ content: `Work ${index}`, status: "in_progress", schedule: { owner: `writer-${index}`, resources: [repo] } })) }] } } }];
			let reads = 0;
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
			const api = {
				setLabel: () => undefined,
				pi: { getLatestTodoPhasesFromEntries: (entries: unknown[]) => {
					expect(entries).toBe(branch);
					reads += 1;
					return getLatestTodoPhasesFromEntries(entries);
				} },
				on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
			} as unknown as ExtensionAPI;
			agentRouter(api);
			let running = [];
			const context = ctx({ sessionManager: { getHeader: () => ({ id: "session-1" }), getBranch: () => branch }, getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }) });
			expect((await handlers.get("before_subagent_spawn")!({ agent: "coder", spawnKey: "writer-0" }, context))?.model).toBeDefined();
			running = [{ id: "writer-0", type: "task", status: "running" }];
			expect((await handlers.get("before_subagent_spawn")!({ agent: "workhorse", spawnKey: "writer-1" }, context))?.model).toBeDefined();
			expect(reads).toBe(2);
		} finally {
			if (previousStateFile === undefined) delete process.env.OMP_AGENT_ROUTER_STATE;
			else process.env.OMP_AGENT_ROUTER_STATE = previousStateFile;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("high-volume execution agents retain Kimi in their pools", () => {
		for (const agent of ["task", "scout", "gate-runner", "git-pr-owner", "scribe", "coder", "workhorse"]) {
			expect(AGENT_POOLS[agent]?.pool.some(spec => spec.startsWith("kimi-code/"))).toBe(true);
		}
	});

	test("latency-sensitive roles never first-pick a model above their intended thinking level", () => {
		for (const [agent, intendedLevel] of Object.entries(LATENCY_SENSITIVE_AGENT_LEVELS)) {
			const config = AGENT_POOLS[agent];
			expect(config).toBeDefined();
			for (const spec of config!.pool) {
				expect(canRunAtOrBelow(spec, intendedLevel)).toBe(true);
			}
		}

		expect(canRunAtOrBelow("deepseek/deepseek-v4-flash:low", "low")).toBe(false);
		expect(canRunAtOrBelow("deepseek/deepseek-v4-flash:high", "low")).toBe(false);
		expect(canRunAtOrBelow("codex-lb/gpt-6-luna:low", "low")).toBe(true);
	});

	test("all executing profiles set a bounded-work stop and receipt contract", () => {
		const executingProfiles = readdirSync(new URL("./agents/", import.meta.url))
			.filter(file => file.endsWith(".md"))
			.map(file => file.slice(0, -3));
		for (const agent of executingProfiles) {
			const content = readFileSync(new URL(`./agents/${agent}.md`, import.meta.url), "utf8");
			const instructions = content.replace(/^---\n[\s\S]*?\n---\n/, "").toLowerCase();
			const boundedWindow = /(?:~|about|approximately|roughly|around|up to|within)\s*15\s*(?:minutes?|mins?)\b/.test(
				instructions,
			);
			const stopForOversizedWork =
				/(?:larger|oversized|bigger|exceeds?|over budget|too large|too big|will not fit|won't fit)[\s\S]{0,180}(?:stop|pause|return|split|boundar|checkable)|(?:stop|pause|return|split|boundar|checkable)[\s\S]{0,180}(?:larger|oversized|bigger|exceeds?|over budget|too large|too big|will not fit|won't fit)/.test(
					instructions,
				);
			const stopForImpendingCompaction =
				/(?:compaction|compact(?:ed|ing)?)[\s\S]{0,180}(?:stop|pause|return|split|boundar|checkable)|(?:stop|pause|return|split|boundar|checkable)[\s\S]{0,180}(?:compaction|compact(?:ed|ing)?)/.test(
					instructions,
				);
			const completedReceiptAndSplit =
				/(?:done|completed|finished)[\s\S]{0,180}(?:receipt|report|result|summary)[\s\S]{0,180}(?:split|subtask|follow-on|next task)|(?:split|subtask|follow-on|next task)[\s\S]{0,180}(?:done|completed|finished)[\s\S]{0,180}(?:receipt|report|result|summary)/.test(
					instructions,
				);
			expect(boundedWindow, `${agent} should set an approximately 15-minute execution window`).toBe(true);
			expect(stopForOversizedWork, `${agent} should stop at a checkable point when work is oversized`).toBe(true);
			expect(stopForImpendingCompaction, `${agent} should stop at a checkable point when compaction is near`).toBe(
				true,
			);
			expect(completedReceiptAndSplit, `${agent} should return completed work and a proposed split`).toBe(true);
		}
	});

	test("coding agents may commit only inside their explicitly isolated worktree", () => {
		for (const agent of ["coder", "ui-coder", "workhorse"] as const) {
			const content = readFileSync(new URL(`./agents/${agent}.md`, import.meta.url), "utf8");
			expect(content).toContain("isolated worktree");
			expect(content).toContain("commit only owned paths");
			expect(content).toContain("shared checkout");
			expect(content).toContain("git-pr-owner");
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

	test("skips catalogued pool models that lack authenticated availability", async () => {
		const { dir, file } = tempStateFile();
		try {
			const available = [{ provider: "kimi-code", id: "k3" }];
			const context = ctx({
				models: {
					list: () => available,
					resolve: (spec: string) => {
						const [provider, id] = spec.split(":")[0]!.split("/");
						return { provider, id };
					},
				} as ExtensionContext["models"],
			});
			const result = await routeSubagentSpawn({ agent: "coder", spawnKey: "auth-1" }, context, createRouterState(), {
				stateFile: file,
			});
			expect(result?.model[0]).toBe("kimi-code/k3:high");
			expect(result?.model).toEqual(["kimi-code/k3:high"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("skips usage-depleted pool members before picking and logs why", async () => {
		const { dir, file } = tempStateFile();
		try {
			const context = ctxWithHealth({
				"kimi-code/kimi-for-coding-highspeed": {
					state: "depleted",
					accounts: [{ state: "depleted", resetsAt: 1790333025547 }],
				},
			});
			const result = await routeSubagentSpawn(
				{ agent: "scout", spawnKey: "usage-1" },
				context,
				createRouterState(),
				{
					stateFile: file,
					shuffle: items => [...items],
				},
			);
			expect(result?.model[0]).toBe("codex-lb/gpt-6-luna:low");
			expect(result?.note).toBe("pool pick codex-lb/gpt-6-luna:low; skipped 1 by usage preflight (eval)");
			expect(readJsonl(file)[0]).toMatchObject({
				kind: "spawn",
				chosen: "codex-lb/gpt-6-luna:low",
				skipped: [
					{
						model: "kimi-code/kimi-for-coding-highspeed:low",
						reason: "usage_depleted",
						healthState: "depleted",
						accounts: [{ state: "depleted", resetsAt: 1790333025547 }],
					},
				],
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps a provider above reserve eligible for rotation", async () => {
		const { dir, file } = tempStateFile();
		try {
			const context = ctxWithHealth({
				"kimi-code/kimi-for-coding-highspeed": {
					state: "healthy",
					accounts: [{ state: "healthy", remainingFraction: 0.42 }],
				},
			});
			const result = await routeSubagentSpawn(
				{ agent: "scout", spawnKey: "usage-healthy" },
				context,
				createRouterState(),
				{
					stateFile: file,
					shuffle: items => [...items].reverse(),
				},
			);
			expect(result?.model[0]).toBe("kimi-code/kimi-for-coding-highspeed:low");
			expect(readJsonl(file)[0]?.skipped).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("capacity counts unique authenticated live model routes", async () => {
		const { dir, file } = tempStateFile();
		try {
			const exhausted = ctxWithHealth(
				Object.fromEntries(
					["codex-lb", "deepseek", "kimi-code", "claude-bridge", "openrouter", "anthropic"].map(provider => [
						provider,
						{ state: "depleted", accounts: [] },
					]),
				),
			);
			expect(await countLiveWorkerModels(exhausted)).toBe(0);
			expect(
				await routeSubagentSpawn({ agent: "coder", spawnKey: "all-dead" }, exhausted, createRouterState(), {
					stateFile: file,
				}),
			).toBeUndefined();
			const inklingOnly = ctxWithHealth(
				Object.fromEntries(
					["codex-lb", "deepseek", "kimi-code", "claude-bridge"].map(provider => [
						provider,
						{ state: "depleted", accounts: [] },
					]),
				),
			);
			expect(await countLiveWorkerModels(inklingOnly)).toBeGreaterThan(0);
			const onlyInklingModel = { provider: "openrouter", id: "thinkingmachines/inkling:free" };
			const onlyInkling = ctx({
				models: {
					list: () => [onlyInklingModel],
					resolve: (spec: string) =>
						spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") ===
						"openrouter/thinkingmachines/inkling:free"
							? onlyInklingModel
							: undefined,
				},
			});
			expect(await countLiveWorkerModels(onlyInkling)).toBe(1);
			expect(
				(
					await routeSubagentSpawn(
						{ agent: "coder", spawnKey: "inkling-only" },
						inklingOnly,
						createRouterState(),
						{ stateFile: file },
					)
				)?.model,
			).toEqual(["openrouter/thinkingmachines/inkling:free"]);
			expect(await agentHasLiveModel("nonexistent", ctx())).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("twenty coder spawns exclude depleted Codex and DeepSeek, including fallbacks", async () => {
		const { dir, file } = tempStateFile();
		try {
			const context = ctxWithHealth({
				"codex-lb": { state: "depleted", accounts: [{ state: "depleted", resetsAt: 1790333025547 }] },
				deepseek: { state: "depleted", accounts: [{ state: "depleted", resetsAt: 1790333025547 }] },
			});
			for (let i = 0; i < 20; i++) {
				const result = await routeSubagentSpawn(
					{ agent: "coder", spawnKey: `depleted-${i}` },
					context,
					createRouterState(),
					{ stateFile: file },
				);
				expect(result?.model.length).toBeGreaterThan(0);
				expect(result?.model.every(model => !model.startsWith("codex-lb/") && !model.startsWith("deepseek/"))).toBe(
					true,
				);
				expect(result?.model[0]?.startsWith("kimi-code/") || result?.model[0]?.startsWith("claude-bridge/")).toBe(
					true,
				);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reviewer fallback is a strong model, never a free model", async () => {
		const { dir, file } = tempStateFile();
		try {
			const context = ctxWithHealth({
				"codex-lb": { state: "depleted", accounts: [] },
				deepseek: { state: "depleted", accounts: [] },
				anthropic: { state: "depleted", accounts: [] },
			});
			const result = await routeSubagentSpawn(
				{ agent: "reviewer", spawnKey: "review-depleted" },
				context,
				createRouterState(),
				{ stateFile: file },
			);
			expect(result?.model).toEqual(["claude-bridge/claude-sonnet-5"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
			const rows = recordTaskOutcome(waitEvent, context, state, { stateFile: file });
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("completed");
			expect(rows[0]?.resolvedModel).toBe("kimi-code/k3:high");
			expect(recordTaskOutcome(waitEvent, context, state, { stateFile: file })).toEqual([]);
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
			await routeSubagentSpawn({ agent: "coder", spawnKey: "spawn-1" }, context, state, {
				stateFile: file,
				now: () => new Date("2026-09-24T18:00:00.000Z"),
				shuffle: items => [...items],
			});
			const rows = recordTaskOutcome(
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
					chosen: AGENT_POOLS.coder.pool[0],
					order: [...AGENT_POOLS.coder.pool, ...AGENT_POOLS.coder.fallbacks],
					status: "completed",
					durationMs: 1234,
					resolvedModel: "deepseek/deepseek-v4-pro:high",
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
			await routeSubagentSpawn({ agent: "scout", spawnKey: "fallback-1" }, context, state, {
				stateFile: file,
				shuffle: items => [...items].reverse(),
			});
			recordRetryFallbackApplied(
				{
					from: "kimi-code/kimi-for-coding-highspeed:low",
					to: "deepseek/deepseek-v4-flash:low",
					role: "fallback",
					reason: "Usage preflight: available quota is at or below the 10% reserve.",
				},
				state,
				{ now: () => new Date("2026-09-24T18:00:01.000Z") },
			);
			const rows = recordTaskOutcome(
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
			const rows = recordTaskOutcome(
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
			expect(await call({ toolName: "write", input: { path: "empty.txt", content: "", replace: true } }, context)).toBeUndefined();
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
			expect(await call({ toolName: "write", input: { path: "tracked.txt", content: "tiny", replace: true } }, context)).toBeUndefined();
			expect(await call({ toolName: "write", input: { path: "new.txt", content: "normal in-repo write" } }, context)).toBeUndefined();
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
});
