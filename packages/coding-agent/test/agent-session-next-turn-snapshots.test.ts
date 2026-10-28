import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { TempDir } from "@oh-my-pi/pi-utils";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";

// Live 2026-10-28: an autonomous lead's next-turn queue held 9 copies of the 218 KB chief runbook and
// 25 requirement notices, persisted on every restart and delivered together on the next prompt.
describe("next-turn snapshots", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-next-turn-snapshots-");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	it("keeps only the newest queued snapshot of one customType and every ordinary message", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 300 };
				},
				{ content: ["ok"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const send = (content: string, snapshot: boolean) =>
			session!.sendCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: false,
					attribution: "user",
					...(snapshot ? { details: { supersedesQueued: true } } : {}),
				},
				{ deliverAs: "nextTurn", triggerTurn: false },
			);
		// Queue while a turn streams: an idle session appends next-turn messages directly.
		const running = session.prompt("work");
		await started.promise;
		await send("RUNBOOK_V1", true);
		await send("FLOW_A", false);
		await send("RUNBOOK_V2", true);
		await send("FLOW_B", false);
		await send("RUNBOOK_V3", true);
		expect(session.queuedMessageCount).toBe(3);

		await running;
		await session.waitForIdle();
		expect(session.queuedMessageCount).toBe(3);
		await session.prompt("go");
		await session.waitForIdle();

		const sent = JSON.stringify(mock.calls.map(call => call.context.messages));
		expect(sent).toContain("RUNBOOK_V3");
		expect(sent).not.toContain("RUNBOOK_V1");
		expect(sent).not.toContain("RUNBOOK_V2");
		expect(sent).toContain("FLOW_A");
		expect(sent).toContain("FLOW_B");
	});
});
