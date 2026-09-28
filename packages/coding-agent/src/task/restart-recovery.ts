import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IrcBus } from "../irc/bus";
import restartContinuationPrompt from "../prompts/restart-continuation.md" with { type: "text" };
import restartRootContinuationPrompt from "../prompts/restart-root-continuation.md" with { type: "text" };
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, getAgentTombstonePath, MAIN_AGENT_ID, type AgentRef } from "../registry/agent-registry";
import { ensurePersistedRoster, isAgentSessionFileInRootTree } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import {
	collectPendingToolCalls,
	summarizeToolArguments,
	type PendingToolCallDiagnostic,
} from "../session/exit-diagnostics";
import { SessionManager, hasConversationalHistory } from "../session/session-manager";
import type { SessionEntry } from "../session/session-entries";

const RESTART_HANDOFF_TYPE = "subagent_restart_handoff";
const RESTART_RECEIPT_TYPE = "subagent_restart_receipt";
const RESTART_HANDOFF_VERSION = 1;
const RESTART_ROOT_RECEIPT_TYPE = "root_restart_continuation_receipt";
const RESTART_ROOT_RECEIPT_VERSION = 1;
type RootContinuationOutcome =
	| "continuation-claimed"
	| "continuation-delivered"
	| "continuation-failed"
	| "continuation-uncertain";

interface RootContinuationReceipt {
	version: 1;
	rootSessionId: string;
	requestId: string;
	outcome: RootContinuationOutcome;
	recordedAt: number;
	deliveryOutcome?: string;
	reason?: string;
}

export interface RootContinuationResult {
	state: "delivered" | "already-delivered" | "blocked";
	reason?: string;
}

export type LiveRestartSubagent = AgentRef & { session: AgentSession };

function rootSubagentRefs(rootSession: AgentSession, registry: AgentRegistry): AgentRef[] {
	const rootRef = registry.list().find(ref => ref.kind === "main" && ref.session === rootSession);
	const rootAgentId = rootRef?.id ?? MAIN_AGENT_ID;
	const rootSessionFile = rootSession.sessionManager.getSessionFile();
	return registry.list().filter(ref => {
		if (ref.kind !== "sub" || ref.status === "aborted") return false;
		if (rootSessionFile) {
			if (isAgentSessionFileInRootTree(ref.sessionFile, rootSessionFile)) return true;
			return !ref.sessionFile && parentChainIncludesRoot(ref, rootAgentId, registry);
		}
		return parentChainIncludesRoot(ref, rootAgentId, registry);
	});
}

/** Return only already-live, root-owned child sessions; parked agents are never revived to drain. */
export function getLiveSubagentsForRestart(rootSession: AgentSession): LiveRestartSubagent[] {
	return rootSubagentRefs(rootSession, AgentRegistry.global()).filter(
		(ref): ref is LiveRestartSubagent => ref.session !== null && ref.status !== "parked",
	);
}
const MAX_RESTART_SUBAGENTS = 256;
const MAX_NOTICE_ROWS = 8;

export interface RestartRecoveryPendingToolCalls {
	id: string;
	displayName: string;
	calls: PendingToolCallDiagnostic[];
}

export interface RestartRecoveryReport {
	/** Same-ID continuations with a confirmed delivery that are currently running. */
	resumed: string[];
	/** Sessions currently restored live as idle without starting a new turn. */
	restoredIdle: string[];
	/** Subagents intentionally left parked. */
	parked: string[];
	pendingToolCalls: RestartRecoveryPendingToolCalls[];
	failures: Array<{ id: string; reason: string }>;
}

type RestartChildStatus = "running" | "idle" | "parked";
type RestartReceiptOutcome =
	| "continuation-claimed"
	| "continuation-delivered"
	| "continuation-failed"
	| "idle-restored"
	| "parked-preserved"
	| "settled-during-restart"
	| "pending-tool-calls"
	| "tombstoned"
	| "revival-failed";

interface RestartChildSnapshot {
	id: string;
	sessionFile: string;
	parentId?: string;
	displayName: string;
	status: RestartChildStatus;
	settled: boolean;
}

interface RestartHandoff {
	version: 1;
	rootSessionId: string;
	rootSessionFile: string;
	capturedAt: number;
	requestId?: string;
	children: RestartChildSnapshot[];
	omittedChildren?: Array<{ id: string; reason: string }>;
}

