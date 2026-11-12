import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createAgentSession } from "../../src/sdk";
import { Settings } from "../../src/config/settings";
import { AuthStorage } from "../../src/session/auth-storage";
import { ModelRegistry } from "../../src/config/model-registry";
import { SessionManager } from "../../src/session/session-manager";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import * as workerClient from "../../src/subprocess/worker-client";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const root = process.env.RESTART_FIXTURE_ROOT!;
const successor = !!process.env.OMP_RESTART_SESSION_ID;
const file = path.join(root, "session-file");
if (!successor) {
	const seed = SessionManager.create(root, path.join(root, "seed"));
	seed.appendMessage({ role: "user", content: "Continue fixture plan", timestamp: 1 });
	await seed.ensureOnDisk();
	await seed.close();
	await fs.cp(path.join(root, "seed"), path.join(root, "copy"), { recursive: true });
	await Bun.write(file, path.join(root, "copy", path.basename(seed.getSessionFile()!)));
}
const manager = await SessionManager.open((await Bun.file(file).text()).trim());
const auth = await AuthStorage.create(":memory:");
auth.keys.setRuntime("anthropic", "fixture-key");
const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
const model = registry.find("anthropic", "claude-sonnet-4-5")!;
const settings = Settings.isolated({
	"compaction.enabled": false,
	"todo.enabled": false,
	"advisor.enabled": false,
	"autolearn.enabled": false,
	"retry.enabled": false,
});
await Settings.init({ inMemory: true, cwd: root });
const { session } = await createAgentSession({
	cwd: root,
	agentDir: path.join(root, "agent"),
	sessionManager: manager,
	authStorage: auth,
	modelRegistry: registry,
	model,
	settings,
	disableExtensionDiscovery: true,
	preloadedExtensionPaths: [],
	preloadedCustomToolPaths: [],
	skills: [],
	contextFiles: [],
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
	skipPythonPreflight: true,
	cacheWarming: false,
	toolNames: [],
	restrictToolNames: true,
});
const started = Promise.withResolvers<void>();
const mock = createMockModel({
	handler: async context => {
		await fs.appendFile(
			path.join(root, "provider.jsonl"),
			JSON.stringify({ successor, messages: context.messages }) + "\n",
		);
		if (!successor && process.env.RESTART_FIXTURE_PENDING === "1") {
			started.resolve();
			while (!session.isRestartDraining) await Bun.sleep(2);
		}
		return { content: ["fixture plan resumed"] };
	},
});
session.agent.streamFn = mock.stream;
initTheme();
spyOn(workerClient, "resolveCliEntryCmd").mockReturnValue([process.execPath, import.meta.path]);
if (!successor && process.env.RESTART_FIXTURE_PENDING === "1") {
	const begin = session.beginRestartDrain.bind(session);
	spyOn(session, "beginRestartDrain").mockImplementation(options => {
		const lease = begin(options);
		session.queueDeferredMessage({
			role: "custom",
			customType: "fixture-input",
			content: "Pending fixture context",
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		return lease;
	});
}
const mode = new InteractiveMode(session, "fixture");
await mode.init();
if (!successor && process.env.RESTART_FIXTURE_PENDING === "1") {
	void session.prompt("Active text-only plan");
	await started.promise;
	session.agent.steer({ role: "user", content: "Steering text-only iteration", timestamp: Date.now() });
}
await Bun.write(
	path.join(root, successor ? "successor-ready" : "ready"),
	JSON.stringify({ pid: process.pid, sessionId: session.sessionId }),
);
await Bun.sleep(60_000);
