import { expect, test } from "bun:test";
import type { AssistantMessage, Message, Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { runLeadSequence } from "./eval/lead-sequence";
const tools: Tool[] = ["todo", "read", "write"].map(name => ({
	name,
	description: name,
	parameters: {
		type: "object",
		properties: { op: { type: "string" }, path: { type: "string" } },
		required: name === "todo" ? ["op"] : ["path"],
	},
}));
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id: `${name}-${JSON.stringify(args)}`,
	name,
	arguments: args,
});
const view = call("todo", { op: "view" });
const target = call("todo", { op: "done" });
const scenario = {
	context: "frozen context",
	phases: [{ name: "Delivery" }],
	expected: { tool: "todo", args: { op: "done" } },
};
async function run(
	batches: ToolCall[][],
	expected: { tool: string; args: Record<string, unknown> } = scenario.expected,
) {
	const seen: Message[][] = [];
	const result = await runLeadSequence({ ...scenario, expected }, tools, [], async messages => {
		seen.push(structuredClone(messages));
		return {
			role: "assistant",
			content: batches[seen.length - 1],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			timestamp: 0,
		} satisfies AssistantMessage;
	});
	return { ...result, seen };
}
test("three simulated reads can precede the required mutation without executing host tools", async () => {
	const result = await run([[view], [view], [view], [target]]);
	expect(result.terminalCall).toEqual(target);
	expect(result.calls).toEqual([view, view, view, target]);
	const replay = result.seen[1].find(m => m.role === "toolResult");
	expect(replay?.content).toEqual([
		{ type: "text", text: JSON.stringify({ context: scenario.context, phases: scenario.phases }) },
	]);
});
test("a fourth read exhausts the budget before another provider request", async () => {
	const result = await run([[view], [view], [view], [view], [target]]);
	expect(result.failure).toContain("budget exhausted");
	expect(result.seen).toHaveLength(4);
});
test("a wrong mutation in a batch fails even when the expected call follows", async () => {
	const result = await run([[call("write", { path: "/must-not-write" }), target]]);
	expect(result.failure).toContain("Wrong call");
	expect(result.terminalCall).toBeUndefined();
	expect(result.calls).toHaveLength(2);
});
test("a malformed call fails before simulation", async () => {
	expect((await run([[call("read", {})], [target]])).failure).toContain("Invalid tool schema");
});
test("a different inspection cannot satisfy or precede an explicitly required read", async () => {
	expect((await run([[view]], { tool: "read", args: { path: "agent://holder" } })).failure).toContain("Wrong call");
});
