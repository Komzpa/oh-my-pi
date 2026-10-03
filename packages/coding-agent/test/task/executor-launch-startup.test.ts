import { afterEach, expect, it, vi } from "bun:test";
import { AuthStorage, clearCustomApis, registerCustomApi, type Api, type Context, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { createAgentSession, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { withSubagentElapsedSignal } from "@oh-my-pi/pi-coding-agent/task/subagent-elapsed-signal";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { createSessionDefaults } from "../helpers/session-defaults";

const authStorages: AuthStorage[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	clearCustomApis();
	for (const authStorage of authStorages.splice(0)) await authStorage.close();
	for (const tempDir of tempDirs.splice(0)) tempDir[Symbol.dispose]();
});

it("overlaps registry refresh with session setup", async () => {
	const tempDir = TempDir.createSync("@pi-task-launch-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);

	const refreshGate = Promise.withResolvers<void>();
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(() => refreshGate.promise);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const openGate = Promise.withResolvers<SessionManager>();
	const openStarted = Promise.withResolvers<void>();
	const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
		openStarted.resolve();
		return openGate.promise;
	});

	const sessionCreationStarted = Promise.withResolvers<void>();
	let sessionCreated = false;
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: { ok: true } } },
					isError: false,
				} as AgentSessionEvent);
			}
			return true;
		},
	} as unknown as AgentSession;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async _options => {
		sessionCreationStarted.resolve();
		sessionCreated = true;
		const result: CreateAgentSessionResult = {
			session,
			extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		};
		return result;
	});

	const run = runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-launch-overlap",
		authStorage,
		enableLsp: false,
		enableIrc: false,
		invokedAt: 100_000,
	});
	await openStarted.promise;

	expect(openSpy).toHaveBeenCalledTimes(1);
	expect(sessionCreated).toBe(false);

	openGate.resolve(sessionManager);
	await sessionCreationStarted.promise;
	expect(sessionCreated).toBe(true);

	refreshGate.resolve();
	expect((await run).exitCode).toBe(0);
});

it("applies async subagent provider transforms after SDK date/cwd shaping", async () => {
	const tempDir = TempDir.createSync("@pi-task-provider-context-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);
	const api = "test-subagent-provider-context";
	const providerContexts: Context[] = [];
	const transformInputs: Context[] = [];
	registerCustomApi(api, (_model, context) => {
		providerContexts.push(context);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message = createAssistantMessage("ok");
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	});
	const model = buildModel({
		id: "subagent-provider-context",
		name: "Subagent provider context",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
	authStorage.keys.setRuntime(model.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "compaction.enabled": false }),
		model,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		taskDepth: 1,
		agentId: "SubAgent",
		transformProviderContext: async context => {
			transformInputs.push(context);
			await Promise.resolve();
			return withSubagentElapsedSignal(context, 5);
		},
	});
	try {
		await session.sendUserMessage("first");
		expect(transformInputs).toHaveLength(1);
		expect(transformInputs[0]!.messages[0]!.role).toBe("user");
		expect(providerContexts).toHaveLength(1);
		expect(providerContexts[0]!.messages.at(-1)).toMatchObject({
			role: "developer",
			content: "elapsed 5s / 900s",
			synthetic: true,
		});
		const userContent = providerContexts[0]!.messages[0]!.content;
		expect(typeof userContent === "string" ? userContent : JSON.stringify(userContent)).toContain("<system-reminder>");
	} finally {
		await session.dispose();
	}
});
