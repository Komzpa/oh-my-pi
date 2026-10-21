import {
	type TodoStatus,
	type TodoDeploymentBinding,
	type TodoOperation,
	type TodoItem,
	type TodoPhase,
	type TodoCompletionTransition,
	type TodoToolDetails,
} from "@oh-my-pi/pi-tui/tools/todo";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import todoRequirementsDescription from "../prompts/tools/todo-requirements.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";

import { AgentRegistry } from "../registry/agent-registry";
import {
	checkRequirementIdentity,
	currentRequirementIdentity,
	formatRequirementIdentity,
	hashArtifactFile,
	identityOf,
	type Identity,
	REQUIREMENT_ARTIFACT_LIMITS,
	parseRequirementIdentity,
	type RequirementIdentity,
	type RequirementIdentityTarget,
	resolveResourceArtifact,
	sameIdentity,
} from "../utils/requirement-artifact";
import { matchingRequirementBranch } from "../session/requirements-branch-selection";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

import * as nodePath from "node:path";
import {
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
	appendRequirementsSnapshot,
	classifyRequirement,
	formatDoneGateRefusal,
	getLatestRequirements,
	evaluateRequirementDoneGate,
	getRequirementRowVerdict,
	parseRequirementReceiptIdentities,
	getRequirementReceiptArtifactRowLabels,
	getPersistedRequirementAuditRejections,
	prepareAwaitingUserCheck,
	type RequirementsLedgerAppender,
} from "./requirements-ledger";

import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

/** Whether an unknown value is a persisted todo phase. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(
		task =>
			isRecord(task) &&
			typeof task.content === "string" &&
			(task.status === "pending" ||
				task.status === "in_progress" ||
				task.status === "completed" ||
				task.status === "abandoned" ||
				task.status === "blocked"),
	);
}

/**
 * Phases a successful, state-changing `todo` result committed, or undefined
 * for errors, pure `view` reads, and requirement classification. A direct call
 * lands these on the branch through its own `toolResult` entry; a caller that
 * produces no `todo` toolResult (the eval bridge) must persist them itself or
 * the next branch rehydration (resume, rewind, fork, /btw) silently reverts the
 * change.
 */
