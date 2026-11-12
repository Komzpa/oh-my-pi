import type { AgentDefinition } from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
//
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"wait",
	"grep",
	"glob",
	"find",
	"web_search",
	"ast_grep",
	"yield",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyToolNames(tools: readonly string[] | undefined): boolean {
	return !!tools?.length && tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return isReadOnlyToolNames(agent.tools);
}

/** Roles whose contract forbids checkout mutation, even if an old definition lists bash. */
export function isReadOnlyWorkerRole(name: string): boolean {
	return ["qa-auditor", "explore", "scout", "reviewer", "security-reviewer"].includes(name);
}

/** A worker dispatched read-only keeps its shell, so its tool list alone no longer proves read-only. */
export function isReadOnlyDispatch(agent: AgentDefinition): boolean {
	return agent.readOnly === true || isReadOnlyAgent(agent);
}

/** Preserve the role's capabilities; read-only dispatch removes direct mutation and delegation. */
export function readOnlyWorkerTools(tools: readonly string[]): string[] {
	return tools.filter(tool => !["edit", "write", "ast_edit", "task"].includes(tool));
}
