// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
// Bookkeeping for critical-path /fast (syncCriticalFast): record fast as on only when
// setSubagentFastMode returned true AND the worker's model realizes priority; re-apply after the
// worker's model changes (router fallback); never repeat the no-service-tier attempt per request.
// Live 2026-10-02: workers on muse-code/kimi-code hit setFastMode's "no service-tier control"
// path every request because the old bookkeeping recorded the failed attempt as done, and a
// fallback to a codex-lb gpt-6 model never re-applied priority for the new model.
import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { syncCriticalFast, type CriticalFastState } from "./todo_dispatch";

// muse-code/kimi-code: no service-tier family → setFastMode returns false and emits the notice.
const kimiModel = { id: "kimi-k2.6", provider: "muse-code", api: "openai-responses", identity: { class: "kimi" } };
// codex-lb serves OpenAI model ids: openai family → priority is realized on the wire.
const codexLbModel = { id: "gpt-6-luna", provider: "codex-lb", api: "openai-completions", identity: { class: "openai" } };
// OpenRouter Claude has a tier family (setFast succeeds) but never realizes priority.
const openRouterClaude = { id: "anthropic/claude-sonnet-4-6", provider: "openrouter", api: "openai-responses", identity: { class: "anthropic" } };

const registerWorker = (id: string, model: unknown) => {
  const session = { model };
  AgentRegistry.global().register({ id, displayName: id, kind: "sub", session });
  return session;
};

const ctxWith = (calls: Array<[string, boolean]>, ok: () => boolean): ExtensionContext =>
  ({
    getAsyncJobSnapshot: () => ({
      running: [{ id: "job-1", type: "task", status: "running", agentId: "worker-1", label: "Row", startTime: 1 }],
      waiting: [],
      recent: [],
    }),
    setSubagentFastMode: (id: string, enabled: boolean) => {
      calls.push([id, enabled]);
      return ok();
    },
  }) as unknown as ExtensionContext;

const criticalDecision = (critical: boolean) =>
  ({
    forecast: {
      rows: [{ id: "row-1", content: "Row", status: "in_progress", owner: "worker-1", critical }],
    },
  }) as never;

test("tier-less worker: setFast false is not recorded and the attempt is not repeated", () => {
  AgentRegistry.resetGlobalForTests();
  registerWorker("worker-1", kimiModel);
  const calls: Array<[string, boolean]> = [];
  const state: CriticalFastState = new Map();
  const ctx = ctxWith(calls, () => false);
  for (let i = 0; i < 3; i++) syncCriticalFast(ctx, criticalDecision(true), state);
  // One attempt only: every attempt re-emits "The current model has no service-tier control".
  expect(calls).toEqual([["worker-1", true]]);
  expect(state.get("worker-1")).toEqual({ modelKey: "muse-code/kimi-k2.6", wanted: true, on: false });
});

test("fallback kimi → codex-lb re-applies priority after the model change", () => {
  AgentRegistry.resetGlobalForTests();
  const session = registerWorker("worker-1", kimiModel);
  const calls: Array<[string, boolean]> = [];
  const state: CriticalFastState = new Map();
  let ok = false;
  const ctx = ctxWith(calls, () => ok);
  syncCriticalFast(ctx, criticalDecision(true), state);
  syncCriticalFast(ctx, criticalDecision(true), state);
  expect(calls).toEqual([["worker-1", true]]);
  // The router fallback swaps the worker's model; priority must be applied for the new model.
  session.model = codexLbModel;
  ok = true;
  syncCriticalFast(ctx, criticalDecision(true), state);
  expect(calls).toEqual([
    ["worker-1", true],
    ["worker-1", true],
  ]);
  expect(state.get("worker-1")).toEqual({ modelKey: "codex-lb/gpt-6-luna", wanted: true, on: true });
  syncCriticalFast(ctx, criticalDecision(true), state);
  expect(calls).toHaveLength(2);
});

test("setFast true on a model that cannot realize priority is not recorded as on", () => {
  AgentRegistry.resetGlobalForTests();
  registerWorker("worker-1", openRouterClaude);
  const calls: Array<[string, boolean]> = [];
  const state: CriticalFastState = new Map();
  const ctx = ctxWith(calls, () => true);
  syncCriticalFast(ctx, criticalDecision(true), state);
  expect(calls).toEqual([["worker-1", true]]);
  expect(state.get("worker-1")).toEqual({ modelKey: "openrouter/anthropic/claude-sonnet-4-6", wanted: true, on: false });
});
