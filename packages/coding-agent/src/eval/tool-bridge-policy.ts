import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";

/** These tools need direct toolResult events to commit their session changes. */
export function isEvalBridgeToolCallable(tool: Pick<AgentTool, "name">, args?: unknown): boolean {
	if (tool.name === "checkpoint" || tool.name === "rewind") return false;
	if (tool.name !== "task" || !isRecord(args)) return true;
	// Audit admission/intake needs direct agent-loop events, including owner-bound
	// qa-auditor calls without explicit IDs and inherited batched task agents.
	const audit = (value: Record<string, unknown>): boolean =>
		(typeof value.agent === "string" && value.agent.trim() === "qa-auditor") ||
		(Array.isArray(value.requirementIds) && value.requirementIds.length > 0);
	return !audit(args) && !(Array.isArray(args.tasks) && args.tasks.some(item => isRecord(item) && audit(item)));
}
