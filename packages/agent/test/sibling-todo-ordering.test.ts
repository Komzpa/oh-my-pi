import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const todoSchema = type({ op: "string", id: "string", rows: "string[]" });
const bashSchema = type({ command: "string", marker: "string" });

interface Fixture {
	candidate: "candidate" | "linked";
	todo: AgentTool<typeof todoSchema, { op: string }>;
	bash: AgentTool<typeof bashSchema, { command: string }>;
	bashExecuted: boolean;
}

function buildFixture(dir: string): Fixture {
	const markerPath = path.join(dir, "bash-effect.txt");
	const fixture: Fixture = {
		candidate: "candidate",
		bashExecuted: false,
		todo: undefined as never,
		bash: undefined as never,
	};
	fixture.todo = {
		name: "todo",
		label: "Todo",
		description: "Classify requirement candidates",
		parameters: todoSchema,
		concurrency: "exclusive",
		async execute(_id, params) {
			if (params.op === "classify" && params.id === "R43" && params.rows.length > 0) {
				fixture.candidate = "linked";
				return { content: [{ type: "text", text: "classified R43" }], details: { op: params.op } };
			}
			return {
				content: [{ type: "text", text: "Blocked: classify R43 failed" }],
				details: { op: params.op },
				isError: true,
			};
		},
	};
	fixture.bash = {
		name: "bash",
		label: "Bash",
		description: "Execute a shell command",
		parameters: bashSchema,
		concurrency: "shared",
		async execute(_id, params) {
			fixture.bashExecuted = true;
			fs.writeFileSync(markerPath, `effect:${params.command}`);
			return { content: [{ type: "text", text: "ok" }], details: { command: params.command } };
		},
	};
	return fixture;
}

async function runBatch(
	fixture: Fixture,
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
	configOverrides: Partial<AgentLoopConfig> = {},
): Promise<ToolResultMessage[]> {
	const mock = createMockModel({
		responses: [{ content: calls.map(c => ({ type: "toolCall" as const, ...c })) }, { content: ["done"] }],
	});
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [fixture.todo, fixture.bash] };
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		beforeToolCall: ({ tool }) => {
			if (tool.name === "todo") return undefined;
			if (fixture.candidate === "candidate") {
				return { block: true, reason: `R43 awaits todo classify (blocked ${tool.name})` };
			}
			return undefined;
		},
		...configOverrides,
	};
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
	for await (const _event of stream) {
		// drain
	}
	return (await stream.result()).filter((m): m is ToolResultMessage => m.role === "toolResult");
}

