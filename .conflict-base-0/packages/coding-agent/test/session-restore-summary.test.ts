import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { hasRestorableTurn } from "../src/session/exit-diagnostics";
import * as loader from "../src/session/session-loader";
import { collectSubSessions } from "../src/session/sub-sessions";

let temp: TempDir | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	temp?.removeSync();
	temp = undefined;
});

function message(id: string, role: string, content: unknown, extra: object = {}) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-06T00:00:00Z",
		message: { role, content, timestamp: 1, ...extra },
	};
}
function lines(entries: unknown[]): string {
	return entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
}
async function fixture() {
	temp = TempDir.createSync("restore-index-");
	const main = path.join(temp.path(), "main.jsonl");
	const file = path.join(temp.path(), "main", "Worker.jsonl");
	await Bun.write(
		file,
		lines([
			{ type: "session", id: "session", version: 3, cwd: temp.path() },
			{ type: "session_init", id: "init", parentId: null, systemPrompt: ["prompt"], task: "work", tools: ["yield"] },
			...Array.from({ length: 600 }, (_, i) => message(`u${i}`, "user", "old body".repeat(30))),
			message(
				"pending",
				"assistant",
				[{ type: "toolCall", id: "yield1", name: "yield", arguments: { huge: "omit" } }],
				{ stopReason: "toolUse" },
			),
		]),
	);
	return { main, file };
}

it("restore selection yields, skips unchanged parsing, and reads only appended bytes", async () => {
	const { main, file } = await fixture();
	const original = loader.visitEntriesFromFileStream;
	const reads: { offset: number; bytes: number }[] = [];
	vi.spyOn(loader, "visitEntriesFromFileStream").mockImplementation(async (file, visit, options) => {
		const read = { offset: options?.startOffset ?? 0, bytes: 0 };
		reads.push(read);
		return original(file, visit, {
			...options,
			onBytesConsumed: bytes => {
				read.bytes += bytes;
				options?.onBytesConsumed?.(bytes);
			},
		});
	});
	const whole = vi.spyOn(loader, "loadSessionFile");
	let heartbeat = false;
	const timer = setTimeout(() => {
		heartbeat = true;
	}, 0);
	try {
		const first = (await collectSubSessions(main)).Worker!;
		expect(hasRestorableTurn(first.entries)).toBe(true);
		expect(first.entries.filter(entry => entry.type === "message").length).toBeLessThanOrEqual(2);
		expect(whole).not.toHaveBeenCalled();
		expect(heartbeat).toBe(true);
		const count = reads.length;
		await collectSubSessions(main);
		expect(reads.length).toBe(count);
		const size = (await fs.stat(file)).size;
		const append = lines([
			message("result", "toolResult", "done", { toolCallId: "yield1", toolName: "yield", isError: false }),
		]);
		await fs.appendFile(file, append);
		const next = (await collectSubSessions(main)).Worker!;
		expect(reads.at(-1)).toEqual({ offset: size, bytes: Buffer.byteLength(append) });
		expect(
			next.entries.some(
				entry =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "yield1",
			),
		).toBe(true);
		expect(next.leafId).toBe("result");
		await fs.appendFile(
			file,
			lines([
				{
					type: "custom",
					id: "exit",
					parentId: "result",
					customType: "session_exit",
					data: { reason: "done", kind: "normal", recordedAt: "2026-11-06" },
				},
			]),
		);
		expect(hasRestorableTurn((await collectSubSessions(main)).Worker!.entries)).toBe(false);
	} finally {
		clearTimeout(timer);
	}
});

it("replays an unterminated record, invalidates rewritten files, and retains branch leaf and tombstone semantics", async () => {
	const { main, file } = await fixture();
	const partial = JSON.stringify(
		message("done", "assistant", [{ type: "text", text: "finished" }], { stopReason: "stop" }),
	);
	await fs.appendFile(file, partial.slice(0, -1));
	const incomplete = (await collectSubSessions(main)).Worker!;
	expect(hasRestorableTurn(incomplete.entries)).toBe(true);
	await fs.appendFile(file, "}\n");
	const complete = (await collectSubSessions(main)).Worker!;
	expect(hasRestorableTurn(complete.entries)).toBe(false);
	await fs.appendFile(
		file,
		lines([
			{ type: "custom", id: "late", parentId: "pending", activeLeafId: "pending", customType: "usage", data: {} },
		]),
	);
	expect((await collectSubSessions(main)).Worker!.leafId).toBe("pending");
	await Bun.write(file + ".tombstone", "");
	// A same-path replacement must discard all prior summary facts.
	await Bun.write(
		file + ".new",
		lines([{ type: "session", id: "new", version: 3 }, message("restart", "user", "retry")]),
	);
	await fs.rename(file + ".new", file);
	const rewritten = (await collectSubSessions(main)).Worker!;
	expect(hasRestorableTurn(rewritten.entries)).toBe(true);
	expect(rewritten.leafId).toBe("restart");
	expect(rewritten.aborted).toBe(true);
});
