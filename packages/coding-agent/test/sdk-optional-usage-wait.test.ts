import { Database } from "bun:sqlite";
import { afterEach, expect, test, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

afterEach(() => vi.restoreAllMocks());

test("four child launches do not wait for optional quota HTTP while parent discovery is busy", async () => {
	using dir = TempDir.createSync("omp-sdk-optional-wait-");
	let requests = 0;
	const releaseHttp = Promise.withResolvers<void>();
	const discoveryStarted = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests++;
			if (new URL(request.url).pathname === "/models") discoveryStarted.resolve();
			await releaseHttp.promise;
			return Response.json({ models: [] });
		},
	});
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: provider =>
			provider === "anthropic"
				? {
						id: provider,
						async fetchUsage(params) {
							const response = await fetch(new URL("usage", server.url), { signal: params.signal });
							await response.json();
							return null;
						},
					}
				: undefined,
	});
	await auth.credentials.set("anthropic", [
		{ type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 60000, accountId: "fixture" },
	]);
	const registry = new ModelRegistry(auth, dir.join("models.yml"), { cacheDbPath: dir.join("models.db") });
	registry.registerProvider("slow-discovery", {
		baseUrl: server.url.toString(),
		api: "openai-completions",
		fetchDynamicModels: async () => {
			const response = await fetch(new URL("models", server.url));
			await response.json();
			return [];
		},
	});
	const settings = Settings.isolated({
		"retry.usageAwareFallback": true,
		"retry.modelFallback": true,
		"retry.usageReservePolicy": "auto",
	});
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	const logs = vi.spyOn(logger, "debug").mockImplementation(() => {});
	const common = {
		cwd: dir.path(),
		agentDir: dir.join("agent"),
		settings,
		modelRegistry: registry,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: [],
		systemPrompt: ["fixture"],
	};
	const sessions: AgentSession[] = [];
	let refresh: Promise<void> | undefined;
	try {
		const { session: parent } = await createAgentSession({
			...common,
			model: { ...primary, baseUrl: server.url.toString() },
			sessionManager: SessionManager.inMemory(dir.path()),
		});
		sessions.push(parent);
		let discoverySettled = false;
		refresh = registry.refreshRuntimeProviders("online").finally(() => {
			discoverySettled = true;
		});
		await discoveryStarted.promise;
		const started = performance.now();
		const children = await Promise.all(
			Array.from({ length: 4 }, (_, i) =>
				createAgentSession({
					...common,
					settings: settings.overlay({}),
					parentTaskPrefix: `optional-wait-${i}`,
					taskDepth: 1,
					sessionManager: SessionManager.inMemory(dir.path()),
					modelPattern: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
				}).then(created => {
					sessions.push(created.session);
					return created;
				}),
			),
		);
		const elapsed = performance.now() - started;
		console.log(
			JSON.stringify({
				elapsedMs: elapsed,
				sdkCreateMs: logs.mock.calls
					.filter(c => c[0] === "subagent launch spans")
					.map(c =>
						((c[1]?.spans ?? []) as Array<{ name: string; wallMs: number }>).filter(s =>
							["sdkCreate", "sdk.usageHealth.wait", "resolveModelDiscoveryDeferredRetry"].includes(s.name),
						),
					),
				requests,
			}),
		);
		expect(requests).toBeGreaterThanOrEqual(2);
		expect(children.map(c => c.session.model?.id)).toEqual(Array(4).fill(primary.id));
		expect(elapsed).toBeLessThan(1200);
		expect(discoverySettled).toBe(false);
	} finally {
		// End fixture I/O before disposing sessions that share its registry.
		releaseHttp.resolve();
		try {
			await refresh;
			await Promise.all(sessions.map(session => session.dispose()));
		} finally {
			await server.stop(true);
			auth.close();
		}
	}
}, 15000);

test("explicit fail-closed quota policy still awaits and rejects a depleted child", async () => {
	using dir = TempDir.createSync("omp-sdk-required-quota-");
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth, dir.join("models.yml"), { cacheDbPath: dir.join("models.db") });
	const health = vi.spyOn(auth.health, "model").mockImplementation(async () => {
		await Bun.sleep(400);
		return { state: "depleted", accounts: [] };
	});
	const started = performance.now();
	try {
		await expect(
			createAgentSession({
				cwd: dir.path(),
				agentDir: dir.join("agent"),
				modelRegistry: registry,
				settings: Settings.isolated({
					"retry.usageAwareFallback": true,
					"retry.usageReservePolicy": "fail-closed",
				}),
				parentTaskPrefix: "required-quota",
				taskDepth: 1,
				sessionManager: SessionManager.inMemory(dir.path()),
				modelPattern: "anthropic/claude-sonnet-4-5",
				disableExtensionDiscovery: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: [],
				systemPrompt: ["fixture"],
			}),
		).rejects.toThrow("reserve policy is fail-closed");
		expect(health).toHaveBeenCalledTimes(1);
		expect(performance.now() - started).toBeGreaterThanOrEqual(400);
	} finally {
		auth.close();
	}
});
