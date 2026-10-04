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

	it("allows incremental yields before rejecting a terminal result after acceptance", async () => {
		const tool = new YieldTool(createSession());
		await tool.execute("call-section", { type: ["notes"], data: { note: "first" } } as never);
		await tool.execute("call-terminal", { data: { answer: 42 } } as never);
		await expect(
			tool.execute("call-later-section", { type: ["notes"], data: "later" } as never),
		).resolves.toBeDefined();
		await expect(tool.execute("call-later-terminal", { data: { answer: 0 } } as never)).rejects.toThrow("Stop now");
	});
});
