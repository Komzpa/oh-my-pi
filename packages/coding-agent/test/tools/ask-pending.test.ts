import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { AskTool } from "../../src/tools/ask";
import { askToolRenderer } from "@oh-my-pi/pi-tui/tools/ask";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

function session(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: os.tmpdir(), hasUI: true, getSessionFile: () => null, getSessionSpawns: () => "*",
		getSessionId: () => "asking-session",
		settings: Settings.isolated({ "ask.timeout": 0.001, "ask.notify": "off", "speech.enabled": false }),
		...overrides,
	};
}

const questions = [{ id: "choice", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }], recommended: 0 }];

describe("pending Ask", () => {
	beforeAll(async () => { await initTheme(false); });

	it("returns a pending identity without opening modal UI or producing consent", async () => {
		const unresolved = Promise.withResolvers<undefined>();
		const select = vi.fn(() => unresolved.promise);
		const askDialog = vi.fn(() => unresolved.promise);
		const confirm = vi.fn(() => unresolved.promise);
		const abort = vi.fn();
		const context = { hasUI: true, ui: { select, askDialog, confirm }, abort } as unknown as AgentToolContext;
		const tool = new AskTool(session());
		const result = await tool.execute("ask-1", { questions }, undefined, undefined, context);
		expect(result.details?.pending).toEqual({ id: "ask-1", sessionId: "asking-session", questions });
		expect(result.details?.selectedOptions).toBeUndefined();
		expect(result.details?.timedOut).toBeUndefined();
		expect(select).not.toHaveBeenCalled();
		expect(askDialog).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(tool.concurrency).toBe("shared");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("No answer or approval has been received") });
	});

	it("keeps multiple asks and independent work runnable while all questions are unanswered", async () => {
		const tool = new AskTool(session());
		const context = { hasUI: true, ui: {}, abort: vi.fn() } as unknown as AgentToolContext;
		let workDone = false;
		const results = await Promise.all([
			tool.execute("ask-1", { questions }, undefined, undefined, context),
			tool.execute("ask-2", { questions }, undefined, undefined, context),
			Promise.resolve().then(() => { workDone = true; }),
		]);
		expect(results[0]?.details?.pending?.id).toBe("ask-1");
		expect(results[1]?.details?.pending?.id).toBe("ask-2");
		expect(workDone).toBe(true);
	});

	it("renders restored pending questions as unanswered rather than cancelled", async () => {
		const result = await new AskTool(session()).execute("ask-1", { questions }, undefined, undefined,
			{ hasUI: true, ui: {}, abort: vi.fn() } as unknown as AgentToolContext);
		const restored = JSON.parse(JSON.stringify(result));
		const rendered = askToolRenderer.renderResult(restored, { expanded: true, isPartial: false }, theme);
		const text = stripVTControlCharacters(rendered.render(100).join("\n"));
		expect(text).toContain("Which database?");
		expect(text).toContain("SQLite");
		expect(text).toContain("Pending ask-1");
		expect(text).not.toContain("Cancelled");
	});

	it("preserves pending identity and later user reply in the same persisted session", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pending-ask-"));
		const manager = SessionManager.create(dir, dir);
		let restored: SessionManager | undefined;
		try {
			const result = await new AskTool(session({ getSessionId: () => manager.getSessionId() })).execute("ask-1", { questions }, undefined, undefined,
				{ hasUI: true, ui: {}, abort: vi.fn() } as unknown as AgentToolContext);
			manager.appendMessage({ role: "toolResult", toolCallId: "ask-1", toolName: "ask", ...result, isError: false, timestamp: Date.now() });
			await manager.ensureOnDisk();
			await manager.flush();
			restored = await SessionManager.open(manager.getSessionFile()!, dir, undefined, { suppressBreadcrumb: true });
			restored.appendMessage({ role: "user", content: [{ type: "text", text: "ask-1: Postgres" }], timestamp: Date.now() });
			const messages = restored.getBranch().filter(entry => entry.type === "message").map(entry => entry.message);
			expect(restored.getSessionId()).toBe(manager.getSessionId());
			expect(messages[0]).toMatchObject({ role: "toolResult", details: { pending: { id: "ask-1", sessionId: manager.getSessionId() } } });
			expect(messages[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "ask-1: Postgres" }] });
		} finally {
			await restored?.close();
			await manager.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retains exclusive modal semantics only for explicit interactive re-answer", () => {
		expect(new AskTool(session(), { interactiveAnswer: true }).concurrency).toBe("exclusive");
	});
});