export function committedTodoPhases(result: AgentToolResult): TodoPhase[] | undefined {
	if (result.isError || !isRecord(result.details)) return undefined;
	const { op, phases } = result.details;
	if (op === "view" || op === "classify" || !Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
	return phases;
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = type('"init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view"');

const InitListEntry = type({
	phase: type("string"),
	items: type("string").array().atLeastLength(1),
});

const todoSchema = type({
	op: TodoOp,
	"awaitingUser?": type({ action: "string", "ids?": type("string").array() }).describe(
		"user-owned pending check for block: exact action and optional card or other ids",
	),
	"list?": InitListEntry.array().describe("phases for init"),
	"task?": type("string").describe("verbatim task content"),
	"phase?": type("string"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": type("string").array().describe("tasks for flat init or append"),
	"reason?": type("string").describe("blocker note for block"),
});

type TodoParams = TodoSchema;
type TodoSchema = typeof todoSchema.infer;

/** A single todo op entry (the params object itself). */
type TodoOpEntryValue = TodoParams;

// Session checkout for rows created by the current `TodoTool.execute()` call.
// Set at the top of execute() (a region #92 leaves alone) and read by
// initPhases/appendItems, so #41 never touches #92's applyEntry/applyParams
// threading or execute-tail hunks. Stays undefined for standalone
// applyOpsToPhases use (which clears it on entry).
let activeArtifactCwd: string | undefined;

function bindArtifactCwd(task: TodoItem, artifactCwd?: string): void {
	if (artifactCwd) {
		task.artifactCwd = artifactCwd;
		task.artifactOwner = "main";
	}
}

export interface RequirementRowArtifact {
	cwd: string;
	head: string | null;
	dirty: boolean;
	sha256?: string;
	/** SHA-256 over HEAD plus sorted dirty-path status and content; set only for dirty Git checkouts. */
	dirtyFingerprint?: string;
	reason?: string;
	awaitingUser?: TodoItem["awaitingUser"];
	/** Canonical identities offered to QA, or the exact receipt checked by its typed probes. */
	identities?: RequirementIdentity[];
	identityCheck?: { artifact: string; reason?: string };
}

export interface RequirementRowArtifactContext {
	cwd: string;
	sessionManager?: { getBranch(): SessionEntry[] };
	getAsyncJobSnapshot?: () => { running?: readonly { id: string; agentId?: string }[] } | undefined;
	signal?: AbortSignal;
	/**
	 * Checkout a finished non-isolated worker actually ran in, captured at the task
	 * execution boundary. Used only for a row scheduled to that exact owner.
	 */
	executionCheckout?: { owner: string; cwd: string };
	/** Saved receipt artifact to authenticate by kind before any owner or checkout lookup. */
	receipt?: string;
}

const ABSOLUTE_ARTIFACT_PATH = /\/(?:home|srv|tmp|var|mnt|workspaces|Users)\/[^\s"'`),;]+/g;

function unknownRequirementArtifact(cwd: string, reason = "checkout mapping unavailable"): RequirementRowArtifact {
	return { cwd, head: null, dirty: true, reason };
}

/** Attach row-owned pending checks to the artifact used by every completion surface. */
export async function getRequirementRowArtifact(
	ctx: RequirementRowArtifactContext,
	row: string,
	phases: readonly TodoPhase[],
	checkoutCache?: Map<string, Promise<RequirementRowArtifact>>,
): Promise<RequirementRowArtifact> {
	const artifact = await resolveRequirementRowArtifact(ctx, row, phases, checkoutCache);
	const tasks = phases.flatMap(phase => phase.tasks).filter(task => task.content === row);
	const pending = tasks.length === 1 && tasks[0]!.status === "blocked" ? tasks[0]!.awaitingUser : undefined;
	return pending?.action.trim() ? { ...artifact, awaitingUser: pending } : artifact;
}

/**
 * Declared typed targets of one row: its deploy string, or every explicit absolute
 * resource (an exact Git root is a `git:` location; any other file or directory is a
 * `file:` target, a directory by manifest). Explicit absolute resources never fall
 * through to the owner map; legacy textual descriptors keep the old resolver.
 * A receipt keeps its own immutable `paths=`; the Git root never widens or invents them.
 */
async function declaredRequirementTargets(
	task: TodoItem,
): Promise<RequirementIdentityTarget[] | { error: string } | undefined> {
	if (task.deployment !== undefined) {
		const parsed = parseRequirementIdentity(task.deployment);
		if ("error" in parsed) return { error: parsed.error };
		if (parsed.identity.kind !== "deploy") return { error: "deployment declaration is not a deploy: identity" };
		const { value: _value, ...target } = parsed.identity;
		return [target];
	}
	const schedule = (task as TodoItem & { schedule?: unknown }).schedule;
	const resources = isRecord(schedule) && Array.isArray(schedule.resources) ? schedule.resources : [];
	if (
		resources.length === 0 ||
		resources.some(resource => typeof resource !== "string" || !nodePath.isAbsolute(resource))
	)
		return undefined;
	const targets: RequirementIdentityTarget[] = [];
	for (const resource of resources as string[]) {
		const info = await fs.promises.lstat(resource).catch(() => undefined);
		const repo = info?.isDirectory() ? vcs.git(resource)?.info().repoRoot : undefined;
		if (repo === undefined || nodePath.resolve(repo) !== nodePath.resolve(resource)) {
			// Missing, symlinked, or special paths stay typed: the helper reports them unverifiable.
			targets.push({ kind: "file", path: resource });
			continue;
		}
		targets.push({ kind: "git", repo });
	}
	return targets;
}

/** Read-only coverage of a parsed receipt against the row's own declared targets; no probe runs here. */
function requirementReceiptCoverageIssue(
	row: string,
	targets: readonly RequirementIdentityTarget[],
	identities: readonly RequirementIdentity[],
): string | undefined {
	const covered = new Set<number>();
	for (const identity of identities) {
		const index = targets.findIndex(target => {
			if (target.kind === "file") return identity.kind === "file" && identity.path === target.path;
			if (target.kind === "git") return identity.kind === "git" && nodePath.resolve(identity.repo) === target.repo;
			if (identity.kind !== "deploy") return false;
			const { value: _value, ...declared } = identity;
			return JSON.stringify(declared) === JSON.stringify(target);
		});
		if (index < 0)
			return `receipt identity ${formatRequirementIdentity(identity)} is outside row ${JSON.stringify(row)}'s declared targets`;
		const target = targets[index]!;
		if (identity.kind === "git" && target.kind === "git") {
			if (identity.paths?.length === 0) return `receipt git identity for ${target.repo} names an empty paths list`;
		}
		covered.add(index);
	}
	const uncovered = targets.filter((_target, index) => !covered.has(index));
	if (uncovered.length)
		return `receipt does not cover declared ${uncovered.map(target => (target.kind === "file" ? target.path : target.kind === "git" ? target.repo : target.target)).join(", ")}`;
	return undefined;
}

/** Typed row identity: kind parse and declared coverage, then real probes; never owner-map fallback. */
async function resolveTypedRequirementArtifact(
	ctx: RequirementRowArtifactContext,
	row: string,
	task: TodoItem,
): Promise<RequirementRowArtifact | undefined> {
	const declaredTargets = await declaredRequirementTargets(task);
	const receipt = ctx.receipt;
	let targets: RequirementIdentityTarget[] | { error: string } | undefined = declaredTargets;
	let parsed:
		| { identities: RequirementIdentity[] }
		| { error: string }
		| { legacy: true; commits: string[] }
		| undefined;
	// Optional resource pins do not turn a typed file/readback receipt into a Git
	// checkout: its own declared target and current SHA-256 govern freshness.
	if (targets === undefined && receipt !== undefined) {
		parsed = parseRequirementReceiptIdentities(receipt);
		if ("error" in parsed) return unknownRequirementArtifact(row, `invalid typed identity (${parsed.error})`);
		if (!("legacy" in parsed))
			targets = parsed.identities.map(identity => {
				if (identity.kind === "deploy") {
					const { value: _value, ...target } = identity;
					return target;
				}
				if (identity.kind === "git")
					return {
						kind: "git",
						repo: identity.repo,
						...(identity.paths !== undefined ? { paths: identity.paths } : {}),
					};
				return { kind: "file", path: identity.path };
			});
	}
	if (!targets) return undefined;
	if ("error" in targets) return unknownRequirementArtifact(row, `invalid typed declaration (${targets.error})`);
	const resolvedTargets = targets;
	const location = resolvedTargets
		.map(target => (target.kind === "file" ? target.path : target.kind === "git" ? target.repo : target.target))
		.join("; ");
	// Current identities of the row's OWN targets are the exact QA input and the quoted retry form.
	const current = async (): Promise<RequirementRowArtifact> => {
		const identities: RequirementIdentity[] = [];
		const errors: string[] = [];
		for (const target of resolvedTargets) {
			const resolved = await currentRequirementIdentity(target, ctx.signal);
			if ("error" in resolved) errors.push(resolved.error);
			else identities.push(resolved.identity);
		}
		return errors.length
			? { cwd: location, head: null, dirty: false, reason: `current identity unavailable (${errors.join("; ")})` }
			: { cwd: location, head: null, dirty: false, identities };
	};
	if (receipt === undefined) return current();
	const reject = async (reason: string): Promise<RequirementRowArtifact> => {
		const own = await current();
		const retry = own.identities
			? `retry with row ${JSON.stringify(row)} @ ${own.identities.map(formatRequirementIdentity).join("; ")}`
			: own.reason!;
		return { ...own, reason: undefined, identityCheck: { artifact: receipt, reason: `${reason}; ${retry}` } };
	};
	let receiptIdentities = parsed ?? parseRequirementReceiptIdentities(receipt);
	if ("legacy" in receiptIdentities) {
		const target = resolvedTargets.length === 1 ? resolvedTargets[0] : undefined;
		const labels = getRequirementReceiptArtifactRowLabels(receipt, new Set([row]));
		if (
			target?.kind !== "git" ||
			target.paths !== undefined ||
			labels.length !== 1 ||
			labels[0] !== row ||
			receiptIdentities.commits.length !== 1
		)
			return reject("receipt has no unambiguous row-bound Git identity");
		receiptIdentities = { identities: [{ kind: "git", repo: target.repo, commit: receiptIdentities.commits[0]! }] };
	}
	if ("error" in receiptIdentities) return reject(`invalid typed identity (${receiptIdentities.error})`);
	const coverageIssue = requirementReceiptCoverageIssue(row, resolvedTargets, receiptIdentities.identities);
	if (coverageIssue) return reject(coverageIssue);
	for (const identity of receiptIdentities.identities) {
		const check = await checkRequirementIdentity(identity, ctx.signal);
		if (check.state === "stale")
			return reject(`stale ${check.kind} ${check.location}: expected ${check.expected}, observed ${check.observed}`);
		if (check.state === "unverifiable")
			return reject(`unverifiable ${check.kind} ${check.location}: expected ${check.expected} (${check.reason})`);
	}
	return {
		cwd: location,
		head: null,
		dirty: false,
		identities: receiptIdentities.identities,
		identityCheck: { artifact: receipt },
	};
}

/** Resolve a row's persisted checkout, then read its current HEAD and dirty state without blocking the CLI. */
async function resolveRequirementRowArtifact(
	ctx: RequirementRowArtifactContext,
	row: string,
	phases: readonly TodoPhase[],
	checkoutCache?: Map<string, Promise<RequirementRowArtifact>>,
): Promise<RequirementRowArtifact> {
	let task: TodoItem | undefined;
	for (const phase of phases) {
		for (const candidate of phase.tasks) {
			if (candidate.content !== row) continue;
			if (task) return unknownRequirementArtifact(`duplicate TODO row ${JSON.stringify(row)}`);
			task = candidate;
		}
	}
	const archived = !task;
	if (!task && ctx.sessionManager) {
		let historical: TodoItem | undefined;
		let ambiguous = false;
		observeLatestTodoPhases(ctx.sessionManager.getBranch(), snapshot => {
			let match: TodoItem | undefined;
			for (const phase of snapshot) {
				for (const candidate of phase.tasks) {
					if (candidate.content !== row) continue;
					if (match) {
						ambiguous = true;
						return;
					}
					match = candidate;
				}
			}
			if (match) {
				historical = cloneTask(match);
				ambiguous = false;
			}
		});
		if (ambiguous) return unknownRequirementArtifact(`duplicate historical TODO row ${JSON.stringify(row)}`);
		task = historical;
	}
	if (!task) return unknownRequirementArtifact("unknown row");
	// Typed declarations resolve by receipt kind before owner/registry/checkout lookup.
	const typed = await resolveTypedRequirementArtifact(ctx, row, task);
	if (typed) return typed;

	const schedule = (task as TodoItem & { schedule?: unknown }).schedule;
	const metadata = isRecord(schedule) ? schedule : undefined;
	const owner = typeof metadata?.owner === "string" ? metadata.owner : undefined;
	const mainOwner = owner === undefined || owner.toLowerCase() === "main";
	const resources = Array.isArray(metadata?.resources) ? metadata.resources : [];
	const paths: string[] = [];
	const branchNames: string[] = [];
	for (const resource of resources) {
		if (typeof resource !== "string") continue;
		// An exact absolute path is a filesystem path verbatim: leading and trailing
		// whitespace is part of the name and is never trimmed (norm 16). Legacy
		// textual descriptor trimming applies only to non-path descriptors.
		if (nodePath.isAbsolute(resource)) {
			paths.push(resource);
			continue;
		}
		const value = resource.trim();
		// Legacy textual descriptor: trimmed text that is itself an absolute path
		// binds it verbatim; otherwise embedded absolute paths are extracted.
		if (nodePath.isAbsolute(value)) paths.push(value);
		else paths.push(...(value.match(ABSOLUTE_ARTIFACT_PATH) ?? []));
		const branch = /^(?:branch:|branch=|refs\/heads\/)(.+)$/.exec(value)?.[1];
		if (branch) branchNames.push(branch);
	}
	if (new Set(branchNames).size > 1) return unknownRequirementArtifact(`ambiguous branches ${branchNames.join(", ")}`);
	const effectiveOwner = owner ?? "main";
	// The binding persisted on the session's latest copy of this row counts even
	// when the caller's in-memory plan predates it; it must be for the same owner
	// and the same schedule, so a reassigned row never inherits an old checkout.
	let persistedCwd: string | undefined;
	const latest =
		archived || !ctx.sessionManager
			? []
			: getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch())
					.flatMap(phase => phase.tasks)
					.filter(candidate => candidate.content === row);
	const latestTask = latest.length === 1 ? latest[0]! : undefined;
	const latestSchedule = latestTask && "schedule" in latestTask ? latestTask.schedule : undefined;
	for (const candidate of [
		task,
		JSON.stringify(latestSchedule) === JSON.stringify(schedule) ? latestTask : undefined,
	]) {
		if (
			!persistedCwd &&
			typeof candidate?.artifactCwd === "string" &&
			nodePath.isAbsolute(candidate.artifactCwd) &&
			candidate.artifactOwner === effectiveOwner
		)
			persistedCwd = candidate.artifactCwd;
	}
	const declaredDeployment =
		task.deployment ??
		(JSON.stringify(latestSchedule) === JSON.stringify(schedule) ? latestTask?.deployment : undefined);
	if (declaredDeployment) return unknownRequirementArtifact(`unresolved deployment ${declaredDeployment}`);
	const finishedCheckout =
		!mainOwner && owner !== undefined && ctx.executionCheckout?.owner === owner
			? ctx.executionCheckout.cwd
			: undefined;

	const running = archived ? [] : (ctx.getAsyncJobSnapshot?.()?.running ?? []);
	const activeJob = owner === undefined ? undefined : running.find(job => job.id === owner || job.agentId === owner);
	const registry = AgentRegistry.global();
	let agent = archived || owner === undefined ? undefined : registry.get(owner);
	if (!agent && activeJob?.agentId) agent = registry.get(activeJob.agentId);
	if (!agent && !archived && paths.length === 0 && !persistedCwd && !finishedCheckout) {
		for (const reference of registry.list()) {
			if (!("todoRow" in reference) || reference.todoRow !== row) continue;
			if (agent) return unknownRequirementArtifact(`ambiguous registered owners for ${JSON.stringify(row)}`);
			agent = reference;
		}
		if (
			agent &&
			owner !== undefined &&
			owner !== agent.id &&
			owner !== activeJob?.id &&
			owner !== activeJob?.agentId
		) {
			return unknownRequirementArtifact(
				`owner ${JSON.stringify(owner)} conflicts with registered row owner ${JSON.stringify(agent.id)}`,
			);
		}
	}
	// Main owns the session checkout by default, including an explicit empty
	// resource list. Named resources and persisted bindings still take precedence;
	// an unmapped worker must never inherit Main's checkout.
	const ownerCwd = mainOwner
		? archived || paths.length || persistedCwd
			? undefined
			: ctx.cwd
		: resources.length > 0 || persistedCwd
			? undefined
			: (finishedCheckout ?? agent?.session?.sessionManager.getCwd());
	// A reassigned worker whose checkout is not known must not inherit the row's initial main checkout.
	if (
		!archived &&
		owner &&
		!mainOwner &&
		!ownerCwd &&
		!persistedCwd &&
		paths.length === 0 &&
		branchNames.length === 0
	) {
		return unknownRequirementArtifact(`unknown checkout for owner ${JSON.stringify(owner)}`);
	}
	if (branchNames.length > 0) {
		const anchor =
			ownerCwd ??
			paths[0] ??
			(typeof task.artifactCwd === "string" && nodePath.isAbsolute(task.artifactCwd) ? task.artifactCwd : undefined);
		if (!anchor) return unknownRequirementArtifact(`unknown worktree for ${branchNames.join(", ")}`);
		try {
			const worktrees = await vcs.requireGit(anchor).worktrees(ctx.signal);
			const matches = worktrees.filter(worktree =>
				branchNames.includes(worktree.branch?.replace(/^refs\/heads\//, "") ?? ""),
			);
			if (matches.length !== 1) return unknownRequirementArtifact(`unknown worktree for ${branchNames.join(", ")}`);
			paths.push(matches[0]!.path);
		} catch {
			return unknownRequirementArtifact(`unknown worktree for ${branchNames.join(", ")}`);
		}
	}
	const uniquePaths = [...new Set(paths)];
	// Explicit resources win over any checkout: several files, a single file, or a
	// non-Git directory are bound by their content SHA (manifest for sets).
	if (uniquePaths.length > 1) return resolveResourceArtifact(uniquePaths, ctx.signal);
	const path = uniquePaths[0] ?? persistedCwd ?? ownerCwd;
	if (!path)
		return unknownRequirementArtifact(
			`unknown artifact mapping for ${JSON.stringify(row)} (owner ${JSON.stringify(owner ?? null)})`,
		);

	try {
		const info = await fs.promises.stat(path);
		if (info.isFile()) return resolveResourceArtifact([path], ctx.signal);
		if (!info.isDirectory()) return unknownRequirementArtifact(path, "resource is neither a file nor a directory");
	} catch {
		return unknownRequirementArtifact(path, "resource path is missing or inaccessible");
	}
	const cwd = path;
	const repo = vcs.git(cwd);
	if (!repo) return resolveResourceArtifact([cwd], ctx.signal);
	const repoRoot = repo.info().repoRoot;
	let current = checkoutCache?.get(repoRoot);
	if (!current) {
		current = Promise.all([
			repo.headSha(ctx.signal),
			repo.statusPorcelain({ untracked: "all", nulTerminated: true }, ctx.signal),
		])
			.then(async ([head, status]): Promise<RequirementRowArtifact> => {
				if (!status) return { cwd: repoRoot, head: head ?? null, dirty: false };
				const fingerprint = await dirtyCheckoutFingerprint(repoRoot, head ?? null, status, ctx.signal);
				if ("reason" in fingerprint) return unknownRequirementArtifact(repoRoot, fingerprint.reason);
				// Fail closed on concurrent drift: the fingerprint is the audited identity
				// only while HEAD and the full porcelain status/path set still match after
				// all hashing.
				const [headAfter, statusAfter] = await Promise.all([
					repo.headSha(ctx.signal),
					repo.statusPorcelain({ untracked: "all", nulTerminated: true }, ctx.signal),
				]);
				if (headAfter !== head || statusAfter !== status)
					return unknownRequirementArtifact(repoRoot, "dirty checkout changed while fingerprinting");
				return { cwd: repoRoot, head: head ?? null, dirty: true, dirtyFingerprint: fingerprint.sha256 };
			})
			.catch(() => unknownRequirementArtifact(repoRoot, "Git HEAD or status unavailable"));
		checkoutCache?.set(repoRoot, current);
	}
	return current;
}

/**
 * Content identity of a dirty checkout: HEAD plus every porcelain entry sorted by
 * path, each with its status code and current content. A path whose status stays
 * `M` still changes the fingerprint when its bytes change. Deleted paths hash as
 * absent, symlinks by target (never followed), renames by both paths; anything
 * else (directories such as submodules, unreadable or oversized files) fails closed.
 */
async function dirtyCheckoutFingerprint(
	repoRoot: string,
	head: string | null,
	status: string,
	signal?: AbortSignal,
): Promise<{ sha256: string } | { reason: string }> {
	const fields = status.split("\0");
	const entries: Array<[path: string, code: string, origin: string]> = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (!field) continue;
		const code = field.slice(0, 2);
		// Porcelain -z writes the rename/copy source as the following field.
		const origin = code.includes("R") || code.includes("C") ? (fields[++index] ?? "") : "";
		entries.push([field.slice(3), code, origin]);
	}
	if (entries.length > REQUIREMENT_ARTIFACT_LIMITS.maxFiles)
		return { reason: `dirty checkout exceeds file-count bound ${REQUIREMENT_ARTIFACT_LIMITS.maxFiles}` };
	entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
	const hash = createHash("sha256").update(`head\0${head ?? ""}\0`);
	let bytes = 0;
	const seen: Array<[absolute: string, relative: string, identity: Identity]> = [];
	for (const [relative, code, origin] of entries) {
		const absolute = nodePath.join(repoRoot, relative);
		let content: string;
		try {
			const info = await fs.promises.lstat(absolute);
			seen.push([absolute, relative, identityOf(info)]);
			if (info.isSymbolicLink()) content = `symlink\0${await fs.promises.readlink(absolute)}`;
			else if (info.isFile()) {
				bytes += info.size;
				if (bytes > REQUIREMENT_ARTIFACT_LIMITS.maxBytes)
					return { reason: `dirty checkout exceeds aggregate byte bound ${REQUIREMENT_ARTIFACT_LIMITS.maxBytes}` };
				content = `file\0${await hashArtifactFile(absolute, signal)}`;
			} else return { reason: `${relative}: dirty path is neither a file nor a symlink` };
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				signal?.throwIfAborted();
				return { reason: `${relative}: ${error instanceof Error ? error.message : String(error)}` };
			}
			content = "absent";
		}
		hash.update(`${code}\0${relative}\0${origin}\0${content}\0`);
	}
	// Re-check every earlier entry's metadata after all hashing, so a file rewritten
	// while a later file was hashed fails closed (same stability contract as the
	// explicit-set manifest recheck in resolveResourceArtifact).
	for (const [absolute, relative, identity] of seen) {
		const current = await fs.promises
			.lstat(absolute)
			.then(identityOf)
			.catch(() => undefined);
		if (!current || !sameIdentity(identity, current)) return { reason: `${relative}: changed while fingerprinting` };
	}
	return { sha256: hash.digest("hex") };
}

/** Persist an unambiguous live audit checkout on the canonical TODO row before the worker can disappear. */
export async function bindRequirementRowArtifact(
	ctx: RequirementRowArtifactContext,
	row: string,
	phases: readonly TodoPhase[],
	pi: RequirementsLedgerAppender,
	checkoutCache?: Map<string, Promise<RequirementRowArtifact>>,
): Promise<RequirementRowArtifact> {
	const artifact = await getRequirementRowArtifact(ctx, row, phases, checkoutCache);
	// Typed rows bind nothing else: their declarations and artifactCwd are never overwritten.
	if (artifact.identities || artifact.identityCheck) return artifact;
	// Unresolved mappings bind nothing; resolved Git, file and manifest identities persist their real cwd.
	if (artifact.reason || (!artifact.head && !artifact.sha256) || !ctx.sessionManager) return artifact;
	let original: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content !== row) continue;
			if (original) return unknownRequirementArtifact(`duplicate TODO row ${JSON.stringify(row)}`);
			original = task;
		}
	}
	// An archived row already has persisted checkout ownership; never resurrect it in the active plan.
	if (!original) return artifact;

	const currentPhases = getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch());
	let current: TodoItem | undefined;
	for (const phase of currentPhases) {
		for (const task of phase.tasks) {
			if (task.content !== row) continue;
			if (current) return unknownRequirementArtifact(`duplicate TODO row ${JSON.stringify(row)}`);
			current = task;
		}
	}
	if (
		!current ||
		JSON.stringify((current as TodoItem & { schedule?: { resources?: unknown } }).schedule?.resources) !==
			JSON.stringify((original as TodoItem & { schedule?: { resources?: unknown } }).schedule?.resources)
	) {
		return unknownRequirementArtifact(`TODO row ${JSON.stringify(row)} changed during artifact binding`);
	}
	const owner = (current as TodoItem & { schedule?: { owner?: unknown } }).schedule?.owner;
	const artifactOwner = typeof owner === "string" ? owner : "main";
	if (original.artifactCwd === artifact.cwd && original.artifactOwner === artifactOwner) return artifact;
	current.artifactCwd = artifact.cwd;
	current.artifactOwner = artifactOwner;
	pi.appendEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: currentPhases });
	return artifact;
}

