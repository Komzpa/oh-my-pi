// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { selectLatestBranchEntry } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { randomInt } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { isTodoSelectionEntryMetadata } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { realizesPriorityServiceTier } from "@oh-my-pi/pi-ai";
import type { ModelUsageHealth, ModelUsageHealthState } from "@oh-my-pi/pi-ai";
import { resolveXiaomiRequestBaseUrl } from "@oh-my-pi/pi-ai/registry/oauth/xiaomi";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { forecastTodoPlan, type TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { checkoutScopesFromResources, checkoutScopesOverlap } from "./checkout_scope";

export interface PoolConfig {
	pool: string[];
	fallbacks: string[];
}

export interface BrrrrModel { id: string; class: "strong" | "fast"; serviceTier?: "priority" }
export const BRRRR_MODELS_FILE = join(homedir(), ".omp/agent/brrrr-models.json");
const BRRRR_MODELS_SEED = new URL("./brrrr_models.json", import.meta.url).pathname;
export function readBrrrrModels(): BrrrrModel[] {
	const file = process.env.OMP_AGENT_ROUTER_MODELS ?? BRRRR_MODELS_FILE;
	return JSON.parse(readFileSync(existsSync(file) ? file : BRRRR_MODELS_SEED, "utf8"));
}
export const STRONG_MODELS = readBrrrrModels().filter(model => model.class === "strong").map(model => model.id);

export const BRRRR_ENTRY = "reemxy-brrrr";
const MODEL_BLACKLIST_SEED = new URL("./model_blacklist.json", import.meta.url).pathname;
export const MODEL_BLACKLIST_FILE = join(homedir(), ".omp/agent/model-blacklist.json");

interface ModelDemotion {
	model: string;
	roles: string[];
	reason: string;
	evidence: string;
}

function readModelSanctions(file = process.env.OMP_AGENT_ROUTER_BLACKLIST ?? MODEL_BLACKLIST_FILE): Array<string | ModelDemotion> {
	const seed: Array<string | ModelDemotion> = JSON.parse(readFileSync(MODEL_BLACKLIST_SEED, "utf8"));
	return existsSync(file) ? [...seed, ...JSON.parse(readFileSync(file, "utf8"))] : seed;
}

export function readModelBlacklist(file = process.env.OMP_AGENT_ROUTER_BLACKLIST ?? MODEL_BLACKLIST_FILE): string[] {
	return [...new Set(readModelSanctions(file).filter((entry): entry is string => typeof entry === "string"))];
}

export const MODEL_BLACKLIST = readModelBlacklist();

function isBlacklistedModel(spec: string, blacklist = readModelBlacklist()): boolean {
	return blacklist.includes(spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, ""));
}

function brrrrModeFileForSession(id: string | undefined): string {
	return join(
		process.env.OMP_AGENT_ROUTER_MODE_DIR ?? join(homedir(), ".local/state/omp-agent-router/modes"),
		`${encodeURIComponent(id ?? "unsaved")}.json`,
	);
}

export function brrrrModeFile(ctx: ExtensionContext): string {
	return brrrrModeFileForSession(sessionId(ctx));
}

/** Bytes read from the head of a transcript to find its session header. */
export const SESSION_HEADER_PEEK_BYTES = 64 * 1024;

/**
 * Session id from a transcript's header line, read from a bounded prefix.
 * A child only needs its parent's id to find the parent's mode file; parsing the
 * whole parent transcript costs memory proportional to its size for every child.
 */
