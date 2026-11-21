import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveAgentModelSelection, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const DROP_ERROR =
	"stream_incomplete: Upstream websocket closed before response.completed: Upstream websocket receive failed";
const DROP_ERROR_ID = 135168;
const PRIMARY = "codex-lb/gpt-6.1-sol";
const FALLBACK = "openai/gpt-4o-mini";
const FALLBACK_COOLDOWN_MS = 60_000;

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function dropStream(model: Model<Api>, errors: AssistantMessage[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const error: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: DROP_ERROR,
			errorId: DROP_ERROR_ID,
			timestamp: Date.now(),
		};
		errors.push(error);
		stream.push({ type: "error", reason: "error", error });
	});
	return stream;
}

describe("AgentSession stream drop fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-stream-drop-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("codex-lb", "test-codex-lb-key");
		authStorage.keys.setRuntime("openai", "test-openai-key");
		const modelsPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"codex-lb": {
						auth: "none",
						baseUrl: "https://codex-lb.example/v1",
						api: "openai-responses",
						models: [
							{
								id: "gpt-6.1-sol",
								name: "GPT 6.1 Sol",
								reasoning: true,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200_000,
								maxTokens: 16_384,
							},
						],
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
		await modelRegistry.refresh("offline");
	});

	beforeEach(() => modelRegistry.clearSuppressedSelectors());

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		modelRegistry.clearSuppressedSelectors();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function models(): { primary: Model<Api>; fallback: Model<Api> } {
		const primary = modelRegistry.find("codex-lb", "gpt-6.1-sol");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) {
			throw new Error(
				`Expected stream drop test models to exist (primary=${Boolean(primary)}, fallback=${Boolean(fallback)}, config=${modelRegistry.getError()?.message ?? "ok"})`,
			);
		}
		return { primary, fallback };
	}

	function createSession(options: {
		maxRetries?: number;
		error?: string;
		errorId?: number;
		errorStatus?: number;
		requestedModels: string[];
		dropErrors?: AssistantMessage[];
		tools?: AgentTool[];
		fallbackToolCall?: boolean;
		primaryAnswersAfterFirstDrop?: boolean;
	}) {
		const { primary, fallback } = models();
		const fallbackMock = createMockModel({
			responses: options.fallbackToolCall
				? [
						{
							content: [{ type: "toolCall", id: "cooldown-tool-call", name: "advance_clock", arguments: {} }],
						},
						{ content: ["Recovered on the fallback"] },
					]
				: [{ content: ["Recovered on the fallback"] }],
		});
		const primarySuccess = createMockModel({ handler: { content: ["Primary recovered"] } });
		let primaryCalls = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: (model, context, streamOptions) => {
				const selector = `${model.provider}/${model.id}`;
				options.requestedModels.push(selector);
				if (selector === PRIMARY) {
					primaryCalls += 1;
					if (options.primaryAnswersAfterFirstDrop && primaryCalls > 1) {
						return primarySuccess.stream(model, context, streamOptions);
					}
					if (options.error === undefined) return dropStream(model, options.dropErrors ?? []);
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const error: AssistantMessage = {
							role: "assistant",
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: emptyUsage(),
							stopReason: "error",
							errorMessage: options.error,
							errorId: options.errorId ?? AIError.classify(options.error, model.api),
							errorStatus: options.errorStatus,
							timestamp: Date.now(),
						};
						stream.push({ type: "error", reason: "error", error });
					});
					return stream;
				}
				if (selector === FALLBACK) return fallbackMock.stream(model, context, streamOptions);
				throw new Error(`Unexpected model requested: ${selector}`);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": options.maxRetries ?? 2,
			"retry.fallbackChains": { default: [FALLBACK] },
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", PRIMARY);
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map((options.tools ?? []).map(tool => [tool.name, tool])),
		});
		session = created;
		return { created, primary, fallback, settings };
	}

	it("retries the empty stream drop on the same model through maxRetries before falling back", async () => {
		mockSchedulerWaitWithClock();
		const requestedModels: string[] = [];
		const dropErrors: AssistantMessage[] = [];
		const { created, fallback } = createSession({ requestedModels, dropErrors, maxRetries: 2 });

		await created.prompt("recover after the upstream websocket closes");
		await created.waitForIdle();

		expect(dropErrors).toHaveLength(3);
		for (const error of dropErrors) {
			expect(error).toMatchObject({
				content: [],
				stopReason: "error",
				errorId: DROP_ERROR_ID,
				errorMessage: DROP_ERROR,
			});
		}
		expect(requestedModels).toEqual([PRIMARY, PRIMARY, PRIMARY, FALLBACK]);
		expect(created.model?.provider).toBe(fallback.provider);
		expect(created.agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
	});

	it("keeps @code resolved to the failed model using the session registry", async () => {
		mockSchedulerWaitWithClock();
		const requestedModels: string[] = [];
		const dropErrors: AssistantMessage[] = [];
		const { created, settings } = createSession({
			requestedModels,
			dropErrors,
			primaryAnswersAfterFirstDrop: true,
		});
		settings.setModelRole("code", `${PRIMARY}, ${FALLBACK}`);

		await created.prompt("select the code role after one stream drop");
		await created.waitForIdle();

		expect(requestedModels).toEqual([PRIMARY, PRIMARY]);
		expect(modelRegistry.isSelectorSuppressed(PRIMARY)).toBe(false);
		const selection = resolveAgentModelSelection({ agentModel: "@code", settings });
		expect(selection).toMatchObject({ patterns: [PRIMARY, FALLBACK], role: "code" });
		const resolved = resolveModelOverride(selection.patterns, modelRegistry, settings);
		expect(resolved.model).toMatchObject({ provider: "codex-lb", id: "gpt-6.1-sol" });
	});

	it("restores the configured model after the stream drop fallback cooldown", async () => {
		mockSchedulerWaitWithClock();
		const requestedModels: string[] = [];
		const dropErrors: AssistantMessage[] = [];
		const { created, fallback } = createSession({ requestedModels, dropErrors, maxRetries: 0 });
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await created.prompt("fall back after one empty drop");
		await created.waitForIdle();
		expect(created.model?.provider).toBe(fallback.provider);

		now += FALLBACK_COOLDOWN_MS - 1;
		await created.prompt("remain on fallback just before cooldown expiry");
		await created.waitForIdle();
		expect(created.model?.provider).toBe(fallback.provider);

		now += 2;
		await created.prompt("restore the configured model just after cooldown expiry");
		await created.waitForIdle();
		// The restored primary is tried on this turn, then its repeated drop
		// sends the session back to the configured fallback.
		expect(requestedModels).toEqual([PRIMARY, FALLBACK, FALLBACK, PRIMARY, FALLBACK]);
		expect(created.model?.provider).toBe(fallback.provider);
	});

	it("restores the primary before the next provider request in a continuing tool loop", async () => {
		mockSchedulerWaitWithClock();
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const requestedModels: string[] = [];
		const dropErrors: AssistantMessage[] = [];
		let toolExecutions = 0;
		const toolSchema = type({});
		const tool: AgentTool<typeof toolSchema, undefined> = {
			name: "advance_clock",
			label: "Advance clock",
			description: "Advance the fake wall clock past fallback cooldown",
			parameters: toolSchema,
			async execute() {
				toolExecutions += 1;
				now += FALLBACK_COOLDOWN_MS + 1;
				return { content: [{ type: "text", text: "clock advanced" }], details: undefined };
			},
		};
		const { created, primary } = createSession({
			requestedModels,
			dropErrors,
			maxRetries: 0,
			tools: [tool],
			fallbackToolCall: true,
			primaryAnswersAfterFirstDrop: true,
		});

		await created.prompt("use a tool, then continue");
		await created.waitForIdle();

		expect(dropErrors).toHaveLength(1);
		expect(toolExecutions).toBe(1);
		expect(requestedModels).toEqual([PRIMARY, FALLBACK, PRIMARY]);
		expect(created.model?.provider).toBe(primary.provider);
	});

	it.each([
		["usage limit 429", `${DROP_ERROR}: 429 usage_limit_reached`, AIError.create(AIError.Flag.UsageLimit), 429],
		[
			"authentication failure 401",
			`${DROP_ERROR}: 401 invalid_api_key`,
			AIError.create(AIError.Flag.AuthFailed),
			401,
		],
		["hard request rejection 400", `${DROP_ERROR}: 400 invalid_request_error`, 400, 400],
	] as const)("does not apply the stream-drop retry delay to %s", async (_label, error, errorId, errorStatus) => {
		mockSchedulerWaitWithClock();
		const requestedModels: string[] = [];
		const { created, fallback } = createSession({ requestedModels, error, errorId, errorStatus, maxRetries: 3 });

		await created.prompt("verify ordinary provider errors keep their recovery path");
		await created.waitForIdle();

		expect(requestedModels).toEqual([PRIMARY, FALLBACK]);
		expect(created.model?.provider).toBe(fallback.provider);
	});
});
