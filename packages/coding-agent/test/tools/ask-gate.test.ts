import { describe, expect, it, spyOn, vi } from "bun:test";
import { type as arkType } from "@oh-my-pi/omptype";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import { buildAsyncResultBatchMessage } from "../../src/session/async-job-delivery";
import type { AsyncJob } from "../../src/async";
import { AskTool } from "../../src/tools/ask";
import type { ToolSession } from "../../src/tools";

const html =
	'<form><fieldset><legend>Layout?</legend><label><input type="radio" name="layout" value="compact" checked>Compact</label><label><input type="radio" name="layout" value="wide">Wide</label></fieldset></form>';
const withoutDefault = html.replace(" checked", "");

function setup(enabled = true, recentSeconds = 0) {
	const settings = Settings.isolated({ ask: { gate: { enabled, agent: "shadow-profile", recentSeconds } } });
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({ role: "user", content: "Build it", timestamp: Date.now() });
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		settings,
		sessionManager,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
	return { tool: new AskTool(session), sessionManager, session };
}

function complete(manager: SessionManager, agent = "shadow-profile", exitCode = 0) {
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "shadow-call",
		toolName: "task",
		content: [{ type: "text", text: "Pick compact" }],
		details: { results: [{ agent, exitCode }] },
		isError: false,
		timestamp: Date.now(),
	});
}

describe("ask lead gate", () => {
	it("refuses a batch if any recommendation is missing or invalid", async () => {
		const { tool, sessionManager } = setup();
		complete(sessionManager);
		await expect(tool.execute("ask", { html: withoutDefault })).rejects.toThrow("Ask refused");
	});

	it("refuses absent, failed, wrong-profile, and pre-user results with no recent window", async () => {
		const { tool, sessionManager } = setup();
		await expect(tool.execute("ask", { html })).rejects.toThrow("shadow");
		complete(sessionManager, "another-profile");
		complete(sessionManager, "shadow-profile", 1);
		await expect(tool.execute("ask", { html })).rejects.toThrow("Ask refused");
		complete(sessionManager);
		sessionManager.appendMessage({ role: "user", content: "Change it", timestamp: Date.now() });
		await expect(tool.execute("ask", { html })).rejects.toThrow("Ask refused");
	});

	it("returns pending working defaults immediately after a successful shadow result", async () => {
		const { tool, sessionManager, session } = setup();
		complete(sessionManager);
		session.submitUserReply = vi.fn();
		const askDialog = vi.fn();
		const context = { hasUI: true, ui: { askDialog } } as unknown as AgentToolContext;
		const result = await tool.execute("ask", { html }, undefined, undefined, context);
		expect(askDialog).not.toHaveBeenCalled();
		expect(session.submitUserReply).not.toHaveBeenCalled();
		expect(result.details?.pending?.id).toBe("ask");
		expect(result.details?.workingDefaults).toEqual([{ id: "layout", option: "Compact" }]);
		expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("working defaults") })]);
	});

	it("accepts a pre-user completed result within the configured recent window", async () => {
		const { tool, sessionManager } = setup(true, 300);
		complete(sessionManager);
		sessionManager.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
		expect((await tool.execute("ask", { html })).details?.workingDefaults).toHaveLength(1);
	});

	it("refuses an expired pre-user result", async () => {
		const { tool, sessionManager } = setup(true, 1);
		complete(sessionManager);
		sessionManager.appendMessage({ role: "user", content: "New choice", timestamp: Date.now() });
		const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		try {
			await expect(tool.execute("ask", { html })).rejects.toThrow("Ask refused");
		} finally {
			clock.mockRestore();
		}
	});

	it("rejects blank or unknown critical reasons at the tool boundary", () => {
		const { tool } = setup();
		for (const critical of [
			{ kind: "public", reason: " " },
			{ kind: "taste", reason: "Prefer blue" },
		]) {
			expect(tool.parameters({ html, critical })).toBeInstanceOf(arkType.errors);
		}
	});

	it("records critical stops while bypassing recommendations and shadow admission", async () => {
		const { tool } = setup();
		const critical = { kind: "public" as const, reason: "Publish the release" };
		const result = await tool.execute("ask", { html: withoutDefault, critical });
		expect(result.details?.critical).toEqual(critical);
		expect(result.details?.pending?.id).toBe("ask");
		expect(result.details?.workingDefaults).toBeUndefined();
	});

	it("leaves ordinary pending behavior unchanged when disabled", async () => {
		const { tool } = setup(false);
		const result = await tool.execute("ask", { html: withoutDefault });
		expect(result.details?.pending?.id).toBe("ask");
		expect(result.details?.workingDefaults).toBeUndefined();
	});

	it("retains async completion profile evidence in the session after delivery", async () => {
		const { tool, sessionManager } = setup();
		const job = {
			type: "task",
			status: "completed",
			latestDetails: { progress: [{ id: "worker", agent: "shadow-profile", status: "completed" }] },
			id: "worker",
			startTime: Date.now(),
			label: "Shadow",
			abortController: new AbortController(),
			promise: Promise.resolve(),
		} satisfies AsyncJob;
		const message = buildAsyncResultBatchMessage([
			{ jobId: "worker", result: "Compact", job, durationMs: 1, epoch: 0 },
		]);
		if (!message) throw new Error("Expected delivery");
		sessionManager.appendMessage(message);
		expect((await tool.execute("ask", { html })).details?.workingDefaults).toHaveLength(1);
	});
});