interface RestartReceipt {
	version: 1;
	rootSessionId: string;
	handoffId: string;
	id: string;
	sessionFile: string;
	outcome: RestartReceiptOutcome;
	recordedAt: number;
	deliveryOutcome?: string;
	reason?: string;
}

interface RootSessionIdentity {
	rootSessionId: string;
	rootSessionFile: string;
}

function parentChainIncludesRoot(ref: AgentRef, rootAgentId: string, registry: AgentRegistry): boolean {
	let parentId = ref.parentId;
	const seen = new Set<string>();
	while (parentId && !seen.has(parentId)) {
		if (parentId === rootAgentId) return true;
		seen.add(parentId);
		parentId = registry.get(parentId)?.parentId;
	}
	return false;
}

async function isTombstoned(sessionFile: string): Promise<boolean> {
	try {
		await fs.access(getAgentTombstonePath(sessionFile));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function readBranchEntries(sessionFile: string, liveSession?: AgentSession | null): Promise<SessionEntry[]> {
	if (liveSession) return liveSession.sessionManager.getBranch();
	const manager = await SessionManager.open(sessionFile, undefined, undefined, {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	try {
		return manager.getBranch();
	} finally {
		await manager.close();
	}
}

/** Close only calls left without a result by the previous process. Their effects are unknown. */
async function closeInterruptedToolCalls(sessionFile: string): Promise<number> {
	const manager = await SessionManager.open(sessionFile, undefined, undefined, {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	try {
		const entries = manager.getBranch();
		const pending = collectPendingToolCalls(entries);
		if (pending.length === 0) return 0;
		const calls = new Map<string, { name: string; arguments: unknown }>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const part of entry.message.content) {
				if (part.type === "toolCall") calls.set(part.id, { name: part.name, arguments: part.arguments });
			}
		}
		for (const item of pending) {
			if (!item.toolCallId || !calls.has(item.toolCallId)) {
				throw new Error(`cannot close interrupted ${item.toolName} call without its persisted assistant call`);
			}
			const call = calls.get(item.toolCallId)!;
			manager.appendMessage({
				role: "toolResult",
				toolCallId: item.toolCallId,
				toolName: call.name,
				content: [
					{
						type: "text",
						text: "OMP exited while this call was in progress. Its effects are unknown; inspect the target before retrying.",
					},
				],
				details: { status: "interrupted", type: "restart-recovery" },
				isError: true,
				timestamp: Date.now(),
			});
		}
		await manager.flush();
		return pending.length;
	} finally {
		await manager.close();
	}
}

function isTerminalYieldResult(isError: boolean, details: unknown): boolean {
	if (isError) return false;
	if (details === null || typeof details !== "object" || Array.isArray(details)) return true;
	const result = details as { status?: unknown; type?: unknown };
	const type = result.type;
	return !(
		result.status === "success" &&
		Array.isArray(type) &&
		type.length > 0 &&
		type.every(item => typeof item === "string")
	);
}

/**
 * Detect only a terminal yield completed in the latest conversation turn. A
 * successful yield from an older turn is invalidated by any later assistant,
 * user, or custom-message entry; artifact files are deliberately not consulted.
 */
function latestTurnHasTerminalYield(entries: readonly SessionEntry[]): boolean {
	let latestYieldCallIds: string[] = [];
	let latestYieldResult = false;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			latestYieldCallIds = [];
			latestYieldResult = false;
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (
						part &&
						typeof part === "object" &&
						part.type === "toolCall" &&
						part.name === "yield" &&
						typeof part.id === "string"
					) {
						latestYieldCallIds.push(part.id);
					}
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			if (typeof message.toolCallId === "string" && latestYieldCallIds.includes(message.toolCallId)) {
				const isLatestYieldCall = latestYieldCallIds.at(-1) === message.toolCallId;
				if (isLatestYieldCall) {
					latestYieldResult = isTerminalYieldResult(message.isError === true, message.details);
				}
			}
			continue;
		}
		latestYieldCallIds = [];
		latestYieldResult = false;
	}
	return latestYieldResult;
}

async function validateRunningChild(ref: AgentRef): Promise<void> {
	const sessionFile = ref.sessionFile;
	if (!sessionFile) throw new Error("has no durable session transcript");
	const stat = await fs.stat(sessionFile).catch(() => undefined);
	if (!stat?.isFile()) throw new Error("has no readable durable session transcript");
	const peek = await SessionManager.peekSessionInit(sessionFile);
	if (!peek?.init) throw new Error("has no persisted session_init contract and cannot be revived safely");
	if (peek.init.isolated) throw new Error("was launched in isolation and is not revivable");
	try {
		await fs.stat(peek.cwd);
	} catch {
		throw new Error(`its recorded workspace is unavailable: ${peek.cwd}`);
	}
	const entries = await readBranchEntries(sessionFile, ref.session);
	if (!hasConversationalHistory(entries))
		throw new Error("has no persisted conversational history and cannot be revived safely");
}

function parseHandoff(entry: SessionEntry): RestartHandoff | undefined {
	if (entry.type !== "custom" || entry.customType !== RESTART_HANDOFF_TYPE) return undefined;
	const value = entry.data;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	if (
		data.version !== RESTART_HANDOFF_VERSION ||
		typeof data.rootSessionId !== "string" ||
		typeof data.rootSessionFile !== "string" ||
		typeof data.capturedAt !== "number" ||
		(data.requestId !== undefined && typeof data.requestId !== "string") ||
		!Array.isArray(data.children)
	) {
		return undefined;
	}
	const children: RestartChildSnapshot[] = [];
	for (const value of data.children) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const item = value as Record<string, unknown>;
		if (
			typeof item.id !== "string" ||
			typeof item.sessionFile !== "string" ||
			typeof item.displayName !== "string" ||
			(item.parentId !== undefined && typeof item.parentId !== "string") ||
			(item.status !== "running" && item.status !== "idle" && item.status !== "parked") ||
			typeof item.settled !== "boolean"
		) {
			return undefined;
		}
		children.push({
			id: item.id,
			sessionFile: item.sessionFile,
			parentId: item.parentId as string | undefined,
			displayName: item.displayName,
			status: item.status,
			settled: item.settled,
		});
	}
	return {
		version: RESTART_HANDOFF_VERSION,
		rootSessionId: data.rootSessionId,
		rootSessionFile: data.rootSessionFile,
		capturedAt: data.capturedAt,
		...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
		children,
	};
}

function parseReceipt(entry: SessionEntry): RestartReceipt | undefined {
	if (entry.type !== "custom" || entry.customType !== RESTART_RECEIPT_TYPE) return undefined;
	const value = entry.data;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	const outcomes: RestartReceiptOutcome[] = [
		"continuation-claimed",
		"continuation-delivered",
		"continuation-failed",
		"idle-restored",
		"parked-preserved",
		"settled-during-restart",
		"pending-tool-calls",
		"tombstoned",
		"revival-failed",
	];
	if (
		data.version !== RESTART_HANDOFF_VERSION ||
		typeof data.rootSessionId !== "string" ||
		typeof data.handoffId !== "string" ||
		typeof data.id !== "string" ||
		typeof data.sessionFile !== "string" ||
		!outcomes.includes(data.outcome as RestartReceiptOutcome) ||
		typeof data.recordedAt !== "number"
	) {
		return undefined;
	}
	return {
		version: RESTART_HANDOFF_VERSION,
		rootSessionId: data.rootSessionId,
		handoffId: data.handoffId,
		id: data.id,
		sessionFile: data.sessionFile,
		outcome: data.outcome as RestartReceiptOutcome,
		recordedAt: data.recordedAt,
		deliveryOutcome: typeof data.deliveryOutcome === "string" ? data.deliveryOutcome : undefined,
		reason: typeof data.reason === "string" ? data.reason : undefined,
	};
}

function latestHandoff(
	entries: readonly SessionEntry[],
	identity: RootSessionIdentity,
	requestId?: string,
): { entryId: string; handoff: RestartHandoff } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		const handoff = parseHandoff(entry);
		if (
			handoff &&
			(requestId === undefined || handoff.requestId === requestId) &&
			handoff.rootSessionId === identity.rootSessionId &&
			path.resolve(handoff.rootSessionFile) === identity.rootSessionFile
		) {
			return { entryId: entry.id, handoff };
		}
	}
	return undefined;
}

