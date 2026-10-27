import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dirs from "@oh-my-pi/pi-utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	findInitialModel,
	parseModelPattern,
	pickDefaultAvailableModel,
	resolveCliModel,
	resolveModelFromSettings,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelRoleValue,
	resolveModelScope,
	resolveRoleChain,
	resolveRoleSelection,
} from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";

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
	expect(registry.find("canary.provider", "convicted")).toBeUndefined();
	await registry.refresh("offline");
	expect(registry.find("canary.provider", "convicted")).toBeUndefined();
	expect(registry.find("canary.provider", "convicted-small")?.id).toBe("convicted-small");
});

const bannedSelector = "canary.provider/lab/convicted:free";
const allowedSelector = `${bannedSelector}-small`;
const candidates = ["lab/convicted:free", "lab/convicted:free-small"].map(id =>
	buildModel({
		provider: "canary.provider", id, name: id, api: "openai-completions",
		baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
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
	expect(resolveCliModel({ cliProvider: "canary.provider", cliModel: "lab/convicted:free:high", modelRegistry: registry }).error).toContain("fixture safety ban");
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
	expect(resolveModelOverride(["@task"], { getAvailable: () => candidates }, settings).model?.id).toBe(candidates[1].id);
	expect(resolveRoleChain("task", settings, candidates).map(entry => entry.model.id)).toEqual([candidates[1].id]);
	expect(resolveModelFromSettings({ settings, availableModels: candidates, roleOrder: ["default", "task"] })?.id).toBe(candidates[1].id);
	expect((await resolveModelScope(["canary.provider/lab/*"], { getAvailable: () => candidates })).map(entry => entry.model.id)).toEqual([candidates[1].id]);
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
		scopedModels: [{ model: candidates[0], explicitThinkingLevel: false }], isContinuing: false,
		defaultProvider: "canary.provider", defaultModelId: candidates[0].id, modelRegistry: registry,
	});
	expect(result.model?.id).toBe(candidates[1].id);
	await expect(findInitialModel({
		cliProvider: "canary.provider", cliModel: candidates[0].id,
		scopedModels: [], isContinuing: false, modelRegistry: registry,
	})).rejects.toThrow("fixture safety ban");
});
