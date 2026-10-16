import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { forecastTodoPlan, formatPlanForecast, formatTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch from "./todo_dispatch";

test("session restoration finishes while quota discovery remains pending", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  todoDispatch({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    getActiveTools: () => [], appendEntry: () => {}, sendMessage: () => {},
    pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast },
  } as unknown as ExtensionAPI);
  const quota = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const ctx = {
    cwd: "/tmp/quota-restoration",
    sessionManager: { getHeader: () => ({ id: "quota-test", parentSession: "root" }),
      getSessionId: () => "quota-test", getBranch: () => [], getBranchMatching: () => [], getLatestBranchMatching: () => undefined },
    models: { resolve: (spec: string) => { const [provider, ...id] = spec.split("/"); return { provider, id: id.join("/") }; },
      list: () => [{ provider: "codex-lb", id: "gpt-6.1-sol" }, { provider: "anthropic", id: "claude-sonnet-5-5" }] },
    modelRegistry: { authStorage: { health: { model: async () => { calls++; entered.resolve(); await quota.promise; return { state: "healthy", accounts: [] }; } } } },
    getAsyncJobSnapshot: () => ({ running: [], recent: [] }), setInterval: () => 0, clearInterval: () => {},
  } as unknown as ExtensionContext;
  try {
    const restored = Promise.resolve(handlers.get("session_start")!({}, ctx)).then(() => true);
    await entered.promise;
    expect(await Promise.race([restored, Bun.sleep(100).then(() => false)])).toBe(true);
    expect(calls).toBe(1);
    await handlers.get("session_switch")!({}, ctx);
    expect(calls).toBe(1);
  } finally {
    quota.resolve();
  }
});
