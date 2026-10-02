import { formatAge } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	COLLAB_REGISTRY_VERSION,
	type PeerDeliveryReceipt,
	type PeerMessageSender,
	type PeerSessionOptions,
	type PeerSessionSnapshot,
	PeerSessionError,
	listPeerSessions,
	sendPeerMessage,
} from "../collab/registry";

export interface PeerListCommandArgs {
	json: boolean;
	registry?: PeerSessionOptions;
}

export interface PeerSendCommandArgs {
	target: string;
	text: string;
	agent?: string;
	from?: PeerMessageSender;
	json: boolean;
	registry?: PeerSessionOptions;
}

export interface PeerListJsonOutput {
	version: number;
	sessions: PeerSessionSnapshot[];
}

export interface PeerSendJsonOutput extends PeerDeliveryReceipt {
	version: number;
}

function clean(text: string): string {
	return sanitizeDisplayLine(text);
}

export async function runPeerListCommand(
	args: PeerListCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const sessions = await listPeerSessions(args.registry);
	if (args.json) {
		const output: PeerListJsonOutput = { version: COLLAB_REGISTRY_VERSION, sessions };
		print(JSON.stringify(output, null, 2));
		return;
	}
	if (sessions.length === 0) {
		print(chalk.dim("No active peer sessions."));
		return;
	}
	print(chalk.green(`${sessions.length} active peer ${sessions.length === 1 ? "session" : "sessions"}`));
	for (const session of sessions) {
		const title = session.sessionName ? clean(session.sessionName) : clean(session.sessionId);
		const cwd = clean(shortenPath(session.cwd));
		const details = [
			`pid ${session.pid}`,
			`main ${clean(session.mainAgentId)}`,
			`started ${formatAge(Math.round((Date.now() - session.startedAt) / 1000)) || "just now"}`,
			session.busy === null ? "busy unknown" : session.busy ? "working" : "idle",
			`${session.agents.length} ${session.agents.length === 1 ? "agent" : "agents"}`,
		];
		print("");
		print(`${session.instanceId}  ${title}  ${chalk.dim(cwd)}`);
		print(`  ${chalk.dim(details.join(" | "))}`);
	}
	print(chalk.dim("Send: omp peers send <id|prefix|cwd|title> <text|@file> [--agent <id>]"));
}

export async function runPeerSendCommand(
	args: PeerSendCommandArgs,
	print: (line: string) => void = line => console.log(line),
	printErr: (line: string) => void = line => console.error(line),
): Promise<number> {
	let receipt: PeerDeliveryReceipt;
	try {
		receipt = await sendPeerMessage({
			registry: args.registry,
			from: args.from ?? { kind: "shell" },
			target: args.target,
			text: args.text,
			...(args.agent ? { agent: args.agent } : {}),
		});
	} catch (error) {
		if (!(error instanceof PeerSessionError)) throw error;
		const failed: PeerDeliveryReceipt = {
			status: "failed",
			target: args.target,
			agent: args.agent ?? "",
			reason: error.code,
		};
		if (args.json) {
			const output: PeerSendJsonOutput = { version: COLLAB_REGISTRY_VERSION, ...failed };
			print(JSON.stringify(output, null, 2));
		} else {
			printErr(`error: ${error.message}`);
		}
		return 1;
	}
	if (args.json) {
		const output: PeerSendJsonOutput = { version: COLLAB_REGISTRY_VERSION, ...receipt };
		print(JSON.stringify(output, null, 2));
	} else if (receipt.status === "failed") {
		printErr(`failed: ${receipt.reason ?? "delivery failed"}`);
		return 1;
	} else {
		print(`${receipt.status}: ${receipt.target} ${receipt.agent}${receipt.outcome ? ` (${receipt.outcome})` : ""}`);
	}
	return 0;
}
