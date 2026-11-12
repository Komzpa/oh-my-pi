import { expect, test } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	api: "openai-responses",
	provider: "test",
	id: "test",
	name: "Test",
	baseUrl: "https://fixture.invalid/v1",
	contextWindow: 8192,
	maxTokens: 2048,
	input: ["text"],
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

// Reconstructed SSE shapes, not a captured live stream. Terminal output=[] also
// guards gateways that deliver real content only through output_item.done.
test.each(["commentary", "analysis", "final_answer"])(
	"keeps message text in phase %s and completed function calls",
	async phase => {
		const items = [
			{
				type: "message",
				id: "msg_1",
				role: "assistant",
				phase,
				content: [{ type: "output_text", text: "Read the next row", annotations: [] }],
				status: "completed",
			},
			{
				type: "function_call",
				id: "fc_1",
				call_id: "call_1",
				name: "read",
				arguments: '{"path":"row.txt"}',
				status: "completed",
			},
		];
		const result = await replay(items);
		expect(result.content.find(block => block.type === "text")).toMatchObject({ text: "Read the next row" });
		expect(result.content.find(block => block.type === "toolCall")).toMatchObject({
			name: "read",
			arguments: { path: "row.txt" },
		});
		expect(result.stopReason).toBe("toolUse");
	},
);

test("reasoning-only and explicitly empty final text remain empty instead of inventing output", async () => {
	const result = await replay([
		{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Waiting for queued work" }] },
		{
			type: "message",
			id: "msg_1",
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "output_text", text: "", annotations: [] }],
			status: "completed",
		},
	]);
	expect(result.content.filter(block => block.type === "text" && block.text.trim())).toEqual([]);
	expect(result.content.filter(block => block.type === "toolCall")).toEqual([]);
	expect(result.stopReason).toBe("stop");
});

async function replay(items: Record<string, unknown>[]) {
	const events = [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
		...items.flatMap((item, output_index) => [
			{ type: "response.output_item.added", output_index, item: { ...item, content: [], summary: [] } },
			{ type: "response.output_item.done", output_index, item },
		]),
		{
			type: "response.completed",
			response: {
				id: "resp_fixture",
				status: "completed",
				output: [],
				usage: { input_tokens: 100, output_tokens: 33, output_tokens_details: { reasoning_tokens: 27 } },
			},
		},
	];
	const stream = streamOpenAIResponses(
		model,
		{ messages: [{ role: "user", content: "Continue", timestamp: 1 }] },
		{
			apiKey: "fixture",
			statefulResponses: false,
			fetch: async () =>
				new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				}),
		},
	);
	for await (const _event of stream) {
		/* drain the actual HTTP/SSE adapter */
	}
	return stream.result();
}
