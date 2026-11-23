import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { recoverCrashedRows } from "@oh-my-pi/pi-coding-agent/task/crash-recovery";
import { INTERRUPTED_TURN_ERROR } from "../../src/session/exit-diagnostics";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";
import { Semaphore } from "@oh-my-pi/pi-coding-agent/task/parallel";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

/** A turn the process died in, mid tool call (no result, no exit record). */
const cutOff: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
		stopReason: "toolUse",
	}),
];
/** A turn that ended on the model's own answer. */
const finished: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({ content: [{ type: "text", text: "all done" }] }),
];

/** Writes subagent `id`'s transcript under the main session `mainFile`, with its spawn contract. */
async function writeSubagent(mainFile: string, cwd: string, id: string, messages: Message[]): Promise<string> {
	const file = path.join(mainFile.slice(0, -6), `${id}.jsonl`);
	const manager = await SessionManager.open(file, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	manager.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "yield"] });
	for (const message of messages) manager.appendMessage(message);
	await manager.close();
	return file;
}

describe("kill/replay through ordinary resume", () => {
	const ids = ["Cut", "Cut-2", "Done", "Killed", "Failed", "Yielded"];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const id of ids) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones", async () => {
		tempDir = TempDir.createSync("@pi-restore-subagents-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		await main.close();
		await writeSubagent(mainFile, cwd, "Cut", [
			...cutOff,
			assistant({ stopReason: "aborted", errorMessage: INTERRUPTED_TURN_ERROR }),
		]);
		await writeSubagent(mainFile, cwd, "Done", finished);
		const killed = await writeSubagent(mainFile, cwd, "Killed", cutOff);
		await fs.writeFile(getAgentTombstonePath(killed), "");

		manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink(MAIN_AGENT_ID, jobId => {
			delivered.push(jobId);
		});
		const result: SingleResult = {
			index: 0,
			id: "Cut",
			agent: "Cut",
			agentSource: "user",
			task: "Cut task",
			exitCode: 0,
			output: "finished after the restart",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
		};
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(result);
		let phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: ["Cut", "Done", "Killed", "Failed", "Yielded"].map(id => ({
					content: `${id} row`,
					status: "in_progress",
					schedule: {
						owner: id,
						executor: { workerId: id, startedAt: 1, ...(id === "Cut" ? { outcome: "aborted" as const } : {}) },
					},
				})),
			},
		];
		await writeSubagent(mainFile, cwd, "Failed", [assistant({ stopReason: "error", errorMessage: "real failure" })]);
		await writeSubagent(mainFile, cwd, "Yielded", [
			assistant({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "yield_1", name: "yield", arguments: {} }],
			}),
			{
				role: "toolResult",
				toolCallId: "yield_1",
				toolName: "yield",
				content: [{ type: "text", text: "accepted" }],
				isError: false,
				timestamp: Date.now(),
			},
		]);
		const permit = new Semaphore(1);
		await permit.acquire(new AbortController().signal);
		const taskTool = Object.create(TaskTool.prototype) as TaskTool;
		Object.defineProperty(taskTool, "recoveryPermit", { value: permit });
		const session = {
			sessionManager: { getSessionFile: () => mainFile },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			getToolByName: () => {
				const wrapper = { name: "task" };
				applyToolProxy(taskTool, wrapper);
				return wrapper;
			},
			getTodoPhases: () => phases,
			getTodoSnapshot: () => phases,
			commitTodoPhases: (next: TodoPhase[]) => {
				phases = next;
			},
		} as unknown as AgentSession;

		const outcome = await recoverCrashedRows(session);

		expect(outcome).toEqual({ turn: false, subagents: ["Cut-2"] });
		expect(followUp).toHaveBeenCalledTimes(0);
		expect((await recoverCrashedRows(session)).subagents).toEqual([]);
		permit.release();
		await manager.getJob("Cut-2")!.promise;
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "Cut-2", restore: true, message: "Cut task" });
		await manager.getJob("Cut-2")!.promise;
		await manager.drainDeliveries({ filter: { ownerId: MAIN_AGENT_ID } });
		expect(delivered).toEqual(["Cut-2"]);
		expect(phases[0]!.tasks[0]!.schedule?.executor).toMatchObject({ workerId: "Cut-2", outcome: "completed" });
		expect((await recoverCrashedRows(session)).subagents).toEqual([]);
		expect(followUp).toHaveBeenCalledTimes(1);
		const copy = await SessionManager.open(path.join(mainFile.slice(0, -6), "Cut-2.jsonl"), undefined, undefined, {
			suppressBreadcrumb: true,
		});
		expect(copy.getCwd()).toBe(cwd);
		expect(
			copy
				.getEntries()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some(part => part.type === "toolCall" && part.id === "call_1"),
				),
		).toBe(true);
		await copy.close();
	});
});