async function recordReceipt(
	session: AgentSession,
	identity: RootSessionIdentity,
	handoffId: string,
	child: RestartChildSnapshot,
	outcome: RestartReceiptOutcome,
	options?: { deliveryOutcome?: string; reason?: string },
): Promise<void> {
	session.sessionManager.appendCustomEntry(RESTART_RECEIPT_TYPE, {
		version: RESTART_HANDOFF_VERSION,
		rootSessionId: identity.rootSessionId,
		handoffId,
		id: child.id,
		sessionFile: child.sessionFile,
		outcome,
		recordedAt: Date.now(),
		...(options?.deliveryOutcome ? { deliveryOutcome: options.deliveryOutcome } : {}),
		...(options?.reason ? { reason: options.reason } : {}),
	} satisfies RestartReceipt);
	await session.sessionManager.flush();
}

function parseRootContinuationReceipt(entry: SessionEntry): RootContinuationReceipt | undefined {
	if (entry.type !== "custom" || entry.customType !== RESTART_ROOT_RECEIPT_TYPE) return undefined;
	const value = entry.data;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	const outcomes: RootContinuationOutcome[] = [
		"continuation-claimed",
		"continuation-delivered",
		"continuation-failed",
		"continuation-uncertain",
	];
	if (
		data.version !== RESTART_ROOT_RECEIPT_VERSION ||
		typeof data.rootSessionId !== "string" ||
		typeof data.requestId !== "string" ||
		!outcomes.includes(data.outcome as RootContinuationOutcome) ||
		typeof data.recordedAt !== "number"
	) {
		return undefined;
	}
	return {
		version: RESTART_ROOT_RECEIPT_VERSION,
		rootSessionId: data.rootSessionId,
		requestId: data.requestId,
		outcome: data.outcome as RootContinuationOutcome,
		recordedAt: data.recordedAt,
		deliveryOutcome: typeof data.deliveryOutcome === "string" ? data.deliveryOutcome : undefined,
		reason: typeof data.reason === "string" ? data.reason : undefined,
	};
}

