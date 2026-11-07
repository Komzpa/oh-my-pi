import { expect, spyOn, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionEntryIndex, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

test("turn-end pruning never reads 300k summarized payloads while completing the live turn", async () => {
	const manager = SessionManager.inMemory();
	const auth = createInMemoryAuthStorage();
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	auth.keys.setRuntime(model.provider, "local-only");
	for (let i = 0; i < 300_000; i++) manager.appendCustomEntry("archive", { i });
	const kept = manager.appendMessage({ role: "user", content: "current request", timestamp: 1 });
	manager.appendCompaction("older history summarized", undefined, kept, 100_000);
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Local test"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		streamFn: () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...createAssistantMessage("completed"),
						provider: model.provider,
						model: model.id,
						api: model.api,
					},
				}),
			);
			return stream;
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.supersedeReads": true, "compaction.dropUseless": true }),
		modelRegistry: new ModelRegistry(auth),
	});
	let historicalReads = 0;
	const original = SessionEntryIndex.prototype.get;
	const read = spyOn(SessionEntryIndex.prototype, "get").mockImplementation(
		function (this: SessionEntryIndex, id, retainIdentity) {
			read.mockClear();
			const entry = original.call(this, id, retainIdentity);
			if (entry?.type === "custom" && entry.customType === "archive") historicalReads++;
			return entry;
		},
	);
	try {
		await session.prompt("continue");
		await session.waitForIdle();
		expect(
			session.messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(part => part.type === "text" && part.text === "completed"),
			),
		).toBe(true);
		expect(historicalReads).toBe(0);
	} finally {
		read.mockRestore();
		await session.dispose();
		auth.close();
	}
}, 60_000);
