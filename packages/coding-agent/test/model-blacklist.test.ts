import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dirs from "@oh-my-pi/pi-utils";
import { assertModelNotBlacklisted } from "@oh-my-pi/pi-ai/model-blacklist";
import { resolveSmolModel } from "../src/commit/model-selection";
import * as sdkModule from "../src/sdk";
import { TurnRecovery, type TurnRecoveryHost } from "../src/session/turn-recovery";
import { createAgentSession } from "../src/sdk";
import { roleCandidatePool } from "../src/config/model-roles";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	findInitialModel,
	findSmolModel,
	findSlowModel,
	parseModelPattern,
	pickDefaultAvailableModel,
	resolveCliModel,
	resolveModelFromSettings,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
	resolveModelRoleValue,
	resolveModelScope,
	resolveRoleChain,
	resolveRoleSelection,
} from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import type { ToolSession } from "../src/tools";
import { resolveImageQuestionModel } from "../src/utils/image-question";
import { describeAttachedImagesForTextModel } from "../src/utils/image-vision-fallback";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AuthStorage } from "../src/session/auth-storage";

import { createAgentsHubDeps } from "../src/modes/agents-hub-deps";
import { collectOnlineTinyCandidates, expandOnlineTinyModelFallbacks } from "../src/tiny/online-candidates";

let dir: string;
let auth: AuthStorage;
let rootSpy: { mockRestore(): void };
beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-blacklist-registry-"));
	rootSpy = spyOn(dirs, "getBaseConfigRoot").mockReturnValue(dir);
	auth = await AuthStorage.create(":memory:");
});
afterEach(() => {
	auth.close();
	rootSpy.mockRestore();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("owner ban wins over re-added custom catalog, refresh, direct lookup and available role candidates", async () => {
	const file = path.join(dir, "models.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			providers: {
				"canary.provider": {
					baseUrl: "http://127.0.0.1:1",
					api: "openai-completions",
					apiKey: "fixture-only",
					models: [{ id: "convicted" }, { id: "convicted-small" }],
				},
			},
		}),
	);
	const registry = new ModelRegistry(auth, file);
	expect(registry.find("canary.provider", "convicted")?.id).toBe("convicted");
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({ "canary.provider/convicted": "fabricated receipt" }),
	);
	for (const models of [
		registry.getAll(),
		registry.getAvailableForProviders(new Set(["canary.provider"])),
		registry.getProviderModels("canary.provider"),
	]) {
		expect(models.some(m => m.provider === "canary.provider" && m.id === "convicted")).toBe(false);
		expect(models.some(m => m.provider === "canary.provider" && m.id === "convicted-small")).toBe(true);
	}
	const bannedSnapshot = registry.getAll();
	expect(registry.getAll()).toBe(bannedSnapshot);
	fs.rmSync(path.join(dir, "model-blacklist.json"));
	const restoredSnapshot = registry.getAll();
	expect(restoredSnapshot.some(model => model.provider === "canary.provider" && model.id === "convicted")).toBe(true);
	expect(registry.getAll()).toBe(restoredSnapshot);
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({ "canary.provider/convicted": "fabricated receipt" }),
	);
	expect(registry.getAll().some(model => model.provider === "canary.provider" && model.id === "convicted")).toBe(
		false,
	);
	expect(registry.find("canary.provider", "convicted")).toBeUndefined();
	await registry.refresh("offline");
	expect(registry.find("canary.provider", "convicted")).toBeUndefined();
	expect(registry.find("canary.provider", "convicted-small")?.id).toBe("convicted-small");
});

const bannedSelector = "canary.provider/lab/convicted:free";
const allowedSelector = `${bannedSelector}-small`;
const candidates = ["lab/convicted:free", "lab/convicted:free-small"].map(id =>
	buildModel({
		provider: "canary.provider",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	}),
);

function banResolverModel(): void {
	fs.writeFileSync(path.join(dir, "model-blacklist.json"), JSON.stringify({ [bannedSelector]: "fixture safety ban" }));
}

