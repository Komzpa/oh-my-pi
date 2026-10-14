/**
 * Result submission tool for subagent output.
 *
 * Subagents can call this tool incrementally or terminally depending on `type`.
 */
import type {
	AgentMessage,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai/types";
import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationResult,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
} from "@oh-my-pi/pi-ai/utils/schema";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import { formatDuration, previewLine } from "@oh-my-pi/pi-tui/render/render-utils";
import type { AbandonedJob } from "@oh-my-pi/pi-tui/tools/task";
import { daemonClientForProject } from "../launch/client";
import { hasLiveOwnedService, listServicesTolerant } from "../launch/services";
import yieldDescription from "../prompts/tools/yield.md" with { type: "text" };
import yieldDataErrorConflictMessage from "../prompts/tools/yield-data-error-conflict.md" with { type: "text" };
import yieldAlreadySubmittedMessage from "../prompts/tools/yield-already-submitted.md" with { type: "text" };
import yieldResultNeedsDataTemplate from "../prompts/tools/yield-result-needs-data.md" with { type: "text" };
import yieldRunningProcessesTemplate from "../prompts/tools/yield-running-processes.md" with { type: "text" };
import yieldServicesUnverifiedTemplate from "../prompts/tools/yield-services-unverified.md" with { type: "text" };
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import type { ToolSession } from ".";
import { buildOutputValidator, formatAllValidationIssues } from "./output-schema-validator";

/** Display-cell cap for a running command shown in the refusal message. */
const RUNNING_COMMAND_PREVIEW_WIDTH = 120;

function previewRunningCommand(command: string): string {
	return previewLine(sanitizeText(command), RUNNING_COMMAND_PREVIEW_WIDTH);
}

const YIELD_FORMAT_HINT = 'Submit success as {"data":<your output>} or failure as {"error":"message"}.';

export function resolveYieldReportText(messages: readonly AgentMessage[], toolCallId: string): string | undefined {
	const current = messages.at(-1);
	if (current?.role !== "assistant" || ["error", "aborted", "length"].includes(current.stopReason)) return;
	const calls = current.content.filter(block => block.type === "toolCall");
	if (calls.length !== 1 || calls[0].name !== "yield" || calls[0].id !== toolCallId) return;
	const currentText = current.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
	if (currentText.trim()) return currentText;
	for (let index = messages.length - 2; index >= 0; index--) {
		const previous = messages[index];
		if (previous.role === "developer") {
			const blocks =
				typeof previous.content === "string" ? [{ type: "text", text: previous.content }] : previous.content;
			if (
				blocks.length &&
				blocks.every(block => block.type === "text" && block.text.startsWith("<system-reminder>"))
			)
				continue;
		}
		if (
			previous.role !== "assistant" ||
			previous.stopReason !== "stop" ||
			previous.content.some(block => block.type === "toolCall")
		)
			return;
		const text = previous.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		return text.trim() ? text : undefined;
	}
}

export interface YieldDetails {
	/** Successful result payload, or omitted when `useLastTurn` requests last-turn extraction. */
	data?: unknown;
	status: "success" | "aborted";
	error?: string;
	/** Optional result section/classification supplied by the yield caller. */
	type?: string | string[];
	/** True when the caller intentionally omitted success data so the executor uses the last assistant turn. */
	useLastTurn?: boolean;
	/** True when this incremental workpool yield completed every item in the active batch. */
	complete?: boolean;
	/**
	 * Set when the yield tool exhausted its in-tool schema-retry budget
	 * (MAX_SCHEMA_RETRIES) and accepted the data anyway. Surfaced so the
	 * executor's post-mortem finalizer can honor the override instead of
	 * re-rejecting the same payload with `schema_violation` — keeping the
	 * subagent's acceptance and the parent's view of the result in lockstep.
	 */
	schemaOverridden?: boolean;
	abandonedJobs?: AbandonedJob[];
}
export type YieldAcceptedListener = (toolCallId: string, details: YieldDetails) => void;

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

function looseRecordSchema(description: string): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: true,
		description,
	};
}

function hasUnresolvedRefs(schema: unknown): boolean {
	if (schema == null) return false;
	if (Array.isArray(schema)) {
		for (const item of schema) {
			if (hasUnresolvedRefs(item)) return true;
		}
		return false;
	}
	if (typeof schema !== "object") return false;
	const record = schema as Record<string, unknown>;
	if (typeof record.$ref === "string") return true;
	for (const key in record) {
		if (key === "const" || key === "default" || key === "enum" || key === "examples") continue;
		if (hasUnresolvedRefs(record[key])) return true;
	}
	return false;
}

const yieldTypeSchema: Record<string, unknown> = {
	anyOf: [
		{ type: "string" },
		{
			type: "array",
			minItems: 1,
			items: { type: "string" },
		},
	],
	description: "Optional result type. A non-empty string array is incremental; a string is terminal.",
};

function isYieldType(value: unknown): value is string | string[] {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
	);
}

function parseYieldType(value: unknown): string | string[] | undefined {
	// Strict-mode providers (OpenAI/Codex) make the optional `type` property
	// required+nullable, so an untyped final yield arrives as `type: null`.
	if (value === undefined || value === null) return undefined;
	if (isYieldType(value)) return value;
	throw new Error("type must be a string or non-empty array of strings");
}
/** Parse any JSON-encoded string value (`"correct"`, `42`, `{"n":4}` …).
 * Returns a `{parsed:true,value}` sentinel — never `undefined`-as-failure —
 * so decoded `null`/`false` stay distinguishable from a parse error.
 * Runs only after raw validation already failed, and the caller adopts the
 * value only if it revalidates. */
