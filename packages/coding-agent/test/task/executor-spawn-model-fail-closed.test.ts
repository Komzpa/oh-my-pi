import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const EXACT_SPAWN_ERROR =
	"Subagent spawn model resolution failed: none of the requested models resolved to a usable model: " +
	"anthropic/claude-opus-5-5:high (absent from catalog); anthropic/claude-sonnet-5-5:medium (absent from catalog)";

function model(provider: string, id: string): Model<"anthropic-messages"> {
	return buildModel({
		provider,
		id,
		name: `${provider}/${id}`,
		api: "anthropic-messages",
		baseUrl: `https://${provider}.example.com`,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const GPT = model("openai", "gpt-5.5");

function fakeRegistry(available: Model<"anthropic-messages">[]) {
	return {
		refresh: async () => {},
		getAvailable: () => available,
		getAll: () => available,
		getApiKey: async () => "sk-test",
	} as unknown as ModelRegistry;
}

function createMockSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as never[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-failclosed",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
			return true;
		},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		hasPendingAsyncWork: () => false,
	};
	return session as unknown as AgentSession;
}

function mockCreateAgentSession(session: AgentSession) {
	const result: CreateAgentSessionResult = {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(result);
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("explicit spawn model resolution fails closed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("errors naming the requested patterns instead of running on the role model", async () => {
		const spy = mockCreateAgentSession(createMockSession());
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "spawn-failclosed",
			modelOverride: ["anthropic/claude-opus-5-5:high", "anthropic/claude-sonnet-5-5:medium"],
			settings: Settings.isolated(),
			modelRegistry: fakeRegistry([GPT]),
			enableLsp: false,
		});
		expect(String(result.error).split("\n")[0]).toBe(`Error: ${EXACT_SPAWN_ERROR}`);
		expect(spy).not.toHaveBeenCalled();
	});

	it("control: with no explicit model the spawn still proceeds to the role chain", async () => {
		const spy = mockCreateAgentSession(createMockSession());
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "spawn-role-chain",
			settings: Settings.isolated(),
			modelRegistry: fakeRegistry([GPT]),
			enableLsp: false,
		});
		expect(result.error).toBeUndefined();
		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]?.model).toBeUndefined();
	});

	it("neighbour: a later order element that resolves is used with its exact id", async () => {
		const spy = mockCreateAgentSession(createMockSession());
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "spawn-second-element",
			modelOverride: ["anthropic/claude-opus-5-5:high", "openai/gpt-5.5:medium"],
			settings: Settings.isolated(),
			modelRegistry: fakeRegistry([GPT]),
			enableLsp: false,
		});
		expect(result.error).toBeUndefined();
		expect(result.exitCode).toBe(0);
		const passed = spy.mock.calls[0]?.[0]?.model;
		expect(passed?.provider).toBe("openai");
		expect(passed?.id).toBe("gpt-5.5");
	});
});
