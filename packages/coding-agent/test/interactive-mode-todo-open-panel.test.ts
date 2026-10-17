import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	mainBaselineOpenIdentities,
	mainTwoRowBaselinePhases,
	openPanelPhases,
	openTaskIdentities,
} from "./fixtures/todo-open-panel";

function setTerminalRows(mode: InteractiveMode, rows: number): void {
	Object.defineProperty(mode.ui.terminal, "rows", { get: () => rows, configurable: true });
}

function renderPanel(mode: InteractiveMode): string[] {
	return mode.todoContainer
		.render(120)
		.flatMap(line => line.split("\n"))
		.map(line => Bun.stripANSI(line));
}

function overflowCount(lines: readonly string[]): number {
	return Number(lines.join("\n").match(/\+(\d+) more open/)?.[1] ?? 0);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visibleTasks(lines: readonly string[], identities: readonly string[]): string[] {
	const found: Array<{ identity: string; row: number }> = [];
	for (const identity of identities) {
		// Exact identity: a substring match would let "Task 1" also match "Task 10"
		// if the fixture ever grows past 9 rows.
		const pattern = new RegExp(`${escapeRegExp(identity)}(?![0-9])`);
		const row = lines.findIndex(line => pattern.test(line));
		if (row >= 0) found.push({ identity, row });
	}
	found.sort((left, right) => left.row - right.row);
	return found.map(entry => entry.identity);
}
function allTaskIdentities(phases: readonly TodoPhase[]): string[] {
	return phases.flatMap(phase => phase.tasks.map(task => task.content));
}

function closedTaskIdentities(phases: readonly TodoPhase[]): string[] {
	return phases.flatMap(phase =>
		phase.tasks.filter(task => task.status === "completed" || task.status === "abandoned").map(task => task.content),
	);
}

function expectScreenshotShape(phases: readonly TodoPhase[]): void {
	const tasks = phases.flatMap(phase => phase.tasks);
	expect(phases).toHaveLength(3);
	expect(tasks.filter(task => task.status !== "completed" && task.status !== "abandoned")).toHaveLength(11);
	expect(tasks.filter(task => task.status === "completed")).toHaveLength(17);
	expect(tasks.filter(task => task.status === "abandoned")).toHaveLength(1);
}

describe("InteractiveMode collapsed TODO open panel", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	let terminal: VirtualTerminal;

	beforeAll(initTheme);

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-open-panel-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		terminal = new VirtualTerminal(120, 27);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			new EventBus(),
			new Composer({ terminal }),
		);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("shows all 11 open rows from the main-based two-row baseline fixture in a 15-row panel", () => {
		expectScreenshotShape(mainTwoRowBaselinePhases);
		// Main's old selector shows one completed context row plus the last phase's blocked row.
		// This fixture intentionally reproduces that main-based shape without inventing #92's header.
		setTerminalRows(mode, 27);
		mode.setTodos(mainTwoRowBaselinePhases);

		const lines = renderPanel(mode);
		expect(lines).toHaveLength(15);
		// The header carries the computed counts (17 completed, 11 open, 1 abandoned),
		// not just the fixture shape checked above.
		const header = lines.find(line => line.includes("TODO"));
		expect(header).toContain("17 ✓");
		expect(header).toContain("11 open");
		expect(header).toContain("1 ×");
		expect(visibleTasks(lines, mainBaselineOpenIdentities)).toEqual([...mainBaselineOpenIdentities]);
		for (const closed of closedTaskIdentities(mainTwoRowBaselinePhases)) {
			expect(lines.some(line => line.includes(closed))).toBe(false);
		}
		expect(lines.some(line => line.includes("Retro catches deploy failures") && line.includes("5/6"))).toBe(true);
		expect(lines.some(line => /more open/i.test(line))).toBe(false);
	});

	it("groups all open rows by in-progress, blocked, then pending priority", () => {
		expectScreenshotShape(openPanelPhases);
		setTerminalRows(mode, 27);
		mode.setTodos(openPanelPhases);

		const lines = renderPanel(mode);
		expect(lines).toHaveLength(15);
		const header = lines.find(line => line.includes("TODO"));
		expect(header).toContain("17 ✓");
		expect(header).toContain("11 open");
		expect(header).toContain("1 ×");
		expect(visibleTasks(lines, openTaskIdentities)).toEqual([...openTaskIdentities]);
		for (const closed of closedTaskIdentities(openPanelPhases)) {
			expect(lines.some(line => line.includes(closed))).toBe(false);
		}
		const phasePositions = ["III. Execution", "II. Needs unblock", "I. Queued work"].map(name =>
			lines.findIndex(line => line.includes(name)),
		);
		expect(phasePositions.every(index => index >= 0)).toBe(true);
		expect(phasePositions).toEqual([...phasePositions].sort((a, b) => a - b));
	});

	it("uses the six-row panel for the maximum priority prefix and exact expand overflow", () => {
		setTerminalRows(mode, 18);
		mode.setTodos(openPanelPhases);

		const lines = renderPanel(mode);
		expect(lines).toHaveLength(6);
		expect(lines.every(line => line.trim().length > 0)).toBe(true);
		expect(visibleTasks(lines, openTaskIdentities)).toEqual(openTaskIdentities.slice(0, 3));
		const overflow = lines.find(line => /\+\d+ more open/i.test(line));
		expect(overflow).toBeDefined();
		expect(overflow?.trimEnd()).toMatch(/(?:^|\s)\+8 more open \(.+ …\)$/);
		expect(openTaskIdentities.length - visibleTasks(lines, openTaskIdentities).length).toBe(8);
	});

	it("drops only the legacy closed context row for a current-only plan with closed tasks", () => {
		setTerminalRows(mode, 27);
		const currentOnly: TodoPhase[] = [
			{
				name: "Current phase",
				tasks: [
					{ content: "Current completed 1", status: "completed" },
					{ content: "Current completed 2", status: "completed" },
					{ content: "Current completed 3", status: "completed" },
					{ content: "Current completed 4", status: "completed" },
					{ content: "Current completed 5", status: "completed" },
					{ content: "Current blocked task", status: "blocked" },
				],
			},
		];
		mode.setTodos(currentOnly);

		const lines = renderPanel(mode);
		// Semantic counts only: the header renders "TODO 5 ✓ · 1 open", so assert
		// the counts rather than echoing its separators.
		const header = lines.find(line => line.includes("TODO"));
		expect(header).toContain("5 ✓");
		expect(header).toContain("1 open");
		expect(lines.some(line => line.includes("Current phase") && line.includes("5/6"))).toBe(true);
		expect(visibleTasks(lines, ["Current blocked task"])).toEqual(["Current blocked task"]);
		for (const closed of closedTaskIdentities(currentOnly)) {
			expect(lines.some(line => line.includes(closed))).toBe(false);
		}
	});

	it("keeps a current-only open plan fully visible under its legacy header", () => {
		setTerminalRows(mode, 27);
		// True unchanged control: one phase, only open tasks already in priority
		// order (in-progress, blocked, pending), no closed rows for the collapsed
		// viewport to hide. Byte-exact equality against base is verified by the
		// gate's base probe; here the semantic shape is pinned exactly.
		const currentOnlyOpen: TodoPhase[] = [
			{
				name: "Current phase",
				tasks: [
					{ content: "Current doing 1", status: "in_progress" },
					{ content: "Current doing 2", status: "in_progress" },
					{ content: "Current stuck", status: "blocked" },
					{ content: "Current queued 1", status: "pending" },
					{ content: "Current queued 2", status: "pending" },
				],
			},
		];
		const currentOpenIdentities = currentOnlyOpen.flatMap(phase => phase.tasks.map(task => task.content));
		mode.setTodos(currentOnlyOpen);

		const lines = renderPanel(mode);
		// Legacy contract for one phase with no closed rows: the header is bare
		// TODO with no counts.
		const header = lines.find(line => line.includes("TODO"));
		expect(header?.trim()).toBe("TODO");
		expect(lines.filter(line => line.includes("Current phase"))).toHaveLength(1);
		expect(lines.some(line => line.includes("Current phase") && line.includes("0/5"))).toBe(true);
		expect(lines.some(line => line.includes("I. Current phase"))).toBe(false);
		expect(visibleTasks(lines, currentOpenIdentities)).toEqual(currentOpenIdentities);
		expect(lines.some(line => /more open/i.test(line))).toBe(false);
	});

	it("leaves the expanded task state and ordering unchanged through collapse and re-expand", async () => {
		setTerminalRows(mode, 50);
		mode.setTodos(openPanelPhases);
		await mode.handleTodoCommand("expand");
		const expandedBefore = renderPanel(mode);
		expect(visibleTasks(expandedBefore, allTaskIdentities(openPanelPhases))).toEqual(
			allTaskIdentities(openPanelPhases),
		);
		// Expanded physical shape oracle: leading blank, bare TODO header with no
		// collapsed counts, and a closing tail row that carries no task content.
		expect(expandedBefore[0]?.trim()).toBe("");
		expect(expandedBefore[1]).toContain("TODO");
		expect(expandedBefore[1]).not.toContain("open");
		const tail = expandedBefore[expandedBefore.length - 1] ?? "";
		expect(visibleTasks([tail], allTaskIdentities(openPanelPhases))).toHaveLength(0);
		expect(/more open/i.test(tail)).toBe(false);

		setTerminalRows(mode, 18);
		await mode.handleTodoCommand("collapse");
		const collapsed = renderPanel(mode);
		expect(collapsed.some(line => line.includes("more open"))).toBe(true);

		setTerminalRows(mode, 50);
		await mode.handleTodoCommand("expand");
		expect(renderPanel(mode)).toEqual(expandedBefore);
	});
	it("honors an optional Composer allocation and refreshes without hydrating historical payloads", () => {
		Object.assign(mode, { getTodoHudPanelRows: () => 6 });
		const getBranch = session.sessionManager.getBranch.bind(session.sessionManager);
		Object.assign(session.sessionManager, {
			getBranch: () => {
				throw new Error("historical payload hydration");
			},
			getBranchMatching: () => [],
		});
		mode.setTodos(openPanelPhases);
		expect(renderPanel(mode)).toHaveLength(6);
		expect(visibleTasks(renderPanel(mode), openTaskIdentities)).toEqual(openTaskIdentities.slice(0, 3));
		expect(overflowCount(renderPanel(mode))).toBe(8);
		Object.assign(mode, { getTodoHudPanelRows: () => 15 });
		mode.refreshTodoHud(120);
		expect(visibleTasks(renderPanel(mode), openTaskIdentities)).toEqual([...openTaskIdentities]);
		expect(overflowCount(renderPanel(mode))).toBe(0);
		Object.assign(session.sessionManager, { getBranch });
	});
});
