import { expect, it } from "bun:test";
import type { AgentSessionEvent } from "../../src/session/agent-session";
import {
	createLocalInteractiveSessionConnection,
	type InteractiveSessionConnection,
} from "../../src/modes/interactive-session";

it("reattaches a view without restarting its outstanding turn or replaying input", async () => {
	const finished = Promise.withResolvers<boolean>();
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const inputs: string[] = [];
	let prompts = 0;
	let aborts = 0;
	const state = { isStreaming: false, isCompacting: false, hasPostPromptWork: false };
	const runtime: Omit<
		InteractiveSessionConnection,
		"waitForSettled" | "saveDraft" | "consumeDraft" | "disposeSession" | "checkpoint" | "beginDispose"
	> & {
		sessionManager: {
			saveDraft(text: string): Promise<void>;
			consumeDraft(): Promise<string | null>;
			close(): Promise<void>;
			seal(): void;
		};
		beginDispose(): void;
		dispose(): Promise<void>;
		waitForIdle(): Promise<void>;
		settleAsyncWork(): Promise<void>;
	} = {
		sessionManager: {
			saveDraft: async () => {},
			consumeDraft: async () => null,
			close: async () => {},
			seal: () => {},
		},
		beginDispose: () => {},
		dispose: async () => {},
		queuedMessageCount: 0,
		hasPendingAsyncWork: () => false,
		waitForIdle: async () => {},
		settleAsyncWork: async () => {},
		get isStreaming() {
			return state.isStreaming;
		},
		get isCompacting() {
			return state.isCompacting;
		},
		get hasPostPromptWork() {
			return state.hasPostPromptWork;
		},
		prompt(text, options) {
			// Access through `this` catches adapters which detach prototype methods.
			expect(this).toBe(runtime);
			state.isStreaming = true;
			prompts++;
			inputs.push(text);
			expect(options).toEqual({ streamingBehavior: "steer" });
			return finished.promise;
		},
		async abort() {
			aborts++;
			expect(this).toBe(runtime);
			state.isStreaming = false;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const firstView = createLocalInteractiveSessionConnection(runtime);
	const firstEvents: AgentSessionEvent[] = [];
	const detach = firstView.subscribe(event => firstEvents.push(event));
	const pendingTurn = firstView.prompt("дописанный ответ 🐈", { streamingBehavior: "steer" });
	expect(firstView.isStreaming).toBe(true);
	detach();
	detach();
	const secondView = createLocalInteractiveSessionConnection(runtime);
	const secondEvents: AgentSessionEvent[] = [];
	const detachSecond = secondView.subscribe(event => secondEvents.push(event));
	expect(secondView.isStreaming).toBe(true);
	state.isCompacting = true;
	state.hasPostPromptWork = true;
	expect(secondView.isCompacting).toBe(true);
	expect(secondView.hasPostPromptWork).toBe(true);
	const event: AgentSessionEvent = { type: "agent_end", messages: [] };
	for (const listener of listeners) listener(event);
	state.isStreaming = false;
	finished.resolve(true);
	expect(await pendingTurn).toBe(true);
	expect(secondView.isStreaming).toBe(false);
	expect(firstEvents).toEqual([]);
	expect(secondEvents).toEqual([event]);
	expect(inputs).toEqual(["дописанный ответ 🐈"]);
	expect(prompts).toBe(1);
	expect(aborts).toBe(0);
	await secondView.abort({ reason: "user interrupt" });
	expect(aborts).toBe(1);
	detachSecond();
	expect(listeners.size).toBe(0);
});
