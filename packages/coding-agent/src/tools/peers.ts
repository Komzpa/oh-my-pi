import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import peersDescription from "../prompts/tools/peers.md" with { type: "text" };
import { type PeerDeliveryReceipt, PeerSessionError, listPeerSessions, sendPeerMessage } from "../collab/registry";
import type { ToolSession } from ".";

const peersSchema = type({
	action: "'list' | 'send'",
	"target?": type("string").describe("target session id, unique id prefix, cwd fragment, or title fragment"),
	"message?": type("string").describe("message text for send"),
	"agent?": type("string").describe("optional agent id inside the target process"),
});

export type PeersParams = typeof peersSchema.infer;

export interface PeersToolDetails {
	action: "list" | "send";
	receipt?: PeerDeliveryReceipt;
}

export class PeersTool implements AgentTool<typeof peersSchema, PeersToolDetails> {
	readonly name = "peers";
	readonly label = "Peers";
	readonly summary = "List and message local OMP peer sessions";
	readonly description = prompt.render(peersDescription);
	readonly parameters = peersSchema;
	readonly strict = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: PeersParams): Promise<AgentToolResult<PeersToolDetails>> {
		if (params.action === "list") {
			const sessions = await listPeerSessions();
			const lines =
				sessions.length === 0
					? ["No active peer sessions."]
					: sessions.map(
							peer =>
								`${peer.instanceId} ${peer.sessionName ?? peer.sessionId} ${peer.cwd} main=${peer.mainAgentId} agents=${peer.agents.map(agent => agent.id).join(",")}`,
						);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { action: "list" } };
		}
		const target = params.target?.trim();
		const message = params.message ?? "";
		if (!target || !message.trim()) {
			return {
				content: [{ type: "text", text: "target and message are required for peers send" }],
				details: { action: "send" },
				isError: true,
			};
		}
		try {
			const receipt = await sendPeerMessage({
				from: {
					kind: "session",
					sessionId: this.session.getSessionId?.() ?? this.session.getAgentId?.() ?? "unknown",
					cwd: this.session.cwd,
				},
				target,
				text: message,
				...(params.agent ? { agent: params.agent } : {}),
			});
			const ok = receipt.status !== "failed";
			return {
				content: [
					{
						type: "text",
						text: ok
							? `${receipt.status} to ${receipt.target} ${receipt.agent}${receipt.outcome ? ` (${receipt.outcome})` : ""}`
							: `failed: ${receipt.reason ?? "delivery failed"}`,
					},
				],
				details: { action: "send", receipt },
				isError: !ok,
			};
		} catch (error) {
			if (!(error instanceof PeerSessionError)) throw error;
			return {
				content: [{ type: "text", text: error.message }],
				details: {
					action: "send",
					receipt: { status: "failed", target, agent: params.agent ?? "", reason: error.code },
				},
				isError: true,
			};
		}
	}
}
