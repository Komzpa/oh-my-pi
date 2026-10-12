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
		expect(first.content).toEqual([{ type: "text", text: "Result submitted." }]);
		expect(first.details).toMatchObject({ status: "success", data: { answer: 42 } });

		await expect(tool.execute("call-second", { data: { answer: 0 } } as never)).rejects.toThrow(
			"result was already submitted",
		);
		await expect(tool.execute("call-third", { error: "retract" } as never)).rejects.toThrow("Stop now");
		expect(first.details?.data).toEqual({ answer: 42 });

		resetYieldTurnState(tool);
		await expect(tool.execute("call-fourth", { data: { answer: 1 } } as never)).rejects.toThrow(
			"result was already submitted",
		);
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