test("explicit banned selectors reject before fuzzy neighbors, thinking parsing, or override fallback", () => {
	banResolverModel();
	const available = candidates.slice(1);
	const registry = { getAll: () => available, getAvailable: () => available };
	for (const selector of [bannedSelector, `${bannedSelector}:high`, "lab/convicted:free"]) {
		expect(() => parseModelPattern(selector, available)).toThrow("fixture safety ban");
		expect(() => resolveModelFromString(selector, available)).toThrow("fixture safety ban");
		expect(() => resolveModelOverride([selector, allowedSelector], registry)).toThrow("fixture safety ban");
		const cli = resolveCliModel({ cliModel: selector, modelRegistry: registry });
		expect(cli.model).toBeUndefined();
		expect(cli.error).toContain("fixture safety ban");
	}
	expect(
		resolveCliModel({ cliProvider: "canary.provider", cliModel: "lab/convicted:free:high", modelRegistry: registry })
			.error,
	).toContain("fixture safety ban");
	expect(resolveModelOverride([allowedSelector], registry).model?.id).toBe(candidates[1].id);
	expect(resolveCliModel({ cliModel: allowedSelector, modelRegistry: registry }).model?.id).toBe(candidates[1].id);
});

test("roles skip banned exact candidates instead of fuzzy substitution and retain permitted fallback order", async () => {
	banResolverModel();
	const settings = Settings.isolated({
		modelRoles: { task: [bannedSelector, allowedSelector], default: bannedSelector },
		"retry.fallbackChains": { task: [bannedSelector, allowedSelector] },
	});
	expect(resolveModelRoleValue(bannedSelector, candidates).model).toBeUndefined();
	expect(resolveModelRoleValue("@task", candidates, { settings }).matchedPatternIndex).toBe(1);
	expect(resolveRoleSelection(["default", "task"], settings, candidates)?.role).toBe("task");
	expect(resolveModelOverride(["@task"], { getAvailable: () => candidates }, settings).model?.id).toBe(
		candidates[1].id,
	);
	expect(resolveRoleChain("task", settings, candidates).map(entry => entry.model.id)).toEqual([candidates[1].id]);
	expect(resolveModelFromSettings({ settings, availableModels: candidates, roleOrder: ["default", "task"] })?.id).toBe(
		candidates[1].id,
	);
	expect(
		(await resolveModelScope(["canary.provider/lab/*"], { getAvailable: () => candidates })).map(
			entry => entry.model.id,
		),
	).toEqual([candidates[1].id]);
	expect(pickDefaultAvailableModel(candidates)?.id).toBe(candidates[1].id);
	expect(pickDefaultAvailableModel([candidates[0]])).toBeUndefined();
});

test("startup excludes a newly banned scoped model and saved default without restoring it", async () => {
	banResolverModel();
	const registry = {
		getAvailable: () => candidates,
		find: (provider: string, id: string) => candidates.find(model => model.provider === provider && model.id === id),
		hasConcreteAuth: () => true,
	};
	const result = await findInitialModel({
		scopedModels: [{ model: candidates[0], explicitThinkingLevel: false }],
		isContinuing: false,
		defaultProvider: "canary.provider",
		defaultModelId: candidates[0].id,
		modelRegistry: registry,
	});
	expect(result.model?.id).toBe(candidates[1].id);
	await expect(
		findInitialModel({
			cliProvider: "canary.provider",
			cliModel: candidates[0].id,
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		}),
	).rejects.toThrow("fixture safety ban");
});

test("provider-qualified bans preserve other providers and exact model case", () => {
	const models = [
		{ ...candidates[0], provider: "openrouter", id: "native/Foo" },
		{ ...candidates[0], provider: "native", id: "Foo" },
		{ ...candidates[0], provider: "native", id: "foo" },
	];
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({ "openrouter/native/Foo": "router ban", "native/Foo": "case ban" }),
	);
	expect(() => resolveModelFromString("native/Foo", models)).toThrow("case ban");
	expect(resolveModelFromString("NATIVE/foo", models)?.id).toBe("foo");
	fs.writeFileSync(path.join(dir, "model-blacklist.json"), JSON.stringify({ "openrouter/native/Foo": "router ban" }));
	expect(resolveModelFromString("native/Foo", models)?.provider).toBe("native");
	expect(() => resolveModelFromString("openrouter/native/Foo", models)).toThrow("router ban");
});

