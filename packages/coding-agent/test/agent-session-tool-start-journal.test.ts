import { afterEach, expect, it, vi } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { getTestModel } from "./helpers/model-fixtures";

let session: AgentSession | undefined;
let auth: AuthStorage | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	auth?.close();
	session = undefined;
	auth = undefined;
});

function setup() {
	const manager = SessionManager.inMemory();
	const agent = new Agent({ initialState: { model: getTestModel("anthropic"), systemPrompt: ["Test"], tools: [] } });
	let onEvent: ((event: AgentEvent) => void) | undefined;
	vi.spyOn(agent, "subscribe").mockImplementation(listener => {
		onEvent = listener;
		return () => {};
	});
	auth = createInMemoryAuthStorage();
	session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth),
	});
	const listener = onEvent;
	if (!listener) throw new Error("AgentSession did not subscribe to agent events");
	return {
		manager,
		start: async (args: unknown) => {
			await listener({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args });
		},
	};
}

function appendCall(manager: SessionManager, command: string) {
	const assistant = createAssistantMessage("");
	assistant.content = [{ type: "toolCall", id: "call", name: "bash", arguments: { command } }];
	assistant.stopReason = "toolUse";
	return manager.appendMessage(assistant);
}

function latestMarker(manager: SessionManager) {
	const marker = manager.getLeafEntry();
	if (marker?.type !== "custom" || marker.customType !== TOOL_EXECUTION_START_CUSTOM_TYPE)
		throw new Error("Tool start did not persist its diagnostic marker");
	return marker.data;
}

it("persists rewritten tool arguments without materializing archived branch history, and omits unchanged drafts", async () => {
	const { manager, start } = setup();
	appendCall(manager, "draft");
	manager.appendCustomEntry("bookkeeping", {});
	// A branch read would hydrate every archived ancestor before recording the
	// start, stalling the UI. Only the nearest assistant's draft is needed.
	vi.spyOn(manager, "getBranch").mockImplementation(() => {
		throw new Error("Archived branch materialized during tool start");
	});
	await start({ command: "effective" });
	expect(latestMarker(manager)).toMatchObject({
		toolCallId: "call",
		toolName: "bash",
		effectiveArguments: { command: "effective" },
		args: { command: "effective" },
	});
	await start({ command: "draft" });
	expect(latestMarker(manager)).not.toHaveProperty("effectiveArguments");
});

it("does not reuse a tool draft across a newer user boundary", async () => {
	const { manager, start } = setup();
	const old = appendCall(manager, "old draft");
	manager.appendMessage({ role: "user", content: "new turn", timestamp: Date.now() });
	manager.appendCustomEntry("bookkeeping", {});
	const getEntry = manager.getEntry.bind(manager);
	vi.spyOn(manager, "getEntry").mockImplementation(id => {
		if (id === old) throw new Error("Read history before the user boundary");
		return getEntry(id);
	});
	await start({ command: "effective" });
	expect(latestMarker(manager)).toMatchObject({ toolCallId: "call", args: { command: "effective" } });
	expect(latestMarker(manager)).not.toHaveProperty("effectiveArguments");
});

it("does not reuse an older matching draft past the closest assistant", async () => {
	const { manager, start } = setup();
	const old = appendCall(manager, "old draft");
	manager.appendMessage(createAssistantMessage("A later assistant with no matching tool call"));
	manager.appendCustomEntry("bookkeeping", {});
	const getEntry = manager.getEntry.bind(manager);
	vi.spyOn(manager, "getEntry").mockImplementation(id => {
		if (id === old) throw new Error("Read history before the closest assistant");
		return getEntry(id);
	});
	await start({ command: "effective" });
	expect(latestMarker(manager)).not.toHaveProperty("effectiveArguments");
});
