import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";
import spacing from "../src/prompts/system/normal-prose-spacing.md" with { type: "text" };

import { assistantMsg, userMsg } from "./utilities";

const advice = spacing.trim();
const reference = getBundledModel("openai", "gpt-5");
function model(id: string, provider = "openai", providerType?: string): Model {
	return buildModel({ ...reference, id, provider, providerType, requestModelId: undefined });
}
const sol = model("gpt-6.1-sol");
const other = model("gpt-6-luna");

describe("resolved-model prose spacing delivery", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	const sessions: AgentSession[] = [];
	beforeEach(async () => {
		dir = TempDir.createSync("sol-spacing-");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		auth.keys.setRuntime("openai", "test");
		registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
		registry.registerProvider("openai", {
			baseUrl: "https://api.openai.com/v1",
			apiKey: "test",
			api: "openai-responses",
			models: [sol, other].map(row => ({
				...row,
				contextWindow: row.contextWindow ?? 272000,
				maxTokens: row.maxTokens ?? 32000,
			})),
		});
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		auth.close();
		dir.removeSync();
	});
	async function open(
		active: Model | undefined,
		manager = SessionManager.inMemory(),
		taskDepth = 0,
		settings = Settings.isolated({ includeModelInPrompt: false, "compaction.enabled": false }),
	) {
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: auth,
			modelRegistry: registry,
			model: active,
			sessionManager: manager,
			taskDepth,
			settings,
			disableExtensionDiscovery: true,
			bindProcessState: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		sessions.push(session);
		return session;
	}
	async function sentPrompt(session: AgentSession): Promise<string[]> {
		return (await session.agent.buildSideRequestContext([])).systemPrompt ?? [];
	}

	it("delivers advice only for the exact provider and delimited family, including custom provider aliases", async () => {
		const cases: Array<[Model | undefined, boolean]> = [
			[model("gpt-6.1"), true],
			[sol, true],
			[model("gpt-6.1-luna", "openai-codex"), true],
			[model("gpt-6.1-sol", "openai-codex-device"), true],
			[model("gpt-6.1-sol", "azure"), true],
			[model("gpt-6.1-sol", "codex-lb"), true],
			[model("gpt-6.1-sol", "private-lb", "openai"), true],
			[model("gpt-6.10-sol"), false],
			[model("gpt-6.1sol"), false],
			[other, false],
			[model("gpt-6.1-sol", "anthropic"), false],
			[model("gpt-6.1-sol", "openai-lookalike"), false],
			[model("sol"), false],
			[undefined, false],
		];
		for (const [resolvedModel, wanted] of cases) {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir.path(),
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: [],
				includeWorkspaceTree: false,
				includeModelInPrompt: false,
				resolvedModel,
			});
			expect(systemPrompt.includes(advice), `${resolvedModel?.provider}/${resolvedModel?.id}`).toBe(wanted);
		}
	});

	it("adds and removes advice on /model's setModel path with the model line hidden", async () => {
		const session = await open(other);
		expect(await sentPrompt(session)).not.toContain(advice);
		await session.setModel(sol);
		expect(await sentPrompt(session)).toContain(advice);
		await session.setModel(other);
		expect(await sentPrompt(session)).not.toContain(advice);
	});

	it("builds a task child's advice from its own model independently of its parent", async () => {
		const parent = await open(sol);
		const child = await open(other, SessionManager.inMemory(), 1);
		expect(await sentPrompt(parent)).toContain(advice);
		expect(await sentPrompt(child)).not.toContain(advice);
		await child.setModel(sol);
		await parent.setModel(other);
		expect(await sentPrompt(child)).toContain(advice);
		expect(await sentPrompt(parent)).not.toContain(advice);
	});

	for (const [from, to] of [
		[other, sol],
		[sol, other],
	]) {
		it(`refreshes advice on retry fallback ${from.id} -> ${to.id}`, async () => {
			const settings = Settings.isolated({
				includeModelInPrompt: false,
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.fallbackChains": { default: [`openai/${to.id}`] },
				"edit.modelVariants": { [from.id]: "replace", [to.id]: "replace" },
			});
			settings.setModelRole("default", `openai/${from.id}`);
			const session = await open(from, SessionManager.inMemory(), 0, settings);
			const mock = createMockModel();
			const requests: Array<[string, boolean]> = [];
			session.agent.streamFn = (active, context, options) => {
				requests.push([active.id, context.systemPrompt?.includes(advice) ?? false]);
				mock.push(
					active.id === from.id
						? { throw: "overloaded_error: provider returned error 503" }
						: { content: ["Recovered"] },
				);
				return mock.stream(active, context, options);
			};
			await session.prompt("Exercise retry fallback");
			await session.waitForIdle();
			expect(requests[0]).toEqual([from.id, from.id === sol.id]);
			expect(requests.at(-1)).toEqual([to.id, to.id === sol.id]);
		});
	}

	it("keeps advice after compaction replaces conversation history", async () => {
		const settings = Settings.isolated({
			includeModelInPrompt: false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
		});
		const session = await open(sol, SessionManager.inMemory(), 0, settings);
		for (let index = 0; index < 4; index++) {
			for (const message of [userMsg(`Task ${index}`), assistantMsg(`Result ${index}`)]) {
				session.agent.appendMessage(message);
				session.sessionManager.appendMessage(message);
			}
		}
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "Task progress summarized",
			shortSummary: "Progress",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1000,
		}));
		await session.compact();
		expect(session.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(await sentPrompt(session)).toContain(advice);
	});

	it("reselects advice when resuming a compacted journal and removes it on a subsequent switch", async () => {
		const manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		manager.appendModelChange(`openai/${sol.id}`);
		const kept = manager.appendMessage({ role: "user", content: "Keep this task", timestamp: Date.now() });
		manager.appendCompaction("Earlier task summarized", "summary", kept, 10000);
		manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile()!;
		const session = await open(undefined, await SessionManager.open(file));
		expect(session.model?.id).toBe(sol.id);
		expect(session.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(await sentPrompt(session)).toContain(advice);
		await session.setModel(other);
		expect(await sentPrompt(session)).not.toContain(advice);
	});
});