test("exact routed ban cannot fall through to a permitted base in a role", () => {
	const model = { ...candidates[0], provider: "openrouter", id: "lab/model" };
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({ "openrouter/lab/model@host": "route ban" }),
	);
	expect(resolveModelRoleValue("openrouter/lab/model@host", [model]).model).toBeUndefined();
	expect(resolveModelRoleValue("openrouter/lab/model", [model]).model?.id).toBe("lab/model");
});

test("registry route aliases cannot restore a banned catalog model", () => {
	const file = path.join(dir, "models.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			providers: {
				openrouter: {
					baseUrl: "http://127.0.0.1:1",
					api: "openai-completions",
					apiKey: "fixture",
					models: [{ id: "lab/example" }],
				},
			},
		}),
	);
	const registry = new ModelRegistry(auth, file);
	const alias = registry.find("openrouter", "lab/example:nitro")!;
	expect(alias.id).toBe("lab/example:nitro");
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({ "openrouter/lab/example": "catalog ban" }),
	);
	expect(registry.find("openrouter", "lab/example:nitro")).toBeUndefined();
	expect(() => assertModelNotBlacklisted(alias)).toThrow("catalog ban");
	expect(() => assertModelNotBlacklisted(JSON.parse(JSON.stringify(alias)))).toThrow("catalog ban");
});

test("automatic image questions skip a banned vision role and use the permitted default", () => {
	banResolverModel();
	const models = candidates.map(model => ({ ...model, input: ["text", "image"] as ("text" | "image")[] }));
	const settings = Settings.isolated({ modelRoles: { vision: bannedSelector, default: allowedSelector } });
	const session = { settings, modelRegistry: { getAvailable: () => models.slice(1) } } as unknown as ToolSession;
	expect(resolveImageQuestionModel(session).model.id).toBe(candidates[1].id);
});

test("automatic attached-image descriptions skip a banned vision role", async () => {
	banResolverModel();
	const model = { ...candidates[1], input: ["text", "image"] as ("text" | "image")[] };
	const mock = createMockModel();
	mock.push({ content: ["a colored square"] });
	const blocks = await describeAttachedImagesForTextModel(
		[
			{
				type: "image",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				mimeType: "image/png",
			},
		],
		{
			activeModel: candidates[0],
			activeModelString: bannedSelector,
			settings: Settings.isolated({ modelRoles: { vision: bannedSelector, default: allowedSelector } }),
			modelRegistry: {
				getAvailable: () => [model],
				getApiKey: async () => "fixture",
				resolver: () => async () => "fixture",
			} as unknown as ModelRegistry,
			localProtocolOptions: { getArtifactsDir: () => dir, getSessionId: () => "fixture" },
			completeImpl: async (selected, context, options) => {
				expect(selected.id).toBe(model.id);
				return mock.stream(selected, context, options).result();
			},
		},
	);
	expect(blocks[0]?.text).toContain("a colored square");
});

test("automatic retry walks past a banned concrete chain entry", async () => {
	await initTheme();
	const primary = { ...candidates[1], id: "primary" };
	const mock = createMockModel();
	const requested: string[] = [];
	const agent = new Agent({
		getApiKey: () => "fixture",
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			requested.push(model.id);
			mock.push(
				model.id === primary.id
					? { throw: "overloaded_error: provider returned error 503" }
					: { content: ["recovered"] },
			);
			return mock.stream(model, context, options);
		},
	});
	banResolverModel();
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.fallbackChains": { default: [bannedSelector, allowedSelector] },
		modelRoles: { default: `${primary.provider}/${primary.id}` },
	});
	auth.keys.setRuntime(primary.provider, "fixture");
	const registry = new ModelRegistry(auth, path.join(dir, "missing-models.json"));
	spyOn(registry, "getAvailable").mockReturnValue([primary, candidates[1]]);
	spyOn(registry, "find").mockImplementation((provider, id) =>
		[primary, candidates[1]].find(model => model.provider === provider && model.id === id),
	);
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: registry,
	});
	try {
		await session.prompt("recover");
		await session.waitForIdle();
		expect(requested).toEqual([primary.id, candidates[1].id]);
	} finally {
		await session.dispose();
	}
});

