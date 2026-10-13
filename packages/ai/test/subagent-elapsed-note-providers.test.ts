// The subagent elapsed note (`elapsed Ns / 900s`) is provider-only scaffolding.
// Providers with an active-turn wire (Cursor) must not promote it to the active
// user action, and chained Responses requests must keep it out of the baseline.
import { describe, expect, it } from "bun:test";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai/types";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { isSubagentElapsedNote } from "@oh-my-pi/pi-ai/utils/subagent-elapsed-note";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgentClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function elapsedNote(seconds: number): Message {
	const note: Message = {
		role: "developer",
		content: `elapsed ${seconds}s / 900s`,
		synthetic: true,
		timestamp: 3,
	};
	markPerCallContextMessage(note);
	return note;
}

describe("isSubagentElapsedNote", () => {
	it("matches only the synthetic elapsed developer note", () => {
		expect(isSubagentElapsedNote(elapsedNote(5))).toBe(true);
		expect(isSubagentElapsedNote({ role: "developer", content: "elapsed 5s / 900s", timestamp: 0 })).toBe(false);
		expect(isSubagentElapsedNote({ role: "developer", content: "continue", synthetic: true, timestamp: 0 })).toBe(
			false,
		);
		expect(isSubagentElapsedNote({ role: "user", content: "elapsed 5s / 900s", timestamp: 0 })).toBe(false);
	});
});

describe("Cursor with the elapsed note", () => {
	const model: Model<"cursor-agent"> = buildModel({
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 200_000,
		maxTokens: 32_000,
	});

	async function actionCase(messages: Message[]): Promise<string | undefined> {
		const { requestBytes } = await buildGrpcRequest(model, { messages }, undefined, {
			conversationId: "conv-1",
			blobStore: new Map(),
		});
		const run = (fromBinary(AgentClientMessageSchema, requestBytes).message as unknown as { value: any }).value;
		return run.action?.action?.case;
	}

	it("keeps resumeAction after tool results when the note trails", async () => {
		const history: Message[] = [
			{ role: "user", content: "go", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
				api: "cursor-agent",
				provider: "cursor",
				model: "gpt-5.6-terra",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		];
		expect(await actionCase(history)).toBe("resumeAction");
		expect(await actionCase([...history, elapsedNote(5)])).toBe("resumeAction");
	});

	it("still sends a trailing real user turn as userMessageAction", async () => {
		const messages: Message[] = [{ role: "user", content: "hello", timestamp: 0 }, elapsedNote(5)];
		expect(await actionCase(messages)).toBe("userMessageAction");
	});
});

describe("OpenAI Responses with the elapsed note", () => {
	const model: Model<"openai-responses"> = buildModel({
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 200_000,
		maxTokens: 32_000,
	});

	it("marks the trailing note as scaffolding so it stays out of the chain baseline", () => {
		const context: Context = {
			messages: [{ role: "user", content: "go", timestamp: 0 }, elapsedNote(7)],
		};
		const { params, trailingScaffoldingItems } = buildParams(model, context, undefined, undefined);
		expect(trailingScaffoldingItems).toBe(1);
		const input = params.input as Array<{ content?: unknown }>;
		expect(JSON.stringify(input.at(-1))).toContain("elapsed 7s / 900s");
		expect(JSON.stringify(input.slice(0, -1))).not.toContain("elapsed");
	});

	it("reports no scaffolding without the note", () => {
		const context: Context = { messages: [{ role: "user", content: "go", timestamp: 0 }] };
		expect(buildParams(model, context, undefined, undefined).trailingScaffoldingItems).toBe(0);
	});
});
