import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { JournalCursor } from "../../src/session/journal-cursor";

test("append observer waits for complete UTF-8 records, skips consumed bytes, and resets on replacement", async () => {
	using dir = TempDir.createSync("journal-cursor-");
	const file = path.join(dir.path(), "session.jsonl");
	const cursor = new JournalCursor();
	const seen: string[] = [];
	const read = () =>
		cursor.read(
			file,
			entry => seen.push(entry.id),
			() => {
				seen.length = 0;
			},
		);
	await Bun.write(file, '{"type":"custom","id":"one"}\n{"type":"custom","id":"');
	await read();
	expect(seen).toEqual(["one"]);
	await fs.appendFile(file, 'два"}\n');
	await read();
	await read();
	expect(seen).toEqual(["one", "два"]);
	const replacement = path.join(dir.path(), "replacement");
	await Bun.write(replacement, '{"type":"custom","id":"new"}\n');
	await fs.rename(replacement, file);
	await read();
	expect(seen).toEqual(["new"]);
	await Bun.write(file, '{"type":"custom","id":"x"}\n');
	await read();
	expect(seen).toEqual(["x"]);
});

test("a complete imported EOF record is observed once before its delayed newline", async () => {
	using dir = TempDir.createSync("journal-eof-");
	const file = path.join(dir.path(), "session.jsonl");
	const cursor = new JournalCursor();
	const ids: string[] = [];
	const read = () =>
		cursor.read(
			file,
			entry => ids.push(entry.id),
			() => {
				ids.length = 0;
			},
		);
	await Bun.write(file, '{"type":"custom","id":"eof"}');
	await read();
	await read();
	expect(ids).toEqual(["eof"]);
	await fs.appendFile(file, '\n{"type":"custom","id":"next"}\n');
	await read();
	expect(ids).toEqual(["eof", "next"]);
});

test("an in-place rewrite that grows past the old size restarts from offset zero", async () => {
	using dir = TempDir.createSync("journal-rewrite-");
	const file = path.join(dir.path(), "session.jsonl");
	const cursor = new JournalCursor();
	const ids: string[] = [];
	const read = () =>
		cursor.read(
			file,
			entry => ids.push(entry.id),
			() => {
				ids.length = 0;
			},
		);
	await Bun.write(file, '{"type":"custom","id":"old"}\n');
	await read();
	expect(ids).toEqual(["old"]);
	const handle = await fs.open(file, "r+");
	await handle.truncate(0);
	await handle.write('{"type":"custom","id":"new-first"}\n{"type":"custom","id":"new-second"}\n', 0);
	await handle.close();
	await read();
	expect(ids).toEqual(["new-first", "new-second"]);
});
