import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Context } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startup() {
	const dir = TempDir.createSync("notice-delivery-");
	cleanups.push(() => dir.removeSync());
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	cleanups.push(() => auth.close());
	auth.keys.setRuntime("openai", "fixture-key");
	const contexts: Context[] = [];
	const mock = createMockModel({
		provider: "openai",
		id: "notice-test",
		handler: context => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			return { content: ["Acknowledged."] };
		},
	});
	const eventBus = new EventBus();
	const preloadedExtensions = await loadExtensions(
		[
			path.join(import.meta.dir, "todo_dispatch.ts"),
			path.join(import.meta.dir, "agent_router.ts"),
			path.join(import.meta.dir, "goal_deadlines.ts"),
		],
		dir.path(),
		eventBus,
	);
	expect(preloadedExtensions.errors).toEqual([]);
	const modelRegistry = new ModelRegistry(auth);
	const sessionManager = SessionManager.inMemory(dir.path());
	const tools: AgentTool[] = ["task", "todo", "wait"].map(name => ({
		name,
		label: name,
		description: "Unused startup fixture tool",
		parameters: type({}),
		execute: async () => {
			throw new Error("Startup must not execute tools");
		},
	}));
	const agent = new Agent({
		getApiKey: () => "fixture-key",
		initialState: { model: mock.model, systemPrompt: ["Test"], tools },
		convertToLlm,
		streamFn: mock.stream,
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "launch.enabled": false });
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		extensionRunner: new ExtensionRunner(
			preloadedExtensions.extensions,
			preloadedExtensions.runtime,
			dir.path(),
			sessionManager,
			modelRegistry,
		),
	});
	cleanups.push(() => session.dispose());
	const errors: unknown[] = [];
	const sends: Promise<unknown>[] = [];
	await initializeExtensions(session, {
		reportSendError: (_action, error) => errors.push(error),
		reportRuntimeError: error => errors.push(error),
		trackExtensionSend: task => sends.push(task),
	});
	await Promise.all(sends);
	await session.waitForIdle();
	expect(errors).toEqual([]);
	const notices = session.agent.state.messages.flatMap(message =>
		message.role === "custom" && ["todo-gate-worker-names", "agent-router-write-guard-notice"].includes(message.customType) ? [message.content] : [],
	);
	expect(notices).toHaveLength(2);
	return { session, contexts, notices };
}

test("loaded harness extensions make zero provider requests before the first user prompt", async () => {
	const { session, contexts, notices } = await startup();
	await Bun.sleep(40);
	expect(contexts).toHaveLength(0);
	await session.prompt("Inspect the fixture.");
	// Stop gates may continue after a real prompt; the idle prefix must stay empty.
	expect(contexts.length).toBeGreaterThanOrEqual(1);
	const input = JSON.stringify(contexts[0]!.messages);
	for (const notice of notices) expect(input).toContain(JSON.stringify(notice).slice(1, -1));
	expect(input).toContain("Inspect the fixture.");
});

test("an explicit peer wake still starts an idle turn with queued harness notices", async () => {
	const { session, contexts, notices } = await startup();
	expect(contexts).toHaveLength(0);
	await session.deliverIrcMessage({
		id: "peer-wake",
		from: "Peer",
		to: "Main",
		body: "WORKER_RECEIPT_READY",
		ts: Date.now(),
	});
	for (let i = 0; i < 100 && contexts.length === 0; i++) await Bun.sleep(10);
	await session.waitForIdle();
	expect(contexts).toHaveLength(1);
	expect(JSON.stringify(contexts[0]!.messages)).toContain("WORKER_RECEIPT_READY");
	for (const notice of notices)
		expect(JSON.stringify(contexts[0]!.messages)).toContain(JSON.stringify(notice).slice(1, -1));
});

test.each([false, true])(
	"a passive notice reaches the next provider input without waking after an internal abort (%s)",
	async abort => {
		const dir = TempDir.createSync("notice-boundary-");
		cleanups.push(() => dir.removeSync());
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		cleanups.push(() => auth.close());
		auth.keys.setRuntime("openai", "fixture-key");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const contexts: Context[] = [];
		const tool: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Wait for test release",
			parameters: type({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "TOOL_FINISHED" }] };
			},
		};
		const mock = createMockModel({
			provider: "openai",
			id: "boundary-test",
			responses: [
				context => {
					contexts.push({ ...context, messages: structuredClone(context.messages) });
					if (abort) {
						started.resolve();
						return { content: ["working"], delayMs: 60_000 };
					}
					return { content: [{ type: "toolCall", id: "hold-1", name: "hold", arguments: {} }] };
				},
				context => {
					contexts.push({ ...context, messages: structuredClone(context.messages) });
					return { content: ["Done."] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test",
			initialState: { model: mock.model, tools: [tool], systemPrompt: ["Test"] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"launch.enabled": false,
		});
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(auth),
			toolRegistry: new Map([[tool.name, tool]]),
		});
		cleanups.push(() => session.dispose());
		const run = session.prompt("go");
		try {
			await started.promise;
			await session.sendCustomMessage(
				{ customType: "info", content: "NOTICE_AT_BOUNDARY", display: false, attribution: "agent" },
				{ deliverAs: "aside", triggerTurn: false },
			);
			expect(contexts).toHaveLength(1);
			if (abort) {
				await session.abort({ reason: "internal" });
				await run;
				await session.waitForIdle();
				expect(contexts).toHaveLength(1);
				await session.prompt("Continue after the internal abort.");
			}
		} finally {
			release.resolve();
			await run;
		}
		expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1]!.messages)).toContain("NOTICE_AT_BOUNDARY");
		if (!abort) expect(JSON.stringify(contexts[1]!.messages)).toContain("TOOL_FINISHED");
	},
);
