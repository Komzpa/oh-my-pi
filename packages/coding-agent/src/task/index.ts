import { stripOmpCollisionSuffixChain } from "./id-collision";
import { findTodoExecutorTarget } from "../tools/todo-executor";
import { todoInfraBreaker, todoWorkAttempts, todoAttemptIsInfra } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import infraBreakerTemplate from "../prompts/tools/task-infra-breaker.md" with { type: "text" };
import { formatSpawnRefusal } from "./spawn-refusal";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import { isTaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { taskSubprocessRenderer } from "@oh-my-pi/pi-tui/tools/subprocess";
// The journal and bus identify one lifecycle owner across primary/advisor tool rebuilds.
const lifecycleOwners = new WeakMap<object, WeakMap<object, Set<TaskTool>>>();

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import {
	discardPreparedTaskWorkspace,
	prepareTaskWorkspace,
	validateTaskWorkspace,
	type VerifiedTaskWorkspace,
} from "./workspace";
import { Snowflake } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolSpeculationPolicy,
} from "@oh-my-pi/pi-agent-core";
import type { TextContent, Usage } from "@oh-my-pi/pi-ai";
import { $env, isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { Settings } from "../config/settings";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskAsyncContractTemplate from "../prompts/tools/task-async-contract.md" with { type: "text" };
import taskCoordinationAdvisoryTemplate from "../prompts/tools/task-coordination-advisory.md" with { type: "text" };
import taskSpawnFeedbackTemplate from "../prompts/tools/task-spawn-feedback.md" with { type: "text" };
import taskSpecializationAdvisoryTemplate from "../prompts/tools/task-specialization-advisory.md" with { type: "text" };
import taskFollowUpTemplate from "../prompts/tools/task-follow-up.md" with { type: "text" };
import { TASK_EFFORTS, type TaskEffort } from "@oh-my-pi/pi-tui/thinking";
import { type Effort } from "@oh-my-pi/pi-catalog/effort";
import { truncateForPrompt } from "../tools/approval";
import { hasWaitTool } from "../tools/wait";
import { isIrcEnabled } from "../irc/messaging";
import { isReadOnlyAgent, isReadOnlyDispatch, isReadOnlyWorkerRole } from "./read-only-policy";
import { resolveAgentModelSelection } from "../config/model-resolver";
import { formatTaskResultSummary } from "./result-summary";
import { isScoutSpawnable, type ResolvedSpawnPolicy, resolveSpawnPolicy } from "./spawn-policy";
import { isBundledSeance, seanceTaskGuidance, seanceTaskSchemaFields, validateSeanceParams } from "./seance";
import { SEANCE_AGENT_NAME } from "./seance-policy";
import { type AgentDefinition, canSpawnAtDepth, getTaskSchema, type TaskToolSchemaInstance } from "./types";
import type { AgentProgress, SingleResult, TaskItem, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { isFailedTaskSingleResult } from "./result-summary";
import { AsyncJobError, type AsyncJobManagerApi } from "../async";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON } from "../async/job-manager";
import { hasResolvableTranscript } from "../internal-urls/registry-helpers";
import { AgentRegistry, isResumable } from "../registry/agent-registry";
import { type DiscoveryResult, discoverAgents } from "./discovery";
import {
	createEvalCustomTools,
	describeEvalTools,
	evalToolsEnabled,
	isBuiltinToolAvailable,
	stripBuiltinToolNames,
} from "./eval-tools";
import { getPerCallModelAdvertisement, type PerCallModelAdvertisement } from "./model-approval";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "./parallel";
import { renderStepsBrief } from "./steps";
import { renderResult, renderCall as renderTaskCall } from "@oh-my-pi/pi-tui/tools/task";
import { repairTaskParams } from "@oh-my-pi/pi-tui/tools/task-repair-args";
import { isInfraFailure, nextUntriedVendorModel } from "./redispatch-vendor";
import { captureReworkReflection, renderPreviousAttempts, type ReworkReflectionResult } from "./rework-reflection";
import {
	invalidModelSelectorReason,
	normalizeModelSelector,
	openIsolatedWorkspace,
	renderSubagentUserPrompt,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentResult,
	type EffectiveSubagentPolicy,
	type StructuredSubagentRequest,
} from "./structured-subagent";
import { SpawnRun, type SpawnPermit } from "./spawn-run";
import { type TaskLauncher, TaskLaunchSession } from "./speculative-launch";
import type { TextTap } from "../job-widgets/text-tap";
import type { SubagentToolResult } from "./executor";
import { appendToolResult, createTaskWidgetInputs } from "./widget-inputs";
import {
	applyOpsToPhases,
	buildTodoExecutorPersistedEdit,
	buildTodoOpPersistedEdit,
	buildTodoReworkAttemptPersistedEdit,
} from "../tools/todo";
import {
	applyTodoExecutorObservation,
	validateTodoExecutorRow,
	appendTodoReworkAttempt,
	findRespawnOwnerRows,
	type TodoExecutorObservation,
} from "../tools/todo-executor";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "./types";
import type { TodoReworkAttempt, TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";

import { cfgAsyncEnabled } from "../tools/settings";
import {
	cfgTaskAgentModelOverrides,
	cfgTaskBatch,
	cfgTaskPeerAwareness,
	cfgTaskDisabledAgents,
	cfgTaskEnableEffort,
	cfgTaskEnableLsp,
	cfgTaskIsolationApply,
	cfgTaskIsolationEnabled,
	cfgTaskMaxConcurrency,
	cfgTaskMaxRecursionDepth,
	cfgTaskMaxRuntimeMs,
	cfgTaskSpeculativeLaunch,
	cfgTaskSteps,
	cfgTaskStructured,
	cfgTaskAgentsMd,
	perCallModelEnabled,
} from "./settings";

interface TodoRowReservation {
	id: string;
	phase: string;
	content: string;
	owner?: string;
	previous?: TodoSchedule;
	started: boolean;
}

// Rebuilt TaskTools share the same journal owner, including concurrent task calls.
const todoRowReservations = new WeakMap<object, Map<string, TodoRowReservation>>();

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Built-in tool names stripped from a spawn item before eval validation, keyed by item. */
const strippedBuiltinTools = new WeakMap<object, string[]>();

/** Built-ins removed from streamed spawn params, retained for speculative validation. */
const speculativeBuiltinTools = new WeakMap<object, string[]>();

function appendTaskNotices(
	result: AgentToolResult<TaskToolDetails>,
	notices: readonly string[],
): AgentToolResult<TaskToolDetails> {
	if (notices.length === 0) return result;
	const noticeText = notices.join("\n");
	let appended = false;
	const content = result.content.map(part => {
		if (!appended && part.type === "text" && typeof part.text === "string") {
			appended = true;
			return { ...part, text: `${part.text}\n\n${noticeText}` };
		}
		return part;
	});
	if (!appended) content.push({ type: "text", text: noticeText });
	return { ...result, content };
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export * from "./read-only-policy";
export type { AgentDefinition, SubagentEventPayload, SubagentLifecyclePayload, SubagentProgressPayload } from "./types";
export type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
export * from "./result-summary";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

interface TaskDescriptionOptions {
	peerAwareness?: boolean;
	agents: AgentDefinition[];
	isolationEnabled: boolean;
	applyIsolatedChanges: boolean;
	disabledAgents: string[];
	batchEnabled: boolean;
	effortEnabled: boolean;
	perCallModelEnabled: boolean;
	perCallModelAdvertisement?: PerCallModelAdvertisement;
	evalToolsEnabled: boolean;
	structured: boolean;
	catalogOnly?: boolean;
	steps: boolean;
	asyncEnabled: boolean;
	ircEnabled: boolean;
	planMode: boolean;
	asyncGuidance: string;
	parentSpawns: string;
	agentsMd: "strip" | "project";
}

/** Plan mode hides seance; a `spawns` list led by it defaults to the next permitted agent. */
function defaultAgentFor(spawnPolicy: ResolvedSpawnPolicy, planMode: boolean): string {
	if (!planMode || spawnPolicy.defaultAgent !== SEANCE_AGENT_NAME) return spawnPolicy.defaultAgent;
	return spawnPolicy.allowedAgents?.find(agent => agent !== SEANCE_AGENT_NAME) ?? spawnPolicy.defaultAgent;
}

/** Render the tool description from a cached agent list and current settings. */
function renderDescription(options: TaskDescriptionOptions): string {
	const spawnPolicy = resolveSpawnPolicy(options.parentSpawns);
	const spawningDisabled = !spawnPolicy.enabled;
	const agents = options.agents;
	let filteredAgents =
		options.disabledAgents.length > 0 ? agents.filter(agent => !options.disabledAgents.includes(agent.name)) : agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (spawnPolicy.allowedAgents !== null) {
		const allowed = new Set(spawnPolicy.allowedAgents);
		filteredAgents = filteredAgents.filter(agent => allowed.has(agent.name));
	}
	if (options.planMode) {
		filteredAgents = filteredAgents.filter(agent => !isBundledSeance(agent));
	}
	const renderedAgents = (options.catalogOnly ? filteredAgents : []).map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
		blocking: agent.blocking === true,
		projectAgentsMd: (agent.agentsMd ?? options.agentsMd) === "project",
		// Marked only while `task.structured` is off; with it on, every agent's result is structured.
		structured: !options.structured && agent.structured === true,
	}));
	const seanceAgent = filteredAgents.find(agent => agent.name === SEANCE_AGENT_NAME);
	const scoutAvailable = isScoutSpawnable(options.disabledAgents, options.parentSpawns);
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		peerAwareness: options.peerAwareness,
		scoutAvailable,
		spawningDisabled: options.catalogOnly === true && spawningDisabled,
		defaultAgent: defaultAgentFor(spawnPolicy, options.planMode),
		isolationEnabled: options.isolationEnabled,
		applyIsolatedChanges: options.applyIsolatedChanges,
		batchEnabled: options.batchEnabled,
		effortEnabled: options.effortEnabled,
		perCallModelEnabled: options.perCallModelEnabled,
		perCallModelAdvertisement: options.perCallModelAdvertisement,
		evalToolsEnabled: options.evalToolsEnabled,
		structured: options.structured,
		steps: options.steps,
		asyncEnabled: options.asyncEnabled,
		hasBlockingAgents: true,
		hasStructuredAgents: true,
		hasModelMentions: true,
		seanceGuidance: options.catalogOnly && seanceAgent && isBundledSeance(seanceAgent) ? seanceTaskGuidance : "",
		catalogOnly: options.catalogOnly,
		ircEnabled: options.ircEnabled,
		projectAgentsMd: options.agentsMd === "project",
		asyncGuidance: options.asyncGuidance,
	});
}
function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		isError: true,
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Reject legacy fields and shape/configuration combinations the current tool
 * cannot accept. `outputSchema` is a first-class per-spawn field; stale
 * `schema` remains an eval-only alias and is rejected.
 */
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if (Object.hasOwn(params, "schema")) {
		return "The task tool uses `outputSchema`; rename the stale `schema` field.";
	}
	if (batchEnabled && params.tasks !== undefined && Object.hasOwn(params, "agent")) {
		return "Top-level `agent` is not part of the batch shape. Set `tasks[].agent` instead.";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the task tool does not accept ${disallowed.map(f => `\`${f}\``).join(" or ")}. Spawn one agent per call with \`task\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the model-facing shape is `{ context, tasks[] }` with one task
 * source (`task` or `steps`) per item and unique names, a non-empty
 * `context`, and no top-level `task` or `steps` alongside. An empty `tasks`
 * array with valid `context` represents no work. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */

/** Reject an out-of-range `effort` selector on internal/stale-transcript calls that bypass the wire schema. */
function validateEffort(effort: TaskEffort | undefined, label: string): string | undefined {
	if (effort === undefined || TASK_EFFORTS.includes(effort)) return undefined;
	return `${label} has an invalid \`effort\` value ${JSON.stringify(effort)}. Use "lo", "med", or "hi".`;
}
/** Reject a malformed `resources` declaration on internal/stale-transcript calls that bypass the wire schema. `[]` is valid (owns nothing); entries must be non-blank strings. */
function validateResources(resources: TaskItem["resources"], label: string): string | undefined {
	if (resources === undefined) return undefined;
	if (!Array.isArray(resources))
		return `${label} has an invalid \`resources\` value ${JSON.stringify(resources)}. Provide an array of checkout path strings, or omit it.`;
	for (const entry of resources) {
		if (typeof entry !== "string" || entry.trim() === "") {
			return `${label} has an invalid \`resources\` entry ${JSON.stringify(entry)}. Every entry must be a non-blank checkout path string.`;
		}
	}
	return undefined;
}

/** Reject a non-array `tools`, or non-string entries, on calls that bypass the wire schema (lenient validation). */
function validateTools(tools: unknown, label: string): string | undefined {
	if (tools === undefined) return undefined;
	if (Array.isArray(tools) && tools.every(name => typeof name === "string")) return undefined;
	return `${label} has an invalid \`tools\` value. Use an array of tool-name strings.`;
}

/**
 * Check a spawn's work: a non-empty `task`, or non-empty `steps`. The wire schema
 * advertises only the one `task.steps` selects, which names the missing field;
 * internal callers and stale transcripts may send either.
 */
function validateTaskInput(item: TaskItem | undefined, label: string, stepsEnabled: boolean): string | undefined {
	if (item?.task !== undefined && item.steps !== undefined) {
		return `${label} takes \`task\` or \`steps\`, not both.`;
	}
	if (item?.steps !== undefined) {
		const { steps } = item;
		const valid =
			Array.isArray(steps) &&
			steps.length > 0 &&
			steps.every(step => typeof step === "string" && step.trim() !== "");
		return valid
			? undefined
			: `${label} has invalid \`steps\`: provide a non-empty list of non-empty instructions, one per stage.`;
	}
	if (typeof item?.task === "string" && item.task.trim() !== "") return undefined;
	if (stepsEnabled && item?.task === undefined) {
		return label === "The call"
			? "Missing `steps`. Provide the agent's ordered stages, one instruction each."
			: `${label} is missing \`steps\`. Every task needs its ordered stages, one instruction each.`;
	}
	return label === "The call"
		? "Missing `task`. Provide complete, self-contained instructions for the agent."
		: `${label} is missing \`task\`. Every task needs complete, self-contained instructions.`;
}

