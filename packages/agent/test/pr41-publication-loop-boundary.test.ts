import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { setAssistantPublicationGate } from "../src/assistant-publication";
import { createAssistantMessage, createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("PR #41 publication loop boundaries", () => {
	it("publishes detached lifecycle snapshots so consumers cannot mutate provider history", async () => {
		const mock = createMockModel({ responses: [{ content: ["unsafe draft"] }] });
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		setAssistantPublicationGate(config, () => ({ replacementText: "approved draft" }));
		const run = agentLoop([createUserMessage("run")], context, config, undefined, mock.stream);
		for await (const event of run) {
			if (event.type === "message_start" || event.type === "message_end") {
				if (event.message.role === "assistant") {
					event.message.content[0] = { type: "text", text: "consumer mutation" };
				}
			}
		}
		const persisted = (await run.result()).find(message => message.role === "assistant");
		expect(persisted?.role === "assistant" ? persisted.content : undefined).toEqual([
			{ type: "text", text: "approved draft" },
		]);
	});

	it("reads a gate installed while a user message is being delivered", async () => {
		const mock = createMockModel({ responses: [{ content: ["unapproved answer"] }] });
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "user") {
				setAssistantPublicationGate(agent, () => ({ replacementText: "gated answer" }));
			}
		});
		await agent.prompt("start run");
		const final = agent.state.messages.at(-1);
		expect(final?.role === "assistant" ? final.content : undefined).toEqual([{ type: "text", text: "gated answer" }]);
	});

	it("withholds open argument previews while a publication gate is active", async () => {
		const previewCalls: string[] = [];
		const tool: AgentTool = {
			name: "streaming-tool",
			label: "Streaming tool",
			description: "Streams arguments",
			parameters: type({ value: "string" }),
			openArgStream(init) {
				return {
					push(delta) {
						init.emit({ delta });
					},
					end() {},
					cancel() {},
				};
			},
			async execute() {
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		let firstCall = true;
		const streamFn: typeof mock.stream = (model, callContext, options) => {
			if (!firstCall) return mock.stream(model, callContext, options);
			firstCall = false;
			const stream = new AssistantMessageEventStream();
			const toolCall = { type: "toolCall" as const, id: "call-1", name: tool.name, arguments: { value: "ok" } };
			const partial = createAssistantMessage([toolCall], "toolUse");
			stream.push({ type: "start", partial });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"ok"}', partial });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
			stream.push({ type: "done", reason: "toolUse", message: partial });
			return stream;
		};
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		setAssistantPublicationGate(config, () => ({ replacementText: "", settled: true }));
		const run = agentLoop([createUserMessage("run")], context, config, undefined, streamFn);
		for await (const event of run) if (event.type === "tool_stream_update") previewCalls.push(event.toolCallId);
		await run.result();
		expect(previewCalls).toEqual([]);
	});

	it("recomputes phase-two concurrency from deferred arguments", async () => {
		const todoSchema = type({ op: "string" });
		const todo: AgentTool<typeof todoSchema> = {
			name: "todo",
			label: "Todo",
			description: "Mutation barrier",
			parameters: todoSchema,
			async execute() {
				return { content: [{ type: "text", text: "updated" }] };
			},
		};
		const bashSchema = type({ pty: "boolean" });
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let secondStarted = false;
		const bash: AgentTool<typeof bashSchema> = {
			name: "bash",
			label: "Bash",
			description: "Argument-dependent concurrency",
			parameters: bashSchema,
			concurrency: args => ((args as { pty: boolean }).pty ? "exclusive" : "shared"),
			async execute(toolCallId) {
				if (toolCallId === "bash-1") {
					firstStarted.resolve();
					await releaseFirst.promise;
				} else {
					secondStarted = true;
				}
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "append" } },
						{ type: "toolCall", id: "bash-1", name: "bash", arguments: { pty: false } },
						{ type: "toolCall", id: "bash-2", name: "bash", arguments: { pty: false } },
					],
				},
				{ content: ["finished"] },
			],
		});
		const run = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: [""], messages: [], tools: [todo, bash] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				beforeToolCall: async ({ toolCall }) =>
					toolCall.name === "bash" ? { args: { pty: toolCall.id === "bash-1" } } : undefined,
			},
			undefined,
			mock.stream,
		);
		const completion = run.result();
		await firstStarted.promise;
		expect(secondStarted).toBe(false);
		releaseFirst.resolve();
		await completion;
		expect(secondStarted).toBe(true);
	});

	it("updates Agent history from effective args on a deferred tool start", async () => {
		const todoSchema = type({ op: "string" });
		const todo: AgentTool<typeof todoSchema> = {
			name: "todo",
			label: "Todo",
			description: "Mutation barrier",
			parameters: todoSchema,
			async execute() {
				return { content: [{ type: "text", text: "updated" }] };
			},
		};
		const bashSchema = type({ pty: "boolean" });
		const bash: AgentTool<typeof bashSchema> = {
			name: "bash",
			label: "Bash",
			description: "Deferred arguments",
			parameters: bashSchema,
			concurrency: args => ((args as { pty: boolean }).pty ? "exclusive" : "shared"),
			async execute() {
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "append" } },
						{ type: "toolCall", id: "bash-1", name: "bash", arguments: { pty: false } },
					],
				},
				{ content: ["finished"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: mock.stream,
			beforeToolCall: ({ toolCall }) => (toolCall.name === "bash" ? { args: { pty: true } } : undefined),
		});
		agent.setTools([todo, bash]);
		let executionArgs: unknown;
		agent.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolCallId === "bash-1") executionArgs = event.args;
		});
		await agent.prompt("run the deferred command");
		const assistant = agent.state.messages.find(
			(message): message is Extract<AgentMessage, { role: "assistant" }> =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "toolCall" && block.id === "bash-1"),
		);
		const storedCall = assistant?.content.find(block => block.type === "toolCall" && block.id === "bash-1");
		expect(executionArgs).toEqual({ pty: true });
		expect(storedCall?.type === "toolCall" ? storedCall.arguments : undefined).toEqual({ pty: true });
	});
});
