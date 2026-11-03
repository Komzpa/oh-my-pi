import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import budgetReminder from "../../coding-agent/src/prompts/system/subagent-yield-reminder.md" with { type: "text" };
import agentRouter from "./agent_router";
import { shouldContinueWorker } from "./worker_continue";

function harness(role = "coder", kind = "sub", messages: unknown[] = []) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	agentRouter({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	const ctx = {
		agent: { kind, name: role, id: "worker-1" },
		sessionManager: {
			getBranch: () =>
				messages.map((message, index) => ({
					type: "message",
					id: String(index),
					parentId: index ? String(index - 1) : null,
					message,
				})),
		},
	} as unknown as ExtensionContext;
	const call = (input: unknown, context = ctx) =>
		handlers.get("tool_call")!({ toolName: "yield", toolCallId: "yield-1", input }, context);
	return { call, ctx };
}

describe("worker continuation gate", async () => {
	test("the registered yield hook refuses an unblocked partial once per worker, then lets it yield", async () => {
		const { call, ctx } = harness();
		expect(await call({ data: "Partial: tests pass; did not commit." })).toEqual({
			block: true,
			reason:
				"Continue: you still have budget. Finish the minimum deliverable (commit what passes) before yielding. Yield partial only with a concrete blocker and the evidence for it.",
		});
		expect(await call({ error: "Checkpoint incomplete; next I would commit." })).toBeUndefined();
		expect(await call({ data: "Not done" }, { ...ctx, agent: { ...ctx.agent, id: "worker-2" } })).toMatchObject({
			block: true,
		});
	});

	test("all requested partial cues request continuation, while a finished report passes", async () => {
		for (const report of [
			"partial",
			"not done",
			"incomplete",
			"next I would commit",
			"remaining: commit",
			"checkpoint incomplete",
			"did not commit",
			"ran out of time",
			"stopping here",
		])
			expect(shouldContinueWorker(report, "coder", false), report).toBe(true);
		expect(await harness().call({ data: "Committed abc123; checks passed." })).toBeUndefined();
	});

	test("concrete external blockers pass without consuming the one refusal", async () => {
		const { call } = harness();
		for (const blocker of [
			"permission denied: /repo/.git/index.lock",
			"sandbox blocked /repo",
			"missing credential: GITHUB_TOKEN",
			"RAM pressure: 1 GiB available",
			"host refusal: load limit",
			"upstream outage: HTTP 503",
			"outside authority: deploy needs lead",
			"ownership conflict: file belongs to other worker",
			"owner decision needed: choose API",
		])
			expect(await call({ error: `Partial. ${blocker}` }), blocker).toBeUndefined();
		expect(await call({ data: "Incomplete; no external blocker." })).toMatchObject({ block: true });
	});

	test("a negated blocker does not excuse stopping", async () => {
		expect(
			await harness().call({ data: "Partial. No permission denied errors; next I would commit." }),
		).toMatchObject({ block: true });
	});

	test("main sessions and read-only roles may yield partial reports", async () => {
		expect(await harness("coder", "main").call({ data: "Partial" })).toBeUndefined();
		for (const role of ["scout", "researcher", "reviewer", "visual-qa", "adversary", "user-shadow", "qa-auditor"])
			expect(await harness(role).call({ data: "Partial" }), role).toBeUndefined();
	});

	test("the real budgetStop reminder exempts the forced wrap-up, while an ordinary idle reminder does not", async () => {
		for (const budgetStop of [true, false]) {
			const content = prompt.render(budgetReminder, { budgetStop, structured: true, retryCount: 1, maxRetries: 3 });
			const { call } = harness("coder", "sub", [{ role: "developer", synthetic: true, content }]);
			expect(await call({ data: "Incomplete; remaining: commit" })).toEqual(
				budgetStop ? undefined : { block: true, reason: expect.stringContaining("Continue:") },
			);
		}
	});

	test("a text-only idle ending is checked when the reminder elicits a data-less yield; incremental sections continue", async () => {
		const { call } = harness("coder", "sub", [
			{ role: "user", content: "Fix and commit" },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Partial; next I would commit." }] },
			{
				role: "developer",
				synthetic: true,
				content: prompt.render(budgetReminder, { structured: true, retryCount: 1, maxRetries: 3 }),
			},
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "yield-1", name: "yield", arguments: { type: "result" } }],
			},
		]);
		expect(await call({ type: ["findings"], data: "Partial" })).toBeUndefined();
		expect(await call({ type: "result" })).toMatchObject({ block: true });
	});
});
