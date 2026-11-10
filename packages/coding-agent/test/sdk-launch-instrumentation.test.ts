import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { currentLoopPhase } from "@oh-my-pi/pi-utils/loop-phase";
import { runLaunchTrace } from "@oh-my-pi/pi-utils/launch-trace";

afterEach(() => vi.restoreAllMocks());

test("real SDK child reports computed UTF-8 sizes and startup steps after startup timing ends", async () => {
	using dir = TempDir.createSync("omp-launch-instrumentation-");
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
	const logs = spyOn(logger, "debug").mockImplementation(() => {});
	logger.endTiming();
	// A slow synchronous kickoff used to disappear between construction and memory startup.
	const restore = AgentSession.prototype.beginInitialAdvisorCostRestore;
	spyOn(AgentSession.prototype, "beginInitialAdvisorCostRestore").mockImplementation(function (this: AgentSession) {
		const deadline = performance.now() + 40;
		while (performance.now() < deadline) {
			/* controlled parent-thread work */
		}
		return restore.call(this);
	});
	try {
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.join("agent"),
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(dir.path()),
			model: getBundledModel("openai", "gpt-4o-mini"),
			parentTaskPrefix: "instrumented-child",
			taskDepth: 1,
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			contextFiles: [{ path: dir.join("context.txt"), content: "Ж猫" }],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
			systemPrompt: ["Ж", "猫"],
		});
		try {
			const calls = logs.mock.calls.filter(call => call[0] === "subagent launch spans");
			expect(calls).toHaveLength(1);
			const summary = calls[0]![1]!;
			expect(summary.failed).toBe(false);
			expect(summary.metrics).toMatchObject({
				"systemPrompt.bytes": 5,
				"context.parent.bytes": 5,
				"context.parent.entries": 1,
			});
			expect(summary.spans).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "buildSystemPrompt" }),
					expect.objectContaining({ name: "createAllTools" }),
					expect.objectContaining({ name: "context.history.build" }),
				]),
			);
			const spans = summary.spans as Array<{ name: string; syncPrefixMs: number }>;
			const kickoff = spans.find(span => span.name === "sdk.advisorCostRestore.kickoff");
			expect(kickoff?.syncPrefixMs).toBeGreaterThanOrEqual(40);
			expect(currentLoopPhase()).toBeUndefined();
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
	}
});

test("sprint persistence after an await names serialization without changing journal payload", async () => {
	const logs = spyOn(logger, "debug").mockImplementation(() => {});
	using dir = TempDir.createSync("omp-launch-state-");
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	await manager.ensureOnDisk();
	let observed: string | undefined;
	await runLaunchTrace({ id: "serialization" }, async () => {
		await Bun.sleep(1);
		manager.appendCustomEntry("todo-dispatch-sprint-state", {
			toJSON() {
				observed = currentLoopPhase();
				return { version: 1 };
			},
		});
	});
	const spans = logs.mock.calls.find(call => call[0] === "subagent launch spans")?.[1]?.spans;
	expect(spans).toEqual(expect.arrayContaining([expect.objectContaining({ name: "journal.write" })]));
	expect(observed).toBe("state.serialize:todo-dispatch-sprint-state");
	await manager.close();
	const persisted = (await Bun.file(manager.getSessionFile()!).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	expect(persisted.at(-1)).toMatchObject({ customType: "todo-dispatch-sprint-state", data: { version: 1 } });
	expect(currentLoopPhase()).toBeUndefined();
});
