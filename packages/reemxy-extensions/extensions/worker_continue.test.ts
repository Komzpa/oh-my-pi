import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import budgetReminder from "../../coding-agent/src/prompts/system/subagent-yield-reminder.md" with { type: "text" };
import { YieldTool } from "../../coding-agent/src/tools/yield";
import type { ToolSession } from "../../coding-agent/src/tools";
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
	// Replaces the once-only assertion: partial workers now continue until a bounded goal exit.
	test("partial yields are refused six times, then reach the lead annotated as partial", async () => {
		const { call, ctx } = harness();
		for (let attempt = 0; attempt < 6; attempt++)
			expect(await call({ data: "Partial: tests pass; did not commit." })).toMatchObject({ block: true });
		const decision = (await call({
			data: { report: "Incomplete; remaining: commit", tests: "4/22" },
		})) as ToolCallEventResult;
		expect(decision.block).not.toBe(true);
		const result = await new YieldTool({} as ToolSession).execute("cap-yield", decision.input!);
		expect(result.details).toMatchObject({
			status: "aborted",
			error: 'goal cap reached; partial\n{"report":"Incomplete; remaining: commit","tests":"4/22"}',
		});
		expect(await call({ data: "Not done" }, { ...ctx, agent: { ...ctx.agent, id: "worker-2" } })).toMatchObject({
			block: true,
		});
	});

	test("done needs evidence for every audit row, not just a completion claim", async () => {
		const { call } = harness();
		expect(await call({ data: "Done. Committed abc1234; checks passed." })).toMatchObject({ block: true });
		expect(await call({ data: "Completion audit:\n- Fix bug: done\n- Run tests: all green" })).toMatchObject({
			block: true,
		});
		expect(await call({ data: "Completion audit:\n- Fix bug: src/fix.ts\n- Run tests: unverified" })).toMatchObject({
			block: true,
		});
		expect(
			await call({
				data: "Done. Completion audit:\n- Fix bug: src/fix.ts\n- Run tests: `bun test` → 22 pass\n- Commit changes: abc1234",
			}),
		).toBeUndefined();
	});

	test("a data-less cap ending is accepted with a terminal annotated result", async () => {
		const { call } = harness();
		for (let attempt = 0; attempt < 6; attempt++)
			expect(await call({ type: "result" })).toMatchObject({ block: true });
		const decision = (await call({ type: "result" })) as ToolCallEventResult;
		const result = await new YieldTool({} as ToolSession).execute("cap-yield", decision.input!);
		expect(result.details).toMatchObject({ status: "aborted", error: "goal cap reached; partial" });
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
		expect(await harness().call({ data: "- Commit: abc1234\n- Checks: `bun test` → 22 pass" })).toBeUndefined();
	});

	test("concrete external blockers pass only on their third consecutive yield", async () => {
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
			"BLOCKED: awaiting lead answer: keep 36 ids or the 35 in verdicts.json?",
		]) {
			const { call } = harness();
			expect(await call({ error: `Partial. ${blocker}` }), blocker).toMatchObject({ block: true });
			expect(await call({ error: `Partial. ${blocker}` }), blocker).toMatchObject({ block: true });
			expect(await call({ error: `Partial. ${blocker}` }), blocker).toBeUndefined();
		}
	});

	test("changing or absent blockers reset the streak; case and whitespace do not", async () => {
		const { call } = harness();
		for (const report of [
			"Partial. permission denied: /repo/a",
			"Partial. permission denied: /repo/a",
			"Partial. permission denied: /repo/b",
			"Partial. permission denied: /repo/a",
			"Partial without a blocker",
			"Partial. permission denied: /repo/a",
		])
			expect(await call({ error: report })).toMatchObject({ block: true });
		// The cap must not turn a changed blocker into a verified blocker exit.
		expect(await call({ error: "Partial. permission denied: /repo/c" })).toMatchObject({
			input: { error: expect.stringContaining("goal cap reached; partial") },
		});
		const normalized = harness();
		expect(await normalized.call({ error: "BLOCKED: awaiting lead answer: choose API" })).toMatchObject({
			block: true,
		});
		expect(await normalized.call({ error: "Awaiting   LEAD answer: choose API." })).toMatchObject({ block: true });
		expect(await normalized.call({ error: "awaiting lead answer: choose API" })).toBeUndefined();
	});

	test("a negated blocker does not excuse stopping", async () => {
		expect(
			await harness().call({ data: "Partial. No permission denied errors; next I would commit." }),
		).toMatchObject({ block: true });
	});

	test("main sessions and read-only roles may yield partial reports", async () => {
		expect(await harness("coder", "main").call({ data: "Partial" })).toBeUndefined();
		for (const role of [
			"scout",
			"researcher",
			"reviewer",
			"visual-qa",
			"adversary",
			"user-shadow",
			"qa-auditor",
			"security-reviewer",
			"architect",
			"plan-doctor",
			"business-analyst",
			"retro-facilitator",
		])
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

	test("budget stop remains exempt across later messages and cannot be claimed by worker prose", async () => {
		const messages: unknown[] = [];
		const { call } = harness("coder", "sub", messages);
		expect(await call({ data: "Partial. Request budget crossed; stopping here" })).toMatchObject({ block: true });
		messages.push({
			role: "developer",
			synthetic: true,
			content: prompt.render(budgetReminder, { budgetStop: true, structured: true }),
		});
		messages.push({ role: "user", content: "Wrap up" });
		expect(await call({ data: "Done" })).toBeUndefined();
		messages.length = 0;
		expect(await call({ data: "Partial" })).toBeUndefined();
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

describe("continue reminder wording", () => {
	test("keeps the whole brief as the goal and never asks for a single step", async () => {
		const template = await Bun.file(new URL("./worker-continue.md", import.meta.url)).text();
		for (const flags of [
			{ partial: true, blocker: false },
			{ partial: false, blocker: true },
			{ partial: false, blocker: false },
		]) {
			const text = prompt.render(template, flags).trim();
			expect(text).not.toMatch(/\b(?:next|one) concrete (?:step|alternative)\b/i);
			expect(text).not.toMatch(/\bone (?:more )?step\b/i);
		}
		const partial = prompt.render(template, { partial: true, blocker: false });
		expect(partial).toContain("Keep working through all remaining requirements");
		expect(partial).toContain("do not shrink it");
		const blocker = prompt.render(template, { partial: false, blocker: true });
		expect(blocker).toContain("worked every part of the brief the blocker does not touch");
	});
});
