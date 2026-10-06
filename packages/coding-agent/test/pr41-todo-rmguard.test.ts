import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	createRequirementCandidates,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

const AT = "2026-10-04T12:00:00.000Z";
const LINKED_ROW = "Preserve linked work";

function createLinkedSession(): { tool: TodoTool; phases: () => TodoPhase[] } {
	const manager = SessionManager.inMemory();
	const requirements = createRequirementCandidates([], ["preserve linked work"], AT);
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements });
	let phases: TodoPhase[] = [];
	const session: ToolSession = {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => "/tmp/test-session.json",
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		sessionManager: manager,
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
	return { tool: new TodoTool(session), phases: () => phases };
}

async function linkRow(tool: TodoTool): Promise<void> {
	await tool.execute("init", { op: "init", list: [{ phase: "Work", items: [LINKED_ROW, "Unlinked neighbor"] }] });
	const result = await tool.execute("link", {
		op: "classify",
		id: "R1",
		classification: "linked",
		rows: [LINKED_ROW],
	} as never);
	if (result.isError) throw new Error("Unable to link fixture row");
}

describe("requirement-linked TODO removal guard", () => {
	it("refuses rm of a linked row and preserves it", async () => {
		const { tool, phases } = createLinkedSession();
		await linkRow(tool);

		const result = await tool.execute("rm", { op: "rm", task: LINKED_ROW });
		const text = result.content.find(part => part.type === "text");
		expect(result.isError).toBe(true);
		expect(text?.type === "text" ? text.text : "").toContain('op="classify"');
		expect(text?.type === "text" ? text.text : "").toContain('id="R1"');
		expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).toContain(LINKED_ROW);
	});

	it("still removes an unlinked neighboring row", async () => {
		const { tool, phases } = createLinkedSession();
		await linkRow(tool);

		const result = await tool.execute("rm", { op: "rm", task: "Unlinked neighbor" });
		expect(result.isError).toBeUndefined();
		expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).not.toContain("Unlinked neighbor");
		expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).toContain(LINKED_ROW);
	});
});
