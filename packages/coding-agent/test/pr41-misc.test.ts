/**
 * PR #41 misc fixes: the async-result template renders `{{this.result}}`, so
 * the mapped job objects handed to the renderer must carry each entry's result
 * text.
 */
import { describe, expect, it } from "bun:test";
import {
	buildAsyncResultBatchMessage,
	type AsyncResultEntry,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";

describe("pr41-misc: buildAsyncResultBatchMessage", () => {
	it("renders each job's result text into the batch message", () => {
		const entries: AsyncResultEntry[] = [
			{ jobId: "job-1", result: "RESULT-TEXT-7f3a", job: undefined, durationMs: 12, epoch: 0 },
			{ jobId: "job-2", result: "RESULT-TEXT-9c2b", job: undefined, durationMs: 34, epoch: 0 },
		];
		const message = buildAsyncResultBatchMessage(entries);
		expect(message).not.toBeNull();
		const content = typeof message?.content === "string" ? message.content : "";
		expect(content).toContain("RESULT-TEXT-7f3a");
		expect(content).toContain("RESULT-TEXT-9c2b");
	});
});
