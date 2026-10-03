import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getLatestRequirements, type RequirementLedgerItem } from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("PR 41 session requirement capture", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pr41-session-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("publishes an ordinary request candidate before its first model call, exactly once", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const manager = SessionManager.inMemory(tempDir.path());
		let requirementsAtModelStart: RequirementLedgerItem[] = [];
		const mock = createMockModel({ responses: [{ content: ["Captured"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [
					{
						name: "todo",
						label: "Todo",
						description: "Callable todo tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					},
				],
				messages: [],
			},
			streamFn: async (...args) => {
				requirementsAtModelStart = getLatestRequirements(manager.getBranch());
				return mock.stream(...args);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });

		await session.prompt("A new user requirement");
		await session.waitForIdle();

		expect(requirementsAtModelStart).toMatchObject([
			{ id: "R1", classification: "candidate", rawText: "A new user requirement" },
		]);
		expect(getLatestRequirements(manager.getBranch())).toMatchObject([
			{ id: "R1", classification: "candidate", rawText: "A new user requirement" },
		]);
		await session.dispose();
		session = undefined;
	});
	it("captures a queued follow-up once at message end", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const manager = SessionManager.inMemory(tempDir.path());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const mock = createMockModel({ responses: [{ content: ["First response"] }, { content: ["Second response"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [
					{
						name: "todo",
						label: "Todo",
						description: "Callable todo tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					},
				],
				messages: [],
			},
			streamFn: async (...args) => {
				calls++;
				if (calls === 1) {
					entered.resolve();
					await release.promise;
				}
				return mock.stream(...args);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": true });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });

		const firstPrompt = session.prompt("Initial request");
		await entered.promise;
		await session.followUp("Queued follow-up", undefined, { attribution: "user" });
		release.resolve();
		await firstPrompt;
		await session.waitForIdle();

		expect(
			getLatestRequirements(manager.getBranch()).filter(item => item.rawText === "Queued follow-up"),
		).toHaveLength(1);
		await session.dispose();
		session = undefined;
	});
});