function latestRootContinuationReceipt(
	entries: readonly SessionEntry[],
	rootSessionId: string,
	requestId: string,
): RootContinuationReceipt | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		const receipt = parseRootContinuationReceipt(entry);
		if (receipt?.rootSessionId === rootSessionId && receipt.requestId === requestId) return receipt;
	}
	return undefined;
}

async function recordRootContinuationReceipt(
	session: AgentSession,
	rootSessionId: string,
	requestId: string,
	outcome: RootContinuationOutcome,
	options?: { deliveryOutcome?: string; reason?: string },
): Promise<void> {
	if (session.sessionManager.getSessionId() !== rootSessionId) {
		throw new Error("root session identity changed before its continuation receipt could be persisted");
	}
	session.sessionManager.appendCustomEntry(RESTART_ROOT_RECEIPT_TYPE, {
		version: RESTART_ROOT_RECEIPT_VERSION,
		rootSessionId,
		requestId,
		outcome,
		recordedAt: Date.now(),
		...(options?.deliveryOutcome ? { deliveryOutcome: options.deliveryOutcome } : {}),
		...(options?.reason ? { reason: options.reason } : {}),
	} satisfies RootContinuationReceipt);
	await session.sessionManager.flush();
}

/** Claim the root continuation durably before delivery; unresolved claims are never replayed. */
export async function sendRootContinuationOnce(
	session: AgentSession,
	requestId: string,
): Promise<RootContinuationResult> {
	const rootSessionId = session.sessionManager.getSessionId();
	const rootRef = AgentRegistry.global()
		.list()
		.find(ref => ref.kind === "main" && ref.session === session);
	if (!rootRef) {
		const reason = "root session is not registered, so the restart continuation cannot be attributed safely";
		session.emitNotice("warning", reason, "restart-recovery");
		return { state: "blocked", reason };
	}
	const priorReceipt = latestRootContinuationReceipt(session.sessionManager.getBranch(), rootSessionId, requestId);
	if (priorReceipt?.outcome === "continuation-delivered") return { state: "already-delivered" };
	if (priorReceipt) {
		const reason =
			priorReceipt.reason ??
			(priorReceipt.outcome === "continuation-claimed"
				? "root continuation has a durable claim but no delivery receipt; it was not replayed"
				: "root continuation previously failed or had an uncertain outcome; it was not replayed");
		session.emitNotice("warning", reason, "restart-recovery");
		return { state: "blocked", reason };
	}
	await session.sessionManager.ensureOnDisk();
	await recordRootContinuationReceipt(session, rootSessionId, requestId, "continuation-claimed");
	let receipt: IrcDeliveryReceipt;
	try {
		receipt = await IrcBus.global().send({
			from: rootRef.id,
			to: rootRef.id,
			body: restartRootContinuationPrompt.trim(),
		});
	} catch (error) {
		const reason = `root continuation send threw after its durable claim; result is uncertain and it will not be retried: ${error instanceof Error ? error.message : String(error)}`;
		try {
			await recordRootContinuationReceipt(session, rootSessionId, requestId, "continuation-uncertain", { reason });
		} catch (receiptError) {
			session.emitNotice(
				"error",
				`${reason}; the uncertainty receipt could not be flushed: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`,
				"restart-recovery",
			);
			return { state: "blocked", reason };
		}
		session.emitNotice("warning", reason, "restart-recovery");
		return { state: "blocked", reason };
	}
	if (receipt.outcome === "failed") {
		const reason = `root continuation delivery failed or has an uncertain result after its durable claim; it will not be retried: ${receipt.error ?? "delivery failed"}`;
		await recordRootContinuationReceipt(session, rootSessionId, requestId, "continuation-failed", {
			deliveryOutcome: receipt.outcome,
			reason,
		});
		session.emitNotice("warning", reason, "restart-recovery");
		return { state: "blocked", reason };
	}
	try {
		await recordRootContinuationReceipt(session, rootSessionId, requestId, "continuation-delivered", {
			deliveryOutcome: receipt.outcome,
		});
		return { state: "delivered" };
	} catch (error) {
		const reason = `root continuation was delivered (${receipt.outcome}) but its receipt could not be persisted; the durable claim will prevent replay: ${error instanceof Error ? error.message : String(error)}`;
		session.emitNotice("error", reason, "restart-recovery");
		return { state: "blocked", reason };
	}
}

