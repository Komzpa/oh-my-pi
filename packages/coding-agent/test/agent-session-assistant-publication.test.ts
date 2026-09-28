import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent, type AgentEvent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { ASSISTANT_GATE_REFUSAL } from "@oh-my-pi/pi-agent-core/assistant-publication";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	BeforeAssistantMessageEvent,
	Extension,
	SessionStopEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const UNSAFE = "Everything is complete, including unaudited R7.";
const STATUS = "Requirements remain open: R7. No completion can be approved.";
type DraftHandler = (event: BeforeAssistantMessageEvent) => unknown;
type StopHandler = (event: SessionStopEvent) => unknown;

function assistantTexts(messages: readonly { role: string; content?: unknown }[]): string[] {
	return messages.flatMap(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
		return message.content.flatMap(block => (block.type === "text" ? [block.text as string] : []));
	});
}

describe("assistant publication bridge", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-publication-bridge-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function runnerFor(manager: SessionManager, handlers: DraftHandler[], stop?: StopHandler): ExtensionRunner {
		const extensionPath = path.join(tempDir.path(), "publication.ts");
		const extension: Extension = {
			path: extensionPath,
			resolvedPath: extensionPath,
			handlers: new Map([
				["before_assistant_message", handlers.map(handler => async (...args: unknown[]) => handler(args[0] as BeforeAssistantMessageEvent))],
				...(stop ? [["session_stop", [async (...args: unknown[]) => stop(args[0] as SessionStopEvent)]] as const] : []),
			]),
			tools: new Map(),
			assistantThinkingRenderers: [],
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		return new ExtensionRunner([extension], new ExtensionRuntime(), tempDir.path(), manager, modelRegistry);
	}

	function harness(options: {
		handlers?: DraftHandler[];
		stop?: StopHandler;
		responses?: MockResponse[];
		tools?: AgentTool[];
		todos?: boolean;
		kind?: "main" | "sub";
		ttsr?: TtsrManager;
	} = {}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const mock = createMockModel({ responses: options.responses ?? [{ content: [UNSAFE] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: mock.stream,
		});
		const manager = SessionManager.inMemory(tempDir.path());
		const runner = runnerFor(manager, options.handlers ?? [], options.stop);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": options.todos ?? false,
			"todo.reminders": options.todos ?? false,
			"todo.remindersMax": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent, sessionManager: manager, settings, modelRegistry, extensionRunner: runner,
			agentKind: options.kind, ttsrManager: options.ttsr,
		});
		sessions.push(session);
		return { session, agent, manager, runner, mock };
	}

	it("withholds the first byte and public state, then settles an open TODO status while awaiting session_stop", async () => {
		const entered = Promise.withResolvers<boolean>();
		const approval = Promise.withResolvers<void>();
		const stopEntered = Promise.withResolvers<boolean>();
		const stopRelease = Promise.withResolvers<void>();
		let receivedSignal: AbortSignal | undefined;
		let stopCalls = 0;
		const { session, agent, manager, mock } = harness({
			todos: true,
			handlers: [async event => {
				receivedSignal = event.signal;
				entered.resolve(true);
				await approval.promise;
				return { replacementText: STATUS, settled: true };
			}],
			stop: async () => {
				stopCalls++;
				stopEntered.resolve(true);
				await stopRelease.promise;
				return { continue: true, additionalContext: "Advisory: continue working" };
			},
		});
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Audit R7", status: "in_progress" }] }]);
		const native: AgentEvent[] = [];
		const publicEvents: AgentSessionEvent[] = [];
		agent.subscribe(event => native.push(event));
		session.subscribe(event => publicEvents.push(event));
		let settled = false;
		const prompt = session.prompt("Report completion").then(() => { settled = true; });
		try {
			await Promise.race([entered.promise, prompt.then(() => false)]);
			expect(assistantTexts(agent.state.messages)).toEqual([]);
			expect(native.filter(event => "message" in event && event.message.role === "assistant")).toEqual([]);
			expect(publicEvents.filter(event => "message" in event && event.message.role === "assistant")).toEqual([]);
			expect(assistantTexts(manager.buildSessionContext().messages)).toEqual([]);
			expect(agent.state.streamMessage).toBeNull();
			expect(receivedSignal).toBeInstanceOf(AbortSignal);
			expect(settled).toBe(false);
			approval.resolve();
			expect(await Promise.race([stopEntered.promise, prompt.then(() => false)])).toBe(true);
			expect(settled).toBe(false);
			stopRelease.resolve();
			await prompt;
			await session.waitForIdle();
			expect(assistantTexts(agent.state.messages)).toEqual([STATUS]);
			expect(assistantTexts(manager.buildSessionContext().messages)).toEqual([STATUS]);
			expect(JSON.stringify(publicEvents)).not.toContain(UNSAFE);
			expect(mock.calls).toHaveLength(1);
			expect(stopCalls).toBe(1);
			expect(publicEvents.some(event => event.type === "todo_reminder")).toBe(false);
			expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("in_progress");
		} finally {
			approval.resolve();
			stopRelease.resolve();
			await prompt;
		}
	});

	it("isolates handler draft mutations and does not let a later permissive handler release the original", async () => {
		const { session, agent } = harness({ handlers: [
			event => {
				const text = event.message.content[0];
				if (text.type === "text") text.text = "MUTATED DRAFT";
				return { replacementText: STATUS, settled: true };
			},
			event => {
				expect(assistantTexts([event.message])).toEqual([UNSAFE]);
				return undefined;
			},
			event => ({ replacementText: assistantTexts([event.message]).join("") }),
		] });
		await session.prompt("Report completion");
		await session.waitForIdle();
		expect(assistantTexts(agent.state.messages)).toEqual([STATUS]);
	});

	it("preserves executable tool calls and only sends approved narrative into the next provider context", async () => {
		const executed: Array<{ id: string; value: string }> = [];
		const parameters = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof parameters> = {
			name: "probe",
			label: "Probe",
			description: "Record a value",
			parameters,
			execute: async (id, args) => {
				executed.push({ id, value: args.value });
				return { content: [{ type: "text", text: "recorded" }], details: {} };
			},
		};
		const { session, agent, mock } = harness({
			tools: [tool],
			responses: [{ content: [UNSAFE, { type: "toolCall", id: "probe-7", name: "probe", arguments: { value: "R7" } }] }, { content: [UNSAFE] }],
			handlers: [event => event.message.content.some(block => block.type === "toolCall")
				? { replacementText: "", settled: true }
				: { replacementText: STATUS, settled: true }],
		});
		await session.prompt("Run the probe");
		await session.waitForIdle();
		expect(executed).toEqual([{ id: "probe-7", value: "R7" }]);
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1].context.messages)).not.toContain(UNSAFE);
		expect(assistantTexts(agent.state.messages)).toEqual([STATUS]);
		expect(agent.state.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId)).toEqual(["probe-7"]);
	});

	it("retains an unrelated explicit session_stop block after a settled replacement", async () => {
		let stops = 0;
		const { session, mock } = harness({
			handlers: [() => ({ replacementText: STATUS, settled: true })],
			responses: [{ content: [UNSAFE] }, { content: [UNSAFE] }],
			stop: () => ++stops === 1 ? { decision: "block", reason: "Required hard check" } : undefined,
		});
		await session.prompt("Report completion");
		await session.waitForIdle();
		expect(stops).toBe(2);
		expect(mock.calls).toHaveLength(2);
	});

	it("does not suppress advisory continuation for an ordinary unmarked answer", async () => {
		let stops = 0;
		const { session, mock } = harness({
			handlers: [() => undefined],
			responses: [{ content: ["Work remains"] }, { content: ["Second status"] }],
			stop: () => ++stops === 1 ? { continue: true, additionalContext: "Continue ordinary work" } : undefined,
		});
		await session.prompt("Report status");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
	});

	it("does not infer settlement from refusal text when no structural receipt was returned", async () => {
		const { session, mock } = harness({
			todos: true,
			handlers: [() => ({ replacementText: STATUS })],
			responses: [{ content: [UNSAFE] }, { content: [UNSAFE] }],
		});
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Audit R7", status: "in_progress" }] }]);
		let reminders = 0;
		session.subscribe(event => { if (event.type === "todo_reminder") reminders++; });
		await session.prompt("Report completion");
		await session.waitForIdle();
		expect(reminders).toBe(1);
		expect(mock.calls).toHaveLength(2);
	});

	it("interrupts withheld raw text for TTSR and retains the rule retry without publishing that text", async () => {
		const ttsr = new TtsrManager({ enabled: true, interruptMode: "always", contextMode: "keep", repeatMode: "once" });
		ttsr.addRule({
			name: "raw-stream-rule", path: "raw-stream-rule.md", content: "Avoid forbidden tokens.",
			condition: ["FORBIDDEN"], scope: ["text"],
			_source: { provider: "test", providerName: "test", path: "raw-stream-rule.md", level: "project" },
		});
		const { session, mock, agent } = harness({
			ttsr,
			handlers: [() => ({ replacementText: STATUS, settled: true })],
			responses: [{ content: ["FORBIDDEN"] }, { content: ["Ordinary raw status"] }],
		});
		const triggered: string[] = [];
		const publicEvents: AgentSessionEvent[] = [];
		session.subscribe(event => {
			publicEvents.push(event);
			if (event.type === "ttsr_triggered") triggered.push(...event.rules.map(rule => rule.name));
		});
		await session.prompt("Check raw stream safety");
		await session.waitForIdle();
		expect(triggered).toEqual(["raw-stream-rule"]);
		expect(mock.calls).toHaveLength(2);
		expect(assistantTexts(agent.state.messages)).toEqual([ASSISTANT_GATE_REFUSAL, STATUS]);
		expect(publicEvents.filter(event => "message" in event && event.message.role === "assistant")
			.some(event => JSON.stringify(event).includes("FORBIDDEN"))).toBe(false);
	});

	it.each(["unguarded", "subagent"] as const)("retains streaming for the %s negative control", async kind => {
		let gateCalls = 0;
		const { session, agent } = harness({
			kind: kind === "subagent" ? "sub" : "main",
			handlers: kind === "subagent" ? [() => { gateCalls++; return { replacementText: STATUS }; }] : [],
		});
		const updates: AgentEvent[] = [];
		agent.subscribe(event => { if (event.type === "message_update") updates.push(event); });
		await session.prompt("Stream normally");
		await session.waitForIdle();
		expect(updates.some(event => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")).toBe(true);
		expect(assistantTexts(agent.state.messages)).toEqual([UNSAFE]);
		expect(gateCalls).toBe(0);
	});

	it.each(["error", "malformed", "timeout"] as const)("fails closed for a publication handler %s", async failure => {
		const pending = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		testSetExtensionHandlerTimeoutMs(25);
		const { session, agent } = harness({ handlers: [event => {
			signal = event.signal;
			if (failure === "error") throw new Error("Gate failed");
			if (failure === "malformed") return { replacementText: 7 };
			return pending.promise;
		}, () => undefined] });
		try {
			await session.prompt("Report completion");
			await session.waitForIdle();
			expect(assistantTexts(agent.state.messages)).toEqual([ASSISTANT_GATE_REFUSAL]);
			if (failure === "timeout") expect(signal?.aborted).toBe(true);
		} finally {
			pending.resolve();
		}
	});

	it("cancels a pending gate without publishing its draft or leaving prompt busy", async () => {
		const entered = Promise.withResolvers<boolean>();
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const { session, agent, manager } = harness({ handlers: [async event => {
			signal = event.signal;
			entered.resolve(true);
			await release.promise;
			return undefined;
		}] });
		const prompt = session.prompt("Report completion");
		try {
			expect(await Promise.race([entered.promise, prompt.then(() => false)])).toBe(true);
			await session.abort();
			await prompt;
			await session.waitForIdle();
			expect(signal?.aborted).toBe(true);
			expect(assistantTexts(agent.state.messages)).toEqual([ASSISTANT_GATE_REFUSAL]);
			expect(assistantTexts(manager.buildSessionContext().messages)).not.toContain(UNSAFE);
			expect(agent.state.isStreaming).toBe(false);
			expect(agent.state.streamMessage).toBeNull();
		} finally {
			release.resolve();
			await prompt;
		}
	});
});