test("automatic widget selection keeps an authenticated role when built-in smol defaults are banned", async () => {
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({ "anthropic/claude-haiku-5-5": "default ban" }),
	);
	const settings = Settings.isolated({ modelRoles: { widget: allowedSelector } });
	const registry = {
		getAvailable: () => candidates.slice(1),
		getApiKey: async () => "fixture",
	} as unknown as ModelRegistry;
	// Widget requests walk this chain in order, skipping candidates without a credential.
	const chain = resolveRoleChain("widget", settings, roleCandidatePool("widget", settings, registry));
	expect(chain[0]?.model.id).toBe(candidates[1].id);
});

test("automatic commit selection skips banned built-in smol models and keeps its primary fallback", async () => {
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({ "anthropic/claude-haiku-5-5": "smol ban" }),
	);
	const registry = new ModelRegistry(auth, path.join(dir, "missing-models.json"));
	spyOn(registry, "getAvailable").mockReturnValue(candidates.slice(1));
	const selected = await resolveSmolModel(Settings.isolated({}), registry, candidates[1], "fallback-key");
	expect(selected.model.id).toBe(candidates[1].id);
	expect(selected.apiKey).toBe("fallback-key");
});

test("startup retry chain skips its banned original and intermediate candidates", async () => {
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({
			"canary.provider/primary": "primary ban",
			[bannedSelector]: "intermediate ban",
		}),
	);
	const settings = Settings.isolated({
		"retry.modelFallback": true,
		"retry.fallbackChains": { default: [bannedSelector, allowedSelector] },
		modelRoles: { default: "canary.provider/primary" },
	});
	auth.keys.setRuntime("canary.provider", "fixture");
	const registry = new ModelRegistry(auth, path.join(dir, "missing-models.json"));
	registry.registerProvider("canary.provider", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		apiKey: "fixture",
		models: candidates.map(({ id, name, reasoning, input, cost }) => ({
			id,
			name,
			reasoning,
			input,
			cost,
			contextWindow: 8192,
			maxTokens: 1024,
		})),
	});
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		authStorage: auth,
		modelRegistry: registry,
		settings,
		sessionManager: SessionManager.inMemory(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
		preloadedCustomToolPaths: [],
		toolNames: ["read"],
	});
	try {
		expect(session.model?.id).toBe(candidates[1].id);
		expect(modelFallbackMessage).toBeUndefined();
	} finally {
		await session.dispose();
	}
});

for (const provider of ["openrouter", "vercel-ai-gateway"]) {
	test(`${provider} retained routes enforce live route bans while permitting the base and other routes`, () => {
		const base = { ...candidates[0], provider, id: "lab/model" };
		const routed = resolveModelFromString(`${provider}/lab/model@host`, [base])!;
		const otherRoute = resolveModelFromString(`${provider}/lab/model@other`, [base])!;
		expect(routed.id).toBe("lab/model");
		fs.writeFileSync(
			path.join(dir, "model-blacklist.json"),
			JSON.stringify({ [`${provider}/lab/model@host`]: "live route ban" }),
		);
		expect(() => assertModelNotBlacklisted(routed)).toThrow("live route ban");
		expect(() => assertModelNotBlacklisted(JSON.parse(JSON.stringify(routed)))).toThrow("live route ban");
		expect(resolveModelFromString(`${provider}/lab/model`, [base])?.id).toBe(base.id);
		assertModelNotBlacklisted(otherRoute);
		fs.writeFileSync(
			path.join(dir, "model-blacklist.json"),
			JSON.stringify({ [`${provider}/lab/model`]: "base ban" }),
		);
		expect(() => assertModelNotBlacklisted(routed)).toThrow("base ban");
	});
}