function receiptMap(
	entries: readonly SessionEntry[],
	rootSessionId: string,
	handoffId: string,
): Map<string, RestartReceipt> {
	const receipts = new Map<string, RestartReceipt>();
	for (const entry of entries) {
		const receipt = parseReceipt(entry);
		if (receipt?.rootSessionId === rootSessionId && receipt.handoffId === handoffId)
			receipts.set(receipt.id, receipt);
	}
	return receipts;
}

function formatPendingCalls(calls: readonly PendingToolCallDiagnostic[]): string {
	return calls
		.slice(0, 4)
		.map(call => {
			const args = summarizeToolArguments(call.args);
			const where = args?.command ? ` command \`${args.command}\`` : args?.path ? ` path \`${args.path}\`` : "";
			return `${call.toolName}${call.toolCallId ? ` ${call.toolCallId}` : ""}${where}`;
		})
		.join(", ");
}

function emitReportNotice(session: AgentSession, report: RestartRecoveryReport): void {
	if (report.pendingToolCalls.length === 0 && report.failures.length === 0) return;
	const rows: string[] = [];
	for (const pending of report.pendingToolCalls.slice(0, MAX_NOTICE_ROWS)) {
		rows.push(`${pending.displayName} (${pending.id}): unresolved tool calls ${formatPendingCalls(pending.calls)}.`);
	}
	for (const failure of report.failures.slice(0, Math.max(0, MAX_NOTICE_ROWS - rows.length))) {
		rows.push(`${failure.id}: ${failure.reason}`);
	}
	const total = report.pendingToolCalls.length + report.failures.length;
	if (total > rows.length) rows.push(`${total - rows.length} more restart recovery item(s) need attention.`);
	session.emitNotice(
		"warning",
		`Subagent restart recovery needs attention:\n${rows.map(row => `- ${row}`).join("\n")}`,
		"restart-recovery",
	);
}

