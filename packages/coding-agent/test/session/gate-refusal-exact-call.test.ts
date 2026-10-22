import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
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
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as unknown as Parameters<SessionManager["appendMessage"]>[0];
}
function setupCandidateSession(): { manager: SessionManager; runtime: RequirementsLedgerRuntime; phases: TodoPhase[] } {
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
	return { manager, runtime, phases };
}

function todoSession(manager: SessionManager, initial: TodoPhase[]): ToolSession {
	let phases = initial;
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
	it("allows worker stop controls without classifying while keeping new work blocked", () => {
		const { manager, runtime } = setupCandidateSession();
		expect(
			runtime.remindUnclassifiedCandidates("write", { path: "agent://PhoneWorker", content: "stop" }),
		).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("write", { path: "agent://all", content: "stop" })).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("write", { path: "proc://PhoneWorker/kill" })).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("task", { action: "abort", id: "PhoneWorker" })).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("task", { action: "cancel", id: "PhoneWorker" })).toBeUndefined();
		expect(
			runtime.remindUnclassifiedCandidates("task", { tasks: [{ task: "tap the phone" }] })?.additionalContext,
		).toContain("R1");
		expect(
			runtime.remindUnclassifiedCandidates("task", { action: "cancel", task: "tap the phone" })?.additionalContext,
		).toContain("R1");
		expect(runtime.remindUnclassifiedCandidates("write", { path: "probe.txt", content: "new work" })).toBeUndefined();
		expect(
			runtime.remindUnclassifiedCandidates("write", { path: "proc://PhoneWorker/mode", content: "persist" }),
		).toBeUndefined();
		expect(runtime.remindUnclassifiedCandidates("bash", { command: "touch probe.txt" })).toBeUndefined();
		expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("candidate");
	});

	it("keeps closure blocked until a genuine candidate is classified", async () => {
		const { manager, runtime, phases } = setupCandidateSession();
		const result = await new TodoTool(todoSession(manager, phases)).execute("close", { op: "done", task: ROW });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: expect.stringContaining("R1 awaits todo classify") }),
			]),
		);
		expect(phases[0]!.tasks[0]!.status).toBe("pending");
		expect(
			runtime.remindUnclassifiedCandidates("write", { path: "agent://PhoneWorker", content: "stop" }),
		).toBeUndefined();
	});

	it("records R51-shaped go-ahead as non-requirement but preserves following obligations", () => {
		const { manager, runtime } = setupCandidateSession();
		appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, []);
		runtime.captureCandidate("го го го");
		runtime.captureCandidate("👍");
		runtime.captureCandidate("блять");
		expect(getLatestRequirements(manager.getBranch()).map(item => item.classification)).toEqual([
			"not-a-requirement",
			"not-a-requirement",
			"not-a-requirement",
		]);
		expect(runtime.remindUnclassifiedCandidates("task", { task: "continue existing plan" })).toBeUndefined();
		runtime.captureCandidate("го почини login");
		expect(getLatestRequirements(manager.getBranch()).at(-1)?.classification).toBe("candidate");
		expect(runtime.remindUnclassifiedCandidates("task", { task: "fix login" })?.additionalContext).toContain("R");
		expect(runtime.remindUnclassifiedCandidates("bash", { command: "touch probe.txt" })).toBeUndefined();
	});

	it("copied placeholder hint cannot link; an explicit relevant row unblocks", async () => {
		const { manager, runtime, phases } = setupCandidateSession();

		const refusal = runtime.remindUnclassifiedCandidates("task", { task: "fix the login bug" });
		expect(refusal?.block).toBeUndefined();
		const reason = refusal?.additionalContext ?? "";
		// The refusal names the exact candidate but never a guessed runnable row.
		expect(reason).toContain('op="classify"');
		expect(reason).toContain('id="R1"');
		expect(reason).toContain(RAW);
		expect(reason).toContain('rows=["<exact todo row>"]');
		expect(reason).not.toContain(`rows=${JSON.stringify([ROW])}`);
		expect(reason).toContain(ROW);
		expect(reason).toContain("Classify them when convenient");

		// Copying the placeholder hint cannot silently link the candidate.
		const id = /id="(R\d+)"/.exec(reason)?.[1];
		const rowsJson = /rows=(\[.*?\])/.exec(reason)?.[1];
		expect(id).toBe("R1");
		const copied: unknown = JSON.parse(rowsJson ?? "null");
		expect(copied).toEqual(["<exact todo row>"]);

		const tool = new TodoTool(todoSession(manager, phases));
		const refused = await tool.execute("call-1", {
			op: "classify",
			id,
			classification: "linked",
			rows: copied,
		} as never);
		expect(refused.isError).toBe(true);
		expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("candidate");
		expect(runtime.remindUnclassifiedCandidates("task", { task: "fix the login bug" })?.additionalContext).toContain(
			"unclassified candidate",
		);

		// Explicitly selecting the relevant row succeeds and unblocks bash.
		const result = await tool.execute("call-2", {
			op: "classify",
			id,
			classification: "linked",
			rows: [ROW],
		} as never);
		expect(result.isError).toBeFalsy();
		expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("linked");

		expect(runtime.remindUnclassifiedCandidates("task", { task: "fix the login bug" })).toBeUndefined();
	});
});