function validateSpawnParams(
	params: TaskParams,
	batchEnabled: boolean,
	stepsEnabled: boolean,
	defaultAgent: string,
	settings: Settings,
): string | undefined {
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks)) {
			return `Missing \`tasks\`. Provide at least one task item with \`${stepsEnabled ? "steps" : "task"}\`.`;
		}
		if (params.task !== undefined || params.steps !== undefined) {
			return "Top-level `task` or `steps` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			const label = `Task ${i + 1}${item?.name ? ` (\`${item.name}\`)` : ""}`;
			const inputError = validateTaskInput(item, label, stepsEnabled);
			if (inputError) return inputError;
			const resourcesError = validateResources(item.resources, label);
			if (resourcesError) return resourcesError;
			const effortError = validateEffort(item.effort, label);
			if (effortError) return effortError;
			const modelError = validateModel(item, label, defaultAgent, settings);
			if (modelError) return modelError;
			const toolsError = validateTools(item.tools, label);
			if (toolsError) return toolsError;
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const name = item.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `Duplicate task name ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}. Provided names must be unique within a call (case-insensitive).`;
			}
			seen.set(key, name);
		}
		if (tasks.length === 0 && (typeof params.context !== "string" || params.context.trim() === "")) {
			return "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`.";
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		return undefined;
	}
	if (batchEnabled && params.task === undefined && params.steps === undefined) {
		return "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`.";
	}
	const callInputError = validateTaskInput(params, "The call", stepsEnabled);
	if (callInputError === undefined) {
		const callResourcesError = validateResources(params.resources, "The call");
		if (callResourcesError && validateEffort(params.effort, "The call") === undefined) return callResourcesError;
	}
	return (
		callInputError ??
		validateEffort(params.effort, "The call") ??
		validateTools(params.tools, "The call") ??
		validateModel(params, "The call", defaultAgent, settings)
	);
}

/**
 * A `model` on a call naming `seance` is checked at preflight, once the name resolves:
 * the bundled seance takes it as its source-session override, a shadowing agent as a per-call model.
 */
function validateModel(
	item: TaskItem | TaskParams,
	label: string,
	defaultAgent: string,
	settings: Settings,
): string | undefined {
	return (item.agent?.trim() || defaultAgent) === SEANCE_AGENT_NAME
		? undefined
		: invalidModelSelectorReason(item.model, label, { settings, invocationKind: "task" });
}

/** Models fill optional selectors with "" / [] / null; treat those as absent instead of refusing the spawn. */
const EMPTY_OPTIONAL_TASK_FIELDS = ["model", "sourceSession"] as const;
function dropEmptyOptionalTaskFields(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	const strip = (value: Record<string, unknown>): Record<string, unknown> => {
		let out = value;
		for (const key of EMPTY_OPTIONAL_TASK_FIELDS) {
			const field = value[key];
			const empty =
				field === null ||
				(typeof field === "string" && field.trim().length === 0) ||
				(Array.isArray(field) && field.length === 0);
			if (key in value && empty) {
				if (out === value) out = { ...value };
				delete out[key];
			}
		}
		return out;
	};
	const top = strip(raw);
	if (!Array.isArray(top.tasks)) return top;
	const tasks = top.tasks.map(item => (isRecord(item) ? strip(item) : item));
	return tasks.some((item, index) => item !== (top.tasks as unknown[])[index]) ? { ...top, tasks } : top;
}

function spawnModelFields(params: TaskParams): Pick<StructuredSubagentRequest, "perCallModel" | "seanceModel"> {
	if (params.model === undefined) return {};
	if (params.agent === SEANCE_AGENT_NAME) return { seanceModel: params.model };
	// `validateModel` rejected anything but one string before dispatch.
	return typeof params.model === "string" ? { perCallModel: params.model } : {};
}

/**
 * Normalize a validated, non-empty call into its spawn list: the `tasks[]`
 * batch when provided, otherwise the single top-level spawn. `execute()`
 * returns the no-work result before calling this for an empty batch. The flat
 * form's `isolated` flag is only materialized when the caller sent one —
 * `#runSpawn` distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		// Copy each item before stripping: pre-execute planning and `execute`
		// resolve separately, and the correction record keys on the stripped
		// item — mutating the caller's `tasks[]` in place would leave the later
		// resolve with nothing to strip and no notice to report.
		return params.tasks.map(source => {
			const item: TaskItem = { ...source };
			stripBuiltinToolNames(item, strippedBuiltinTools);
			return item;
		});
	}
	const item: TaskItem = {
		requirementIds: params.requirementIds,
		name: params.name,
		agent: params.agent,
		task: params.task,
	};
	if (params.steps !== undefined) item.steps = params.steps;
	if (params.workspace !== undefined) item.workspace = params.workspace;
	if (params.reads !== undefined) item.reads = params.reads;
	if ("images" in params) item.images = params.images;
	if ("solutionSpace" in params) item.solutionSpace = params.solutionSpace;
	if ("rework" in params) item.rework = params.rework;
	if ("outputSchema" in params) item.outputSchema = params.outputSchema;
	if ("schemaMode" in params) item.schemaMode = params.schemaMode;
	if ("tools" in params) item.tools = params.tools;
	if ("scope" in params) item.scope = params.scope;
	if ("effort" in params) item.effort = params.effort;
	if ("resources" in params) item.resources = params.resources;
	if ("isolated" in params) item.isolated = params.isolated;
	stripBuiltinToolNames(item, strippedBuiltinTools);
	if ("sourceSession" in params) item.sourceSession = params.sourceSession;
	if ("model" in params) item.model = params.model;
	if ("row" in params) item.row = params.row;
	if ("resources" in params) item.resources = params.resources;
	if ("readOnly" in params) item.readOnly = params.readOnly;
	return [item];
}

// Rebuilt spawn params share only their dispatch item's preparation, never a name across calls.
const spawnPreparationKeys = new WeakMap<object, object>();

function spawnPreparationKey(params: TaskParams): object {
	return spawnPreparationKeys.get(params) ?? params;
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. Each spawn's `agent` resolves here —
 * the item's own value, else `defaultAgent` from the session spawn policy.
 * `tasks` never leaks into a spawn; the shared `context` rides along
 * unchanged. Keys are only materialized when present — `#runSpawn`
 * distinguishes an absent `isolated` from an explicit one. The item's
 * `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	spawnPreparationKeys.set(spawn, item);
	if (item.workspace !== undefined) spawn.workspace = item.workspace;
	if (item.reads !== undefined) spawn.reads = item.reads;
	if (item.requirementIds !== undefined) spawn.requirementIds = item.requirementIds;
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (item.scope !== undefined) spawn.scope = item.scope;
	if (item.steps !== undefined) spawn.steps = item.steps;
	if (item.row !== undefined) spawn.row = item.row;
	if (item.resources !== undefined) spawn.resources = item.resources;
	if (item.readOnly !== undefined) spawn.readOnly = item.readOnly;
	if (item.solutionSpace !== undefined) spawn.solutionSpace = item.solutionSpace;
	if (item.rework !== undefined) spawn.rework = item.rework;
	if (params.context !== undefined) spawn.context = params.context;
	if ("outputSchema" in item) spawn.outputSchema = item.outputSchema;
	if ("schemaMode" in item) spawn.schemaMode = item.schemaMode;
	if ("tools" in item) spawn.tools = item.tools;
	if ("effort" in item) spawn.effort = item.effort;
	// Per-item images win; the flat form's top-level `images` applies to the
	// single spawn. Only materialized when present — image-less calls keep
	// byte-identical args.
	if (item.images !== undefined) spawn.images = item.images;
	else if ("images" in params) spawn.images = params.images;
	if ("sourceSession" in item) spawn.sourceSession = item.sourceSession;
	if ("model" in item) spawn.model = item.model;
	if ("resources" in item) spawn.resources = item.resources;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	return spawn;
}

/** A validated call's spawn list: its items and the per-spawn params each run receives. */
interface SpawnPlan {
	params: TaskParams;
	items: TaskItem[];
	spawns: TaskParams[];
}

/** A present but blank `model` (see {@link normalizeModelSelector}): "use the agent's routing", not a selector. */
function isEmptyModelPlaceholder(model: unknown): boolean {
	return model !== undefined && normalizeModelSelector(model) === undefined;
}

/**
 * Drop empty `model` placeholders from the call and its batch items so they
 * route like an omitted model. Copy-on-write: the submitted arguments are
 * never mutated, and the same reference is returned when nothing changed.
 */
function normalizeTaskModelPlaceholders(params: TaskParams): TaskParams {
	const originalTasks = params.tasks;
	let normalizedTasks: TaskItem[] | undefined;
	if (Array.isArray(originalTasks)) {
		for (let i = 0; i < originalTasks.length; i++) {
			const item = originalTasks[i];
			if (!isRecord(item) || !isEmptyModelPlaceholder(item.model)) continue;
			normalizedTasks ??= originalTasks.slice();
			const copy = { ...item };
			delete copy.model;
			normalizedTasks[i] = copy;
		}
	}
	const emptyRootModel = isEmptyModelPlaceholder(params.model);
	if (!emptyRootModel && !normalizedTasks) return params;
	const copy = { ...params };
	if (emptyRootModel) delete copy.model;
	if (normalizedTasks) copy.tasks = normalizedTasks;
	return copy;
}

/**
 * Repair, validate, and normalize a call into its spawns. Returns the
 * validation error the call reports instead when the shape is rejected. Shared
 * by dispatch and the speculative launcher so both derive identical spawns.
 */
function planSpawns(
	rawParams: unknown,
	batchEnabled: boolean,
	stepsEnabled: boolean,
	defaultAgent: string,
	seanceAdvertised: boolean,
	settings: Settings,
): SpawnPlan | string {
	const params = normalizeTaskModelPlaceholders(repairTaskParams(rawParams as TaskParams));
	const error =
		validateShapeParams(batchEnabled, params) ??
		validateSpawnParams(params, batchEnabled, stepsEnabled, defaultAgent, settings) ??
		validateSeanceParams({ params, batchEnabled, defaultAgent, seanceAdvertised });
	if (error) return error;
	const items = resolveSpawnItems(params);
	return { params, items, spawns: items.map(item => spawnParamsFor(params, item, defaultAgent)) };
}

interface ReworkRoute {
	row: { phase: string; content: string };
	previous: NonNullable<TodoSchedule["executor"]>;
	reason?: string;
	/** Next-vendor model from the agent's own chain; absent means ordinary routing. */
	rung?: { model: string };
	failedLine?: string;
	context?: string;
}

/**
 * One sync-executed spawn: its item, position in the original call, (for mixed
 * calls) a pre-claimed agent id, and a run already started speculatively.
 */
interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	run?: SpawnRun;
	preAllocatedId?: string;
}

/** Merged view of a sync spawn set's payloads: joined text plus flattened results/usage/paths. */
interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
	/** Some spawn returned an error result. */
	isError: boolean;
}

/**
 * Merge per-spawn sync payloads into one result view. `index` is each spawn's
 * position in the original call so batch rows keep stable ordering; a missing
 * payload (cancelled before start) becomes an explanatory content line. An
 * error payload from any spawn makes the merged view an error too, the way a
 * one-spawn call returns that payload as is.
 */
function mergeSyncPayloads(
	spawns: SyncSpawnRef[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let projectAgentsDir: string | null = null;
	let isError = false;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		isError ||= payload.isError === true;
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
		isError,
	};
}

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(
	agentNames: string[],
	depthCapacity: boolean,
	scoutAvailable = true,
): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	return prompt
		.render(taskSpecializationAdvisoryTemplate, {
			count: generics.length,
			agent: generics[0],
			scoutAvailable,
		})
		.trim();
}

/**
 * Non-blocking writer-ownership guidance while multiple siblings run and spawn capacity remains.
 * Ownership applies independently of the peer messaging transport.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	_ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || items.length < 2) return undefined;
	return prompt.render(taskCoordinationAdvisoryTemplate, { count: items.length }).trim();
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
export function composeSpawnAdvisory(args: {
	agents: string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
	scoutAvailable?: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity, args.scoutAvailable),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends AsyncJobError {}

/**
 * Process-level create-time discovery memo and published reload snapshots,
 * keyed by resolved cwd plus the exact effective `extensions` array.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process. Sessions
 * may share a cwd while carrying different overlay/runtime extension settings,
 * so cwd alone is not an isolation boundary. Explicit plugin reloads replace
 * only the matching cwd+extensions snapshot. Execution-time discovery
 * (`#runSpawn`) intentionally stays fresh. The memo also tracks the live
 * `discoverAgents` binding: test spies swap that binding, which invalidates
 * both caches automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
const discoverySnapshots = new Map<string, AgentDefinition[]>();
let discoveryMemoFn: typeof discoverAgents | undefined;

/** Stable cache identity for the filesystem root and the full effective extension-root struct. */
function discoveryCacheKey(cwd: string, extensionRoots?: EffectiveExtensionRoots): string {
	return `${path.resolve(cwd)}\0${JSON.stringify(extensionRoots ?? null)}`;
}

function discoverAgentsForCreate(cwd: string, extensionRoots?: EffectiveExtensionRoots): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
		discoverySnapshots.clear();
	}
	const key = discoveryCacheKey(cwd, extensionRoots);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd, undefined, extensionRoots);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

/** Rescan one cwd and publish its definitions to existing and future task tools. */
export async function refreshAgentDiscovery(cwd: string, extensionRoots?: EffectiveExtensionRoots): Promise<void> {
	const key = discoveryCacheKey(cwd, extensionRoots);
	discoveryMemo.delete(key);
	const pending = discoverAgentsForCreate(cwd, extensionRoots);
	const { agents } = await pending;
	if (discoveryMemo.get(key) === pending) {
		discoverySnapshots.set(key, agents);
	}
}

/**
 * A spawn's `assignment`, labelling and displaying the run: its `task`, or every step as one brief.
 * The task text keeps its whitespace; only policy resolution compares a trimmed copy.
 */
