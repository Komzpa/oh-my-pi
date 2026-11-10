import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";

export interface WorkerQuestion {
	id: string;
	questionId: string;
	question: string;
	proposedDefault?: string;
	critical?: boolean;
	at: number;
}

export function answersWorkerQuestion(text: string, question: WorkerQuestion): boolean {
	const prefix = `Answer to ${question.id} [${question.questionId}]:`;
	const index = text.indexOf(prefix);
	return index >= 0 && text.slice(index + prefix.length).trim().length > 0;
}

/** All unresolved asks, including asks before compaction's recent-message window. */
export function pendingWorkerAsks(messages: readonly AgentMessage[] = []): WorkerQuestion[] {
	const pending = new Map<string, WorkerQuestion>();
	const writes = new Map<string, string>();
	const answer = (text: string) => {
		for (const [key, q] of pending) if (answersWorkerQuestion(text, q)) pending.delete(key);
	};
	const parentReply = (text: string) => {
		answer(text);
		for (const [key, q] of pending) if (q.questionId === "reply") pending.delete(key);
	};
	for (const message of messages) {
		if (message.role === "assistant")
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== "write") continue;
				const args = part.arguments;
				if (
					typeof args.path === "string" &&
					["agent://main", "agent://lead", "agent://parent"].includes(args.path) &&
					typeof args.content === "string" &&
					args.content.trim()
				)
					writes.set(part.id, args.content);
			}
		if (message.role === "toolResult" && message.toolName === "write" && !message.isError) {
			const sent = writes.get(message.toolCallId);
			if (sent)
				pending.set(`${message.toolCallId}:reply`, {
					id: message.toolCallId,
					questionId: "reply",
					question: sent,
					at: message.timestamp,
					proposedDefault: /I will do (.+?) unless told otherwise/i.exec(sent)?.[1],
				});
		}
		if (
			message.role === "custom" &&
			message.customType === "irc:incoming" &&
			isRecord(message.details) &&
			["main", "lead", "parent"].includes(String(message.details.from)) &&
			!message.details.progress &&
			typeof message.details.message === "string" &&
			message.details.message.trim()
		) {
			parentReply(message.details.message);
		}
		if (message.role === "toolResult" && message.toolName === "ask" && !message.isError) {
			const details = message.details;
			if (!isRecord(details) || details.workingDefaults || !isRecord(details.pending)) continue;
			const ask = details.pending;
			if (typeof ask.id !== "string" || !Array.isArray(ask.questions)) continue;
			for (const q of ask.questions) {
				if (!isRecord(q) || typeof q.id !== "string" || typeof q.question !== "string") continue;
				const option =
					Array.isArray(q.options) && typeof q.recommended === "number" ? q.options[q.recommended] : undefined;
				pending.set(`${ask.id}:${q.id}`, {
					id: ask.id,
					questionId: q.id,
					question: q.question,
					at: message.timestamp,
					critical: Boolean(details.critical),
					proposedDefault: isRecord(option) && typeof option.label === "string" ? option.label : undefined,
				});
			}
		}
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(p => p.type === "text")
							.map(p => p.text)
							.join("\n");
			answer(text);
			// Parent IRC delivered mid-turn is persisted as a user steer when consumed.
			if (message.parentIrc?.body.trim()) parentReply(message.parentIrc.body);
		}
	}
	return [...pending.values()];
}

export function workerAskDefaultWaitMs(value = Bun.env.OMP_WORKER_ASK_DEFAULT_WAIT_MS): number {
	const ms = value === undefined ? 600_000 : Number(value);
	if (!Number.isFinite(ms) || ms <= 0) throw new Error("OMP_WORKER_ASK_DEFAULT_WAIT_MS must be positive");
	return ms;
}
