import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgComposerTokenRate } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TspKind } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";

const context = (supports: (kind: TspKind) => boolean): DescribeContext => ({
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports,
	feature: () => true,
});

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if (isNode(child)) out.push(...nodes(child));
	return out;
}

describe("Native todo HUD viewport regression", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-activity-line-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(() => {
		mode.loadingAnimation?.stop();
		mode.loadingAnimation = undefined;
		mode.statusContainer.disposeChildren();
		session.setTodoPhases([]);
		mode.setTodos(session.getTodoPhases());
		session.tokenRate.reset();
		cfgComposerTokenRate.clearOverride(settings);
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps the full checklist and bounded fallback stage window, and clears both when the plan is removed", async () => {
		const plan: TodoPhase[] = Array.from({ length: 8 }, (_, index) => ({
			name: `Stage ${index}`,
			tasks: [{ content: `Work ${index}`, status: index === 0 ? "completed" : "pending" }],
		}));
		plan[1]!.tasks.push({ content: "Blocked work", status: "blocked", blocker: "Waiting for approval" });
		session.commitTodoPhases(plan);
		await mode.reloadTodos();
		const todo = (supportsChecklist: boolean) =>
			(mode.statusContainer.describe(context(kind => supportsChecklist || kind !== "checklist"))?.c ?? [])
				.filter(isNode)
				.find(child => child.key === "todo");
		const collapsed = todo(true);
		expect(collapsed).toMatchObject({
			k: "checklist",
			key: "todo",
			p: {
				role: "omp.hud.todo",
				phases: [
					{ items: [{ status: "done" }] },
					{ items: [{ status: "pending" }, { status: "blocked", note: "Waiting for approval" }] },
					...plan.slice(2).map(() => ({ items: [{ status: "pending" }] })),
				],
			},
		});
		const fallback = todo(false)!;
		expect(fallback).toMatchObject({ k: "col", key: "todo", p: { role: "omp.hud.todo" } });
		const tree = nodes(fallback).find(n => n.k === "tree");
		expect(tree).toMatchObject({
			p: {
				nodes: [
					{ id: "1", open: true, children: [{ id: "1.0" }, { id: "1.1" }] },
					...plan.slice(2, 6).map((_, index) => ({ id: `${index + 2}`, open: false, children: undefined })),
					{ id: "more" },
					{ id: "more-todos" },
				],
			},
		});
		mode.setTodoExpanded(true);
		expect(todo(true)).toEqual(collapsed);
		expect(nodes(todo(false)!).find(n => n.k === "tree")).toMatchObject({
			p: {
				nodes: plan.map((phase, index) => ({
					id: `${index}`,
					children: phase.tasks.map((_, task) => ({ id: `${index}.${task}` })),
				})),
			},
		});
		mode.setTodoExpanded(false);
		session.sessionManager.appendCustomEntry("requirements_ledger", { requirements: [] });
		await mode.reloadTodos();
		expect(todo(true)).toEqual(collapsed);
		expect(todo(false)).toEqual(fallback);
		session.commitTodoPhases([]);
		await mode.reloadTodos();
		expect(todo(true)).toBeUndefined();
		expect(todo(false)).toBeUndefined();
	});
});
