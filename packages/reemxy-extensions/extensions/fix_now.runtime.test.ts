// @ts-nocheck -- registered hooks with disposable persisted session state.
import { expect, test } from "bun:test";
import { harness } from "./fix-now.fixture";

const row = content => ({ content, status: "pending", schedule: { dependencies: [], estimateMinutes: 10, reestimateCount: 14 } });

test("churn and a slipped forecast do not manufacture owner scope or deadline questions", async () => {
 const h = await harness([row("Cooling trunks"), row("Power source")]);
 h.journal.push({ type: "custom", customType: "reemxy-goal-deadlines", data: {
  version: 1, goalId: "fixture", goalStartedAt: Math.floor(Date.now() / 1000) - 7200,
  timezone: "Asia/Tbilisi", active: true, auto: true, stages: [], baselineDeadlineAt: Math.floor(Date.now() / 1000) - 3600,
 }});
 const feedback = { role: "custom", customType: "async-result", content: "Cooling inspection disproved the old locator; repair the current route." };
 const messages = [feedback, { role: "user", content: "Keep the full scope and deadline; use the findings." }];
 for (let attempt = 0; attempt < 3; attempt++) {
  const shaped = await h.hooks.get("context")({ messages }, h.ctx);
  expect(shaped.messages).toEqual(messages);
  expect(shaped.messages.filter(message => message.runtimeSupervisor)).toHaveLength(0);
 }
 expect(h.journal.filter(entry => entry.customType.startsWith("todo-fix-now"))).toHaveLength(0);
 expect(h.notices).toEqual([]);
});

test("resume removes obsolete generated choices while preserving worker findings and real owner questions", async () => {
 const h = await harness([row("Cooling trunks")]);
 const feedback = { role: "custom", customType: "async-result", content: "Worker found the capacity explanation misses the zero clamp. Existing model is correct." };
 const ownerQuestion = { role: "assistant", content: [{ type: "text", text: "Which authorized deployment target should receive this release?" }] };
 const external = { type: "text", text: "File documents FIX NOW: 1. Plan late 3m: cut/split/parallelize or ask owner" };
 const messages = [feedback, ownerQuestion,
  { role: "user", content: [{ type: "text", text: "Harness (not Darafei): FIX NOW: 1. ask old choices" }], runtimeSupervisor: true },
  { role: "toolResult", content: [external,
   { type: "text", text: "FIX NOW: 1. Plan late 703m: cut/split/parallelize or ask owner; 2. Break churn on «Cooling»" },
   { type: "text", text: "FIX NOW: old", harnessNotice: true }] },
  { role: "custom", customType: "todo-old", content: "Advice\n\nFIX NOW: old" },
 ];
 const shaped = await h.hooks.get("context")({ messages }, h.ctx);
 expect(shaped.messages).toEqual([feedback, ownerQuestion, { role: "toolResult", content: [external] }, { role: "custom", customType: "todo-old", content: "Advice" }]);
 expect((await h.hooks.get("context")({ messages: shaped.messages }, h.ctx)).messages).toEqual(shaped.messages);
});

test("subagent and clean chief receive no generated scope decision", async () => {
 const h = await harness([]);
 expect((await h.hooks.get("context")({ messages: [] }, h.ctx)).messages).toEqual([]);
 h.phases[0].tasks.push(row("Child work"));
 h.ctx.sessionManager.getHeader = () => ({ id: "child", parentSession: "lead" });
 expect((await h.hooks.get("context")({ messages: [] }, h.ctx)).messages).toEqual([]);
});