function parseJsonEncodedValue(value: string): { parsed: true; value: unknown } | { parsed: false } {
	try {
		return { parsed: true, value: JSON.parse(value) };
	} catch {
		return { parsed: false };
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when a terminal `type: "result"` payload carries no answer: missing
 * (`undefined`; strict-mode `null` is already normalized to it), blank text,
 * or an empty container (`[]`, `{}`). Genuine scalars (`0`, `false`) count as
 * content — only provably answer-less payloads are rejected.
 */
function isEmptyResultData(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value === "string") return value.trim().length === 0;
	if (Array.isArray(value)) return value.length === 0;
	if (isPlainRecord(value)) return Object.keys(value).length === 0;
	return false;
}

/**
 * Read the optional `error` argument, trimmed. Strict-mode providers (OpenAI/Codex) send
 * omitted optionals as `null`; non-strict OpenAI-compatible backends routinely fill the
 * optional string with `""` (or a filler such as `"unused"`) next to a valid `data`
 * payload. `null`, `undefined` and blank strings mean "no error". When `hasData` is true,
 * a known filler string (see {@link PLACEHOLDER_YIELD_ERRORS}) also means "no error"; any
 * other error next to `data` is returned so the caller rejects the conflict.
 *
 * Trimming changes two error-only yields on purpose: `{error:"  boom\n"}` now records
 * `"boom"`, and `{error:"   "}` without data is an empty result that counts toward the
 * empty-result retry budget (`#emptyResultFailures`) instead of aborting with an
 * all-whitespace reason.
 */
function parseYieldError(value: unknown, options: { hasData: boolean }): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("error must be a string");
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (options.hasData && isPlaceholderYieldError(trimmed)) return undefined;
	return trimmed;
}

/**
 * Render an incremental yield's `type: [...]` labels as a quoted, comma-separated list for
 * model-facing retry messages — keeps the failed section labelled even when the yield carried
 * multiple labels at once.
 */
function formatYieldLabels(labels: readonly string[]): string {
	if (labels.length === 0) return '""';
	return labels.map(label => `"${label}"`).join(", ");
}

/**
 * Filler strings that non-strict OpenAI-compatible backends put into the optional `error`
 * field when they have to fill every property next to a valid `data` payload. Consulted
 * only when `data` is present (see {@link parseYieldError}); an error-only yield keeps its
 * text as the failure reason. This is not a general error filter: do not grow it to hide
 * genuine failure messages.
 */
const PLACEHOLDER_YIELD_ERRORS = new Set([
	"ignore",
	"ignored",
	"n/a",
	"none",
	"not applicable",
	"null",
	"placeholder",
	"undefined",
	"unused",
]);

/** Whether an already-trimmed `error` string is one of {@link PLACEHOLDER_YIELD_ERRORS}. Only meaningful next to `data`. */
function isPlaceholderYieldError(value: string): boolean {
	return PLACEHOLDER_YIELD_ERRORS.has(value.toLowerCase());
}

function renderDataErrorConflictMessage(
	errorMessage: string,
	yieldType: string | string[] | undefined,
	workPoolKey?: number,
): string {
	return prompt.render(yieldDataErrorConflictMessage, {
		errorJson: JSON.stringify(errorMessage),
		failureJson: JSON.stringify(
			workPoolKey === undefined ? { error: errorMessage } : { key: workPoolKey, error: errorMessage },
		),
		typeJson: yieldType === undefined ? undefined : JSON.stringify(yieldType),
		isWorkPool: workPoolKey !== undefined,
		workPoolKey,
	});
}

/**
 * Expand a plain-object `data` schema into a strict union that ALSO accepts each
 * top-level section value (and array element) on its own. Agents that yield
 * incrementally (`type: ["findings"]`, `type: ["confidence"]`, …) submit one
 * section per call, so `data` is a single finding object or a lone verdict value
 * — never the full output object. Without this, strict-mode providers constrain
 * `data` to the whole schema and reject/—under constrained decoding—forbid the
 * partial. Every branch is a typed sub-schema, so strict representability holds;
 * the full-output object stays the first (terminal) branch. The assembled whole
 * is still validated against the full schema at finalization. Non-object / loose
 * schemas are returned unchanged.
 */
function withSectionVariants(dataSchema: Record<string, unknown>): Record<string, unknown> {
	if (dataSchema.type !== "object") return dataSchema;
	const props = dataSchema.properties;
	if (props === null || typeof props !== "object") return dataSchema;
	const propRecord = props as Record<string, unknown>;
	const { description, ...fullWithoutDescription } = dataSchema;
	const branches: unknown[] = [];
	const seen = new Set<string>();
	const add = (schema: unknown): void => {
		if (schema === null || typeof schema !== "object") return;
		const key = JSON.stringify(schema);
		if (seen.has(key)) return;
		seen.add(key);
		branches.push(schema);
	};
	add(fullWithoutDescription);
	for (const name in propRecord) {
		const prop = propRecord[name];
		add(prop);
		if (prop !== null && typeof prop === "object") {
			const propObj = prop as Record<string, unknown>;
			if (propObj.type === "array") add(propObj.items);
		}
	}
	if (branches.length <= 1) return dataSchema;
	return description !== undefined ? { description, anyOf: branches } : { anyOf: branches };
}

function wrapWorkPoolYieldParameters(items: readonly WorkPoolYieldItem[]): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		description: "submit one workpool item outcome",
		properties: {
			key: {
				enum: items.map(item => item.index),
				description: "1-based workpool item number",
			},
			data: { description: "Self-contained outcome and evidence for this item" },
			error: { type: "string", description: "Failure reason for this item" },
		},
		required: ["key"],
	};
}

function resolveWorkPoolYieldItem(items: readonly WorkPoolYieldItem[], value: unknown): WorkPoolYieldItem {
	const item =
		typeof value === "number" && Number.isInteger(value)
			? items.find(candidate => candidate.index === value)
			: undefined;
	if (item) return item;
	throw new Error(`key must be one of: ${items.map(candidate => candidate.index).join(", ")}`);
}

