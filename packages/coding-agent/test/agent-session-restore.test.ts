import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createRestartQueueController } from "@oh-my-pi/pi-coding-agent/task/restart-queue";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(model: Model, fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

const probeSchema = type({ value: "string" });

/** A `probe` tool recording each run's `value` in `executed`. */
function probeTool(executed: string[]): AgentTool {
	const tool: AgentTool<typeof probeSchema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Probe tool",
		parameters: probeSchema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
		},
	};
	return tool as AgentTool;
}

/** `persisted` with the records resume-time exit recovery (sdk.ts) closes its cut-off turn with. */
function closedByExitRecovery(persisted: Message[]): Message[] {
	const manager = SessionManager.inMemory();
	for (const message of persisted) manager.appendMessage(message);
	const branch = manager.getBranch();
	const abort = createInterruptedTurnAbortMessage(branch, undefined, { assumeExit: true });
	if (!abort) throw new Error("Expected an unfinished turn to close");
	return [...persisted, ...createInterruptedToolResults(branch), abort];
}

describe("AgentSession.restoreInterruptedTurn (omp --restore)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		await initTheme(false);
		tempDir = TempDir.createSync("@pi-restore-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** A session reopened from `persisted` as `--resume` builds it, its model answering from `responses`. */
	function reopen(
		model: Model,
		persisted: Message[],
		tools: AgentTool[],
		responses: MockResponse[],
		evalToolSession?: ToolSession,
	) {
		const sessionManager = SessionManager.inMemory();
		for (const message of persisted) sessionManager.appendMessage(message);
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: sessionManager.buildSessionContext().messages,
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			evalToolSession,
		});
		session.subscribe(() => {});
		return { session, mock };
	}

	it("goes on with a turn a crash cut off mid tool call, running the cut-off call again", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		// The process died while `probe` ran: no tool result, no session_exit record.
		const { session, mock } = reopen(
			model,
			[
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			],
			[probeTool(executed)],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "done after restore" });
	});

	it("goes on with a turn exit recovery closed when the eval state snapshot follows it (#16195)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const evalToolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getEvalSessionId: () => "restore-eval-state",
		};
		// Eval history makes the reopened session persist an eval state snapshot right
		// after the turn the previous process's exit cut off and resume recovery closed.
		const { session, mock } = reopen(
			model,
			closedByExitRecovery([
				{ role: "user", content: "eval something", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_eval", name: "eval", arguments: { code: "1" } }],
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "call_eval",
					toolName: "eval",
					content: [{ type: "text", text: "1" }],
					isError: false,
					timestamp: Date.now(),
				},
				assistant(model, { content: [{ type: "text", text: "evaluated" }] }),
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			]),
			[probeTool(executed)],
			[{ content: ["done after restore"], stopReason: "stop" }],
			evalToolSession,
		);
		const tail = session.sessionManager.getBranch().at(-1);
		expect(tail?.type === "custom_message" && tail.customType).toBe("eval-state-context");
		// The idle "F5 to Retry" row sees the closed turn through the snapshot too.
		expect(session.hasAbortedToolCallTail).toBe(true);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "done after restore" });
	});

	it("leaves a turn the user interrupted, and one that finished, as they are", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const interrupted: Message[] = [
			{ role: "user", content: "run the probe", timestamp: Date.now() },
			assistant(model, {
				content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "x" } }],
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "probe",
				content: [{ type: "text", text: "Execution interrupted" }],
				isError: true,
				timestamp: Date.now(),
			},
			assistant(model, { stopReason: "aborted", errorMessage: "Interrupted by user" }),
		];
		const finished: Message[] = [
			{ role: "user", content: "say hi", timestamp: Date.now() },
			assistant(model, { content: [{ type: "text", text: "hi" }] }),
		];
		for (const persisted of [interrupted, finished]) {
			const { session, mock } = reopen(model, persisted, [], []);
			await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
			expect(mock.calls.length).toBe(0);
			await session.dispose();
		}
		session = undefined;
	});
	for (const recovery of ["resume", "restore", "rolling"] as const) {
		it(`reopens an unanswered ask on ${recovery}, preserving completed siblings and one answer across restart`, async () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const questions = [
				{ id: "deploy", question: "Deploy where?", options: [{ label: "Here" }, { label: "There" }] },
			];
			const persisted: Message[] = [
				{ role: "user", content: "choose", timestamp: Date.now() },
				assistant(model, {
					stopReason: "toolUse",
					content: [
						{ type: "toolCall", id: "completed", name: "probe", arguments: {} },
						{ type: "toolCall", id: "original_ask", name: "ask", arguments: { questions } },
					],
				}),
				{
					role: "toolResult",
					toolCallId: "completed",
					isError: false,
					toolName: "probe",
					content: [{ type: "text", text: "already done" }],
					timestamp: Date.now(),
				},
			];
			const reopened = reopen(model, persisted, [], [{ content: ["accepted"], stopReason: "stop" }]);
			// SDK resume closes the crashed turn before interactive startup.
			reopened.session.sessionManager.appendCustomEntry("recovery-neighbour", { keep: "original" });
			const branch = reopened.session.sessionManager.getBranch();
			for (const result of createInterruptedToolResults(branch))
				reopened.session.sessionManager.appendMessage(result);
			reopened.session.sessionManager.appendMessage(
				createInterruptedTurnAbortMessage(branch, undefined, { assumeExit: true })!,
			);
			const shown: unknown[] = [];
			const ui = {
				select: async (question: string, options: unknown[]) => {
					expect(await reopened.session.restorePendingAsk(ui)).toBe(false);
					shown.push({ question, options });
					return "There";
				},
			} as unknown as ExtensionUIContext;
			const restored =
				recovery === "resume"
					? await reopened.session.restorePendingAsk(ui)
					: await reopened.session.restoreInterruptedTurn(ui);
			expect(restored).toBe(true);
			await reopened.session.waitForIdle();
			expect(reopened.mock.calls).toHaveLength(1);
			expect(
				reopened.session.sessionManager
					.getBranchView()
					.some(entry => entry.type === "custom" && entry.customType === "recovery-neighbour"),
			).toBe(true);
			expect(shown).toHaveLength(1);
			expect(JSON.stringify(shown)).toContain("Deploy where?");
			expect(JSON.stringify(shown)).toContain("Here");
			expect(JSON.stringify(shown)).toContain("There");
			const messages = reopened.session.sessionManager.buildSessionContext({ transcript: true }).messages;
			const answers = messages.filter(
				message => message.role === "toolResult" && message.toolCallId === "original_ask",
			);
			expect(answers).toHaveLength(1);
			expect(JSON.stringify(answers)).toContain("There");
			expect(
				messages.filter(message => message.role === "toolResult" && message.toolCallId === "completed"),
			).toHaveLength(1);
			await reopened.session.dispose();
			const rawMessages = reopened.session.sessionManager
				.getBranchView()
				.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
			const again = reopen(model, rawMessages as Message[], [], []);
			expect(await again.session.restorePendingAsk(ui)).toBe(false);
			expect(shown).toHaveLength(1);
			await again.session.dispose();
			const cancelled = reopen(
				model,
				[
					...persisted,
					{
						role: "toolResult",
						toolName: "ask",
						toolCallId: "original_ask",
						content: [{ type: "text", text: "Ask tool was cancelled by the user" }],
						isError: true,
						timestamp: Date.now(),
					},
				],
				[],
				[],
			);
			expect(await cancelled.session.restorePendingAsk(ui)).toBe(false);
			expect(shown).toHaveLength(1);
		});
	}

	it("leaves a turn the user interrupted, and one that finished, as they are", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const interrupted: Message[] = [
			{ role: "user", content: "run the probe", timestamp: Date.now() },
			assistant(model, {
				content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "x" } }],
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "probe",
				content: [{ type: "text", text: "Execution interrupted" }],
				isError: true,
				timestamp: Date.now(),
			},
			assistant(model, { stopReason: "aborted", errorMessage: "Interrupted by user" }),
		];
		const finished: Message[] = [
			{ role: "user", content: "say hi", timestamp: Date.now() },
			assistant(model, { content: [{ type: "text", text: "hi" }] }),
		];
		for (const persisted of [interrupted, finished]) {
			const { session, mock } = reopen(model, persisted, [], []);
			await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
			expect(mock.calls.length).toBe(0);
			await session.dispose();
		}
		session = undefined;
	});
});