export interface TodoCompletionSelector {
	task?: string;
	phase?: string;
	items?: string[];
}

/** Select the exact rows a `done`/`drop` batch names; an empty batch is an
 *  error, not a request to close every row. */
function selectCompletionBatchTargets(
	phases: TodoPhase[],
	entry: { op?: string; task?: string; items?: string[] },
	errors: string[],
): TodoItem[] {
	if (!entry.task && (entry.items?.length ?? 0) === 0) {
		errors.push(
			`${entry.op === "drop" ? "drop" : "done"} requires a task or items target; call todo with op="done", task="<exact row>" (or op="done", items=["<row1>", ...])`,
		);
		return [];
	}
	const targets: TodoItem[] = [];
	const seen = new Set<TodoItem>();
	const addTarget = (content: string) => {
		const hit = resolveTaskOrError(phases, content, errors);
		if (hit && !seen.has(hit.task)) {
			seen.add(hit.task);
			targets.push(hit.task);
		}
	};
	if (entry.task) addTarget(entry.task);
	for (const content of entry.items ?? []) addTarget(content);
	return targets;
}

/** Resolve done targets once for native mutation and the extension safety gate. */
export function getCompletionTargets(phases: TodoPhase[], entry: TodoCompletionSelector, errors: string[]): TodoItem[] {
	if (entry.items !== undefined) {
		return selectCompletionBatchTargets(phases, { op: "done", task: entry.task, items: entry.items }, errors);
	}
	return getTaskTargets(phases, { op: "done", task: entry.task, phase: entry.phase }, errors);
}