function buildYieldParameters(dataSchema: Record<string, unknown>): Record<string, unknown> {
	// `data` xor `error`, and "omitted data requires a `type`", are enforced in
	// `execute()` at runtime, NOT in this schema: a top-level combinator
	// (`allOf`/`anyOf`/`oneOf`/...) makes OpenAI/Codex Responses reject the whole
	// tool with `invalid_function_parameters`, so the parameters stay a plain
	// object with optional properties (strict enforcement makes them nullable).
	return {
		type: "object",
		additionalProperties: false,
		description: "submit data or error",
		properties: {
			type: yieldTypeSchema,
			data: dataSchema,
			error: { type: "string", description: "Failure reason; mutually exclusive with data" },
		},
		required: [],
	};
}

/**
 * Max consecutive schema-validation failures before the yield tool overrides validation
 * and lets non-conforming data through. The override is a safety net for schemas the
 * JTD→JSON-Schema converter cannot fully express; it should not be reached during normal
 * model retries. Three matches the existing "3 reminders" pattern elsewhere in the agent
 * runtime.
 */
const MAX_SCHEMA_RETRIES = 3;

/**
 * Max consecutive untyped empty-result submissions before the yield tool fails
 * the child explicitly. Some weak tool callers can acknowledge the required
 * shape in prose while repeatedly sending `{}`; without a hard stop the parent
 * waits forever.
 */