for (const { scenario, contract } of [
	{ scenario: "later role candidate", contract: "deferred SDK roles ignore a denied later candidate" },
	{ scenario: "role retry chain", contract: "deferred SDK roles skip denied primaries and retry entries" },
	{ scenario: "explicit concrete", contract: "deferred SDK explicit concrete requests retain owner-ban rejection" },
	{ scenario: "auth fallback", contract: "deferred SDK authentication fallback skips a denied selector" },
] as const) {
	test(contract, async () => {
		banResolverModel();
		const settings = Settings.isolated({
			"retry.modelFallback": true,
			modelRoles: { task: scenario === "role retry chain" ? bannedSelector : [allowedSelector, bannedSelector] },
			"retry.fallbackChains": { task: [bannedSelector, allowedSelector] },
		});
		auth.keys.setRuntime("canary.provider", "fixture");
		const registry = new ModelRegistry(auth, path.join(dir, "missing-models.json"));
		registry.registerProvider("canary.provider", {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "fixture",
			models: candidates.map(({ id, name, reasoning, input, cost }) => ({
				id,
				name,
				reasoning,
				input,
				cost,
				contextWindow: 8192,
				maxTokens: 1024,
			})),
		});
		if (scenario === "auth fallback") spyOn(registry, "getApiKey").mockResolvedValue(undefined);
		const creation = createAgentSession({
			cwd: dir,
			agentDir: dir,
			authStorage: auth,
			modelRegistry: registry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern:
				scenario === "explicit concrete"
					? bannedSelector
					: scenario === "auth fallback"
						? allowedSelector
						: "@task",
			modelPatternAuthFallback: scenario === "auth fallback" ? bannedSelector : undefined,
		});
		if (scenario === "explicit concrete") {
			await expect(creation).rejects.toThrow("fixture safety ban");
			return;
		}
		const { session } = await creation;
		try {
			expect(session.model?.id).toBe(candidates[1].id);
		} finally {
			await session.dispose();
		}
	});
}

test("online tiny walks past banned fallbacks and retains the healthy primary", () => {
	banResolverModel();
	const primary = candidates[1];
	const settings = Settings.isolated({
		modelRoles: { tiny: allowedSelector },
		"retry.fallbackChains": { tiny: [bannedSelector], [allowedSelector]: [bannedSelector] },
	});
	expect(collectOnlineTinyCandidates(["tiny"], settings, candidates).map(entry => entry.model.id)).toEqual([
		primary.id,
	]);
	expect(expandOnlineTinyModelFallbacks(primary, settings, candidates).map(model => model.id)).toEqual([primary.id]);
});

for (const scenario of ["later role candidate", "parent fallback", "banned parent"] as const) {
	test(`subagent authentication fallback skips bans with ${scenario}`, async () => {
		banResolverModel();
		const primary = candidates[1];
		const fallback = { ...primary, id: "permitted-fallback", name: "permitted fallback" };
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const authRequests: string[] = [];
		const registry = {
			getAvailable: () => [primary, fallback],
			getApiKey: async (model: typeof primary) => {
				authRequests.push(model.id);
				return model.id === fallback.id ? "fixture-key" : undefined;
			},
		};
		const settings = Settings.isolated({
			modelRoles: {
				task: [
					allowedSelector,
					...(scenario === "banned parent" ? [] : [bannedSelector]),
					...(scenario === "later role candidate" ? [fallbackSelector] : []),
				],
			},
		});
		const result = await resolveModelOverrideWithAuthFallback(
			["@task"],
			scenario === "banned parent" ? bannedSelector : fallbackSelector,
			registry,
			settings,
		);
		expect(result.model?.id).toBe(scenario === "banned parent" ? primary.id : fallback.id);
		expect(result.authFallbackUsed).toBe(scenario === "parent fallback");
		expect(authRequests).not.toContain(candidates[0].id);
		await expect(
			resolveModelOverrideWithAuthFallback([bannedSelector], fallbackSelector, registry, settings),
		).rejects.toThrow("fixture safety ban");
	});
}

test("agents hub previews stale banned selectors as unavailable and keeps allowed alternatives inspectable", () => {
	banResolverModel();
	const registry = new ModelRegistry(auth, path.join(dir, "missing-models.json"));
	spyOn(registry, "getAvailable").mockReturnValue(candidates.slice(1));
	const deps = createAgentsHubDeps(
		dir,
		Settings.isolated({ modelRoles: { task: [bannedSelector, allowedSelector] } }),
		registry,
		() => {
			throw new Error("Preview must not discover extensions");
		},
	);
	expect(deps.resolvePatterns([bannedSelector])).toBeUndefined();
	expect(deps.resolvePatterns([bannedSelector, allowedSelector])).toBe(allowedSelector);
	expect(deps.resolvePatterns(["@task"])).toBe(allowedSelector);
	expect(() => resolveModelOverride([bannedSelector], registry)).toThrow("fixture safety ban");
});