// =============================================================================
// State helpers
// =============================================================================

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	return structuredClone(task);
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => {
		const { tasks, ...metadata } = phase;
		return { ...structuredClone(metadata), tasks: tasks.map(cloneTask) };
	});
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
		}
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return transitions;
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/** Return the active todo task, preferring an in-progress item over the first pending item. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export const TODO_HUD_STATE_CUSTOM_TYPE = "todo_hud_state";

export type TodoHudVisibility = "dismissed" | "revealed";

export interface TodoSnapshotIdentity {
	sourceEntryId: string;
	fingerprint: string;
}

export interface TodoHudStateEntryData extends TodoSnapshotIdentity {
	visibility: TodoHudVisibility;
}

function todoPhasesFingerprint(phases: readonly TodoPhase[]): string {
	return JSON.stringify(
		phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task =>
				task.blocker === undefined
					? { content: task.content, status: task.status }
					: { content: task.content, status: task.status, blocker: task.blocker },
			),
		})),
	);
}

function canonicalTodoPhases(entry: SessionEntry): TodoPhase[] | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
		const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
		return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as {
		role?: string;
		toolName?: string;
		details?: { op?: unknown; phases?: unknown };
		isError?: boolean;
	};
	if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	if (message.details?.op === "view") return undefined;
	const phases = message.details?.phases;
	return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
}

/** Identify the latest durable canonical todo snapshot on the active branch. */
export function getLatestTodoSnapshotIdentity(entries: SessionEntry[]): TodoSnapshotIdentity | undefined {
	let latest: TodoPhase[] | undefined;
	let sourceEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) {
			latest = phases;
			sourceEntryId = entries[i].id;
			break;
		}
	}
	if (!latest || !sourceEntryId) return undefined;
	return { sourceEntryId, fingerprint: todoPhasesFingerprint(latest) };
}

