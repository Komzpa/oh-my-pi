import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { PERSISTED_HISTORY_WORKER_ARG } from "../cli/worker-selectors";
import type { AgentHistorySummary } from "./agent-registry";
import type { PersistedTranscript } from "./persisted-agents";

export type HistoryWorkerReply =
	| { type: "history"; transcript: PersistedTranscript; history: AgentHistorySummary }
	| { type: "done" }
	| { type: "error"; error: string };

/** Parse historical transcripts on a separate event loop, returning only small summaries. */
export async function hydrateHistoryOffThread(
	transcripts: PersistedTranscript[],
	shouldContinue: () => boolean,
	accept: (transcript: PersistedTranscript, history: AgentHistorySummary) => void,
): Promise<void> {
	if (!transcripts.length || !shouldContinue()) return;
	const host = workerHostEntry();
	const worker = host
		? new Worker(host, { type: "module", argv: [PERSISTED_HISTORY_WORKER_ARG] })
		: new Worker(new URL("./persisted-history-worker.ts", import.meta.url).href, { type: "module" });
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	worker.onmessage = (event: MessageEvent<HistoryWorkerReply>) => {
		if (!shouldContinue()) {
			resolve();
			return;
		}
		const reply = event.data;
		if (reply.type === "done") resolve();
		else if (reply.type === "error") reject(new Error(reply.error));
		else {
			try {
				accept(reply.transcript, reply.history);
			} catch (error) {
				reject(error);
			}
		}
	};
	worker.onerror = event => reject(new Error(event.message));
	worker.addEventListener("close", () => reject(new Error("History worker closed before completion")));
	const cancellation = setInterval(() => {
		if (!shouldContinue()) resolve();
	}, 50);
	try {
		worker.postMessage(transcripts);
		await promise;
	} finally {
		clearInterval(cancellation);
		worker.terminate();
	}
}
