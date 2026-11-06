import { describe, expect, it } from "bun:test";
import { loadEntriesFromFileStream, loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Storage whose stat lags its content, simulating an interleaving appender. */
class SkewedStorage extends MemorySessionStorage {
	override statSync(path: string) {
		const stat = super.statSync(path);
		return { ...stat, size: Math.max(0, stat.size - 12) };
	}
}

const HEADER = JSON.stringify({ type: "session", id: "s1", version: 1, timestamp: "t", cwd: "/c" });
const LINE = JSON.stringify({ type: "message", id: "m1" });

describe("loadSessionFile sourceSize", () => {
	it("describes the snapshot actually read, not the pre-read stat", async () => {
		const storage = new SkewedStorage();
		const content = `${HEADER}\n${LINE}\n`;
		storage.writeTextSync("/s/l.jsonl", content);

		const loaded = await loadSessionFile("/s/l.jsonl", storage);
		expect(loaded.entries.length).toBeGreaterThan(0);
		expect(loaded.sourceSize).toBe(Buffer.byteLength(content, "utf8"));
	});

	it("stays null when the path does not exist", async () => {
		const dir = TempDir.createSync("@loader-source-size-");
		try {
			const storage = new FileSessionStorage();
			const loaded = await loadSessionFile(`${dir.path()}/missing.jsonl`, storage);
			expect(loaded.sourceSize).toBeNull();
			expect(loaded.entries).toEqual([]);
		} finally {
			await dir.remove();
		}
	});
});

it("streamed snapshot replay preserves unicode and independent mutable payloads across repeated text", async () => {
	using dir = TempDir.createSync("@loader-snapshots-");
	const file = dir.join("session.jsonl");
	const text = "Repeated snapshot 世界 ".repeat(4000);
	const row = (id: string) => ({ type: "custom", id, customType: "state", data: { rows: [{ text }] } });
	await Bun.write(file, `${HEADER}\n${JSON.stringify(row("a"))}\nbroken\n${JSON.stringify(row("b"))}\n`);
	const loaded = await loadEntriesFromFileStream(file);
	expect(loaded.malformedRecords).toBe(1);
	const first = loaded.entries[1];
	const second = loaded.entries[2];
	if (first?.type !== "custom" || second?.type !== "custom") throw new Error("Missing snapshots");
	const a = first.data as { rows: { text: string }[] };
	const b = second.data as { rows: { text: string }[] };
	a.rows[0]!.text = "edited";
	a.rows.push({ text: "new row" });
	expect(b.rows).toEqual([{ text }]);
});
