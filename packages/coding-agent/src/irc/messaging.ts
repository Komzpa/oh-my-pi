import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import type { Settings } from "../config/settings";
import type { AgentRegistry } from "../registry/agent-registry";
import { IrcBus } from "./bus";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { canSpawnAtDepth } from "../task/types";

import { cfgTaskMaxRecursionDepth } from "../task/settings";

export interface AgentMessageDelivery {
	delivered: boolean;
	text: string;
}

interface AgentMessageSession {
	agentRegistry?: AgentRegistry;
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

export function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	return `[${msg.id}] ${msg.from}${replyTag}: ${msg.body}`;
}

/** Session-buffered inbox drain used before parking a bus waiter. */
export function drainPendingInbox(registry: AgentRegistry, senderId: string, from?: string): IrcMessage | undefined {
	const session = registry.get(senderId)?.session;
	return typeof session?.drainPendingIrcInboxMessages === "function"
		? session.drainPendingIrcInboxMessages(senderId, { from, limit: 1 })[0]
		: undefined;
}

/** `wait` result carrying a consumed message. */
export function messageResult(senderId: string, waited: IrcMessage): AgentToolResult<CoordinationDetails> {
	return {
		content: [{ type: "text", text: formatIncoming(waited) }],
		details: { op: "wait", from: senderId, waited },
	};
}

/** Send a direct message or broadcast; delivery never waits for a reply. */
export async function executeSend(
	deps: { registry: AgentRegistry; senderId: string; sessionFileHint?: string | null },
	params: { to: string; message: string },
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
	// Restore parked recipients only when needed; never delay delivery to a live peer.
	if (!isBroadcast && sessionFileHint) {
		const recipient = registry.get(to);
		if (!recipient || recipient.status === "parked") await ensurePersistedRoster(registry, sessionFileHint);
	}

	const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
	const suppressRelay = isBroadcast && targets.includes(MAIN_AGENT_ID);
	const bus = IrcBus.global();
	const receipts = await Promise.all(
		targets.map(target => bus.send({ from: senderId, to: target, body: message }, { suppressRelay })),
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

export async function sendAgentMessageFromSession(
	session: AgentMessageSession,
	to: string,
	message: string,
): Promise<AgentMessageDelivery> {
	const registry = session.agentRegistry;
	const senderId = session.getAgentId?.() ?? undefined;
	if (
		!registry ||
		!senderId ||
		session.enableIrc === false ||
		!isIrcEnabled(session.settings, session.taskDepth ?? 0)
	) {
		return { delivered: false, text: "Peer messaging is unavailable in this session." };
	}
	try {
		const result = await executeSend(
			{ registry, senderId, sessionFileHint: session.getSessionFile?.() },
			{ to, message },
		);
		const text = result.content.find(item => item.type === "text")?.text ?? "Message delivery failed.";
		return { delivered: result.isError !== true, text };
	} catch (error) {
		return { delivered: false, text: error instanceof Error ? error.message : String(error) };
	}
}
