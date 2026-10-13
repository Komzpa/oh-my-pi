import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetYieldTurnState, YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("YieldTool terminal result latch", () => {
	it("keeps the first accepted terminal result and rejects later terminal yields (642/665)", async () => {
		const tool = new YieldTool(createSession());
		const first = await tool.execute("call-first", { data: { answer: 42 } } as never);
		expect(first.details).toMatchObject({ status: "success", data: { answer: 42 } });

		await expect(tool.execute("call-second", { data: { answer: 0 } } as never)).rejects.toThrow(
			"result was already submitted",
		);
		await expect(tool.execute("call-third", { error: "retract" } as never)).rejects.toThrow("Stop now");
		expect(first.details?.data).toEqual({ answer: 42 });

		// A new monitored run (follow-up turn, IRC wake) re-arms the latch: its
		// first terminal result is accepted, then it is one-shot again.
		resetYieldTurnState(tool);
		const nextRun = await tool.execute("call-next-run", { data: { answer: 1 } } as never);
		expect(nextRun.details).toMatchObject({ status: "success", data: { answer: 1 } });
		await expect(tool.execute("call-next-run-later", { data: { answer: 2 } } as never)).rejects.toThrow(
			"result was already submitted",
		);
	});

	it("accepts only one of two concurrent sibling terminal yields", async () => {
		const tool = new YieldTool(createSession());
		const results = await Promise.allSettled([
			tool.execute("call-a", { data: { answer: "a" } } as never),
			tool.execute("call-b", { data: { answer: "b" } } as never),
		]);
		expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
	});

	it("rejects empty data for any terminal type and accepts schema-valid empty values", async () => {
		const typed = new YieldTool(createSession());
		await expect(typed.execute("call-summary-empty", { type: "summary", data: "" } as never)).rejects.toThrow(
			/result needs data/,
		);
		const ok = await typed.execute("call-summary", { type: "summary", data: "done" } as never);
		expect(ok.details).toMatchObject({ status: "success", data: "done" });

		const schemaTool = new YieldTool(createSession({ outputSchema: { type: "array", items: { type: "string" } } }));
		const empty = await schemaTool.execute("call-empty-array", { type: "result", data: [] } as never);
		expect(empty.details).toMatchObject({ status: "success", data: [] });
	});

	it("awaits the claim when aborting after repeated stray-key yields", async () => {
		const tool = new YieldTool(createSession());
		for (let i = 0; i < 3; i++) {
			await expect(tool.execute(`call-stray-${i}`, { type: "summary", result: "answer" } as never)).rejects.toThrow(
				/no `data`/,
			);
		}
		const aborted = await tool.execute("call-stray-abort", { type: "summary", result: "answer" } as never);
		expect(aborted.details).toMatchObject({ status: "aborted" });
		await expect(tool.execute("call-after-abort", { data: { answer: 1 } } as never)).rejects.toThrow("Stop now");
	});

	it("refuses a terminal yield while any owner job runs, then rolls the latch back", async () => {
		const job = { id: "job-1", type: "eval", status: "running", startTime: Date.now(), label: "\x1b[31mcell\x1b[0m" };
		const tool = new YieldTool(
			createSession({
				requireYieldTool: true,
				getAgentId: () => "worker",
				asyncJobManager: { getRunningOwnerJobs: () => [job] } as never,
			}),
		);
		const refusal = await tool.execute("call-refused", { data: { answer: 1 } } as never).catch(error => error);
		expect(refusal).toBeInstanceOf(Error);
		expect(String(refusal.message)).toContain("job-1");
		expect(String(refusal.message)).not.toContain("\x1b");
		const accepted = await tool.execute("call-repeat", { data: { answer: 1 } } as never);
		expect(accepted.details).toMatchObject({ status: "success" });
		expect((accepted.details as { abandonedJobs?: Array<{ type: string }> }).abandonedJobs?.[0]?.type).toBe("eval");
	});

	it("allows incremental yields only before terminal acceptance", async () => {
		const tool = new YieldTool(createSession());
		await tool.execute("call-section", { type: ["notes"], data: { note: "first" } } as never);
		await tool.execute("call-terminal", { data: { answer: 42 } } as never);
		await expect(tool.execute("call-later-section", { type: ["notes"], data: "later" } as never)).rejects.toThrow(
			"Stop now",
		);
		await expect(tool.execute("call-later-terminal", { data: { answer: 0 } } as never)).rejects.toThrow("Stop now");
	});

	it("rejects an empty terminal result as a retryable error without completing (#108)", async () => {
		// Missing data: the first yield bounces in-band and latches nothing, so a
		// resubmission with the payload completes.
		const tool = new YieldTool(createSession());
		await expect(tool.execute("call-empty-result", { type: "result" } as never)).rejects.toThrow(/result needs data/);
		const done = await tool.execute("call-real-result", {
			type: "result",
			data: { verdict: "clean" },
		} as never);
		expect(done.details).toMatchObject({ status: "success", data: { verdict: "clean" } });

		// Explicitly empty payloads bounce the same way, then a real one completes.
		const blank = new YieldTool(createSession());
		await expect(blank.execute("call-blank", { type: "result", data: "" } as never)).rejects.toThrow(
			/result needs data/,
		);
		await expect(blank.execute("call-empty-object", { type: "result", data: {} } as never)).rejects.toThrow(
			/result needs data/,
		);
		await expect(blank.execute("call-empty-array", { type: "result", data: [] } as never)).rejects.toThrow(
			/result needs data/,
		);
		const filled = await blank.execute("call-filled", {
			type: "result",
			data: { verdict: "clean" },
		} as never);
		expect(filled.details).toMatchObject({ status: "success", data: { verdict: "clean" } });

		// Negative control: an error yield without data still completes as an error.
		const failing = new YieldTool(createSession());
		const failed = await failing.execute("call-error", { type: "error", error: "x" } as never);
		expect(failed.details).toMatchObject({ status: "aborted", error: "x" });
	});
});
