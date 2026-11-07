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

/** All unresolved asks, including asks before compaction's recent-message window. */
export function pendingWorkerAsks(messages: readonly AgentMessage[] = []): WorkerQuestion[] {
	const pending = new Map<string, WorkerQuestion>();
	for (const message of messages) {
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
			for (const [key, q] of pending) if (text.includes(`Answer to ${q.id} [${q.questionId}]:`)) pending.delete(key);
		}
	}
	return [...pending.values()];
}

export function workerAskDefaultWaitMs(value = Bun.env.OMP_WORKER_ASK_DEFAULT_WAIT_MS): number {
	const ms = value === undefined ? 600_000 : Number(value);
	if (!Number.isFinite(ms) || ms <= 0) throw new Error("OMP_WORKER_ASK_DEFAULT_WAIT_MS must be positive");
	return ms;
}
