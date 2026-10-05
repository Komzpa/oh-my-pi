// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import agentRouter, {
	getAgentPools,
	MODEL_BLACKLIST,
	STRONG_MODELS,
	BRRRR_ENTRY,
	brrrrModeFile,
	agentHasLiveModel,
	countLiveWorkerModels,
	createRouterState,
	recordRetryFallbackApplied,
	recordTaskOutcome,
	routeSubagentSpawn,
} from "./agent_router";

const AGENT_POOLS = getAgentPools();

function ctx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	const models = Object.values(AGENT_POOLS)
		.flatMap(config => [...config.pool, ...config.fallbacks])
		.map(spec => {
			const base = spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "");
			const slash = base.indexOf("/");
			return { provider: base.slice(0, slash), id: base.slice(slash + 1) };
		});
	return {
		sessionManager: { getHeader: () => ({ id: "session-1" }) },
		models: {
			list: () => models,
			resolve: (spec: string) =>
				models.find(
					model => `${model.provider}/${model.id}` === spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, ""),
				),
		},
		...overrides,
	} as unknown as ExtensionContext;
}

function ctxWithHealth(
	healthByKey: Record<string, { state: string; accounts: Array<Record<string, unknown>> }>,
): ExtensionContext {
	const base = ctx();
	return {
		...base,
		modelRegistry: {
			authStorage: {
				health: {
					model: async (provider: string, options: { modelId?: string }) =>
						healthByKey[`${provider}/${options.modelId}`] ??
						healthByKey[provider] ?? { state: "unknown", accounts: [] },
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
	return THINKING_ORDER.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : undefined;
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
	const effective = floor && requested && levelIndex(requested) < levelIndex(floor) ? floor : (requested ?? floor);
	return effective === undefined || levelIndex(effective) <= levelIndex(intended);
}

describe("agent router", () => {
	test("brrrr orders contain only strong entries for coder scout and reviewer", async () => {
		const { dir, file } = tempStateFile();
		const modeFile = join(dir, "mode.json");
		writeFileSync(modeFile, JSON.stringify({ enabled: true }));
		try {
			for (const agent of ["coder", "scout", "reviewer", "task", "custom-worker"]) {
				const routed = await routeSubagentSpawn({ agent }, ctx(), createRouterState(), { stateFile: file, modeFile });
				expect(routed?.model.length).toBeGreaterThan(0);
				for (const spec of routed!.model) {
					expect([...STRONG_MODELS, "cerebras/qwen-3.8-27b"]).toContain(spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, ""));
					expect(spec).not.toMatch(/:free|ling/);
				}
				expect(routed.requiredModelServiceTiers["codex-lb/gpt-6-luna"]).toBe("priority");
				const profile = AGENT_POOLS[agent];
				const expected = profile ? [...profile.pool, ...profile.fallbacks]
					.filter(spec => STRONG_MODELS.includes(modelSelectorBase(spec)) && !spec.includes("luna"))
					.map(modelSelectorBase) : [];
				expect(routed.model.filter(spec => !spec.startsWith("cerebras/")).slice(0, expected.length).map(modelSelectorBase)).toEqual(expected);
			}
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("brrrr puts the fast Cerebras model first for scout and last for coder", async () => {
		const { dir, file } = tempStateFile();
		const modeFile = join(dir, "mode.json");
		writeFileSync(modeFile, JSON.stringify({ enabled: true }));
		const previous = process.env.OMP_AGENT_ROUTER_MODELS;
		process.env.OMP_AGENT_ROUTER_MODELS = new URL("./brrrr_models.json", import.meta.url).pathname;
		const fast = "cerebras/qwen-3.8-27b";
		try {
			const scout = await routeSubagentSpawn({ agent: "scout" }, ctx(), createRouterState(), { stateFile: file, modeFile });
			const coder = await routeSubagentSpawn({ agent: "coder" }, ctx(), createRouterState(), { stateFile: file, modeFile });
			expect(modelSelectorBase(scout.model[0])).toBe(fast);
			expect(scout.model.length).toBeGreaterThan(1);
			expect(modelSelectorBase(coder.model.at(-1))).toBe(fast);
			expect(modelSelectorBase(coder.model[0])).not.toBe(fast);
			for (const spec of [...scout.model, ...coder.model]) expect(spec).not.toMatch(/gpt-oss/);
		} finally {
			if (previous === undefined) delete process.env.OMP_AGENT_ROUTER_MODELS;
			else process.env.OMP_AGENT_ROUTER_MODELS = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("brrrr returns undefined when every allowed model is depleted", async () => {
		const { dir, file } = tempStateFile();
		const modeFile = join(dir, "mode.json");
		writeFileSync(modeFile, JSON.stringify({ enabled: true }));
		try {
			const health = Object.fromEntries([...STRONG_MODELS, "cerebras/qwen-3.8-27b"].map(id => [id, { state: "depleted", accounts: [] }]));
			expect(await routeSubagentSpawn({ agent: "coder" }, ctxWithHealth(health), createRouterState(), { stateFile: file, modeFile })).toBeUndefined();
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("brrrr rereads mode and blacklist before each spawn", async () => {
		const { dir, file } = tempStateFile();
		const modeFile = join(dir, "mode.json");
		const blacklistFile = join(dir, "blacklist.json");
		try {
			const options = { stateFile: file, modeFile, blacklistFile };
			const context = ctx();
			expect((await routeSubagentSpawn({ agent: "coder" }, context, createRouterState(), options)).model[0]).toContain(":free");
			writeFileSync(modeFile, JSON.stringify({ enabled: true }));
			const first = await routeSubagentSpawn({ agent: "coder" }, context, createRouterState(), options);
			expect(first.model[0]).not.toContain(":free");
			writeFileSync(blacklistFile, JSON.stringify([modelSelectorBase(first.model[0])]));
			const next = await routeSubagentSpawn({ agent: "coder" }, context, createRouterState(), options);
			expect(next.model.map(modelSelectorBase)).not.toContain(modelSelectorBase(first.model[0]));
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("brrrr rereads the user-wide model allow-list between spawns in the same context", async () => {
		const { dir, file } = tempStateFile();
		const agentDir = join(dir, ".omp", "agent");
		mkdirSync(agentDir, { recursive: true });
		const modelsFile = join(agentDir, "brrrr-models.json");
		const modeFile = join(dir, "mode.json");
		const previous = process.env.OMP_AGENT_ROUTER_MODELS;
		process.env.OMP_AGENT_ROUTER_MODELS = modelsFile;
		const ling = "openrouter/inclusionai/ling-3.0-flash-sante:free";
		const base = ctx();
		const context = ctx({
			models: {
				list: () => [...base.models.list(), { provider: "openrouter", id: ling.slice("openrouter/".length) }],
				resolve: spec => spec === ling
					? { provider: "openrouter", id: ling.slice("openrouter/".length) }
					: base.models.resolve(spec),
			},
		});
		const state = createRouterState();
		const options = { stateFile: file, modeFile, shuffle: items => [...items] };
		try {
			writeFileSync(modeFile, JSON.stringify({ enabled: true }));
			writeFileSync(modelsFile, JSON.stringify([{ id: "anthropic/claude-opus-5-5", class: "strong" }]));
			const before = await routeSubagentSpawn({ agent: "coder" }, context, state, options);
			expect(before.model.map(modelSelectorBase)).toEqual(["anthropic/claude-opus-5-5"]);
			expect(before.model.some(spec => spec.includes(":free"))).toBe(false);
			writeFileSync(modelsFile, JSON.stringify([
				{ id: "codex-lb/gpt-6.1-sol", class: "strong" },
				{ id: ling, class: "strong" },
			]));
			const after = await routeSubagentSpawn({ agent: "coder" }, context, state, options);
			expect(after.model.map(modelSelectorBase)).toEqual(["codex-lb/gpt-6.1-sol"]);
			expect(after.model).not.toContain(ling);
			writeFileSync(modeFile, JSON.stringify({ enabled: false }));
			const off = await routeSubagentSpawn({ agent: "coder" }, context, state, options);
			expect(off.model).toEqual([
				...AGENT_POOLS.coder.pool.filter(spec => spec.endsWith(":free")),
				...AGENT_POOLS.coder.pool.filter(spec => !spec.endsWith(":free")),
				...AGENT_POOLS.coder.fallbacks,
			]);
			expect(off.enforce).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.OMP_AGENT_ROUTER_MODELS;
			else process.env.OMP_AGENT_ROUTER_MODELS = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a child session inherits brrrr from its active parent", async () => {
		const { dir, file } = tempStateFile();
		const previous = process.env.OMP_AGENT_ROUTER_MODE_DIR;
		process.env.OMP_AGENT_ROUTER_MODE_DIR = join(dir, "modes");
		const parent = SessionManager.create(dir, dir);
		let child: SessionManager | undefined;
		let active = parent;
		const handlers = new Map();
		const commands = new Map();
		const api = {
			on: (event, handler) => handlers.set(event, handler),
			registerCommand: (name, command) => commands.set(name, command),
			appendEntry: (customType, data) => active.appendCustomEntry(customType, data),
		};
		const ui = { setStatus: () => {}, notify: () => {} };
		const parentContext = ctx({ sessionManager: parent, ui });
		try {
			agentRouter(api);
			await handlers.get("session_start")({}, parentContext);
			await commands.get("brrrr").handler("", parentContext);
			await parent.ensureOnDisk();
			await parent.flush();
			const parentFile = parent.getSessionFile();
			const parentBefore = readFileSync(parentFile, "utf8");
			child = await SessionManager.open(join(dir, "child.jsonl"), dir, undefined, {
				initialCwd: dir,
				parentSession: parentFile,
				suppressBreadcrumb: true,
			});
			active = child;
			const childContext = ctx({ sessionManager: child, ui });
			expect(child.getBranch().some(entry => entry.type === "custom" && entry.customType === BRRRR_ENTRY)).toBe(false);
			await handlers.get("session_start")({}, childContext);
			expect(JSON.parse(readFileSync(brrrrModeFile(childContext), "utf8")).enabled).toBe(true);
			const routed = await routeSubagentSpawn({ agent: "coder" }, childContext, createRouterState(), { stateFile: file });
			expect(routed.enforce).toBe(true);
			expect(routed.model.some(spec => /:free|ling/.test(spec))).toBe(false);
			expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
			parent.appendCustomEntry("inheritance-control", { stillWritable: true });
			await parent.flush();
			expect(parent.getSessionFile()).toBe(parentFile);
			expect(readFileSync(parentFile, "utf8")).toContain("inheritance-control");
			await commands.get("brrrr").handler("off", childContext);
			expect(JSON.parse(readFileSync(brrrrModeFile(parentContext), "utf8")).enabled).toBe(true);
			expect(JSON.parse(readFileSync(brrrrModeFile(childContext), "utf8")).enabled).toBe(false);
		} finally {
			await child?.close();
			await parent.close();
			if (previous === undefined) delete process.env.OMP_AGENT_ROUTER_MODE_DIR;
			else process.env.OMP_AGENT_ROUTER_MODE_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("brrrr command persists and restores status in a headless session", async () => {
		const { dir } = tempStateFile();
		const previous = process.env.OMP_AGENT_ROUTER_MODE_DIR;
		process.env.OMP_AGENT_ROUTER_MODE_DIR = dir;
		const entries = [];
		const handlers = new Map();
		const commands = new Map();
		const statuses = [];
		const notices = [];
		const api = { on: (event, handler) => handlers.set(event, handler), registerCommand: (name, command) => commands.set(name, command), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
		const context = ctx({ sessionManager: { getHeader: () => ({ id: "headless-brrrr" }), getBranch: () => entries }, ui: { setStatus: (_key, value) => statuses.push(value), notify: text => notices.push(text) } });
		try {
			agentRouter(api);
			await handlers.get("session_start")({}, context);
			await commands.get("brrrr").handler("", context);
			expect(JSON.parse(readFileSync(brrrrModeFile(context), "utf8")).enabled).toBe(true);
			expect(entries.at(-1)).toEqual({ type: "custom", customType: BRRRR_ENTRY, data: { enabled: true } });
			expect(statuses.at(-1)).toContain("BRRRR");
			agentRouter(api);
			await handlers.get("session_start")({}, context);
			expect(statuses.at(-1)).toContain("BRRRR");
			await commands.get("brrrr").handler("off", context);
			expect(statuses.at(-1)).toBeUndefined();
			expect(notices).toHaveLength(2);
		} finally {
			if (previous === undefined) delete process.env.OMP_AGENT_ROUTER_MODE_DIR; else process.env.OMP_AGENT_ROUTER_MODE_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("brrrr Claude coder effort is capped at high", async () => {
		const { dir, file } = tempStateFile();
		const modeFile = join(dir, "mode.json");
		const profileDir = join(dir, "profiles");
		mkdirSync(profileDir);
		writeFileSync(modeFile, JSON.stringify({ enabled: true }));
		writeFileSync(join(profileDir, "coder.md"), "---\nname: coder\ndescription: test\nmodel: anthropic/claude-opus-5-5:max\n---\nImplement.\n");
		try {
			const routed = await routeSubagentSpawn({ agent: "coder" }, ctx(), createRouterState(), { stateFile: file, modeFile, profileDir });
			expect(routed.model[0]).toBe("anthropic/claude-opus-5-5:high");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	test("uniform crypto shuffle can cover every coder pool member as the chosen model", async () => {
		const seen = new Set<string>();
		const { dir, file } = tempStateFile();
		try {
			const nonFreePool = AGENT_POOLS.coder.pool.filter(spec => !spec.endsWith(":free"));
			for (let i = 0; i < 600 && seen.size < nonFreePool.length; i++) {
				const state = createRouterState();
				const result = await routeSubagentSpawn({ agent: "coder", spawnKey: `coder-${i}` }, ctx(), state, {
					stateFile: file,
				});
				expect(result).toBeDefined();
				seen.add(result!.model.find(spec => !spec.endsWith(":free"))!);
			}
			expect(seen).toEqual(new Set(nonFreePool));
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
			expect(result?.model).toEqual([
				...AGENT_POOLS["ui-coder"].pool.filter(spec => spec.endsWith(":free")),
				...AGENT_POOLS["ui-coder"].pool.filter(spec => !spec.endsWith(":free")).reverse(),
				...AGENT_POOLS["ui-coder"].fallbacks,
			]);
			expect(result?.model).toContain("codex-lb/gpt-6.1-sol:medium");
			expect(result?.model).not.toContain("anthropic/claude-sonnet-5:medium");
			expect(result?.note).toBe(`pool pick ${result?.model[0]} (eval)`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("reads an edited profile chain at the next spawn", async () => {
		const { dir, file } = tempStateFile();
		const profileDir = join(dir, "profiles");
		mkdirSync(profileDir);
		const profilePath = join(profileDir, "coder.md");
		const profile = readFileSync(new URL("./agents/coder.md", import.meta.url), "utf8");
		try {
			writeFileSync(profilePath, profile);
			const before = await routeSubagentSpawn(
				{ agent: "coder", spawnKey: "profile-before" },
				ctx(),
				createRouterState(),
				{
					stateFile: file,
					profileDir,
				},
			);
			expect(before?.model[0]).toBe("openrouter/dots-studio/dots-3-note-preview:free");
			writeFileSync(
				profilePath,
				profile.replace(/^model:.*$/m, "model: xiaomi/mimo-v2.6-pro, kimi-code/kimi-for-coding:high"),
			);
			const after = await routeSubagentSpawn(
				{ agent: "coder", spawnKey: "profile-after" },
				ctx(),
				createRouterState(),
				{
					stateFile: file,
					profileDir,
				},
			);
			expect(after?.model).toContain("xiaomi/mimo-v2.6-pro");
			expect(after?.model).toContain("kimi-code/kimi-for-coding:high");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("never chooses blacklisted models from the pool or fallback chain", async () => {
		const { dir, file } = tempStateFile();
		const profileDir = join(dir, "profiles");
		mkdirSync(profileDir);
		const scoutProfile = readFileSync(new URL("./agents/scout.md", import.meta.url), "utf8");
		writeFileSync(
			join(profileDir, "scout.md"),
			scoutProfile.replace(
				/^model:.*$/m,
				"model: openrouter/inclusionai/ling-3.0-flash-sante:free, missing/pool-one, missing/pool-two, missing/pool-three, missing/pool-four, openrouter/inclusionai/ling-3.0-flash-sante:free:low, openrouter/dots-studio/dots-3-note-preview:free",
			),
		);
		const baseContext = ctx();
		const blacklistedModel = { provider: "openrouter", id: "inclusionai/ling-3.0-flash-sante" };
		const availableModels = [...baseContext.models.list(), blacklistedModel];
		const context = ctx({
			models: {
				list: () => availableModels,
				resolve: (spec: string) =>
					MODEL_BLACKLIST.includes(spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") as never)
						? blacklistedModel
						: baseContext.models.resolve(spec),
			} as ExtensionContext["models"],
		});
		try {
			const result = await routeSubagentSpawn(
				{ agent: "scout", spawnKey: "blacklist-pool-fallback" },
				context,
				createRouterState(),
				{ stateFile: file, profileDir, shuffle: items => [...items] },
			);
			expect(result?.model[0]).toBe("openrouter/dots-studio/dots-3-note-preview:free");
			expect(
				result?.model.some(spec =>
					MODEL_BLACKLIST.some(
						blacklisted => spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") === blacklisted,
					),
				),
			).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("skips the only free model when usage-depleted", async () => {
		const { dir, file } = tempStateFile();
		try {
			const firstFree = AGENT_POOLS.coder.pool.find(spec => spec.endsWith(":free"))!;
			const modelKey = firstFree.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "");
			const unavailableFirstFree = ctxWithHealth({ [modelKey]: { state: "depleted", accounts: [] } });
			for (let i = 0; i < 50; i++) {
				const result = await routeSubagentSpawn(
					{ agent: "coder", spawnKey: `free-first-${i}` },
					unavailableFirstFree,
					createRouterState(),
					{ stateFile: file },
				);
				expect(result?.model).not.toContain(firstFree);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("subscribed Xiaomi and Muse models can each be the first pick, not fallback-only", async () => {
		const candidates = [
			["coder", "xiaomi/mimo-v2.6-pro"],
			["coder", "muse-code/muse-spark-1.3-contributor"],
			["ui-coder", "xiaomi/mimo-v2.6-pro"],
			["scout", "xiaomi/mimo-v2.6-flash"],
			["gate-runner", "xiaomi/mimo-v2.6-flash"],
			["git-pr-owner", "xiaomi/mimo-v2.6-flash"],
			["scribe", "xiaomi/mimo-v2.6-flash"],
			["workhorse", "xiaomi/mimo-v2.6-flash"],
			["task", "xiaomi/mimo-v2.6-pro"],
			["task", "muse-code/muse-spark-1.3-contributor"],
		] as const;
		const { dir, file } = tempStateFile();
		try {
			for (const [agent, candidate] of candidates) {
				const config = AGENT_POOLS[agent]!;
				expect(config.pool).toContain(candidate);
				expect(config.fallbacks).not.toContain(candidate);
				const result = await routeSubagentSpawn(
					{ agent, spawnKey: `${agent}:${candidate}` },
					ctx(),
					createRouterState(),
					{
						stateFile: file,
						shuffle: items => {
							const index = items.indexOf(candidate);
							return [...items.slice(index), ...items.slice(0, index)];
						},
					},
				);
				expect(result?.model).toContain(candidate);
				expect(
					result?.model.filter(model => model.startsWith("openrouter/")).every(model => model.endsWith(":free")),
				).toBe(true);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("every openrouter entry ends with :free and judgment roles use no openrouter entry", () => {
		const judgmentRoles: Record<string, true> = { reviewer: true, adversary: true, "qa-auditor": true };
		for (const [agent, config] of Object.entries(AGENT_POOLS)) {
			for (const model of [...config.pool, ...config.fallbacks]) {
				if (!model.startsWith("openrouter/")) continue;
				expect(model.endsWith(":free"), `${agent}: ${model}`).toBe(true);
				expect(judgmentRoles[agent] === true || agent.endsWith("-strong"), agent).toBe(false);
			}
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
			expect(afterCompletion?.model).toBeDefined();
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
			expect(first?.model).toBeDefined();
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
			expect(owner?.model).toBeDefined();
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
			expect((await spawn("git-pr-owner", "owner-1"))?.model).toBeDefined();
			running = [{ id: "owner-1", type: "task", status: "running" }];
			expect((await spawn("coder", "coder-disjoint"))?.model).toBeDefined();
			const overlap = await spawn("coder", "coder-overlap");
			expect(overlap?.block).toBe(true);
			expect(overlap?.reason).toContain("owner-1");
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
			expect(first?.model).toBeDefined();
			running = [{ id: "batch-unowned-1", type: "task", status: "running" }];
			const second = await spawn("batch-unowned-2", `# Row: Fix beta lane\nLane: ${laneB}\nDo the work.`);
			expect(second?.model).toBeDefined();
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
			expect(controlFirst?.model).toBeDefined();
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
			expect(controlSecond?.reason).toContain("this spawn scope");
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
			expect((await spawn("native-writer"))?.model).toBeDefined();
			running = [{ id: "native-writer", type: "task", status: "running" }];
			expect((await spawn("tasks-writer"))?.model).toBeDefined();
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
				expect((await spawn(spawnKey))?.model).toBeDefined();
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
			expect((await spawn("writer-1"))?.model).toBeDefined();
			running = [{ id: "writer-1", type: "task", status: "running" }];
			tasks[0].schedule.resources = [changed];
			tasks.push({ content: "Next", status: "pending", schedule: { owner: "writer-2", resources: [original] } });
			expect((await spawn("writer-2"))?.block).toBe(true);
			tasks[1].schedule.resources = [changed];
			expect((await spawn("writer-2"))?.model).toBeDefined();
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
			expect((await spawn("writer-2"))?.model).toBeDefined();
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
			];
			let reads = 0;
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
			const api = {
				setLabel: () => undefined,
				pi: {
					getLatestTodoPhasesFromEntries: (entries: unknown[]) => {
						expect(entries).toBe(branch);
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
				(await handlers.get("before_subagent_spawn")!({ agent: "coder", spawnKey: "writer-0" }, context))?.model,
			).toBeDefined();
			running = [{ id: "writer-0", type: "task", status: "running" }];
			expect(
				(await handlers.get("before_subagent_spawn")!({ agent: "workhorse", spawnKey: "writer-1" }, context))
					?.model,
			).toBeDefined();
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

	test("a bridge-only registry cannot dispatch either ordinary or strong workers", async () => {
		const { dir, file } = tempStateFile();
		try {
			const bridge = { provider: "claude-bridge", id: "claude-sonnet-5" };
			const context = ctx({
				models: {
					list: () => [bridge],
					resolve: (selector: string) => (selector === "claude-bridge/claude-sonnet-5" ? bridge : undefined),
				},
			});
			const state = createRouterState();
			for (const agent of ["coder", "coder-strong", "ui-coder", "ui-coder-strong"]) {
				expect(
					await routeSubagentSpawn({ agent, spawnKey: agent }, context, state, { stateFile: file }),
				).toBeUndefined();
			}
			expect(state.spawns.size).toBe(0);
			expect(await countLiveWorkerModels(context)).toBe(0);
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
			expect(result?.model[0]).toBe("openrouter/dots-studio/dots-3-note-preview:free");
			expect(result?.note).toBe(
				"pool pick openrouter/dots-studio/dots-3-note-preview:free; skipped 1 by usage preflight (eval)",
			);
			expect(readJsonl(file)[0]).toMatchObject({
				kind: "spawn",
				chosen: "openrouter/dots-studio/dots-3-note-preview:free",
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
					shuffle: items => {
						const index = items.indexOf("kimi-code/kimi-for-coding-highspeed:low");
						return [...items.slice(index), ...items.slice(0, index)];
					},
				},
			);
			expect(result?.model).toContain("kimi-code/kimi-for-coding-highspeed:low");
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
					[
						"codex-lb",
						"deepseek",
						"kimi-code",
						"claude-bridge",
						"openrouter",
						"anthropic",
						"xiaomi",
						"muse-code",
						"cerebras",
					].map(provider => [provider, { state: "depleted", accounts: [] }]),
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
			expect(await countLiveWorkerModels(onlyInkling)).toBe(0);
			expect(
				await routeSubagentSpawn({ agent: "coder", spawnKey: "inkling-only" }, onlyInkling, createRouterState(), {
					stateFile: file,
				}),
			).toBeUndefined();
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
				expect(
					["openrouter/", "kimi-code/", "claude-bridge/", "xiaomi/", "muse-code/"].some(provider =>
						result?.model[0]?.startsWith(provider),
					),
				).toBe(true);
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
			expect(result).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("coder spawn with a fixed shuffle resolves to a free model", async () => {
		const { dir, file } = tempStateFile();
		try {
			const result = await routeSubagentSpawn(
				{ agent: "coder", spawnKey: "FreeFirst" },
				ctx(),
				createRouterState(),
				{ stateFile: file, shuffle: items => [...items] },
			);
			expect(result?.model[0]).toBe("openrouter/dots-studio/dots-3-note-preview:free");
			expect(result?.model.filter(model => model.endsWith(":free"))).toEqual([
				"openrouter/dots-studio/dots-3-note-preview:free",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reviewer spawn never resolves to a free model (control)", async () => {
		const { dir, file } = tempStateFile();
		try {
			const result = await routeSubagentSpawn(
				{ agent: "reviewer", spawnKey: "ReviewNoFree" },
				ctx(),
				createRouterState(),
				{ stateFile: file, shuffle: items => [...items] },
			);
			expect(result?.model.length).toBeGreaterThan(0);
			expect(result?.model.every(model => !model.endsWith(":free"))).toBe(true);
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
			await routeSubagentSpawn({ agent: "coder", spawnKey: "spawn-1" }, context, state, {
				stateFile: file,
				now: () => new Date("2026-09-24T18:00:00.000Z"),
				shuffle: items => [...items],
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
			const routed = await routeSubagentSpawn({ agent: "scout", spawnKey: "fallback-1" }, context, state, {
				stateFile: file,
				shuffle: items => {
					const index = items.indexOf("kimi-code/kimi-for-coding-highspeed:low");
					return [...items.slice(index), ...items.slice(0, index)];
				},
			});
			recordRetryFallbackApplied(
				{
					from: routed!.model[0]!,
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
	test("auth-dead models are skipped for hours after a 401 Invalid API Key failure", async () => {
		const { dir, file } = tempStateFile();
		try {
			const t0 = new Date("2026-10-01T15:00:00.000Z");
			const state = createRouterState();
			const context = ctx();
			const xiaomiFirst = <T>(items: readonly T[]) => {
				const index = items.indexOf("xiaomi/mimo-v2.6-pro" as T);
				return [...items.slice(index), ...items.slice(0, index)];
			};
			const first = await routeSubagentSpawn({ agent: "coder", spawnKey: "coder-auth-1" }, context, state, {
				stateFile: file,
				now: () => t0,
				shuffle: xiaomiFirst,
			});
			expect(first?.model[0]).toBe("openrouter/dots-studio/dots-3-note-preview:free");
			const base = ctx();
			const xiaomiModel = {
				provider: "xiaomi",
				id: "mimo-v2.6-pro",
				baseUrl: "https://api.xiaomimimo.com/v1",
			};
			const deadContext = ctx({
				models: {
					list: () => [xiaomiModel],
					resolve: (spec: string) =>
						spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") === "xiaomi/mimo-v2.6-pro"
							? xiaomiModel
							: base.models.resolve(spec),
				},
				modelRegistry: {
					authStorage: { health: { model: async () => ({ state: "unknown", accounts: [] }) } },
					getApiKey: async () => "sk-dead-key",
				},
			});
			const rows = await recordTaskOutcome(
				{
					toolName: "task",
					isError: true,
					details: {
						results: [
							{
								agent: "coder",
								exitCode: 1,
								durationMs: 200,
								resolvedModel: "xiaomi/mimo-v2.6-pro",
								error: "[xiaomi/mimo-v2.6-pro] 401 Invalid API Key",
							},
						],
					},
				},
				deadContext,
				state,
				{ stateFile: file, now: () => t0, authProbe: async () => false },
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("failed");
			const whileDead = await routeSubagentSpawn({ agent: "coder", spawnKey: "coder-auth-2" }, context, state, {
				stateFile: file,
				now: () => new Date(t0.getTime() + 60 * 60 * 1000),
				shuffle: xiaomiFirst,
			});
			expect(whileDead?.model).toBeDefined();
			expect(whileDead?.model).not.toContain("xiaomi/mimo-v2.6-pro");
			const afterTtl = await routeSubagentSpawn({ agent: "coder", spawnKey: "coder-auth-3" }, context, state, {
				stateFile: file,
				now: () => new Date(t0.getTime() + 7 * 60 * 60 * 1000),
				shuffle: xiaomiFirst,
			});
			expect(afterTtl?.model[0]).toBe("openrouter/dots-studio/dots-3-note-preview:free");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a 401 probes the request-resolved plan host and keeps the model when the key is alive", async () => {
		const { dir, file } = tempStateFile();
		try {
			const t0 = new Date("2026-10-01T15:00:00.000Z");
			const state = createRouterState();
			const base = ctx();
			const xiaomiModel = {
				provider: "xiaomi",
				id: "mimo-v2.6-pro",
				// Bundled cold-start entry: hardcoded standard host before discovery runs.
				baseUrl: "https://api.xiaomimimo.com/v1",
			};
			const context = ctx({
				models: {
					list: () => [xiaomiModel],
					resolve: (spec: string) =>
						spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") === "xiaomi/mimo-v2.6-pro"
							? xiaomiModel
							: base.models.resolve(spec),
				},
				modelRegistry: {
					authStorage: { health: { model: async () => ({ state: "unknown", accounts: [] }) } },
					getApiKey: async () => "tp-test-key",
				},
			});
			const probed: { url: string; authorization: string | null }[] = [];
			const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				probed.push({ url: String(input), authorization: headers.get("Authorization") });
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}) as unknown as typeof fetch;
			const fail = {
				toolName: "task",
				isError: true,
				details: {
					results: [
						{
							agent: "coder",
							exitCode: 1,
							durationMs: 200,
							resolvedModel: "xiaomi/mimo-v2.6-pro",
							error: "[xiaomi/mimo-v2.6-pro] 401 Invalid API Key",
						},
					],
				},
			};
			await routeSubagentSpawn({ agent: "coder", spawnKey: "coder-probe-1" }, context, state, {
				stateFile: file,
				now: () => t0,
			});
			await recordTaskOutcome(fail, context, state, { stateFile: file, now: () => t0, fetch: fetchMock });
			expect(probed).toEqual([
				{ url: "https://token-plan-sgp.xiaomimimo.com/v1/models", authorization: "Bearer tp-test-key" },
			]);
			expect(state.authDead.has("xiaomi/mimo-v2.6-pro")).toBe(false);
			await routeSubagentSpawn({ agent: "coder", spawnKey: "coder-probe-2" }, context, state, {
				stateFile: file,
				now: () => new Date(t0.getTime() + 30 * 60 * 1000),
			});
			await recordTaskOutcome(fail, context, state, {
				stateFile: file,
				now: () => new Date(t0.getTime() + 30 * 60 * 1000),
				fetch: fetchMock,
			});
			expect(probed).toHaveLength(1); // probe result cached for the hour
			expect(state.authDead.has("xiaomi/mimo-v2.6-pro")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a 401 hides the model only when the probe also rejects the key", async () => {
		const { dir, file } = tempStateFile();
		try {
			const t0 = new Date("2026-10-01T15:00:00.000Z");
			const state = createRouterState();
			const xiaomiModel = {
				provider: "xiaomi",
				id: "mimo-v2.6-pro",
				baseUrl: "https://api.xiaomimimo.com/v1",
			};
			const context = ctx({
				models: {
					list: () => [xiaomiModel],
					resolve: () => xiaomiModel,
				},
				modelRegistry: {
					authStorage: { health: { model: async () => ({ state: "unknown", accounts: [] }) } },
					getApiKey: async () => "sk-dead-key",
				},
			});
			await routeSubagentSpawn({ agent: "coder", spawnKey: "coder-dead-1" }, context, state, {
				stateFile: file,
				now: () => t0,
			});
			await recordTaskOutcome(
				{
					toolName: "task",
					isError: true,
					details: {
						results: [
							{
								agent: "coder",
								exitCode: 1,
								durationMs: 200,
								resolvedModel: "xiaomi/mimo-v2.6-pro",
								error: "[xiaomi/mimo-v2.6-pro] 401 Invalid API Key",
							},
						],
					},
				},
				context,
				state,
				{ stateFile: file, now: () => t0, authProbe: async () => false },
			);
			expect(state.authDead.has("xiaomi/mimo-v2.6-pro")).toBe(true);
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
			expect((await spawn("holder-1"))?.model).toBeDefined();
			running = [{ id: "holder-1", type: "task", status: "running" }];
			tasks.push({
				content: "Other repo work",
				status: "pending",
				schedule: { owner: "other-1", resources: [`${repoB}/src/other.ts:source-writer`] },
			});
			expect((await spawn("other-1"))?.model).toBeDefined();
			tasks.pop();
			tasks.push({
				content: "Outside any repo",
				status: "pending",
				schedule: { owner: "tmp-1", resources: [join(dir, "scratch", "newfile.ts")] },
			});
			expect((await spawn("tmp-1"))?.model).toBeDefined();
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
			expect((await spawn("holder-1"))?.model).toBeDefined();
			running = [{ id: "holder-1", type: "task", status: "running" }];
			const refused = await spawn("same-1");
			expect(refused).toMatchObject({ block: true });
			expect(refused?.reason).toContain("holder-1");
			expect(refused?.reason).toContain(repoA);
			expect(refused?.reason).toContain("if this row edits another repo, put that repo path in the row resources");
			expect(refused?.reason).toContain(`isolated: true isolates only ${repoA}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	describe("critical row priority-first routing", () => {
		const NOW_MS = Date.UTC(2026, 9, 2, 10, 0, 0);
		const estimate = (optimisticSeconds: number, likelySeconds: number, pessimisticSeconds: number) => ({
			optimisticSeconds,
			likelySeconds,
			pessimisticSeconds,
			confidence: "medium",
			basis: "test",
			updatedAt: NOW_MS - 1000,
		});
		// "long" is the only zero-natural-float row, so the canonical forecast
		// marks it critical and "short" non-critical (verified against
		// forecastTodoPlan directly).
		const PHASES = [
			{
				name: "Work",
				tasks: [
					{
						content: "long",
						status: "pending",
						schedule: {
							owner: "long-1",
							dependencies: [],
							resources: ["repo-a"],
							estimate: estimate(60, 120, 180),
						},
					},
					{
						content: "short",
						status: "pending",
						schedule: {
							owner: "short-1",
							dependencies: [],
							resources: ["repo-b"],
							estimate: estimate(6, 12, 18),
						},
					},
				],
			},
		];
		// Slim { provider, id } stubs cannot classify; enrich with the api and
		// identity the prod model registry resolve carries.
		const MODEL_DETAILS: Record<string, { api: string; identity: { class: string } }> = {
			"codex-lb/gpt-6-luna": { api: "openai-completions", identity: { class: "openai" } },
			"codex-lb/gpt-6.1-sol": { api: "openai-completions", identity: { class: "openai" } },
			"codex-lb/Qwen3.8-27B": { api: "openai-completions", identity: { class: "qwen" } },
			"kimi-code/kimi-for-coding": { api: "anthropic-messages", identity: { class: "kimi" } },
			"kimi-code/k3": { api: "anthropic-messages", identity: { class: "kimi" } },
			"deepseek/deepseek-v4-pro": { api: "openai-completions", identity: { class: "deepseek" } },
			"xiaomi/mimo-v2.6-pro": { api: "openai-completions", identity: { class: "mimo" } },
			"muse-code/muse-spark-1.3-contributor": { api: "openai-completions", identity: { class: "meta" } },
			"cerebras/qwen-3.8-27b": { api: "openai-completions", identity: { class: "qwen" } },
		};
		function priorityCtx(only?: string[]): ExtensionContext {
			const base = ctx() as unknown as { models: { list: () => Array<{ provider: string; id: string }> } };
			const models = base.models
				.list()
				.filter(model => !only || only.includes(`${model.provider}/${model.id}`))
				.map(model => ({ ...model, ...MODEL_DETAILS[`${model.provider}/${model.id}`] }));
			return {
				...base,
				sessionManager: { getHeader: () => ({ id: "session-1" }), getBranch: () => [] },
				models: {
					list: () => models,
					resolve: (spec: string) =>
						models.find(
							model =>
								`${model.provider}/${model.id}` === spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, ""),
						),
				},
			} as unknown as ExtensionContext;
		}
		const reversed = <T>(items: readonly T[]) => [...items].reverse();
		const spawnTask = (spawnKey: string, context: ExtensionContext, file: string) =>
			routeSubagentSpawn({ agent: "task", spawnKey }, context, createRouterState(), {
				stateFile: file,
				now: () => new Date(NOW_MS),
				shuffle: reversed,
				latestTodo: () => PHASES,
			});
		// Free pool members stay first; only non-free pool members are shuffled.
		const TASK_ORDER = [
			"openrouter/dots-studio/dots-3-note-preview:free",
			"muse-code/muse-spark-1.3-contributor",
			"xiaomi/mimo-v2.6-pro",
			"kimi-code/k3:high",
			"deepseek/deepseek-v4-pro:high",
			"kimi-code/kimi-for-coding:high",
			"codex-lb/gpt-6-luna:medium",
			"codex-lb/gpt-6.1-sol:medium",
			"codex-lb/Qwen3.8-27B",
			"cerebras/qwen-3.8-27b",
		];

		test("critical row moves the earliest priority-capable chain entry first when no free model is present", async () => {
			const { dir, file } = tempStateFile();
			try {
				const withoutFree = TASK_ORDER.filter(spec => !spec.endsWith(":free"));
				const models = withoutFree.map(spec => spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, ""));
				const result = await spawnTask("long-1", priorityCtx(models), file);
				expect(result?.model?.[0]).toBe("codex-lb/gpt-6-luna:medium");
				expect(result?.model).toEqual([
					"codex-lb/gpt-6-luna:medium",
					...withoutFree.filter(spec => spec !== "codex-lb/gpt-6-luna:medium"),
				]);
				expect(result?.note).toContain("critical row");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("critical row keeps a free model first", async () => {
			const { dir, file } = tempStateFile();
			try {
				const result = await spawnTask("long-1", priorityCtx(), file);
				expect(result?.model).toEqual(TASK_ORDER);
				expect(result?.model?.[0]).toBe("openrouter/dots-studio/dots-3-note-preview:free");
				expect(result?.note).not.toContain("critical row");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("non-critical row keeps the existing order", async () => {
			const { dir, file } = tempStateFile();
			try {
				const result = await spawnTask("short-1", priorityCtx(), file);
				expect(result?.model).toEqual(TASK_ORDER);
				expect(result?.note).not.toContain("critical row");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("critical row without a priority-capable entry keeps the existing order", async () => {
			const { dir, file } = tempStateFile();
			try {
				// Unavailable models drop out of the order, so the chain holds
				// only non-priority entries with Qwen and cerebras last.
				const withoutPriority = TASK_ORDER.filter(
					spec => spec !== "codex-lb/gpt-6-luna:medium" && spec !== "codex-lb/gpt-6.1-sol:medium",
				);
				const context = priorityCtx(
					withoutPriority.map(spec => spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "")),
				);
				const result = await spawnTask("long-1", context, file);
				expect(result?.model).toEqual(withoutPriority);
				expect(result?.model?.slice(-2)).toEqual(["codex-lb/Qwen3.8-27B", "cerebras/qwen-3.8-27b"]);
				expect(result?.note).not.toContain("critical row");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

test("R3: internal control URIs bypass the empty-write guard so proc:// kill passes", async () => {
	const { dir } = tempStateFile();
	try {
		const call = toolCallHandler();
		const context = ctx({ cwd: dir });
		// The chief-of-staff runbook's exact kill call, with empty or omitted content.
		expect(
			await call(
				{ toolName: "write", input: { path: "proc://IntegrateFacilityCallouts/kill", content: "" } },
				context,
			),
		).toBeUndefined();
		expect(await call({ toolName: "write", input: { path: "proc://FixR8LastFails/kill" } }, context)).toBeUndefined();
		expect(await call({ toolName: "write", input: { path: "agent://Main", content: "" } }, context)).toBeUndefined();
		expect(
			await call({ toolName: "write", input: { path: "xd://report_issue", content: "" } }, context),
		).toBeUndefined();
		// Negative control: a real file keeps the guard.
		const refused = await call({ toolName: "write", input: { path: "empty.txt", content: "" } }, context);
		expect(refused).toMatchObject({ block: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
