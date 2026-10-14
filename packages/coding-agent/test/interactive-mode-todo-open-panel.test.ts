import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { Spacer } from "@oh-my-pi/pi-tui/components/spacer";
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

const longDraft = Array.from(
	{ length: 40 },
	(_, i) => `draft line ${i + 1} with enough words to occupy the editor buffer`,
).join("\n");

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

	async function initializeViewport(rows: number): Promise<void> {
		terminal.resize(120, rows);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await terminal.waitForRender(() => terminal.getViewport().some(line => line.trim().length > 0));
	}

	function viewport(): string[] {
		return terminal.getViewport().map(line => Bun.stripANSI(line).trimEnd());
	}

	function expectAccountedOpenRows(identities: readonly string[]): void {
		const frame = viewport();
		const visible = visibleTasks(frame, identities);
		expect(visible.length + overflowCount(frame)).toBe(identities.length);
		expect(visible).toEqual(identities.slice(0, visible.length));
		const panel = mode.todoContainer.render(terminal.columns).map(line => Bun.stripANSI(line));
		expect(visibleTasks(panel, identities)).toEqual(visible);
		expect(overflowCount(panel)).toBe(overflowCount(frame));
		for (const closed of closedTaskIdentities(openPanelPhases)) {
			expect(frame.some(line => line.includes(closed))).toBe(false);
		}
	}
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

	it("accounts for all 11 open rows in the actual 27-row viewport with a live 40-line draft", async () => {
		await initializeViewport(27);
		mode.setTodos(openPanelPhases);
		await terminal.waitForRender(() => visibleTasks(viewport(), openTaskIdentities).length === 11);
		mode.editor.setDraft(longDraft);
		mode.ui.requestRender();
		await terminal.waitForRender(() => viewport().some(line => line.includes("draft line 40")));
		expectAccountedOpenRows(openTaskIdentities);
		expect(visibleTasks(viewport(), openTaskIdentities)).toEqual([...openTaskIdentities]);
		expect(mode.editor.getExpandedText()).toBe(longDraft);
		expect(viewport()[terminal.getCursor().row]).toContain("draft line 40");
	});

	it.each([
		{ spacerRows: 12, panelRows: 2 },
		{ spacerRows: 13, panelRows: 1 },
	])(
		"accounts for all 11 open tasks with only $panelRows HUD rows after sibling chrome",
		async ({ spacerRows, panelRows }) => {
			await initializeViewport(18);
			mode.setTodos(openPanelPhases);
			mode.editor.setDraft(longDraft);
			// The actual band editor floor is three rows, plus one sibling gap:
			// 18 - (spacerRows + 1) - 3 leaves exactly two or one HUD rows.
			mode.hookWidgetContainerBelow.addChild(new Spacer(spacerRows));
			mode.ui.requestRender();
			await terminal.waitForRender(() => viewport().some(line => line.includes("+11 more open")));
			expect(viewport().some(line => line.includes("+11 more open"))).toBe(true);
			expectAccountedOpenRows(openTaskIdentities);
			expect(visibleTasks(viewport(), openTaskIdentities)).toHaveLength(0);
			expect(overflowCount(viewport())).toBe(11);
			expect(viewport().find(line => line.includes("+11 more open"))).toContain("/todo expand");
			expect(mode.todoContainer.render(120)).toHaveLength(panelRows);
			expect(mode.editorContainer.render(120)).toHaveLength(3);
			expect(mode.editor.getExpandedText()).toBe(longDraft);
			expect(viewport()[terminal.getCursor().row]).toContain("draft line 40");
		},
	);

	it("selects blocked B before pending A in a six-row actual HUD and its native fallback", async () => {
		await initializeViewport(18);
		const mixed: TodoPhase[] = [
			{
				name: "Phase A",
				tasks: [
					{ content: "A doing", status: "in_progress" },
					{ content: "A pending 1", status: "pending" },
					{ content: "A pending 2", status: "pending" },
				],
			},
			{ name: "Phase B", tasks: [{ content: "B blocked", status: "blocked" }] },
		];
		mode.setTodos(mixed);
		await terminal.waitForRender(() => viewport().some(line => line.includes("+2 more open")));
		const frame = viewport();
		expect(visibleTasks(frame, ["A doing", "B blocked", "A pending 1", "A pending 2"])).toEqual([
			"A doing",
			"B blocked",
		]);
		expect(overflowCount(frame)).toBe(2);
		expect(frame.filter(line => line.includes("Phase A"))).toHaveLength(1);
		expect(frame.filter(line => line.includes("Phase B"))).toHaveLength(1);
		expect(mode.todoContainer.render(120)).toHaveLength(6);
		const fallback = JSON.stringify(mode.todoHudNative?.fallback);
		expect(fallback).toContain("A doing");
		expect(fallback).toContain("B blocked");
		expect(fallback).not.toContain("A pending");
		expect(fallback).toContain("+2 more open");
	});

	it.each([
		{ terminalRows: 27, panelRows: 15, shown: 11, hidden: 0 },
		{ terminalRows: 18, panelRows: 6, shown: 3, hidden: 8 },
	])(
		"accounts for multiline task and phase labels in the actual $terminalRows-row viewport",
		async ({ terminalRows, panelRows, shown, hidden }) => {
			await initializeViewport(terminalRows);
			const multiline: TodoPhase[] = [
				{
					name: "Execution\nphase detail",
					tasks: Array.from({ length: 4 }, (_, i) => ({
						content: `Multiline task ${i + 1}\ntask detail ${i + 1}`,
						status: "in_progress" as const,
					})),
				},
				{
					name: "Needs unblock\nphase detail",
					tasks: Array.from({ length: 3 }, (_, i) => ({
						content: `Multiline task ${i + 5}\ntask detail ${i + 5}`,
						status: "blocked" as const,
					})),
				},
				{
					name: "Queued work\nphase detail",
					tasks: Array.from({ length: 4 }, (_, i) => ({
						content: `Multiline task ${i + 8}\ntask detail ${i + 8}`,
						status: "pending" as const,
					})),
				},
			];
			const labels = Array.from({ length: 11 }, (_, i) => `Multiline task ${i + 1}`);
			const canonical = structuredClone(multiline);
			mode.setTodos(multiline);
			await mode.handleTodoCommand("expand");
			const expandedBefore = mode.todoContainer.render(120);
			expect(
				renderPanel(mode).some(line => line.includes("task detail 1") && !line.includes("Multiline task 1")),
			).toBe(true);
			await mode.handleTodoCommand("collapse");
			mode.editor.setDraft(longDraft);
			mode.ui.requestRender();
			await terminal.waitForRender(
				() =>
					visibleTasks(viewport(), labels).length === shown &&
					overflowCount(viewport()) === hidden &&
					viewport().some(line => line.includes("draft line 40")),
			);
			const frame = viewport();
			const visible = visibleTasks(frame, labels);
			expect(visible).toEqual(labels.slice(0, shown));
			expect(overflowCount(frame)).toBe(hidden);
			expect(new Set(visible).size + overflowCount(frame)).toBe(11);
			const panel = mode.todoContainer.render(120).map(line => Bun.stripANSI(line));
			expect(panel).toHaveLength(panelRows);
			expect(panel.every(line => !line.includes("\n"))).toBe(true);
			expect(visibleTasks(panel, labels)).toEqual(visible);
			expect(overflowCount(panel)).toBe(hidden);
			expect(panel.some(line => line.includes("Execution phase detail"))).toBe(true);
			for (const label of visible) {
				const taskNumber = Number(label.match(/\d+$/)?.[0]);
				expect(frame.find(line => line.includes(`${label} task detail ${taskNumber}`))).toBeDefined();
			}
			expect(mode.todoPhases).toEqual(canonical);
			expect(mode.editor.getExpandedText()).toBe(longDraft);
			expect(frame[terminal.getCursor().row]).toContain("draft line 40");
			await mode.handleTodoCommand("expand");
			expect(mode.todoContainer.render(120)).toEqual(expandedBefore);
			expect(mode.todoPhases).toEqual(canonical);
		},
	);

	it("keeps repeated phase fallback identities disjoint from consumer task identities in a roomy HUD", async () => {
		await initializeViewport(27);
		const mixed: TodoPhase[] = [
			{
				name: "Phase A",
				tasks: [
					{ content: "A doing", status: "in_progress" },
					{ content: "A pending 1", status: "pending" },
					{ content: "A pending 2", status: "pending" },
				],
			},
			{ name: "Phase B", tasks: [{ content: "B blocked", status: "blocked" }] },
		];
		const identities = ["A doing", "B blocked", "A pending 1", "A pending 2"];
		mode.setTodos(mixed);
		await terminal.waitForRender(() => visibleTasks(viewport(), identities).length === 4);
		expect(visibleTasks(viewport(), identities)).toEqual(identities);
		expect(overflowCount(viewport())).toBe(0);
		const context = { cols: 120, reduceMotion: true, dark: true, supports: () => false, feature: () => false };
		const fallback = mode.todoContainer.describe(context);
		const tree = fallback?.c?.find(child => "k" in child && child.k === "tree");
		if (!tree || !("k" in tree) || tree.k !== "tree") throw new Error("Expected consumer TODO fallback tree");
		const headings = tree.p?.nodes ?? [];
		const tasks = headings.flatMap(heading => heading.children ?? []);
		const nodes = [...headings, ...tasks];
		expect(new Set(nodes.map(item => item.id)).size).toBe(nodes.length);
		expect(headings.map(item => item.id)).toEqual(["0", "1", "phase:0:2"]);
		expect(tasks.map(item => item.id)).toEqual(["0.0", "1.0", "0.1", "0.2"]);
		const checklist = mode.todoContainer.describe({ ...context, supports: kind => kind === "checklist" });
		if (checklist?.k !== "checklist") throw new Error("Expected consumer TODO checklist");
		const checklistItems = checklist.p?.phases.flatMap(phase => phase.items) ?? [];
		for (const task of tasks) {
			const canonical = checklistItems.find(item => item.id === task.id);
			expect(canonical).toBeDefined();
			expect(JSON.stringify(task.label)).toContain(canonical!.text as string);
			// A native select/activate item ID must resolve to just its task,
			// never the repeated Phase A heading (formerly also "0.2").
			expect(nodes.filter(item => item.id === task.id)).toEqual([task]);
		}
		await mode.handleTodoCommand("expand");
		await mode.handleTodoCommand("collapse");
		expect(mode.todoContainer.describe(context)).toEqual(fallback);
		expect(mode.todoPhases).toEqual(mixed);
	});

	it("reallocates the actual viewport 27 to 18 to 27 without a todo update or collapse", async () => {
		await initializeViewport(27);
		mode.setTodos(openPanelPhases);
		mode.editor.setDraft(longDraft);
		mode.ui.requestRender();
		await terminal.waitForRender(() => viewport().some(line => line.includes("draft line 40")));
		expectAccountedOpenRows(openTaskIdentities);
		const original = mode.todoContainer.render(120);
		terminal.resize(120, 18);
		await terminal.waitForRender(() => viewport().some(line => line.includes("+8 more open")));
		expectAccountedOpenRows(openTaskIdentities);
		expect(visibleTasks(viewport(), openTaskIdentities)).toEqual(openTaskIdentities.slice(0, 3));
		expect(overflowCount(viewport())).toBe(8);
		terminal.resize(120, 27);
		await terminal.waitForRender(() => visibleTasks(viewport(), openTaskIdentities).length === 11);
		expectAccountedOpenRows(openTaskIdentities);
		expect(mode.todoContainer.render(120)).toEqual(original);
		expect(mode.editor.getExpandedText()).toBe(longDraft);
	});

	it("reflows the actual HUD 120 to 40 columns without hiding the overflow count or expand command", async () => {
		await initializeViewport(18);
		mode.setTodos(openPanelPhases);
		mode.editor.setDraft(longDraft);
		mode.ui.requestRender();
		await terminal.waitForRender(() => viewport().some(line => line.includes("+8 more open")));
		expectAccountedOpenRows(openTaskIdentities);
		terminal.resize(40, 18);
		await terminal.waitForRender(() =>
			viewport().some(line => line.includes("+8 more open") && line.includes("/todo expand")),
		);
		expectAccountedOpenRows(openTaskIdentities);
		expect(viewport().find(line => line.includes("+8 more open"))).toContain("/todo expand");
		expect(mode.todoContainer.render(40)).toHaveLength(6);
		expect(mode.editor.getExpandedText()).toBe(longDraft);
		await mode.handleTodoCommand("expand");
		const expanded = mode.todoContainer.render(40).map(line => Bun.stripANSI(line));
		expect(visibleTasks(expanded, allTaskIdentities(openPanelPhases))).toEqual(allTaskIdentities(openPanelPhases));
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
});
