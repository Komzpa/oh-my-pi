// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { todoInfraBreaker } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { appendFileSync, chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { randomInt } from "node:crypto";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ModelPresetSwitchResult } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { getLiveTodoBranchEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { validateTodoExecutorRow } from "@oh-my-pi/pi-coding-agent/tools/todo-executor";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import { workerYieldRefusal, type WorkerContinuationState } from "./worker_continue";
import resourceClaimInstructions from "./resource-claim-refusal.md" with { type: "text" };
import gateNotices from "./gate-notices.md" with { type: "text" };
import { shortenPath, truncateMiddleToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import {
	workerToolPreflight,
	holdsWriteCustody,
	workerRowScope,
	workerScopeCovers,
	fileToolTargets,
	type HostResourceProbes,
} from "./dispatch_preflight";
import { visionToolRefusal, visionResultRefusal } from "./vision_gate";
import {
	readOnlyClaim,
	readOnlyRow,
	checkoutScopesFromResources,
	checkoutScopesOverlap,
	checkoutScopesContain,
} from "./checkout_scope";

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
	"rebaser",
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

function grantedResources(event: BeforeSubagentSpawnEvent): string[] | undefined {
	if (Array.isArray(event.resources)) return event.resources;
	if (Array.isArray(event.verifiedWorkspace?.resources)) return event.verifiedWorkspace.resources;
	const cwd = event.workspace && stringValue(event.verifiedWorkspace?.cwd);
	return cwd ? [cwd] : undefined;
}

function ownedCheckoutScopes(
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
	latestTodo?: () => TodoScheduleInput,
): string[] | undefined {
	const granted = grantedResources(event);
	if (granted) return checkoutScopesFromResources(granted) ?? [];
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
					if (!Array.isArray(row.schedule?.resources)) {
						complete = false;
						break;
					}
					for (const scope of checkoutScopesFromResources(row.schedule.resources) ?? []) scopes.add(scope);
				}
				if (complete) return [...scopes].sort();
			}
		} catch {
			// Fall through to the explicitly matched row or child checkout.
		}
	}
	if (typeof event.row === "string") {
		const row = readPhases()
			?.flatMap(phase => phase.tasks)
			.find(item => item.content === event.row);
		if (Array.isArray(row?.schedule?.resources)) return checkoutScopesFromResources(row.schedule.resources) ?? [];
	}
	const cwd = stringValue(event.cwd);
	return cwd ? (checkoutScopesFromResources([cwd]) ?? []) : (sessionCwdScopes(ctx) ?? []);
}

