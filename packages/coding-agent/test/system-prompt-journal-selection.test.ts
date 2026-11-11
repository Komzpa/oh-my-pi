import { afterEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import * as resolver from "../src/memory-backend/resolve";
import { offBackend } from "../src/memory-backend/off-backend";
import type { SessionEntry } from "../src/session/session-entries";
import { SessionManager } from "../src/session/session-manager";
import { SessionTools, type SessionToolsHost } from "../src/session/session-tools";

afterEach(() => vi.restoreAllMocks());

function setup(memoryEnabled: boolean, startup?: string) {
	const manager = SessionManager.inMemory("/fixture");
	const agent = new Agent();
	const settings = Settings.isolated();
	const host: SessionToolsHost = {
		agent,
		sessionManager: manager,
		settings,
		effectiveExtensionRoots: () => ({}) as never,
		modelRegistry: {} as never,
		extensionRunner: () => undefined,
		clientBridge: () => undefined,
		agentKind: () => "main",
		isDisposed: () => false,
		isStreaming: () => false,
		steeringArrivalSignal: () => new AbortController().signal,
		steeringArrivalSeq: () => 0,
		steeringArrivalAdmitted: () => undefined,
		steeringArrivalRelease: () => {},
		queuedMessageCount: () => 0,
		planModeEnabled: () => false,
		model: () => undefined,
		memoryBackendSession: () => ({ memoryEnabled, sessionManager: manager }) as never,
		clearInheritedProviderPromptCacheKey: () => {},
		clearMemoryPromotionSnapshot: () => {},
		captureMemoryPromotionSnapshot: () => {},
		emitNotice: () => {},
		notifyCommandMetadataChanged: () => {},
		localProtocolOptions: () => ({}),
		evalPreludes: () => [],
		sessionAgents: () => [],
		waitForUser: dialog => dialog(),
	};

	const tools = new SessionTools(host, { baseSystemPrompt: [], getStartupContext: () => startup });
	const fullRead = vi.spyOn(manager, "getBranch");
	// Model an indexed store: metadata iteration never materializes unrelated payloads.
	let decoded = 0;
	const indexed = Object.assign(manager, {
		*iterateBranchMatchingNewestFirst(
			predicate: (metadata: { type: SessionEntry["type"]; customType?: string }) => boolean,
		) {
			const entries = manager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (
					predicate({
						type: entry.type,
						customType: entry.type === "custom_message" ? entry.customType : undefined,
					})
				) {
					decoded++;
					yield entry;
				}
			}
		},
	});
	vi.spyOn(resolver, "resolveMemoryBackend").mockResolvedValue({
		...offBackend,
		id: "off",
		beforeAgentStartPrompt: async () => ({ context: "recall", commit: () => true }),
		buildConversationContext: async () => "first context",
	});
	return { manager: indexed, tools, fullRead, decoded: () => decoded };
}

it("deduplicates startup context without hydrating archives and delivers it again after reset", async () => {
	const { manager, tools, fullRead } = setup(false, "workspace");
	manager.appendCustomEntry("archive", { padding: "unrelated" });
	expect((await tools.buildSystemPromptForAgentStart("go", () => true)).startupContext?.content).toBe("workspace");
	manager.appendCustomMessageEntry("startup-context", "workspace", false, { cwd: "/fixture" });
	manager.appendCustomMessageEntry("startup-context", "wrong cwd", false, { cwd: "/elsewhere" });
	expect((await tools.buildSystemPromptForAgentStart("go", () => true)).startupContext).toBeUndefined();
	manager.appendResetBoundary();
	expect((await tools.buildSystemPromptForAgentStart("go", () => true)).startupContext?.content).toBe("workspace");
	expect(fullRead).not.toHaveBeenCalled();
});

it("deduplicates scoped memory without hydrating archives and ignores delivery before reset", async () => {
	const { manager, tools, fullRead } = setup(true);
	manager.appendCustomEntry("archive", { padding: "unrelated" });
	manager.appendCustomMessageEntry("memory-context", "old", false, {
		backend: "off",
		cwd: "/fixture",
		recall: "recall",
	});
	manager.appendCustomMessageEntry("memory-context", "other scope", false, {
		backend: "off",
		cwd: "/fixture",
		scope: "other",
		recall: "different",
	});
	expect((await tools.buildSystemPromptForAgentStart("go", () => true)).memoryContext).toBeUndefined();
	manager.appendResetBoundary();
	expect((await tools.buildSystemPromptForAgentStart("go", () => true)).memoryContext?.content).toBe("first context");
	expect(fullRead).not.toHaveBeenCalled();
});

it("ten prompt preparations skip 300k unrelated custom messages while preserving startup deduplication", async () => {
	const { manager, tools, decoded } = setup(false, "workspace");
	manager.appendCustomMessageEntry("startup-context", "workspace", false, { cwd: "/fixture" });
	for (let i = 0; i < 300_000; i++) manager.appendCustomMessageEntry("unrelated-notice", "old", false);
	for (let turn = 0; turn < 10; turn++) {
		expect((await tools.buildSystemPromptForAgentStart("go", () => true)).startupContext).toBeUndefined();
	}
	expect(decoded()).toBe(10);
}, 60_000);
