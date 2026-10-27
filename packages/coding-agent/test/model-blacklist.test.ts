import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dirs from "@oh-my-pi/pi-utils";
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
				"canary-provider": {
					baseUrl: "http://127.0.0.1:1",
					api: "openai-completions",
					apiKey: "fixture-only",
					models: [{ id: "convicted" }, { id: "convicted-small" }],
				},
			},
		}),
	);
	const registry = new ModelRegistry(auth, file);
	expect(registry.find("canary-provider", "convicted")?.id).toBe("convicted");
	fs.writeFileSync(
		path.join(dir, "model-blacklist.json"),
		JSON.stringify({ "canary-provider/convicted": "fabricated receipt" }),
	);
	for (const models of [
		registry.getAll(),
		registry.getAvailableForProviders(new Set(["canary-provider"])),
		registry.getProviderModels("canary-provider"),
	]) {
		expect(models.some(m => m.provider === "canary-provider" && m.id === "convicted")).toBe(false);
		expect(models.some(m => m.provider === "canary-provider" && m.id === "convicted-small")).toBe(true);
	}
	expect(registry.find("canary-provider", "convicted")).toBeUndefined();
	await registry.refresh("offline");
	expect(registry.find("canary-provider", "convicted")).toBeUndefined();
	expect(registry.find("canary-provider", "convicted-small")?.id).toBe("convicted-small");
});
