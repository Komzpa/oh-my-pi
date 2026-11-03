import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import continueReminder from "./worker-continue.md" with { type: "text" };

const READ_ONLY_ROLES = new Set([
	"scout",
	"researcher",
	"reviewer",
	"visual-qa",
	"adversary",
	"user-shadow",
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
		if (repo && (await repo.statusPorcelain({ untracked: "no" })).trim())
			failure = "Uncommitted tracked changes: commit or discard, then yield";
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