test("a banned advisor roster entry stays unavailable without disabling the permitted advisor or primary", async () => {
	banResolverModel();
	const primary = createMockModel({ handler: { content: ["primary complete"] } });
	const advisor = createMockModel({ handler: { content: ["advisor complete"] } });
	const requested: string[] = [];
	const registry = new ModelRegistry(auth, path.join(dir, "missing-models.json"));
	spyOn(registry, "getAvailable").mockReturnValue(candidates.slice(1));
	spyOn(registry, "getApiKey").mockResolvedValue("fixture-key");
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: candidates[1], systemPrompt: ["fixture"], tools: [], messages: [] },
			streamFn: primary.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		modelRegistry: registry,
		settings: Settings.isolated({ "advisor.enabled": true, "advisor.syncBacklog": "1", "compaction.enabled": false }),
		advisorConfigs: [
			{ name: "Denied", model: bannedSelector },
			{ name: "Permitted", model: allowedSelector },
		],
		advisorTools: { names: () => [], create: () => ({ tools: [] }) },
		advisorStreamFn: (model, context, options) => {
			requested.push(model.id);
			return advisor.stream(model, context, options);
		},
	});
	try {
		expect(session.getAdvisorStatusOverview().advisors.map(({ name, status }) => ({ name, status }))).toEqual([
			{ name: "Denied", status: "no_model" },
			{ name: "Permitted", status: "running" },
		]);
		await session.prompt("work");
		await session.waitForIdle();
		expect(await session.waitForAdvisorCatchup(5000)).toBe(true);
		expect(requested).toEqual([candidates[1].id]);
		expect(session.state.messages.some(message => message.role === "assistant")).toBe(true);
	} finally {
		await session.dispose();
	}
});

for (const resolve of [findSmolModel, findSlowModel]) {
	test(`${resolve.name} skips a banned saved model and keeps the permitted automatic candidate`, async () => {
		banResolverModel();
		const registry = { getAvailable: () => candidates };
		expect((await resolve(registry, bannedSelector))?.id).toBe(candidates[1].id);
		expect((await resolve(registry, allowedSelector))?.id).toBe(candidates[1].id);
	});
}

test("retry chain lookup ignores a stale banned live role assignment", () => {
	banResolverModel();
	const registry = new ModelRegistry(auth, path.join(dir, "missing-models.json"));
	const settings = Settings.isolated({
		modelRoles: { task: bannedSelector },
		"retry.fallbackChains": { default: [allowedSelector] },
	});
	const recovery = new TurnRecovery(
		{
			model: () => candidates[1],
			settings,
			modelRegistry: registry,
			sessionManager: { getLastModelChangeRole: () => "task" },
		} as unknown as TurnRecoveryHost,
		{ deferFallbackChainValidation: true },
	);
	expect(recovery.resolveRetryFallbackRole(allowedSelector)).toBe("default");
});

test("agent generation skips a banned configured default and uses an available model", async () => {
	banResolverModel();
	const registry = new ModelRegistry(auth, path.join(dir, "missing-models.json"));
	spyOn(registry, "refresh").mockResolvedValue();
	spyOn(registry, "getApiKey").mockResolvedValue("fixture-key");
	spyOn(registry, "getAvailable").mockReturnValue(candidates.slice(1));
	const mock = createMockModel({ handler: { content: ["generated specification"] } });
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: candidates[1], systemPrompt: ["fixture"], tools: [], messages: [] },
			streamFn: mock.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
	});
	const creation = spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		expect(options?.model?.id).toBe(candidates[1].id);
		return { session } as never;
	});
	const deps = createAgentsHubDeps(
		dir,
		Settings.isolated({ modelRoles: { default: bannedSelector } }),
		registry,
		() => {
			throw new Error("No discovery");
		},
	);
	try {
		expect(await deps.generateAgent("fixture", () => {})).toBe("generated specification");
	} finally {
		creation.mockRestore();
		await session.dispose();
	}
});
