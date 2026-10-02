// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomInt } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { ModelUsageHealth, ModelUsageHealthState } from "@oh-my-pi/pi-ai";
import { resolveXiaomiRequestBaseUrl } from "@oh-my-pi/pi-ai/registry/oauth/xiaomi";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { checkoutScopesFromResources, checkoutScopesOverlap } from "./checkout_scope";

export interface PoolConfig {
	pool: string[];
	fallbacks: string[];
}

// Pool lengths are routing policy; model selectors and fallback order live in agent frontmatter.
const POOL_SIZES: Record<string, number> = {
	coder: 6,
	"ui-coder": 4,
	scout: 3,
	"gate-runner": 3,
	"git-pr-owner": 3,
	scribe: 3,
	reviewer: 3,
	workhorse: 4,
	"retro-facilitator": 3,
	architect: 4,
	"plan-doctor": 3,
	"security-reviewer": 0,
	"coder-strong": 0,
	"ui-coder-strong": 0,
	researcher: 1,
	"business-analyst": 3,
	creative: 2,
};

const WRITE_CAPABLE_WORKERS = new Set([
	"coder",
	"coder-strong",
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

function ownedCheckoutScopes(
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
	latestTodo?: LatestTodoGetter,
): string[] | undefined {
	const fallback = sessionCwdScopes(ctx);
	const owner = stringValue(event.spawnKey);
	if (!owner || !latestTodo || !ctx.sessionManager?.getBranch) return fallback;
	try {
		const rows = latestTodo(ctx.sessionManager.getBranch())
			.flatMap(phase => phase.tasks)
			.filter(row => (row.status === "pending" || row.status === "in_progress") && row.schedule?.owner === owner);
		if (!rows.length) return fallback;
		const scopes = new Set<string>();
		for (const row of rows) {
			const owned = checkoutScopesFromResources(row.schedule?.resources);
			if (!owned) return fallback;
			for (const scope of owned) scopes.add(scope);
		}
		return [...scopes].sort();
	} catch {
		return fallback;
	}
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

function profilePool(agent: string, poolSize: number): PoolConfig {
	const file = new URL(`./agents/${agent}.md`, import.meta.url);
	const chain = parseAgent(file.pathname, readFileSync(file, "utf8"), "user").model;
	if (!chain?.length) throw new Error(`Missing model frontmatter for ${agent}`);
	return { pool: chain.slice(0, poolSize), fallbacks: chain.slice(poolSize) };
}

export const AGENT_POOLS: Record<string, PoolConfig> = {
	...Object.fromEntries(Object.entries(POOL_SIZES).map(([agent, size]) => [agent, profilePool(agent, size)])),
	// The built-in task agent has no package profile; retain its independent router policy.
	task: {
		pool: [
			"codex-lb/gpt-6-luna:medium",
			"kimi-code/kimi-for-coding:high",
			"deepseek/deepseek-v4-pro:high",
			"kimi-code/k3:high",
			"xiaomi/mimo-v2.6-pro",
			"muse-code/muse-spark-1.3-contributor",
		],
		fallbacks: ["codex-lb/gpt-6.1-sol:medium", "codex-lb/Qwen3.8-27B", "cerebras/qwen-3.8-27b"],
	},
};

export interface SpawnRecord {
	kind: "spawn";
	spawnKey: string;
	jobId?: string;
	at: string;
	sessionId?: string;
	agent: string;
	chosen: string;
	order: string[];
	skipped?: SkippedModelRecord[];
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
	fallbackReason?: string;
}

export interface SkippedModelRecord {
	model: string;
	reason: string;
	healthState?: ModelUsageHealthState;
	accounts?: Array<{
		state: ModelUsageHealthState;
		remainingPercent?: number;
		resetsAt?: number;
	}>;
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
}

export interface AuthProbeRecord {
	at: number;
	alive: boolean;
}

export interface RouterState {
	spawns: Map<string, SpawnState>;
	fallbacks: FallbackRecord[];
	authDead: Map<string, number>;
	authProbe: Map<string, AuthProbeRecord>;
}
export interface BeforeSubagentSpawnEvent {
	agent?: unknown;
	spawnKey?: unknown;
	patterns?: unknown;
	isolated?: unknown;
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
	return { spawns: new Map(), fallbacks: [], authDead: new Map(), authProbe: new Map() };
}

export const AUTH_DEAD_TTL_MS = 6 * 60 * 60 * 1000;
export const AUTH_PROBE_TTL_MS = 60 * 60 * 1000;

export function defaultStateFile(): string {
	return process.env.OMP_AGENT_ROUTER_STATE ?? join(homedir(), ".local/state/omp-agent-router/spawns.jsonl");
}

export function cryptoShuffle<T>(items: readonly T[]): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		[result[i], result[j]] = [result[j]!, result[i]!];
	}
	return result;
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
	const target = canonicalPath(
		requestedPath === "~" || requestedPath.startsWith("~/")
			? resolve(homedir(), requestedPath.slice(2))
			: resolve(ctx.cwd, requestedPath),
	);
	const content = typeof input.content === "string" ? input.content : "";
	if (content.length === 0) {
		return {
			block: true,
			reason: `Refusing write to ${requestedPath}: content is empty; pass replace: true to confirm intentional replacement.`,
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
		return {
			block: true,
			reason: `Refusing write to ${requestedPath}: ${newSize} bytes is under 5% of the tracked file's ${size} bytes; pass replace: true to confirm intentional replacement.`,
		};
	}
	return undefined;
}

function usageSkipRecord(spec: string, health: ModelUsageHealth): SkippedModelRecord | undefined {
	if (health.state !== "reserve" && health.state !== "depleted") return undefined;
	return {
		model: spec,
		reason: health.state === "reserve" ? "usage_reserve_reached" : "usage_depleted",
		healthState: health.state,
		accounts: health.accounts.map(account => ({
			state: account.state,
			...(account.remainingFraction === undefined
				? {}
				: { remainingPercent: Math.max(0, account.remainingFraction * 100) }),
			...(account.resetsAt === undefined ? {} : { resetsAt: account.resetsAt }),
		})),
	};
}

async function usageSkipForModel(spec: string, ctx: ExtensionContext): Promise<SkippedModelRecord | undefined> {
	const model = ctx.models?.resolve?.(spec);
	const health = ctx.modelRegistry?.authStorage?.health?.model;
	if (!model || !health) return undefined;
	try {
		// This is the same credential-pool health API that core usage-aware fallback
		// calls before the first request. Passing NaN lets auth-storage use the
		// effective auth policy reserve loaded from retry.usageReservePct.
		return usageSkipRecord(
			spec,
			await health.call(ctx.modelRegistry.authStorage.health, model.provider, {
				modelId: model.id,
				sessionId: sessionId(ctx),
				baseUrl: model.baseUrl,
				reserveFraction: Number.NaN,
			}),
		);
	} catch {
		// Core usage-aware preflight fails open when the health probe itself fails.
		return undefined;
	}
}

function authSkipRecord(spec: string, state: RouterState, nowMs: number): SkippedModelRecord | undefined {
	const deadUntil = state.authDead.get(modelSelectorBase(spec));
	if (deadUntil === undefined || deadUntil <= nowMs) {
		if (deadUntil !== undefined) state.authDead.delete(modelSelectorBase(spec));
		return undefined;
	}
	return { model: spec, reason: `auth_failed_retry_after_${new Date(deadUntil).toISOString()}` };
}

async function availablePoolMembers(
	pool: readonly string[],
	ctx: ExtensionContext,
	state?: RouterState,
	now?: () => Date,
): Promise<{ available: string[]; skipped: SkippedModelRecord[] }> {
	const nowMs = (now ?? (() => new Date()))().getTime();
	if (!ctx.models?.resolve || !ctx.models?.list) return { available: [...pool], skipped: [] };
	const authenticated = new Set(ctx.models.list().map(model => `${model.provider}/${model.id}`));
	const available: string[] = [];
	const skipped: SkippedModelRecord[] = [];
	for (const spec of pool) {
		const model = ctx.models.resolve(spec);
		if (model === undefined || !authenticated.has(`${model.provider}/${model.id}`)) continue;
		if (state) {
			const authSkip = authSkipRecord(spec, state, nowMs);
			if (authSkip) {
				skipped.push(authSkip);
				continue;
			}
		}
		const usageSkip = await usageSkipForModel(spec, ctx);
		if (usageSkip) {
			skipped.push(usageSkip);
			continue;
		}
		available.push(spec);
	}
	return { available, skipped };
}

/** True when this routed agent has at least one authenticated, non-depleted pool or fallback model now. */
export async function agentHasLiveModel(
	agent: string,
	ctx: ExtensionContext,
	state?: RouterState,
	now?: () => Date,
): Promise<boolean> {
	const config = AGENT_POOLS[agent];
	if (!config) return false;
	return (await availablePoolMembers([...config.pool, ...config.fallbacks], ctx, state, now)).available.length > 0;
}

export async function countLiveWorkerModels(
	ctx: ExtensionContext,
	state?: RouterState,
	now?: () => Date,
): Promise<number> {
	const specs = [...new Set(Object.values(AGENT_POOLS).flatMap(config => [...config.pool, ...config.fallbacks]))];
	const { available } = await availablePoolMembers(specs, ctx, state, now);
	const models = new Set(
		available.map(spec => {
			const model = ctx.models?.resolve?.(spec);
			return model ? `${model.provider}/${model.id}` : spec;
		}),
	);
	return models.size;
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

export async function routeSubagentSpawn(
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
	state = createRouterState(),
	options: {
		stateFile?: string;
		now?: () => Date;
		shuffle?: <T>(items: readonly T[]) => T[];
		latestTodo?: LatestTodoGetter;
	} = {},
): { model: string[]; note: string } | { block: true; reason: string } | undefined {
	const agent = stringValue(event.agent);
	if (!agent) return undefined;
	const config = AGENT_POOLS[agent];
	if (!config) return undefined;
	const checkoutScopes =
		WRITE_CAPABLE_WORKERS.has(agent) && event.isolated !== true
			? ownedCheckoutScopes(event, ctx, options.latestTodo)
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
			return {
				block: true,
			reason: `Refusing ${agent}: ${activeWriter.agent} worker ${activeWriter.spawnKey} is running in ${holderRepoLabel(activeWriter, ctx)}; if this row edits another repo, put that repo path in the row resources; isolated: true isolates only ${cwdRepoLabel(ctx)}.`,
			};
		}
	}
	const shuffle = options.shuffle ?? cryptoShuffle;
	const { available, skipped: poolSkipped } = await availablePoolMembers(config.pool, ctx, state, options.now);
	const { available: fallbacks, skipped: fallbackSkipped } = await availablePoolMembers(config.fallbacks, ctx, state, options.now);
	const skipped = [...poolSkipped, ...fallbackSkipped];
	const poolOrder = shuffle(available);
	const order = [...poolOrder, ...fallbacks];
	const chosen = order[0];
	if (!chosen) return undefined;

	const spawnKey = stringValue(event.spawnKey) ?? `${agent}:${Date.now()}:${randomInt(1_000_000_000)}`;
	const record: SpawnRecord = {
		kind: "spawn",
		spawnKey,
		at: (options.now ?? (() => new Date()))().toISOString(),
		sessionId: sessionId(ctx),
		agent,
		chosen,
		order,
		...(event.isolated === true ? { isolated: true } : {}),
		...(checkoutScopes ? { checkoutScopes } : {}),
		...(skipped.length > 0 ? { skipped } : {}),
	};
	state.spawns.set(recordKey(spawnKey, agent), { ...record, recordedOutcome: false });
	appendJsonl(options.stateFile ?? defaultStateFile(), record);

	const skippedNote = skipped.length > 0 ? `; skipped ${skipped.length} by usage preflight` : "";
	return { model: order, note: `pool pick ${chosen}${skippedNote} (eval)` };
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

function modelSelectorsDiffer(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	return modelSelectorBase(left) !== modelSelectorBase(right);
}

function takeFallbackReason(state: RouterState, spawn: SpawnState, resolvedModel?: string): string | undefined {
	if (!modelSelectorsDiffer(spawn.chosen, resolvedModel)) return undefined;
	const chosenBase = modelSelectorBase(spawn.chosen);
	const resolvedBase = resolvedModel ? modelSelectorBase(resolvedModel) : undefined;
	const index = state.fallbacks.findIndex(fallback => {
		const fromMatches = modelSelectorBase(fallback.from) === chosenBase;
		const toMatches = resolvedBase === undefined || modelSelectorBase(fallback.to) === resolvedBase;
		return fromMatches && toMatches;
	});
	if (index === -1) return undefined;
	const [fallback] = state.fallbacks.splice(index, 1);
	return fallback?.reason;
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

function authFailureText(payload: Record<string, unknown>): string | undefined {
	const texts: string[] = [];
	for (const key of ["error", "message", "stderr", "stdout", "output", "text", "fallbackReason"]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim() !== "") texts.push(value);
	}
	return texts.length ? texts.join("\n") : undefined;
}

function isAuthFailureText(text: string): boolean {
	if (/invalid api key/i.test(text)) return true;
	return /\b40[13]\b/.test(text) && /auth|unauthor|forbidden|invalid|api.key/i.test(text);
}

export interface AuthProbeInput {
	baseUrl: string;
	apiKey: string;
}

export type AuthProbeFn = (input: AuthProbeInput) => Promise<boolean>;

export interface RecordOutcomeOptions {
	stateFile?: string;
	now?: () => Date;
	authProbe?: AuthProbeFn;
	fetch?: typeof fetch;
}

/** Free liveness check: GET <baseUrl>/models with the same key. Alive unless 401/403. */
export async function probeModelAuthAlive(
	input: AuthProbeInput,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	let response: Response;
	try {
		response = await fetchImpl(`${input.baseUrl.replace(/\/+$/, "")}/models`, {
			headers: { Authorization: `Bearer ${input.apiKey}` },
		});
	} catch {
		return true;
	}
	return response.status !== 401 && response.status !== 403;
}

function failedModelSelector(text: string, fallback: string): string {
	const match = text.match(/\[([\w.-]+\/[\w./:-]+)\]/);
	return match?.[1] ?? fallback;
}

async function markAuthDeadAfterFailure(
	ctx: ExtensionContext,
	state: RouterState,
	spawn: SpawnState,
	resolvedModel: string | undefined,
	payload: Record<string, unknown>,
	now: () => Date,
	options: Pick<RecordOutcomeOptions, "authProbe" | "fetch"> = {},
): Promise<void> {
	const text = authFailureText(payload);
	if (!text || !isAuthFailureText(text)) return;
	const selector = resolvedModel ?? failedModelSelector(text, spawn.chosen);
	const base = modelSelectorBase(selector);
	const nowMs = now().getTime();
	const cached = state.authProbe.get(base);
	if (cached && nowMs - cached.at < AUTH_PROBE_TTL_MS) {
		if (!cached.alive) state.authDead.set(base, nowMs + AUTH_DEAD_TTL_MS);
		return;
	}
	const resolved = ctx.models?.resolve?.(selector) as { provider?: string; baseUrl?: string } | undefined;
	let apiKey: string | undefined;
	try {
		apiKey = resolved ? await ctx.modelRegistry?.getApiKey?.(resolved, sessionId(ctx)) : undefined;
	} catch {
		apiKey = undefined;
	}
	if (!resolved || !apiKey) return;
	// Probe the request-resolved host: a Xiaomi `tp-` key rides the Token Plan
	// cluster, so probing the bundled standard host would 401 and falsely mark
	// the model dead.
	const baseUrl = resolveXiaomiRequestBaseUrl({ provider: resolved.provider, baseUrl: resolved.baseUrl }, apiKey);
	if (!baseUrl) return;
	const probe = options.authProbe ?? ((probeInput: AuthProbeInput) => probeModelAuthAlive(probeInput, options.fetch));
	let alive = true;
	try {
		alive = await probe({ baseUrl, apiKey });
	} catch {
		return;
	}
	state.authProbe.set(base, { at: nowMs, alive });
	if (!alive) state.authDead.set(base, nowMs + AUTH_DEAD_TTL_MS);
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
			const fallbackReason = takeFallbackReason(state, spawn, resolvedModel);
			if (status === "failed")
				await markAuthDeadAfterFailure(ctx, state, spawn, resolvedModel, job, options.now ?? (() => new Date()), options);
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
		const fallbackReason = stringValue(result.fallbackReason) ?? takeFallbackReason(state, spawn, resolvedModel);
		if (statusFromResult(result, event.isError === true) === "failed")
			await markAuthDeadAfterFailure(ctx, state, spawn, resolvedModel, result, options.now ?? (() => new Date()), options);
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
			...(fallbackReason ? { fallbackReason } : {}),
		};
		appendJsonl(options.stateFile ?? defaultStateFile(), record);
		rows.push(record);
	}

	return rows;
}

export default function agentRouter(pi: ExtensionAPI) {
	const state = createRouterState();
	pi.setLabel?.("Agent Router");
	pi.on("tool_call", (event, ctx) => fileToolRefusal(event, ctx));
	pi.on("before_subagent_spawn", (event, ctx) =>
		routeSubagentSpawn(event as BeforeSubagentSpawnEvent, ctx, state, {
			latestTodo: pi.pi?.getLatestTodoPhasesFromEntries,
		}),
	);
	pi.on("retry_fallback_applied", (event, ctx) => {
		recordAndNotifyRetryFallbackApplied(event as RetryFallbackAppliedEvent, ctx, state);
	});
	pi.on("tool_result", (event, ctx) => {
		void recordTaskOutcome(event as ToolResultEvent, ctx, state);
	});
}
