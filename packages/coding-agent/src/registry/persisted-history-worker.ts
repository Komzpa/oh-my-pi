import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { readPersistedAgentHistory, type PersistedTranscript } from "./persisted-agents";
import type { HistoryWorkerReply } from "./persisted-history-client";

if (!parentPort) throw new Error("History worker requires a parent port");
const send = (reply: HistoryWorkerReply): void => {
	parentPort!.postMessage(reply);
};
async function load(transcripts: PersistedTranscript[]): Promise<void> {
	try {
		for (const transcript of transcripts) {
			const history = await readPersistedAgentHistory(transcript, () => true);
			send({ type: "history", transcript, history });
		}
		send({ type: "done" });
	} catch (error) {
		send({ type: "error", error: String(error) });
	}
}
const handle = (message: unknown): void => {
	void load(message as PersistedTranscript[]);
};
const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else parentPort.on("message", handle);
