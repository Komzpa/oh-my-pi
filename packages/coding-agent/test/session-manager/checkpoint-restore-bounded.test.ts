import { expect, spyOn, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionEntryIndex, SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

test("checkpoint resume restores its original message count without decoding 300k unrelated notices", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	for (let i = 0; i < 300_000; i++) manager.appendCustomMessageEntry("unrelated", "obsolete notice", false);
	const kept = manager.appendMessage({ role: "user", content: "current", timestamp: 2 });
	manager.appendCompaction("summary", undefined, kept, 100);
	const startedAt = "2026-01-01T00:00:00.000Z";
	const checkpoint = manager.appendMessage({
		role: "toolResult",
		toolName: "checkpoint",
		toolCallId: "check",
		isError: false,
		content: [{ type: "text", text: "checkpoint created" }],
		details: { startedAt },
		timestamp: 3,
	});
	// This fixture has no TODOs. Its independent eager TODO restore belongs to #92.
	const todoRead = spyOn(manager, "getBranch").mockReturnValue([]);
	let obsoleteReads = 0;
	const original = SessionEntryIndex.prototype.get;
	const read = spyOn(SessionEntryIndex.prototype, "get").mockImplementation(
		function (this: SessionEntryIndex, id, retain) {
			read.mockClear();
			const entry = original.call(this, id, retain);
			if (entry?.type === "custom_message" && entry.customType === "unrelated") obsoleteReads++;
			return entry;
		},
	);
	const auth = createInMemoryAuthStorage();
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, messages: [], tools: [] },
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	try {
		expect(session.getCheckpointState()).toEqual({
			checkpointEntryId: checkpoint,
			checkpointMessageCount: 3,
			startedAt,
		});
		expect(obsoleteReads).toBe(0);
	} finally {
		read.mockRestore();
		todoRead.mockRestore();
		await session.dispose();
		auth.close();
	}
}, 60_000);
