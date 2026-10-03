import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import {
	getOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { withSubagentElapsedSignal } from "@oh-my-pi/pi-coding-agent/task/subagent-elapsed-signal";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";

const { getAgentDir, setAgentDir, TempDir } = piUtils;

const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const originalProxyEnv: Record<string, string | undefined> = {
	PI_PROXY: Bun.env.PI_PROXY,
	HTTPS_PROXY: Bun.env.HTTPS_PROXY,
	https_proxy: Bun.env.https_proxy,
	ALL_PROXY: Bun.env.ALL_PROXY,
	all_proxy: Bun.env.all_proxy,
	NO_PROXY: Bun.env.NO_PROXY,
	no_proxy: Bun.env.no_proxy,
};

beforeEach(() => {
	for (const key in originalProxyEnv) delete Bun.env[key];
	__resetProxyCache();
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
	__resetProxyCache();
	for (const key in originalProxyEnv) {
		const value = originalProxyEnv[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
}

type TestUsage = {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details: { cached_tokens: number };
};

const DEFAULT_USAGE: TestUsage = {
	input_tokens: 5,
	output_tokens: 3,
	total_tokens: 8,
	input_tokens_details: { cached_tokens: 0 },
};

/**
 * Minimal loopback stand-in for the global WebSocket used by the Codex
 * transport. Mirrors the MockWebSocket harness in openai-codex-stream.test.ts:
 * production code drives it via onopen/onmessage handlers, tests capture the
 * frames it is sent and script the replies. The setTimeout in scheduleOpen
 * matches the provider's async-connect expectation (same as the ai harness).
 */
class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = 0;
	binaryType = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: Record<string, unknown>,
	) {}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	emit(type: string, event: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
		if (typeof handler === "function") (handler as (event: Event) => void).call(this, event);
	}

	scheduleOpen(): void {
		setTimeout(() => {
			this.readyState = MockWebSocket.OPEN;
			this.emit("open", new Event("open"));
		}, 0);
	}

	sendJson(payload: Record<string, unknown>): void {
		this.emit("message", { data: JSON.stringify(payload) } as unknown as MessageEvent);
	}

	emitCodexText(opts: { messageId: string; responseId: string; text: string }): void {
		const { messageId, responseId, text } = opts;
		this.sendJson({ type: "response.created", response: { id: responseId } });
		this.sendJson({
			type: "response.output_item.added",
			item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
		});
		this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
		this.sendJson({ type: "response.output_text.delta", delta: text });
		this.sendJson({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		});
		this.sendJson({
			type: "response.completed",
			response: { id: responseId, status: "completed", usage: DEFAULT_USAGE },
		});
	}

	emitCodexToolCall(opts: { responseId: string; callId: string; name: string; args: string }): void {
		const { responseId, callId, name, args } = opts;
		const itemId = "fc_1";
		this.sendJson({ type: "response.created", response: { id: responseId } });
		this.sendJson({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", id: itemId, call_id: callId, name, arguments: "" },
		});
		this.sendJson({
			type: "response.function_call_arguments.delta",
			output_index: 0,
			item_id: itemId,
			delta: args,
		});
		this.sendJson({
			type: "response.function_call_arguments.done",
			output_index: 0,
			item_id: itemId,
			arguments: args,
		});
		this.sendJson({
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "function_call",
				id: itemId,
				call_id: callId,
				name,
				arguments: args,
				status: "completed",
			},
		});
		this.sendJson({
			type: "response.completed",
			response: { id: responseId, status: "completed", usage: DEFAULT_USAGE },
		});
	}
}

function inputItems(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return body.input as Array<Record<string, unknown>>;
}

function turnIdOf(body: Record<string, unknown> | undefined): unknown {
	return (body?.client_metadata as Record<string, unknown> | undefined)?.turn_id;
}

/** Two text turns through the real Codex request builder over the loopback socket. */
async function runTwoTextTurns(
	sessionId: string,
	noteSeconds: [number, number] | null,
	includeSyntheticDirective = false,
) {
	const tempDir = TempDir.createSync("@pi-pr39-chain-");
	setAgentDir(tempDir.path());
	const token = createCodexTestToken();
	const sent: Array<Record<string, unknown>> = [];
	const fetchMock = vi.fn(async () => {
		throw new Error("SSE fallback should not be called");
	});

	class ChainWebSocket extends MockWebSocket {
		constructor(url: string, options?: Record<string, unknown>) {
			super(url, options);
			this.scheduleOpen();
		}

		override send(data: string): void {
			sent.push(JSON.parse(data) as Record<string, unknown>);
			const index = sent.length;
			this.emitCodexText({
				messageId: `msg_${index}`,
				responseId: `resp_${index}`,
				text: index === 1 ? "First answer" : "Second answer",
			});
		}
	}

	global.WebSocket = ChainWebSocket as unknown as typeof WebSocket;
	const model = createCodexTestModel();
	const providerSessionState = new Map<string, ProviderSessionState>();
	const systemPrompt = ["You are a helpful assistant."];

	const firstBase: Context = {
		systemPrompt,
		messages: [{ role: "user", content: "First question", timestamp: Date.now() - 1000 }],
	};
	const firstContext = noteSeconds ? withSubagentElapsedSignal(firstBase, noteSeconds[0]) : firstBase;
	const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
		fetch: fetchMock as FetchImpl,
		apiKey: token,
		sessionId,
		providerSessionState,
	}).result();
	expect(firstResponse.stopReason).toBe("stop");

	const secondBase: Context = {
		systemPrompt,
		messages: [
			{ role: "user", content: "First question", timestamp: Date.now() - 1000 },
			firstResponse,
			{ role: "user", content: "Second question", timestamp: Date.now() },
			...(includeSyntheticDirective
				? [{ role: "developer" as const, content: "Start a fresh run.", synthetic: true, timestamp: Date.now() }]
				: []),
		],
	};
	const secondContext = noteSeconds ? withSubagentElapsedSignal(secondBase, noteSeconds[1]) : secondBase;
	const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
		fetch: fetchMock as FetchImpl,
		apiKey: token,
		sessionId,
		providerSessionState,
	}).result();
	expect(secondResponse.stopReason).toBe("stop");
	expect(fetchMock).not.toHaveBeenCalled();

	return {
		sent,
		stats: getOpenAICodexWebSocketDebugStats(model, { sessionId, providerSessionState }),
	};
}