/**
 * Persist the root-scoped subagent identity/status snapshot before restart
 * teardown. Task text is intentionally absent: the child session_init and
 * transcript already own it.
 */
export async function captureSubagentsForRestart(
	rootSession: AgentSession,
	options?: { runningAgentIds?: ReadonlySet<string>; requestId?: string },
): Promise<void> {
	const registry = AgentRegistry.global();
	const rootSessionFile = rootSession.sessionManager.getSessionFile();
	if (!rootSessionFile) {
		const descendants = rootSubagentRefs(rootSession, registry);
		if (descendants.length > 0)
			throw new Error("Cannot restart safely: this root session has subagents but no durable session file.");
		return;
	}
	const rootIdentityValue: RootSessionIdentity = {
		rootSessionId: rootSession.sessionManager.getSessionId(),
		rootSessionFile: path.resolve(rootSessionFile),
	};
	const candidates = rootSubagentRefs(rootSession, registry);
	const resumable: AgentRef[] = [];
	for (const ref of candidates) {
		// Parked children have a durable transcript and are restored lazily by
		// persisted-agents. They do not need a restart handoff slot.
		if (!ref.session || (ref.status !== "running" && ref.status !== "idle")) continue;
		if (!ref.sessionFile)
			throw new Error(`Cannot restart safely: root-owned subagent ${ref.id} has no durable session file.`);
		if (await isTombstoned(ref.sessionFile)) continue;
		resumable.push(ref);
	}
	const needsContinuation = (ref: AgentRef): boolean =>
		(options?.runningAgentIds?.has(ref.id) || ref.status === "running") && ref.lifecycle?.acceptedAt === undefined;
	resumable.sort((left, right) => {
		const continuationOrder = Number(needsContinuation(right)) - Number(needsContinuation(left));
		return continuationOrder || right.lastActivity - left.lastActivity || left.id.localeCompare(right.id);
	});
	const selected = resumable.slice(0, MAX_RESTART_SUBAGENTS);
	const omittedChildren = resumable.slice(MAX_RESTART_SUBAGENTS).map(ref => ({
		id: ref.id,
		reason: `restart handoff limit (${MAX_RESTART_SUBAGENTS}) reached; this live child was not revived`,
	}));
	const children: RestartChildSnapshot[] = [];
	for (const ref of selected) {
		if (!ref.sessionFile) continue;
		if (
			(ref.status === "running" || options?.runningAgentIds?.has(ref.id)) &&
			ref.lifecycle?.acceptedAt === undefined
		) {
			try {
				await validateRunningChild(ref);
			} catch (error) {
				const currentRef = registry.get(ref.id);
				if (!currentRef || currentRef !== ref || currentRef.status === "aborted") continue;
				if (currentRef.lifecycle?.acceptedAt === undefined && currentRef.status === "running") {
					throw new Error(
						`Cannot restart safely: subagent ${ref.id} ${error instanceof Error ? error.message : String(error)}.`,
					);
				}
			}
		}
		const currentRef = registry.get(ref.id);
		if (!currentRef || currentRef !== ref || currentRef.status === "aborted") continue;
		const originalRunStillUnaccepted =
			options?.runningAgentIds?.has(currentRef.id) && currentRef.lifecycle?.acceptedAt === undefined;
		const status: RestartChildStatus = originalRunStillUnaccepted
			? "running"
			: currentRef.status === "running" && currentRef.lifecycle?.acceptedAt !== undefined
				? "idle"
				: currentRef.status;
		if (status !== "running" && status !== "idle" && status !== "parked") continue;
		children.push({
			id: ref.id,
			sessionFile: path.resolve(ref.sessionFile),
			parentId: ref.parentId,
			displayName: ref.displayName,
			status,
			settled: currentRef.lifecycle?.acceptedAt !== undefined,
		});
	}
	if (children.length === 0 && omittedChildren.length === 0) return;
	await rootSession.sessionManager.ensureOnDisk();
	rootSession.sessionManager.appendCustomEntry(RESTART_HANDOFF_TYPE, {
		version: RESTART_HANDOFF_VERSION,
		...rootIdentityValue,
		capturedAt: Date.now(),
		...(options?.requestId ? { requestId: options.requestId } : {}),
		children,
		...(omittedChildren.length > 0 ? { omittedChildren } : {}),
	} satisfies RestartHandoff);
	await rootSession.sessionManager.flush();
}

