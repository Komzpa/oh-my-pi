import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	INTERRUPTED_TURN_ERROR,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createRestartQueueController } from "@oh-my-pi/pi-coding-agent/task/restart-queue";
import type { ExtensionFormDialogResult, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { isRecord, postmortem, TempDir } from "@oh-my-pi/pi-utils";

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

function appendRestartTransitions(sessionManager: SessionManager, requestId: string, afterQueued?: () => void): void {
	const sessionId = sessionManager.getSessionId();
	const requestedAt = Date.now();
	sessionManager.appendCustomMessageEntry(
		"restart-queued",
		`Restart ${requestId} is queued. Do not start another model turn until it completes.`,
		true,
		{ requestId, state: "queued" },
	);
	for (const [index, state] of ["queued", "draining", "checkpointed", "restarting"].entries()) {
		const updatedAt = requestedAt + index;
		sessionManager.appendCustomEntry("restart_request_transition", {
			version: 1,
			identity: { instanceId: "before-restart", sessionId, generation: 1 },
			record: {
				version: 1,
				requestId,
				sessionId,
				state,
				requestedAt,
				updatedAt,
				rootWasRunning: false,
			},
		});
		if (state === "queued") afterQueued?.();
	}
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
		modelInputs?: string[],
	) {
		const sessionManager = SessionManager.inMemory();
		for (const message of persisted) sessionManager.appendMessage(message);
		return open(model, sessionManager, tools, responses, evalToolSession, modelInputs);
	}

	/** A session over `sessionManager`'s transcript, its model answering from `responses`. */
	function open(
		model: Model,
		sessionManager: SessionManager,
		tools: AgentTool[],
		responses: MockHandler[],
		evalToolSession?: ToolSession,
		modelInputs?: string[],
	) {
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: sessionManager.buildSessionContext().messages,
			},
			streamFn: (model, context, options) => {
				modelInputs?.push(JSON.stringify(context.messages));
				return mock.stream(model, context, options);
			},
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

	it("goes on with a request its owner's shutdown cut off, not with one a normal quit stopped", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const stops: Array<{ label: string; stop: (session: AgentSession) => Promise<void>; restored: boolean }> = [
			// Lifecycle teardown of a running revived agent: the dispose itself cuts the request off.
			{ label: "process-exit dispose", stop: s => s.dispose({ reason: postmortem.Reason.EXIT }), restored: true },
			// Task executor on manager shutdown: the run aborts first, then its session is released.
			{
				label: "shutdown abort, then process-exit dispose",
				stop: async s => {
					await s.abort({ reason: INTERRUPTED_TURN_ERROR });
					await s.dispose({ reason: postmortem.Reason.EXIT });
				},
				restored: true,
			},
			{ label: "normal quit", stop: s => s.dispose(), restored: false },
		];
		for (const [index, { label, stop, restored }] of stops.entries()) {
			const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `shutdown-${index}`));
			const requested = Promise.withResolvers<void>();
			const first = open(
				model,
				sessionManager,
				[],
				[
					() => {
						requested.resolve();
						return { delayMs: 60_000, content: ["never streamed"] };
					},
				],
			).session;
			const running = first.prompt("work").catch(() => {});
			await requested.promise;
			await stop(first);
			await running;
			session = undefined;

			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session file");
			const { session: second, mock } = open(
				model,
				await SessionManager.open(file),
				[],
				[{ content: ["done after restore"], stopReason: "stop" }],
			);
			expect({ label, restored: await second.restoreInterruptedTurn() }).toEqual({ label, restored });
			await second.waitForIdle();
			expect({ label, calls: mock.calls.length }).toEqual({ label, calls: restored ? 1 : 0 });
			await second.dispose();
			session = undefined;
		}
	});

	it("goes on again with a restored turn a second shutdown cut off", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		let started = Promise.withResolvers<void>();
		const hang: AgentTool<typeof probeSchema> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: probeSchema,
			async execute(_toolCallId, _params, signal) {
				started.resolve();
				const aborted = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				throw new Error("probe aborted");
			},
		};
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "shutdown-twice"));
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		const first = open(
			model,
			sessionManager,
			[hang as AgentTool],
			[{ content: [{ type: "toolCall", name: "probe", arguments: { value: "again" } }] }],
		).session;
		const running = first.prompt("run the probe").catch(() => {});
		await started.promise;
		await first.dispose({ reason: postmortem.Reason.EXIT });
		await running;

		// The restored turn replays the cut-off call (a scheduled continuation), and the next shutdown cuts it off too.
		started = Promise.withResolvers<void>();
		const second = open(model, await SessionManager.open(file), [hang as AgentTool], []).session;
		await expect(second.restoreInterruptedTurn()).resolves.toBe(true);
		await started.promise;
		await second.dispose({ reason: postmortem.Reason.EXIT });

		const executed: string[] = [];
		const { session: third, mock } = open(
			model,
			await SessionManager.open(file),
			[probeTool(executed)],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);
		await expect(third.restoreInterruptedTurn()).resolves.toBe(true);
		await third.waitForIdle();
		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
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
	for (const recovery of ["legacy", "legacy-text", "resume", "restore", "rolling"] as const) {
		it(`reopens an unanswered ask on ${recovery}, preserving completed siblings and one answer across restart`, async () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const html =
				'<form><label>Deploy where?<select name="deploy"><option>Here</option><option>There</option></select></label></form>';
			const input =
				recovery === "legacy-text"
					? { questions: [{ id: "deploy", question: "Deploy where?" }] }
					: recovery === "legacy"
						? {
								questions: [
									{
										id: "deploy",
										question: "Deploy where?",
										options: [{ label: "Here" }, { label: "There" }],
									},
								],
							}
						: { html };
			const persisted: Message[] = [
				{ role: "user", content: "choose", timestamp: Date.now() },
				assistant(model, {
					stopReason: "toolUse",
					content: [
						{ type: "toolCall", id: "completed", name: "probe", arguments: {} },
						{ type: "toolCall", id: "original_ask", name: "ask", arguments: input },
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
				formDialog: async (requested: string) => {
					expect(await reopened.session.restorePendingAsk(ui)).toBe(false);
					shown.push(requested);
					return { data: { deploy: "There" } };
				},
			} as unknown as ExtensionUIContext;
			const restored =
				recovery === "resume"
					? await reopened.session.restorePendingAsk(ui)
					: (await reopened.session.restorePendingAsk(ui)) || (await reopened.session.restoreInterruptedTurn());
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
			if (recovery !== "legacy-text") {
				expect(JSON.stringify(shown)).toContain("Here");
				expect(JSON.stringify(shown)).toContain("There");
			}
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

	it.each(["html", "legacy"] as const)(
		"restores a %s form before restart continuation, preserving saved images and sending unanswered fields as chat",
		async format => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const html =
				'<form><label>Which region?<select name="region"><option>east</option><option>west</option></select></label><label>Which version?<input name="version"></label></form>';
			const input =
				format === "html"
					? { html }
					: {
							questions: [
								{ id: "region", question: "Which region?", options: [{ label: "east" }, { label: "west" }] },
								{
									id: "version",
									question: "Which version?",
									options: [{ label: "stable" }, { label: "canary" }],
								},
							],
						};
			const image: ImageContent = { type: "image", data: "AQID", mimeType: "image/png" };
			const submittedAnswer = format === "html" ? "3.14" : "Other: 3.14";
			const askCallId = "async-ask-call";
			const dialog = Promise.withResolvers<ExtensionFormDialogResult | undefined>();
			const shown: string[] = [];
			const dialogOptions: unknown[] = [];
			const ui = {
				askDialog: () => {
					throw new Error("Legacy question API must not open");
				},
				formDialog: (requested: string, options: unknown) => {
					shown.push(requested);
					dialogOptions.push(options);
					return dialog.promise;
				},
			} as unknown as ExtensionUIContext;
			const modelInputs: string[] = [];
			const { session: restored } = reopen(
				model,
				[
					{ role: "user", content: "choose deployment", timestamp: Date.now() },
					assistant(model, {
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: askCallId, name: "ask", arguments: input }],
					}),
					{
						role: "toolResult",
						toolCallId: askCallId,
						toolName: "ask",
						content: [{ type: "text", text: "Pending question; reply in this session's chat" }],
						details: { pending: { id: askCallId, sessionId: "old-instance", ...input } },
						isError: false,
						timestamp: Date.now(),
					},
					assistant(model, { stopReason: "stop" }),
					{
						role: "user",
						content: [{ type: "text", text: `Answer to ${askCallId} [region]: east` }, image],
						timestamp: Date.now(),
					},
					assistant(model, {
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "later-probe", name: "probe", arguments: {} }],
					}),
					{
						role: "toolResult",
						toolCallId: "later-probe",
						toolName: "probe",
						content: [{ type: "text", text: "probe complete" }],
						isError: false,
						timestamp: Date.now(),
					},
					assistant(model, { content: [{ type: "text", text: "later work complete" }] }),
				],
				[],
				[{ content: ["resumed with the answer"], stopReason: "stop" }],
				undefined,
				modelInputs,
			);
			const sessionId = restored.sessionManager.getSessionId();
			appendRestartTransitions(restored.sessionManager, "restart-ask-1");
			let pending = false;
			let pendingAskRestore: Promise<boolean> | undefined;
			const controller = createRestartQueueController({
				session: restored,
				identity: () => ({ instanceId: "new-instance", sessionId, generation: 2 }),
				restart: async () => {},
				restorePendingAsk: onAnswered => {
					pendingAskRestore = restored.restorePendingAsk(ui, onAnswered, () => {
						pending = true;
					});
					return pending;
				},
			});

			try {
				await controller.restore();
				expect(pending).toBe(true);
				expect(shown).toHaveLength(1);
				if (format === "html") expect(shown).toEqual([html]);
				else {
					expect(shown[0]).toContain("Which region?");
					expect(shown[0]).toContain('name="version"');
					const version = parseHtmlForm(shown[0]!).fields.find(field => field.name === "version");
					expect(version?.kind === "choice" && version.other).toBe(true);
				}
				expect(dialogOptions).toEqual([{}]);
				expect(modelInputs).toHaveLength(0);
				const completed = restored.sessionManager
					.getEntries()
					.find(
						entry =>
							entry.type === "custom_message" &&
							isRecord(entry.details) &&
							entry.details.requestId === "restart-ask-1" &&
							entry.details.state === "completed",
					);
				expect(completed?.type === "custom_message" ? completed.content : undefined).toContain(" completed;");
				expect(
					restored.sessionManager
						.getEntries()
						.filter(
							entry =>
								entry.type === "custom_message" &&
								isRecord(entry.details) &&
								entry.details.requestId === "restart-ask-1" &&
								entry.details.state === "completed",
						),
				).toHaveLength(1);
				expect(
					restored.sessionManager
						.getEntries()
						.filter(entry => entry.type === "custom" && entry.customType === "restart_request_transition")
						.at(-1),
				).toMatchObject({ data: { record: { state: "completed" } } });

				dialog.resolve({ data: { region: "west", version: "3.14" } });
				await pendingAskRestore;
				await restored.waitForIdle();
				await restored.settleInFlightMessagePersistence();
				const context = modelInputs.join("\n");
				expect(modelInputs).toHaveLength(1);
				expect(
					restored.sessionManager
						.getBranchView()
						.filter(
							entry =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === askCallId,
						),
				).toHaveLength(1);
				expect(context).toContain(`Answer to ${askCallId} [region]: east`);
				expect(context).toContain(`Answer to ${askCallId} [version]: ${submittedAnswer}`);
				expect(context).not.toContain(`Answer to ${askCallId} [region]: west`);
				expect(context.indexOf("Restart restart-ask-1 completed")).toBeLessThan(
					context.indexOf(`Answer to ${askCallId} [version]`),
				);
				expect(context).not.toContain("Do not start another model turn until it completes");
				const answer = restored.sessionManager
					.buildSessionContext({ transcript: true })
					.messages.find(
						message =>
							message.role === "user" &&
							typeof message.content === "string" &&
							message.content.includes(`[version]: ${submittedAnswer}`),
					);
				expect(answer).toMatchObject({
					role: "user",
					content: `Answer to ${askCallId} [version]: ${submittedAnswer}`,
				});
				const savedImages = restored.sessionManager
					.buildSessionContext({ transcript: true })
					.messages.flatMap(message =>
						message.role === "user" && Array.isArray(message.content)
							? message.content.filter(part => part.type === "image")
							: [],
					);
				expect(savedImages).toEqual([image]);
			} finally {
				controller.dispose();
			}
		},
	);

	it("replays the restart window with exactly the current pending ask and restores goal work without waking an idle root", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const { session: restored, mock } = reopen(
			model,
			[{ role: "user", content: "choose", timestamp: Date.now() }],
			[],
			[{ content: ["continued after Escape"], stopReason: "stop" }],
		);
		const manager = restored.sessionManager;
		const appendAsk = (id: string) =>
			manager.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "ask",
				content: [{ type: "text", text: "Pending question; reply in this session's chat" }],
				details: {
					pending: {
						id,
						html: `<form><label>Which target for ${id}?<select name="target"><option>Here</option><option>There</option></select></label></form>`,
					},
				},
				timestamp: Date.now(),
				isError: false,
			});
		// Five unanswered asks from earlier process lifetimes, as in the reported journal.
		for (const id of ["call_01a13cec", "call_01a13ec8", "call_01a13efa", "call_01a13f91", "toolu_01UTEsFZ"])
			appendAsk(id);
		appendRestartTransitions(manager, "previous-restart");
		manager.appendCustomEntry("restart_request_transition", {
			version: 1,
			identity: { instanceId: "previous", sessionId: manager.getSessionId(), generation: 0 },
			record: {
				version: 1,
				requestId: "previous-restart",
				sessionId: manager.getSessionId(),
				state: "completed",
				requestedAt: Date.now(),
				updatedAt: Date.now(),
				rootWasRunning: false,
			},
		});
		// Negative control: this ask was answered before the restart.
		appendAsk("toolu_01DGHLakyERoUepEGwJzo3En");
		manager.appendMessage({
			role: "user",
			content: "Answer to toolu_01DGHLakyERoUepEGwJzo3En [target]: Here",
			timestamp: Date.now(),
		});
		const currentAsk = "toolu_0127ueKLLVt1b5XwazFRUV6c";
		appendRestartTransitions(manager, "current-restart", () => appendAsk(currentAsk));
		// A later ask must not be claimed by this restart's recovery either.
		appendAsk("post-checkpoint-ask");
		const shown: string[] = [];
		const dialog = Promise.withResolvers<ExtensionFormDialogResult | undefined>();
		const ui = {
			formDialog: (value: string) => {
				shown.push(value);
				return dialog.promise;
			},
		} as unknown as ExtensionUIContext;
		let restore: Promise<boolean> | undefined;
		let pending = false;
		let goalRestores = 0;
		const latest = manager
			.getBranchView()
			.findLast(entry => entry.type === "custom" && entry.customType === "restart_request_transition");
		if (latest?.type !== "custom" || !isRecord(latest.data) || !isRecord(latest.data.record))
			throw new Error("Missing restart record");
		manager.appendCustomEntry("restart_request_transition", {
			...latest.data,
			record: { ...latest.data.record, goalModeBefore: { goalId: "goal" } },
		});
		const controller = createRestartQueueController({
			session: restored,
			identity: () => ({ instanceId: "after", sessionId: manager.getSessionId(), generation: 2 }),
			restart: async () => {},
			restorePendingAsk: settled => {
				restore = restored.restorePendingAsk(ui, settled, () => {
					pending = true;
				});
				return pending;
			},
			restoreGoalMode: async () => {
				goalRestores++;
			},
		});
		try {
			await controller.restore();
			expect(shown).toHaveLength(1);
			expect(shown[0]).toContain(`Which target for ${currentAsk}?`);
			dialog.resolve(undefined);
			await restore;
			const presentations = manager
				.getBranchView()
				.filter(entry => entry.type === "custom" && entry.customType === "restart_asks_presented");
			expect(presentations.map(entry => (entry.type === "custom" ? entry.data : null))).toEqual([
				{ requestId: "current-restart", toolCallIds: [currentAsk] },
			]);
			expect(goalRestores).toBe(1);
			expect(mock.calls).toHaveLength(0);
			expect(
				manager
					.getBranchView()
					.filter(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(`Answer to ${currentAsk}`),
					),
			).toEqual([]);
			expect(await restored.restorePendingAsk(ui)).toBe(false);
			expect(shown).toHaveLength(1);
		} finally {
			dialog.resolve(undefined);
			controller.dispose();
		}
	}, 2_000);

	it("allows a failed restored ask dialog to be opened again", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const askCallId = "retryable-restored-ask";
		const html = '<form><label>Which target?<input name="target"></label></form>';
		const { session: restored } = reopen(model, [{ role: "user", content: "choose", timestamp: Date.now() }], [], []);
		restored.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: askCallId,
			toolName: "ask",
			content: [{ type: "text", text: "Pending question; reply in this session's chat" }],
			details: { pending: { id: askCallId, html } },
			timestamp: Date.now(),
			isError: false,
		});
		appendRestartTransitions(restored.sessionManager, "retryable-restart");
		let opens = 0;
		const ui = {
			formDialog: async () => {
				opens++;
				if (opens === 1) throw new Error("dialog could not open");
				return undefined;
			},
		} as unknown as ExtensionUIContext;
		const presented = () =>
			restored.sessionManager
				.getBranchView()
				.filter(entry => entry.type === "custom" && entry.customType === "restart_asks_presented");

		try {
			await expect(restored.restorePendingAsk(ui)).rejects.toThrow("dialog could not open");
			expect(presented()).toHaveLength(0);
			expect(await restored.restorePendingAsk(ui, answered => expect(answered).toBe(false))).toBe(true);
			expect(opens).toBe(2);
			expect(presented()).toHaveLength(1);
		} finally {
			await restored.dispose();
			session = undefined;
		}
	});

	it("does not re-present an answered ask or show a dialog when a restart has no pending ask", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		for (const answered of [true, false]) {
			const askCallId = "answered-async-ask";
			const html = '<form><input name="region"><input name="version"></form>';
			const messages: Message[] = answered
				? [
						{ role: "user", content: "choose deployment", timestamp: Date.now() },
						assistant(model, {
							stopReason: "toolUse",
							content: [{ type: "toolCall", id: askCallId, name: "ask", arguments: { html } }],
						}),
						{
							role: "toolResult",
							toolCallId: askCallId,
							toolName: "ask",
							content: [{ type: "text", text: "Pending question" }],
							details: { pending: { id: askCallId, sessionId: "old", html } },
							isError: false,
							timestamp: Date.now(),
						},
						assistant(model, { stopReason: "stop" }),
						{
							role: "user",
							content: `Answer to ${askCallId} [region]: east\nAnswer to ${askCallId} [version]: stable`,
							timestamp: Date.now(),
						},
					]
				: [
						{ role: "user", content: "ordinary finished session", timestamp: Date.now() },
						assistant(model, { content: [{ type: "text", text: "finished" }] }),
					];
			const { session: restored } = reopen(model, messages, [], []);
			appendRestartTransitions(restored.sessionManager, `restart-no-ask-${answered}`);
			const shown: string[] = [];
			const ui = {
				formDialog: async (requested: string) => {
					shown.push(requested);
					return undefined;
				},
			} as unknown as ExtensionUIContext;
			const sessionId = restored.sessionManager.getSessionId();
			const controller = createRestartQueueController({
				session: restored,
				identity: () => ({ instanceId: "new-instance", sessionId, generation: 2 }),
				restart: async () => {},
				restorePendingAsk: onAnswered => {
					let pending = false;
					void restored.restorePendingAsk(ui, onAnswered, () => {
						pending = true;
					});
					return pending;
				},
			});
			try {
				await controller.restore();
				expect(shown).toHaveLength(0);
				expect(
					restored.sessionManager
						.getEntries()
						.filter(
							entry =>
								entry.type === "custom_message" &&
								isRecord(entry.details) &&
								entry.details.requestId === `restart-no-ask-${answered}` &&
								entry.details.state === "completed" &&
								typeof entry.content === "string" &&
								entry.content.includes("completed"),
						),
				).toHaveLength(1);
			} finally {
				controller.dispose();
				await restored.dispose();
				session = undefined;
			}
		}
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
});
