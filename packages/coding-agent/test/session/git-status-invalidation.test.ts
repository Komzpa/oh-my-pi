import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { Agent, type AgentTool, type AfterToolCallContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Type } from "@oh-my-pi/omptype/typebox";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const sessions: AgentSession[] = [];
const stores: AuthStorage[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const store of stores.splice(0)) store.close();
});

function setup(approval: AgentTool["approval"]) {
	const auth = createInMemoryAuthStorage();
	stores.push(auth);
	const tool: AgentTool = {
		name: "fixture_operation",
		label: "Fixture",
		description: "Test operation",
		approval,
		parameters: Type.Object({}),
		execute: async () => ({ content: [] }),
	};
	const mock = createMockModel({ responses: [] });
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		modelRegistry: new ModelRegistry(auth),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
	});
	sessions.push(session);
	return agent;
}

async function finishTool(approval: AgentTool["approval"], isError: boolean) {
	const agent = setup(approval);
	const context: AfterToolCallContext = {
		assistantMessage: createAssistantMessage("Tool call"),
		toolCall: { type: "toolCall", id: "operation", name: "fixture_operation", arguments: {} },
		args: {},
		result: { content: [] },
		isError,
		context: { messages: [], tools: agent.state.tools, systemPrompt: ["Test"] },
	};
	await agent.afterToolCall?.(context);
}

describe("session Git status invalidation", () => {
	for (const isError of [false, true]) {
		test(`invalidates after ${isError ? "a partially failed" : "a successful"} writer`, async () => {
			const invalidation = spyOn(vcs, "invalidateStatus");
			try {
				await finishTool("write", isError);
				expect(invalidation).toHaveBeenCalledTimes(1);
			} finally {
				invalidation.mockRestore();
			}
		});
	}

	test("read-tier calls preserve the shared snapshot", async () => {
		const invalidation = spyOn(vcs, "invalidateStatus");
		try {
			await finishTool(() => "read", false);
			expect(invalidation).not.toHaveBeenCalled();
		} finally {
			invalidation.mockRestore();
		}
	});
});