/** Return the persisted HUD choice only when it targets the current canonical snapshot exactly. */
export function getTodoHudVisibility(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
): TodoHudVisibility | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TODO_HUD_STATE_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<TodoHudStateEntryData> | undefined;
		if (
			data?.sourceEntryId === snapshot.sourceEntryId &&
			data.fingerprint === snapshot.fingerprint &&
			(data.visibility === "dismissed" || data.visibility === "revealed")
		) {
			return data.visibility;
		}
	}
	return undefined;
}

/** Build persisted HUD metadata only for phases matching the latest durable canonical snapshot. */
export function createTodoHudStateData(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
	visibility: TodoHudVisibility,
): TodoHudStateEntryData | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	return { ...snapshot, visibility };
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) return clonePhases(phases);
	}
	return [];
}

/** Last meaningful change to each row in saved todo history. Closing alone does not invalidate QA. */
export function getTodoRowChanges(entries: readonly SessionEntry[]): Map<string, { at: string; id: string }> {
	const changes = new Map<string, { at: string; id: string }>();
	const previous = new Map<string, TodoItem>();
	for (const entry of entries) {
		const phases = canonicalTodoPhases(entry);
		if (!phases) continue;
		const current = new Map(phases.flatMap(phase => phase.tasks.map(task => [task.content, task] as const)));
		for (const [row, task] of current) {
			const old = previous.get(row);
			const comparable = task.status === "completed" && old ? { ...task, status: old.status } : task;
			if (!old || JSON.stringify(comparable) !== JSON.stringify(old))
				changes.set(row, { at: entry.timestamp, id: entry.id });
		}
		for (const [row, old] of previous) {
			if (!current.has(row) && old.status !== "completed") changes.set(row, { at: entry.timestamp, id: entry.id });
		}
		previous.clear();
		for (const [row, task] of current) previous.set(row, task);
	}
	return changes;
}

