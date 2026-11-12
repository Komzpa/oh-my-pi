import { expect, spyOn, test } from "bun:test";
import { SessionManager } from "../src/session/session-manager";
import { readTodoDisplayArchive, readTodoDisplayLedgerFromManager } from "../src/tools/todo-plan-display";

test("HUD refreshes avoid historical payloads and refresh ledger and auditor state on branch changes", () => {
	const manager = SessionManager.inMemory();
	const note = "ROLE: chief of staff\n".repeat(2600);
	for (let i = 0; i < 1400; i++) manager.appendCustomEntry("user_todo_edit", { note });
	manager.appendCustomEntry("requirements_ledger", {
		requirements: [{ classification: "required", rows: ["Ship"], rowVerdicts: { Ship: { status: "pass" } } }],
	});
	manager.appendCustomEntry("requirements_auditor_assignments", {
		jobs: [{ agent: "qa-auditor", workerId: "audit", rows: ["Ship"] }],
	});
	const fullBranch = spyOn(manager, "getBranch");
	try {
		for (let i = 0; i < 50; i++) {
			const view = readTodoDisplayLedgerFromManager(manager, new Set(["audit"]));
			expect(view.requirements?.[0]?.rowVerdicts?.Ship?.status).toBe("pass");
			expect(view.auditors.get("Ship")).toBe("audit");
		}
		expect(fullBranch).toHaveBeenCalledTimes(0);
		expect(readTodoDisplayLedgerFromManager(manager, new Set()).auditors.size).toBe(0);
		manager.appendCustomEntry("requirements_ledger", {
			requirements: [{ classification: "required", rows: ["Ship"], rowVerdicts: { Ship: { status: "fail" } } }],
		});
		expect(readTodoDisplayLedgerFromManager(manager).requirements?.[0]?.rowVerdicts?.Ship?.status).toBe("fail");
		expect(fullBranch).toHaveBeenCalledTimes(0);
	} finally {
		fullBranch.mockRestore();
	}
});

test("archive refresh reuses reconstruction across unrelated messages and clears after todo init", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("user_todo_edit", {
		edit: {
			v: 1,
			kind: "archive",
			at: 1000,
			archivedPhases: [{ name: "Old", tasks: [{ content: "Shipped", status: "completed" }] }],
		},
	});
	for (let i = 0; i < 50; i++) {
		manager.appendCustomEntry("unrelated", { tick: i });
		const view = readTodoDisplayArchive(manager);
		expect(view.summary?.count).toBe(1);
		expect(view.phases[0]?.tasks[0]?.content).toBe("Shipped");
	}
	manager.appendCustomEntry("user_todo_edit", { edit: { v: 1, kind: "op", at: 2000, op: "init", params: {} } });
	const cleared = readTodoDisplayArchive(manager);
	expect(cleared.summary).toBeUndefined();
	expect(cleared.phases).toEqual([]);
});
