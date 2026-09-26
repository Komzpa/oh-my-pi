/**
 * Reproduction for TODO HUD triple-duplication regression at 190 columns.
 *
 * Renders the same 13 concurrent worker mocks through the three surfaces that
 * can list live subagents:
 *   - TODO tree (#renderTodoList -> todoContainer)
 *   - anchored Subagents panel (#renderSubagentList -> subagentContainer)
 *   - wait-tool result tree (waitToolRenderer.renderResult with agents roster)
 *
 * The test surfaces counts and truncation markers so a red-before fix is
 * observable without editing any production render file.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { waitToolRenderer, type AgentActivitySnapshot } from "@oh-my-pi/pi-tui/tools/wait";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const COLUMNS = 190;
const WORKER_COUNT = 13;

function makeLifecycle(id: string, index: number, description: string): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached: true,
	};
}

function makeProgress(id: string, index: number, description: string): AgentProgress {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: description,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		description,
	};
}

function makeProgressPayload(id: string, index: number, description: string): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached: true,
		progress: makeProgress(id, index, description),
	};
}

function makeAgentSnapshot(id: string): AgentActivitySnapshot {
	return { id, ageMs: 1000, live: true, activity: "running" };
}

function countWorkerOccurrences(text: string, id: string): number {
	// Use a word-boundary-ish match that tolerates ANSI and tree glyphs.
	const re = new RegExp(`\\b${id.replace(/[-./\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "g");
	return (Bun.stripANSI(text).match(re) ?? []).length;
}

function findTruncationLines(text: string): string[] {
	return Bun.stripANSI(text)
		.split("\n")
		.filter(line => /…\s*\d+\s+more/.test(line));
}

describe("TODO HUD triple-duplication reproduction", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let modelRegistry: ModelRegistry;

	async function replaceMode(): Promise<void> {
		if (mode) {
			mode.stop();
			await session.dispose();
		}
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-hud-repro-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		await replaceMode();
	});

	afterEach(async () => {
		session.setTodoPhases([]);
		mode.setTodos([]);
		vi.restoreAllMocks();
		await replaceMode();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("renders 13 workers at 190 columns without triple duplication", async () => {
		await mode.init({ suppressWelcomeIntro: true });

		// One linked worker, the rest unassigned — same shape as the existing
		// "lists other workers once" test, but scaled to the reported size.
		mode.setTodos([
			{
				name: "Work",
				tasks: [{ content: "job 0", status: "in_progress", schedule: { owner: "Override0" } }],
			},
		]);

		for (let index = 0; index < WORKER_COUNT; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(`Override${index}`, index, `job ${index}`));
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload(`Override${index}`, index, `job ${index}`));
		}

		await Promise.resolve();
		mode.applyPinnedAgentsSetting();

		const todoStrip = Bun.stripANSI(mode.todoContainer.render(COLUMNS).join("\n"));
		const subagentStrip = Bun.stripANSI(mode.subagentContainer.render(COLUMNS).join("\n"));

		const waitComponent = waitToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "waiting" }],
				details: {
					op: "wait",
					agents: Array.from({ length: WORKER_COUNT }, (_, i) => makeAgentSnapshot(`Override${i}`)),
				},
			},
			{ expanded: true, isPartial: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
			theme,
		);
		const waitStrip = Bun.stripANSI(waitComponent.render(COLUMNS).join("\n"));

		// Surface raw rendered output for red-before inspection.
		console.log("=== TODO tree ===");
		console.log(todoStrip);
		console.log("=== Subagents panel ===");
		console.log(subagentStrip);
		console.log("=== Wait-tool tree ===");
		console.log(waitStrip);

		// A real plan is active, so the TODO tree alone accounts for every
		// worker (linked to its row, or under "unassigned workers"). The
		// anchored Subagents panel must not repeat that list — the reported
		// triple-duplication symptom was this panel showing the same workers
		// a second (and the wait-tool tree a third) time.
		expect(subagentStrip).not.toContain("Subagents");

		for (let index = 0; index < WORKER_COUNT; index++) {
			const id = `Override${index}`;
			expect(countWorkerOccurrences(todoStrip, id)).toBe(1);
			expect(countWorkerOccurrences(subagentStrip, id)).toBe(0);
			// The wait-tool tree is an independent, pre-existing surface (not
			// part of this regression): it may still list its own roster once.
			expect(countWorkerOccurrences(waitStrip, id)).toBe(1);
		}

		// Truncation at 190 columns would be unexpected for 13 short rows.
		expect(findTruncationLines(waitStrip)).toEqual([]);
	});

	it("keeps the Subagents panel with no todo plan when active subagents are present", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		// Explicitly do NOT call mode.setTodos().

		for (let index = 0; index < WORKER_COUNT; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(`NoPlan${index}`, index, `job ${index}`));
		}

		await Promise.resolve();
		mode.applyPinnedAgentsSetting();

		const subagentStrip = Bun.stripANSI(mode.subagentContainer.render(COLUMNS).join("\n"));
		console.log("=== Subagents panel (no todo plan) ===");
		console.log(subagentStrip);

		// With no plan, the TODO tree has nothing to claim these workers into,
		// so the Subagents panel is the only place that shows them (the pinned
		// HUD's own height-driven truncation, as already covered by the
		// existing "coalesces a burst of worker changes" test, still applies).
		expect(subagentStrip).toContain("Subagents");
		expect(subagentStrip).toContain("NoPlan0");
	});
});
