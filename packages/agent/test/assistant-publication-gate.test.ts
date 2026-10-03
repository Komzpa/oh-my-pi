import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentEvent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { setAssistantPublicationGate } from "@oh-my-pi/pi-agent-core/assistant-publication";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage, createHarmonyMitigationModel } from "./helpers";

const unsafe = "All requested work is done without QA.";
const approved = "Requirements R1 and R2 remain open.";

function assistantEvents(events: AgentEvent[]): AgentEvent[] {
	return events.filter(event =>
		event.type === "message_update" ||
		((event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant") ||
		event.type === "turn_end" || event.type === "agent_end",
	);
}

describe("assistant publication gate", () => {
	it("withholds the first start snapshot and text/thinking/image deltas until admission, publishing only replacement", async () => {
		const mock = createMockModel({ responses: [] });
		const rawSeen = Promise.withResolvers<void>();
		const finishProvider = Promise.withResolvers<void>();
		const gateEntered = Promise.withResolvers<void>();
		const releaseGate = Promise.withResolvers<void>();
		let admitted: AssistantMessage | undefined;
		const interceptedEvents: string[] = [];
		const draft = createAssistantMessage([
			{ type: "text", text: unsafe },
			{ type: "thinking", thinking: "unsafe private reasoning" },
			{ type: "image", data: "unsafe-image", mimeType: "image/png" },
		]);
		draft.providerPayload = { type: "openaiResponsesHistory", items: [{ type: "message", content: unsafe }] };
		draft.usage.output = 23;
		draft.usage.totalTokens = 23;
		const agent = new Agent({
			initialState: { model: mock.model },
			onAssistantMessageEvent: (_message, event) => {
				interceptedEvents.push(event.type);
				if (event.type === "image_end") rawSeen.resolve();
			},
			transformAssistantMessage: message => { message.content[0] = { type: "text", text: "transformed draft" }; },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(async () => {
					stream.push({ type: "start", partial: draft });
					stream.push({ type: "text_delta", contentIndex: 0, delta: unsafe, partial: draft });
					stream.push({ type: "thinking_delta", contentIndex: 1, delta: "unsafe private reasoning", partial: draft });
					stream.push({ type: "image_end", contentIndex: 2, content: { type: "image", data: "unsafe-image", mimeType: "image/png" }, partial: draft });
					await finishProvider.promise;
					stream.push({ type: "done", reason: "stop", message: draft });
				});
				return stream;
			},
		});
		setAssistantPublicationGate(agent, async message => {
			expect(message.content[0]).toEqual({ type: "text", text: "transformed draft" });
			admitted = message;
			gateEntered.resolve();
			await releaseGate.promise;
			return { replacementText: approved, settled: true };
		});

		const events: AgentEvent[] = [];
		const promptRecorded = Promise.withResolvers<void>();
		agent.subscribe(event => {
			events.push(event);
			if (event.type === "message_end" && event.message.role === "user") promptRecorded.resolve();
		});
		const run = agent.prompt("implement");
		await rawSeen.promise;
		expect(interceptedEvents).toEqual(["start", "text_delta", "thinking_delta", "image_end"]);
		await promptRecorded.promise;
		expect(assistantEvents(events)).toEqual([]);
		expect(agent.state.streamMessage).toBeNull();
		expect(agent.state.messages.map(message => message.role)).toEqual(["user"]);
		finishProvider.resolve();
		await gateEntered.promise;
		expect(assistantEvents(events)).toEqual([]);
		expect(agent.state.streamMessage).toBeNull();
		expect(agent.state.messages.map(message => message.role)).toEqual(["user"]);
		releaseGate.resolve();
		await run;
		expect(assistantEvents(events).map(event => event.type)).toEqual(["message_start", "message_end", "turn_end", "agent_end"]);
		expect(agent.state.messages.at(-1)).toBe(admitted);
		expect(admitted?.content).toEqual([{ type: "text", text: approved }]);
		expect(admitted?.providerPayload).toBeUndefined();
		expect(admitted?.usage).toMatchObject({ output: 23, totalTokens: 23 });
		expect(JSON.stringify(events)).not.toContain(unsafe);
		expect(JSON.stringify(events)).not.toContain("unsafe private reasoning");
		expect(JSON.stringify(events)).not.toContain("unsafe-image");
		const admittedMessage = admitted;
		if (!admittedMessage) throw new Error("publication gate did not admit a message");
		for (const event of assistantEvents(events)) {
			if (event.type === "agent_end") {
				const finalMessage = event.messages.at(-1);
				if (!finalMessage) throw new Error("agent_end did not include the admitted message");
				expect(finalMessage).toBe(admittedMessage);
			} else if (
				(event.type === "message_start" || event.type === "message_end") &&
				event.message.role === "assistant"
			) {
				expect(event.message).toBe(admittedMessage);
			}
		}
	});

	it("keeps unguarded sessions streaming before provider completion", async () => {
		const mock = createMockModel({ responses: [] });
		const started = Promise.withResolvers<void>();
		const stream = new AssistantMessageEventStream();
		const draft = createAssistantMessage([{ type: "text", text: "ordinary stream" }]);
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: () => stream });
		agent.subscribe(event => { if (event.type === "message_update") started.resolve(); });
		const run = agent.prompt("hello");
		stream.push({ type: "start", partial: draft });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "ordinary stream", partial: draft });
		await started.promise;
		expect(agent.state.streamMessage).toMatchObject({ content: draft.content });
		stream.push({ type: "done", reason: "stop", message: draft });
		await run;
		expect(agent.state.messages.at(-1)).toMatchObject({ content: draft.content });
	});

	it("preserves transformed tool arguments, ids, execution and pairing when narrative is suppressed", async () => {
		const schema = type({ value: "string" });
		const executed: unknown[] = [];
		const wireFragments: string[] = [];
		const completedArgs: unknown[] = [];
		let argumentStreamCancelled = false;
		const tool: AgentTool<typeof schema> = {
			name: "echo", label: "Echo", description: "Echo", parameters: schema,
			intent: () => unsafe,
			openArgStream: () => ({
				push: delta => { wireFragments.push(delta); },
				end: args => { completedArgs.push(args); },
				cancel: () => { argumentStreamCancelled = true; },
			}),
			async execute(id, args) {
				executed.push({ id, args });
				return { content: [{ type: "text", text: args.value }], details: {} };
			},
		};
		const mock = createMockModel({ responses: [
			{ content: [unsafe, { type: "toolCall", id: "call-1", name: "echo", arguments: { value: "before" } }] },
			{ content: [unsafe] },
		] });
		const agent = new Agent({
			initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream, intentTracing: true,
			transformAssistantMessage: message => {
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					block.arguments = { value: "after" };
					block.intent = unsafe;
					block.rawBlock = 'call echo with {"value":"after"}';
				}
			},
		});
		setAssistantPublicationGate(agent, message => ({ replacementText: message.content.some(block => block.type === "toolCall") ? "" : approved }));

		const events: AgentEvent[] = [];
		agent.subscribe(event => { events.push(event); });
		await agent.prompt("echo");
		expect(executed).toEqual([{ id: "call-1", args: { value: "after" } }]);
		expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_start", toolCallId: "call-1", toolName: "echo" }));
		expect(JSON.parse(wireFragments.join(""))).toEqual({ value: "before" });
		expect(completedArgs).toEqual([{ value: "before" }]);
		expect(argumentStreamCancelled).toBe(false);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(agent.state.messages[1]).toMatchObject({ content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "after" } }] });
		expect(agent.state.messages[1]).toMatchObject({ content: [{ type: "toolCall", id: "call-1", name: "echo", rawBlock: 'call echo with {"value":"after"}', arguments: { value: "after" } }] });
		const admittedToolTurn = agent.state.messages[1];
		if (!admittedToolTurn || admittedToolTurn.role !== "assistant") throw new Error("tool turn was not persisted");
		expect(admittedToolTurn.content[0]).not.toHaveProperty("intent");
		expect(agent.state.messages[2]).toMatchObject({ toolCallId: "call-1", content: [{ type: "text", text: "after" }] });
		expect(JSON.stringify(events)).not.toContain(unsafe);
	});

	it("keeps tool execution and pairing intact when its narrative gate rejects", async () => {
		const schema = type({ value: "string" });
		const executed: unknown[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "echo", label: "Echo", description: "Echo", parameters: schema,
			async execute(id, args) {
				executed.push({ id, args });
				return { content: [{ type: "text", text: args.value }], details: {} };
			},
		};
		const mock = createMockModel({ responses: [
			{ content: [unsafe, { type: "toolCall", id: "rejected-call", name: "echo", arguments: { value: "keep" } }] },
			{ content: [unsafe] },
		] });
		const agent = new Agent({
			initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream,
		});
		setAssistantPublicationGate(agent, () => { throw new Error("delivery handler failed"); });

		const events: AgentEvent[] = [];
		agent.subscribe(event => { events.push(event); });
		await agent.prompt("echo");
		expect(executed).toEqual([{ id: "rejected-call", args: { value: "keep" } }]);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(agent.state.messages[2]).toMatchObject({ toolCallId: "rejected-call" });
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(events)).not.toContain(unsafe);
	});

	for (const failure of ["reject", "abort"] as const) {
		it(`fails closed on gate ${failure} without waiting for a stuck hook or publishing raw text`, async () => {
			const mock = createMockModel({ responses: [{ content: [unsafe] }] });
			const entered = Promise.withResolvers<void>();
			const pending = Promise.withResolvers<void>();
			const agent = new Agent({
				initialState: { model: mock.model }, streamFn: mock.stream,
			});
			setAssistantPublicationGate(agent, async () => {
				entered.resolve();
				if (failure === "reject") throw new Error("gate failed");
				await pending.promise;
			});

			const events: AgentEvent[] = [];
			agent.subscribe(event => { events.push(event); });
			const run = agent.prompt("implement");
			await entered.promise;
			if (failure === "abort") agent.abort();
			await run;
			pending.resolve();
			expect(JSON.stringify(events)).not.toContain(unsafe);
			expect(JSON.stringify(agent.state.messages)).not.toContain(unsafe);
			expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: failure === "abort" ? "aborted" : "stop" });
			expect(agent.state.isStreaming).toBe(false);
		});
	}

	for (const outcome of ["done", "fail", "abort"] as const) {
		it(`gates Cursor ${outcome} finalization while retaining the executed tool result`, async () => {
			const mock = createMockModel({ responses: [] });
			const toolCall = { type: "toolCall" as const, id: "cursor-1", name: "shell", arguments: { command: "pwd" }, [kCursorExecResolved]: true };
			const draft = createAssistantMessage([{ type: "text", text: unsafe }, toolCall]);
			const result: ToolResultMessage = { role: "toolResult", toolCallId: "cursor-1", toolName: "shell", content: [{ type: "text", text: "/workspace" }], timestamp: 1, isError: false };
			const seen = Promise.withResolvers<void>();
			const agent = new Agent({
				initialState: { model: mock.model },
				onAssistantMessageEvent: () => { seen.resolve(); },
				streamFn: (_model, _context, options) => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(async () => {
						await options?.cursorOnToolResult?.(result);
						stream.push({ type: "start", partial: draft });
						stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: draft });
						if (outcome === "done") stream.push({ type: "done", reason: "stop", message: draft });
						if (outcome === "fail") stream.fail(new Error("connection reset"));
					});
					return stream;
				},
			});
			setAssistantPublicationGate(agent, () => ({ replacementText: approved }));

			const events: AgentEvent[] = [];
			agent.subscribe(event => { events.push(event); });
			const run = agent.prompt("pwd");
			await seen.promise;
			if (outcome === "abort") agent.abort();
			await run;
			expect(JSON.stringify(events)).not.toContain(unsafe);
			expect(agent.state.messages.filter(message => message.role === "toolResult")).toEqual([result]);
			const assistant = agent.state.messages.find(message => message.role === "assistant");
			expect(assistant?.content.filter(block => block.type === "toolCall")).toMatchObject([toolCall]);
			expect(assistant?.stopReason).toBe(outcome === "done" ? "stop" : outcome === "fail" ? "error" : "aborted");
		});
	}

	it("gates a zero-event trailing result and persists the callback identity", async () => {
		const mock = createMockModel({ responses: [] });
		const draft = createAssistantMessage([{ type: "text", text: unsafe }]);
		let admitted: AssistantMessage | undefined;
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				stream.end(draft);
				return stream;
			},
		});
		setAssistantPublicationGate(agent, message => {
			admitted = message;
			return { replacementText: approved };
		});

		const events: AgentEvent[] = [];
		agent.subscribe(event => { events.push(event); });
		await agent.prompt("implement");
		expect(agent.state.messages.at(-1)).toBe(admitted);
		expect(admitted?.content).toEqual([{ type: "text", text: approved }]);
		expect(JSON.stringify(events)).not.toContain(unsafe);
	});

	it("never publishes discarded Harmony attempts before gating the clean retry", async () => {
		const leak = `${unsafe} analysis to=functions.edit code`;
		const mock = createMockModel({ provider: "openai-codex", responses: [{ content: [leak] }, { content: [unsafe] }] });
		const agent = new Agent({ initialState: { model: createHarmonyMitigationModel() }, streamFn: mock.stream });
		setAssistantPublicationGate(agent, () => ({ replacementText: approved }));
		const events: AgentEvent[] = [];
		agent.subscribe(event => { events.push(event); });
		await agent.prompt("implement");
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(events)).not.toContain(unsafe);
		expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: approved }] });
	});
});