describe("sibling todo ordering barrier", () => {
	it("runs bash after a same-batch todo classify of R43", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-todo-"));
		try {
			const fixture = buildFixture(dir);
			const results = await runBatch(fixture, [
				{ id: "call-todo", name: "todo", arguments: { op: "classify", id: "R43", rows: ["row-a"] } },
				{
					id: "call-bash",
					name: "bash",
					arguments: { command: "probe", marker: path.join(dir, "bash-effect.txt") },
				},
			]);
			expect(fixture.candidate).toBe("linked");
			expect(results.find(r => r.toolCallId === "call-bash")?.isError).toBe(false);
			expect(fs.existsSync(path.join(dir, "bash-effect.txt"))).toBe(true);
			expect(fixture.bashExecuted).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs bash after a reversed-order same-batch todo classify of R43", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-todo-rev-"));
		try {
			const fixture = buildFixture(dir);
			const results = await runBatch(fixture, [
				{
					id: "call-bash",
					name: "bash",
					arguments: { command: "probe", marker: path.join(dir, "bash-effect.txt") },
				},
				{ id: "call-todo", name: "todo", arguments: { op: "classify", id: "R43", rows: ["row-a"] } },
			]);
			expect(fixture.candidate).toBe("linked");
			expect(results.find(r => r.toolCallId === "call-bash")?.isError).toBe(false);
			expect(fs.existsSync(path.join(dir, "bash-effect.txt"))).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("blocks bash-only while the R43 candidate is unclassified", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-todo-neg-"));
		try {
			const fixture = buildFixture(dir);
			const results = await runBatch(fixture, [
				{
					id: "call-bash",
					name: "bash",
					arguments: { command: "probe", marker: path.join(dir, "bash-effect.txt") },
				},
			]);
			const bashResult = results.find(r => r.toolCallId === "call-bash");
			expect(bashResult?.isError).toBe(true);
			expect(JSON.stringify(bashResult?.content ?? [])).toContain("R43 awaits todo classify");
			expect(fs.existsSync(path.join(dir, "bash-effect.txt"))).toBe(false);
			expect(fixture.bashExecuted).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps bash blocked when the sibling classify fails", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-todo-fail-"));
		try {
			const fixture = buildFixture(dir);
			const results = await runBatch(fixture, [
				{ id: "call-todo", name: "todo", arguments: { op: "classify", id: "R43", rows: [] } },
				{
					id: "call-bash",
					name: "bash",
					arguments: { command: "probe", marker: path.join(dir, "bash-effect.txt") },
				},
			]);
			expect(results.find(r => r.toolCallId === "call-todo")?.isError).toBe(true);
			const bashResult = results.find(r => r.toolCallId === "call-bash");
			expect(bashResult?.isError).toBe(true);
			expect(JSON.stringify(bashResult?.content ?? [])).toContain("R43 awaits todo classify");
			expect(fs.existsSync(path.join(dir, "bash-effect.txt"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	for (const todoFirst of [false, true]) {
		it(`executes the original QA task with the post-classify audit input (${todoFirst ? "todo first" : "task first"})`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-todo-qa-"));
			try {
				const fixture = buildFixture(dir);
				const taskSchema = type({ task: "string", auditInput: "string" });
				const originalTask = "Review R43 row-a against its implementation evidence";
				const auditInput = JSON.stringify({ requirements: [{ id: "R43", status: "linked", rows: ["row-a"] }] });
				const received: Array<{ task: string; auditInput: string; state: string }> = [];
				const gateStates: string[] = [];
				let speculativeExecutions = 0;
				const task: AgentTool<typeof taskSchema> = {
					name: "task",
					label: "Task",
					description: "Run QA against a frozen requirement snapshot",
					parameters: taskSchema,
					concurrency: "shared",
					speculation: {
						finalized: {
							assess: () => ({ eligible: true, effect: { kind: "pure" } }),
							async execute({ args }) {
								speculativeExecutions++;
								received.push({
									task: String(args.task),
									auditInput: String(args.auditInput),
									state: fixture.candidate,
								});
								return { kind: "result", result: { content: [] }, isError: false };
							},
						},
					},
					async execute(_id, args) {
						received.push({ ...args, state: fixture.candidate });
						return { content: [] };
					},
				};
				const todoCall = {
					type: "toolCall" as const,
					id: "qa-todo",
					name: "todo",
					arguments: { op: "classify", id: "R43", rows: ["row-a"] },
				};
				const taskCall = {
					type: "toolCall" as const,
					id: "qa-task",
					name: "task",
					arguments: { task: originalTask, auditInput: "" },
				};
				const calls = todoFirst ? [todoCall, taskCall] : [taskCall, todoCall];
				const mock = createMockModel({ responses: [{ content: calls }, { content: ["done"] }] });
				const messages = await agentLoop(
					[createUserMessage("classify and review")],
					{ systemPrompt: [""], messages: [], tools: [fixture.todo, task] },
					{
						model: mock.model,
						convertToLlm: identityConverter,
						beforeToolCall: ({ tool, args }) => {
							if (tool.name === "todo") return undefined;
							gateStates.push(fixture.candidate);
							if (fixture.candidate !== "linked") return { block: true, reason: "R43 awaits classification" };
							return { args: { ...args, auditInput } };
						},
						speculativeToolExecution: {
							enabled: true,
							host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
						},
					},
					undefined,
					mock.stream,
				).result();
				// The consumer receives the exact original task and the gate's frozen
				// snapshot, not a candidate prepared before the todo mutation.
				expect(received).toEqual([{ task: originalTask, auditInput, state: "linked" }]);
				expect(gateStates).toEqual(["linked"]);
				expect(speculativeExecutions).toBe(0);
				expect(
					messages.filter((m): m is ToolResultMessage => m.role === "toolResult").map(m => m.toolCallId),
				).toEqual(calls.map(c => c.id));
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	for (const mutation of ["failed classify", "no mutation"] as const) {
		it(`does not launch host-deferred bash while its candidate gate blocks (${mutation})`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-todo-spec-block-"));
			try {
				const fixture = buildFixture(dir);
				const marker = path.join(dir, "speculative-effect.txt");
				let speculativeExecutions = 0;
				fixture.bash.speculation = {
					finalized: {
						assess: () => ({ eligible: true, effect: { kind: "pure" } }),
						async execute() {
							speculativeExecutions++;
							// Observable launch sentinel, not an actual shell process.
							fs.writeFileSync(marker, "launched");
							return { kind: "result", result: { content: [] }, isError: false };
						},
					},
				};
				// Candidate first ensures speculation is admitted before the unsafe
				// todo tool can establish the ordinary direct-speculation barrier.
				const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [
					{ id: "blocked-bash", name: "bash", arguments: { command: "probe", marker } },
				];
				if (mutation === "failed classify") {
					calls.push({ id: "failed-todo", name: "todo", arguments: { op: "classify", id: "R43", rows: [] } });
				}
				const results = await runBatch(fixture, calls, {
					speculativeToolExecution: {
						enabled: true,
						host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
					},
				});
				expect(speculativeExecutions).toBe(0);
				expect(fs.existsSync(marker)).toBe(false);
				expect(fixture.bashExecuted).toBe(false);
				expect(results.find(r => r.toolCallId === "blocked-bash")?.isError).toBe(true);
				if (mutation === "failed classify")
					expect(results.find(r => r.toolCallId === "failed-todo")?.isError).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
