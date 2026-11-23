import { expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

test("dispatcher silence covers streamed text and persisted history; a real user and worker update remain visible", async () => {
	const root = TempDir.createSync("omp-wake-visibility-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test");
	const registry = new ModelRegistry(auth);
	const model = createMockModel({
		responses: Array.from({ length: 3 }, () => ({
			content: [{ type: "text" as const, text: "Nothing has changed on PR 114." }],
		})),
	});
	const { session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry: registry,
		model,
		sessionManager: SessionManager.inMemory(root.path()),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: [],
	});
	const text: string[] = [];
	session.agent.streamFn = model.stream;
	session.subscribe(event => {
		if ((event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant")
			text.push(...event.message.content.filter(block => block.type === "text").map(block => block.text));
	});
	try {
		await session.sendCustomMessage(
			{
				customType: "todo-plan-check",
				content: "Internal wake",
				display: false,
				details: { silentAssistant: true },
			},
			{ triggerTurn: true },
		);
		await session.agent.waitForIdle();
		expect(text.join("")).toBe("");
		expect(model.calls).toHaveLength(1);
		const assistant = session.agent.state.messages.find(message => message.role === "assistant");
		expect(assistant?.content.filter(block => block.type === "text" && block.text.trim()) ?? []).toEqual([]);
		await session.prompt("What changed?");
		expect(text.join("")).toContain("PR 114");
		text.length = 0;
		await session.sendCustomMessage(
			{ customType: "async-result", content: "Worker finished", display: false },
			{ triggerTurn: true },
		);
		await session.agent.waitForIdle();
		expect(text.join("")).toContain("PR 114");
	} finally {
		await session.dispose();
		auth.close();
		root.removeSync();
	}
}, 30000);
