import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import type { Settings } from "../config/settings";
import { IrcBus } from "./bus";
import type { AgentRegistryApi } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { canSpawnAtDepth } from "../task/types";

import { cfgTaskMaxRecursionDepth } from "../task/settings";

export interface AgentMessageDelivery {
	delivered: boolean;
	text: string;
}

interface AgentMessageSession {
	agentRegistry?: AgentRegistryApi;
	enableIrc?: boolean;
	settings: Settings;
	taskDepth?: number;
	getAgentId?: () => string | null | undefined;
	getSessionFile?: () => string | null | undefined;
}

function coordinationErrorResult(text: string, details: CoordinationDetails): AgentToolResult<CoordinationDetails> {
	return { content: [{ type: "text", text }], details, isError: true };
}

/** Messaging is available to subagents and to top-level sessions able to spawn peers. */
export function isIrcEnabled(settings: Settings, taskDepth: number): boolean {
	if (taskDepth > 0) return true;
	const maxDepth = cfgTaskMaxRecursionDepth.get(settings);
	return canSpawnAtDepth(maxDepth, taskDepth);
}

/** Send a direct message or, from a top-level agent only, a broadcast; delivery never waits for a reply. */
export async function executeSend(
	deps: { registry: AgentRegistryApi; senderId: string; sessionFileHint?: string | null },
	params: { to: string; message: string; progress?: boolean },
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, sessionFileHint } = deps;
	const to = params.to.trim();
	const message = params.message;
	if (!to) return coordinationErrorResult("A recipient is required.", { op: "send", from: senderId });
	if (!message.trim())
		return coordinationErrorResult("A non-empty message is required.", { op: "send", from: senderId });
	if (to === senderId)
		return coordinationErrorResult("Cannot send a message to yourself.", { op: "send", from: senderId, to });
	const isBroadcast = to === "all";
	// A subagent's broadcast wakes every live peer for news that is almost never
	// theirs; it messages the one agent that can answer instead.
	if (isBroadcast && registry.get(senderId)?.kind !== "main")
		return coordinationErrorResult(
			"Only the main agent can broadcast. Message the one agent that can answer via `agent://<id>`.",
			{ op: "send", from: senderId, to },
		);
	// Restore parked recipients only when needed; never delay delivery to a live peer.
	if (!isBroadcast && sessionFileHint) {
		const recipient = registry.get(to);
		if (!recipient || recipient.status === "parked") await ensurePersistedRoster(registry, sessionFileHint, to);
	}

	const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
	const bus = IrcBus.global();
	const receipts = await Promise.all(
		targets.map(target =>
			bus.send({
				from: senderId,
				to: target,
				body: message,
				...(isBroadcast ? { broadcast: true } : {}),
				...(params.progress ? { progress: true } : {}),
			}),
		),
	);
	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	let text: string;
	if (isBroadcast) {
		text =
			targets.length === 0
				? "No live peers to broadcast to."
				: `Broadcast delivered to ${delivered.length} of ${targets.length} peer(s).`;
		if (receipts.length) {
			text += `\n${receipts
				.map(receipt =>
					receipt.outcome === "failed"
						? `- ${receipt.to}: failed — ${receipt.error ?? "not running"}`
						: `- ${receipt.to}: ${receipt.outcome}`,
				)
				.join("\n")}`;
		}
	} else {
		const receipt = receipts[0]!;
		const recipient = registry.get(to);
		const unavailable = !recipient || recipient.status === "aborted" || !recipient.session;
		text =
			receipt.outcome === "failed"
				? `Failed: ${to} ${unavailable ? "is not running" : "could not receive the message"}. ${receipt.error ?? ""}`.trimEnd()
				: to.startsWith("shell:")
					? `Delivered to ${to} (shell inbox).`
					: to.startsWith("peer:")
						? `Delivered to ${to} (peer session).`
						: receipt.outcome === "revived"
							? `Queued for ${to} (was parked; revived).`
							: `Delivered to ${to}.`;
	}
	return {
		content: [{ type: "text", text }],
		details: { op: "send", from: senderId, to, receipts },
		isError: delivered.length === 0 && targets.length > 0,
	};
}

/**
 * Shared availability predicate for peer messaging. The extension
 * `ctx.sendAgentMessage` API and `write agent://` evaluate this same path so
 * the two channels cannot disagree about whether messaging works in a
 * session. Returns the user-facing reason when unavailable, `undefined` when
 * delivery may proceed.
 */
export function agentMessagingUnavailableReason(session: AgentMessageSession): string | undefined {
	const registry = session.agentRegistry;
	const senderId = session.getAgentId?.() ?? undefined;
	if (
		!registry ||
		!senderId ||
		session.enableIrc === false ||
		!isIrcEnabled(session.settings, session.taskDepth ?? 0)
	) {
		return "Peer messaging is unavailable in this session.";
	}
	return undefined;
}
export async function sendAgentMessageFromSession(
	session: AgentMessageSession,
	to: string,
	message: string,
): Promise<AgentMessageDelivery> {
	const registry = session.agentRegistry;
	const senderId = session.getAgentId?.() ?? undefined;
	const unavailable = agentMessagingUnavailableReason(session);
	if (unavailable !== undefined) return { delivered: false, text: unavailable };
	try {
		const result = await executeSend(
			// `agentMessagingUnavailableReason` above guarantees both are present.
			{ registry: registry!, senderId: senderId!, sessionFileHint: session.getSessionFile?.() },
			{ to, message },
		);
		const text = result.content.find(item => item.type === "text")?.text ?? "Message delivery failed.";
		return { delivered: result.isError !== true, text };
	} catch (error) {
		return { delivered: false, text: error instanceof Error ? error.message : String(error) };
	}
}
