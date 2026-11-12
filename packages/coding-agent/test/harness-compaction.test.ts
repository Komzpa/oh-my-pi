import { expect, it } from "bun:test";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

it("reopens native history for local preparation while retaining native replay and collapsed display", () => {
	const model = getBundledModel("openai-codex", "gpt-5.6-sol");
	const reader = getBundledModel("anthropic", "claude-opus-5-5");
	const manager = SessionManager.inMemory();
	const original = manager.appendMessage({ role: "user", content: "Archived fact. ".repeat(2000), timestamp: 0 });
	const kept = manager.appendMessage({ role: "user", content: "Kept question.", timestamp: 1 });
	const compactionItem = { type: "compaction", encrypted_content: "opaque" };
	manager.appendCompaction("Native placeholder", undefined, kept, 8000, {
		method: "remote",
		preserveData: {
			openaiRemoteCompaction: { provider: model.provider, replacementHistory: [compactionItem], compactionItem },
		},
	});
	manager.appendMessage({ role: "user", content: "Next question.", timestamp: 2 });
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100, remoteEnabled: false };
	// Negative-control fixture: replay/display selection intentionally omits originals;
	// feeding it to preparation recreates the lost-history boundary without changing source.
	const collapsed = manager.getContextBranch(model);
	expect(collapsed.some(entry => entry.id === original)).toBe(false);
	expect(manager.getContextBranch().some(entry => entry.id === original)).toBe(false);
	expect(
		manager.getContextBranch(model, { ...settings, remoteEnabled: true }).some(entry => entry.id === original),
	).toBe(false);
	const local = prepareCompaction(manager.getContextBranch(model, settings), settings, model)!;
	expect(JSON.stringify(local.messagesToSummarize)).toContain("Archived fact.");
	expect(local.previousSummary).toBeUndefined();
	expect(prepareCompaction(collapsed, settings, model)).toBeUndefined();
	expect(manager.getContextBranch(reader).some(entry => entry.id === original)).toBe(true);
	// A subsequent native read must not reuse the local preparation's expanded closure.
	expect(manager.getContextBranch(model).some(entry => entry.id === original)).toBe(false);
});
