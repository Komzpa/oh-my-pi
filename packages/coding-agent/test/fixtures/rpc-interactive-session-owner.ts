import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";

const directory = process.env.RPC_OWNER_TEST_DIR!;
const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
let calls = 0;
const mock = createMockModel({
	handler: async (_context, options) => {
		await Bun.write(path.join(directory, "started.json"), JSON.stringify({ pid: process.pid, calls: ++calls }));
		while (!(await Bun.file(path.join(directory, "release")).exists())) {
			options?.signal?.throwIfAborted();
			await Bun.sleep(5);
		}
		options?.signal?.throwIfAborted();
		await Bun.write(path.join(directory, "effect.json"), JSON.stringify({ calls, pid: process.pid }));
		return { content: ["completed once"] };
	},
});
const auth = await AuthStorage.create(":memory:");
auth.keys.setRuntime("anthropic", "fixture-key");
const manager = SessionManager.create(directory, directory);
manager.appendMessage({ role: "user", content: "existing history", timestamp: 1 });
await manager.ensureOnDisk();
await manager.saveDraft("unsent черновик 🐈");
await Bun.write(path.join(directory, "session-file"), manager.getSessionFile()!);
const session = new AgentSession({
	agent: new Agent({
		getApiKey: () => "fixture-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	}),
	sessionManager: manager,
	settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
	modelRegistry: new ModelRegistry(auth),
});
await runRpcMode(session);
