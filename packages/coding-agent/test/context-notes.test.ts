import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { isJsonSchemaValueValid } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolCall } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CONTEXT_NOTES_ENTRY_TYPE,
	getContextNotes,
	MAX_CONTEXT_NOTES_BYTES,
} from "@oh-my-pi/pi-coding-agent/session/context-notes";
import type { ContextNotesEntry } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import type { CustomEntry, ResetBoundaryEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ContextNotesTool, NewContextTool } from "@oh-my-pi/pi-coding-agent/tools/context-notes";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgCompactionExperimentalContextManagement } from "@oh-my-pi/pi-coding-agent/session/context-settings";

const NOW = "2026-09-04T00:00:00.000Z";

function noteEntry(id: string, parentId: string | null, text: string): CustomEntry<ContextNotesEntry> {
	return {
		type: "custom",
		customType: CONTEXT_NOTES_ENTRY_TYPE,
		data: { version: 1, text },
		id,
		parentId,
		timestamp: NOW,
	};
}

function resetEntry(id: string, parentId: string | null): ResetBoundaryEntry {
	return { type: "reset_boundary", id, parentId, timestamp: NOW };
}

function toolSession(
	settings: Settings,
	sessionManager: SessionManager,
	ownerId = sessionManager.getSessionId(),
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionId: () => ownerId,
		getSessionSpawns: () => null,
		sessionManager,
	};
}