export function readSessionHeaderId(file: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(SESSION_HEADER_PEEK_BYTES);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		const lines = buffer.subarray(0, length).toString("utf8").split("\n");
		// The last line of a full buffer may be cut mid-record; only whole lines are parsed.
		if (length === buffer.length) lines.pop();
		for (const line of lines) {
			if (!line.trim()) continue;
			const record = JSON.parse(line);
			if (record?.type === "title") continue;
			return record?.type === "session" && typeof record.id === "string" ? record.id : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function readBrrrrMode(ctx: ExtensionContext, file = brrrrModeFile(ctx)): boolean {
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).enabled === true : false;
}

function persistBrrrrMode(ctx: ExtensionContext, enabled: boolean): void {
	const file = brrrrModeFile(ctx);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
}

function strongOrder(agent: string, config: PoolConfig, models: BrrrrModel[]): string[] {
	const profile = [...config.pool, ...config.fallbacks];
	const strong = models.filter(model => model.class === "strong");
	const fast = models.filter(model => model.class === "fast").map(model => model.id);
	const order: string[] = [];
	for (const spec of [...profile, ...strong.map(model => model.id)]) {
		const base = spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "");
		if (!strong.some(model => model.id === base) || base === "codex-lb/gpt-6-luna") continue;
		if (order.some(candidate => candidate.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") === base)) continue;
		const implementation = ["coder", "minor-coder", "ui-coder", "task", "workhorse"].includes(agent) || agent.endsWith("-strong");
		order.push(implementation && base.startsWith("anthropic/claude-") && !/:(?:minimal|low|medium|high)$/.test(spec) ? `${base}:high` : spec);
	}
	if (strong.some(model => model.id === "codex-lb/gpt-6-luna" && model.serviceTier === "priority")) {
		order.push(profile.find(spec => spec.startsWith("codex-lb/gpt-6-luna")) ?? "codex-lb/gpt-6-luna");
	}
	const ordered = ["scout", "workhorse", "gate-runner", "scribe", "git-pr-owner", "sonic"].includes(agent) ? [...fast, ...order] : [...order, ...fast];
	// A fast entry may be the same model as a strong one at a lower effort (Luna `:low`): keep the first placement only.
	const seen = new Set<string>();
	return ordered.filter(spec => {
		const base = spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "");
		if (seen.has(base)) return false;
		seen.add(base);
		return true;
	});
}
// Pool lengths are routing policy; model selectors and fallback order live in agent frontmatter.
// Size 2 shares load between the first two entries (different providers) so one provider's 429 cannot take the role down; the rest of the chain stays ordered fallbacks.
const POOL_SIZES: Record<string, number> = {
	coder: 2,
	"minor-coder": 2,
	"ui-coder": 2,
	scout: 5,
	"gate-runner": 5,
	"git-pr-owner": 2,
	scribe: 5,
	reviewer: 4,
	workhorse: 7,
	"retro-facilitator": 3,
	architect: 4,
	"plan-doctor": 3,
	"security-reviewer": 0,
	"coder-strong": 0,
	"ui-coder-strong": 0,
	researcher: 3,
	"business-analyst": 3,
	creative: 2,
};

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

function lanePathsFromText(text: string): string[] {
	const found: string[] = [];
	const pattern = /(~\/[^\s'"`,;]+|\/[A-Za-z0-9_.-]+(?:\/[^\s'"`,;]+)*)/g;
	for (const match of text.matchAll(pattern)) {
		let candidate = (match[1] ?? "").replace(/[),.;'"`\]}]+$/g, "").replace(/\/+$/g, "");
		if (!candidate || candidate === "~" || candidate === "/") continue;
		if (candidate === "~" || candidate.startsWith("~/")) candidate = join(homedir(), candidate.slice(2));
		if (!candidate.startsWith("/")) continue;
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

function profilePool(agent: string, poolSize: number, profileDir?: string): PoolConfig {
	const filePath = profileDir
		? join(profileDir, `${agent}.md`)
		: new URL(`./agents/${agent}.md`, import.meta.url).pathname;
	const chain = parseAgent(filePath, readFileSync(filePath, "utf8"), "user").model;
	if (!chain?.length) throw new Error(`Missing model frontmatter for ${agent}`);
	return { pool: chain.slice(0, poolSize), fallbacks: chain.slice(poolSize) };
}

const TASK_POOL: PoolConfig = {
	pool: [
		"openrouter/dots-studio/dots-3-note-preview:free",
		"codex-lb/gpt-6-luna:medium",
		"anthropic/claude-haiku-5-5:medium",
		"kimi-code/kimi-for-coding:high",
		"deepseek/deepseek-v4-pro:high",
		"kimi-code/k3:high",
		"xai-oauth/grok-4.5",
		"muse-code/muse-spark-1.3-contributor",
		"xai-oauth/grok-4.6",
	],
	fallbacks: ["codex-lb/gpt-6.1-sol:medium", "codex-lb/Qwen3.8-27B", "cerebras/qwen-3.8-27b"],
};

export function getAgentPools(profileDir?: string): Record<string, PoolConfig> {
	return {
		...Object.fromEntries(
			Object.entries(POOL_SIZES).map(([agent, size]) => [agent, profilePool(agent, size, profileDir)]),
		),
		task: TASK_POOL,
	};
}

export function getAgentPool(agent: string, profileDir?: string): PoolConfig | undefined {
	if (agent === "task") return TASK_POOL;
	const size = POOL_SIZES[agent];
	return size === undefined ? undefined : profilePool(agent, size, profileDir);
}

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
	firstTurnModel?: string;
	fallbacks?: OutcomeFallback[];
	fallbackReason?: string;
}

export interface OutcomeFallback {
	from: string;
	to: string;
	at: string;
	reason: "unrecorded" | {
		class: "quota" | "auth" | "other";
		status?: number;
		message: string;
		source?: "provider-error" | "usage-preflight";
	};
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
	/** Provider -> epoch ms until which an account-level 429 with a long retry-after is known to last. */
	rateLimited: Map<string, number>;
	authProbe: Map<string, AuthProbeRecord>;
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
	return { spawns: new Map(), fallbacks: [], authDead: new Map(), rateLimited: new Map(), authProbe: new Map() };
}

export const AUTH_DEAD_TTL_MS = 6 * 60 * 60 * 1000;
/** Retry-after shorter than this is a transient throttle, not an account-level outage worth skipping a provider for. */
export const RATE_LIMIT_SKIP_MIN_MS = 60 * 1000;
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

function specProvider(spec: string, ctx: ExtensionContext): string | undefined {
	const resolved = ctx.models?.resolve?.(spec) as { provider?: string } | undefined;
	return resolved?.provider ?? (spec.includes("/") ? spec.slice(0, spec.indexOf("/")) : undefined);
}

function rateLimitSkipRecord(
	spec: string,
	ctx: ExtensionContext,
	state: RouterState,
	nowMs: number,
): SkippedModelRecord | undefined {
	const provider = specProvider(spec, ctx);
	if (!provider) return undefined;
	const until = state.rateLimited.get(provider);
	if (until === undefined || until <= nowMs) {
		if (until !== undefined) state.rateLimited.delete(provider);
		return undefined;
	}
	return { model: spec, reason: `rate_limited_retry_after_${new Date(until).toISOString()}` };
}

async function availablePoolMembers(
	pool: readonly string[],
	ctx: ExtensionContext,
	state?: RouterState,
	now?: () => Date,
	options: { keepCooled?: boolean | ((spec: string) => boolean) } = {},
): Promise<{ available: string[]; skipped: SkippedModelRecord[]; cooled: string[] }> {
	const nowMs = (now ?? (() => new Date()))().getTime();
	const allowed = pool.filter(isAllowedOpenRouterModel);
	const skipped: SkippedModelRecord[] = pool
		.filter(spec => !isAllowedOpenRouterModel(spec))
		.map(model => ({ model, reason: "paid_openrouter_disabled" }));
	const cooled: string[] = [];
	if (!ctx.models?.resolve || !ctx.models?.list) return { available: allowed, skipped, cooled };
	const authenticated = new Set(ctx.models.list().map(model => `${model.provider}/${model.id}`));
	const available: string[] = [];
	for (const spec of allowed) {
		const model = ctx.models.resolve(spec);
		if (model === undefined || !authenticated.has(`${model.provider}/${model.id}`)) continue;
		// Child recovery shares this registry with its parent; respect its existing
		// selector cooldown even when credential health cannot report a balance.
		if (ctx.modelRegistry?.isSelectorSuppressed?.(spec)) {
			skipped.push({ model: spec, reason: "retry_cooldown" });
			// A cooldown is a preference to try others first, not proof the provider is
			// dead: callers that opt in keep it eligible at the end of the order.
			if (typeof options.keepCooled === "function" ? options.keepCooled(spec) : options.keepCooled) cooled.push(spec);
			continue;
		}
		if (state) {
			const rateSkip = rateLimitSkipRecord(spec, ctx, state, nowMs);
			if (rateSkip) {
				skipped.push(rateSkip);
				continue;
			}
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
	return { available, skipped, cooled };
}

/** True when this routed agent has at least one authenticated, non-depleted pool or fallback model now. */
export async function agentHasLiveModel(
	agent: string,
	ctx: ExtensionContext,
	state?: RouterState,
	now?: () => Date,
): Promise<boolean> {
	const config = getAgentPool(agent);
	if (!config) return false;
	return (await availablePoolMembers([...config.pool, ...config.fallbacks], ctx, state, now)).available.length > 0;
}

export async function countLiveWorkerModels(
	ctx: ExtensionContext,
	state?: RouterState,
	now?: () => Date,
): Promise<number> {
	const specs = [...new Set(Object.values(getAgentPools()).flatMap(config => [...config.pool, ...config.fallbacks]))];
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

/** One latestTodo read per spawn: checkout scopes and criticality share it. */
function memoLatestTodo(getter: LatestTodoGetter | undefined, ctx: ExtensionContext): (() => TodoScheduleInput) | undefined {
	if (!ctx.getTodoPhases && (!getter || !ctx.sessionManager?.getBranchMatching)) return undefined;
	let cached: TodoScheduleInput | undefined;
	return () => cached ??= ctx.getTodoPhases?.() ??
		(getter && ctx.sessionManager?.getBranchMatching
			? getter(ctx.sessionManager.getBranchMatching(isTodoSelectionEntryMetadata))
			: []);
}

/** True when the spawning task item owns a plan row the forecast marks critical. */
function spawnIsCriticalRow(
	event: BeforeSubagentSpawnEvent,
	latestTodo: (() => TodoScheduleInput) | undefined,
	nowMs: number,
): boolean {
	const owner = stringValue(event.spawnKey);
	if (!owner || !latestTodo) return false;
	try {
		const phases = latestTodo();
		return forecastTodoPlan(phases, { now: nowMs }).rows.some(row => row.owner === owner && row.critical);
	} catch {
		return false;
	}
}

/** Index of the earliest chain entry whose model realizes priority service tier. Never cerebras. */
function firstPriorityCapableIndex(order: readonly string[], ctx: ExtensionContext): number {
	for (let index = 0; index < order.length; index++) {
		const spec = order[index]!;
		if (spec.split("/")[0] === "cerebras") continue;
		let model: unknown;
		try {
			model = ctx.models?.resolve?.(spec);
		} catch {
			continue;
		}
		if (!model) continue;
		try {
			if (realizesPriorityServiceTier("priority", model as never)) return index;
		} catch {
			continue;
		}
	}
	return -1;
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
		profileDir?: string;
		modeFile?: string;
		blacklistFile?: string;
	} = {},
): { model: string[]; note: string } | { block: true; reason: string } | undefined {
	const agent = stringValue(event.agent);
	if (!agent) return undefined;
	const brrrr = readBrrrrMode(ctx, options.modeFile);
	const brrrrModels = brrrr ? readBrrrrModels() : [];
	const sanctions = readModelSanctions(options.blacklistFile);
	const demotions = new Set(sanctions.filter((entry): entry is ModelDemotion => typeof entry !== "string" && entry.roles.includes(agent)).map(entry => modelSelectorBase(entry.model)));
	const config = getAgentPool(agent, options.profileDir) ?? (brrrr || demotions.size > 0 ? { pool: (event.patterns as string[]) ?? [], fallbacks: [] } : undefined);
	if (!config) return undefined;
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
			return {
				block: true,
				reason: `Refusing ${agent}: ${activeWriter.agent} worker ${activeWriter.spawnKey} is running in ${holderRepoLabel(activeWriter, ctx)} (holder scope ${heldScope}); this spawn scope is ${incomingScope}; if this row edits another repo, put that repo path in the row resources; isolated: true isolates only ${cwdRepoLabel(ctx)}.`,
			};
		}
	}
	const shuffle = options.shuffle ?? cryptoShuffle;
	const blacklist = sanctions.filter((entry): entry is string => typeof entry === "string");
	const filteredConfig = brrrr ? { pool: strongOrder(agent, config, brrrrModels), fallbacks: [] } : config;
	const pool = filteredConfig.pool.filter(spec => !isBlacklistedModel(spec, blacklist));
	// A cooldown only demotes a member, so one failing provider cannot empty the order.
	// brrrr is strong-only: a cooled strong member is still strong and stays last, but a
	// non-strong (fast-class) member stays excluded.
	const strongBases = new Set(brrrrModels.filter(model => model.class === "strong").map(model => model.id));
	const keepCooled = brrrr
		? (spec: string) => strongBases.has(spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, ""))
		: true;
	const { available, skipped: poolSkipped, cooled: poolCooled } = await availablePoolMembers(pool, ctx, state, options.now, { keepCooled });
	const { available: fallbacks, skipped: fallbackSkipped, cooled: fallbackCooled } = await availablePoolMembers(
		filteredConfig.fallbacks.filter(spec => !isBlacklistedModel(spec, blacklist)),
		ctx,
		state,
		options.now,
		{ keepCooled },
	);
	const skipped = [...poolSkipped, ...fallbackSkipped];
	const poolOrder = brrrr ? available : [
		...available.filter(spec => spec.endsWith(":free")),
		...shuffle(available.filter(spec => !spec.endsWith(":free"))),
	];
	const order = [...poolOrder, ...fallbacks];
	const cooledOrder = [...poolCooled, ...fallbackCooled];
	// A critical-path row starts on the fast lane: the earliest chain entry whose
	// model realizes priority service tier moves to the front. All other rows keep
	// the existing order; chains without a priority-capable entry are untouched.
	const nowMs = (options.now ?? (() => new Date()))().getTime();
	let criticalFirst = false;
	if (
		!brrrr &&
		spawnIsCriticalRow(event, latestTodo, nowMs) &&
		!order[0]?.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "").endsWith(":free")
	) {
		const priorityIndex = firstPriorityCapableIndex(order, ctx);
		if (priorityIndex > 0) {
			const [prioritySpec] = order.splice(priorityIndex, 1);
			order.unshift(prioritySpec!);
			criticalFirst = true;
		}
	}
	// Evidence-backed role sanctions outrank free-first and critical-row promotion.
	// Keep sanctioned models eligible only after every unaffected candidate.
	if (demotions.size > 0) {
		const demoted = order.filter(spec => demotions.has(modelSelectorBase(spec)));
		const preferred = order.filter(spec => !demotions.has(modelSelectorBase(spec)));
		order.splice(0, order.length, ...preferred, ...demoted);
	}
	// Cooled-down (retry_cooldown) members go last, after sanction demotions too.
	order.push(...cooledOrder.filter(spec => !order.includes(spec)));
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
	const criticalNote = criticalFirst ? "; critical row: priority-capable model first" : "";
	return {
		model: order,
		note: `pool pick ${chosen}${skippedNote}${criticalNote} (eval)`,
		...(brrrr ? {
			enforce: true,
			requiredModelServiceTiers: Object.fromEntries(brrrrModels.filter(model => model.serviceTier).map(model => [model.id, model.serviceTier])),
			claudeEffortCap: ["coder", "minor-coder", "ui-coder", "task", "workhorse"].includes(agent) || agent.endsWith("-strong"),
		} : {}),
	};
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

function isAllowedOpenRouterModel(spec: string): boolean {
	const selector = spec.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "");
	return !selector.startsWith("openrouter/") || selector.endsWith(":free");
}

const THINKING_EFFORT_SUFFIXES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function modelEffortOf(spec: string | undefined): string | undefined {
	if (!spec) return undefined;
	const separator = spec.lastIndexOf(":");
	if (separator <= spec.indexOf("/")) return undefined;
	const suffix = spec.slice(separator + 1).trim().toLowerCase();
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
			const from = stringValue(item.from), to = stringValue(item.to), at = stringValue(item.at);
			if (!from || !to || !at) continue;
			const reason = item.reason as OutcomeFallback["reason"] | undefined;
			fallbacks.push({ from, to, at, reason: reason ?? "unrecorded" });
		}
	}
	let fallbackReason = stringValue(result.fallbackReason);
	if (fallbacks.length) {
		fallbackReason ??= fallbacks.map(item => typeof item.reason === "string" ? item.reason : item.reason.message).join("; ");
	} else if (modelSelectorsDiffer(spawn.chosen, resolvedModel)) {
		const index = state.fallbacks.findIndex(fallback =>
			modelSelectorBase(fallback.from) === modelSelectorBase(spawn.chosen) &&
			modelSelectorBase(fallback.to) === modelSelectorBase(resolvedModel!) &&
			(fallback.role === "fallback" || fallback.role === `subagent:${spawn.spawnKey}`));
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

function recordFailingFallbackCooldowns(ctx: ExtensionContext, fallbacks: OutcomeFallback[]): void {
	for (const fallback of fallbacks) {
		if (typeof fallback.reason === "string" || fallback.reason.source !== "provider-error") continue;
		const failed = modelSelectorBase(fallback.from);
		if (!ctx.modelRegistry?.isSelectorSuppressed?.(failed)) {
			ctx.modelRegistry?.suppressSelector?.(failed, Date.now() + 5 * 60 * 1000);
		}
	}
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
export async function probeModelAuthAlive(input: AuthProbeInput, fetchImpl: typeof fetch = fetch): Promise<boolean> {
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

/** Retry-after (seconds, ms, ISO or HTTP date) found in a failure text, as ms from now. */
export function parseRetryAfterMs(text: string, nowMs: number): number | undefined {
	// Core's recorded failure text ends `retry-after-ms=N until <ISO>`: the absolute time is exact.
	const until = text.match(/\buntil\s+(\d{4}-\d\d-\d\dT[0-9:.]+Z)/i);
	if (until) {
		const at = Date.parse(until[1]!);
		if (Number.isFinite(at)) return at - nowMs;
	}
	const match = text.match(/retry[-_ ]after(?:[-_ ]ms)?["'\s:=]*([0-9]+(?:\.[0-9]+)?|\d{4}-\d\d-\d\dT[0-9:.]+Z|[A-Z][a-z]{2}, \d\d [A-Z][a-z]{2} \d{4} [0-9:]+ GMT)/i);
	if (!match) return undefined;
	const raw = match[1]!;
	if (/^[0-9.]+$/.test(raw)) {
		const value = Number.parseFloat(raw);
		if (!Number.isFinite(value)) return undefined;
		return /retry[-_ ]after[-_ ]ms/i.test(match[0]) ? value : value * 1000;
	}
	const at = Date.parse(raw);
	return Number.isFinite(at) ? at - nowMs : undefined;
}

function markRateLimitedAfterFailure(
	ctx: ExtensionContext,
	state: RouterState,
	spawn: SpawnState,
	resolvedModel: string | undefined,
	payload: Record<string, unknown>,
	now: () => Date,
): void {
	const text = authFailureText(payload);
	if (!text || !/\b429\b|rate[-_ ]?limit/i.test(text)) return;
	const nowMs = now().getTime();
	const delay = parseRetryAfterMs(text, nowMs);
	if (delay === undefined || delay < RATE_LIMIT_SKIP_MIN_MS) return;
	const selector = resolvedModel ?? failedModelSelector(text, spawn.chosen);
	// Core prefixes the failing provider: `Error: anthropic: billing: 429 ...`.
	const provider = text.match(/\b(?:Error:\s*)?([a-z][a-z0-9-]*): (?:billing|rate)/i)?.[1] ?? specProvider(selector, ctx);
	if (!provider) return;
	state.rateLimited.set(provider, Math.max(state.rateLimited.get(provider) ?? 0, nowMs + delay));
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
	markRateLimitedAfterFailure(ctx, state, spawn, resolvedModel, payload, now);
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
	const content = typeof custom.content === "string" ? custom.content : Array.isArray(custom.content)
		? custom.content.map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n")
		: "";
	const synthetic: Record<string, unknown>[] = [];
	for (const raw of jobs) {
		if (!raw || typeof raw !== "object") continue;
		const job = raw as Record<string, unknown>;
		const id = stringValue(job.jobId);
		if (!id) continue;
		const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const segment = content.match(new RegExp(`<task-result id="${escaped}"[\\s\\S]*?(?:</task-result>|$)`))?.[0] ?? content;
		synthetic.push({ id, status: job.status, durationMs: job.durationMs, ...(job.status === "failed" ? { error: segment } : {}) });
	}
	if (synthetic.length === 0) return [];
	return recordTaskOutcome({ toolName: "wait", details: { jobs: synthetic } }, ctx, state, options);
}

export default function agentRouter(pi: ExtensionAPI) {
	const state = createRouterState();
	pi.setLabel?.("Agent Router");
	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui?.setStatus?.("brrrr", readBrrrrMode(ctx) ? "BRRRR · strong models" : undefined);
	};
	const load = async (ctx: ExtensionContext) => {
		if (!existsSync(brrrrModeFile(ctx))) {
			const entry = selectLatestBranchEntry(ctx.sessionManager, item => item.type === "custom" && item.customType === BRRRR_ENTRY);
			const parentFile = ctx.sessionManager.getHeader()?.parentSession;
			if (!entry && parentFile && existsSync(parentFile)) {
				const parentId = readSessionHeaderId(parentFile);
				persistBrrrrMode(ctx, parentId !== undefined && readBrrrrMode(ctx, brrrrModeFileForSession(parentId)));
			} else {
				persistBrrrrMode(ctx, entry?.data?.enabled === true);
			}
		}
		updateStatus(ctx);
	};
	pi.registerCommand?.("brrrr", {
		description: "Use strong models only; /brrrr off restores normal routing",
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (argument !== "" && argument !== "off") {
				ctx.ui.notify("Usage: /brrrr [off]", "warning");
				return;
			}
			const enabled = argument !== "off";
			const changed = readBrrrrMode(ctx) !== enabled;
			persistBrrrrMode(ctx, enabled);
			pi.appendEntry(BRRRR_ENTRY, { enabled });
			updateStatus(ctx);
			if (changed) ctx.ui.notify(`brrrr ${enabled ? "on: strong models only; fast lane per brrrr-models.json" : "off: normal routing"}`, "info");
		},
	});
	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, (_event, ctx) => load(ctx));
	}
	pi.on("tool_call", (event, ctx) => fileToolRefusal(event, ctx));
	pi.on("before_subagent_spawn", async (event, ctx) => {
		updateStatus(ctx);
		const routed = await routeSubagentSpawn(event as BeforeSubagentSpawnEvent, ctx, state, {
			latestTodo: pi.pi?.getLatestTodoPhasesFromEntries,
		});
		return routed ?? (readBrrrrMode(ctx) ? { block: true, reason: "brrrr: no strong model available" } : undefined);
	});
	pi.on("retry_fallback_applied", (event, ctx) => {
		recordAndNotifyRetryFallbackApplied(event as RetryFallbackAppliedEvent, ctx, state);
	});
	pi.on("tool_result", (event, ctx) => {
		void recordTaskOutcome(event as ToolResultEvent, ctx, state);
	});
	pi.on("message_end", (event, ctx) => {
		void recordAsyncResultOutcome((event as { message?: unknown }).message, ctx, state);
	});
}
