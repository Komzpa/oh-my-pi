import type { AssistantMessage, Message, Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { validateToolCall } from "@oh-my-pi/pi-ai/utils/validation";

export function contains(actual: unknown, expected: unknown, taskBrief = false, key = ""): boolean {
	if (taskBrief && key === "task" && typeof actual === "string" && typeof expected === "string")
		return actual.includes(expected);
	if (typeof expected !== "object" || expected === null) return actual === expected;
	if (typeof actual !== "object" || actual === null) return false;
	return Object.entries(expected).every(([key, value]) => contains(Reflect.get(actual, key), value, taskBrief, key));
}

export interface SequenceScenario {
	context: string;
	phases?: unknown;
	expected: { tool: string; args: Record<string, unknown> } | null;
}
export function isReadCall(call: ToolCall): boolean {
	return (
		["read", "grep", "glob", "find"].includes(call.name) || (call.name === "todo" && call.arguments.op === "view")
	);
}

/** No tool executes: reads return only the frozen scenario, never host state. */
export async function runLeadSequence(
	scenario: SequenceScenario,
	tools: Tool[],
	messages: Message[],
	respond: (messages: Message[]) => Promise<AssistantMessage>,
) {
	const calls: ToolCall[] = [];
	const responses: AssistantMessage[] = [];
	let reads = 0;
	let failure: string | undefined;
	let terminalCall: ToolCall | undefined;
	for (;;) {
		let response: AssistantMessage;
		try {
			response = await respond(messages);
		} catch (error) {
			if (responses.length === 0) throw error;
			failure = `Provider request stopped: ${String(error)}`;
			break;
		}
		responses.push(response);
		messages.push(response);
		const batch = response.content.filter(b => b.type === "toolCall");
		calls.push(...batch);
		if (response.stopReason === "error" || response.stopReason === "aborted" || batch.length === 0) break;
		for (const call of batch) {
			try {
				validateToolCall(tools, call);
			} catch {
				failure = `Invalid tool schema: ${call.name}`;
				break;
			}
			const expected = scenario.expected;
			if (expected === null && call.name === "wait") {
				terminalCall = call;
				break;
			}
			if (expected && call.name === expected.tool && contains(call.arguments, expected.args, call.name === "task")) {
				terminalCall = call;
				break;
			}
			// A different read cannot replace an explicitly required inspection.
			if (
				!isReadCall(call) ||
				(expected && isReadCall({ ...call, name: expected.tool, arguments: expected.args }))
			) {
				failure = `Wrong call before expected action: ${call.name}`;
				break;
			}
			if (++reads > 3) {
				failure = "Read-tier budget exhausted (3)";
				break;
			}
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [
					{ type: "text", text: JSON.stringify({ context: scenario.context, phases: scenario.phases ?? null }) },
				],
				isError: false,
				timestamp: 0,
			});
		}
		if (failure || terminalCall) break;
	}
	return { calls, responses, terminalCall, failure };
}