function codexModel() {
	return buildModel({
		id: "gpt-5.5",
		name: "gpt-5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

describe("experimental context notes", () => {
	it("reads saved notes via action read without modifying the journal, even when placeholder text is supplied", async () => {
		using tempDir = TempDir.createSync("@omp-context-notes-read-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const manager = SessionManager.create(tempDir.path(), sessionDir);
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, manager));
		if (!tool) throw new Error("expected context notes tool");
		try {
			await tool.execute("save", { action: "replace", text: "retain this notebook" });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("expected persisted session file");
			const before = await Bun.file(sessionFile).text();
			const revision = getContextNotes(manager.getBranch());
			const model = codexModel();
			const [wireTool] = convertOpenAICodexResponsesTools([tool], model);
			if (wireTool?.type !== "function") throw new Error("expected function schema");
			expect(isJsonSchemaValueValid(wireTool.parameters, {})).toBe(false);
			expect(isJsonSchemaValueValid(wireTool.parameters, { action: "read" })).toBe(true);
			expect(isJsonSchemaValueValid(wireTool.parameters, { action: "read", text: "" })).toBe(true);
			expect(isJsonSchemaValueValid(wireTool.parameters, { action: "bogus" })).toBe(false);
			expect(isJsonSchemaValueValid(wireTool.parameters, { action: "read", text: null })).toBe(false);
			const args = validateToolCall([tool], {
				type: "toolCall",
				id: "read",
				name: tool.name,
				arguments: { action: "read", text: "" },
			});
			const read = await tool.execute("read", tool.parameters.assert(args));
			expect(read.content).toEqual([{ type: "text", text: "retain this notebook" }]);
			expect(getContextNotes(manager.getBranch())).toEqual(revision);
			expect(await Bun.file(sessionFile).text()).toBe(before);
			// A read carrying replacement-looking text still cannot replace or clear.
			await tool.execute("read-with-text", { action: "read", text: "must not be saved" });
			expect(getContextNotes(manager.getBranch())).toEqual(revision);
			expect(await Bun.file(sessionFile).text()).toBe(before);
			await tool.execute("clear", { action: "clear" });
			expect(getContextNotes(manager.getBranch())?.text).toBe("");
			expect(getContextNotes(manager.getBranch())?.entryId).not.toBe(revision?.entryId);
			const resumed = await SessionManager.open(sessionFile, sessionDir);
			try {
				expect(getContextNotes(resumed.getBranch())?.text).toBe("");
			} finally {
				await resumed.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("rejects omitted or unknown actions and empty replacements without changing the notebook", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, sessionManager));
		if (!tool) throw new Error("expected context notes tool");

		await tool.execute("initial", { action: "replace", text: "keep me" });
		const revision = getContextNotes(sessionManager.getBranch());
		const journalLength = sessionManager.getBranch().length;
		// Legacy shapes: omitted text must not read, empty text must not clear.
		await expect(tool.execute("legacy-read", {} as never)).rejects.toThrow("unchanged");
		await expect(tool.execute("legacy-clear", { text: "" } as never)).rejects.toThrow("unchanged");
		await expect(tool.execute("unknown", { action: "delete" } as never)).rejects.toThrow("unchanged");
		await expect(tool.execute("empty-replace", { action: "replace", text: "" })).rejects.toThrow("unchanged");
		await expect(tool.execute("missing-replace", { action: "replace" })).rejects.toThrow("unchanged");
		expect(getContextNotes(sessionManager.getBranch())).toEqual(revision);
		expect(sessionManager.getBranch()).toHaveLength(journalLength);
	});

	it("rejects an oversized UTF-8 replacement while retaining the current notebook revision", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const session = toolSession(settings, sessionManager);
		const tool = ContextNotesTool.createIf(session);
		if (!tool) throw new Error("expected context notes tool");

		await tool.execute("initial", { action: "replace", text: "Retain this notebook after an invalid replacement." });
		const multibyteCharacter = "€";
		const oversized = multibyteCharacter.repeat(
			Math.floor(MAX_CONTEXT_NOTES_BYTES / Buffer.byteLength(multibyteCharacter, "utf8")) + 1,
		);
		await expect(tool.execute("overflow", { action: "replace", text: oversized })).rejects.toThrow(
			`${MAX_CONTEXT_NOTES_BYTES} UTF-8 bytes`,
		);
		expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_CONTEXT_NOTES_BYTES);
		expect(getContextNotes(sessionManager.getBranch())?.text).toBe(
			"Retain this notebook after an invalid replacement.",
		);
		expect(
			sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === CONTEXT_NOTES_ENTRY_TYPE),
		).toHaveLength(1);
	});

	it("saves exactly MAX_CONTEXT_NOTES_BYTES across a multibyte boundary and rejects one byte over without a new revision", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const session = toolSession(settings, sessionManager);
		const tool = ContextNotesTool.createIf(session);
		if (!tool) throw new Error("expected context notes tool");

		await tool.execute("initial", { action: "replace", text: "prior notebook" });
		const priorEntryId = getContextNotes(sessionManager.getBranch())?.entryId;
		if (!priorEntryId) throw new Error("expected prior notebook entry");

		// Exact cap, ending on a multibyte boundary: pad with ASCII then fill the tail with "€" (3 bytes).
		const euroBytes = Buffer.byteLength("€", "utf8");
		const euroCount = 2; // 6 bytes of "€" tail
		const exactText = "a".repeat(MAX_CONTEXT_NOTES_BYTES - euroCount * euroBytes) + "€".repeat(euroCount);
		expect(Buffer.byteLength(exactText, "utf8")).toBe(MAX_CONTEXT_NOTES_BYTES);
		const saved = await tool.execute("exact-cap", { action: "replace", text: exactText });
		expect(saved.details?.bytes).toBe(MAX_CONTEXT_NOTES_BYTES);
		const exactRevision = getContextNotes(sessionManager.getBranch());
		expect(exactRevision?.text).toBe(exactText);
		expect(exactRevision?.entryId).not.toBe(priorEntryId);

		// One byte over the cap rejects without a new revision or entry-ID change.
		const oneOver = exactText + "b";
		expect(Buffer.byteLength(oneOver, "utf8")).toBe(MAX_CONTEXT_NOTES_BYTES + 1);
		const rejection = await tool
			.execute("one-over", { action: "replace", text: oneOver })
			.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(Error);
		const after = getContextNotes(sessionManager.getBranch());
		expect(after?.text).toBe(exactText);
		expect(after?.entryId).toBe(exactRevision?.entryId);
		expect(
			sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === CONTEXT_NOTES_ENTRY_TYPE),
		).toHaveLength(2);
	});

	it("leaves the branch journal unchanged when reading a missing notebook", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, sessionManager));
		if (!tool) throw new Error("expected context notes tool");

		await tool.execute("read-missing", { action: "read" });
		expect(getContextNotes(sessionManager.getBranch())).toBeUndefined();
		expect(sessionManager.getBranch()).toHaveLength(0);
	});

	it("uses only the active branch's latest notebook and hides it after a context reset", () => {
		const shared = noteEntry("base", null, "shared context");
		const branchA: SessionEntry[] = [shared, noteEntry("a", "base", "branch A context")];
		const branchB: SessionEntry[] = [shared, noteEntry("b", "base", "branch B context")];
		const resetBranch: SessionEntry[] = [
			shared,
			resetEntry("reset", "base"),
			noteEntry("after", "reset", "fresh context"),
		];

		expect(getContextNotes(branchA)).toEqual({ entryId: "a", text: "branch A context" });
		expect(getContextNotes(branchB)).toEqual({ entryId: "b", text: "branch B context" });
		expect(getContextNotes(resetBranch)).toEqual({ entryId: "after", text: "fresh context" });
		expect(getContextNotes([shared, resetEntry("clear", "base")])).toBeUndefined();
	});

	it("persists a replacement for resume and refuses disabled or parent-bound tool sessions", async () => {
		using tempDir = TempDir.createSync("@omp-context-notes-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const session = toolSession(settings, sessionManager);
		const tool = ContextNotesTool.createIf(session);
		if (!tool) throw new Error("expected context notes tool");

		await tool.execute("save", { action: "replace", text: "preserve this across resume" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const resumed = await SessionManager.open(sessionFile, sessionDir);
		try {
			expect(getContextNotes(resumed.getBranch())).toMatchObject({ text: "preserve this across resume" });
		} finally {
			await resumed.close();
			await sessionManager.close();
		}

		const disabled = toolSession(
			Settings.isolated({ "compaction.experimentalContextManagement": false }),
			SessionManager.inMemory(),
		);
		expect(ContextNotesTool.createIf(disabled)).toBeNull();
		expect(NewContextTool.createIf(disabled)).toBeNull();

		const advisorBound = toolSession(settings, SessionManager.inMemory(), "advisor-session");
		expect(ContextNotesTool.createIf(advisorBound)).toBeNull();
	});
	it("does not append notes when the branch changes while disk preparation is pending", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, sessionManager));
		if (!tool) throw new Error("expected context notes tool");
		const pendingEnsure = Promise.withResolvers<void>();
		const ensureSpy = vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(() => pendingEnsure.promise);
		try {
			const pendingWrite = tool.execute("stale-branch", { action: "replace", text: "must not persist" });
			await Promise.resolve();
			sessionManager.appendCustomEntry("test_branch_change");
			pendingEnsure.resolve();
			await expect(pendingWrite).rejects.toThrow("session branch changed");
			expect(getContextNotes(sessionManager.getBranch())).toBeUndefined();
		} finally {
			ensureSpy.mockRestore();
		}
	});

	it("does not append notes when experimental context management is disabled while preparing disk", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, sessionManager));
		if (!tool) throw new Error("expected context notes tool");
		const pendingEnsure = Promise.withResolvers<void>();
		const ensureSpy = vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(() => pendingEnsure.promise);
		try {
			const pendingWrite = tool.execute("disabled-mid-write", { action: "replace", text: "must not persist" });
			await Promise.resolve();
			cfgCompactionExperimentalContextManagement.override(settings, false);
			pendingEnsure.resolve();
			await expect(pendingWrite).rejects.toThrow("Experimental context management is disabled.");
			expect(getContextNotes(sessionManager.getBranch())).toBeUndefined();
		} finally {
			ensureSpy.mockRestore();
		}
	});
});
