import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Tool-command state of the session whose eval bridge started the current async chain. */
const evalBridgeCall = new AsyncLocalStorage<object>();

/**
 * Carry the bridge origin through nested dispatch without marking concurrent direct calls.
 * Keyed by the bridging session's tool-command state so sessions started inside the call (in-process
 * subagents) keep their own tool-command dispatch.
 */
export function withEvalBridgeToolCall<T>(origin: object | undefined, run: () => T): T {
	return origin ? evalBridgeCall.run(origin, run) : run();
}

export function isEvalBridgeToolCall(origin: object): boolean {
	return evalBridgeCall.getStore() === origin;
}

/**
 * Checkpoint/rewind need direct toolResult events to commit session changes;
 * yield needs direct loop events to finalize the delegated task.
 */
export function isEvalBridgeToolCallable(tool: Pick<AgentTool, "name">, args?: unknown): boolean {
	if (tool.name === "checkpoint" || tool.name === "rewind" || tool.name === "yield") return false;
	if (tool.name !== "task" || !isRecord(args)) return true;
	// Audit admission/intake needs direct agent-loop events, including owner-bound
	// qa-auditor calls without explicit IDs and inherited batched task agents.
	const audit = (value: Record<string, unknown>): boolean =>
		(typeof value.agent === "string" && value.agent.trim() === "qa-auditor") ||
		(Array.isArray(value.requirementIds) && value.requirementIds.length > 0);
	return !audit(args) && !(Array.isArray(args.tasks) && args.tasks.some(item => isRecord(item) && audit(item)));
}
