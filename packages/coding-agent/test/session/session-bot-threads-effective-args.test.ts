import { describe, expect, it } from "bun:test";
import { buildSessionContext } from "../../src/session/session-context";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "../../src/session/exit-diagnostics";
import type { SessionEntry } from "../../src/session/session-entries";

const timestamp = "2026-10-25T00:00:00.000Z";

describe("deferred tool argument persistence", () => {
	it("rebuilds effective args from the start marker without mutating the transcript entry", () => {
		const draft = { task: "old", status: "pending" };
		const effective = { task: "new", status: "completed" };
		const entries = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "do the task" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "todo", arguments: draft }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "custom",
				id: "start-1",
				parentId: "assistant-1",
				timestamp,
				customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
				data: { toolCallId: "call-1", toolName: "todo", startedAt: timestamp, effectiveArguments: effective },
			},
			{
				type: "message",
				id: "result-1",
				parentId: "start-1",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "todo",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			},
		] satisfies SessionEntry[];

		const rebuilt = buildSessionContext(entries).messages.find(message => message.role === "assistant");
		const call = rebuilt?.role === "assistant" ? rebuilt.content.find(block => block.type === "toolCall") : undefined;
		expect(call?.type === "toolCall" ? call.arguments : undefined).toEqual(effective);
		const original = entries[1];
		expect(
			original?.type === "message" && original.message.role === "assistant"
				? original.message.content[0]
				: undefined,
		).toMatchObject({
			arguments: draft,
		});
	});
});