describe("subagent elapsed note keeps Codex chaining", () => {
	it("chains turn 2 with previous_response_id and a delta-only input carrying the fresh note", async () => {
		const noted = await runTwoTextTurns("pr39-note", [5, 12]);
		const plain = await runTwoTextTurns("pr39-plain", null);

		expect(noted.sent).toHaveLength(2);
		expect(plain.sent).toHaveLength(2);

		// No-note run must chain: the harness canary.
		expect(plain.sent[1]?.previous_response_id).toBe("resp_1");
		const plainDelta = inputItems(plain.sent[1] as Record<string, unknown>);
		expect(plainDelta).toHaveLength(1);
		expect(JSON.stringify(plainDelta)).toContain("Second question");

		// With-note run chains identically.
		expect(noted.sent[0]?.previous_response_id).toBeUndefined();
		expect(noted.sent[1]?.previous_response_id).toBe("resp_1");
		const delta = inputItems(noted.sent[1] as Record<string, unknown>);
		const deltaJson = JSON.stringify(delta);
		expect(deltaJson).toContain("Second question");
		expect(deltaJson).toContain("elapsed 12s / 900s");
		expect(deltaJson).not.toContain("First question");
		expect(deltaJson).not.toContain("First answer");
		expect(deltaJson).not.toContain("elapsed 5s");

		// The note text is elapsed seconds against the budget only: no estimate.
		const noteItem = delta.find(item => item.role === "developer" && /elapsed \d+s/.test(JSON.stringify(item)));
		const noteParts = (noteItem?.content ?? []) as Array<{ text?: string }>;
		expect(noteParts.map(part => part.text ?? "").join("")).toBe("elapsed 12s / 900s");

		// Delta-only input matches the no-note delta plus the fresh note.
		expect(delta).toHaveLength(plainDelta.length + 1);

		expect(noted.stats?.fullContextRequests).toBe(1);
		expect(noted.stats?.deltaRequests).toBe(1);
		expect(noted.stats?.lastPreviousResponseId).toBe("resp_1");

		// Both runs rotate to a new turn on the second user question.
		expect(turnIdOf(noted.sent[1])).not.toBe(turnIdOf(noted.sent[0]));
		expect(turnIdOf(plain.sent[1])).not.toBe(turnIdOf(plain.sent[0]));
	});
	it("does not mistake an unrelated synthetic directive for elapsed scaffolding", async () => {
		const { sent } = await runTwoTextTurns("pr39-directive", [5, 12], true);

		expect(turnIdOf(sent[1])).not.toBe(turnIdOf(sent[0]));
		const input = inputItems(sent[1] as Record<string, unknown>);
		expect(JSON.stringify(input)).toContain("Start a fresh run.");
		expect(JSON.stringify(input)).toContain("elapsed 12s / 900s");
	});


	it("keeps mid-turn continuation (turn_id and delta) identical to the no-note run", async () => {
		const run = async (sessionId: string, noteSeconds: [number, number] | null) => {
			const tempDir = TempDir.createSync("@pi-pr39-cont-");
			setAgentDir(tempDir.path());
			const token = createCodexTestToken();
			const sent: Array<Record<string, unknown>> = [];
			const fetchMock = vi.fn(async () => {
				throw new Error("SSE fallback should not be called");
			});

			class ContWebSocket extends MockWebSocket {
				constructor(url: string, options?: Record<string, unknown>) {
					super(url, options);
					this.scheduleOpen();
				}

				override send(data: string): void {
					sent.push(JSON.parse(data) as Record<string, unknown>);
					if (sent.length === 1) {
						this.emitCodexToolCall({
							responseId: "resp_1",
							callId: "call_1",
							name: "lookup",
							args: '{"path":"a.txt"}',
						});
					} else {
						this.emitCodexText({ messageId: "msg_2", responseId: "resp_2", text: "Done" });
					}
				}
			}

			global.WebSocket = ContWebSocket as unknown as typeof WebSocket;
			const model = createCodexTestModel();
			const providerSessionState = new Map<string, ProviderSessionState>();
			const systemPrompt = ["You are a helpful assistant."];

			const firstBase: Context = {
				systemPrompt,
				messages: [{ role: "user", content: "Run lookup", timestamp: Date.now() - 1000 }],
			};
			const firstContext = noteSeconds ? withSubagentElapsedSignal(firstBase, noteSeconds[0]) : firstBase;
			const toolResponse = await streamOpenAICodexResponses(model, firstContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId,
				providerSessionState,
			}).result();
			expect(toolResponse.stopReason).toBe("toolUse");

			const secondBase: Context = {
				systemPrompt,
				messages: [
					{ role: "user", content: "Run lookup", timestamp: Date.now() - 1000 },
					toolResponse,
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "lookup",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			};
			const secondContext = noteSeconds ? withSubagentElapsedSignal(secondBase, noteSeconds[1]) : secondBase;
			const finalResponse = await streamOpenAICodexResponses(model, secondContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId,
				providerSessionState,
			}).result();
			expect(finalResponse.stopReason).toBe("stop");
			expect(fetchMock).not.toHaveBeenCalled();
			return sent;
		};

		const noted = await run("pr39-note-cont", [5, 6]);
		const plain = await run("pr39-plain-cont", null);
		expect(noted).toHaveLength(2);
		expect(plain).toHaveLength(2);

		// No-note run is the continuation canary: same turn, chained delta.
		expect(plain[1]?.previous_response_id).toBe("resp_1");
		const plainDelta = inputItems(plain[1] as Record<string, unknown>);
		expect(plainDelta).toHaveLength(1);
		expect(turnIdOf(plain[1])).toBe(turnIdOf(plain[0]));

		// With-note run must detect the continuation exactly like the no-note run.
		expect(noted[1]?.previous_response_id).toBe("resp_1");
		const delta = inputItems(noted[1] as Record<string, unknown>);
		expect(delta).toHaveLength(plainDelta.length + 1);
		const deltaJson = JSON.stringify(delta);
		expect(deltaJson).toContain("call_1");
		expect(deltaJson).toContain("elapsed 6s / 900s");
		expect(deltaJson).not.toContain("Run lookup");
		expect(deltaJson).not.toContain("elapsed 5s");
		expect(turnIdOf(noted[1])).toBe(turnIdOf(noted[0]));
	});
});
