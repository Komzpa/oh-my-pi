import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readDurationHistory } from "./todo_calibration";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const outcome = (key: string) =>
	JSON.stringify({ kind: "outcome", status: "completed", agent: "coder", spawnKey: key, durationMs: 3000 });

test("appending an outcome reads only appended bytes and retains prior calibration", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calibration-io-"));
	dirs.push(dir);
	const journal = path.join(dir, "spawns.jsonl");
	fs.writeFileSync(journal, `${outcome("a")}\n`);
	expect(readDurationHistory(journal).samples.map(sample => sample.spawnKey)).toEqual(["a"]);
	const reads = spyOn(fs, "readSync");
	const fullReads = spyOn(fs, "readFileSync");
	try {
		const append = `${outcome("б")}\n`;
		fs.appendFileSync(journal, append);
		expect(readDurationHistory(journal).samples.map(sample => sample.spawnKey)).toEqual(["a", "б"]);
		expect(fullReads.mock.calls).toHaveLength(0);
		expect(reads.mock.results.reduce((sum, result) => sum + Number(result.value), 0)).toBe(Buffer.byteLength(append));
		reads.mockClear();
		expect(readDurationHistory(journal).samples).toHaveLength(2);
		expect(reads.mock.calls).toHaveLength(0);
	} finally {
		reads.mockRestore();
		fullReads.mockRestore();
	}
});

test("partial outcomes are deferred, replacements and truncation discard obsolete history", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calibration-io-"));
	dirs.push(dir);
	const journal = path.join(dir, "spawns.jsonl");
	fs.writeFileSync(journal, outcome("partial"));
	expect(readDurationHistory(journal).samples).toEqual([]);
	fs.appendFileSync(journal, "\n");
	expect(readDurationHistory(journal).samples.map(sample => sample.spawnKey)).toEqual(["partial"]);
	fs.writeFileSync(journal, "");
	expect(readDurationHistory(journal).samples).toEqual([]);
	fs.writeFileSync(`${journal}.new`, `${outcome("replacement")}\n`);
	fs.renameSync(`${journal}.new`, journal);
	expect(readDurationHistory(journal).samples.map(sample => sample.spawnKey)).toEqual(["replacement"]);
});
