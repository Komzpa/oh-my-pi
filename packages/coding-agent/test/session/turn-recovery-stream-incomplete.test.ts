import { describe, expect, it } from "bun:test";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const STREAM_INCOMPLETE_MESSAGE =
	"stream_incomplete: Upstream websocket closed before response.completed: Upstream websocket receive failed";

const ACTIVE_MODEL = {
	api: "openai-responses",
	provider: "codex-lb",
	id: "gpt-6-sol",
	contextWindow: 200_000,
} as Model;

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "partial reasoning" }],
		api: "openai-responses",
		provider: "codex-lb",
		model: "gpt-6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorId: 0,
		errorStatus: null as unknown as undefined,
		errorMessage: STREAM_INCOMPLETE_MESSAGE,
		timestamp: Date.now(),
		...overrides,
	};
}

function failUnexpected(name: string): never {
	throw new Error(`Unexpected TurnRecoveryHost call: ${name}`);
}

function recovery(options: { textOutputCommitted?: boolean } = {}): TurnRecovery {
	const host: TurnRecoveryHost = {
		agent: {} as Agent,
		sessionManager: {} as SessionManager,
		settings: Settings.isolated({
			"retry.modelFallback": false,
			"retry.fallbackChains": {},
		}),
		modelRegistry: {
			isProviderDiscoveryPending: () => false,
		} as unknown as ModelRegistry,
		configWarnings: [],
		model: () => ACTIVE_MODEL,
		contextFitsModel: () => true,
		textOutputCommitted: () => options.textOutputCommitted === true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 1,
		promptSequence: () => 1,
		sessionId: () => "stream-incomplete-test",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		persistedAssistantEntryId: () => undefined,
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: () => failUnexpected("setModelWithProviderSessionReset"),
		resolveActiveEditMode: () => failUnexpected("resolveActiveEditMode"),
		syncAfterModelChange: () => failUnexpected("syncAfterModelChange"),
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => false,
		runAutoCompaction: () => failUnexpected("runAutoCompaction"),
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: operation => operation(),
	};
	return new TurnRecovery(host);
}

describe("TurnRecovery stream_incomplete retry gate", () => {
	it("retries a thinking-only OpenAI Responses stream_incomplete failure", () => {
		expect(recovery().isRetryableError(assistant())).toBe(true);
	});

	it("does not retry the same failure after committed assistant text", () => {
		expect(
			recovery({ textOutputCommitted: true }).isRetryableError(
				assistant({
					content: [
						{ type: "thinking", thinking: "partial reasoning" },
						{ type: "text", text: "committed answer" },
					],
				}),
			),
		).toBe(false);
	});
});
