import { strict as assert } from "node:assert";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { chiefFixNow } from "../packages/reemxy-extensions/extensions/fix_now";
import { createCodexModel } from "../packages/ai/test/helpers";

// Offline request serialization only. No credentials, network or live session.
const model = createCodexModel("gpt-6.1-sol", { provider: "codex-lb", baseUrl: "http://offline.invalid" });
const liveShape = { main: true, defects: [
  { row: "Cooling", action: "Staff", severity: 1, detail: "overdue 6m" },
  { row: "Push branch", action: "Push", severity: 2 },
  { row: "Power", action: "Repair refused staffing for", severity: 2 },
  { row: "Frame", action: "Staff", severity: 3 },
] };
const messages: AgentMessage[] = [
  { role: "assistant", content: [{ type: "toolCall", id: "call_probe", name: "todo", arguments: {} }],
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 },
  { role: "toolResult", toolCallId: "call_probe", toolName: "todo",
    content: [{ type: "text", text: chiefFixNow(liveShape) }], isError: false, timestamp: 1 },
  { role: "custom", customType: "todo-plan-check", content: "Agent gate", attribution: "agent", display: false, timestamp: 2 },
  { role: "hookMessage", customType: "gate", content: "Hook gate", attribution: "agent", display: false, timestamp: 3 },
  { role: "custom", customType: "collab-prompt", content: "Owner steering", attribution: "user", display: true, timestamp: 4 },
];
const before = await buildTransformedCodexRequestBody(model, { messages: convertToLlm(messages) }, undefined, "offline");
assert(before.input?.some(item => item.type === "function_call_output"));
assert.equal(before.input?.filter(item => item.role === "developer").length, 2);
assert.equal(before.input?.filter(item => item.role === "user").length, 1);
const supervisor: AgentMessage = { role: "user", attribution: "agent", timestamp: 5,
  content: chiefFixNow(liveShape, true) };
const after = await buildTransformedCodexRequestBody(model, { messages: convertToLlm([...messages, supervisor]) }, undefined, "offline");
assert.equal(after.input?.at(-1)?.role, "user");
assert(!/authoriz|approv|permission/i.test(JSON.stringify(after.input?.at(-1))));

// Deliberately scripted consumer: proves channel visibility, not Sol compliance.
function scriptedConsumer(input: typeof before.input): string {
  return input?.some(item => item.role === "user" && JSON.stringify(item).includes("Runtime supervisor (not Darafei): FIX NOW:"))
    ? "staff Cooling" : "continue reading";
}
assert.equal(scriptedConsumer(before.input), "continue reading");
assert.equal(scriptedConsumer(after.input), "staff Cooling");
await Bun.write(new URL("./fixlist-wire.json", import.meta.url), JSON.stringify({
  model: model.id, provider: model.provider, before, after,
  scriptedAB: { A: scriptedConsumer(before.input), B: scriptedConsumer(after.input),
    limitation: "scripted channel detector, not model adherence or live latency" },
}, null, 2) + "\n");
console.log("PASS: tool output; custom/hook developer; collab user; supervisor user; scripted A/B");