function spawnAssignment(item: TaskItem): string {
	return item.steps ? renderStepsBrief(item.steps) : (item.task ?? "");
}

/** Approval lines for a spawn's `steps`, numbered as the child receives them; none without steps. */
function formatApprovalSteps(steps: unknown): string[] {
	if (!Array.isArray(steps)) return [];
	return steps.flatMap((step, index) =>
		typeof step === "string" ? [`Step ${index + 1}:\n${truncateForPrompt(step)}`] : [],
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/** Owner key from a checkout-lock refusal ("Refusing <agent>: <writer> worker <key> is running in this checkout"). */
export function checkoutLockOwnerFromTaskError(text: string): string | undefined {
	return text.match(/Refusing \S+: \S+ worker (.+?) is running in this checkout/i)?.[1]?.trim() || undefined;
}
/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns one subagent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs; when
 * disabled, the tool blocks until every spawn finishes.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		if (typeof params.name === "string" && params.name.trim()) {
			lines.push(`Name: ${truncateForPrompt(params.name)}`);
		}
		if (typeof params.model === "string") {
			lines.push(`Model: ${truncateForPrompt(params.model)}`);
		}
		if (typeof params.task === "string") {
			lines.push(`Task:\n${truncateForPrompt(params.task)}`);
		}
		lines.push(...formatApprovalSteps(params.steps));
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\n${truncateForPrompt(params.context)}`);
		}
		const tasks: unknown[] = Array.isArray(params.tasks) ? params.tasks : [];
		if (tasks.length > 0) {
			const defaultAgent = this.#defaultAgent();
			const effectiveAgent = (item: unknown): string => {
				if (item && typeof item === "object" && "agent" in item) {
					const agent = item.agent;
					if (typeof agent === "string" && agent.trim()) return agent.trim();
				}
				return defaultAgent;
			};
			const agentCounts = new Map<string, number>();
			for (const item of tasks) {
				const agent = effectiveAgent(item);
				agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
			}
			const agentSummary = [...agentCounts].map(([agent, count]) => `${agent} ×${count}`).join(", ");
			lines.push(`Batch agents: ${truncateForPrompt(agentSummary)}`);

			const firstTask = tasks[0];
			if (firstTask && typeof firstTask === "object") {
				if ("name" in firstTask && typeof firstTask.name === "string" && firstTask.name.trim()) {
					lines.push(`Name: ${truncateForPrompt(firstTask.name)}`);
				}
				lines.push(`Agent: ${truncateForPrompt(effectiveAgent(firstTask))}`);
				if ("task" in firstTask && typeof firstTask.task === "string") {
					lines.push(`Task:\n${truncateForPrompt(firstTask.task)}`);
				}
				if (isRecord(firstTask)) lines.push(...formatApprovalSteps(firstTask.steps));
			}
			for (const [index, item] of tasks.entries()) {
				if (isRecord(item) && typeof item.model === "string") {
					lines.push(`Task ${index + 1} model: ${truncateForPrompt(item.model)}`);
				}
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn subagents to complete delegated tasks";
	readonly strict = false;
	readonly loadMode = "essential";
	// Arktype validates model calls against the active wire schema, but the flat
	// single-spawn schema carries `"+": "delete"`: a batch `{ context, tasks[] }`
	// payload has those keys stripped, then can fail on a missing flat-form field.
	// That preempts the tool's own actionable shape checks (`validateShapeParams` /
	// `validateSpawnParams`), which never run. Lenient validation forwards the
	// raw args to `execute()` on any arktype failure so those checks surface the
	// real reason ("enable task.batch, or use the flat `task` shape"). Valid
	// calls still normalize through arktype; `execute()` resolves `agent`
	// defaults independently, so the success path is unchanged.
	readonly lenientArgValidation = true;
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	/**
	 * One semaphore per TaskTool instance (i.e. per session): bounds concurrent
	 * subagents across parallel `task` calls within the session. Resized in
	 * place from `task.maxConcurrency` before every acquire/release so a
	 * mid-session settings change (UI toggle, `/settings`) applies to both new
	 * spawns and work already parked in the semaphore queue.
	 */
	#spawnSemaphore: Semaphore | undefined;
	/** Whether a spawn result already carried the job-lifecycle reference. */
	#lifecycleShown = false;
	readonly #permit: SpawnPermit = {
		acquire: signal => this.#getSpawnSemaphore().acquire(signal),
		release: () => this.#releaseSpawnSemaphore(),
	};
	/** Streamed calls' speculative launches, keyed by tool-call id until dispatch adopts or discards them. */
	readonly #launchSessions = new Map<string, TaskLaunchSession>();
	readonly #launcher: TaskLauncher = {
		spawns: args => {
			const plan = planSpawns(
				args,
				this.#isBatchEnabled(),
				cfgTaskSteps.get(this.session.settings),
				this.#defaultAgent(),
				this.#seanceSchemaFields() !== undefined,
				this.session.settings,
			);
			if (typeof plan === "string") return undefined;
			return plan.spawns.map((spawn, index) => {
				const builtins = strippedBuiltinTools.get(plan.items[index]!);
				if (builtins) speculativeBuiltinTools.set(spawn, builtins);
				return spawn;
			});
		},
		start: (toolCallId, spawn, index, signal) => this.#startSpeculative(toolCallId, spawn, index, signal),
	};

	/**
	 * Batch calls start each subagent as soon as its `tasks[]` item streams in;
	 * see `./speculative-launch` for the abort/adoption contract.
	 */
	readonly speculation: ToolSpeculationPolicy = {
		stream: {
			open: async context => {
				if (!cfgTaskSpeculativeLaunch.get(this.session.settings) || !this.#isBatchEnabled()) return undefined;
				if (!context.coordinator.authorizeLaunch) return undefined;
				const id = context.parentToolCallId;
				const session = new TaskLaunchSession({
					sink: context.coordinator,
					tool: this,
					launcher: this.#launcher,
					onClose: () => {
						if (this.#launchSessions.get(id) === session) this.#launchSessions.delete(id);
					},
				});
				this.#launchSessions.set(id, session);
				return session;
			},
		},
	};

	readonly #restartWorkers = new Set<string>();
	readonly #resourceWaits = new Map<string, string>();

	#setResourceWait(params: TaskParams, holder?: { row: string; workerId?: string }): void {
		const target = this.#spawnRow(params);
		const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.();
		if (!target || !phases || JSON.stringify(target.task.schedule?.resourceWait) === JSON.stringify(holder)) return;
		const updated = phases.map(phase => ({
			...phase,
			tasks: phase.tasks.map(task =>
				task === target.task ? { ...task, schedule: { ...task.schedule, resourceWait: holder } } : task,
			),
		}));
		this.session.setTodoPhases?.(updated);
		this.session.persistTodoPhases?.(updated);
	}

	readonly #todoExecutors = new Map<string, TodoExecutorObservation>();
	readonly #reworkRoutes = new Map<string, ReworkRoute>();
	readonly #workerSessions = new Map<string, StructuredSubagentResult>();
	readonly #preparedWorkspaces = new WeakMap<object, VerifiedTaskWorkspace>();
	readonly #spawnWorkspaces = new Map<string, VerifiedTaskWorkspace>();
	readonly #reflectingWorkers = new Set<string>();

	#spawnRow(params: TaskParams) {
		const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.() ?? [];
		const task = findTodoExecutorTarget(phases, {
			workerId: params.name ?? "",
			row: params.row,
			taskText: params.task,
			startedAt: 0,
		});
		const phase = phases.find(phase => phase.tasks.includes(task!));
		return task && phase ? { phase: phase.name, task } : undefined;
	}

	#rowReservations(): Map<string, TodoRowReservation> {
		const owner = this.session.sessionManager ?? this.session;
		let reservations = todoRowReservations.get(owner);
		if (!reservations) todoRowReservations.set(owner, (reservations = new Map()));
		return reservations;
	}

	#reserveRow(params: TaskParams, id: string, readOnly: boolean): string | undefined {
		if (readOnly) return;
		const row = this.#spawnRow(params);
		if (!row) return;
		const reservations = this.#rowReservations();
		const key = `${row.phase}\0${row.task.content}`;
		const prior = reservations.get(key);
		if (prior && prior.id !== id)
			return formatSpawnRefusal(`Task row ${JSON.stringify(row.task.content)} is reserved by ${prior.id}.`, id);
		if (prior && row.task.schedule?.owner !== prior.owner)
			return formatSpawnRefusal(`Task row ${JSON.stringify(row.task.content)} was reassigned before execution.`, id);
		// No await between observing and reserving a row, before extension admission can yield.
		if (!prior)
			reservations.set(key, {
				id,
				phase: row.phase,
				content: row.task.content,
				owner: row.task.schedule?.owner,
				previous: row.task.schedule ? structuredClone(row.task.schedule) : undefined,
				started: false,
			});
	}

	#releaseRow(id: string, rollback = false): void {
		for (const [key, reservation] of this.#rowReservations()) {
			if (reservation.id !== id) continue;
			this.#rowReservations().delete(key);
			if (!rollback || reservation.started) continue;
			const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.();
			const row = phases
				?.find(phase => phase.name === reservation.phase)
				?.tasks.find(task => task.content === reservation.content);
			// Undo only our unstarted admission, never a replacement assignment or a recorded attempt.
			if (!row || row.schedule?.owner !== id || row.schedule.executor?.workerId === id) continue;
			const previous = reservation.previous;
			const schedule = {
				...row.schedule,
				owner: previous?.owner,
				ownerReadOnly: previous?.ownerReadOnly,
				resources: previous?.resources,
				resourceWait: previous?.resourceWait,
			};
			const updated = phases!.map(phase => ({
				...phase,
				tasks: phase.tasks.map(task => (task === row ? { ...task, schedule } : task)),
			}));
			this.session.setTodoPhases?.(updated);
			this.session.persistTodoPhases?.(updated);
		}
	}

	#allocateSpawn(params: TaskParams): Promise<string> {
		const row = this.#spawnRow(params)?.task;
		const history = row?.schedule?.attemptHistory ?? [];
		const requested = params.name?.trim() || generateTaskName();
		const agent = this.#discoveredAgents.find(agent => agent.name === params.agent);
		// Audit/read-only invocations are not retries of the row's producer.
		if (
			!history.length ||
			isReadOnlyWorkerRole(params.agent ?? this.#defaultAgent()) ||
			params.readOnly === true ||
			(agent && isReadOnlyDispatch(agent))
		) {
			return this.#outputManager().allocate(requested);
		}
		const base = stripOmpCollisionSuffixChain(history[0]!.workerName.split(".").at(-1) ?? requested);
		return this.#outputManager().allocate(base, history.length + 1);
	}

	#breaker(params: TaskParams): string | undefined {
		const row = this.#spawnRow(params)?.task;
		const cause = row?.status === "blocked" ? todoInfraBreaker(row.schedule?.attemptHistory) : undefined;
		return cause ? prompt.render(infraBreakerTemplate, { row: row!.content, cause }).trim() : undefined;
	}

	#recordRefusal(params: TaskParams, id: string, cause: string): void {
		const row = this.#spawnRow(params);
		if (!row || !this.session.setTodoPhases || !this.session.persistTodoPhases) return;
		const now = Date.now();
		this.#appendAttempt(
			{ phase: row.phase, content: row.task.content },
			{
				attemptId: `admission:${id}:${now}:${row.task.schedule?.attemptHistory?.length ?? 0}`,
				workerName: id,
				resolvedModel: "unresolved",
				effort: "unresolved",
				startedAt: now,
				finishedAt: now,
				durationMs: 0,
				terminalStatus: "failed",
				deliverablePaths: [],
				infraFailureError: cause,
				infraFailureLine: `infra failure: ${cause}`,
			},
		);
	}

	#routeRework(spawn: TaskParams): { route?: ReworkRoute; error?: string } {
		const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.();
		const name = spawn.name?.trim();
		const breaker = this.#breaker(spawn);
		if (breaker) return { error: breaker };
		if (!phases || !name) return {};
		const rows = phases.flatMap(phase =>
			phase.tasks
				.filter(
					task =>
						task.status !== "completed" &&
						task.status !== "abandoned" &&
						(task.schedule?.owner === name || task.schedule?.executor?.workerId === name),
				)
				.map(task => ({ phase: phase.name, task })),
		);
		if (rows.length !== 1) return {};
		const { phase, task } = rows[0]!;
		const previous = task.schedule?.executor;
		const exhaustedBlocked =
			task.status === "blocked" && task.blocker?.startsWith("waits for user: Rework ladder exhausted.");
		if (!previous?.outcome) return {};
		const requestedProfile = spawn.agent ?? previous.agentProfile;
		const history = task.schedule?.attemptHistory ?? [];
		// Vendors already spent on this row: every rejected or model-failed attempt, plus the
		// attempt being re-dispatched. Infrastructure failures say nothing about the model.
		const triedModels = history
			.filter(
				attempt =>
					attempt.terminalStatus === "completed" ||
					(!attempt.interruption && !todoAttemptIsInfra(attempt) && !isInfraFailure(attempt.infraFailureError)),
			)
			.map(attempt => attempt.resolvedModel);
		/** Next-vendor model; undefined = no chain (ordinary routing); null = every vendor tried. */
		const nextVendorModel = (): string | null | undefined => {
			const requestedAgent = [...this.#discoveredAgents, ...(this.session.getSessionAgents?.() ?? [])].find(
				agent => agent.name === requestedProfile,
			);
			const chain = resolveAgentModelSelection({
				agentModel: requestedAgent?.model,
				settingsOverride: requestedProfile
					? cfgTaskAgentModelOverrides.get(this.session.settings)[requestedProfile]
					: undefined,
				settings: this.session.settings,
			}).patterns;
			if (chain.length === 0) return undefined;
			return nextUntriedVendorModel(chain, triedModels) ?? null;
		};
		const exhausted = {
			error: `Blocked: "${task.content}" has no untried model vendor left and will not run again. Call todo with op=append to split it into 2-4 smaller rows, each with its own checkable result, then op=drop on the exhausted row (or make it depend on the new rows), then dispatch the new rows.`,
		};
		if (previous.outcome !== "completed") {
			const failed = history.findLast(attempt => attempt.attemptId === `${previous.workerId}:${previous.startedAt}`);
			const infra =
				failed?.interruption === "restart" ||
				(failed && todoAttemptIsInfra(failed)) ||
				isInfraFailure(failed?.infraFailureError);
			const sameProfile = spawn.agent === undefined || spawn.agent === previous.agentProfile;
			let model: string | null | undefined;
			// No resolved model means the worker failed before any model ran (a missing key, a bad
			// spawn): that says nothing about the model, so the retry routes ordinarily.
			if (!infra && sameProfile && previous.resolvedModel) {
				triedModels.push(previous.resolvedModel);
				model = nextVendorModel();
				if (model === null) return exhausted;
			}
			return {
				route: {
					row: { phase, content: task.content },
					previous,
					rung: model ? { model } : undefined,
					failedLine:
						failed?.infraFailureLine ??
						`attempt ${todoWorkAttempts(history).length + 1} failed: ${previous.outcome}`,
				},
			};
		}
		const reason = spawn.rework;
		if ((reason === undefined || reason.trim().length === 0) && !exhaustedBlocked) return {};
		if (reason === undefined || reason.trim().length === 0 || /[\r\n\u2028\u2029]/u.test(reason))
			return { error: `Rework of "${task.content}" requires a one-line \`rework\` rejection reason.` };
		if (!previous.resolvedModel || !previous.thinkingLevel || previous.finishedAt === undefined) {
			return {
				error: `Cannot rework "${task.content}": the completed worker's resolved model, effort, or finish time is missing.`,
			};
		}
		triedModels.push(previous.resolvedModel);
		const model = nextVendorModel();
		if (exhaustedBlocked || model === null) return exhausted;
		return {
			route: {
				row: { phase, content: task.content },
				previous,
				reason,
				rung: model ? { model } : undefined,
			},
		};
	}

	#appendAttempt(row: ReworkRoute["row"], attempt: TodoReworkAttempt): void {
		const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.();
		if (!phases || !this.session.setTodoPhases || !this.session.persistTodoPhases) {
			throw new Error("Rework requires durable Todo persistence.");
		}
		const priorCause = todoInfraBreaker(
			phases.find(phase => phase.name === row.phase)?.tasks.find(task => task.content === row.content)?.schedule
				?.attemptHistory,
		);
		const updated = appendTodoReworkAttempt(phases, row, attempt);
		if (!updated) {
			const matches = phases.flatMap(phase =>
				phase.name === row.phase ? phase.tasks.filter(task => task.content === row.content) : [],
			);
			if (
				matches.length === 1 &&
				matches[0]!.schedule?.attemptHistory?.some(previous => previous.attemptId === attempt.attemptId)
			)
				return;
			throw new Error(`Cannot persist rework attempt: exact Todo row "${row.content}" is no longer unique.`);
		}
		this.session.setTodoPhases(updated);
		this.session.persistTodoPhases(updated, buildTodoReworkAttemptPersistedEdit(row, attempt));
		const cause = todoInfraBreaker(
			updated.find(phase => phase.name === row.phase)?.tasks.find(task => task.content === row.content)?.schedule
				?.attemptHistory,
		);
		if (cause && !priorCause)
			this.session.steer?.({
				customType: "todo-infra-breaker",
				content: prompt.render(infraBreakerTemplate, { row: row.content, cause }).trim(),
			});
	}

	#recordFailedAttempt(
		result: Pick<
			SingleResult,
			| "id"
			| "exitCode"
			| "error"
			| "aborted"
			| "abortReason"
			| "stderr"
			| "output"
			| "outputPath"
			| "durationMs"
			| "resolvedModelIdentity"
			| "resolvedThinkingLevel"
		>,
		signal?: AbortSignal,
	): void {
		if (!result.aborted && result.exitCode === 0 && !result.error) return;
		const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.();
		if (!phases) return;
		const rows = phases.flatMap(phase =>
			phase.tasks
				.filter(task => task.schedule?.executor?.workerId === result.id)
				.map(task => ({ phase: phase.name, task })),
		);
		if (rows.length !== 1) return;
		const { phase, task } = rows[0]!;
		const previous = task.schedule!.executor!;
		if (signal?.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON) this.#restartWorkers.add(result.id);
		this.#persistTodoExecutor({
			...previous,
			resolvedModel: result.resolvedModelIdentity ?? previous.resolvedModel,
			thinkingLevel: result.resolvedThinkingLevel ?? previous.thinkingLevel,
			finishedAt: previous.finishedAt ?? Date.now(),
			outcome: result.aborted ? "aborted" : "failed",
		});
		const error =
			(result.error ?? result.abortReason ?? result.stderr ?? result.output)
				.replace(/[\r\n\u2028\u2029]+/gu, " ")
				.trim() || "worker failed";
		const attempt: TodoReworkAttempt = {
			attemptId: `${result.id}:${previous.startedAt}`,
			workerName: result.id,
			resolvedModel: result.resolvedModelIdentity ?? previous.resolvedModel ?? "unresolved",
			effort: result.resolvedThinkingLevel ?? previous.thinkingLevel ?? "unresolved",
			startedAt: previous.startedAt,
			finishedAt: previous.finishedAt ?? Date.now(),
			durationMs: result.durationMs,
			terminalStatus: result.aborted ? "aborted" : "failed",
			deliverablePaths: result.outputPath ? [result.outputPath] : [],
			interruption: signal?.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON ? "restart" : undefined,
			infraFailureError: error,
			infraFailureLine: `attempt ${todoWorkAttempts(task.schedule?.attemptHistory).length + 1} failed: ${error}`,
		};
		if (attempt.interruption) attempt.infraFailureLine = "Restart interruption: resume pending";
		else if (todoAttemptIsInfra(attempt)) attempt.infraFailureLine = `infra failure: ${error}`;
		this.#appendAttempt({ phase, content: task.content }, attempt);
	}

	async #restoreWorker(route: ReworkRoute, policy: EffectiveSubagentPolicy): Promise<StructuredSubagentResult> {
		const cached = this.#workerSessions.get(route.previous.workerId);
		if (cached) return cached;
		const ref = AgentRegistry.global().get(route.previous.workerId);
		const artifactsDir = ref?.sessionFile ? path.dirname(ref.sessionFile) : this.session.getArtifactsDir?.();
		if (!artifactsDir)
			throw new Error(`Cannot restore report for ${route.previous.workerId}: artifacts directory is unavailable.`);
		const outputPath = ref?.history?.outputPath ?? path.join(artifactsDir, `${route.previous.workerId}.md`);
		const output = await Bun.file(outputPath).text();
		const restored: StructuredSubagentResult = {
			policy: {
				...policy,
				effectiveAgent: { ...policy.effectiveAgent, name: route.previous.agentProfile ?? policy.agentName },
			},
			artifactsDir,
			temporaryArtifacts: false,
			changesApplied: null,
			mergeSummary: "",
			result: {
				index: 0,
				id: route.previous.workerId,
				agent: route.previous.agentProfile ?? policy.agentName,
				agentSource: policy.agent.source,
				task: route.row.content,
				exitCode: route.previous.outcome === "completed" ? 0 : 1,
				output,
				outputPath,
				stderr: "",
				truncated: false,
				durationMs: Math.max(0, (route.previous.finishedAt ?? route.previous.startedAt) - route.previous.startedAt),
				tokens: 0,
				requests: 0,
				resolvedModelIdentity: route.previous.resolvedModel,
				resolvedThinkingLevel: route.previous.thinkingLevel as Effort,
			},
		};
		this.#workerSessions.set(route.previous.workerId, restored);
		return restored;
	}

	async #prepareRework(
		route: ReworkRoute,
		policy: EffectiveSubagentPolicy,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		if (route.failedLine) {
			route.context = route.failedLine;
			return undefined;
		}
		const previous = await this.#restoreWorker(route, policy);
		// Save the rejected report before reflection can overwrite the same worker artifact.
		const report = previous.result.outputPath
			? await Bun.file(previous.result.outputPath).text()
			: previous.result.output;
		const attemptId = `${route.previous.workerId}:${route.previous.startedAt}`;
		const phasesBefore = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.() ?? [];
		const priorRecord = phasesBefore
			.find(phase => phase.name === route.row.phase)
			?.tasks.find(task => task.content === route.row.content)
			?.schedule?.attemptHistory?.find(attempt => attempt.attemptId === attemptId);
		if (!priorRecord) {
			this.#reflectingWorkers.add(route.previous.workerId);
			let reflection: ReworkReflectionResult;
			try {
				reflection = await captureReworkReflection({
					session: this.session,
					previous,
					reason: route.reason!,
					signal,
				});
			} finally {
				this.#reflectingWorkers.delete(route.previous.workerId);
			}
			if (reflection.resumed) this.#workerSessions.set(route.previous.workerId, reflection.resumed);
			const paths = new Set<string>();
			if (previous.result.outputPath) paths.add(previous.result.outputPath);
			if (previous.result.patchPath) paths.add(previous.result.patchPath);
			for (const deliverable of previous.result.nestedPatchPaths ?? []) paths.add(deliverable);
			const collectPaths = (value: unknown, pathField = false): void => {
				if (typeof value === "string") {
					if (pathField && value.trim()) paths.add(value);
				} else if (Array.isArray(value)) {
					for (const item of value) collectPaths(item, pathField);
				} else if (value && typeof value === "object") {
					for (const [key, item] of Object.entries(value)) collectPaths(item, /(?:paths?|files?)$/iu.test(key));
				}
			};
			collectPaths(previous.result.structuredOutput?.data);
			try {
				collectPaths(JSON.parse(report));
			} catch {
				// Prose reports are inspected below; JSON reports also preserve explicit path fields.
			}
			for (const match of report.matchAll(/`([^`\r\n]+)`/gu)) {
				const candidate = match[1]!;
				if (!/\s/u.test(candidate) && (candidate.includes("/") || /\.[a-z0-9]+$/iu.test(candidate)))
					paths.add(candidate);
			}
			this.#appendAttempt(route.row, {
				attemptId,
				workerName: route.previous.workerId,
				resolvedModel: route.previous.resolvedModel!,
				effort: route.previous.thinkingLevel!,
				startedAt: route.previous.startedAt,
				finishedAt: route.previous.finishedAt!,
				durationMs: Math.max(0, route.previous.finishedAt! - route.previous.startedAt),
				terminalStatus: "completed",
				deliverablePaths: [...paths],
				rejectionReason: route.reason,
				reflectionAnswer: reflection.answer,
				noAnswerReason: reflection.noAnswerReason,
				finalReportParagraph:
					report
						.trimEnd()
						.split(/\n\s*\n/u)
						.at(-1) ?? "",
			});
		}
		const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.() ?? [];
		const task = phases
			.find(phase => phase.name === route.row.phase)
			?.tasks.find(task => task.content === route.row.content);
		route.context = renderPreviousAttempts(task?.schedule?.attemptHistory ?? []);
		return undefined;
	}

	get parameters(): TaskToolSchemaInstance {
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationEnabled = !planMode && cfgTaskIsolationEnabled.get(this.session.settings);
		return getTaskSchema({
			peerAwareness: cfgTaskPeerAwareness.get(this.session.settings),
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: cfgTaskEnableEffort.get(this.session.settings),
			evalToolsEnabled: evalToolsEnabled(this.session),
			structured: this.#isStructured(),
			steps: cfgTaskSteps.get(this.session.settings),
			perCallModel: perCallModelEnabled(this.session.settings, "task"),
			defaultAgent: this.#defaultAgent(),
			seanceFields: this.#seanceSchemaFields(),
		});
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Background-job lifecycle contract; inherited by extension replacements that delegate to Task. */
	get delegationGuidance(): string {
		if (!cfgAsyncEnabled.get(this.session.settings)) return "";
		return prompt.render(taskAsyncContractTemplate, {
			ircEnabled: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			waitTool: hasWaitTool(this.session),
		});
	}

	/** Dynamic description that reflects current task settings. */
	get description(): string {
		return this.#renderDescription();
	}

	/** Project-scoped catalog, excluded from provider-native tool schemas. */
	get projectInstructions(): string {
		return this.#renderDescription(true);
	}

	#renderDescription(catalogOnly = false): string {
		const disabledAgents = cfgTaskDisabledAgents.get(this.session.settings);
		const agents =
			discoverySnapshots.get(discoveryCacheKey(this.session.cwd, this.session.effectiveExtensionRoots?.())) ??
			this.#discoveredAgents;
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationEnabled = cfgTaskIsolationEnabled.get(this.session.settings);
		const perCallModel = perCallModelEnabled(this.session.settings, "task");
		const perCallModelAdvertisement =
			this.session.advertisedPerCallModel?.() ??
			(perCallModel
				? getPerCallModelAdvertisement(
						this.session.settings,
						this.session.getActiveModel?.(),
						this.session.modelRegistry,
					)
				: undefined);
		return renderDescription({
			catalogOnly,
			agents,
			isolationEnabled: !planMode && isolationEnabled,
			applyIsolatedChanges: cfgTaskIsolationApply.get(this.session.settings),
			disabledAgents,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: cfgTaskEnableEffort.get(this.session.settings),
			perCallModelEnabled: perCallModel,
			perCallModelAdvertisement,
			evalToolsEnabled: evalToolsEnabled(this.session),
			structured: this.#isStructured(),
			steps: cfgTaskSteps.get(this.session.settings),
			asyncEnabled: cfgAsyncEnabled.get(this.session.settings),
			peerAwareness: cfgTaskPeerAwareness.get(this.session.settings),
			ircEnabled: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			planMode,
			asyncGuidance: this.delegationGuidance,
			parentSpawns: this.session.getSessionSpawns() ?? "*",
			agentsMd: cfgTaskAgentsMd.get(this.session.settings),
		});
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
		const bus = session.subagentEventBus ?? session.eventBus;
		if (
			bus &&
			!session.seanceSourceArtifactsDir &&
			session.getTodoPhases &&
			session.setTodoPhases &&
			session.persistTodoPhases
		) {
			const owner = session.sessionManager ?? session;
			let buses = lifecycleOwners.get(owner);
			if (!buses) lifecycleOwners.set(owner, (buses = new WeakMap()));
			let subscribers = buses.get(bus);
			if (!subscribers) buses.set(bus, (subscribers = new Set()));
			const existing = subscribers.values().next().value;
			if (existing) {
				this.#todoExecutors = existing.#todoExecutors;
				this.#reflectingWorkers = existing.#reflectingWorkers;
			}
			subscribers.add(this);
			const owners = subscribers;
			const stopLifecycle = bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				if (owners.values().next().value !== this) return;
				if (!data || typeof data !== "object") return;
				const event = data as Partial<SubagentLifecyclePayload>;
				if (typeof event.id !== "string" || typeof event.agent !== "string") return;
				if (this.#reflectingWorkers.has(event.id)) return;
				if (event.followUpTurn) {
					this.session.sessionManager?.appendCustomEntry("task_worker_activity", {
						workerId: event.id,
						status: event.status,
						at: event.at ?? Date.now(),
						taskText: event.taskText,
					});
					return;
				}
				if (event.status === "started") {
					const observed: TodoExecutorObservation = {
						workerId: event.id,
						agentProfile: event.agent,
						description: event.description,
						taskText: event.taskText,
						row: event.row,
						startedAt: event.at ?? Date.now(),
					};
					this.#todoExecutors.set(event.id, observed);
					this.#persistTodoExecutor(observed);
				} else if (event.status === "completed" || event.status === "failed" || event.status === "aborted") {
					const prior = this.#todoExecutors.get(event.id);
					if (!prior) return;
					const observed = {
						...prior,
						resolvedModel: event.resolvedModelIdentity ?? prior.resolvedModel,
						thinkingLevel: event.resolvedThinkingLevel ?? prior.thinkingLevel,
						finishedAt: event.at ?? Date.now(),
						outcome: event.status,
					};
					this.#persistTodoExecutor(observed);
					this.#todoExecutors.delete(event.id);
				}
			});
			const stopProgress = bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				if (owners.values().next().value !== this) return;
				if (!data || typeof data !== "object") return;
				const event = data as Partial<SubagentProgressPayload>;
				if (event.followUpTurn) return;
				const workerId = event.progress?.id;
				if (typeof workerId !== "string") return;
				if (this.#reflectingWorkers.has(workerId)) return;
				const prior = this.#todoExecutors.get(workerId);
				if (!prior) return;
				const observed = {
					...prior,
					resolvedModel:
						event.progress?.resolvedModelIdentity ?? event.progress?.resolvedModel ?? prior.resolvedModel,
					thinkingLevel: event.progress?.resolvedThinkingLevel ?? prior.thinkingLevel,
				};
				this.#todoExecutors.set(workerId, observed);
				this.#persistTodoExecutor(observed);
			});
			session.registerDisposeCallback?.(() => {
				stopLifecycle();
				stopProgress();
				owners.delete(this);
			});
		}
	}

	#persistTodoExecutor(observation: TodoExecutorObservation): void {
		const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.();
		if (!phases) return;
		const currentOwner = findTodoExecutorTarget(phases, observation)?.schedule?.owner;
		const runningWorkerIds = new Set(this.#todoExecutors.keys());
		// A queued attempt losing its assignment must not reclaim it when cancellation settles.
		if (observation.finishedAt !== undefined && currentOwner && currentOwner !== observation.workerId)
			runningWorkerIds.add(currentOwner);
		const updated = applyTodoExecutorObservation(phases, {
			...observation,
			runningWorkerIds,
		});
		if (!updated) return;
		const row = updated.flatMap((phase, phaseIndex) =>
			phase.tasks.filter((task, taskIndex) => task !== phases[phaseIndex]?.tasks[taskIndex]),
		)[0];
		const owner = row?.schedule?.owner;
		this.session.setTodoPhases?.(updated);
		if (observation.finishedAt === undefined)
			for (const reservation of this.#rowReservations().values())
				if (reservation.id === observation.workerId) reservation.owner = owner;
		this.session.persistTodoPhases?.(
			updated,
			buildTodoExecutorPersistedEdit({
				...observation,
				// Preserve the same resolved assignment during journal replay.
				row: row?.content ?? observation.row,
				runningWorkerIds: owner && runningWorkerIds.has(owner) ? new Set([owner]) : undefined,
			}),
		);
	}

	/**
	 * Hand open rows owned by a settled worker to its respawn. Re-staffing a row under its owner's
	 * name gets `<name>-<n>` from the output manager; the row moves in the same tool call so the
	 * caller never sees an owner that names a finished job. Returns the note for the tool result.
	 */
	#relinkRespawnOwners(
		spawns: ReadonlyArray<{ requestedName: string; workerId: string }>,
		manager: AsyncJobManagerApi,
	): string | undefined {
		const phases = this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.();
		if (!phases || !this.session.setTodoPhases || !this.session.persistTodoPhases) return undefined;
		const running = new Set([...this.#todoExecutors.keys(), ...manager.getRunningJobs().map(job => job.id)]);
		const notes: string[] = [];
		let current = [...phases];
		for (const { requestedName, workerId } of spawns) {
			if (!requestedName) continue;
			// The new worker's own job is already registered as running; only the requested id counts.
			running.delete(workerId);
			const rows = findRespawnOwnerRows(current, { requestedName, workerId, runningWorkerIds: running });
			running.add(workerId);
			if (rows.length === 0) continue;
			const params = { op: "schedule" as const, updates: rows.map(task => ({ task, owner: workerId })) };
			const applied = applyOpsToPhases(current, [params]);
			if (applied.errors.length > 0) continue;
			current = applied.phases;
			this.session.setTodoPhases(current);
			this.session.persistTodoPhases(current, buildTodoOpPersistedEdit("schedule", params));
			const rowList = rows.map(row => `"${row}"`).join(", ");
			notes.push(
				`\`${requestedName}\` already names an earlier job, so this worker is \`${workerId}\`; TODO ${rows.length === 1 ? "row" : "rows"} ${rowList} now ${rows.length === 1 ? "names" : "name"} \`${workerId}\` as owner.`,
			);
		}
		return notes.length > 0 ? notes.join("\n") : undefined;
	}

	#isBatchEnabled(): boolean {
		return cfgTaskBatch.get(this.session.settings);
	}

	#isStructured(): boolean {
		return cfgTaskStructured.get(this.session.settings);
	}

	/**
	 * Result contract for a spawn: with `task.structured` the caller's
	 * `outputSchema`/`schemaMode` pass through; without it the child gets no
	 * schema or `yield` tool and returns its final message, unless its agent
	 * declares `structured: true` (resolved in the shared subagent policy).
	 */
	#resultParams(params: TaskParams): Pick<StructuredSubagentRequest, "outputSchema" | "schemaMode" | "structured"> {
		if (!this.#isStructured()) return { structured: false };
		return {
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
		};
	}

	/**
	 * Thinking override for a spawn. `task.enableEffort` gates the caller's
	 * `effort` at runtime, not only in the advertised schema: stale transcripts
	 * and lenient argument fallbacks still deliver the field, and honoring it
	 * would override the agent's configured thinking selector.
	 */
	#effortParams(params: TaskParams): Pick<StructuredSubagentRequest, "effort"> {
		if (params.effort === undefined || !cfgTaskEnableEffort.get(this.session.settings)) return {};
		return { effort: params.effort };
	}

	#seanceSchemaFields() {
		const spawnPolicy = resolveSpawnPolicy(this.session.getSessionSpawns());
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const disabledAgents = cfgTaskDisabledAgents.get(this.session.settings);
		if (
			planMode ||
			!spawnPolicy.enabled ||
			disabledAgents.includes(SEANCE_AGENT_NAME) ||
			(spawnPolicy.allowedAgents !== null && !spawnPolicy.allowedAgents.includes(SEANCE_AGENT_NAME))
		) {
			return undefined;
		}
		const agents =
			discoverySnapshots.get(discoveryCacheKey(this.session.cwd, this.session.effectiveExtensionRoots?.())) ??
			this.#discoveredAgents;
		const sessionAgents = this.session.advertisedSessionAgents?.() ?? this.session.getSessionAgents?.() ?? [];
		const seanceAgent = [...agents, ...sessionAgents].find(agent => agent.name === SEANCE_AGENT_NAME);
		return seanceAgent && isBundledSeance(seanceAgent) ? seanceTaskSchemaFields : undefined;
	}

	#defaultAgent(): string {
		return defaultAgentFor(
			resolveSpawnPolicy(this.session.getSessionSpawns()),
			this.session.getPlanModeState?.()?.enabled === true,
		);
	}

	/** Session-retained id allocator; async ids are claimed before job registration. */
	#outputManager(): AgentOutputManager {
		let manager = this.session.agentOutputManager;
		if (!manager) {
			manager = new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			this.session.agentOutputManager = manager;
		}
		return manager;
	}

	/** Start one spawn's subagent run behind the session semaphore. */
	#launch(spawn: {
		toolCallId: string;
		params: TaskParams;
		index: number;
		agentId?: string;
		detached: boolean;
	}): SpawnRun {
		const launched = new SpawnRun(
			{
				acquire: async (signal, onResourceWait) => {
					const id = spawn.agentId;
					const releaseUnstarted = () => {
						if (!id || ![...this.#rowReservations().values()].some(row => row.id === id && !row.started)) return;
						if (this.#resourceWaits.delete(id)) this.#setResourceWait(spawn.params);
						this.#releaseRow(id, true);
					};
					signal.addEventListener("abort", releaseUnstarted, { once: true });
					try {
						if (id) await onResourceWait?.(this.#resourceWaits.get(id));
						while (true) {
							while (id && this.#resourceWaits.has(id)) {
								signal.throwIfAborted();
								await Bun.sleep(100);
								signal.throwIfAborted();
								const refusal = await this.#admitSpawn(spawn.params, id, signal);
								await onResourceWait?.(this.#resourceWaits.get(id));
								if (refusal) throw new Error(refusal);
							}
							await this.#permit.acquire(signal);
							try {
								signal.throwIfAborted();
								// Capacity waits do not preserve row existence, assignment or resource admission.
								const refusal = id ? await this.#admitSpawn(spawn.params, id, signal) : undefined;
								if (refusal) throw new Error(refusal);
								if (!id || !this.#resourceWaits.has(id)) break;
							} catch (error) {
								this.#permit.release();
								throw error;
							}
							this.#permit.release();
						}
					} finally {
						signal.removeEventListener("abort", releaseUnstarted);
						if (id && this.#resourceWaits.delete(id)) {
							this.#setResourceWait(spawn.params);
							await onResourceWait?.(undefined);
						}
					}
				},
				release: () => this.#permit.release(),
			},
			run => {
				for (const reservation of this.#rowReservations().values())
					if (reservation.id === spawn.agentId) reservation.started = true;
				return this.#runSpawn(
					spawn.toolCallId,
					spawn.params,
					run.signal,
					run.onUpdate,
					spawn.agentId,
					spawn.index,
					spawn.detached,
					run.timing,
					spawn.detached ? run.onArtifactsRetained : undefined,
					run.tools,
				);
			},
			{ agentId: spawn.agentId, detached: spawn.detached },
		);
		void launched.result.then(
			() => {
				if (spawn.agentId) this.#releaseRow(spawn.agentId);
			},
			() => {
				if (spawn.agentId) this.#releaseRow(spawn.agentId, true);
			},
		);
		return launched;
	}

	/**
	 * Start a streamed item's run ahead of dispatch. Preflight and execution
	 * mode mirror dispatch exactly; refuses (undefined) whenever dispatch would
	 * reject the item, so a refusal halts further speculation for the call.
	 */
	async #startSpeculative(
		toolCallId: string,
		spawn: TaskParams,
		index: number,
		signal: AbortSignal,
	): Promise<SpawnRun | undefined> {
		if (spawn.workspace !== undefined || spawn.reads !== undefined || spawn.isolated === true) return undefined;
		if (spawn.tools?.length && this.session.getPlanModeState?.()?.enabled === true) return undefined;
		let policy;
		try {
			policy = await this.#resolveSpawnPreflight(spawn);
		} catch {
			return undefined;
		}
		// A built-in the chosen agent lacks is re-added as an eval tool at dispatch, so the running
		// speculative child (launched with the stripped list) would be rejected on adopt. Refuse it.
		if (
			(speculativeBuiltinTools.get(spawn) ?? []).some(
				name => !isBuiltinToolAvailable(name, policy.effectiveAgent, this.session),
			)
		) {
			return undefined;
		}
		const evalToolNames = spawn.tools ?? [];
		if (evalToolNames.length > 0) {
			if (this.session.getPlanModeState?.()?.enabled === true) return undefined;
			try {
				await describeEvalTools(this.session, evalToolNames, signal);
			} catch {
				return undefined;
			}
		}
		const blocking = policy.effectiveAgent.blocking === true;
		const detached =
			cfgAsyncEnabled.get(this.session.settings) && this.session.asyncJobManager !== undefined && !blocking;
		const agentId = await this.#allocateSpawn(spawn);
		if (signal.aborted || (await this.#admitSpawn(spawn, agentId, signal))) {
			this.#releaseRow(agentId, true);
			return undefined;
		}
		return this.#launch({ toolCallId, params: spawn, index, agentId, detached });
	}

	/** The same capacity gate is used by crash recovery and ordinary task calls. */
	get recoveryPermit(): SpawnPermit {
		return this.#permit;
	}

	#getSpawnSemaphore(): Semaphore {
		const max = cfgTaskMaxConcurrency.get(this.session.settings);
		if (this.#spawnSemaphore) {
			this.#spawnSemaphore.resize(max);
		} else {
			this.#spawnSemaphore = new Semaphore(max);
		}
		return this.#spawnSemaphore;
	}

	#releaseSpawnSemaphore(): void {
		this.#getSpawnSemaphore().release();
	}

	/**
	 * Resolve the shared policy before detached work exists. The resulting
	 * policy intentionally stays local: executor dispatch resolves again from
	 * normalized task params rather than smuggling internal policy over the
	 * task wire contract.
	 */
	async #resolveSpawnPreflight(params: TaskParams) {
		const key = spawnPreparationKey(params);
		let workspace = this.#preparedWorkspaces.get(key);
		if (!workspace) {
			workspace = await prepareTaskWorkspace({
				...params,
				resources:
					params.resources ?? (params.workspace ? undefined : this.#spawnRow(params)?.task.schedule?.resources),
				cwd: this.session.cwd,
				id: `workspace-${Snowflake.next()}`,
				openWorkspace: openIsolatedWorkspace(this.session.settings),
			});
			this.#preparedWorkspaces.set(key, workspace);
		}
		try {
			await validateTaskWorkspace(workspace);
			if (params.row !== undefined) {
				const error = validateTodoExecutorRow(
					this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.() ?? [],
					params.row,
				);
				if (error) throw new Error(error);
			}
			return await resolveEffectiveSubagentPolicy({
				session: this.session,
				invocationKind: "task",
				assignment: spawnAssignment(params).trim(),
				row: params.row,
				readOnly: params.readOnly,
				context: this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined,
				agent: params.agent,
				sourceSession: params.sourceSession,
				...spawnModelFields(params),
				...this.#resultParams(params),
				...this.#effortParams(params),
				...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
				blockedAgent: this.#blockedAgent,
				enableLsp: (this.session.enableLsp ?? true) && cfgTaskEnableLsp.get(this.session.settings),
				enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
				maxRuntimeMs: cfgTaskMaxRuntimeMs.get(this.session.settings),
			});
		} catch (error) {
			this.#preparedWorkspaces.delete(key);
			try {
				await discardPreparedTaskWorkspace(workspace);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`Workspace preflight failed: ${String(error)}; cleanup failed: ${String(cleanupError)}`,
				);
			}
			throw error;
		}
	}

	async #admitSpawn(params: TaskParams, id: string, signal?: AbortSignal): Promise<string | undefined> {
		const breaker = this.#breaker(params);
		if (breaker) return breaker;
		try {
			const policy = await this.#resolveSpawnPreflight(params);
			const verifiedWorkspace = this.#preparedWorkspaces.get(spawnPreparationKey(params))!;
			this.#spawnWorkspaces.set(id, verifiedWorkspace);
			if (isReadOnlyDispatch(policy.effectiveAgent)) verifiedWorkspace.resources = [];
			signal?.throwIfAborted();
			if (policy.preparedSession !== undefined) return;
			const reserved = this.#reserveRow(params, id, isReadOnlyDispatch(policy.effectiveAgent));
			if (reserved) return reserved;
			const result = await this.session.emitBeforeSubagentSpawn?.(
				{
					type: "before_subagent_spawn",
					phase: "admission",
					row: params.row,
					resources: params.resources,
					workspace: params.workspace,
					verifiedWorkspace,
					reads: verifiedWorkspace.reads,
					cwd: verifiedWorkspace.cwd,
					readOnly: isReadOnlyDispatch(policy.effectiveAgent),
					agent: policy.agentName,
					invocationKind: "task",
					modelRole: policy.modelRole,
					patterns: policy.modelOverride ?? [],
					spawnKey: id,
					isolated: params.workspace !== undefined ? false : params.isolated === true,
					assignment: params.steps ? spawnAssignment(params) : params.task,
					context: this.#isBatchEnabled() ? params.context : undefined,
				},
				signal,
			);
			signal?.throwIfAborted();
			if (params.row !== undefined) {
				const invalid = validateTodoExecutorRow(
					this.session.getTodoSnapshot?.() ?? this.session.getTodoPhases?.() ?? [],
					params.row,
				);
				if (invalid) throw new Error(invalid);
			}
			for (const reservation of this.#rowReservations().values()) {
				if (reservation.id !== id) continue;
				const owner = this.#spawnRow(params)?.task.schedule?.owner;
				if (owner !== reservation.owner && owner !== id) {
					this.#releaseRow(id, true);
					return formatSpawnRefusal(
						`Task row ${JSON.stringify(reservation.content)} was reassigned during admission.`,
						id,
					);
				}
				reservation.owner = owner;
			}
			if (result?.resourceWait) {
				this.#resourceWaits.set(
					id,
					`Waiting for row ${result.resourceWait.row} (worker ${result.resourceWait.workerId ?? "unassigned"})`,
				);
				this.#setResourceWait(params, result.resourceWait);
				return;
			}
			this.#resourceWaits.delete(id);
			this.#setResourceWait(params);
			if (result?.block) {
				await discardPreparedTaskWorkspace(verifiedWorkspace);
				this.#preparedWorkspaces.delete(spawnPreparationKey(params));
				this.#releaseRow(id, true);
				const cause = result.reason ?? "Subagent spawn blocked by extension.";
				this.#recordRefusal(params, id, cause);
				return this.#breaker(params) ?? formatSpawnRefusal(cause, id);
			}
		} catch (error) {
			this.#releaseRow(id, true);
			const prepared = this.#spawnWorkspaces.get(id);
			if (prepared) await discardPreparedTaskWorkspace(prepared);
			this.#preparedWorkspaces.delete(spawnPreparationKey(params));
			const cause = error instanceof Error ? error.message : String(error);
			this.#recordRefusal(params, id, cause);
			return this.#breaker(params) ?? formatSpawnRefusal(cause, id);
		}
	}

	/** Agents a TaskTool for `session` offers at construction; memoized per cwd and extension roots. */
	static async discoverAgents(session: ToolSession): Promise<AgentDefinition[]> {
		return (await discoverAgentsForCreate(session.cwd, session.effectiveExtensionRoots?.())).agents;
	}

	/** Create a TaskTool synchronously from agents found by {@link TaskTool.discoverAgents}. */
	static withAgents(session: ToolSession, agents: AgentDefinition[]): TaskTool {
		return new TaskTool(session, agents);
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		return new TaskTool(session, await TaskTool.discoverAgents(session));
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const launchSession = this.#launchSessions.get(toolCallId);
		this.#launchSessions.delete(toolCallId);
		try {
			return await this.#dispatch(toolCallId, rawParams, launchSession, signal, onUpdate);
		} finally {
			// No-op once dispatch adopted; otherwise nothing launched early may outlive the call.
			launchSession?.discard("task call settled without adopting speculative launches");
		}
	}

	/** Internal callers can await an ordinary worker while their own hook stays detached. */
	async executeBlocking(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#dispatch(toolCallId, rawParams, undefined, signal, onUpdate, true);
	}

	async #dispatch(
		toolCallId: string,
		rawParams: unknown,
		launchSession: TaskLaunchSession | undefined,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		waitForCompletion = false,
	): Promise<AgentToolResult<TaskToolDetails>> {
		// Schema defaults fill `agent` for model calls, but internal callers
		// and stale transcripts can bypass arktype. `spawnParamsFor` resolves each
		// item's agent type against the session's actual default agent.
		const defaultAgent = this.#defaultAgent();
		const batchEnabled = this.#isBatchEnabled();
		const plan = planSpawns(
			dropEmptyOptionalTaskFields(rawParams),
			batchEnabled,
			cfgTaskSteps.get(this.session.settings),
			defaultAgent,
			this.#seanceSchemaFields() !== undefined,
			this.session.settings,
		);
		if (typeof plan === "string") {
			return createTaskModeError(plan);
		}
		const { params } = plan;

		if (batchEnabled && Array.isArray(params.tasks) && params.tasks.length === 0) {
			return {
				content: [{ type: "text", text: "No tasks selected; nothing to dispatch." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const spawnItems = plan.items;
		const normalizedSpawnParams = spawnItems.map(item => spawnParamsFor(params, item, defaultAgent));

		const routes = normalizedSpawnParams.map(spawn => this.#routeRework(spawn));
		for (const [index, decision] of routes.entries()) {
			if (decision.error) return createTaskModeError(decision.error);
			if (decision.route) this.#reworkRoutes.set(`${toolCallId}:${index}`, decision.route);
		}
		const evalToolNames = spawnItems.flatMap(item => item.tools ?? []);
		if (evalToolNames.length > 0) {
			if (this.session.getPlanModeState?.()?.enabled === true) {
				return createTaskModeError("Task execution failed: Eval-defined tools are unavailable in plan mode.");
			}
			try {
				await describeEvalTools(this.session, evalToolNames, signal);
			} catch (error) {
				return createTaskModeError(
					`Task execution failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const resolvedAgents = normalizedSpawnParams.map(spawn => spawn.agent ?? defaultAgent);
		// Resolve every item before choosing an execution path. No executor or
		// job manager may observe a batch unless every effective policy is valid.
		const preflights = await Promise.all(
			normalizedSpawnParams.map(async spawn => {
				try {
					return { policy: await this.#resolveSpawnPreflight(spawn) };
				} catch (error) {
					return { error: error instanceof StructuredSubagentError ? error.message : String(error) };
				}
			}),
		);
		const preflightFailures = preflights
			.map((preflight, index) => ("error" in preflight ? { index, error: preflight.error } : undefined))
			.filter((failure): failure is { index: number; error: string } => failure !== undefined);
		if (preflightFailures.length > 0) {
			for (const failure of preflightFailures)
				this.#recordRefusal(
					normalizedSpawnParams[failure.index]!,
					spawnItems[failure.index]!.name ?? "preflight",
					failure.error,
				);
			if (!batchEnabled) {
				return createTaskModeError(`Task execution failed: ${preflightFailures[0]!.error}`);
			}
		}
		const policies = preflights.map(preflight => preflight.policy);
		try {
			for (const [index, policy] of policies.entries()) {
				if (!policy) continue;
				const route = this.#reworkRoutes.get(`${toolCallId}:${index}`);
				if (!route) continue;
				const blocked = await this.#prepareRework(route, policy, signal);
				if (blocked) return createTaskModeError(blocked);
			}
		} catch (error) {
			return createTaskModeError(
				`Rework preparation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const itemBlocking = policies.map(policy => policy?.effectiveAgent.blocking === true);
		const toolNotices: string[] = [];
		const unavailableBuiltins: string[] = [];
		spawnItems.forEach((item, index) => {
			const policy = policies[index]!;
			if (!policy) return;
			for (const name of strippedBuiltinTools.get(item) ?? []) {
				if (isBuiltinToolAvailable(name, policy.effectiveAgent, this.session)) {
					toolNotices.push(
						`Note: \`${name}\` is a built-in tool provided by agent \`${policy.agentName}\`; it was removed from \`tools\`, which accepts eval-defined tools only.`,
					);
				} else {
					unavailableBuiltins.push(name);
					item.tools = [...(item.tools ?? []), name];
					const spawn = normalizedSpawnParams[index]!;
					spawn.tools = [...(spawn.tools ?? []), name];
				}
			}
		});
		if (unavailableBuiltins.length > 0) {
			try {
				await describeEvalTools(this.session, unavailableBuiltins, signal);
			} catch (error) {
				return appendTaskNotices(
					createTaskModeError(`Task execution failed: ${error instanceof Error ? error.message : String(error)}`),
					toolNotices,
				);
			}
		}
		if (this.session.getPlanModeState?.()?.enabled === true && unavailableBuiltins.length > 0) {
			return appendTaskNotices(
				createTaskModeError("Task execution failed: Eval-defined tools are unavailable in plan mode."),
				toolNotices,
			);
		}

		// Execution mode is per item: an item whose agent type declares
		// `blocking: true` runs inline on this turn (the parent waits on its
		// result); every other item becomes a background job when async
		// execution is available.
		const asyncEnabled = cfgAsyncEnabled.get(this.session.settings) && !waitForCompletion;
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		const asyncItems = manager ? spawnItems.filter((_, index) => !itemBlocking[index]) : [];
		// Runs started while the call streamed. An item runs detached iff it
		// becomes a background job here; a run launched under the other mode
		// (settings flipped mid-stream) cannot be re-homed and starts over.
		const adopted = launchSession ? await launchSession.adopt(normalizedSpawnParams) : new Map<number, SpawnRun>();
		for (const [index, run] of adopted) {
			if (run.identity.detached === (manager !== undefined && !itemBlocking[index])) continue;
			run.discard("task execution mode changed after speculative launch");
			adopted.delete(index);
		}
		const admittedIds = new Map<number, string>();
		const refused: string[] = [];
		for (const index of spawnItems.keys()) {
			const failure = preflightFailures.find(failure => failure.index === index);
			if (failure) {
				refused.push(`Task ${spawnItems[index]!.name?.trim() || `#${index + 1}`} refused: ${failure.error}`);
				continue;
			}
			const run = adopted.get(index);
			const id = run?.identity.agentId ?? (await this.#allocateSpawn(normalizedSpawnParams[index]!));
			const refusal = run ? undefined : await this.#admitSpawn(normalizedSpawnParams[index]!, id, signal);
			if (refusal) refused.push(refusal);
			else admittedIds.set(index, id);
		}
		const refusalContent = refused.map(text => ({ type: "text" as const, text, harnessNotice: true as const }));
		if (admittedIds.size === 0)
			return {
				content: refusalContent,
				harnessNotice: refused.join("\n"),
				isError: true,
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};

		const depthCapacity = canSpawnAtDepth(
			cfgTaskMaxRecursionDepth.get(this.session.settings),
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);

		if (!manager || asyncItems.length === 0) {
			// Sync fallback: async execution disabled, orphaned host that never
			// wired a job manager, or every item's agent type declares
			// `blocking: true`.
			if (asyncEnabled && !this.session.asyncJobManager) {
				logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
			}
			const advisory = this.session.suppressSpawnAdvisory
				? undefined
				: composeSpawnAdvisory({
						agents: resolvedAgents.filter((_, index) => admittedIds.has(index)),
						items: asyncItems,
						depthCapacity,
						ircEnabled,
						willRunAsync: false,
						scoutAvailable: isScoutSpawnable(
							cfgTaskDisabledAgents.get(this.session.settings),
							this.session.getSessionSpawns?.() ?? "*",
						),
					});
			const result = await this.#executeSyncFanout(
				toolCallId,
				params,
				spawnItems
					.map((item, index) => ({ item, index, run: adopted.get(index), preAllocatedId: admittedIds.get(index) }))
					.filter(spawn => admittedIds.has(spawn.index)),
				refusalContent,
				defaultAgent,
				signal,
				onUpdate,
			);
			if (!advisory) return appendTaskNotices(result, toolNotices);
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return appendTaskNotices({ ...result, content }, toolNotices);
		}

		// Coordination only makes sense for spawns that keep running after this
		// call returns (the async subset). Blocking items have already completed
		// by then, so a "coordinate while they run" hint would misfire.

		// Returns a fresh result (copied content array, copied text part) rather
		// than mutating the caller's — task results are short-lived here, but an
		// in-place edit on a shared/cached AgentToolResult would be a hidden trap.
		// oxlint-disable-next-line prefer-const -- read by withAdvisory, assigned once spawns are registered
		let respawnNote: string | undefined;
		const withAdvisory = (result: AgentToolResult<TaskToolDetails>): AgentToolResult<TaskToolDetails> => {
			const note = [respawnNote, advisory].filter(Boolean).join("\n\n");
			if (!note) return { ...result, content: [...refusalContent, ...result.content] };
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${note}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: note });
			return { ...result, content: [...refusalContent, ...content] };
		};
		const callStartedAt = Date.now();
		const spawns: Array<{
			agentId: string;
			item: TaskItem;
			index: number;
			blocking: boolean;
			run: SpawnRun | undefined;
			progress: AgentProgress;
		}> = [];
		for (const [index, item] of spawnItems.entries()) {
			const agentType = resolvedAgents[index]!;
			const policy = policies[index]!;
			if (!policy) continue;
			const agentSource = policy.agent.source;
			const run = adopted.get(index);
			const agentId = admittedIds.get(index);
			if (!agentId) continue;
			const assignment = spawnAssignment(item);
			spawns.push({
				agentId,
				item,
				index,
				blocking: itemBlocking[index],
				run,
				progress: {
					index,
					id: agentId,
					agent: agentType,
					agentSource,
					modelRole: policy.modelRole,
					status: "pending",
					stage: this.#resourceWaits.get(agentId),
					task: assignment,
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
			});
		}

		const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
		const syncSpawns = spawns.filter(spawn => spawn.blocking);
		const advisory = this.session.suppressSpawnAdvisory
			? undefined
			: composeSpawnAdvisory({
					agents: asyncSpawns.map(spawn => spawn.progress.agent),
					items: asyncSpawns.map(spawn => spawn.item),
					depthCapacity,
					ircEnabled,
					willRunAsync: asyncSpawns.length > 0,
					scoutAvailable: isScoutSpawnable(
						cfgTaskDisabledAgents.get(this.session.settings),
						this.session.getSessionSpawns?.() ?? "*",
					),
				});
		const agentLabel = [...new Set(asyncSpawns.map(spawn => spawn.progress.agent))].join(", ");

		// Aggregate state for the one tool call. Async spawns report into the
		// shared progress snapshot through their jobs: the async half stays
		// "running" until every job settles, then turns "failed" if any spawn
		// failed. Blocking spawns run inline below and land in `results` before
		// the call returns, so post-return job updates never drop them.
		let settledCount = 0;
		let failedCount = 0;
		let primaryJobId = asyncSpawns[0]?.agentId ?? syncSpawns[0]!.agentId;
		const syncResults: SingleResult[] = [];
		// oxlint-disable-next-line prefer-const -- read by buildAsyncDetails before assignment
		let syncUsage: Usage | undefined;
		// oxlint-disable-next-line prefer-const -- read by buildAsyncDetails before assignment
		let syncOutputPaths: string[] | undefined;
		let syncProjectAgentsDir: string | null = null;
		const buildAsyncDetails = (): TaskToolDetails => ({
			projectAgentsDir: syncProjectAgentsDir,
			results: [...syncResults],
			totalDurationMs: Date.now() - callStartedAt,
			usage: syncUsage,
			outputPaths: syncOutputPaths,
			progress: spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: settledCount < asyncSpawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
				jobId: primaryJobId,
				type: "task",
			},
		});

		const started: Array<{ agentId: string; jobId: string }> = [];
		const failedSchedules: string[] = [];
		for (const spawn of asyncSpawns) {
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams: spawnParamsFor(params, spawn.item, defaultAgent),
					agentId: spawn.agentId,
					run: spawn.run,
					progress: spawn.progress,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: (failed, runSignal) => {
						const prior = this.#todoExecutors.get(spawn.agentId);
						if (
							prior &&
							runSignal?.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON &&
							!this.#restartWorkers.has(spawn.agentId)
						)
							this.#recordFailedAttempt(
								{
									id: spawn.agentId,
									exitCode: 1,
									aborted: true,
									abortReason: "Restart interrupted queued resource wait.",
									error: "Restart interrupted queued resource wait.",
									stderr: "",
									output: "",
									durationMs: Date.now() - prior.startedAt,
								},
								runSignal,
							);
						const interrupted = this.#restartWorkers.delete(spawn.agentId);
						if (prior && !interrupted) {
							this.#persistTodoExecutor({
								...prior,
								finishedAt: Date.now(),
								outcome: failed ? "failed" : "completed",
							});
						}
						this.#todoExecutors.delete(spawn.agentId);
						settledCount += 1;
						if (failed) failedCount += 1;
					},
				});
				this.session.onTaskWorkerLaunched?.(toolCallId, spawn.index, spawn.agentId, spawn.progress.agent);
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
				// Register ownership before returning the spawn result, even when the
				// executor is still waiting for a permit or session initialization.
				if (!this.#todoExecutors.has(spawn.agentId)) {
					const observed: TodoExecutorObservation = {
						workerId: spawn.agentId,
						agentProfile: spawn.progress.agent,
						row: spawn.item.row,
						description: spawn.progress.description,
						taskText: spawn.item.task,
						startedAt: Date.now(),
					};
					this.#todoExecutors.set(spawn.agentId, observed);
					this.#persistTodoExecutor(observed);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// An adopted run already executes; without its job nothing would own it.
				spawn.run?.discard(`background job registration failed: ${message}`);
				this.#releaseRow(spawn.agentId, true);
				this.#resourceWaits.delete(spawn.agentId);
				this.#setResourceWait(spawnParamsFor(params, spawn.item, defaultAgent));
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				spawn.progress.status = "failed";
				settledCount += 1;
				failedCount += 1;
			}
		}

		respawnNote = this.#relinkRespawnOwners(
			spawns
				.filter(spawn => spawn.blocking || started.some(entry => entry.agentId === spawn.agentId))
				.map(spawn => ({ requestedName: spawn.item.name?.trim() ?? "", workerId: spawn.agentId })),
			manager,
		);

		if (started.length === 0 && syncSpawns.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to start background task job${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} spawn${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}.`
				: "";
		// Job lifecycle (proc://, expiry, agent://) rides the first spawn result only: later
		// calls reuse it, and sessions that never spawn never pay for it.
		const renderSpawnFeedback = (mixed: boolean): string => {
			const lifecycle = !this.#lifecycleShown;
			this.#lifecycleShown = true;
			return prompt
				.render(taskSpawnFeedbackTemplate, {
					mixed,
					lifecycle,
					ircEnabled,
					singular: started.length === 1,
					singleCall: spawns.length === 1,
					showListing: mixed || spawns.length > 1,
					count: started.length,
					agentId: started[0]?.agentId,
					jobId: started[0]?.jobId,
					agentLabel,
					started,
					scheduleFailureSummary,
				})
				.trim();
		};

		if (syncSpawns.length === 0) {
			if (spawns.length === 1) {
				const { agentId } = started[0];
				onUpdate?.({
					content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
					details: buildAsyncDetails(),
				});
				return appendTaskNotices(
					withAdvisory({
						content: [
							{
								type: "text",
								text: renderSpawnFeedback(false),
							},
						],
						details: buildAsyncDetails(),
					}),
					toolNotices,
				);
			}
			onUpdate?.({
				content: [{ type: "text", text: `Spawned ${started.length} agents...` }],
				details: buildAsyncDetails(),
			});
			return appendTaskNotices(
				withAdvisory({
					content: [
						{
							type: "text",
							text: renderSpawnFeedback(false),
						},
					],
					details: buildAsyncDetails(),
				}),
				toolNotices,
			);
		}

		// Mixed call: the async jobs above already run detached; the blocking
		// subset runs inline and gates the call's return — exactly what each
		// agent type declares (`blocking: true` = the parent waits on it).
		const syncLabel = syncSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Running ${syncLabel} inline; ${started.length} background agent${started.length === 1 ? "" : "s"} spawned...`,
				},
			],
			details: buildAsyncDetails(),
		});
		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns: syncSpawns.map(spawn => ({
				item: spawn.item,
				index: spawn.index,
				preAllocatedId: spawn.agentId,
				run: spawn.run,
			})),
			onItemProgress: onUpdate
				? (index, progress) => {
						const spawn = spawns.find(candidate => candidate.index === index);
						if (spawn) spawn.progress = { ...progress, index };
						onUpdate({
							content: [{ type: "text", text: `Running ${syncLabel} inline...` }],
							details: buildAsyncDetails(),
						});
					}
				: undefined,
		});
		const merged = mergeSyncPayloads(
			syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index })),
			payloads,
		);
		syncResults.push(...merged.results);
		syncUsage = merged.usage;
		syncOutputPaths = merged.outputPaths;
		syncProjectAgentsDir = merged.projectAgentsDir;
		// Settle the inline spawns' progress rows from their merged results so
		// post-return job updates carry final statuses, not the last snapshot.
		for (let position = 0; position < syncSpawns.length; position++) {
			const spawn = syncSpawns[position];
			const result = merged.results.find(r => r.id === spawn.agentId);
			if (result) {
				spawn.progress.status = result.aborted
					? "aborted"
					: result.exitCode === 0 && !result.error
						? "completed"
						: "failed";
				spawn.progress.durationMs = result.durationMs;
			} else {
				spawn.progress.status = payloads[position] ? "failed" : "aborted";
			}
		}

		const spawnedSummary = started.length > 0 ? renderSpawnFeedback(true) : scheduleFailureSummary.trim();
		const text = [merged.contentParts.join("\n\n"), spawnedSummary]
			.filter(section => section.trim().length > 0)
			.join("\n\n");
		return appendTaskNotices(
			withAdvisory({
				content: [{ type: "text", text: text.length > 0 ? text : "No results." }],
				...(merged.isError ? { isError: true } : {}),
				details: buildAsyncDetails(),
			}),
			toolNotices,
		);
	}

	/**
	 * Register one background job that runs a single spawn to completion and
	 * delivers its yield text. The job body mirrors the sync path; `buildDetails`
	 * supplies the (possibly batch-shared) progress snapshot and `onSettled`
	 * feeds the caller's aggregate counters.
	 */
	#registerSpawnJob(options: {
		manager: AsyncJobManagerApi;
		toolCallId: string;
		spawnParams: TaskParams;
		agentId: string;
		/** Run already started while the call streamed; the job adopts it instead of launching. */
		run?: SpawnRun;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean, signal: AbortSignal) => void;
	}): string {
		const {
			manager,
			toolCallId,
			spawnParams,
			agentId,
			run,
			progress,
			ircEnabled,
			buildDetails,
			onUpdate,
			onSettled,
		} = options;
		// A queued job launches (or adopts) its run when it starts; until then
		// its widget has no tool tap to read.
		let spawnRun: SpawnRun | undefined = run;
		const buildFollowUpHint = async (aborted: boolean): Promise<string> => {
			// Isolated runs are parked without a reviver once the run ends
			// (`finalizeSubagentLifecycle`), so "message it" would point the
			// caller at a follow-up path that no longer exists. The template says
			// nothing about the worktree itself: the runner keeps it when captured
			// changes could not be written, and names that path in the result.
			const isolated = spawnParams.isolated === true;
			const ref = aborted ? AgentRegistry.global().get(agentId) : undefined;
			return `\n\n${prompt.render(taskFollowUpTemplate, {
				agentId,
				aborted,
				isolated,
				ircEnabled,
				resumable: !isolated && isResumable(ref),
				transcriptAvailable: aborted ? await hasResolvableTranscript(agentId) : true,
			})}`;
		};
		return manager.register(
			"task",
			agentId,
			async ({ jobId, signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const forwardSyncProgress: AgentToolUpdateCallback<TaskToolDetails> = async update => {
					const nextProgress = update.details?.progress?.[0];
					if (nextProgress) {
						// The job body owns status and identity (id/index/agent);
						// copy only the live metrics the subagent streams so the
						// polling row reflects the resolved model, reasoning level,
						// and running counters without reverting the "running"
						// status back to the subagent's initial "pending" snapshot.
						progress.modelRole = nextProgress.modelRole ?? progress.modelRole;
						progress.resolvedModel = nextProgress.resolvedModel;
						progress.resolvedModelIdentity = nextProgress.resolvedModelIdentity;
						progress.resolvedThinkingLevel = nextProgress.resolvedThinkingLevel;
						progress.resolvedModelIsFallback = nextProgress.resolvedModel
							? nextProgress.resolvedModelIsFallback
							: undefined;
						progress.advisor = nextProgress.advisor ?? progress.advisor;
						progress.completionPercent = nextProgress.completionPercent ?? progress.completionPercent;
						progress.stage = nextProgress.stage ?? progress.stage;
						progress.watch = nextProgress.watch ?? progress.watch;
						progress.resolvedModelRoute = nextProgress.resolvedModelRoute ?? progress.resolvedModelRoute;
						progress.firstTurnModel = nextProgress.firstTurnModel ?? progress.firstTurnModel;
						progress.fallbacks = nextProgress.fallbacks ?? progress.fallbacks;
						progress.tokens = nextProgress.tokens;
						progress.requests = nextProgress.requests;
						progress.contextTokens = nextProgress.contextTokens;
						progress.contextWindow = nextProgress.contextWindow;
						progress.cost = nextProgress.cost;
						progress.toolCount = nextProgress.toolCount;
						progress.currentTool = nextProgress.currentTool;
						progress.currentToolArgs = nextProgress.currentToolArgs;
						progress.currentToolArgsKey = nextProgress.currentToolArgsKey;
						progress.currentToolIntent = nextProgress.currentToolIntent;
						progress.currentToolStartMs = nextProgress.currentToolStartMs;
						progress.lastIntent = nextProgress.lastIntent;
						progress.recentTools = nextProgress.recentTools.slice();
						progress.recentOutput = nextProgress.recentOutput.slice();
						progress.retryState = nextProgress.retryState;
						progress.retryFailure = nextProgress.retryFailure;
					}
					const updateText =
						update.content.find(part => part.type === "text")?.text ?? `Running background task ${agentId}...`;
					await reportProgress(updateText, buildDetails() as unknown as Record<string, unknown>);
				};
				const activeRun = (spawnRun ??= this.#launch({
					toolCallId,
					params: spawnParams,
					index: progress.index,
					agentId,
					detached: true,
				}));
				activeRun.attach({
					signal: runSignal,
					onUpdate: forwardSyncProgress,
					onResourceWait: async stage => {
						if (progress.stage === stage) return;
						progress.stage = stage;
						await reportProgress(
							stage ?? `Queued background task ${agentId}...`,
							buildDetails() as unknown as Record<string, unknown>,
						);
					},
					onArtifactsRetained: cleanup => {
						// Tie the retained temp directory's lifetime to this job
						// row: the manager runs `cleanup` exactly once, on
						// eviction or manager disposal, instead of it leaking
						// for the process lifetime. Look up by the resolved
						// `jobId`, not the requested `agentId` — `register()`
						// suffixes `jobId` on collision, and looking up the
						// requested id would hit an unrelated pre-existing row.
						const job = manager.getJob(jobId);
						if (job) job.retainedArtifactsCleanup = cleanup;
						else void cleanup();
					},
				});
				// An acquire-time abort and a post-acquire abort take the same
				// path: progress + onSettled have to fire even when the spawn
				// never reached the executor, otherwise the batch aggregate state
				// stays "running" forever.
				const permitHeld = await activeRun.started.then(
					() => true,
					() => false,
				);
				if (!permitHeld || runSignal.aborted) {
					progress.status = "aborted";
					onSettled?.(true, runSignal);
					throw new Error("Aborted before execution");
				}
				try {
					markRunning();
					progress.status = "running";
					await reportProgress(
						`Running background task ${agentId}...`,
						buildDetails() as unknown as Record<string, unknown>,
					);
					const result = await activeRun.result;
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					const singleResult = result.details?.results[0];
					// A missing result means the sync path failed at the tool level
					// (results: []) — treat it as a failure, not success. A runner
					// error on a zero exit (changes captured but not landed, or a
					// retained workspace) is a failure too: the work needs manual
					// recovery, which a "completed" job would hide. Mirrors the sync
					// path's status derivation. `isError` marks a child that finished
					// before a later step (isolation merge, nested patch apply) threw.
					const resultFailed = isFailedTaskSingleResult(result, singleResult);
					progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
					progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
					progress.tokens = singleResult?.tokens ?? 0;
					progress.requests = singleResult?.requests ?? 0;
					progress.contextTokens = singleResult?.contextTokens;
					progress.contextWindow = singleResult?.contextWindow;
					progress.cost = singleResult?.usage?.cost.total ?? 0;
					progress.extractedToolData = singleResult?.extractedToolData;
					progress.retryFailure = singleResult?.retryFailure;
					progress.retryState = undefined;
					progress.modelRole = singleResult?.modelRole ?? progress.modelRole;
					progress.advisor = singleResult?.advisor ?? progress.advisor;
					progress.resolvedModelRoute = singleResult?.resolvedModelRoute ?? progress.resolvedModelRoute;
					progress.firstTurnModel = singleResult?.firstTurnModel;
					progress.fallbacks = singleResult?.fallbacks;
					if (singleResult?.resolvedModel) {
						progress.resolvedModel = singleResult.resolvedModel;
						progress.resolvedModelIdentity = singleResult.resolvedModelIdentity;
						progress.resolvedThinkingLevel = singleResult.resolvedThinkingLevel;
						progress.resolvedModelIsFallback = singleResult.resolvedModelIsFallback;
					} else {
						delete progress.resolvedModel;
						delete progress.resolvedModelIdentity;
						delete progress.resolvedThinkingLevel;
						delete progress.resolvedModelIsFallback;
					}
					onSettled?.(resultFailed, runSignal);
					const statusText = resultFailed
						? `Background task ${agentId} failed.`
						: `Background task ${agentId} complete.`;
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
					const deliveryText = `${finalText}${await buildFollowUpHint(singleResult?.aborted === true)}`;
					const structured = singleResult?.structuredOutput;
					if (resultFailed) {
						// Mark the job itself failed; the failed agent stays interrogable.
						throw new TaskJobError(deliveryText, structured);
					}
					return structured ? { text: deliveryText, structured } : deliveryText;
				} catch (error) {
					if (error instanceof TaskJobError) {
						throw error;
					}
					progress.status = "failed";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					onSettled?.(true, runSignal);
					const statusText = `Background task ${agentId} failed.`;
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
					const message = error instanceof Error ? error.message : String(error);
					const hint = AgentRegistry.global().get(agentId) ? await buildFollowUpHint(false) : "";
					throw new TaskJobError(`${message}${hint}`);
				}
			},
			{
				id: agentId,
				agentId,
				queued: true,
				ownerId: this.session.getAgentId?.() ?? undefined,
				widgetInputs: createTaskWidgetInputs({
					manager,
					agentId,
					tools: () => spawnRun?.tools,
					progress,
					intent: this.session.getToolCallIntent?.(toolCallId),
				}),
				onProgress: text => {
					onUpdate?.({ content: [{ type: "text", text }], details: buildDetails() });
				},
			},
		);
	}

	/**
	 * Sync fan-out (async unavailable, or every item's agent type is
	 * `blocking: true`): run every spawn to completion inline and merge the
	 * per-spawn payloads into a single tool result, an error when any spawn's
	 * payload is. The session-scoped semaphore still bounds concurrency across
	 * parallel task calls.
	 */
	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawns: SyncSpawnRef[],
		refusalContent: TextContent[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (spawns.length === 1) {
			const spawn = spawns[0]!;
			const run =
				spawn.run ??
				this.#launch({
					toolCallId,
					params: spawnParamsFor(params, spawn.item, defaultAgent),
					index: spawn.index,
					agentId: spawn.preAllocatedId,
					detached: false,
				});
			run.attach({ signal, onUpdate });
			const result = await run.result;
			return { ...result, content: [...refusalContent, ...result.content] };
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawns.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns,
			onItemProgress: onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						emitCombined();
					}
				: undefined,
		});

		const merged = mergeSyncPayloads(spawns, payloads);
		return {
			content: [...refusalContent, { type: "text", text: merged.contentParts.join("\n\n") }],
			...(merged.isError ? { isError: true } : {}),
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
			},
		};
	}

	/**
	 * Run a set of spawns to completion inline, bounded by the session spawn
	 * semaphore. `preAllocatedId` reuses an id claimed up front (mixed calls);
	 * `index` is each item's position in the original call so progress rows and
	 * merged results keep stable ordering. Per-item progress snapshots flow
	 * through `onItemProgress`. Returns per-spawn payloads in input order;
	 * `undefined` marks a spawn cancelled before it started.
	 */
	async #runSyncSpawns(args: {
		toolCallId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
	}): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { toolCallId, params, defaultAgent, spawns, signal, onItemProgress } = args;
		const { results } = await mapWithConcurrencyLimitAllSettled(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const run =
					spawn.run ??
					this.#launch({
						toolCallId,
						params: spawnParamsFor(params, spawn.item, defaultAgent),
						index: spawn.index,
						agentId: spawn.preAllocatedId,
						detached: false,
					});
				run.attach({
					signal: workerSignal,
					onUpdate: onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined,
				});
				try {
					await run.started;
				} catch (error) {
					if (workerSignal.aborted) return undefined;
					throw error;
				}
				return await run.result;
			},
			signal,
		);
		// A worker never invoked (call aborted first) never attached its adopted run.
		spawns.forEach((spawn, position) => {
			if (!results[position]) spawn.run?.discard("task call aborted before the spawn started");
		});
		return results.map((settled, position) => {
			if (!settled) return undefined;
			if (settled.status === "fulfilled") return settled.value;
			const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
			const item = spawns[position].item;
			return {
				content: [
					{
						type: "text",
						text: `Task ${item.name?.trim() || `#${spawns[position].index + 1}`} failed: ${message}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		});
	}

	/** Spawn a fresh subagent and run it to completion; the body of every {@link SpawnRun}. */
	async #runSpawn(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
		onArtifactsRetained?: (cleanup: () => Promise<void>) => void,
		tools?: TextTap,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const assignment = spawnAssignment(params);
		const route = this.#reworkRoutes.get(`${toolCallId}:${spawnIndex}`);
		const context =
			[this.#isBatchEnabled() ? params.context?.trim() : undefined, route?.context].filter(Boolean).join("\n\n") ||
			undefined;
		let latestProgress: AgentProgress | undefined;
		try {
			const request = {
				session: this.session,
				invocationKind: "task" as const,
				assignment,
				scope: params.scope,
				workspace: params.workspace,
				reads: params.reads,
				verifiedWorkspace: preAllocatedId ? this.#spawnWorkspaces.get(preAllocatedId) : undefined,
				context,
				steps: params.steps,
				agent: params.agent,
				requirementIds: params.requirementIds,
				...(params.images?.length ? { images: params.images } : {}),
				sourceSession: params.sourceSession,
				...spawnModelFields(params),
				...this.#resultParams(params),
				...this.#effortParams(params),
				...(Object.hasOwn(params, "resources") ? { resources: params.resources } : {}),
				solutionSpace: params.solutionSpace,
				row: params.row,
				resources: params.resources,
				readOnly: params.readOnly,
				...(route?.rung ? { model: route.rung.model } : {}),
				...(params.tools?.length
					? {
							customTools: createEvalCustomTools(
								this.session,
								await describeEvalTools(this.session, params.tools, signal),
							),
						}
					: {}),
				// `name` is the spawn handle: keep it for id allocation when this
				// path did not pre-reserve one. Do not treat it as a HUD description.
				identity: { id: preAllocatedId, label: params.name },
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				// Rework may resume this worker after the async job is evicted.
				// Retain the worker's artifacts for the parent session, not one invocation.
				keepAlive: true,
				retainArtifacts: true,
				onArtifactsRetained: (cleanup: () => Promise<void>) => {
					if (this.session.registerDisposeCallback)
						this.session.registerDisposeCallback(() => {
							void cleanup();
						});
					else onArtifactsRetained?.(cleanup);
				},
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
				...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
				blockedAgent: this.#blockedAgent,
				enableLsp: (this.session.enableLsp ?? true) && cfgTaskEnableLsp.get(this.session.settings),
				enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
				maxRuntimeMs: cfgTaskMaxRuntimeMs.get(this.session.settings),
				signal,
				...(tools ? { onToolResult: (result: SubagentToolResult) => appendToolResult(tools, result) } : {}),
				onProgress: (progress: AgentProgress) => {
					latestProgress = { ...progress, recentTools: progress.recentTools.slice() };
					this.session.onTaskWorkerLaunched?.(toolCallId, spawnIndex, progress.id, progress.agent);
					onUpdate?.({
						content: [{ type: "text", text: `Running agent ${progress.id}...` }],
						details: {
							projectAgentsDir: null,
							results: [],
							totalDurationMs: Date.now() - startTime,
							progress: [latestProgress],
						},
					});
				},
			};
			const execution: StructuredSubagentResult = await runStructuredSubagent(request);
			this.#workerSessions.set(execution.result.id, execution);
			this.#recordFailedAttempt(execution.result, signal);
			this.#reworkRoutes.delete(`${toolCallId}:${spawnIndex}`);
			return this.#buildResultPayload(
				execution.result,
				execution.policy.discovery.projectAgentsDir,
				Date.now() - startTime,
				execution.mergeSummary,
			);
		} catch (error) {
			const message = error instanceof StructuredSubagentError ? error.message : String(error);
			const lockOwner = checkoutLockOwnerFromTaskError(message);
			if (lockOwner && Date.now() - startTime < 2000) {
				this.#reworkRoutes.delete(`${toolCallId}:${spawnIndex}`);
				return {
					content: [
						{
							type: "text",
							text: `NOT STARTED: checkout lock held by ${lockOwner}; respawning identically will fail again; wait for ${lockOwner} or give edits to it`,
						},
					],
					details: { projectAgentsDir: null, results: [], totalDurationMs: Date.now() - startTime },
				};
			}
			// A child that finished before the failure keeps its exit status,
			// usage, and artifact path. `error` is set so nothing reads a zero
			// exit code as a completed run.
			const settled = error instanceof StructuredSubagentError ? error.result : undefined;
			const cause = error instanceof StructuredSubagentError ? error.cause : undefined;
			const salvaged = settled
				? {
						...settled,
						error: settled.error ?? (cause instanceof Error ? cause.message : message),
					}
				: undefined;
			const workerId = latestProgress?.id ?? preAllocatedId;
			if (workerId)
				this.#recordFailedAttempt(
					{
						id: workerId,
						exitCode: 1,
						error: message,
						output: "",
						stderr: message,
						durationMs: Date.now() - startTime,
						aborted: signal?.aborted,
					},
					signal,
				);
			this.#reworkRoutes.delete(`${toolCallId}:${spawnIndex}`);
			return {
				content: [{ type: "text", text: `Task execution failed: ${message}` }],
				isError: true,
				details: {
					projectAgentsDir: null,
					results: salvaged ? [salvaged] : [],
					totalDurationMs: Date.now() - startTime,
					...(salvaged?.usage ? { usage: salvaged.usage } : {}),
					...(salvaged?.outputPath ? { outputPaths: [salvaged.outputPath] } : {}),
					...(latestProgress ? { progress: [latestProgress] } : {}),
				},
			};
		}
	}

	/** Build the tool result (summary text + details) for a settled run. */
	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): AgentToolResult<TaskToolDetails> {
		const summary = formatTaskResultSummary(result, { totalDurationMs, mergeSummary });
		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}

subprocessToolRegistry.register<TaskToolDetails>("task", {
	...taskSubprocessRenderer,
	extractData: event => (isTaskToolDetails(event.result?.details) ? event.result.details : undefined),
});
export const __testDropEmptyOptionalTaskFields = dropEmptyOptionalTaskFields;
