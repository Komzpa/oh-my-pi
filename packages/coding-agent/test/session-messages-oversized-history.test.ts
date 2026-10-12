import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { shrinkOversizedToolHistory } from "../src/session/tool-history-shrink";

const HUGE = "A".repeat(400_000);
let clock = 1_700_000_000_000;

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: clock++ } as AgentMessage;
}

function assistant(calls: ToolCall[]): AgentMessage {
	return {
		role: "assistant",
		content: calls,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: clock++,
	} as AgentMessage;
}

function taskCall(id: string, data: unknown): ToolCall {
	return { type: "toolCall", id, name: "task", arguments: { tasks: [{ data }] } };
}

function result(id: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "task",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: clock++,
	} as AgentMessage;
}

function fiveHugeCallTurn(): AgentMessage[] {
	const call: ToolCall = {
		type: "toolCall",
		id: "call-task",
		name: "task",
		arguments: { tasks: [{ images: Array.from({ length: 5 }, () => ({ data: HUGE })) }] },
	};
	return [user("start"), assistant([call]), result(call.id, "task complete")];
}

function toolCalls(messages: Message[]): ToolCall[] {
	return messages.flatMap(m => (m.role === "assistant" ? m.content.filter(b => b.type === "toolCall") : []));
}

function resultText(messages: Message[], id: string): string {
	const message = messages.find(m => m.role === "toolResult" && m.toolCallId === id) as ToolResultMessage;
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

const tempDirs: TempDir[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("convertToLlm oversized tool history", () => {
	it("shrinks five 400KB prior-turn task call arguments below 100KB keeping ids, names and results", () => {
		const messages = [...fiveHugeCallTurn(), user("next")];
		const converted = convertToLlm(messages);

		expect(JSON.stringify(converted).length).toBeLessThan(100_000);
		const calls = toolCalls(converted);
		expect(calls.map(call => [call.id, call.name])).toEqual([["call-task", "task"]]);
		const images = (calls[0]!.arguments.tasks as Array<{ images: Array<{ data: string }> }>)[0]!.images;
		for (const image of images) {
			expect(image.data).toMatch(
				/^\[omitted 400000 bytes, sha256=[0-9a-f]{12}; full value kept in the session file\]$/,
			);
		}
		expect(resultText(converted, "call-task")).toBe("task complete");
		// The caller's history keeps every full image argument.
		const original = (messages[1] as AssistantMessage).content[0] as ToolCall;
		const savedImages = (original.arguments.tasks as Array<{ images: Array<{ data: string }> }>)[0]!.images;
		expect(savedImages.map(image => image.data)).toEqual(Array(5).fill(HUGE));
	});

	it("leaves prior-turn arguments at or below 16KiB unchanged", () => {
		const limit = "é".repeat(8_192); // exactly 16384 UTF-8 bytes
		const messages = [
			user("start"),
			assistant([taskCall("call-small", limit)]),
			result("call-small", "ok"),
			user("next"),
		];
		const call = toolCalls(convertToLlm(messages))[0]!;
		expect((call.arguments.tasks as Array<{ data: string }>)[0]!.data).toBe(limit);
		const original = (messages[1] as AssistantMessage).content[0] as ToolCall;
		expect(Buffer.from(JSON.stringify(call.arguments)).equals(Buffer.from(JSON.stringify(original.arguments)))).toBe(
			true,
		);
	});

	it("shrinks nested string over 16KiB counted in UTF-8 bytes, not UTF-16 length", () => {
		const multibyte = "é".repeat(8_193); // 8193 UTF-16 units, 16386 UTF-8 bytes
		const messages = [
			user("start"),
			assistant([taskCall("call-nested", { deep: [{ value: multibyte }], keep: "short" })]),
			result("call-nested", "ok"),
			user("next"),
		];
		const call = toolCalls(convertToLlm(messages))[0]!;
		const data = (call.arguments.tasks as Array<{ data: { deep: Array<{ value: string }>; keep: string } }>)[0]!.data;
		expect(data.deep[0]!.value).toStartWith("[omitted 16386 bytes, sha256=");
		expect(data.keep).toBe("short");
	});

	it("keeps the current turn's completed call and a pending call unchanged", () => {
		const messages = [
			user("start"),
			assistant([taskCall("call-current", HUGE)]),
			result("call-current", "done"),
			assistant([taskCall("call-pending", HUGE)]),
		];
		const calls = toolCalls(convertToLlm(messages));
		expect(calls.map(call => call.id)).toEqual(["call-current", "call-pending"]);
		for (const call of calls) expect((call.arguments.tasks as Array<{ data: string }>)[0]!.data).toBe(HUGE);
	});

	it("keeps a prior-turn pending call unchanged while shrinking its completed sibling", () => {
		const messages = [
			user("start"),
			assistant([taskCall("call-done", HUGE), taskCall("call-open", HUGE)]),
			result("call-done", "done"),
			user("next"),
		];
		const [done, open] = toolCalls(convertToLlm(messages));
		expect((done!.arguments.tasks as Array<{ data: string }>)[0]!.data).toStartWith("[omitted 400000 bytes");
		expect((open!.arguments.tasks as Array<{ data: string }>)[0]!.data).toBe(HUGE);
	});

	it("keeps UTF-8-safe 8KiB head and tail of a prior-turn tool result over 256KiB", () => {
		const head = "H".repeat(8_191);
		const tail = "T".repeat(8_191);
		// Multi-byte characters straddle both 8192-byte cut points.
		const text = `${head}€${"x".repeat(300_000)}€${tail}`;
		const messages = [user("start"), assistant([taskCall("call-big", "x")]), result("call-big", text), user("next")];
		const shrunk = resultText(convertToLlm(messages), "call-big");
		expect(shrunk).toStartWith(head);
		expect(shrunk).toEndWith(tail);
		expect(shrunk).not.toContain("\uFFFD");
		expect(shrunk).toMatch(/\[omitted \d+ bytes, sha256=[0-9a-f]{12}; full value kept in the session file\]/);
		expect(Buffer.byteLength(shrunk, "utf8")).toBeLessThan(17_000);
		expect(resultText(messages as Message[], "call-big")).toBe(text);
	});

	it("shrinks the previous turn when a new user message is appended to the same array", () => {
		const messages = fiveHugeCallTurn();
		const first = convertToLlm(messages);
		expect(JSON.stringify(first).length).toBeGreaterThan(2_000_000);

		messages.push(user("next"));
		const second = convertToLlm(messages);
		expect(JSON.stringify(second).length).toBeLessThan(100_000);
		expect(toolCalls(second).map(call => call.id)).toEqual(["call-task"]);
		expect(second.at(-1)).toMatchObject({ role: "user" });
	});

	it("leaves the persisted SessionManager file bytes unchanged", async () => {
		const tempDir = TempDir.createSync("@omp-oversized-history-");
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		for (const message of [...fiveHugeCallTurn(), user("next")]) manager.appendMessage(message as never);
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		const before = fs.readFileSync(sessionFile);

		const context = manager.buildSessionContext().messages;
		expect(JSON.stringify(convertToLlm(context)).length).toBeLessThan(100_000);
		await manager.flush();

		expect(fs.readFileSync(sessionFile).equals(before)).toBe(true);
		expect(before.toString("utf8")).toContain(HUGE);
		await manager.close();
	});

	describe("native Responses replay", () => {
		const encrypted = `enc_${"r".repeat(4_096)}`;
		const originalArguments = JSON.stringify({ tasks: [{ data: HUGE }] });

		// Same-model assistant turn whose native items replay instead of content.
		function nativeTurn(): AgentMessage[] {
			const call: ToolCall = {
				type: "toolCall",
				id: "call_native|fc_native",
				name: "task",
				arguments: { tasks: [{ data: HUGE }] },
			};
			const message = {
				...(assistant([call]) as AssistantMessage),
				api: "openai-responses",
				provider: "openai",
				model: "test-native",
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "openai",
					dt: true,
					items: [
						{ type: "reasoning", id: "rs_native", summary: [], encrypted_content: encrypted },
						{
							type: "function_call",
							id: "fc_native",
							call_id: "call_native",
							name: "task",
							arguments: originalArguments,
						},
					],
				},
			} as AgentMessage;
			return [user("start"), message, result(call.id, "task complete")];
		}

		async function encode(messages: Message[]): Promise<Array<Record<string, unknown>>> {
			const model = buildModel({
				id: "test-native",
				name: "Test Native",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400_000,
				maxTokens: 128_000,
			});
			return buildResponsesInput({
				model,
				context: { messages },
				strictResponsesPairing: true,
				supportsImageDetailOriginal: true,
				nativeHistory: { replay: true, filterReasoning: false },
			}) as unknown as Array<Record<string, unknown>>;
		}

		function nativeItem(input: Array<Record<string, unknown>>, type: string): Record<string, unknown> {
			const item = input.find(entry => entry.type === type);
			if (!item) throw new Error(`Expected native ${type} item`);
			return item;
		}

		function payloadArguments(message: AgentMessage): string {
			const payload = (message as AssistantMessage).providerPayload as { items: Array<Record<string, unknown>> };
			return payload.items.find(item => item.type === "function_call")!.arguments as string;
		}

		it("encodes elided prior-turn native function_call arguments with reasoning and pairing intact", async () => {
			const messages = [...nativeTurn(), user("next")];
			const converted = convertToLlm(messages);
			const input = await encode(converted);

			expect(JSON.stringify(input).length).toBeLessThan(100_000);
			const call = nativeItem(input, "function_call");
			expect(call).toMatchObject({ call_id: "call_native", name: "task" });
			expect(JSON.parse(call.arguments as string)).toEqual(toolCalls(converted)[0]!.arguments);
			expect(call.arguments).toMatch(/\[omitted 400000 bytes, sha256=[0-9a-f]{12}; full value kept/);
			expect(nativeItem(input, "reasoning").encrypted_content).toBe(encrypted);
			expect(nativeItem(input, "function_call_output")).toMatchObject({
				call_id: "call_native",
				output: "task complete",
			});
			// The user's session copy keeps the full native arguments.
			expect(payloadArguments(messages[1]!)).toBe(originalArguments);
		});

		it("keeps current-turn native arguments full, and the forced whole-context retry elides them", async () => {
			const messages = nativeTurn();
			const current = nativeItem(await encode(convertToLlm(messages)), "function_call");
			expect(current.arguments).toBe(originalArguments);

			const forced = shrinkOversizedToolHistory(messages, true);
			const input = await encode(convertToLlm(forced));
			expect(JSON.stringify(input).length).toBeLessThan(100_000);
			expect(nativeItem(input, "function_call").arguments).toMatch(/^\{"tasks":\[\{"data":"\[omitted 400000 bytes/);
			expect(nativeItem(input, "reasoning").encrypted_content).toBe(encrypted);
			expect(payloadArguments(messages[1]!)).toBe(originalArguments);
		});
	});
});
