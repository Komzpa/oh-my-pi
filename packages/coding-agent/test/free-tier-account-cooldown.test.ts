import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelOverrideWithAuthFallback } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// The exact error a `gate-runner` worker drew from the OpenRouter free pool (2026-10-28).
const FREE_DAILY_LIMIT_ERROR = "429 Rate limit exceeded: free-models-per-day-high-balance. retry-after-ms=57552552";

describe("account-wide free-tier daily limit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let drawn: Model<Api>;
	let siblingFree: Model<Api>;
	let paid: Model<Api>;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-free-tier-cooldown-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("openrouter", "openrouter-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const models = [
			getBundledModel("openrouter", "cohere/north-mini-code:free"),
			getBundledModel("openrouter", "arcee-ai/trinity-mini:free"),
			getBundledModel("openai", "gpt-4o-mini"),
		];
		if (models.some(model => !model)) throw new Error("Expected bundled test models to exist");
		[drawn, siblingFree, paid] = models as Model<Api>[];
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	async function hitDailyLimitOn(model: Model<Api>, chain: string[]): Promise<string[]> {
		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (m, context, options) => {
				requestedModels.push(`${m.provider}/${m.id}`);
				if (m.provider === model.provider && m.id === model.id) mock.push({ throw: FREE_DAILY_LIMIT_ERROR });
				else mock.push({ content: [`ok:${m.provider}/${m.id}`] });
				return mock.stream(m, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: chain },
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		await session.prompt("hit the daily limit");
		await session.waitForIdle();
		return requestedModels;
	}

	it("skips every sibling :free model in the retry chain", async () => {
		const requested = await hitDailyLimitOn(drawn, [
			`${siblingFree.provider}/${siblingFree.id}`,
			`${paid.provider}/${paid.id}`,
		]);
		expect(requested).toEqual([`${drawn.provider}/${drawn.id}`, `${paid.provider}/${paid.id}`]);
	});

	it("suppresses every openrouter :free selector but no paid or foreign one", async () => {
		await hitDailyLimitOn(drawn, [`${paid.provider}/${paid.id}`]);
		expect(modelRegistry.isSelectorSuppressed(`${drawn.provider}/${drawn.id}`)).toBe(true);
		expect(modelRegistry.isSelectorSuppressed(`${siblingFree.provider}/${siblingFree.id}`)).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openrouter/some/never-seen-model:free")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openrouter/anthropic/claude-haiku-5-5")).toBe(false);
		expect(modelRegistry.isSelectorSuppressed(`${paid.provider}/${paid.id}`)).toBe(false);
	});

	it("draws the next chain entry for a new task and for a redispatch of the same row", async () => {
		await hitDailyLimitOn(drawn, [`${paid.provider}/${paid.id}`]);
		const registry = {
			getAvailable: () => [drawn, siblingFree, paid],
			getApiKey: async () => kNoAuth,
			isSelectorSuppressed: (selector: string) => modelRegistry.isSelectorSuppressed(selector),
		};
		// "@free-no-dots, @fast" expanded: the pool order puts :free members first.
		const patterns = [
			`${siblingFree.provider}/${siblingFree.id}`,
			`${drawn.provider}/${drawn.id}`,
			`${paid.provider}/${paid.id}`,
		];
		for (const sessionId of ["CaptureRecoveryBehavior", "CaptureRecoveryBehavior-2", "CaptureRecoveryBehavior-3"]) {
			const selected = await resolveModelOverrideWithAuthFallback(
				patterns,
				undefined,
				registry,
				undefined,
				sessionId,
			);
			expect(`${selected.model?.provider}/${selected.model?.id}`).toBe(`${paid.provider}/${paid.id}`);
		}
	});

	it("still returns a :free model when the whole chain is cooling down", async () => {
		await hitDailyLimitOn(drawn, [`${paid.provider}/${paid.id}`]);
		const registry = {
			getAvailable: () => [drawn, siblingFree],
			getApiKey: async () => kNoAuth,
			isSelectorSuppressed: (selector: string) => modelRegistry.isSelectorSuppressed(selector),
		};
		const selected = await resolveModelOverrideWithAuthFallback(
			[`${siblingFree.provider}/${siblingFree.id}`],
			undefined,
			registry,
		);
		expect(selected.model?.id).toBe(siblingFree.id);
	});
});
