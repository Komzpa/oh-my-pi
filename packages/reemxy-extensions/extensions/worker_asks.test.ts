// @ts-nocheck -- disposable extension host and registry fixture.
import { afterEach, expect, test, spyOn } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { installWorkerAskInterrupt } from "./worker_asks";
import { wakeDemand } from "./dispatch_wake";

afterEach(() => {
	mockRegistry?.mockRestore();
});
let mockRegistry;
function harness() {
	const messages = [
		{
			role: "toolResult",
			toolName: "ask",
			timestamp: 1,
			details: {
				pending: {
					id: "ask-1",
					questions: [
						{
							id: "q",
							question: "Physical conflict or solar artefact?",
							options: [{ label: "Show physical conflicts" }],
							recommended: 0,
						},
					],
				},
			},
		},
	];
	mockRegistry = spyOn(AgentRegistry, "global").mockReturnValue({ get: () => ({ session: { messages } }) });
	const hooks = new Map();
	const sent = [];
	installWorkerAskInterrupt({
		on: (name, fn) => hooks.set(name, fn),
		sendMessage: (msg, options) => sent.push({ ...msg, options }),
	});
	const ctx = {
		sessionManager: { getHeader: () => ({ id: "lead" }) },
		getAsyncJobSnapshot: () => ({ running: [{ id: "worker", type: "task" }] }),
	};
	return { hooks, sent, ctx, messages };
}

test("seen worker ask survives prose, unrelated dispatch and failed/wrong-worker answers; successful reject releases gate", async () => {
	const h = harness();
	const call = () => h.hooks.get("tool_call")({ toolName: "yield" }, h.ctx);
	const context = h.hooks.get("context")(
		{ messages: [{ role: "custom", customType: "time-note", content: "late" }] },
		h.ctx,
	);
	expect(context.messages.at(-1).content).toContain("Show physical conflicts");
	await h.hooks.get("turn_end")({}, h.ctx);
	expect(h.sent.at(-1).options).toMatchObject({ triggerTurn: true, deliverAs: "steer" });
	expect(call()?.block).toBe(true);
	for (const event of [
		{ toolName: "task", isError: false },
		{ toolName: "write", input: { path: "agent://worker", content: "Answer to ask-1 [q]: " } },
		{ toolName: "write", input: { path: "agent://other", content: "Answer to ask-1 [q]: reject" } },
		{ toolName: "write", isError: true, input: { path: "agent://worker", content: "Answer to ask-1 [q]: reject" } },
	]) {
		await h.hooks.get("tool_result")(event, h.ctx);
		expect(call()?.block).toBe(true);
	}
	await h.hooks.get("tool_result")(
		{ toolName: "write", isError: false, input: { path: "agent://worker", content: "Answer to ask-1 [q]: reject" } },
		h.ctx,
	);
	expect(call()).toBeUndefined();
});

test("worker question preempts a churning row", () => {
	const phases = [
		{ name: "Ship", tasks: [{ content: "churn", status: "pending", schedule: { cumulativeReestimateCount: 4 } }] },
	];
	const demand = wakeDemand(phases, new Set(), 10, undefined, undefined, [
		{ worker: "PushFitCamera-10", question: "Which oracle?" },
	]);
	expect(demand.churn).toBe(false);
	expect(demand.action).toContain("Which oracle?");
});

test("direct lead questions require a real reply; progress cannot answer or create an ask", () => {
	const h = harness();
	h.messages.length = 0;
	const write = (id, path) => h.messages.push(
		{ role: "assistant", content: [{ type: "toolCall", name: "write", id, arguments: { path, content: "Which existing oracle?" } }] },
		{ role: "toolResult", toolName: "write", toolCallId: id, timestamp: 1 },
	);
	const gate = () => h.hooks.get("tool_call")({ toolName: "yield" }, h.ctx);
	write("progress", "agent://main?progress");
	expect(gate()).toBeUndefined();
	write("question", "agent://main");
	expect(gate()?.block).toBe(true);
	h.messages.push({ role: "custom", customType: "irc:incoming", details: { from: "main", progress: true, message: "Looking" } });
	expect(gate()?.block).toBe(true);
	h.messages.push({ role: "custom", customType: "irc:incoming", details: { from: "main", message: "Use the existing oracle" } });
	expect(gate()).toBeUndefined();
});
