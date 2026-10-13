/**
 * `:raw` reads must never truncate a line; normal reads that cap a line must say so and point at `:raw`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const LONG_LINE = Array.from({ length: 140 }, (_, i) => `word${String(i).padStart(3, "0")}`)
	.join(" ")
	.slice(0, 1400);

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
		enableLsp: false,
	};
}

describe("read :raw never truncates lines", () => {
	let tmpDir: string;
	let filePath: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-raw-long-"));
		filePath = path.join(tmpDir, "doc.md");
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		lines[35] = LONG_LINE;
		await fs.writeFile(filePath, `${lines.join("\n")}\n`);
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("whole-file :raw returns the 1400-character line intact", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("c1", { path: `${filePath}:raw` }));
		expect(text).toContain(LONG_LINE);
	});

	it("single-line N-N:raw returns exactly that full line", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("c2", { path: `${filePath}:36-36:raw` }));
		expect(text).toBe(LONG_LINE);
	});

	it("N:raw starts at line N and keeps the long line whole", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("c2b", { path: `${filePath}:36:raw` }));
		expect(text.startsWith(`${LONG_LINE}\nline 37`)).toBe(true);
	});

	it("negative control: normal mode caps the line and the notice says how to see it whole", async () => {
		const tool = wrapToolWithMetaNotice(new ReadTool(createSession(tmpDir)));
		const text = textOutput(await tool.execute("c3", { path: `${filePath}:36` }));
		expect(text).not.toContain(LONG_LINE);
		expect(text).toContain("Some lines truncated to 768 chars. Use :raw:36-36 to read line 36 whole");
	});

	it("raw reads carry no truncation notice", async () => {
		const tool = wrapToolWithMetaNotice(new ReadTool(createSession(tmpDir)));
		const text = textOutput(await tool.execute("c4", { path: `${filePath}:raw` }));
		expect(text).not.toContain("truncated");
	});
});
