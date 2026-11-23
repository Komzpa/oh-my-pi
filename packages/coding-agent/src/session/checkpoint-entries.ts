import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { stringProperty } from "@oh-my-pi/pi-utils";
import type { CheckpointState, CompletedRewindState } from "../tools/checkpoint";
import { toolCommandDispatches } from "../tools/tool-commands";
import { REWIND_REPORT_MESSAGE_TYPE } from "./messages";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Extracts text from custom message content. */
export function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

/** Extracts the report body from persisted rewind-report content. */
export function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

/** Checkpoint-domain tool names normalized from direct calls and `bash` tool commands. */
export type SemanticCheckpointToolName = "checkpoint" | "rewind";

/** Normalized checkpoint-domain tool result. */
export interface SemanticToolResult {
	toolName: SemanticCheckpointToolName;
	details?: unknown;
}

/**
 * Normalizes successful checkpoint and rewind results: a direct call's own
 * non-error result, or the last `checkpoint`/`rewind` tool command a `bash` run
 * executed with exit status 0, with that command's details, whatever the
 * outer `bash` status. Session state changes only when the result is
 * committed, so within one run every successful command saw the same state
 * and the last one stands for the run. Undefined for anything else.
 */
export function semanticToolResult(toolName: string | undefined, result: unknown): SemanticToolResult | undefined {
	if (toolName === "checkpoint" || toolName === "rewind") {
		if (!result || typeof result !== "object") return undefined;
		if ("isError" in result && result.isError === true) return undefined;
		return { toolName, details: "details" in result ? result.details : undefined };
	}
	if (toolName === undefined) return undefined;
	for (const dispatch of toolCommandDispatches(toolName, result).toReversed()) {
		if (dispatch.mode !== "execute" || dispatch.exitCode !== 0) continue;
		if (dispatch.tool === "checkpoint" || dispatch.tool === "rewind") {
			return { toolName: dispatch.tool, details: dispatch.inner };
		}
	}
	return undefined;
}

/** Restores completed rewind state from a persisted session entry. */
export function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== REWIND_REPORT_MESSAGE_TYPE) return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	const rewoundAt = stringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		stringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}

/** Whether an entry is a successful checkpoint tool result. */
export function isSuccessfulCheckpointEntry(
	entry: SessionEntry,
): entry is SessionEntry & { type: "message"; message: Extract<AgentMessage, { role: "toolResult" }> } {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
	return semanticToolResult(entry.message.toolName, entry.message)?.toolName === "checkpoint";
}

/** Returns the checkpoint start timestamp represented by an entry. */
export function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = semanticToolResult(entry.message.toolName, entry.message)?.details;
	if (details && typeof details === "object") {
		const startedAt = stringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
}

/** Payload-free selection fact shared by append and journal indexing. */
export function checkpointEntryKind(entry: SessionEntry): "pending" | "completed" | undefined {
	if (isSuccessfulCheckpointEntry(entry)) return "pending";
	if (completedRewindFromEntry(entry)) return "completed";
	return undefined;
}

/** Restore only the last checkpoint transition; older payloads cannot change it. */
export function readCheckpointRewindState(manager: SessionManager): {
	checkpoint?: CheckpointState;
	completed?: CompletedRewindState;
} {
	const entry = manager.getLatestBranchMatching(metadata => metadata.checkpointKind !== undefined);
	if (!entry) return {};
	if (!isSuccessfulCheckpointEntry(entry)) return { completed: completedRewindFromEntry(entry) };
	let messageCount = 0;
	let reached = false;
	manager.getBranchMatching(metadata => {
		if (!reached && metadata.type === "message") messageCount++;
		if (metadata.id === entry.id) reached = true;
		return false;
	});
	return {
		checkpoint: {
			checkpointEntryId: entry.id,
			startedAt: checkpointStartedAtFromEntry(entry) ?? entry.timestamp,
			checkpointMessageCount: messageCount,
		},
	};
}
