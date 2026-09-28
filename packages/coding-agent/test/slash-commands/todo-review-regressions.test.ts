import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { handleTodoAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";

describe("PR41 text/ACP TODO completion gate", () => {
	it("does not complete an abandoned linked row through no-argument /todo done", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "todo-acp-done-gate-"));
		try {
			const manager = SessionManager.inMemory(cwd);
			const row = "Abandoned linked task";
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [{ name: "Work", tasks: [{ content: row, status: "abandoned" }] }],
			});
			const candidate = createRequirementCandidates([], [`complete ${row}`], "2026-10-25T12:00:00.000Z")[0]!;
			const requirement: RequirementLedgerItem = { ...candidate, classification: "linked", rows: [row] };
			appendRequirementsSnapshot(
				{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
				[requirement],
			);
			const output = vi.fn();
			let inMemory: TodoPhase[] = getLatestTodoPhasesFromEntries(manager.getBranch());
			const runtime = {
				session: {
					getTodoPhases: () => inMemory,
					setTodoPhases: (next: typeof inMemory) => {
						inMemory = next;
					},
				},
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd,
				output,
				refreshCommands: vi.fn(),
				reloadPlugins: vi.fn(),
			} as unknown as SlashCommandRuntime;

			const result = await handleTodoAcp({ name: "todo", args: "done", text: "/todo done" }, runtime);

			expect(result).toEqual({ consumed: true, failed: true });
			expect(output).toHaveBeenCalledWith(expect.stringContaining("R1"));
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]?.status).toBe("abandoned");
			expect(inMemory[0]?.tasks[0]?.status).toBe("abandoned");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("guards ACP rm and import replacement of unfinished linked rows", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "todo-acp-removal-gate-"));
		try {
			const manager = SessionManager.inMemory(cwd);
			const row = "Keep ACP linked work";
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [{ name: "Work", tasks: [{ content: row, status: "pending" }] }],
			});
			const candidate = createRequirementCandidates([], [`complete ${row}`], "2026-10-25T12:00:00.000Z")[0]!;
			const requirement: RequirementLedgerItem = { ...candidate, classification: "linked", rows: [row] };
			appendRequirementsSnapshot(
				{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
				[requirement],
			);
			const output = vi.fn();
			let inMemory = getLatestTodoPhasesFromEntries(manager.getBranch());
			const runtime = {
				session: {
					getTodoPhases: () => inMemory,
					setTodoPhases: (next: typeof inMemory) => {
						inMemory = next;
					},
				},
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd,
				output,
				refreshCommands: vi.fn(),
				reloadPlugins: vi.fn(),
			} as unknown as SlashCommandRuntime;
			const invoke = (args: string) => handleTodoAcp({ name: "todo", args, text: `/todo ${args}` }, runtime);

			await invoke(`rm ${row}`);
			await fs.writeFile(path.join(cwd, "TODO.md"), "# Replacement\n- [ ] Unrelated task\n", "utf8");
			await invoke("import");

			expect(output).toHaveBeenCalledTimes(2);
			expect(output).toHaveBeenCalledWith(expect.stringContaining("Cannot remove unfinished requirement-linked"));
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks.map(task => task.content)).toContain(row);
			expect(
				getLatestTodoPhasesFromEntries(manager.getBranch()).flatMap(phase => phase.tasks.map(task => task.content)),
			).not.toContain("Unrelated task");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