/** Walk every canonical snapshot on the branch in order, then return the active phases. */
export function observeLatestTodoPhases(
	entries: SessionEntry[],
	onSnapshot: (phases: readonly TodoPhase[]) => void,
): TodoPhase[] {
	let latest: TodoPhase[] | undefined;
	for (const entry of entries) {
		const phases = canonicalTodoPhases(entry);
		if (phases) {
			onSnapshot(phases);
			latest = phases;
		}
		// Archive edits retain row identity and artifact bindings after the live
		// plan drops them. Observe them without making them the active snapshot.
		const data =
			entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE
				? entry.data
				: entry.type === "message" &&
					  entry.message.role === "toolResult" &&
					  entry.message.toolName === "todo" &&
					  !entry.message.isError
					? entry.message.details
					: undefined;
		const edit = isRecord(data) ? data.edit : undefined;
		if (
			isRecord(edit) &&
			edit.v === 1 &&
			edit.kind === "archive" &&
			Array.isArray(edit.archivedPhases) &&
			edit.archivedPhases.every(isTodoPhase)
		)
			onSnapshot(edit.archivedPhases);
	}
	return latest ? clonePhases(latest) : [];
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	// #41: `done`/`drop` select exact batch rows from `items`; all other
	// targeting keeps base selection.
	if ((entry.op === "done" || entry.op === "drop") && entry.items !== undefined) {
		return selectCompletionBatchTargets(phases, entry, errors);
	}
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	// (optionally with a bare `phase`) instead of the canonical
	// `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
	// so a common, recoverable mistake isn't a hard error.
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// Duplicate phase names / task contents would be permanently unaddressable
	// (every targeting op resolves the first match), so reject them up front.
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		if (seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		}
		seenPhases.add(listEntry.phase);
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
		}
	}
	return list.map(listEntry => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>(content => {
			const task: TodoItem = { content, status: "pending" };
			bindArtifactCwd(task, activeArtifactCwd);
			return task;
		}),
	}));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	// Validate the whole batch before mutating so a failing op reports every
	// duplicate and leaves nothing half-applied.
	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		const task: TodoItem = { content, status: "pending" };
		bindArtifactCwd(task, activeArtifactCwd);
		phase.tasks.push(task);
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
					}
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "block": {
			if (!prepareAwaitingUserCheck(phases, entry, errors)) return phases;
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// Collapse whitespace runs (incl. newlines) to single spaces: a blocker
			// note rides on one Markdown checklist line (as a trailing HTML comment)
			// and one HUD/summary line, so an embedded newline from a multi-line
			// external error or user question would corrupt the round-trip parse and
			// the rendered line. Normalizing here keeps every consumer one-line-safe.
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				// Only actionable open work can be blocked: blocking a phase must not
				// reopen completed/abandoned tasks or erase finished progress. An
				// already-blocked task stays eligible so a later block can refine its
				// blocker note (e.g. first blocked without a reason, then with one).
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				task.status = "blocked";
				task.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
			if (!prepareAwaitingUserCheck(phases, entry, errors)) return phases;
			if (!entry.task && !entry.phase) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
				}
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
		case "view":
			return phases;
	}
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append` (lazily creates the phase, so the result
 *   matches a single-phase init when nothing exists yet)
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
function inferTodoOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (typeof args.phase === "string" && args.phase) return "append";
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. The tool sets
 * `lenientArgValidation`, so the agent loop hands `execute()` the raw
 * arguments when schema validation fails; the only failure repaired here is
 * a missing `op` alongside an unambiguous payload (models routinely send
 * `{list:[...]}` with no op). Anything else returns the schema error text
 * for a normal model retry.
 */
function resolveTodoParams(raw: unknown, hasExistingPhases: boolean): TodoOpEntryValue | string {
	const direct = todoSchema(raw);
	if (!(direct instanceof type.errors)) return direct;
	if (isRecord(raw) && raw.op === undefined) {
		const inferred = inferTodoOp(raw, hasExistingPhases);
		if (inferred) {
			const repaired = todoSchema({ ...raw, op: inferred });
			if (!(repaired instanceof type.errors)) return repaired;
		}
	}
	return `Invalid todo arguments: ${direct.summary}`;
}

function applyParams(phases: TodoPhase[], params: TodoOpEntryValue): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const next = applyEntry(phases, params, errors);
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpEntryValue[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	// Standalone use has no session checkout: never inherit a stale slot value.
	activeArtifactCwd = undefined;
	let next = clonePhases(currentPhases);
	for (const op of ops) {
		next = applyEntry(next, op, errors);
	}
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
	blocked: "!",
};

export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = normalizePathLikeInput(input) || "TODO.md";
	return resolveToCwd(raw, cwd);
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		for (const task of phases[i].tasks) {
			// A blocked task's reason rides in a trailing HTML comment: invisible in
			// rendered markdown, unambiguous to parse back (task content can't
			// contain the comment delimiters), so the note survives `/todo edit` and
			// export/import round-trips.
			const blockerNote = task.status === "blocked" && task.blocker ? ` <!-- blocker: ${task.blocker} -->` : "";
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}${blockerNote}`);
		}
	}
	return `${out.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
	"!": "blocked",
};

import {
	createTodoToolSchema,
	type TodoToolParams as TodoToolParamsType,
	type TodoToolSchema,
} from "./todo-classify-schema";

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];

		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			currentPhase = { name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		// Tolerate backslash-escaped brackets (`- \[x\]`): some editors and
		// markdown serializers escape `[` (and `]`) when round-tripping, yet the
		// line still renders as a normal `[x]` checkbox. Accept either form.
		const taskMatch = /^[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-], [!])`);
				continue;
			}
			// Recover a blocked task's reason from its trailing HTML comment (see
			// phasesToMarkdown), then strip the comment from the visible content.
			const rawContent = taskMatch[2].trim();
			const blockerMatch = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(rawContent);
			if (status === "blocked" && blockerMatch) {
				currentPhase.tasks.push({ content: blockerMatch[1].trim(), status, blocker: blockerMatch[2].trim() });
			} else {
				currentPhase.tasks.push({ content: rawContent, status });
			}
			continue;
		}

		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}

	normalizeInProgressTask(phases);
	return { phases, errors };
}

