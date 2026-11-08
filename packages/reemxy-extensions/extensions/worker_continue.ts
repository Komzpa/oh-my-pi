import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import { fileToolTargets, liveWorkerRows } from "./dispatch_preflight";
import continueReminder from "./worker-continue.md" with { type: "text" };

const READ_ONLY_ROLES = new Set([
	"scout",
	"researcher",
	"reviewer",
	"visual-qa",
	"adversary",
	"qa-auditor",
	"security-reviewer",
	"architect",
	"plan-doctor",
	"business-analyst",
	"retro-facilitator",
]);
export const MAX_WORKER_REFUSALS = 6;
export const BLOCKER_YIELDS_REQUIRED = 3;
export const GOAL_CAP_ANNOTATION = "goal cap reached; partial";

export interface WorkerContinuationState {
	refusals: number;
	blocker?: string;
	blockerYields: number;
	budgetStopped: boolean;
}

export type WorkerEvidence = { commit: string } | { path: string } | { command: string };
export interface WorkerRequirement {
	requirement: string;
	done: boolean;
	evidence: WorkerEvidence;
}

const HANDOFF =
	/\b(?:lead|main|parent|orchestrator|caller)\b[^.\n]{0,40}\bcommits?\b|\b(?:do not|don't|never)\s+commit\b|\bedit[- ]only\b|\bonly edit\b/i;

/** Status paths are worktree-relative; derive the worktree root from the cwd prefix. */
function worktreeRoot(repo: { prefixOf(dir: string): string | null }, cwd: string): string {
	const prefix = repo.prefixOf(cwd) ?? "";
	const depth = prefix.split("/").filter(Boolean).length;
	let root = path.resolve(cwd);
	for (let i = 0; i < depth; i++) root = path.dirname(root);
	return root;
}
function stripResource(resource: string): string {
	return resource.replace(/^(?:path|repo|repository|checkout|worktree):/, "").replace(/:[^/]+$/, "");
}
function within(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${path.sep}`);
}
function statusPaths(porcelain: string): string[] {
	const out: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (line.length < 4) continue;
		for (const part of line.slice(3).split(" -> ")) out.push(part.replace(/^"(.*)"$/, "$1"));
	}
	return out;
}
function writtenTargets(ctx: ExtensionContext): string[] {
	const branch = ctx.sessionManager.getBranch();
	const start = branch.findIndex(entry => entry.type === "session_init");
	const targets: string[] = [];
	for (const entry of start < 0 ? [] : branch.slice(start + 1)) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content)
			if (part.type === "toolCall" && ["edit", "write", "ast_edit"].includes(part.name))
				targets.push(...fileToolTargets((part.arguments ?? {}) as Record<string, unknown>));
	}
	return targets;
}
/** Dirty tracked paths this worker owns: its row resources below the repo root plus files it wrote. */
function ownedDirt(porcelain: string, root: string, ctx: ExtensionContext): string[] {
	const owned = [
		...liveWorkerRows(ctx)
			.flatMap(row => row.schedule?.resources ?? [])
			.map(stripResource),
		...writtenTargets(ctx),
	]
		.filter(target => !target.includes("://"))
		.map(target => path.resolve(ctx.cwd, target))
		.filter(target => target !== root && within(root, target));
	return statusPaths(porcelain).filter(rel => owned.some(target => within(target, path.resolve(root, rel))));
}
/** The brief, row, or later parent IRC says to hand off uncommitted owned edits. */
function editOnlyHandoff(ctx: ExtensionContext): boolean {
	const texts = liveWorkerRows(ctx).map(row => row.content);
	let briefSeen = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content as unknown;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map(part => (part as { text?: string }).text ?? "").join("\n")
					: "";
		if (!briefSeen) {
			texts.push(text);
			briefSeen = true;
		} else if (entry.message.attribution === "agent") {
			for (const match of text.matchAll(/<irc from="parent"[^>]*>([\s\S]*?)<\/irc>/g)) texts.push(match[1]!);
		}
	}
	return texts.some(text => HANDOFF.test(text));
}

async function verifyEvidence(value: unknown, ctx: ExtensionContext): Promise<string | undefined> {
	if (!value || typeof value !== "object") return "missing evidence";
	const evidence = value as Record<string, unknown>;
	const keys = Object.keys(evidence);
	if (keys.length !== 1 || !["commit", "path", "command"].includes(keys[0]!))
		return "evidence must contain one commit, path, or command";
	const key = keys[0]!;
	const item = evidence[key];
	if (typeof item !== "string" || !item.trim()) return `empty ${key} evidence`;
	if (key === "path") {
		try {
			await fs.stat(path.resolve(ctx.cwd, item));
			return;
		} catch {
			return `path does not exist: ${item}`;
		}
	}
	if (key === "commit") {
		try {
			const repo = vcs.requireGit(ctx.cwd);
			const commit = await repo.resolveRef(`${item}^{commit}`);
			if (!commit) return `commit does not exist: ${item}`;
			if ((await repo.mergeBase(commit, "HEAD")) !== commit) return `commit is not reachable from HEAD: ${item}`;
			return;
		} catch {
			return `commit does not exist: ${item}`;
		}
	}
	const calls = new Set<string>();
	const branch = ctx.sessionManager.getBranch();
	const start = branch.findIndex(entry => entry.type === "session_init");
	for (const entry of start < 0 ? [] : branch.slice(start + 1)) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content)
				if (part.type === "toolCall" && part.name === "bash" && part.arguments?.command === item)
					calls.add(part.id);
		} else if (
			message.role === "toolResult" &&
			calls.has(message.toolCallId) &&
			message.isError === false &&
			(message.details as { exitCode?: unknown } | undefined)?.exitCode === 0
		)
			return;
	}
	return `command has no successful result in this worker's history: ${item}`;
}

/** Terminal mutation workers must prove completion from their own execution state. */
export async function workerYieldRefusal(
	input: unknown,
	ctx: ExtensionContext,
	workers: Map<string, WorkerContinuationState>,
	toolCallId?: string,
): Promise<ToolCallEventResult | undefined> {
	if (ctx.agent.kind !== "sub" || READ_ONLY_ROLES.has(ctx.agent.name)) return;
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	if (Array.isArray(args.type) && args.type.length > 0) return;
	const state = workers.get(ctx.agent.id) ?? { refusals: 0, blockerYields: 0, budgetStopped: false };
	workers.set(ctx.agent.id, state);
	const ownSession = ctx.sessionManager.getHeader()?.id;
	state.budgetStopped ||= ctx.sessionManager
		.getBranch()
		.some(
			entry =>
				entry.type === "custom" &&
				entry.customType === "worker-budget-stop" &&
				(entry.data as { sessionId?: unknown } | undefined)?.sessionId === ownSession &&
				ownSession !== undefined,
		);
	if (state.budgetStopped) return;
	let failure: string | undefined;
	try {
		const repo = vcs.git(ctx.cwd);
		if (repo) {
			const dirty = ownedDirt(await repo.statusPorcelain({ untracked: "no" }), worktreeRoot(repo, ctx.cwd), ctx);
			if (dirty.length && !editOnlyHandoff(ctx))
				failure = `Uncommitted tracked changes in your own paths (${dirty.slice(0, 5).join(", ")}): commit them, then yield`;
		}
	} catch {
		failure = "Cannot verify worktree state";
	}
	const rows = args.requirements;
	if (!Array.isArray(rows) || rows.length === 0)
		failure ??= "requirements must list every requirement with done and evidence";
	if (Array.isArray(rows))
		for (const [index, raw] of rows.entries()) {
			const row = raw as Partial<WorkerRequirement> | null;
			if (!row || typeof row.requirement !== "string" || !row.requirement.trim() || typeof row.done !== "boolean") {
				failure ??= `requirement ${index + 1}: invalid requirement or done field`;
				continue;
			}
			const error = await verifyEvidence(row.evidence, ctx);
			if (error) failure ??= `requirement ${index + 1} (${row.requirement}): ${error}`;
			if (!row.done && !args.blocker)
				failure ??= `requirement ${index + 1} (${row.requirement}): done:false without a blocker`;
		}
	const blocker = args.blocker as { kind?: unknown; evidence?: unknown } | undefined;
	let blockerKey: string | undefined;
	if (blocker) {
		const error = await verifyEvidence(blocker.evidence, ctx);
		if (typeof blocker.kind !== "string" || !blocker.kind.trim() || error)
			failure ??= `blocker: ${error ?? "missing kind"}`;
		else blockerKey = JSON.stringify([blocker.kind, blocker.evidence]);
	}
	state.blockerYields = blockerKey ? (state.blocker === blockerKey ? state.blockerYields + 1 : 1) : 0;
	state.blocker = blockerKey;
	if (!failure && (!blockerKey || state.blockerYields >= BLOCKER_YIELDS_REQUIRED)) return;
	if (state.refusals >= MAX_WORKER_REFUSALS)
		return { input: { error: `${GOAL_CAP_ANNOTATION}\n${JSON.stringify(args)}` } };
	state.refusals++;
	return { block: true, reason: prompt.render(continueReminder, { failure, blocker: Boolean(blockerKey) }).trim() };
}
