// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { appendFileSync, chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { randomInt } from "node:crypto";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ModelPresetSwitchResult } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { isTodoSelectionEntryMetadata } from "@oh-my-pi/pi-coding-agent/tools/todo";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import gateNotices from "./gate-notices.md" with { type: "text" };
import { shortenPath, truncateMiddleToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { checkoutScopesFromResources, checkoutScopesOverlap } from "./checkout_scope";

// Model selection lives in core: the agent's frontmatter chain (role groups) plus core fallback.
// This extension keeps the write-scope gate, the file-write refusal and the spawn/outcome records.

const WRITE_CAPABLE_WORKERS = new Set([
	"coder",
	"coder-strong",
	"minor-coder",
	"ui-coder",
	"ui-coder-strong",
	"workhorse",
	"git-pr-owner",
]);

type LatestTodoGetter = (entries: unknown[]) => TodoScheduleInput;

export function sessionCwdScopes(ctx: ExtensionContext): string[] | undefined {
	const cwd = typeof ctx.cwd === "string" && ctx.cwd.trim() !== "" ? ctx.cwd : undefined;
	if (!cwd) return undefined;
	try {
		const canonical = canonicalPath(cwd);
		const repo = vcs.git(canonical);
		if (!repo) return [];
		const root = realpathSync(repo.info().repoRoot);
		return [`${root}\0.`];
	} catch {
		return undefined;
	}
}

function spawnTaskText(event: BeforeSubagentSpawnEvent): string | undefined {
	const record = event as Record<string, unknown>;
	for (const key of ["assignment", "task", "prompt", "text", "message"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

function spawnTextMatchesRowTitle(text: string, title: unknown): boolean {
	if (typeof title !== "string" || title.trim() === "") return false;
	const trimmed = text.trim();
	const clean = title.trim();
	if (trimmed.startsWith(clean)) return true;
	const firstLine = trimmed.split("\n", 1)[0]!.trim();
	const normalizedText = firstLine.replace(/^#\s*row\s*:\s*/i, "").trim();
	const normalizedTitle = clean.replace(/^#\s*row\s*:\s*/i, "").trim();
	return (
		normalizedText !== "" &&
		normalizedTitle !== "" &&
		(normalizedText === normalizedTitle || normalizedText.startsWith(normalizedTitle))
	);
}

export function lanePathsFromText(text: string): string[] {
	const found: string[] = [];
	const pattern = /(~\/[^\s'"`,;]+|\/[A-Za-z0-9_.-]+(?:\/[^\s'"`,;]+)*)/g;
	for (const match of text.matchAll(pattern)) {
		let candidate = (match[1] ?? "").replace(/[),.;'"`\]}]+$/g, "").replace(/\/+$/g, "");
		if (!candidate || candidate === "~" || candidate === "/") continue;
		if (candidate === "~" || candidate.startsWith("~/")) candidate = join(homedir(), candidate.slice(2));
		if (!candidate.startsWith("/")) continue;
		// HTTP routes (/ACK, /bundle/message/photo) are not checkout paths: the top-level directory must exist.
		if (!existsSync(`/${candidate.split("/")[1]}`)) continue;
		if (!found.includes(candidate)) found.push(candidate);
	}
	return found;
}

function ownedCheckoutScopes(
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
	latestTodo?: () => TodoScheduleInput,
): string[] | undefined {
	const fallback = sessionCwdScopes(ctx);
	const declared = checkoutScopesFromResources(event.resources);
	if (declared) return declared;
	const readPhases = (): TodoScheduleInput | undefined => {
		if (!latestTodo) return undefined;
		try {
			return latestTodo();
		} catch {
			return undefined;
		}
	};
	const owner = stringValue(event.spawnKey);
	if (owner) {
		try {
			const phases = readPhases();
			const rows = phases
				?.flatMap(phase => phase.tasks)
				.filter(row => (row.status === "pending" || row.status === "in_progress") && row.schedule?.owner === owner);
			if (rows?.length) {
				const scopes = new Set<string>();
				let complete = true;
				for (const row of rows) {
					const owned = checkoutScopesFromResources(row.schedule?.resources);
					if (!owned) {
						complete = false;
						break;
					}
					for (const scope of owned) scopes.add(scope);
				}
				if (complete && scopes.size) return [...scopes].sort();
			}
		} catch {
			// Fall through to the spawn-text scope below.
		}
	}
	const text = spawnTaskText(event);
	if (text) {
		try {
			const phases = readPhases();
			const open = phases
				?.flatMap(phase => phase.tasks)
				.filter(row => row.status === "pending" || row.status === "in_progress");
			const matched = open?.filter(row => spawnTextMatchesRowTitle(text, row.content));
			if (matched?.length) {
				const scopes = new Set<string>();
				let complete = true;
				for (const row of matched) {
					const owned = checkoutScopesFromResources(row.schedule?.resources);
					if (!owned) {
						complete = false;
						break;
					}
					for (const scope of owned) scopes.add(scope);
				}
				if (complete && scopes.size) return [...scopes].sort();
			}
		} catch {
			// Fall through to the lane-path scope below.
		}
		const paths = lanePathsFromText(text);
		if (paths.length) {
			const fromPaths = checkoutScopesFromResources(paths);
			if (fromPaths) return fromPaths;
		}
	}
	return fallback;
}

function activeWriteWorker(
	state: RouterState,
	ctx: ExtensionContext,
	checkoutScopes?: string[],
): SpawnState | undefined {
	const runningJobs = ctx.getAsyncJobSnapshot?.()?.running ?? [];
	const cwdFallback = sessionCwdScopes(ctx);
	const incoming = checkoutScopes ?? cwdFallback;
	return [...state.spawns.values()].find(spawn => {
		if (spawn.recordedOutcome || spawn.isolated || !WRITE_CAPABLE_WORKERS.has(spawn.agent)) return false;
		const held = spawn.checkoutScopes ?? cwdFallback;
		if (incoming !== undefined && held !== undefined && !checkoutScopesOverlap(incoming, held)) return false;
		return runningJobs.some(job => {
			const identifiers = [stringValue(job.id), stringValue(job.agentId)];
			return (
				identifiers.includes(spawn.spawnKey) || (spawn.jobId !== undefined && identifiers.includes(spawn.jobId))
			);
		});
	});
}

export interface SpawnRecord {
	kind: "spawn";
	spawnKey: string;
	jobId?: string;
	at: string;
	sessionId?: string;
	agent: string;
	/** First candidate of the agent's resolved chain; the model core actually ran is the outcome's resolvedModel. */
	chosen: string;
	order: string[];
	isolated?: boolean;
	checkoutScopes?: string[];
}

export interface OutcomeRecord {
	kind: "outcome";
	spawnKey: string;
	jobId?: string;
	at: string;
	sessionId?: string;
	agent: string;
	chosen: string;
	order: string[];
	status: "completed" | "failed" | "cancelled";
	durationMs: number;
	resolvedModel?: string;
	firstTurnModel?: string;
	fallbacks?: OutcomeFallback[];
	fallbackReason?: string;
}

export interface OutcomeFallback {
	from: string;
	to: string;
	at: string;
	reason:
		| "unrecorded"
		| {
				class: "quota" | "auth" | "other";
				status?: number;
				message: string;
				source?: "provider-error" | "usage-preflight";
		  };
}

export interface FallbackRecord {
	from: string;
	to: string;
	role: string;
	reason?: string;
	at: string;
}

interface SpawnState extends SpawnRecord {
	recordedOutcome: boolean;
	writerNoticeSent?: boolean;
}

export interface RouterState {
	spawns: Map<string, SpawnState>;
	fallbacks: FallbackRecord[];
}
export interface BeforeSubagentSpawnEvent {
	agent?: unknown;
	spawnKey?: unknown;
	patterns?: unknown;
	isolated?: unknown;
	assignment?: unknown;
	task?: unknown;
	prompt?: unknown;
	text?: unknown;
	message?: unknown;
}

export interface ToolResultEvent {
	toolName?: unknown;
	toolCallId?: unknown;
	isError?: unknown;
	details?: unknown;
}

export interface RetryFallbackAppliedEvent {
	from?: unknown;
	to?: unknown;
	role?: unknown;
	reason?: unknown;
}

export type JsonlRecord = SpawnRecord | OutcomeRecord;

export function createRouterState(): RouterState {
	return { spawns: new Map(), fallbacks: [] };
}

export function defaultStateFile(): string {
	return process.env.OMP_AGENT_ROUTER_STATE ?? join(homedir(), ".local/state/omp-agent-router/spawns.jsonl");
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function recordKey(spawnKey: string, agent: string): string {
	return `${spawnKey}\u0000${agent}`;
}

function sessionId(ctx: ExtensionContext): string | undefined {
	const header = ctx.sessionManager?.getHeader?.();
	if (!header || typeof header !== "object") return undefined;
	return stringValue((header as Record<string, unknown>).id);
}

function appendJsonl(stateFile: string, record: JsonlRecord): void {
	mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
	appendFileSync(stateFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(stateFile, 0o600);
}

function canonicalPath(target: string): string {
	let current = resolve(target);
	const suffix: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return resolve(target);
		suffix.unshift(current.slice(parent.length + 1));
		current = parent;
	}
	return resolve(realpathSync(current), ...suffix);
}

function fileToolTargets(input: Record<string, unknown>): string[] {
	const targets = [typeof input.path === "string" ? input.path : undefined];
	if (Array.isArray(input.paths))
		targets.push(...input.paths.filter((target): target is string => typeof target === "string"));
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (edit && typeof edit === "object" && typeof (edit as Record<string, unknown>).rename === "string") {
				targets.push((edit as Record<string, string>).rename);
			}
		}
	}
	if (typeof input.input === "string") {
		for (const line of input.input.split(/\r?\n/)) {
			const hashline = /^\[([^\]]+)\]$/.exec(line.trim());
			const patchFile = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/.exec(line.trim());
			const patchMove = /^\*\*\*\s+Move to:\s*(.+)$/.exec(line.trim());
			const unified = /^(?:--- a\/|\+\+\+ b\/)(.+)$/.exec(line.trim());
			const target =
				hashline?.[1]?.replace(/#[0-9a-f]{4}$/i, "") ?? patchFile?.[1] ?? patchMove?.[1] ?? unified?.[1];
			if (target && target !== "/dev/null") targets.push(target);
		}
	}
	return [...new Set(targets.filter((target): target is string => Boolean(target)))];
}
async function fileToolRefusal(event: { toolName?: unknown; input?: unknown }, ctx: ExtensionContext) {
	if (event.toolName !== "write") return undefined;
	if (!event.input || typeof event.input !== "object") return undefined;
	const input = event.input as Record<string, unknown>;
	const requestedPaths = fileToolTargets(input);
	if (input.replace === true || requestedPaths.length === 0) return undefined;
	return truncatingWriteRefusal(requestedPaths[0]!, input, ctx);
}

async function truncatingWriteRefusal(requestedPath: string, input: Record<string, unknown>, ctx: ExtensionContext) {
	// R3: the empty-content and shrink guard protects real files only. Internal control URIs
	// (proc://, agent://, xd://, any non-file scheme) are not files, so `write proc://<id>/kill`
	// with empty or omitted content always passes. A single-letter "scheme" is a Windows drive.
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(requestedPath) && !/^[A-Za-z]:[\\/]/.test(requestedPath)) return undefined;
	const target = canonicalPath(
		requestedPath === "~" || requestedPath.startsWith("~/")
			? resolve(homedir(), requestedPath.slice(2))
			: resolve(ctx.cwd, requestedPath),
	);
	const content = typeof input.content === "string" ? input.content : "";
	if (content.length === 0) {
		const action = `Pass replace: true for ${truncateMiddleToWidth(shortenPath(requestedPath), 48)}.`;
		return {
			block: true,
			reason: `${action.slice(0, 100)}\nRequested path: ${requestedPath}. Refusing an empty write without explicit replacement confirmation.`,
		};
	}
	const targetRepo = vcs.git(target);
	if (!targetRepo || !existsSync(target)) return undefined;
	const relativeTarget = relative(targetRepo.info().repoRoot, target);
	if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) return undefined;
	if (!(await targetRepo.lsFiles(false, false)).includes(relativeTarget)) return undefined;
	const size = statSync(target).size;
	const newSize = Buffer.byteLength(content, "utf8");
	if (newSize < size * 0.05) {
		const action = `Pass replace: true to shrink ${truncateMiddleToWidth(shortenPath(requestedPath), 42)}.`;
		return {
			block: true,
			reason: `${action.slice(0, 100)}\nRequested path: ${requestedPath}. This ${newSize}-byte write is under 5% of the tracked ${size}-byte file.`,
		};
	}
	return undefined;
}

/** Distinct authenticated models the session can start a worker on; feeds the dispatcher's shown task cap. */
export async function countLiveWorkerModels(ctx: ExtensionContext): Promise<number> {
	// No model list to count (headless or partial context): fail open like the dispatcher's unchecked default.
	if (!ctx.models?.list) return availableParallelism();
	return new Set((ctx.models?.list?.() ?? []).map(model => `${model.provider}/${model.id}`)).size;
}

export function holderRepoLabel(spawn: SpawnState | undefined, ctx: ExtensionContext): string {
	const scopes = spawn?.checkoutScopes ?? sessionCwdScopes(ctx);
	const root = scopes?.[0]?.split("\0")[0];
	return root && root.trim() !== "" ? root : "this checkout";
}

export function cwdRepoLabel(ctx: ExtensionContext): string {
	const root = sessionCwdScopes(ctx)?.[0]?.split("\0")[0];
	if (root && root.trim() !== "") return root;
	return typeof ctx.cwd === "string" && ctx.cwd.trim() !== "" ? ctx.cwd : "the session checkout";
}

/** One latestTodo read per spawn: checkout scopes and criticality share it. */
function memoLatestTodo(
	getter: LatestTodoGetter | undefined,
	ctx: ExtensionContext,
): (() => TodoScheduleInput) | undefined {
	if (!ctx.getTodoPhases && (!getter || !ctx.sessionManager?.getBranchMatching)) return undefined;
	let cached: TodoScheduleInput | undefined;
	return () =>
		(cached ??=
			ctx.getTodoPhases?.() ??
			(getter && ctx.sessionManager?.getBranchMatching
				? getter(ctx.sessionManager.getBranchMatching(isTodoSelectionEntryMetadata))
				: []));
}

export function routeSubagentSpawn(
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
	state = createRouterState(),
	options: { stateFile?: string; now?: () => Date; latestTodo?: LatestTodoGetter } = {},
): { block: true; reason: string } | undefined {
	const agent = stringValue(event.agent);
	if (!agent) return undefined;
	const latestTodo = memoLatestTodo(options.latestTodo, ctx);
	const checkoutScopes =
		WRITE_CAPABLE_WORKERS.has(agent) && event.isolated !== true
			? ownedCheckoutScopes(event, ctx, latestTodo)
			: undefined;
	// git-pr-owner only runs VCS finalization (commit/PR/push), sequenced by the
	// caller after a coder's edits land. Blocking it on a still-"running" coder
	// deadlocks the commit-after-write flow the gate is meant to serialize, so
	// the gate covers file-writing spawns and an active git-pr-owner still
	// blocks later writers via its recorded scopes — the exemption is incoming
	// only. Simpler alternatives (per-file overlap checks, completion-aware
	// "files are done" detection) need edit-intent tracking the spawn event
	// does not carry.
	if (WRITE_CAPABLE_WORKERS.has(agent) && agent !== "git-pr-owner" && event.isolated !== true) {
		const activeWriter = activeWriteWorker(state, ctx, checkoutScopes);
		if (activeWriter) {
			const heldScopes = activeWriter.checkoutScopes ?? sessionCwdScopes(ctx);
			const heldFirst = heldScopes?.[0]?.split("\0") ?? [];
			const heldScope =
				heldFirst[0] && heldFirst[0].trim() !== ""
					? heldFirst[1] && heldFirst[1] !== "."
						? `${heldFirst[0]}/${heldFirst[1]}`
						: heldFirst[0]
					: holderRepoLabel(activeWriter, ctx);
			const incomingScopes = checkoutScopes ?? sessionCwdScopes(ctx);
			const incomingFirst = incomingScopes?.[0]?.split("\0") ?? [];
			const incomingScope =
				incomingFirst[0] && incomingFirst[0].trim() !== ""
					? incomingFirst[1] && incomingFirst[1] !== "."
						? `${incomingFirst[0]}/${incomingFirst[1]}`
						: incomingFirst[0]
					: cwdRepoLabel(ctx);
			const action = `Wait for ${truncateMiddleToWidth(activeWriter.agent, 18)} ${truncateMiddleToWidth(activeWriter.spawnKey, 22)} or use disjoint resources.`;
			return {
				block: true,
				reason: `${action.slice(0, 100)}\nWorker ${activeWriter.agent} ${activeWriter.spawnKey} is writing ${heldScope}; ${agent} targets ${incomingScope}. Put the other repo path in this row's resources; isolated: true isolates only ${cwdRepoLabel(ctx)}.`,
			};
		}
	}
	const order = Array.isArray(event.patterns)
		? event.patterns.filter((spec): spec is string => typeof spec === "string")
		: [];
	const spawnKey = stringValue(event.spawnKey) ?? `${agent}:${Date.now()}:${randomInt(1_000_000_000)}`;
	const record: SpawnRecord = {
		kind: "spawn",
		spawnKey,
		at: (options.now ?? (() => new Date()))().toISOString(),
		sessionId: sessionId(ctx),
		agent,
		chosen: order[0] ?? "",
		order,
		...(event.isolated === true ? { isolated: true } : {}),
		...(checkoutScopes ? { checkoutScopes } : {}),
	};
	state.spawns.set(recordKey(spawnKey, agent), { ...record, recordedOutcome: false });
	appendJsonl(options.stateFile ?? defaultStateFile(), record);
	return undefined;
}

function statusFromResult(result: Record<string, unknown>, eventIsError: boolean): OutcomeRecord["status"] {
	if (result.aborted === true) return "cancelled";
	if (eventIsError || typeof result.error === "string") return "failed";
	const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
	return exitCode === 0 ? "completed" : "failed";
}

function resultDuration(result: Record<string, unknown>): number | undefined {
	const durationMs = result.durationMs;
	return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
}

function asyncJobId(details: Record<string, unknown>): string | undefined {
	const asyncDetails = details.async;
	if (!asyncDetails || typeof asyncDetails !== "object") return undefined;
	return stringValue((asyncDetails as Record<string, unknown>).jobId);
}

function uniquePendingSpawnForAgent(state: RouterState, agent: string, jobId?: string): SpawnState | undefined {
	const matches = [...state.spawns.values()].filter(spawn => {
		if (spawn.recordedOutcome || spawn.agent !== agent) return false;
		return jobId === undefined || spawn.jobId === undefined || spawn.jobId === jobId;
	});
	return matches.length === 1 ? matches[0] : undefined;
}

function modelSelectorBase(spec: string): string {
	const separator = spec.lastIndexOf(":");
	if (separator <= spec.indexOf("/")) return spec;
	return spec.slice(0, separator);
}

const THINKING_EFFORT_SUFFIXES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function modelEffortOf(spec: string | undefined): string | undefined {
	if (!spec) return undefined;
	const separator = spec.lastIndexOf(":");
	if (separator <= spec.indexOf("/")) return undefined;
	const suffix = spec
		.slice(separator + 1)
		.trim()
		.toLowerCase();
	return (THINKING_EFFORT_SUFFIXES as readonly string[]).includes(suffix) ? suffix : undefined;
}

function modelSelectorsDiffer(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	return modelSelectorBase(left) !== modelSelectorBase(right);
}

function takeFallbackReason(
	state: RouterState,
	spawn: SpawnState,
	resolvedModel: string | undefined,
	result: Record<string, unknown>,
): { fallbackReason?: string; fallbacks: OutcomeFallback[] } {
	const fallbacks: OutcomeFallback[] = [];
	if (Array.isArray(result.fallbacks)) {
		for (const raw of result.fallbacks) {
			if (!raw || typeof raw !== "object") continue;
			const item = raw as Record<string, unknown>;
			const from = stringValue(item.from),
				to = stringValue(item.to),
				at = stringValue(item.at);
			if (!from || !to || !at) continue;
			const reason = item.reason as OutcomeFallback["reason"] | undefined;
			fallbacks.push({ from, to, at, reason: reason ?? "unrecorded" });
		}
	}
	let fallbackReason = stringValue(result.fallbackReason);
	if (fallbacks.length) {
		fallbackReason ??= fallbacks
			.map(item => (typeof item.reason === "string" ? item.reason : item.reason.message))
			.join("; ");
	} else if (modelSelectorsDiffer(spawn.chosen, resolvedModel)) {
		const index = state.fallbacks.findIndex(
			fallback =>
				modelSelectorBase(fallback.from) === modelSelectorBase(spawn.chosen) &&
				modelSelectorBase(fallback.to) === modelSelectorBase(resolvedModel!) &&
				(fallback.role === "fallback" || fallback.role === `subagent:${spawn.spawnKey}`),
		);
		if (index !== -1) fallbackReason ??= state.fallbacks.splice(index, 1)[0]?.reason;
		fallbackReason ??= "unrecorded";
	} else if (resolvedModel) {
		const chosenEffort = modelEffortOf(spawn.chosen);
		const resolvedEffort = modelEffortOf(resolvedModel);
		if (chosenEffort !== undefined && chosenEffort !== resolvedEffort) {
			const at = new Date().toISOString();
			const reason = `effort_clamp:${chosenEffort}->${resolvedEffort ?? "default"}`;
			fallbacks.push({ from: spawn.chosen, to: resolvedModel, at, reason });
			fallbackReason ??= reason;
		}
	}
	return { fallbackReason, fallbacks };
}

export function recordRetryFallbackApplied(
	event: RetryFallbackAppliedEvent,
	state: RouterState,
	options: { now?: () => Date } = {},
): FallbackRecord | undefined {
	const from = stringValue(event.from);
	const to = stringValue(event.to);
	const role = stringValue(event.role);
	if (!from || !to || !role) return undefined;
	const record: FallbackRecord = {
		from,
		to,
		role,
		at: (options.now ?? (() => new Date()))().toISOString(),
		...(stringValue(event.reason) ? { reason: stringValue(event.reason) } : {}),
	};
	state.fallbacks.push(record);
	return record;
}

export function recordAndNotifyRetryFallbackApplied(
	event: RetryFallbackAppliedEvent,
	ctx: ExtensionContext,
	state: RouterState,
	options: { now?: () => Date } = {},
): FallbackRecord | undefined {
	const record = recordRetryFallbackApplied(event, state, options);
	if (!record) return undefined;
	const reason = record.reason ? `; ${record.reason}` : "";
	ctx.ui?.notify?.(`routed: actual model ${record.to} (fallback from ${record.from}${reason})`, "warning");
	return record;
}

export async function recordTaskOutcome(
	event: ToolResultEvent,
	ctx: ExtensionContext,
	state: RouterState,
	options: RecordOutcomeOptions = {},
): Promise<OutcomeRecord[]> {
	if (event.toolName === "wait") {
		const details = event.details;
		if (!details || typeof details !== "object") return [];
		const jobs = (details as Record<string, unknown>).jobs;
		if (!Array.isArray(jobs)) return [];
		const rows: OutcomeRecord[] = [];
		for (const raw of jobs) {
			if (!raw || typeof raw !== "object") continue;
			const job = raw as Record<string, unknown>;
			const id = stringValue(job.id);
			const status = job.status;
			const durationMs = resultDuration(job);
			if (!id || !["completed", "failed", "cancelled"].includes(String(status)) || durationMs === undefined)
				continue;
			const matching = [...state.spawns.values()].filter(spawn => spawn.spawnKey === id && !spawn.recordedOutcome);
			if (matching.length !== 1) continue;
			const spawn = matching[0]!;
			spawn.recordedOutcome = true;
			const resolvedModel = stringValue(job.resolvedModel);
			const { fallbackReason, fallbacks } = takeFallbackReason(state, spawn, resolvedModel, job);
			recordFailingFallbackCooldowns(ctx, fallbacks);
			if (status === "failed")
				await markAuthDeadAfterFailure(
					ctx,
					state,
					spawn,
					resolvedModel,
					job,
					options.now ?? (() => new Date()),
					options,
				);
			const record: OutcomeRecord = {
				kind: "outcome",
				spawnKey: spawn.spawnKey,
				jobId: id,
				at: (options.now ?? (() => new Date()))().toISOString(),
				sessionId: sessionId(ctx) ?? spawn.sessionId,
				agent: spawn.agent,
				chosen: spawn.chosen,
				order: spawn.order,
				status: status as OutcomeRecord["status"],
				durationMs,
				...(resolvedModel ? { resolvedModel } : {}),
				...(stringValue(job.firstTurnModel) ? { firstTurnModel: stringValue(job.firstTurnModel) } : {}),
				...(fallbacks.length ? { fallbacks } : {}),
				...(fallbackReason ? { fallbackReason } : {}),
			};
			appendJsonl(options.stateFile ?? defaultStateFile(), record);
			rows.push(record);
		}
		return rows;
	}
	if (event.toolName !== "task") return [];
	const details = event.details;
	if (!details || typeof details !== "object") return [];
	const detailRecord = details as Record<string, unknown>;
	const results = Array.isArray(detailRecord.results) ? detailRecord.results : [];
	const jobId = asyncJobId(detailRecord);
	const rows: OutcomeRecord[] = [];

	for (const raw of results) {
		if (!raw || typeof raw !== "object") continue;
		const result = raw as Record<string, unknown>;
		const agent = stringValue(result.agent);
		const durationMs = resultDuration(result);
		if (!agent || durationMs === undefined) continue;
		const spawn = uniquePendingSpawnForAgent(state, agent, jobId);
		if (!spawn) continue;
		if (jobId && !spawn.jobId) spawn.jobId = jobId;
		spawn.recordedOutcome = true;
		const resolvedModel = stringValue(result.resolvedModel);
		const { fallbackReason, fallbacks } = takeFallbackReason(state, spawn, resolvedModel, result);
		recordFailingFallbackCooldowns(ctx, fallbacks);
		if (statusFromResult(result, event.isError === true) === "failed")
			await markAuthDeadAfterFailure(
				ctx,
				state,
				spawn,
				resolvedModel,
				result,
				options.now ?? (() => new Date()),
				options,
			);
		const record: OutcomeRecord = {
			kind: "outcome",
			spawnKey: spawn.spawnKey,
			...(spawn.jobId ? { jobId: spawn.jobId } : {}),
			at: (options.now ?? (() => new Date()))().toISOString(),
			sessionId: sessionId(ctx) ?? spawn.sessionId,
			agent,
			chosen: spawn.chosen,
			order: spawn.order,
			status: statusFromResult(result, event.isError === true),
			durationMs,
			...(resolvedModel ? { resolvedModel } : {}),
			...(stringValue(result.firstTurnModel) ? { firstTurnModel: stringValue(result.firstTurnModel) } : {}),
			...(fallbacks.length ? { fallbacks } : {}),
			...(fallbackReason ? { fallbackReason } : {}),
		};
		appendJsonl(options.stateFile ?? defaultStateFile(), record);
		rows.push(record);
	}

	return rows;
}

/**
 * Background jobs deliver their result as an `async-result` custom message, not as a
 * `task`/`wait` tool result, so a fast failure nobody waited on never reached
 * recordTaskOutcome (AuditR22ScmBody, 457 ms). Replay the delivery as a `wait` result.
 */
export async function recordAsyncResultOutcome(
	message: unknown,
	ctx: ExtensionContext,
	state: RouterState,
	options: RecordOutcomeOptions = {},
): Promise<OutcomeRecord[]> {
	if (!message || typeof message !== "object") return [];
	const custom = message as Record<string, unknown>;
	if (custom.role !== "custom" || custom.customType !== "async-result") return [];
	const details = custom.details;
	const jobs = details && typeof details === "object" ? (details as Record<string, unknown>).jobs : undefined;
	if (!Array.isArray(jobs)) return [];
	const content =
		typeof custom.content === "string"
			? custom.content
			: Array.isArray(custom.content)
				? custom.content
						.map(part =>
							part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
								? (part as { text: string }).text
								: "",
						)
						.join("\n")
				: "";
	const synthetic: Record<string, unknown>[] = [];
	for (const raw of jobs) {
		if (!raw || typeof raw !== "object") continue;
		const job = raw as Record<string, unknown>;
		const id = stringValue(job.jobId);
		if (!id) continue;
		const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const segment =
			content.match(new RegExp(`<task-result id="${escaped}"[\\s\\S]*?(?:</task-result>|$)`))?.[0] ?? content;
		synthetic.push({
			id,
			status: job.status,
			durationMs: job.durationMs,
			...(job.status === "failed" ? { error: segment } : {}),
		});
	}
	if (synthetic.length === 0) return [];
	return recordTaskOutcome({ toolName: "wait", details: { jobs: synthetic } }, ctx, state, options);
}

export interface RecordOutcomeOptions {
	stateFile?: string;
	now?: () => Date;
}

export async function recordTaskOutcome(
	event: ToolResultEvent,
	ctx: ExtensionContext,
	state: RouterState,
	options: RecordOutcomeOptions = {},
): Promise<OutcomeRecord[]> {
	if (event.toolName === "wait") {
		const details = event.details;
		if (!details || typeof details !== "object") return [];
		const jobs = (details as Record<string, unknown>).jobs;
		if (!Array.isArray(jobs)) return [];
		const rows: OutcomeRecord[] = [];
		for (const raw of jobs) {
			if (!raw || typeof raw !== "object") continue;
			const job = raw as Record<string, unknown>;
			const id = stringValue(job.id);
			const status = job.status;
			const durationMs = resultDuration(job);
			if (!id || !["completed", "failed", "cancelled"].includes(String(status)) || durationMs === undefined)
				continue;
			const matching = [...state.spawns.values()].filter(spawn => spawn.spawnKey === id && !spawn.recordedOutcome);
			if (matching.length !== 1) continue;
			const spawn = matching[0]!;
			spawn.recordedOutcome = true;
			const resolvedModel = stringValue(job.resolvedModel);
			const { fallbackReason, fallbacks } = takeFallbackReason(state, spawn, resolvedModel, job);
			const record: OutcomeRecord = {
				kind: "outcome",
				spawnKey: spawn.spawnKey,
				jobId: id,
				at: (options.now ?? (() => new Date()))().toISOString(),
				sessionId: sessionId(ctx) ?? spawn.sessionId,
				agent: spawn.agent,
				chosen: spawn.chosen,
				order: spawn.order,
				status: status as OutcomeRecord["status"],
				durationMs,
				...(resolvedModel ? { resolvedModel } : {}),
				...(stringValue(job.firstTurnModel) ? { firstTurnModel: stringValue(job.firstTurnModel) } : {}),
				...(fallbacks.length ? { fallbacks } : {}),
				...(fallbackReason ? { fallbackReason } : {}),
			};
			appendJsonl(options.stateFile ?? defaultStateFile(), record);
			rows.push(record);
		}
		return rows;
	}
	if (event.toolName !== "task") return [];
	const details = event.details;
	if (!details || typeof details !== "object") return [];
	const detailRecord = details as Record<string, unknown>;
	const results = Array.isArray(detailRecord.results) ? detailRecord.results : [];
	const jobId = asyncJobId(detailRecord);
	const rows: OutcomeRecord[] = [];

	for (const raw of results) {
		if (!raw || typeof raw !== "object") continue;
		const result = raw as Record<string, unknown>;
		const agent = stringValue(result.agent);
		const durationMs = resultDuration(result);
		if (!agent || durationMs === undefined) continue;
		const spawn = uniquePendingSpawnForAgent(state, agent, jobId);
		if (!spawn) continue;
		if (jobId && !spawn.jobId) spawn.jobId = jobId;
		spawn.recordedOutcome = true;
		const resolvedModel = stringValue(result.resolvedModel);
		const { fallbackReason, fallbacks } = takeFallbackReason(state, spawn, resolvedModel, result);
		const record: OutcomeRecord = {
			kind: "outcome",
			spawnKey: spawn.spawnKey,
			...(spawn.jobId ? { jobId: spawn.jobId } : {}),
			at: (options.now ?? (() => new Date()))().toISOString(),
			sessionId: sessionId(ctx) ?? spawn.sessionId,
			agent,
			chosen: spawn.chosen,
			order: spawn.order,
			status: statusFromResult(result, event.isError === true),
			durationMs,
			...(resolvedModel ? { resolvedModel } : {}),
			...(stringValue(result.firstTurnModel) ? { firstTurnModel: stringValue(result.firstTurnModel) } : {}),
			...(fallbacks.length ? { fallbacks } : {}),
			...(fallbackReason ? { fallbackReason } : {}),
		};
		appendJsonl(options.stateFile ?? defaultStateFile(), record);
		rows.push(record);
	}

	return rows;
}

/**
 * Background jobs deliver their result as an `async-result` custom message, not as a
 * `task`/`wait` tool result, so a fast failure nobody waited on never reached
 * recordTaskOutcome (AuditR22ScmBody, 457 ms). Replay the delivery as a `wait` result.
 */
export async function recordAsyncResultOutcome(
	message: unknown,
	ctx: ExtensionContext,
	state: RouterState,
	options: RecordOutcomeOptions = {},
): Promise<OutcomeRecord[]> {
	if (!message || typeof message !== "object") return [];
	const custom = message as Record<string, unknown>;
	if (custom.role !== "custom" || custom.customType !== "async-result") return [];
	const details = custom.details;
	const jobs = details && typeof details === "object" ? (details as Record<string, unknown>).jobs : undefined;
	if (!Array.isArray(jobs)) return [];
	const content =
		typeof custom.content === "string"
			? custom.content
			: Array.isArray(custom.content)
				? custom.content
						.map(part =>
							part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
								? (part as { text: string }).text
								: "",
						)
						.join("\n")
				: "";
	const synthetic: Record<string, unknown>[] = [];
	for (const raw of jobs) {
		if (!raw || typeof raw !== "object") continue;
		const job = raw as Record<string, unknown>;
		const id = stringValue(job.jobId);
		if (!id) continue;
		const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const segment =
			content.match(new RegExp(`<task-result id="${escaped}"[\\s\\S]*?(?:</task-result>|$)`))?.[0] ?? content;
		synthetic.push({
			id,
			status: job.status,
			durationMs: job.durationMs,
			...(job.status === "failed" ? { error: segment } : {}),
		});
	}
	if (synthetic.length === 0) return [];
	return recordTaskOutcome({ toolName: "wait", details: { jobs: synthetic } }, ctx, state, options);
}

export default function agentRouter(pi: ExtensionAPI) {
	const state = createRouterState();
	const announcedGuardSessions = new Set<string>();
	pi.setLabel?.("Agent Router");
	pi.on("tool_call", (event, ctx) => fileToolRefusal(event, ctx));
	pi.on("session_start", (_event, ctx) => {
		const sessionKey = sessionId(ctx) ?? ctx.cwd ?? "unknown-session";
		if (announcedGuardSessions.has(sessionKey)) return;
		announcedGuardSessions.add(sessionKey);
		pi.sendMessage?.(
			{
				customType: "agent-router-write-guard-notice",
				content: prompt.render(gateNotices, { fileWrites: true, repo: cwdRepoLabel(ctx) }).trim(),
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "aside", triggerTurn: false, interruptWait: false },
		);
	});
	pi.on("before_subagent_spawn", (event, ctx) =>
		routeSubagentSpawn(event as BeforeSubagentSpawnEvent, ctx, state, {
			latestTodo: pi.pi?.getLatestTodoPhasesFromEntries,
		}),
	);
	pi.on("retry_fallback_applied", (event, ctx) => {
		recordAndNotifyRetryFallbackApplied(event as RetryFallbackAppliedEvent, ctx, state);
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "task" && event.isError !== true && event.details && typeof event.details === "object") {
			const details = event.details as { progress?: unknown; async?: { state?: unknown } };
			if (details.async?.state === "running" && Array.isArray(details.progress)) {
				for (const item of details.progress) {
					if (!item || typeof item !== "object") continue;
					const progress = item as { id?: unknown; status?: unknown };
					if (progress.status !== "running" || typeof progress.id !== "string") continue;
					const spawn = [...state.spawns.values()].find(candidate => candidate.spawnKey === progress.id);
					if (!spawn || spawn.recordedOutcome || spawn.writerNoticeSent || !WRITE_CAPABLE_WORKERS.has(spawn.agent))
						continue;
					spawn.writerNoticeSent = true;
					pi.sendMessage?.(
						{
							customType: "agent-router-active-writer-notice",
							content: prompt
								.render(gateNotices, { writer: true, agent: spawn.agent, worker: spawn.spawnKey })
								.trim(),
							display: false,
							attribution: "agent",
						},
						{ deliverAs: "aside", triggerTurn: false, interruptWait: false },
					);
				}
			}
		}
		void recordTaskOutcome(event as ToolResultEvent, ctx, state);
	});
	pi.on("message_end", (event, ctx) => {
		void recordAsyncResultOutcome((event as { message?: unknown }).message, ctx, state);
	});
	registerBrrrrCommand(pi);
}

/** `/brrrr`: per-session "fast and reliable, paid allowed" preset, applied through core session presets. */
function registerBrrrrCommand(pi: ExtensionAPI) {
	const presets = pi as unknown as Partial<{
		applySessionModelPreset(name: string): Promise<ModelPresetSwitchResult>;
		clearSessionModelPreset(): string | undefined;
	}>;
	pi.registerCommand?.("brrrr", {
		description: "Apply the brrrr model preset to this session; /brrrr off clears it",
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (argument !== "" && argument !== "off") {
				ctx.ui.notify("Usage: /brrrr [off]", "warning");
				return;
			}
			if (!presets.applySessionModelPreset || !presets.clearSessionModelPreset) {
				ctx.ui.notify("brrrr: session model presets are unavailable in this build", "warning");
				return;
			}
			if (argument === "off") {
				const cleared = presets.clearSessionModelPreset();
				ctx.ui.notify(cleared ? `brrrr off (cleared session preset ${cleared})` : "brrrr was not active", "info");
				return;
			}
			const result = await presets.applySessionModelPreset("brrrr");
			const reason = "reason" in result ? result.reason : undefined;
			ctx.ui.notify(
				result.kind === "switched"
					? "brrrr on"
					: `brrrr: preset not applied (${result.kind}${reason ? `: ${reason}` : ""})`,
				result.kind === "switched" ? "info" : "warning",
			);
		},
	});
}