function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	let currentIdx = phases.findIndex(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
		}
	}
	// Closed = completed + abandoned, mirroring the per-phase `done` count.
	const closedAll = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const blockedAll = tasks.filter(task => task.status === "blocked").length;
	// The active phase is the EARLIEST one still holding open work, so the
	// in-progress pointer can sit in a phase whose successors already have
	// completed tasks. Detect that "worked ahead" case to explain the
	// otherwise-surprising backward pointer instead of letting it read as a
	// completed task reverting to pending.
	const workedAhead = phases.some(
		(phase, idx) =>
			idx > currentIdx && phase.tasks.some(task => task.status === "completed" || task.status === "abandoned"),
	);
	lines.push(
		`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
			workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? task.blocker
								? ` (blocked: ${task.blocker})`
								: " (blocked)"
							: "";
			lines.push(`    - ${checkbox} ${task.content}${tag}`);
		}
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<TodoToolSchema<TodoSchema>, TodoToolDetails> {
	private static readonly schema: TodoToolSchema<TodoSchema> = createTodoToolSchema(todoSchema);
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Track structured todos and classify requirements";
	readonly description: string;
	readonly parameters = TodoTool.schema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	// Raw args reach execute() on schema failure; resolveTodoParams re-validates
	// and repairs the one recoverable shape (missing `op`, unambiguous payload).
	readonly lenientArgValidation = true;

	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = `${prompt.render(todoDescription)}\n\n${prompt.render(todoRequirementsDescription)}`;
	}

	async execute(
		_toolCallId: string,
		params: TodoToolParamsType<TodoSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const result = await this.#executeTodo(_toolCallId, params, _signal, _onUpdate, _context);
		if (result.details?.op === "view" && this.session.sessionManager) {
			const amendments = getLatestRequirements(this.session.sessionManager.getBranch()).flatMap(requirement =>
				(requirement.amendments ?? []).map(amendment =>
					amendment.supersededBy
						? `${requirement.id} superseded by ${amendment.supersededBy} at ${amendment.at}: ${amendment.oldClassification} -> ${amendment.newClassification}; rows ${JSON.stringify(amendment.oldRows)} -> ${JSON.stringify(amendment.newRows)} (${amendment.reason})`
						: `${requirement.id} relinked at ${amendment.at}: rows ${JSON.stringify(amendment.oldRows)} -> ${JSON.stringify(amendment.newRows)} (${amendment.reason})`,
				),
			);
			if (amendments.length > 0) {
				for (const content of result.content) {
					if (content.type === "text") content.text += `\n${amendments.join("\n")}`;
				}
			}
		}
		return result;
	}

	async #executeTodo(
		_toolCallId: string,
		params: TodoToolParamsType<TodoSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		// Publish the session checkout for rows created below. Set here at the
		// top of execute() (untouched by #92); row-creating ops reach
		// applyParams synchronously, and todo concurrency is exclusive.
		activeArtifactCwd = this.session.cwd;
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const rawOp: unknown = params.op;
		if (rawOp === "classify") return this.#classify(params, previousPhases, storage);
		if (rawOp === "done") {
			const gate = await this.#doneGate(params, previousPhases, storage, _signal);
			if (gate) return gate;
		}
		const resolved = resolveTodoParams(params, previousPhases.length > 0);
		if (typeof resolved === "string") {
			return {
				content: [{ type: "text", text: resolved }],
				details: { phases: previousPhases, storage },
				isError: true,
			};
		}
		const entry = resolved;
		const sessionManager = this.session.sessionManager;
		if ((entry.op === "rm" || entry.op === "init") && sessionManager) {
			const linkedRequirements = getLatestRequirements(sessionManager.getBranch()).filter(
				requirement => requirement.classification === "linked",
			);
			const targetErrors: string[] = [];
			const removedRows = new Set<string>();
			if (entry.op === "rm") {
				for (const task of getTaskTargets(previousPhases, entry, targetErrors)) removedRows.add(task.content);
			} else {
				const replacementRows = new Set(entry.list?.flatMap(item => item.items) ?? entry.items ?? []);
				for (const requirement of linkedRequirements) {
					for (const row of requirement.rows) {
						if (!replacementRows.has(row) && findTaskByContent(previousPhases, row)) removedRows.add(row);
					}
				}
			}
			const blocked = linkedRequirements.flatMap(requirement =>
				requirement.rows.filter(row => removedRows.has(row)).map(row => ({ requirement, row })),
			);
			if (targetErrors.length === 0 && blocked.length > 0) {
				const unfinished = blocked.find(
					({ row }) => findTaskByContent(previousPhases, row)?.task.status !== "completed",
				);
				if (unfinished) {
					const { requirement, row } = unfinished;
					return {
						content: [
							{
								type: "text",
								text: `Blocked: cannot remove unfinished requirement-linked TODO row ${JSON.stringify(row)} (${requirement.id}). Obtain a fresh qa-auditor pass and mark the row done before removing it, or relink the requirement with relink=true and a reason to its replacement row.`,
							},
						],
						details: { op: entry.op, phases: previousPhases, storage },
						isError: true,
					};
				}
				// Completed rows may leave the active plan only while their saved QA
				// evidence is still fresh. Canonical snapshots retain their artifact history.
				const gate = await this.#doneGate(
					{ items: [...new Set(blocked.map(({ row }) => row))] },
					previousPhases,
					storage,
					_signal,
				);
				if (gate) {
					if (gate.details) gate.details.op = entry.op;
					return gate;
				}
			}
		}
		// Slash commands and worker completion can edit the plan during an artifact
		// probe even though native todo calls are exclusive. Never publish that stale
		// snapshot: retry must select and audit the current rows and bindings.
		const currentPhases = this.session.getTodoPhases?.() ?? [];
		if (JSON.stringify(currentPhases) !== JSON.stringify(previousPhases)) {
			return {
				content: [
					{
						type: "text",
						text: "Blocked: TODO state changed during the artifact check. Retry against the current plan; no changes were applied.",
					},
				],
				details: { op: entry.op, phases: clonePhases(currentPhases), storage },
				isError: true,
			};
		}
		const op = entry.op;
		// Pure-view calls are reads: no normalization, no state write.
		const readOnly = op === "view";
		const { phases: updated, errors } = readOnly
			? { phases: previousPhases, errors: [] as string[] }
			: applyParams(clonePhases(previousPhases), entry);
		// A batch with any error is discarded wholesale: persisting a
		// half-applied batch makes the natural retry hit "already exists" for
		// the ops that did land. State and rendered summary stay at previous.
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const details: TodoToolDetails = { op, phases: effective, storage };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;

		return {
			content: [{ type: "text", text: formatSummary(effective, errors, readOnly) }],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}

	/** Native completion delegates row evidence and refusal reasons to the shared ledger owner. */
	async #doneGate(
		params: Record<string, unknown>,
		previousPhases: TodoPhase[],
		storage: "memory" | "session",
		signal?: AbortSignal,
	): Promise<AgentToolResult<TodoToolDetails> | undefined> {
		const sessionManager = this.session.sessionManager;
		if (!sessionManager) return undefined;
		const task = typeof params.task === "string" ? params.task : undefined;
		const phase = typeof params.phase === "string" ? params.phase : undefined;
		const items = Array.isArray(params.items)
			? params.items.filter((item): item is string => typeof item === "string")
			: undefined;
		const selectorErrors: string[] = [];
		const targets = getCompletionTargets(previousPhases, { task, phase, items }, selectorErrors);
		if (selectorErrors.length === 0) {
			// Gate checks need persisted requirements and Todo state, not conversation bodies.
			const branch = matchingRequirementBranch(
				sessionManager,
				entry =>
					(entry.type === "custom" &&
						(entry.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE ||
							entry.customType === REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE ||
							entry.customType === USER_TODO_EDIT_CUSTOM_TYPE)) ||
					(entry.type === "message" && entry.messageRole === "toolResult" && entry.toolName === "todo"),
			);
			const changes = getTodoRowChanges(branch);
			const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();
			const open = await evaluateRequirementDoneGate(
				getLatestRequirements(branch),
				targets.map(target => target.content),
				async (row, receipt) => ({
					...(await getRequirementRowArtifact(
						{ cwd: this.session.cwd, sessionManager, signal, receipt },
						row,
						previousPhases,
						checkoutCache,
					)),
					lastChange: changes.get(row),
				}),
				getPersistedRequirementAuditRejections(branch, sessionManager.getSessionId?.() ?? null),
			);
			if (open.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: formatDoneGateRefusal(open),
						},
					],
					details: { op: "done", phases: previousPhases, storage },
					isError: true,
				};
			}
		}
		return undefined;
	}

	/** #41's classify path, dispatched on raw args before the shared schema. The shared
	 *  TodoOp union and TodoOperation in `@oh-my-pi/pi-tui/tools/todo` stay at base text;
	 *  only this tool's local TodoOp/todoSchema expose classify so the model can see the op. */
	async #classify(
		params: Record<string, unknown>,
		previousPhases: TodoPhase[],
		storage: string,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const details = { op: "classify", phases: previousPhases, storage } as unknown as TodoToolDetails;
		const id = typeof params.id === "string" ? params.id : undefined;
		const rawClassification = params.classification;
		const classification =
			rawClassification === "linked" || rawClassification === "not-a-requirement" || rawClassification === "merged"
				? rawClassification
				: undefined;
		const rows = Array.isArray(params.rows)
			? params.rows.filter((row): row is string => typeof row === "string")
			: undefined;
		const reason = typeof params.reason === "string" ? params.reason : undefined;
		const mergeInto = typeof params.mergeInto === "string" ? params.mergeInto : undefined;
		if (!id || !classification) {
			return {
				content: [
					{
						type: "text",
						text: `Blocked: classify requires an Rn id and classification. Call todo with op="classify", id="<Rn>", classification="linked", rows=["<exact todo row>"] (or classification="not-a-requirement" with reason="<why this is not a requirement>", or classification="merged" with mergeInto="<other Rn>"). Then retry`,
					},
				],
				details,
				isError: true,
			};
		}
		const sessionManager = this.session.sessionManager;
		if (!sessionManager) {
			return {
				content: [
					{
						type: "text",
						text: `Blocked: classify requires persistent session storage. Retry the same call todo with op="classify", id="${id ?? "<Rn>"}", classification="<linked|not-a-requirement|merged>" in a persisted session`,
					},
				],
				details,
				isError: true,
			};
		}
		let archivedTargets: TodoPhase[] = [];
		if (classification === "linked") {
			const missingActiveRows = (rows ?? []).filter(row => !findTaskByContent(previousPhases, row));
			if (missingActiveRows.length > 0) {
				const historical = new Map<string, TodoPhase>();
				observeLatestTodoPhases(sessionManager.getBranch(), snapshot => {
					for (const phase of snapshot) {
						for (const task of phase.tasks) {
							if (missingActiveRows.includes(task.content))
								historical.set(task.content, { name: phase.name, tasks: [cloneTask(task)] });
						}
					}
				});
				archivedTargets = [...historical.values()];
			}
			const unknownRows = missingActiveRows.filter(row => !findTaskByContent(archivedTargets, row));
			if (unknownRows.length > 0) {
				const available = previousPhases.flatMap(phase => phase.tasks.map(task => JSON.stringify(task.content)));
				return {
					content: [
						{
							type: "text",
							text: `Blocked: unknown TODO rows for ${id}: ${unknownRows.map(row => JSON.stringify(row)).join(", ")}. Available rows: ${available.length > 0 ? available.join(", ") : '(none: first create one with todo op="append", items=["<exact todo row>"] (or op="init"))'}. Call todo with op="classify", id="${id}", classification="linked", rows=[<exact existing row>]. Then retry`,
						},
					],
					details,
					isError: true,
				};
			}
		}
		const requirements = getLatestRequirements(sessionManager.getBranch());
		// A candidate has no prior requirement binding to relink; its first
		// classification may atomically replace the row's provisional artifact.
		const initialClassification =
			requirements.find(requirement => requirement.id === id)?.classification === "candidate";
		const resourcesSupplied = params.resources !== undefined;
		const resources = Array.isArray(params.resources)
			? params.resources.filter((resource): resource is string => typeof resource === "string")
			: undefined;
		const deploymentSupplied = params.deployment !== undefined;
		let deployment: TodoDeploymentBinding | undefined;
		if (deploymentSupplied) {
			const value = params.deployment;
			const parsed =
				typeof value === "string" ? parseRequirementIdentity(value) : { error: "deployment must be a string" };
			if (
				classification !== "linked" ||
				!Array.isArray(params.rows) ||
				params.rows.length === 0 ||
				params.rows.some(row => typeof row !== "string" || !row.trim()) ||
				"error" in parsed ||
				parsed.identity.kind !== "deploy" ||
				resourcesSupplied
			) {
				return {
					content: [
						{
							type: "text",
							text: `Blocked: deployment for ${id} requires classification="linked", nonempty exact TODO rows, and one canonical deploy identity${"error" in parsed ? ` (${parsed.error})` : ""}; deployment and resources are mutually exclusive. Call todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"], deployment="deploy:<HTTP(S) URL>@<version> field=<dot.path>" (or "deploy:<unit.service>@<version> scope=<user|system> env=<ENV_IDENTIFIER>"). Then retry`,
						},
					],
					details,
					isError: true,
				};
			}
			deployment = formatRequirementIdentity(parsed.identity);
		}
		if (
			resourcesSupplied &&
			(classification !== "linked" ||
				!resources ||
				resources.length === 0 ||
				resources.length !== (params.resources as unknown[]).length ||
				resources.some(path => !nodePath.isAbsolute(path)))
		) {
			return {
				content: [
					{
						type: "text",
						text: `Blocked: resources for ${id} must be a nonempty list of absolute paths on classification="linked". Call todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"], resources=["/absolute/file-or-checkout"]. Then retry`,
					},
				],
				details,
				isError: true,
			};
		}
		const affectedRows = new Set<string>();
		let replacingBinding = false;
		for (const task of [...previousPhases, ...archivedTargets].flatMap(phase => phase.tasks)) {
			if (!rows?.includes(task.content)) continue;
			const schedule = "schedule" in task && isRecord(task.schedule) ? task.schedule : undefined;
			const hasResources = Array.isArray(schedule?.resources) && schedule.resources.length > 0;
			if (deployment) {
				const previous = task.deployment;
				if (previous !== deployment) {
					affectedRows.add(task.content);
					if (previous || hasResources) replacingBinding = true;
				}
			} else if (resources) {
				// Resource identity is the order-independent manifest (common parent plus
				// sorted entries), so a pure reorder binds the same artifact, not a replacement.
				const previousResources = Array.isArray(schedule?.resources)
					? schedule.resources.filter((entry): entry is string => typeof entry === "string")
					: [];
				const sameResourceSet =
					!task.deployment &&
					previousResources.length === resources.length &&
					JSON.stringify([...previousResources].sort()) === JSON.stringify([...resources].sort());
				if (!sameResourceSet) {
					affectedRows.add(task.content);
					if (task.deployment || hasResources) replacingBinding = true;
				}
			}
		}
		if (replacingBinding && !initialClassification && (params.relink !== true || !reason?.trim())) {
			return {
				content: [
					{
						type: "text",
						text: `Blocked: replacing a saved deployment or resource binding for ${id} requires relink=true and a nonblank reason. Call todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"], relink=true, reason="<why the artifact binding changes>", deployment="deploy:<HTTP(S)-URL>@<version> field=<dot.path>" (or deployment="deploy:<literal.service>@<version> scope=<user|system> env=<ENV_KEY>", or resources=["/absolute/file-or-checkout"]). Then retry`,
					},
				],
				details,
				isError: true,
			};
		}
		const result = classifyRequirement(requirements, id, classification, {
			rows,
			reason,
			mergeInto,
			relink: params.relink === true,
			supersededBy: typeof params.supersededBy === "string" ? params.supersededBy : undefined,
		});
		if ("error" in result) return { content: [{ type: "text", text: result.error }], details, isError: true };
		if (resources || deployment) {
			// Omitted bindings remain untouched; an explicit cutover stores exactly
			// one primary artifact descriptor on each selected row.
			const phases = clonePhases(previousPhases);
			const archivedPhases = clonePhases(archivedTargets);
			for (const task of [...phases, ...archivedPhases].flatMap(phase => phase.tasks)) {
				if (!rows?.includes(task.content)) continue;
				const schedule = "schedule" in task && isRecord(task.schedule) ? task.schedule : {};
				if (deployment) {
					task.deployment = deployment;
					if (Object.hasOwn(schedule, "resources")) {
						const updatedSchedule = { ...schedule };
						delete updatedSchedule.resources;
						Object.assign(task, { schedule: updatedSchedule });
					}
				} else if (resources) {
					delete task.deployment;
					Object.assign(task, { schedule: { ...schedule, resources: [...resources] } });
				}
			}
			sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases,
				...(archivedPhases.length > 0
					? {
							edit: { v: 1, kind: "archive", at: Date.now(), archivedPhases },
						}
					: {}),
			});
			this.session.setTodoPhases?.(phases);
			details.phases = phases;
		}
		if (affectedRows.size > 0) {
			result.requirements = result.requirements.map(requirement => {
				if (!requirement.rows.some(row => affectedRows.has(row))) return requirement;
				const updated = { ...requirement };
				const rowVerdicts = { ...requirement.rowVerdicts };
				for (const row of requirement.rows) {
					if (affectedRows.has(row)) {
						delete rowVerdicts[row];
					} else if (!Object.hasOwn(rowVerdicts, row)) {
						const verdict = getRequirementRowVerdict(requirement, row);
						if (verdict) {
							Object.defineProperty(rowVerdicts, row, {
								value: verdict,
								enumerable: true,
								configurable: true,
								writable: true,
							});
						}
					}
				}
				delete updated.verdict;
				if (Object.keys(rowVerdicts).length > 0) updated.rowVerdicts = rowVerdicts;
				else delete updated.rowVerdicts;
				return updated;
			});
		}
		appendRequirementsSnapshot(
			{ appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data) },
			result.requirements,
		);
		await sessionManager.flush();
		return {
			content: [{ type: "text", text: `Classified ${id} as ${classification}.` }],
			details,
		};
	}
}