function activeWriteWorker(
	state: RouterState,
	ctx: ExtensionContext,
	checkoutScopes?: string[],
	latestTodo?: () => TodoScheduleInput,
): SpawnState | undefined {
	const runningJobs = ctx.getAsyncJobSnapshot?.()?.running ?? [];
	const cwdFallback: string[] = [];
	const incoming = checkoutScopes ?? cwdFallback;
	return [...state.spawns.values()].find(spawn => {
		if (
			spawn.recordedOutcome ||
			spawn.isolated ||
			spawn.readOnly === true ||
			(spawn.readOnly !== false && !WRITE_CAPABLE_WORKERS.has(spawn.agent))
		)
			return false;
		let phases: TodoScheduleInput | undefined;
		try {
			phases = latestTodo?.();
		} catch {
			/* Keep the recorded scope when the plan is unavailable. */
		}
		const rows = phases
			?.flatMap(phase => phase.tasks)
			.filter(
				row => row.status !== "completed" && row.status !== "abandoned" && row.schedule?.owner === spawn.spawnKey,
			);
		if (rows?.length && spawn.dynamicRowScope)
			spawn.checkoutScopes = checkoutScopesFromResources(rows.flatMap(row => row.schedule?.resources ?? []));
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
	readOnly?: boolean;
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
	dynamicRowScope?: boolean;
}

export interface RouterState {
	spawns: Map<string, SpawnState>;
	fallbacks: FallbackRecord[];
}
export interface BeforeSubagentSpawnEvent {
	phase?: "admission";
	agent?: unknown;
	spawnKey?: unknown;
	patterns?: unknown;
	isolated?: unknown;
	assignment?: unknown;
	context?: unknown;
	resources?: unknown;
	workspace?: unknown;
	verifiedWorkspace?: { cwd?: unknown; resources?: string[] };
	readOnly?: boolean;
	row?: string;
	cwd?: unknown;
	worktree?: unknown;
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
	if (!ctx.getTodoPhases && (!getter || !ctx.sessionManager)) return undefined;
	let cached: TodoScheduleInput | undefined;
	return () =>
		(cached ??=
			ctx.getTodoPhases?.() ??
			(getter && ctx.sessionManager ? getter(getLiveTodoBranchEntries(ctx.sessionManager)) : []));
}

export function resourceScopeNotice(worker: string, action: unknown): string {
	return prompt.render(gateNotices, { scopeRequest: true, worker, action: JSON.stringify(action) }).trim();
}

export async function requestResourceScope(ctx: ExtensionContext, paths: string[], pending = new Set<string>()) {
	if (!paths.length || paths.some(target => !target.startsWith("/")))
		return { status: "invalid", reason: "Use absolute paths." };
	if (await workerScopeCovers(ctx, paths)) {
		for (const target of paths) {
			const refusal = await workerToolPreflight({ toolName: "write", input: { path: target } }, ctx);
			if (refusal) return { status: "conflict", reason: refusal.reason };
		}
		return { status: "granted", paths };
	}
	const scope = workerRowScope(ctx);
	if (!scope?.lead.session || !scope.rows.length)
		return { status: "unavailable", reason: "No canonical lead row found." };
	const updates = scope.rows.map(row => ({
		task: row.content,
		resources: [...new Set([...(row.schedule?.resources ?? []), ...paths])],
	}));
	const action = { op: "schedule", updates };
	const key = JSON.stringify(action);
	if (!pending.has(key)) {
		pending.add(key);
		try {
			await scope.lead.session.steer(resourceScopeNotice(ctx.agent?.id ?? "worker", action), undefined, {
				attribution: "agent",
			});
		} catch (error) {
			pending.delete(key);
			throw error;
		}
	}
	return {
		status: "pending",
		lead: scope.lead.id,
		action,
		next: 'Yield with error:"Scope pending: awaiting the lead todo schedule action"; the lead must schedule these resources before retrying. Do not repeat the request.',
	};
}

/** Persist only caller-assigned paths, after canonical overlap checks, before any worker starts. */
export function admitAssignedResources(
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
	persist = true,
	onWait?: (holder: { row: string; workerId?: string }) => void,
): string | undefined {
	const explicit = Array.isArray(event.resources);
	if (explicit && event.resources.some(value => typeof value !== "string" || !value.startsWith("/")))
		return "resources must contain absolute paths; use tasks[].resources to narrow the row.";
	const grant = grantedResources(event);
	const assigned = [...new Set(grant ?? [])];
	const scopes = checkoutScopesFromResources(assigned);
	if (assigned.length && !scopes) return "Cannot resolve assigned resources.";
	if (ctx.agent?.kind === "sub") {
		const inherited = workerRowScope(ctx);
		const allowed = checkoutScopesFromResources(inherited?.rows.flatMap(row => row.schedule?.resources ?? []));
		if (scopes && (!allowed || !checkoutScopesContain(allowed, scopes)))
			return `Nested worker assignment exceeds its parent's row resources; call resource_scope {paths:[<absolute path>]} in this worker, then yield with error:"Scope pending: awaiting lead schedule".`;
		return;
	}
	const phases = ctx.getTodoPhases?.() ?? [];
	const rows = phases
		.flatMap(phase => phase.tasks)
		.filter(row => row.status !== "completed" && row.status !== "abandoned");
	const matched = rows.filter(
		row =>
			(typeof event.spawnKey === "string" &&
				(row.schedule?.owner === event.spawnKey || row.schedule?.executor?.workerId === event.spawnKey)) ||
			row.content === event.row,
	);
	if (matched.length !== 1) return;
	const row = matched[0];
	if (row.status === "blocked" && todoInfraBreaker(row.schedule?.attemptHistory))
		return row.blocker ?? "Infra breaker: inspect todo history and repair admission before unblocking this row.";
	const previous = checkoutScopesFromResources(
		row.schedule?.resources?.filter(resource => !resource.startsWith("git:")),
	);
	const workspaceDefault = !explicit && Boolean(event.workspace && event.verifiedWorkspace?.cwd);
	if (
		!workspaceDefault &&
		Array.isArray(row.schedule?.resources) &&
		scopes &&
		(!previous || !checkoutScopesContain(previous, scopes))
	)
		return `resources exceed row ${JSON.stringify(row.content)}; update its todo schedule resources before expanding.`;
	const readOnly = event.readOnly === true || readOnlyRow(row);
	// An empty reader write claim must not erase the row's artifact/audit scope.
	const resources =
		readOnly && grant?.length === 0
			? [...(row.schedule?.resources ?? [])]
			: grant !== undefined
				? [
						...new Set([
							...assigned,
							...(row.schedule?.resources ?? []).filter(resource => resource.startsWith("git:")),
						]),
					]
				: [...new Set([...(row.schedule?.resources ?? []), ...assigned])];
	const incoming = checkoutScopesFromResources(resources.filter(resource => !resource.startsWith("git:")));
	for (const other of rows) {
		if (other === row || readOnly || !holdsWriteCustody(other)) continue;
		const held = checkoutScopesFromResources(
			other.schedule?.resources?.filter(resource => !resource.startsWith("git:")),
		);
		if (incoming && held && checkoutScopesOverlap(incoming, held)) {
			onWait?.({ row: other.content, workerId: other.schedule?.executor?.workerId ?? other.schedule?.owner });
			return `resources ${JSON.stringify(
				resources.filter(resource => {
					const scope = checkoutScopesFromResources([resource]);
					return scope && checkoutScopesOverlap(scope, held);
				}),
			)} held by row ${JSON.stringify(other.content)} (owner ${other.schedule?.owner ?? other.schedule?.executor?.workerId ?? "unassigned"}); narrow tasks[].resources to disjoint absolute paths within the row, or wait for its writer. ${prompt.render(resourceClaimInstructions, { row: other.content, owner: other.schedule?.owner ?? other.schedule?.executor?.workerId }).trim()}`;
		}
	}
	const owner = stringValue(event.spawnKey) ?? row.schedule?.owner;
	const ownerReadOnly = owner ? { owner, readOnly } : undefined;
	if (
		persist &&
		(JSON.stringify(resources) !== JSON.stringify(row.schedule?.resources ?? []) ||
			owner !== row.schedule?.owner ||
			JSON.stringify(ownerReadOnly) !== JSON.stringify(row.schedule?.ownerReadOnly)) &&
		ctx.updateTodoSchedule?.(row.content, { resources, owner, ownerReadOnly }) !== true
	)
		return "Could not persist assigned row resources; retry dispatch after updating the row.";
}

/** Inspect the same admission policy for notices without changing row ownership. */
export function assignedResourceRefusals(phases: TodoScheduleInput, ctx: ExtensionContext): Map<string, string> {
	const view = { ...ctx, getTodoPhases: () => phases };
	return new Map(
		phases
			.flatMap(phase => phase.tasks)
			.filter(row => row.status !== "completed" && row.status !== "abandoned")
			.flatMap(row => {
				const reason = admitAssignedResources({ row: row.content, task: row.content }, view, false);
				return reason ? [[row.content, reason] as const] : [];
			}),
	);
}

export function routeSubagentSpawn(
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
	state = createRouterState(),
	options: {
		stateFile?: string;
		now?: () => Date;
		latestTodo?: LatestTodoGetter;
	} = {},
): { block?: true; reason: string; resourceWait?: { row: string; workerId?: string } } | undefined {
	const agent = stringValue(event.agent);
	if (!agent) return undefined;
	if (typeof event.row === "string") {
		const phases = ctx.getTodoSnapshot?.() ?? ctx.getTodoPhases?.() ?? [];
		const invalid = validateTodoExecutorRow(phases, event.row);
		if (invalid) return { block: true, reason: invalid };
		const row = phases.flatMap(phase => phase.tasks).find(row => row.content === event.row)!;
		if (event.phase !== "admission" && row.schedule?.owner && row.schedule.owner !== event.spawnKey)
			return { block: true, reason: `Task row ${JSON.stringify(event.row)} was reassigned before execution.` };
	}
	let resourceWait: { row: string; workerId?: string } | undefined;
	const admission = admitAssignedResources(event, ctx, true, holder => {
		resourceWait = holder;
	});
	if (admission)
		return resourceWait && event.phase === "admission"
			? { resourceWait, reason: admission }
			: { block: true, reason: admission };
	const latestTodo = memoLatestTodo(options.latestTodo, ctx);
	const claimsCheckout = event.isolated !== true || Boolean(event.verifiedWorkspace?.cwd);
	const checkoutScopes =
		event.readOnly !== true && claimsCheckout ? ownedCheckoutScopes(event, ctx, latestTodo) : undefined;
	// git-pr-owner only runs VCS finalization (commit/PR/push), sequenced by the
	// caller after a coder's edits land. Blocking it on a still-"running" coder
	// deadlocks the commit-after-write flow the gate is meant to serialize, so
	// the gate covers file-writing spawns and an active git-pr-owner still
	// blocks later writers via its recorded scopes — the exemption is incoming
	// only. Simpler alternatives (per-file overlap checks, completion-aware
	// "files are done" detection) need edit-intent tracking the spawn event
	// does not carry.
	if (
		event.readOnly !== true &&
		(event.readOnly === false || WRITE_CAPABLE_WORKERS.has(agent)) &&
		agent !== "git-pr-owner" &&
		claimsCheckout
	) {
		const activeWriter = activeWriteWorker(state, ctx, checkoutScopes, latestTodo);
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
	if (event.phase === "admission") return;
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
		readOnly: event.readOnly,
		chosen: order[0] ?? "",
		order,
		...(event.isolated === true ? { isolated: true } : {}),
		...(checkoutScopes?.length ? { checkoutScopes } : {}),
	};
	state.spawns.set(recordKey(spawnKey, agent), {
		...record,
		isolated: event.isolated === true && !event.verifiedWorkspace?.cwd,
		dynamicRowScope: grantedResources(event) === undefined,
		recordedOutcome: false,
	});
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

/** The yield gate answers inside this budget, below the host's 30 s extension handler timeout, so
 * a slow check (git status on a large worktree under load) never turns a finished worker's yield
 * into a timeout block that discards its completed result. */
export const YIELD_GATE_BUDGET_MS = 20_000;
export const SLOW_YIELD_GATE_ENTRY = "agent-router-slow-yield-gate";
export interface AgentRouterOptions {
	yieldGateBudgetMs?: number;
	yieldGate?: typeof workerYieldRefusal;
}

export default function agentRouter(pi: ExtensionAPI, probes?: HostResourceProbes, options: AgentRouterOptions = {}) {
	const state = createRouterState();
	const announcedGuardSessions = new Set<string>();
	pi.setLabel?.("Agent Router");
	const continuedWorkers = new Map<string, WorkerContinuationState>();
	const pendingScopes = new Set<string>();
	if (pi.zod && pi.registerTool)
		pi.registerTool({
			name: "resource_scope",
			label: "Resource scope",
			loadMode: "essential",
			description:
				"Request write scope for absolute paths. Already assigned paths are granted immediately; new paths become a ready lead action.",
			parameters: pi.zod.object({ paths: pi.zod.array(pi.zod.string()).min(1) }),
			async execute(_id, input, _signal, _update, ctx) {
				const result = await requestResourceScope(ctx, input.paths, pendingScopes);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});
	pi.on("tool_call", async (event, ctx) => {
		const vision = await visionToolRefusal(event, ctx);
		if (vision) return vision;
		const preflight = await workerToolPreflight(event, ctx, probes);
		if (preflight) return preflight;
		if (event.toolName === "yield" && ctx.agent?.kind === "sub") {
			// A delivered scope request has no local work left: report it once to the lead.
			// The ordinary completion gate would otherwise demand evidence for an edit
			// the resource gate has just forbidden.
			if (
				pendingScopes.size &&
				typeof event.input?.error === "string" &&
				event.input.error.startsWith("Scope pending:")
			)
				return undefined;
			const budgetMs = options.yieldGateBudgetMs ?? YIELD_GATE_BUDGET_MS;
			const startedAt = Date.now();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const slow = Symbol("slow-yield-gate");
			const gate = (options.yieldGate ?? workerYieldRefusal)(event.input, ctx, continuedWorkers, event.toolCallId);
			const decision = await Promise.race([
				gate,
				new Promise<typeof slow>(resolveSlow => {
					timer = setTimeout(() => resolveSlow(slow), budgetMs);
					(timer as { unref?: () => void }).unref?.();
				}),
			]).finally(() => clearTimeout(timer));
			if (decision === slow) {
				// Fail open: the worker's result stands. Record the slow check for diagnosis.
				gate.catch(() => undefined);
				pi.appendEntry?.(SLOW_YIELD_GATE_ENTRY, {
					agent: ctx.agent.name,
					agentId: ctx.agent.id,
					toolCallId: event.toolCallId,
					budgetMs,
					elapsedMs: Date.now() - startedAt,
					at: Date.now(),
				});
				return undefined;
			}
			if (decision) return decision;
		}
		return fileToolRefusal(event, ctx);
	});
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
	pi.on("before_subagent_spawn", (event, ctx) => {
		return routeSubagentSpawn(event as BeforeSubagentSpawnEvent, ctx, state, {
			latestTodo: pi.pi?.getLatestTodoPhasesFromEntries,
		});
	});
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
		return visionResultRefusal(event, ctx);
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