const MAX_EMPTY_RESULT_RETRIES = 3;

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly approval = "read" as const;
	readonly label = "Submit Result";
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: (value: unknown) => JsonSchemaValidationResult;
	readonly #validateSection?: ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult>;
	readonly #normalizeData?: (value: unknown) => unknown;
	readonly #normalizeSection?: (label: string, value: unknown) => unknown;
	#rejectUnknownSections = false;
	#knownSectionLabels: readonly string[] = [];
	#isKnownSection?: (label: string) => boolean;
	#schemaStrict = true;
	#schemaValidationFailures = 0;
	#emptyResultFailures = 0;
	#hasIncrementalSections = false;
	// A terminal acceptance closes submission for the current monitored run.
	// Later yields in that run, including incremental sections, must not mutate
	// its result. resetTurnState() re-arms the latch for the next monitored run.
	#terminalResultSubmitted = false;
	#turnStateGeneration = 0;
	readonly #session: ToolSession;
	readonly #parameters: TSchema;
	#workPoolBatchKey = "";
	readonly #submittedWorkPoolItems = new Set<string>();
	readonly #warnedRunningJobs = new Set<string>();
	readonly #acceptedResultListeners = new Set<YieldAcceptedListener>();

	get strict(): boolean {
		return this.#workPoolItems().length === 0 && this.#schemaStrict;
	}

	get description(): string {
		return prompt.render(yieldDescription, {
			hasOutputSchema: this.#validate !== undefined,
			workPoolItems: this.#workPoolItems().length > 0,
		});
	}

	get parameters(): TSchema {
		const items = this.#workPoolItems();
		return items.length > 0 ? wrapWorkPoolYieldParameters(items) : this.#parameters;
	}

	constructor(session: ToolSession) {
		let validate: ((value: unknown) => JsonSchemaValidationResult) | undefined;
		let normalizeData: ((value: unknown) => unknown) | undefined;
		let normalizeSection: ((label: string, value: unknown) => unknown) | undefined;
		let validateSection: ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult> | undefined;
		let rejectUnknownSections = false;
		let knownSectionLabels: readonly string[] = [];
		let isKnownSection: ((label: string) => boolean) | undefined;
		let parameters: TSchema;

		try {
			const {
				validator,
				jsonSchema: normalizedSchema,
				normalized,
				error: schemaError,
			} = buildOutputValidator(session.outputSchema);
			if (validator) {
				validate = value => validator.validate(value);
				validateSection = validator.validateSection;
				rejectUnknownSections = validator.rejectUnknownSections;
				knownSectionLabels = validator.knownSectionLabels;
				isKnownSection = label => validator.isKnownSection(label);
			}

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = schemaError
				? `Structured JSON output (output schema invalid; accepting unconstrained object): ${schemaError}`
				: `Structured output matching the schema:\n${schemaHint}`;
			let sanitizedSchema: Record<string, unknown> | undefined;
			if (!schemaError && normalizedSchema !== undefined) {
				const strictProbe = tryEnforceStrictSchema(normalizedSchema);
				if (strictProbe.strict) {
					if (validator) {
						normalizeData = value => validator.normalize(value);
						normalizeSection = (label, value) => validator.normalizeSection(label, value);
					}
					sanitizedSchema = sanitizeSchemaForStrictMode(normalizedSchema);
				} else {
					sanitizedSchema = normalizedSchema;
					this.#schemaStrict = false;
				}
			} else if (!schemaError && normalized === true) {
				sanitizedSchema = {};
				this.#schemaStrict = false;
			}

			let dataSchema: Record<string, unknown>;
			if (sanitizedSchema !== undefined) {
				const resolved = dereferenceJsonSchema({
					...sanitizedSchema,
					description: schemaDescription,
				}) as Record<string, unknown>;
				if (hasUnresolvedRefs(resolved)) {
					throw new Error("schema contains unresolved $ref after dereferencing");
				}
				dataSchema = withSectionVariants(resolved);
			} else {
				this.#schemaStrict = false;
				dataSchema = looseRecordSchema(
					schemaError ? schemaDescription : "Structured JSON output (no schema specified)",
				);
			}
			parameters = buildYieldParameters(dataSchema);
			JSON.stringify(parameters);
			if (!isValidJsonSchema(parameters)) throw new Error("yield parameters schema is invalid");
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			parameters = buildYieldParameters(
				looseRecordSchema(`Structured JSON output (schema processing failed: ${errorMsg})`),
			);
			validate = undefined;
			normalizeData = undefined;
			normalizeSection = undefined;
			this.#schemaStrict = false;
		}

		this.#session = session;
		this.#validate = validate;
		this.#normalizeData = normalizeData;
		this.#normalizeSection = normalizeSection;
		this.#validateSection = validateSection;
		this.#rejectUnknownSections = rejectUnknownSections;
		this.#knownSectionLabels = knownSectionLabels;
		this.#isKnownSection = isKnownSection;
		this.#parameters = parameters;
	}

	/**
	 * Clear per-run accumulator state before a kept-alive session continues with a
	 * new monitored turn. The tool instance is stored once in the session's tool
	 * registry and reused across follow-up turns (`runSubagentFollowUpTurn`), so a
	 * prior run's incremental-section flag and retry counters would otherwise leak
	 * forward: a later thinking-only `{type:"result"}` would skip the empty-last-
	 * turn and schema guards (which require `!#hasIncrementalSections`) and fail
	 * the run post-mortem. Workpool submission state resets separately via the
	 * batch key in {@link #workPoolItems}.
	 */
	resetTurnState(): void {
		this.#hasIncrementalSections = false;
		this.#schemaValidationFailures = 0;
		this.#emptyResultFailures = 0;
		this.#warnedRunningJobs.clear();
		// Each monitored run (initial, follow-up, IRC wake) owns its own result;
		// the executor's per-run monitor ignores yields from a settled run.
		this.#terminalResultSubmitted = false;
		// Fence late-arriving executions: an execute() that captured the previous
		// generation before awaiting #checkRunningJobs must not mutate or notify
		// the new run when it finally returns.
		this.#turnStateGeneration++;
	}

	/**
	 * Subscribe to accepted yield results. The listener set is snapshotted at
	 * execute() invocation start, so a stale execution from a detached run can
	 * never notify the next run's monitor even if detach missed its unsubscribe.
	 * Exposed through ExtensionToolWrapper's bound-method proxy like
	 * resetTurnState. Returns an unsubscribe function with per-monitor lifetime.
	 */
	subscribeAcceptedResult(listener: YieldAcceptedListener): () => void {
		this.#acceptedResultListeners.add(listener);
		return () => {
			this.#acceptedResultListeners.delete(listener);
		};
	}

	/**
	 * One-shot latch for terminal results: the first accepted terminal result is
	 * the run's answer and can never be replaced. Throws the stop instruction when
	 * a later terminal yield reaches the accept point. The latch is reserved
	 * before awaiting the running-job check so sibling terminal calls executing
	 * concurrently cannot both be accepted; a refusal rolls the reservation back.
	 * Only resetTurnState() (a new monitored run) clears it.
	 */
	async #claimTerminalResult(runGeneration: number, signal?: AbortSignal): Promise<AbandonedJob[] | undefined> {
		if (this.#terminalResultSubmitted) {
			throw new Error(yieldAlreadySubmittedMessage.trim());
		}
		this.#terminalResultSubmitted = true;
		try {
			return await this.#checkRunningJobs(runGeneration, signal);
		} catch (error) {
			// A refusal releases only this run's reservation, never a successor's.
			if (runGeneration === this.#turnStateGeneration) this.#terminalResultSubmitted = false;
			throw error;
		}
	}

	async #checkRunningJobs(runGeneration: number, signal?: AbortSignal): Promise<AbandonedJob[] | undefined> {
		if (!this.#session.requireYieldTool) return;
		const jobs: AbandonedJob[] = [];
		const ownerId = this.#session.getAgentId?.() ?? undefined;
		if (hasLiveOwnedService(this.#session)) {
			const owner = this.#session.getSessionId?.() ?? ownerId;
			const client = await daemonClientForProject(this.#session.cwd);
			const { services, error: listError } = await listServicesTolerant(this.#session, signal);
			// Fail closed: an empty roster from a failed broker request is not
			// evidence that no owned service is running.
			if (listError !== undefined && !this.#warnedRunningJobs.has("service-list-unverified")) {
				if (runGeneration === this.#turnStateGeneration) this.#warnedRunningJobs.add("service-list-unverified");
				throw new Error(prompt.render(yieldServicesUnverifiedTemplate, { error: sanitizeText(listError) }).trim());
			}
			for (const service of services) {
				if (service.owner !== owner || service.persist || service.detached || TERMINAL_STATES[service.state])
					continue;
				let daemon = service;
				let command: string | undefined;
				try {
					const described = await client.request({ op: "describe", name: service.name }, signal);
					if (described.op !== "describe") throw new Error("Unexpected daemon describe response");
					if (
						described.daemon.owner !== owner ||
						described.daemon.persist ||
						described.daemon.detached ||
						TERMINAL_STATES[described.daemon.state]
					)
						continue;
					daemon = described.daemon;
					command = described.spec.args.at(-1) ?? described.spec.application;
				} catch {
					continue;
				}
				jobs.push({
					id: daemon.name,
					type: "service",
					command: previewRunningCommand(command ?? daemon.name),
					startedAt: daemon.startedAt,
					elapsedMs: Math.max(0, Date.now() - daemon.startedAt),
				});
			}
		}
		// Teardown reaps every owner job including foreground-backed and
		// delivery-suppressed rows; the guard enumerates that same set.
		for (const job of this.#session.asyncJobManager?.getRunningOwnerJobs(ownerId) ?? []) {
			jobs.push({
				id: job.id,
				type: job.type,
				command: previewRunningCommand(job.process?.command ?? job.label),
				startedAt: job.startTime,
				elapsedMs: Math.max(0, Date.now() - job.startTime),
			});
		}
		if (jobs.length === 0) return;
		const key = (job: AbandonedJob): string => `${job.type}:${job.id}:${job.startedAt}`;
		if (jobs.some(job => !this.#warnedRunningJobs.has(key(job)))) {
			// Service checks may outlive their run; keep the next run's first refusal intact.
			if (runGeneration === this.#turnStateGeneration) {
				for (const job of jobs) this.#warnedRunningJobs.add(key(job));
			}
			throw new Error(
				prompt
					.render(yieldRunningProcessesTemplate, {
						jobs: jobs.map(job => ({ id: job.id, command: job.command, elapsed: formatDuration(job.elapsedMs) })),
					})
					.trim(),
			);
		}
		return jobs;
	}

	/**
	 * True when `data` is absent or empty AND the declared output schema (if any)
	 * does not explicitly accept that empty value. A schema that legitimately
	 * allows `[]`, `{}` or `""` keeps ownership of the verdict via `#validate`.
	 */
	#isEmptyTerminalData(data: unknown): boolean {
		if (!isEmptyResultData(data)) return false;
		if (data === undefined || this.#validate === undefined) return true;
		return !this.#validate(data).success;
	}

	#workPoolItems(): readonly WorkPoolYieldItem[] {
		const items = this.#session.getWorkPoolYieldItems?.() ?? [];
		const key = items.map(item => `${item.index}:${item.id}`).join("\0");
		if (key !== this.#workPoolBatchKey) {
			this.#workPoolBatchKey = key;
			this.#submittedWorkPoolItems.clear();
		}
		return items;
	}

	async execute(
		toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		// Capture the run generation and listener identity at invocation start.
		// An execute() that outlives its run (detached while awaiting
		// #checkRunningJobs, then a new run resets and subscribes) must neither
		// mutate the new run's accumulators nor notify its listeners on return.
		const runGeneration = this.#turnStateGeneration;
		const acceptedListeners = [...this.#acceptedResultListeners];
		const result = await this.#execute(toolCallId, params, runGeneration, _signal);
		if (runGeneration === this.#turnStateGeneration && result.details !== undefined) {
			// Only still-active listeners from this invocation can observe acceptance.
			// Propagate canonical monitor failures instead of silently losing completion.
			for (const listener of acceptedListeners) {
				if (this.#acceptedResultListeners.has(listener)) listener(toolCallId, result.details);
			}
		}
		return result;
	}

	async #execute(
		toolCallId: string,
		params: unknown,
		runGeneration: number,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<YieldDetails>> {
		if (this.#terminalResultSubmitted) {
			throw new Error(yieldAlreadySubmittedMessage.trim());
		}
		if (!isPlainRecord(params)) throw new Error("yield arguments must be an object");
		const raw = params;
		const workPoolItems = this.#workPoolItems();
		let workPoolItemId: string | undefined;
		let yieldType: string | string[] | undefined;
		// Strict-mode providers send omitted optionals as `null`; treat it as absent.
		let data: unknown = raw.data === null ? undefined : raw.data;
		const errorMessage = parseYieldError(raw.error, { hasData: data !== undefined });
		if (workPoolItems.length > 0) {
			const item = resolveWorkPoolYieldItem(workPoolItems, raw.key);
			workPoolItemId = item.id;
			if (this.#submittedWorkPoolItems.has(item.id)) {
				throw new Error(`workpool item ${item.index} was already submitted`);
			}
			if (data !== undefined && errorMessage !== undefined) {
				throw new Error(renderDataErrorConflictMessage(errorMessage, undefined, item.index));
			}
			if ((data === undefined) === (errorMessage === undefined)) {
				throw new Error("workpool yield requires exactly one of data or error");
			}
			yieldType = [item.id];
		} else {
			yieldType = parseYieldType(raw.type);
		}
		let useLastTurn = errorMessage === undefined && data === undefined && yieldType !== undefined;
		// Incremental array-typed sections carry partial data (one finding, one
		// field) that cannot satisfy the full output schema; the assembled result
		// is validated as a whole at finalization (executor finalizeSubprocessOutput).
		const isIncremental = Array.isArray(yieldType) && yieldType.length > 0;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error(renderDataErrorConflictMessage(errorMessage, yieldType));
		}
		if (errorMessage === undefined && data === undefined && yieldType === undefined) {
			this.#emptyResultFailures++;
			if (this.#emptyResultFailures > MAX_EMPTY_RESULT_RETRIES) {
				const attemptCount = this.#emptyResultFailures;
				this.#emptyResultFailures = 0;
				const error = `yield result stayed empty after ${attemptCount} consecutive attempt(s); aborting child instead of retrying forever. ${YIELD_FORMAT_HINT}`;
				const abandonedJobs =
					workPoolItems.length === 0 && !isIncremental
						? await this.#claimTerminalResult(runGeneration, _signal)
						: undefined;
				return {
					content: [{ type: "text", text: `Task aborted: ${error}` }],
					details: {
						data: undefined,
						status: "aborted",
						error,
						type: yieldType,
						abandonedJobs,
					},
				};
			}
			const remaining = MAX_EMPTY_RESULT_RETRIES - this.#emptyResultFailures;
			throw new Error(
				`yield must contain either \`data\` or \`error\`. ${YIELD_FORMAT_HINT} Empty untyped result retries remaining before abort: ${remaining}.`,
			);
		}

		const status = errorMessage !== undefined && workPoolItemId === undefined ? "aborted" : "success";
		if (workPoolItemId !== undefined && errorMessage !== undefined) data = { error: errorMessage };
		let schemaValidationOverridden = false;
		let schemaValidationFailureCount = 0;
		// A terminal `type: "result"` yield is the run's answer, so it must carry
		// it in `data`. Without this, a data-less or explicitly empty (`""`, `{}`,
		// `[]`) result is accepted as completed with an empty result and the real
		// answer — e.g. a verdict table left in assistant text — is lost with no
		// retry. Bounce it in-band so the model resubmits with the payload.
		// Untouched: error yields (`type: "error"` takes the aborted path),
		// incremental sections, workpool items, and the legitimate last-turn
		// closes (accumulated sections, or resolvable last-turn text handled by
		// the guards below).
		if (
			status === "success" &&
			!isIncremental &&
			workPoolItems.length === 0 &&
			(yieldType === "result" || (typeof yieldType === "string" && data !== undefined)) &&
			this.#isEmptyTerminalData(data)
		) {
			const closesIncrementalFlow = data === undefined && this.#hasIncrementalSections;
			// Missing data still falls through to the guards below when one of them
			// can speak: accumulated sections close the incremental flow, a
			// last-turn source may resolve the text, and a schema validator owns
			// the schema-bound punt message. Only a missing payload no guard can
			// resolve — and any explicitly empty one (`""`, `{}`, `[]`) — bounces
			// here.
			const mayResolveLastTurn =
				data === undefined &&
				(this.#session.getLastAssistantText !== undefined ||
					this.#session.getYieldReportText !== undefined ||
					this.#validate !== undefined);
			if (!closesIncrementalFlow && !mayResolveLastTurn) {
				this.#emptyResultFailures++;
				if (this.#emptyResultFailures > MAX_EMPTY_RESULT_RETRIES) {
					const attemptCount = this.#emptyResultFailures;
					this.#emptyResultFailures = 0;
					const error = `yield result stayed empty after ${attemptCount} consecutive attempt(s); aborting child instead of retrying forever. ${YIELD_FORMAT_HINT}`;
					const abandonedJobs = await this.#claimTerminalResult(runGeneration, _signal);
					return {
						content: [{ type: "text", text: `Task aborted: ${error}` }],
						details: {
							data: undefined,
							status: "aborted",
							error,
							type: yieldType,
							abandonedJobs,
						},
					};
				}
				const remaining = MAX_EMPTY_RESULT_RETRIES - this.#emptyResultFailures;
				throw new Error(
					prompt.render(yieldResultNeedsDataTemplate, { formatHint: YIELD_FORMAT_HINT, remaining }).trim(),
				);
			}
		}
		// A success yield with no accumulated sections must carry its answer in `data`.
		// A stray non-empty top-level key (`result`, `output`, `answer`) with `data`
		// missing is the answer under the wrong key, so bounce it before last-turn text
		// resolution can replace it with prose. An untyped yield whose `data` is explicitly
		// empty bounces the same way the typed result does.
		if (status === "success" && !isIncremental && workPoolItems.length === 0) {
			const strayKey =
				data === undefined
					? Object.keys(raw).find(
							key =>
								key !== "type" &&
								key !== "data" &&
								key !== "error" &&
								raw[key] !== null &&
								!isEmptyResultData(raw[key]),
						)
					: undefined;
			const emptyUntyped = yieldType === undefined && data !== undefined && this.#isEmptyTerminalData(data);
			if (strayKey !== undefined || emptyUntyped) {
				this.#emptyResultFailures++;
				if (this.#emptyResultFailures > MAX_EMPTY_RESULT_RETRIES) {
					const attemptCount = this.#emptyResultFailures;
					this.#emptyResultFailures = 0;
					const error = `yield result stayed empty after ${attemptCount} consecutive attempt(s); aborting child instead of retrying forever. ${YIELD_FORMAT_HINT}`;
					const abandonedJobs = await this.#claimTerminalResult(runGeneration, _signal);
					return {
						content: [{ type: "text", text: `Task aborted: ${error}` }],
						details: {
							data: undefined,
							status: "aborted",
							error,
							type: yieldType,
							abandonedJobs,
						},
					};
				}
				const remaining = MAX_EMPTY_RESULT_RETRIES - this.#emptyResultFailures;
				const problem =
					strayKey !== undefined
						? `yield has no \`data\`: put your full answer in data, not in \`${strayKey}\``
						: "yield data is empty: put your full answer in `data`";
				throw new Error(
					`${problem}. ${YIELD_FORMAT_HINT} Empty result retries remaining before abort: ${remaining}.`,
				);
			}
		}
		// Unknown incremental labels are a hard contract mismatch with the closed caller
		// schema. Reject before the last-turn short-circuit too: `type: ["findings"], result: {}`
		// would otherwise be accepted as a typed last-turn incremental yield, then a sibling
		// section's MAX_SCHEMA_RETRIES override flips schemaOverridden in finalization and the
		// stale section rides along untouched.
		if (status === "success" && isIncremental && workPoolItemId === undefined) {
			const unknownLabels = this.#unknownIncrementalLabels(yieldType as string[]);
			if (unknownLabels.length > 0) {
				const validLabels =
					this.#knownSectionLabels.length > 0 ? formatYieldLabels(this.#knownSectionLabels) : "none";
				throw new Error(
					`Section ${formatYieldLabels(yieldType as string[])} uses unknown incremental yield label(s): ${formatYieldLabels(unknownLabels)}. Resubmit with one of the schema's labels: ${validLabels}.`,
				);
			}
		}
		// A schema-bound terminal last-turn yield with no accumulated sections can
		// only assemble raw prose, which finalization then rejects post-mortem as a
		// fatal schema_violation the child can no longer correct. Catch it here as
		// a retryable error instead. With sections present, a data-less finalize
		// legitimately closes the incremental flow (assembly keeps the sections).
		if (status === "success" && useLastTurn && !isIncremental && this.#validate && !this.#hasIncrementalSections) {
			throw new Error(
				"This task requires structured output matching the declared schema; a last-turn result cannot satisfy it. " +
					`Submit the full object: {"data":<object matching the schema>}.`,
			);
		}
		// A data-less `useLastTurn` yield resolves to the last assistant turn's
		// text. A thinking-only turn carries none, so accepting an incremental
		// call records an empty section and accepting a terminal call with no
		// accumulated sections records an empty result. Finalization would fail
		// either run post-mortem with SUBAGENT_WARNING_NULL_YIELD, after the child
		// can no longer correct it. Reject at the boundary so the reminder ladder
		// re-prompts for `data`. A terminal data-less yield after valid incremental
		// sections still closes that flow without reading last-turn text.
		if (
			status === "success" &&
			useLastTurn &&
			(isIncremental || !this.#hasIncrementalSections) &&
			(this.#session.getLastAssistantText !== undefined || this.#session.getYieldReportText !== undefined)
		) {
			const resolveReport = !isIncremental && this.#session.getYieldReportText;
			const lastTurnText = resolveReport ? resolveReport(toolCallId) : this.#session.getLastAssistantText?.();
			if (lastTurnText === undefined || lastTurnText.trim().length === 0) {
				this.#emptyResultFailures++;
				if (this.#emptyResultFailures > MAX_EMPTY_RESULT_RETRIES) {
					const attemptCount = this.#emptyResultFailures;
					this.#emptyResultFailures = 0;
					const error = `yield resolved to an empty last-turn result after ${attemptCount} consecutive attempt(s); aborting child instead of retrying forever. ${YIELD_FORMAT_HINT}`;
					const abandonedJobs =
						workPoolItems.length === 0 && !isIncremental
							? await this.#claimTerminalResult(runGeneration, _signal)
							: undefined;
					return {
						content: [{ type: "text", text: `Task aborted: ${error}` }],
						details: {
							data: undefined,
							status: "aborted",
							error,
							type: yieldType,
							abandonedJobs,
						},
					};
				}
				const remaining = MAX_EMPTY_RESULT_RETRIES - this.#emptyResultFailures;
				throw new Error(
					`yield used the last assistant turn as the result, but that turn contains no text (thinking only). ` +
						`Put your result in \`data\`: ${YIELD_FORMAT_HINT} Empty last-turn result retries remaining before abort: ${remaining}.`,
				);
			}
			if (resolveReport) {
				data = lastTurnText;
				useLastTurn = false;
			}
		}
		const normalizeData = (value: unknown): unknown =>
			workPoolItemId !== undefined
				? value
				: Array.isArray(yieldType) && yieldType.length === 1
					? (this.#normalizeSection?.(yieldType[0], value) ?? value)
					: !isIncremental
						? (this.#normalizeData?.(value) ?? value)
						: value;
		if (status === "success" && data !== undefined) data = normalizeData(data);
		if (status === "success" && !useLastTurn) {
			const validateData = (value: unknown): JsonSchemaValidationResult | undefined =>
				workPoolItemId !== undefined
					? undefined
					: isIncremental
						? this.#validateIncrementalSection(yieldType as string[], value)
						: this.#validate
							? this.#validate(value)
							: undefined;
			let sectionFailure = validateData(data);
			if (sectionFailure && !sectionFailure.success && typeof data === "string") {
				// Lossless recovery: a JSON-encoded payload string parses to exactly
				// the intended value (executor finalization already parses terminal
				// yields the same way). Never the reverse — stringifying objects to
				// fit string-typed fields is silent corruption. The sentinel keeps
				// decoded `false` distinct from a parse error. Decoded `null` is
				// never adopted: finalization treats null data as missing
				// (`resolveYieldPayload`), so accepting it here would report success
				// and then warn post-mortem instead of giving a retryable error.
				const decoded = parseJsonEncodedValue(data);
				if (decoded.parsed && decoded.value !== null) {
					const normalized = normalizeData(decoded.value);
					const revalidated = validateData(normalized);
					if (revalidated === undefined || revalidated.success) {
						data = normalized;
						sectionFailure = revalidated;
					}
				}
			}
			if (sectionFailure && !sectionFailure.success) {
				this.#schemaValidationFailures++;
				if (this.#schemaValidationFailures <= MAX_SCHEMA_RETRIES) {
					const remaining = MAX_SCHEMA_RETRIES - this.#schemaValidationFailures;
					const retryHint =
						remaining > 0
							? ` Call yield again with the corrected shape — ${remaining} retry attempt(s) remain before the schema constraint is dropped.`
							: " Call yield again with the corrected shape — this is the final retry before the schema constraint is dropped.";
					const scope = isIncremental ? `Section ${formatYieldLabels(yieldType as string[])}` : "Output";
					throw new Error(
						`${scope} does not match schema: ${formatAllValidationIssues(sectionFailure.issues)}.${retryHint}`,
					);
				}
				// Budget exhausted: capture the count for the message, accept, and
				// reset so the next independent submission starts fresh.
				schemaValidationFailureCount = this.#schemaValidationFailures;
				this.#schemaValidationFailures = 0;
				schemaValidationOverridden = true;
			} else {
				// Schema-valid submission: the documented budget is consecutive,
				// so a success resets it for the next independent section.
				this.#schemaValidationFailures = 0;
			}
		}

		// Check before either terminal latch or the last workpool item is committed.
		const completesWorkPool =
			workPoolItemId !== undefined &&
			workPoolItems.every(item => item.id === workPoolItemId || this.#submittedWorkPoolItems.has(item.id));
		const abandonedJobs =
			workPoolItems.length === 0 && !isIncremental
				? await this.#claimTerminalResult(runGeneration, _signal)
				: status === "aborted" || completesWorkPool
					? await this.#checkRunningJobs(runGeneration, _signal)
					: undefined;
		// A stale execution from a detached run must not mutate the new run's
		// accumulators: skip them when the generation moved during the awaits above.
		const staleAcceptedResult = runGeneration !== this.#turnStateGeneration;
		if (!staleAcceptedResult) this.#emptyResultFailures = 0;
		if (!staleAcceptedResult && status === "success" && isIncremental) this.#hasIncrementalSections = true;
		let workPoolComplete = false;
		let submittedWorkPoolItem: WorkPoolYieldItem | undefined;
		let remainingWorkPoolItems: readonly WorkPoolYieldItem[] = [];
		if (workPoolItemId !== undefined) {
			submittedWorkPoolItem = workPoolItems.find(item => item.id === workPoolItemId);
			if (!staleAcceptedResult) this.#submittedWorkPoolItems.add(workPoolItemId);
			remainingWorkPoolItems = workPoolItems.filter(item => !this.#submittedWorkPoolItems.has(item.id));
			workPoolComplete = remainingWorkPoolItems.length === 0;
		}
		const responseText =
			status === "aborted"
				? `Task aborted: ${errorMessage}`
				: submittedWorkPoolItem !== undefined
					? workPoolComplete
						? `Item ${submittedWorkPoolItem.index} submitted. All workpool items are complete; ending this turn.`
						: `Item ${submittedWorkPoolItem.index} submitted. Remaining item(s): ${remainingWorkPoolItems.map(item => item.index).join(", ")}.`
					: schemaValidationOverridden
						? `Result submitted (schema validation overridden after ${schemaValidationFailureCount} failed attempt(s)).`
						: "Result submitted.";
		return {
			content: [{ type: "text", text: responseText }],
			details: {
				data,
				status,
				error: errorMessage,
				type: yieldType,
				useLastTurn: useLastTurn || undefined,
				complete: workPoolComplete || undefined,
				schemaOverridden: schemaValidationOverridden || undefined,
				abandonedJobs,
			},
		};
	}

	/**
	 * Return incremental yield labels the closed caller schema does not accept. Closure covers the
	 * root, `allOf` conjuncts, and `oneOf`/`anyOf` unions whose every variant is closed (e.g. JTD
	 * discriminators). Open schemas accept any label.
	 */
	#unknownIncrementalLabels(labels: string[]): string[] {
		if (!this.#rejectUnknownSections) return [];
		const isKnown = this.#isKnownSection;
		if (!isKnown) return [];
		return labels.filter(label => !isKnown(label));
	}

	/**
	 * Validate the `data` payload of an incremental yield (`type: ["<label>", …]`) against
	 * the matching property's sub-validator. Returns the first failure across all known labels,
	 * or `undefined` when no label is recognised (user-defined section labels stay loose) or
	 * when all known labels accept the value. Lets the model see the same retry feedback that
	 * the terminal-yield path already produces, instead of leaking the mismatch through to
	 * the parent's post-mortem `schema_violation`. Unknown labels under a closed schema are
	 * handled separately by `#unknownIncrementalLabels` and never reach this validator.
	 */
	#validateIncrementalSection(labels: string[], data: unknown): JsonSchemaValidationResult | undefined {
		const subValidators = this.#validateSection;
		if (!subValidators || subValidators.size === 0) return undefined;
		for (const label of labels) {
			const sub = subValidators.get(label);
			if (!sub) continue;
			const parsed = sub(data);
			if (!parsed.success) return parsed;
		}
		return undefined;
	}
}
interface TurnStateResettable {
	resetTurnState(): void;
}

function canResetTurnState(tool: AgentTool): tool is AgentTool & TurnStateResettable {
	return "resetTurnState" in tool && typeof tool.resetTurnState === "function";
}

/**
 * Reset per-run yield state through either a native tool or an
 * `ExtensionToolWrapper` proxy.
 */
export function resetYieldTurnState(tool: AgentTool | undefined): void {
	if (tool && canResetTurnState(tool)) tool.resetTurnState();
}

interface AcceptedResultSubscribable {
	subscribeAcceptedResult(listener: YieldAcceptedListener): () => void;
}

function canSubscribeAcceptedResult(tool: AgentTool): tool is AgentTool & AcceptedResultSubscribable {
	return "subscribeAcceptedResult" in tool && typeof tool.subscribeAcceptedResult === "function";
}

/**
 * Subscribe to a yield tool's accepted results through either a native tool or
 * an `ExtensionToolWrapper` proxy (bound-method forwarding). Missing or dynamic
 * replacement tools without this producer have no subscription.
 */
export function subscribeYieldAcceptedResult(tool: AgentTool | undefined, listener: YieldAcceptedListener): () => void {
	if (tool && canSubscribeAcceptedResult(tool)) return tool.subscribeAcceptedResult(listener);
	return () => {};
}

// Register subprocess tool handler for extraction + termination.
subprocessToolRegistry.register<YieldDetails>("yield", {
	extractData: event => {
		const details = event.result?.details;
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const status = record.status;
		if (status !== "success" && status !== "aborted") return undefined;
		return {
			data: record.data,
			status,
			error: typeof record.error === "string" ? record.error : undefined,
			type: isYieldType(record.type) ? record.type : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
			complete: record.complete === true ? true : undefined,
			schemaOverridden: record.schemaOverridden === true ? true : undefined,
			abandonedJobs: Array.isArray(record.abandonedJobs) ? (record.abandonedJobs as AbandonedJob[]) : undefined,
		};
	},
	shouldTerminate: event => {
		if (event.isError) return false;
		const details = event.result?.details;
		if (!details || typeof details !== "object") return true;
		const record = details as Record<string, unknown>;
		if (record.complete === true) return true;
		return !(
			record.status === "success" &&
			Array.isArray(record.type) &&
			record.type.length > 0 &&
			record.type.every(item => typeof item === "string")
		);
	},
});
