import { untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { PromptOptions } from "../../session/agent-session-types";
import type { InteractiveSessionConnection } from "../interactive-session";
import type { RpcAskDialogRequest, RpcAskDialogView, RpcClient } from "./rpc-client";
import type { RpcSessionState } from "./rpc-types";

/** A view lease on an RPC owner. Disconnecting a view never stops its runtime. */
export interface RpcInteractiveSessionConnection extends InteractiveSessionConnection {
	refresh(): Promise<void>;
	attachAskDialogView(listener: (request: RpcAskDialogRequest) => void): RpcAskDialogView;
	disconnect(): void;
}

/** The caller owns the started RpcClient and its process lifetime. */
export async function createRpcInteractiveSessionConnection(
	client: RpcClient,
): Promise<RpcInteractiveSessionConnection> {
	let state: Pick<
		RpcSessionState,
		"isStreaming" | "isCompacting" | "hasPostPromptWork" | "queuedMessageCount" | "hasPendingAsyncWork"
	> = {
		isStreaming: false,
		isCompacting: false,
		hasPostPromptWork: false,
		queuedMessageCount: 0,
		hasPendingAsyncWork: false,
	};
	let disconnected = false;
	const lifetime = new AbortController();
	let revision = 0;
	let refreshing: Promise<void> | undefined;
	const askViews = new Set<RpcAskDialogView>();
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const assertConnected = (): void => {
		if (disconnected) throw new Error("Interactive session view is disconnected");
	};
	let refreshAgain = false;
	const refresh = (): Promise<void> => {
		assertConnected();
		if (refreshing) {
			refreshAgain = true;
			return refreshing;
		}
		const observed = revision;
		refreshing = client
			.getState()
			.then(snapshot => {
				// Lifecycle events newer than the request win over its old snapshot.
				if (!disconnected && observed === revision) state = snapshot;
			})
			.finally(() => {
				refreshing = undefined;
				if (refreshAgain && !disconnected) {
					refreshAgain = false;
					void refresh().catch(() => disconnect());
				}
			});
		return refreshing;
	};
	const unsubscribe = client.onSessionEvent(event => {
		let activityChanged = true;
		switch (event.type) {
			case "agent_start":
				state.isStreaming = true;
				break;
			case "agent_end":
				state.isStreaming = false;
				break;
			case "queue_update":
				break;
			case "auto_compaction_start":
				state.isCompacting = true;
				break;
			case "auto_compaction_end":
				state.isCompacting = false;
				break;
			default:
				activityChanged = false;
		}
		if (activityChanged) {
			revision++;
			void refresh().catch(() => disconnect());
		}
		// Never put a state round trip between a token and its frontend.
		for (const listener of listeners) listener(event);
	});
	const unsubscribeResult = client.onPromptResult(() => {
		void refresh().catch(() => disconnect());
	});
	const unsubscribeSettled = client.onSessionSettled(() => {
		revision++;
		state = {
			...state,
			isStreaming: false,
			hasPendingAsyncWork: false,
			hasPostPromptWork: false,
			queuedMessageCount: 0,
		};
		void refresh().catch(() => disconnect());
	});
	const disconnect = (): void => {
		if (disconnected) return;
		disconnected = true;
		lifetime.abort(new Error("Interactive session view is disconnected"));
		listeners.clear();
		for (const view of askViews) view.disconnect();
		askViews.clear();
		unsubscribe();
		unsubscribeResult();
		unsubscribeSettled();
	};
	try {
		await refresh();
	} catch (error) {
		disconnect();
		throw error;
	}
	return {
		beginDispose() {
			assertConnected();
			return client.beginDispose();
		},
		disposeSession(options) {
			assertConnected();
			return client.disposeSession(options);
		},
		checkpoint() {
			assertConnected();
			return client.checkpointSession();
		},
		saveDraft(text) {
			assertConnected();
			return client.saveDraft(text);
		},
		consumeDraft() {
			assertConnected();
			return client.consumeDraft();
		},
		refresh,
		disconnect,
		attachAskDialogView(listener) {
			assertConnected();
			const lease = client.attachAskDialogView(listener);
			const view: RpcAskDialogView = {
				respond: response => lease.respond(response),
				disconnect: () => {
					lease.disconnect();
					askViews.delete(view);
				},
			};
			askViews.add(view);
			return view;
		},
		get isStreaming() {
			return state.isStreaming;
		},
		get isCompacting() {
			return state.isCompacting;
		},
		get queuedMessageCount() {
			return state.queuedMessageCount ?? 0;
		},
		hasPendingAsyncWork() {
			return state.hasPendingAsyncWork === true;
		},
		async waitForSettled(signal) {
			assertConnected();
			const cancellation = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
			await client.waitForSettled(0, cancellation);
			cancellation.throwIfAborted();
			await untilAborted(cancellation, refresh);
		},
		get hasPostPromptWork() {
			return state.hasPostPromptWork === true;
		},
		prompt(text: string, options?: PromptOptions) {
			assertConnected();
			return client.promptWithResult(text, options);
		},
		abort(options) {
			assertConnected();
			return client.abort(options);
		},
		subscribe(listener) {
			assertConnected();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
