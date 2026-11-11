import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { applyModelPreset, clearSessionModelPreset } from "../../src/config/model-presets";
import { resolveConfiguredModelPatterns } from "../../src/config/model-resolver";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { getRetryFallbackRole, installRetryFallbackRole } from "../../src/session/retry-fallback-chains";
import { SessionManager } from "../../src/session/session-manager";
import { installLiveModelPresetRefresh, runSubprocess } from "../../src/task/executor";

let runId = 0;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-live-preset-"));
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("mock", "test");
	registerMockApi("live-preset-test");
	cleanups.push(async () => {
		auth.close();
		unregisterCustomApis("live-preset-test");
		await fs.rm(cwd, { recursive: true, force: true });
	});
	const settings = Settings.isolated({
		modelRoles: { default: "mock/base", free: "mock/base, mock/base-tail" },
		modelPresets: { brrrr: { modelRoles: { free: "mock/preset, mock/preset-tail" } } },
		"task.isolation.enabled": false,
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.maxRetries": 0,
		"retry.usageAwareFallback": false,
	});
	const models = ["base", "base-tail", "preset", "preset-tail"].map(id =>
		createMockModel({ id, handler: () => ({ content: [id] }) }),
	);
	const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"));
	vi.spyOn(registry, "find").mockImplementation((provider, id) =>
		models.find(m => m.provider === provider && m.id === id),
	);
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	vi.spyOn(registry, "getAll").mockReturnValue(models);
	const parent = new AgentSession({
		agent: new Agent({ initialState: { model: models[0], systemPrompt: ["test"], tools: [], messages: [] } }),
		settings,
		modelRegistry: registry,
		sessionManager: SessionManager.inMemory(),
	});
	cleanups.push(() => parent.dispose());
	const apply = async () => {
		expect((await applyModelPreset(settings, parent, "brrrr", { scope: "session" })).kind).toBe("switched");
	};
	const run = async (pin = false, persist = false) => {
		const id = `PresetChild${++runId}`;
		cleanups.push(async () => {
			await AgentRegistry.global().get(id)?.session?.dispose();
			AgentRegistry.global().unregister(id);
		});
		const result = await runSubprocess({
			cwd,
			artifactsDir: persist ? cwd : undefined,
			settings,
			modelRegistry: registry,
			authStorage: auth,
			structured: false,
			noContextFiles: true,
			skills: [],
			rules: [],
			promptTemplates: [],
			agent: {
				name: "worker",
				description: "test",
				systemPrompt: "test",
				source: "bundled",
				tools: ["read"],
				model: ["@free"],
			},
			modelOverride: pin ? "mock/base" : resolveConfiguredModelPatterns("@free", settings),
			modelRole: pin ? undefined : "free",
			task: "Answer.",
			index: 0,
			id,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		const session = AgentRegistry.global().get(id)?.session;
		if (!(session instanceof AgentSession)) throw new Error(`expected an in-process session for ${id}`);
		return { ...result, id, session, entries: session.sessionManager.getEntries() };
	};
	return { cwd, settings, models, parent, registry, apply, run };
}

it("a live free child uses the new preset on its next failure fallback", async () => {
	const f = await fixture();
	f.models[0]!.push(async () => {
		await f.apply();
		return { stopReason: "error", errorMessage: "502 Bad Gateway" };
	});
	f.models[2]!.push({ stopReason: "error", errorMessage: "502 Bad Gateway" });
	const result = await f.run();
	expect(result.output).toBe("preset-tail");
	expect(f.models[1]!.calls).toHaveLength(0);
	expect(
		result.entries.some(
			entry => entry.type === "model_change" && entry.model === "mock/preset" && /brrrr/.test(entry.reason ?? ""),
		),
	).toBe(true);
});

it("a pinned child stays pinned while a role child follows the preset", async () => {
	const f = await fixture();
	f.models[0]!.push(async () => {
		await f.apply();
		return { content: [{ type: "toolCall", name: "read", arguments: { path: "missing" } }] };
	});
	expect((await f.run(true)).output).toBe("base");
	clearSessionModelPreset(f.settings);
	f.models[0]!.push(async () => {
		await f.apply();
		return { stopReason: "error", errorMessage: "502 Bad Gateway" };
	});
	expect((await f.run()).output).toBe("preset");
});

it("clearing the preset returns a live child to the base chain at the next turn", async () => {
	const f = await fixture();
	await f.apply();
	f.models[2]!.push(() => {
		clearSessionModelPreset(f.settings);
		return { content: [{ type: "toolCall", name: "read", arguments: { path: "missing" } }] };
	});
	expect((await f.run()).output).toBe("base");
});

it("clearing the preset restores the base chain on the next fallback", async () => {
	const f = await fixture();
	await f.apply();
	f.models[2]!.push(() => {
		clearSessionModelPreset(f.settings);
		return { stopReason: "error", errorMessage: "502 Bad Gateway" };
	});
	expect((await f.run()).output).toBe("base");
});

it("applying a preset switches a live role child before its next tool continuation", async () => {
	const f = await fixture();
	f.models[0]!.push(async () => {
		await f.apply();
		return { content: [{ type: "toolCall", name: "read", arguments: { path: "missing" } }] };
	});
	expect((await f.run()).output).toBe("preset");
});

it("aborting during a preset refresh never dispatches the cancelled prompt", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	f.parent.refreshModelSelection = async () => {
		entered.resolve();
		await release.promise;
		return false;
	};
	const prompt = f.parent.prompt("Answer.");
	await entered.promise;
	const abort = f.parent.abort();
	release.resolve();
	await Promise.all([prompt, abort]);
	expect(f.models.flatMap(model => model.calls)).toHaveLength(0);
});