/**
 * Restore the latest root-scoped handoff after the persisted reviver and
 * interactive runtime are ready. The transcript scanner restores identity in
 * parked form; this helper revives only captured-idle/unfinished-running rows.
 */
export async function restoreSubagentsAfterRestart(
	rootSession: AgentSession,
	options?: { requestId?: string },
): Promise<RestartRecoveryReport> {
	const report: RestartRecoveryReport = {
		resumed: [],
		restoredIdle: [],
		parked: [],
		pendingToolCalls: [],
		failures: [],
	};
	const rootSessionFile = rootSession.sessionManager.getSessionFile();
	if (!rootSessionFile) return report;
	const identity: RootSessionIdentity = {
		rootSessionId: rootSession.sessionManager.getSessionId(),
		rootSessionFile: path.resolve(rootSessionFile),
	};
	const rootEntries = rootSession.sessionManager.getBranch();
	const saved = latestHandoff(rootEntries, identity, options?.requestId);
	if (!saved) return report;
	const { handoff, entryId } = saved;
	for (const omitted of handoff.omittedChildren ?? []) report.failures.push(omitted);
	const registry = AgentRegistry.global();
	try {
		const scannedRoot = await ensurePersistedRoster(registry, identity.rootSessionFile);
		if (!scannedRoot || path.resolve(scannedRoot) !== identity.rootSessionFile) {
			throw new Error("persisted subagent transcript scan could not resolve this root session");
		}
	} catch (error) {
		report.failures.push({ id: "root", reason: error instanceof Error ? error.message : String(error) });
		emitReportNotice(rootSession, report);
		return report;
	}
	const receipts = receiptMap(rootSession.sessionManager.getBranch(), identity.rootSessionId, entryId);
	const rootRef = registry.list().find(ref => ref.kind === "main" && ref.session === rootSession);
	const childrenToRestore = handoff.children
		.filter(child => child.status !== "parked")
		.sort((left, right) => {
			const continuationOrder = Number(right.status === "running") - Number(left.status === "running");
			return continuationOrder || right.sessionFile.localeCompare(left.sessionFile);
		})
		.slice(0, MAX_RESTART_SUBAGENTS);
	for (const child of handoff.children) {
		if (child.status === "parked") continue;
		if (!childrenToRestore.includes(child)) {
			report.failures.push({
				id: child.id,
				reason: `restart handoff limit (${MAX_RESTART_SUBAGENTS}) reached; this live child was not revived`,
			});
		}
	}
	for (const child of childrenToRestore) {
		const priorReceipt = receipts.get(child.id);
		try {
			if (await isTombstoned(child.sessionFile)) {
				if (priorReceipt?.outcome !== "tombstoned")
					await recordReceipt(rootSession, identity, entryId, child, "tombstoned");
				continue;
			}
			const ref = registry.get(child.id);
			if (
				!ref ||
				ref.kind !== "sub" ||
				!ref.sessionFile ||
				path.resolve(ref.sessionFile) !== child.sessionFile ||
				!isAgentSessionFileInRootTree(ref.sessionFile, identity.rootSessionFile)
			) {
				report.failures.push({
					id: child.id,
					reason: "persisted child identity no longer matches the captured root/session file",
				});
				continue;
			}
			if (ref.status === "aborted") {
				if (priorReceipt?.outcome !== "tombstoned")
					await recordReceipt(rootSession, identity, entryId, child, "tombstoned");
				continue;
			}
			if (!registry.restoreIdentity(child.id, ref, { displayName: child.displayName, parentId: child.parentId })) {
				report.failures.push({ id: child.id, reason: "child identity changed during restart restoration" });
				continue;
			}
			if (priorReceipt?.outcome === "tombstoned") continue;
			let entries = await readBranchEntries(child.sessionFile, ref.session);
			const pending = collectPendingToolCalls(entries);
			if (pending.length > 0) {
				if (ref.session) throw new Error("cannot close interrupted calls while the child session is still live");
				await closeInterruptedToolCalls(child.sessionFile);
				entries = await readBranchEntries(child.sessionFile);
			}
			const effectivePriorReceipt = priorReceipt?.outcome === "pending-tool-calls" ? undefined : priorReceipt;
			if (effectivePriorReceipt) {
				if (effectivePriorReceipt.outcome === "continuation-claimed") {
					report.failures.push({
						id: child.id,
						reason:
							"continuation was durably claimed but has no delivery receipt; it was not retried to avoid a duplicate wake",
					});
				} else if (
					effectivePriorReceipt.outcome === "continuation-failed" ||
					effectivePriorReceipt.outcome === "revival-failed"
				) {
					report.failures.push({
						id: child.id,
						reason: effectivePriorReceipt.reason ?? "restart recovery failed",
					});
				} else if (
					effectivePriorReceipt.outcome === "continuation-delivered" ||
					effectivePriorReceipt.outcome === "idle-restored" ||
					effectivePriorReceipt.outcome === "settled-during-restart"
				) {
					try {
						const live = await AgentLifecycleManager.global().ensureLive(child.id);
						const current = registry.get(child.id);
						if (!current || current.session !== live) throw new Error("child session changed during restoration");
						if (current.status === "running") report.resumed.push(child.id);
						else if (current.status === "idle") report.restoredIdle.push(child.id);
						else if (current.status === "parked") report.parked.push(child.id);
					} catch (error) {
						report.failures.push({
							id: child.id,
							reason: error instanceof Error ? error.message : String(error),
						});
					}
				} else if (effectivePriorReceipt.outcome === "parked-preserved") {
					if (ref.status === "parked") report.parked.push(child.id);
					else if (ref.status === "running") report.resumed.push(child.id);
					else if (ref.status === "idle") report.restoredIdle.push(child.id);
				}
				continue;
			}
			const completedDuringRestart = child.status === "running" && latestTurnHasTerminalYield(entries);
			if (child.status === "parked" && pending.length === 0) {
				await recordReceipt(rootSession, identity, entryId, child, "parked-preserved");
				report.parked.push(child.id);
				continue;
			}
			const lifecycle = AgentLifecycleManager.global();
			try {
				await lifecycle.ensureLive(child.id);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				await recordReceipt(rootSession, identity, entryId, child, "revival-failed", { reason });
				report.failures.push({ id: child.id, reason });
				continue;
			}
			if ((child.status === "idle" || child.settled || completedDuringRestart) && pending.length === 0) {
				const outcome = completedDuringRestart || child.settled ? "settled-during-restart" : "idle-restored";
				await recordReceipt(rootSession, identity, entryId, child, outcome);
				report.restoredIdle.push(child.id);
				continue;
			}
			if (!rootRef) {
				const reason = "root session is not registered, so the continuation cannot be attributed safely";
				await recordReceipt(rootSession, identity, entryId, child, "revival-failed", { reason });
				report.failures.push({ id: child.id, reason });
				continue;
			}
			// Claim and flush before sending. A crash between claim and send is
			// surfaced as unresolved on the next restore; it is never blindly retried.
			await recordReceipt(rootSession, identity, entryId, child, "continuation-claimed");
			let receipt: IrcDeliveryReceipt;
			try {
				receipt = await IrcBus.global().send({
					from: rootRef.id,
					to: child.id,
					body: restartContinuationPrompt.trim(),
				});
			} catch (error) {
				const reason = `continuation send failed after its durable claim: ${error instanceof Error ? error.message : String(error)}`;
				report.failures.push({ id: child.id, reason });
				continue;
			}
			if (receipt.outcome === "failed") {
				const reason = receipt.error ?? "IRC continuation was not delivered";
				await recordReceipt(rootSession, identity, entryId, child, "continuation-failed", {
					deliveryOutcome: receipt.outcome,
					reason,
				});
				report.failures.push({ id: child.id, reason });
				continue;
			}
			try {
				await recordReceipt(rootSession, identity, entryId, child, "continuation-delivered", {
					deliveryOutcome: receipt.outcome,
				});
				report.resumed.push(child.id);
			} catch (error) {
				report.failures.push({
					id: child.id,
					reason: `continuation was delivered (${receipt.outcome}) but its receipt could not be persisted; it will not be retried: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		} catch (error) {
			report.failures.push({ id: child.id, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	emitReportNotice(rootSession, report);
	return report;
}
