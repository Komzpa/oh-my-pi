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
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { runSubprocess } from "../../src/task/executor";

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
	const run = async (pin = false) => {
		const id = `PresetChild${++runId}`;
		cleanups.push(async () => {
			await AgentRegistry.global().get(id)?.session?.dispose();
			AgentRegistry.global().unregister(id);
		});
		const result = await runSubprocess({
			cwd,
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
		return { ...result, entries: session.sessionManager.getEntries() };
	};
	return { cwd, settings, models, parent, apply, run };
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
