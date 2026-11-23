import { logger, getBaseConfigRoot } from "@oh-my-pi/pi-utils";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as path from "node:path";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
logger.setTransports({ file: path.resolve("../evidence/probe-runtime.log") });
const lane = path.resolve("../evidence");
if (!getBaseConfigRoot().startsWith(lane + path.sep))
	throw new Error("Set PI_CONFIG_DIR to a lane-owned config root before running this probe");
const mode = Bun.argv[2] ?? "resume";
const packageDir = path.resolve("evidence/criticlive/runtime/node_modules/@oh-my-pi/reemxy-extensions");
const manager = await SessionManager.open(path.join(lane, "dc.jsonl"));
console.log("opened", manager.getHeader()?.id);
const auth = await AuthStorage.create(":memory:");
const { session, extensionsResult } = await createAgentSession({
	model: getBundledModel("openai", "gpt-4.1")!,
	cwd: lane,
	agentDir: path.join(lane, "agent"),
	sessionManager: manager,
	modelRegistry: new ModelRegistry(auth),
	settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
	disableExtensionDiscovery: true,
	additionalExtensionPaths:
		mode === "package"
			? [packageDir]
			: ["goal_deadlines.ts", "todo_dispatch.ts", "agent_router.ts"].map(file =>
					path.join(packageDir, "extensions", file),
				),
	skills: [],
	contextFiles: [],
	promptTemplates: [],
	slashCommands: [],
	toolNames: [],
	enableMCP: false,
	enableLsp: false,
});
session.agent.streamFn = () => {
	throw new Error("Fixture must not call a provider");
};
console.log(
	"identity",
	manager.getHeader(),
	session
		.getTodoPhases()
		.flatMap(p => p.tasks)
		.filter(t => t.status !== "completed" && t.status !== "abandoned").length,
);
console.log(
	"loaded",
	extensionsResult?.extensions.map(e => e.path),
	"errors",
	extensionsResult?.errors,
);
let calls = 0;
session.extensionRunner!.invokeNativeTool = async (name, params) => {
	calls++;
	console.log("reviewer", name, JSON.stringify(params).slice(0, 250));
	return {
		content: [],
		details: {
			results: [
				{
					output: JSON.stringify({
						converging: true,
						criticalPathBlocker: null,
						falseDependencies: [],
						split: [],
						cut: [],
						escalate: [],
						actions: [],
					}),
				},
			],
		},
	} as never;
};
const started = performance.now();
await initializeExtensions(session, {
	reportSendError: (_a, e) => console.log("send-error", String(e)),
	reportRuntimeError: e => console.log("runtime-error", e),
});
if (mode === "restore") {
	// Complete only the copied lead turn: no provider or child restoration.
	manager.appendCustomEntry("session_exit", {
		reason: "fixture-checkpoint",
		kind: "normal",
		recordedAt: new Date().toISOString(),
	});
	session.agent.streamFn = () => {
		throw new Error("Fixture must not call a provider");
	};
	console.log("restore", await restoreSession(session));
}
for (let i = 0; i < 600 && calls === 0; i++) await Bun.sleep(100);
console.log("elapsedMs", performance.now() - started);
console.log("calls", calls);
if (calls !== 1) process.exitCode = 1;
await session.dispose();
await manager.close();
auth.close();
