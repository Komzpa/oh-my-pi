import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

const AT = "2026-09-28T12:00:00.000Z";
const ROW = "Fix login bug";
const RAW = "fix the login bug";

function assistantStop(): Parameters<SessionManager["appendMessage"]>[0] {
	return {
		role: "assistant",
		content: [{ type: "text", text: "working" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	} as unknown as Parameters<SessionManager["appendMessage"]>[0];
}
function setupOverdueSession(): { manager: SessionManager; runtime: RequirementsLedgerRuntime } {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
		version: 1,
		requirements: createRequirementCandidates([], [RAW], AT),
	});
	const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: ROW, status: "pending" }] }];
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	manager.appendMessage(assistantStop());
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => "/tmp/test",
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
		setPublicationGate: () => {},
	});
	return { manager, runtime };
}

function todoSession(manager: SessionManager): ToolSession {
	let phases: TodoPhase[] = [];
	return {
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
}

describe("gate refusal names the exact unblocking call", () => {
	it("bash refusal parses into a classify call that succeeds and unblocks bash", async () => {
		const { manager, runtime } = setupOverdueSession();

		const refusal = runtime.refuseOverdueCandidate("bash");
		expect(refusal?.block).toBe(true);
		const reason = refusal && typeof refusal === "object" && "reason" in refusal ? String(refusal.reason) : "";
		// The refusal must name the exact call with the real id, candidate words, and row.
		expect(reason).toContain('op="classify"');
		expect(reason).toContain('id="R1"');
		expect(reason).toContain(RAW);
		expect(reason).toContain(JSON.stringify([ROW]));
		expect(reason).toContain("Then retry");

		// Parse the call the refusal names and execute it through TodoTool.
		const id = /id="(R\d+)"/.exec(reason)?.[1];
		const rowsJson = /rows=(\[.*?\])/.exec(reason)?.[1];
		expect(id).toBe("R1");
		const rows: unknown = JSON.parse(rowsJson ?? "null");
		expect(rows).toEqual([ROW]);

		const tool = new TodoTool(todoSession(manager));
		const result = await tool.execute("call-1", { op: "classify", id, classification: "linked", rows } as never);
		expect(result.isError).toBeFalsy();
		expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("linked");

		expect(runtime.refuseOverdueCandidate("bash")).toBeUndefined();
	});

	it("classify appears in the model-visible todo tool definition", () => {
		const { manager } = setupOverdueSession();
		const tool = new TodoTool(todoSession(manager));
		expect(tool.description).toContain("classify");
		const parsed = (tool.parameters as (value: unknown) => unknown)({
			op: "classify",
			id: "R1",
			classification: "linked",
			rows: [ROW],
		});
		expect(parsed instanceof type.errors).toBe(false);
	});
	it("todo done without a target names the exact form", async () => {
		const { manager } = setupOverdueSession();
		const tool = new TodoTool(todoSession(manager));
		const result = await tool.execute("call-1", { op: "done", items: [] } as never);
		const text = result.content.find(part => part.type === "text");
		expect(result.isError).toBe(true);
		expect(text?.type === "text" ? text.text : "").toContain('op="done", task="<exact row>"');
	});
});