it("same-model preset refresh lets recovery use the fallback chain immediately", async () => {
	const f = await fixture();
	f.settings.setModelRole("free", "mock/base, mock/base-tail");
	f.settings.overrideModelRoles({ default: "mock/base" });
	installLiveModelPresetRefresh(f.parent, f.settings, f.registry, "Same", "free");
	await f.apply();
	// This preset changes the role but selects the already-active model.
	f.settings.overrideModelRoles({ free: "mock/base, mock/base-tail" });
	expect(await f.parent.refreshModelSelection?.()).toBe(false);
});

it("a failed metadata refresh keeps the previous retry primary and chain", async () => {
	const f = await fixture();
	installLiveModelPresetRefresh(f.parent, f.settings, f.registry, "Failed", "free");
	await f.apply();
	const before = f.parent.settings.getModelRoles();
	vi.spyOn(f.registry, "refreshSelectedModelMetadata").mockRejectedValue(new Error("metadata unavailable"));
	await expect(f.parent.refreshModelSelection?.()).rejects.toThrow("metadata unavailable");
	expect(f.parent.settings.getModelRole("subagent:Failed")).toBe(before["subagent:Failed"]);
	expect(f.parent.model?.id).toBe("base");
});

it("a parked role child follows a preset cleared before revival", async () => {
	const f = await fixture();
	await f.apply();
	const child = await f.run(false, true);
	await AgentLifecycleManager.global().park(child.id);
	clearSessionModelPreset(f.settings);
	const revived = await AgentLifecycleManager.global().ensureLive(child.id);
	await revived.prompt("Answer again.");
	expect(revived.model?.id).toBe("base");
	expect(f.models[0]!.calls.length).toBeGreaterThan(0);
});

it("an installed retry role does not freeze roles inherited by nested workers", () => {
	const parent = Settings.isolated({ modelRoles: { default: "mock/base", smol: "mock/base" } });
	const child = parent.overlay({});
	installRetryFallbackRole(child, "subagent:Own", { primary: "mock/base", chain: [] });
	parent.overrideModelRoles({ smol: "mock/preset" });
	expect(child.getModelRole("smol")).toBe("mock/preset");
	expect(child.getModelRole("subagent:Own")).toBe("mock/base");
});

it("failure after switching the model retains its newly installed retry chain", async () => {
	const f = await fixture();
	installLiveModelPresetRefresh(f.parent, f.settings, f.registry, "After", "free");
	await f.apply();
	vi.spyOn(f.parent.sessionManager, "appendModelSelectionChange").mockImplementation(() => {
		throw new Error("record failed");
	});
	await expect(f.parent.refreshModelSelection?.()).rejects.toThrow("record failed");
	expect(f.parent.model?.id).toBe("preset");
	expect(getRetryFallbackRole(f.parent.settings, "subagent:After")).toEqual({
		primary: "mock/preset",
		chain: ["mock/preset-tail"],
	});
});
