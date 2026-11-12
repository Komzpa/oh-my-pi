import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../packages/coding-agent/src/config/model-registry";
import { Settings } from "../packages/coding-agent/src/config/settings";
import { AgentSession } from "../packages/coding-agent/src/session/agent-session";
import { AuthStorage } from "../packages/coding-agent/src/session/auth-storage";
import { SessionManager } from "../packages/coding-agent/src/session/session-manager";
const root = "/home/kom/proj/ai_pr/omp-compactloop-20261107/offline";
const started = performance.now();
const manager = await SessionManager.open(`${root}/session.jsonl`, undefined, undefined, { suppressBreadcrumb: true });
if (manager.getCwd() !== `${root}/cwd`) throw new Error("Unsafe recorded cwd");
process.chdir(manager.getCwd());
console.log(JSON.stringify({ phase: "loaded", ms: performance.now() - started }));
const auth = await AuthStorage.create(":memory:");
auth.keys.setRuntime("mock", "offline-stub");
const mock = createMockModel({ contextWindow: 1024, maxTokens: 128, handler: () => ({ content: ["offline stub turn"] }) });
const agent = new Agent({ initialState: { model: mock, systemPrompt: ["resident ".repeat(8000)], tools: [], messages: manager.buildSessionContext().messages }, streamFn: mock.stream, getApiKey: () => "offline-stub" });
const session = new AgentSession({ agent, sessionManager: manager, modelRegistry: new ModelRegistry(auth), settings: Settings.isolated({ "compaction.methodOrder": ["soft"], "compaction.asyncEnabled": false, "compaction.autoContinue": false, "todo.enabled": false }) });
let compactions = 0;
const notices: string[] = [];
session.subscribe(event => { if (event.type === "auto_compaction_start") compactions++; if (event.type === "notice" && event.message.startsWith("Harness (not Darafei):")) notices.push(event.message); });
for (let turn = 0; turn < 3; turn++) {
 const start = performance.now();
 await session.prompt(`offline probe ${turn}`);
 await session.waitForIdle();
 console.log(JSON.stringify({ turn, ms: performance.now() - start, compactions, notices: notices.length, calls: mock.calls.length }));
}
if (compactions !== 0 || notices.length !== 1 || mock.calls.length !== 3) throw new Error("Breaker contract failed");
console.log(JSON.stringify({ result: "PASS", notice: notices[0] }));
// Avoid unrelated cold-history shutdown scans in this focused compaction probe.
process.exit(0);
