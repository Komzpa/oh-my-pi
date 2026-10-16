import { expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SessionManager } from "../../src/session/session-manager";
import type { SessionEntry } from "../../src/session/session-entries";
import {
	assertInteractiveOwnerCanCheckpoint,
	createLocalInteractiveViewSource,
	createInteractiveViewMetadataProvider,
	createInteractiveViewSourceRouter,
} from "../../src/modes/interactive-view";

it.each(["streaming", "compacting", "postPrompt", "queued", "async", "admitted"])(
	"keeps the journal with its owner while %s work remains",
	kind => {
		expect(() =>
			assertInteractiveOwnerCanCheckpoint({
				hasAdmittedSubmission: kind === "admitted",
				isStreaming: kind === "streaming",
				isCompacting: kind === "compacting",
				hasPostPromptWork: kind === "postPrompt",
				queuedMessageCount: kind === "queued" ? 1 : 0,
				hasPendingAsyncWork: () => kind === "async",
			}),
		).toThrow("still owned by active work");
	},
);

it("allows a settled owner to transfer the journal", () => {
	expect(() =>
		assertInteractiveOwnerCanCheckpoint({
			hasAdmittedSubmission: false,
			isStreaming: false,
			isCompacting: false,
			hasPostPromptWork: false,
			queuedMessageCount: 0,
			hasPendingAsyncWork: () => false,
		}),
	).not.toThrow();
});

it("adapts eager metadata counts without changing standalone manager behavior", () => {
	const manager = SessionManager.inMemory();
	const first = manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
	manager.appendCompaction("summary", undefined, first, 100);
	const provider = createInteractiveViewMetadataProvider(manager);
	expect(provider.getEntryCount()).toBe(manager.getEntries().length);
	expect(provider.getCompactionCount()).toBe(1);
	manager.appendMessage({ role: "user", content: "later", timestamp: 2 });
	expect(provider.getEntryCount()).toBe(manager.getEntries().length);
});

it("uses selective metadata and never enumerates the full journal for a view snapshot or focus change", async () => {
	const manager = SessionManager.inMemory();
	const first = manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
	manager.appendCompaction("summary", undefined, first, 100);
	const entries = manager.getEntries();
	const selectedTypes: Array<string | undefined> = [];
	const selective = Object.assign(manager, {
		getEntryCount() {
			expect(Object.is(this, manager)).toBe(true);
			return entries.length;
		},
		*iterateEntries(type?: SessionEntry["type"]) {
			expect(Object.is(this, manager)).toBe(true);
			selectedTypes.push(type);
			for (const entry of entries) if (!type || entry.type === type) yield entry;
		},
	});
	using fullScan = spyOn(selective, "getEntries").mockImplementation(() => {
		throw new Error("full journal hydration");
	});
	const session = {
		sessionId: selective.getSessionId(),
		sessionFile: selective.getSessionFile(),
		isStreaming: false,
		sessionManager: selective,
		agent: new Agent(),
		buildTranscriptSessionContext: () => selective.buildSessionContext({ transcript: true }),
	};
	const source = createLocalInteractiveViewSource(session);
	const router = createInteractiveViewSourceRouter(() => session);
	for (const view of [source, router]) {
		expect(view.revision?.()).toBe(entries.length);
		const snapshot = await view.capture();
		expect(snapshot.entryCount).toBe(entries.length);
		expect(snapshot.compactionCount).toBe(1);
	}
	expect(selectedTypes).toEqual(["compaction", "compaction"]);
	expect(fullScan).not.toHaveBeenCalled();
});

it("honors an explicit metadata provider without inspecting the manager's storage capabilities", async () => {
	const manager = SessionManager.inMemory();
	using fullScan = spyOn(manager, "getEntries").mockImplementation(() => {
		throw new Error("full journal hydration");
	});
	const source = createLocalInteractiveViewSource(
		{
			sessionId: manager.getSessionId(),
			sessionFile: undefined,
			isStreaming: false,
			sessionManager: manager,
			agent: new Agent(),
			buildTranscriptSessionContext: () => manager.buildSessionContext({ transcript: true }),
		},
		{ getEntryCount: () => 75, getCompactionCount: () => 3 },
	);
	expect(source.revision?.()).toBe(75);
	expect(await source.capture()).toMatchObject({ entryCount: 75, compactionCount: 3 });
	expect(fullScan).not.toHaveBeenCalled();
});
