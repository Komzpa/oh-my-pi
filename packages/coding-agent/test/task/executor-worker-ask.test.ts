import { afterEach, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as questions from "@oh-my-pi/pi-coding-agent/task/worker-questions";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

function harness(task = "Fix camera", maxRuntimeMs = 0) {
	const messages: AgentMessage[] = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const prompts: string[] = [];
	const asked = Promise.withResolvers<void>();
	const turnStopped = Promise.withResolvers<void>();
	let listener: (event: AgentSessionEvent) => void = () => {};
	let aborted = 0;
	const finish = () =>
		listener({
			type: "tool_execution_end",
			toolCallId: "finished",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Submitted" }],
				details: { status: "success", data: { fixed: true } },
			},
			isError: false,
		} as AgentSessionEvent);
	const answer = (text = "Answer to ask-camera [scope]: Use existing oracle") => {
		messages.push({ role: "user", content: text, timestamp: Date.now() });
		finish();
	};
	const session = {
		...createSessionDefaults(),
		messages,
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
			getHeader: () => null,
			appendCustomEntry: (type: string, data: unknown) => entries.push({ type, data }),
		},
		getActiveToolNames: () => ["ask", "yield"],
		getEnabledToolNames: () => ["ask", "yield"],
		subscribe: (fn: (event: AgentSessionEvent) => void) => {
			listener = fn;
			return () => {};
		},
		prompt: async (text: string) => {
			prompts.push(text);
			if (prompts.length === 1) {
				messages.push({
					role: "toolResult",
					toolName: "ask",
					toolCallId: "ask-camera",
					timestamp: Date.now(),
					content: [{ type: "text", text: "Awaiting lead answer" }],
					isError: false,
					details: {
						pending: {
							id: "ask-camera",
							questions: [
								{
									id: "scope",
									question: "May I use existing oracle?",
									options: [{ label: "Use existing oracle" }],
									recommended: 0,
								},
							],
						},
					},
				});
				const pending = messages.at(-1)!;
				listener({
					type: "tool_execution_end",
					toolCallId: "ask-camera",
					toolName: "ask",
					result: {
						content: pending.content,
						details: pending.role === "toolResult" ? pending.details : undefined,
					},
					isError: false,
				} as AgentSessionEvent);
				asked.resolve();
				await turnStopped.promise;
			} else if (text.startsWith("Answer to ask-camera")) answer(text);
			return true;
		},
		abort: async () => {
			aborted++;
			turnStopped.resolve();
		},
	} as unknown as AgentSession;
	vi.spyOn(sdk, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	});
	const controller = new AbortController();
	const result = runSubprocess({
		cwd: "/tmp",
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task,
		index: 0,
		id: "worker-ask-regression",
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		settings: Settings.isolated({ "task.maxRuntimeMs": maxRuntimeMs }),
		signal: controller.signal,
	});
	return { result, asked: asked.promise, answer, finish, prompts, entries, controller, abortCalls: () => aborted };
}

test("unanswered worker ask survives runtime deadline and resumes the same assignment after lead answer", async () => {
	const h = harness("Fix camera", 500);
	await h.asked;
	await Bun.sleep(1100);
	expect(h.abortCalls()).toBe(1);
	expect(h.prompts).toEqual(["Fix camera"]);
	h.answer();
	const result = await h.result;
	expect(result.aborted).toBe(false);
	expect(result.exitCode).toBe(0);
});

test("explicit caller cancellation still stops a worker parked on an ask", async () => {
	const h = harness();
	await h.asked;
	h.controller.abort();
	const result = await h.result;
	expect(result.aborted).toBe(true);
	expect(h.abortCalls()).toBeGreaterThan(0);
});

test("authorized brief applies the stated default after bounded wait and records the decision", async () => {
	vi.spyOn(questions, "workerAskDefaultWaitMs").mockReturnValue(30);
	const h = harness("Fix camera [worker-ask-defaults]");
	const result = await h.result;
	expect(result.aborted).toBe(false);
	expect(h.prompts).toContain("Answer to ask-camera [scope]: Use existing oracle");
	expect(h.entries.some(e => e.type === "worker-ask-default-applied")).toBe(true);
});

test("recommended option alone never authorizes a worker default", async () => {
	vi.spyOn(questions, "workerAskDefaultWaitMs").mockReturnValue(30);
	const h = harness();
	await h.asked;
	await Bun.sleep(350);
	expect(h.prompts).toEqual(["Fix camera"]);
	expect(h.entries.some(e => e.type === "worker-ask-default-applied")).toBe(false);
	h.answer();
	expect((await h.result).aborted).toBe(false);
});

test("late terminal yield cannot terminate an assignment with an unanswered worker ask", async () => {
	const h = harness();
	let settled = false;
	void h.result.then(() => {
		settled = true;
	});
	await h.asked;
	h.finish();
	await Bun.sleep(350);
	expect(settled).toBe(false);
	expect(h.prompts).toEqual(["Fix camera"]);
	h.answer();
	expect((await h.result).aborted).toBe(false);
});
