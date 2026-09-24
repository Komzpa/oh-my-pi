import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type } from "@oh-my-pi/omptype";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const agentDef: AgentDefinition = {
	name: "drain-driver",
	description: "restart-drain driver regression",
	systemPrompt: "Use the tools as needed, then yield.",
	source: "bundled",
};

describe("task driver restart drain", () => {
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let neighbor: AgentSession | undefined;

	beforeAll(async () => {
		fixtureDir = `/tmp/pi-restart-drain-driver-${Snowflake.next()}`;
		await fs.mkdir(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(`${fixtureDir}/auth.db`);
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, `${fixtureDir}/models.yml`);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all([session?.dispose(), neighbor?.dispose()]);
		session = undefined;
		neighbor = undefined;
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	it("keeps a task open through drain and accepts only the resumed yield", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const toolStarted = Promise.withResolvers<void>();
		const finishTool = Promise.withResolvers<void>();
		let toolRuns = 0;
		const heldTool: AgentTool = {
			name: "held_tool",
			label: "Held Tool",
			description: "Waits for test release",
			parameters: type({}),
			execute: async () => {
				toolRuns++;
				toolStarted.resolve();
				await finishTool.promise;
				return { content: [{ type: "text", text: "effect finished" }] };
			},
		};
		const yieldParameters = type({ data: "unknown" });
		const yieldTool: AgentTool<typeof yieldParameters> = {
			name: "yield",
			label: "Submit Result",
			description: "Submits the task result",
			parameters: yieldParameters,
			execute: async (_toolCallId, { data }) => ({
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			}),
		};
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "held-call", name: "held_tool", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					content: [
						{ type: "toolCall", id: "yield-call", name: "yield", arguments: { data: { answer: "done" } } },
					],
					stopReason: "toolUse",
				},
			],
		});
		const buildSession = (tools: AgentTool[], streamFn: typeof mock.stream) =>
			new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools },
					streamFn,
					convertToLlm,
				}),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				modelRegistry,
			});
		session = buildSession([heldTool, yieldTool], mock.stream);
		const neighborMock = createMockModel({ responses: [{ content: ["neighbor remains independent"] }] });
		neighbor = buildSession([], neighborMock.stream);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as never,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		const task = runSubprocess({ cwd: fixtureDir, agent: agentDef, task: "finish", index: 0, id: "drain-driver" });
		await toolStarted.promise;
		const lease = session.beginRestartDrain();
		const quiescence = lease.waitForQuiescence();
		await neighbor.prompt("independent prompt");
		expect(neighborMock.calls).toHaveLength(1);
		finishTool.resolve();
		await quiescence;
		await session.waitForIdle();
		await Promise.resolve();
		// The held effect has settled, but the driver must neither enter its
		// reminder ladder nor resolve a false missing-yield result during drain.
		expect(toolRuns).toBe(1);
		expect(mock.calls).toHaveLength(1);
		let taskSettled = false;
		void task.then(() => (taskSettled = true));
		await Promise.resolve();
		for (let turn = 0; turn < 20; turn++) await Promise.resolve();
		expect(taskSettled).toBe(false);

		lease.release();
		const result = await task;
		expect(result.output).toContain("done");
		expect(result.exitCode).toBe(0);
		expect(toolRuns).toBe(1);
		expect(mock.calls).toHaveLength(2);
	});
});
