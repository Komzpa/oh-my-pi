// @ts-nocheck -- exercises the registered tool_call hook with a disposable worker context.
import { expect, test } from "bun:test";
import { EXTENSION_HANDLER_TIMEOUT_MS } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import agentRouter, { SLOW_YIELD_GATE_ENTRY, YIELD_GATE_BUDGET_MS } from "./agent_router";

// Live DC 2026-11-05 21:4x: "agent_router.ts extension yield timeout (30000ms) again killed
// StakeholderDocs after completed commit 2619fa3c; third occurrence this hour".
function harness(yieldGate, yieldGateBudgetMs) {
	const handlers = new Map();
	const entries = [];
	agentRouter(
		{ setLabel: () => undefined, on: (event, handler) => handlers.set(event, handler), appendEntry: (customType, data) => entries.push({ customType, data }) },
		undefined,
		{ yieldGate, yieldGateBudgetMs },
	);
	const ctx = {
		cwd: process.cwd(),
		agent: { kind: "sub", name: "coder", id: "StakeholderDocs" },
		sessionManager: { getHeader: () => ({ id: "worker" }), getBranch: () => [] },
	};
	const yieldCall = () => handlers.get("tool_call")({ toolName: "yield", toolCallId: "y1", input: { result: { commit: "2619fa3c" } } }, ctx);
	return { entries, yieldCall };
}

const after = (ms, value) => new Promise(resolve => { const timer = setTimeout(() => resolve(value), ms); timer.unref?.(); });

test("the yield gate answers inside the host's extension handler timeout", () => {
	expect(YIELD_GATE_BUDGET_MS).toBeLessThan(EXTENSION_HANDLER_TIMEOUT_MS);
});

test("a yield hook slower than 30 s after a completed commit never blocks the worker's result", async () => {
	let calls = 0;
	// The check would take 31 s and then refuse; the budget answers first and lets the yield stand.
	const { entries, yieldCall } = harness(() => { calls++; return after(31_000, { block: true, reason: "late refusal" }); }, 25);
	const started = Date.now();
	const result = await yieldCall();
	expect(Date.now() - started).toBeLessThan(5_000);
	expect(calls).toBe(1);
	expect(result).toBeUndefined();
	const slow = entries.filter(entry => entry.customType === SLOW_YIELD_GATE_ENTRY);
	expect(slow).toHaveLength(1);
	expect(slow[0].data).toMatchObject({ agentId: "StakeholderDocs", toolCallId: "y1", budgetMs: 25 });
});

test("negative control: a fast refusal inside the budget still blocks the yield", async () => {
	const { entries, yieldCall } = harness(async () => ({ block: true, reason: "Uncommitted tracked changes: commit or discard, then yield" }), 5_000);
	const result = await yieldCall();
	expect(result).toMatchObject({ block: true });
	expect(entries).toHaveLength(0);
});

test("neighbour: a fast pass inside the budget records nothing", async () => {
	const { entries, yieldCall } = harness(async () => undefined, 5_000);
	expect(await yieldCall()).toBeUndefined();
	expect(entries).toHaveLength(0);
});
