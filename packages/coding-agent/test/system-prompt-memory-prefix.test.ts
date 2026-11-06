import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import type { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

async function start(cwd: string, manager: SessionManager, memory: string, mentalModel: string) {
	const settings = Settings.isolated({
		"memory.backend": "hindsight",
		"hindsight.apiUrl": "http://memory.invalid",
		"hindsight.autoRecall": true,
		"hindsight.autoRetain": false,
		"compaction.enabled": false,
		"todo.enabled": false,
	});
	const mock = createMockModel({ responses: [{ content: ["Done"] }, { content: ["Done again"] }] });
	const requests: Context[] = [];
	let startupContext: string | undefined;
	const render = async () => {
		const result = await buildSystemPrompt({
			cwd,
			contextFiles: [],
			skills: [],
			rules: [],
			tools: new Map(),
			includeWorkspaceTree: true,
			workspaceTree: { rootPath: cwd, rendered: memory, truncated: false, totalLines: 0, agentsMdFiles: [] },
			resolvedAppendSystemPrompt: await hindsightBackend.buildDeveloperInstructions(cwd, cwd, settings, session),
		});
		startupContext = result.conversationContext;
		return result;
	};
	const agent = new Agent({
		initialState: { model: mock.model, tools: [], messages: manager.buildSessionContext().messages },
		getApiKey: () => "test",
		convertToLlm,
		streamFn: (model, context, options) => {
			requests.push(structuredClone(context));
			return mock.stream(model, context, options);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: { getApiKey: async () => "test", hasConfiguredAuth: () => true } as never,
		rebuildSystemPrompt: render,
		getStartupContext: () => startupContext,
	});
	sessions.push(session);
	const state = new HindsightSessionState({
		sessionId: manager.getSessionId(),
		session,
		client: { recall: async () => ({ results: [{ id: "memory", text: memory }] }) } as unknown as HindsightApi,
		bankId: "bank",
		config: loadHindsightConfig(settings),
		banksSet: new Set(),
	});
	state.mentalModelsSnippet = mentalModel;
	session.setHindsightSessionState(state);
	await session.refreshBaseSystemPrompt();
	return { session, requests };
}

it("keeps fresh-session system bytes identical while delivering different recall and mental models, then replays them on resume", async () => {
	using dir = TempDir.createSync("@prompt-memory-prefix-");
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	const first = await start(dir.path(), manager, "deploy host alpha", "<mental_models>tabs</mental_models>");
	const second = await start(
		dir.path(),
		SessionManager.inMemory(dir.path()),
		"deploy host beta",
		"<mental_models>spaces</mental_models>",
	);
	await first.session.prompt("Where is the deploy host?");
	await second.session.prompt("Where is the deploy host?");
	expect(first.requests[0].systemPrompt).toEqual(second.requests[0].systemPrompt);
	expect(JSON.stringify(first.requests[0].systemPrompt)).not.toContain("alpha");
	expect(JSON.stringify(first.requests[0].messages)).toContain("deploy host alpha");
	expect(JSON.stringify(first.requests[0].messages)).toContain("<mental_models>tabs</mental_models>");
	expect(JSON.stringify(second.requests[0].messages)).toContain("deploy host beta");
	await first.session.refreshBaseSystemPrompt();
	await first.session.prompt("Continue");
	expect(first.requests[1].systemPrompt).toEqual(first.requests[0].systemPrompt);
	expect(JSON.stringify(first.requests[1].messages).match(/<memories>/g)).toHaveLength(1);
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("missing session file");
	const resumed = await start(
		dir.path(),
		await SessionManager.open(file, dir.join("sessions")),
		"CHANGED recall",
		"CHANGED mental model",
	);
	await resumed.session.prompt("Continue after resume");
	expect(resumed.requests[0].systemPrompt).toEqual(first.requests[0].systemPrompt);
	expect(resumed.requests[0].messages.slice(0, first.requests[0].messages.length)).toEqual(first.requests[0].messages);
	expect(JSON.stringify(resumed.requests[0].messages)).not.toContain("CHANGED");
});
