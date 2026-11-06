import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replayTodoJournals } from "../src/tools/todo-plan-replay";
import { TodoPlanCalibrationStore } from "../src/tools/todo-plan-calibration";

const fixtures = path.join(import.meta.dir, "fixtures/todo-plan-replay");
async function replay(name: string) {
	const file = path.join(fixtures, `${name}.jsonl`);
	return replayTodoJournals([{ path: file, upper_byte: (await fs.stat(file)).size }]);
}
test("frozen targets retain an earlier closed member after archival, and seed survives semantic reread", async () => {
	const result = await replay("closure");
	const first = result.records[0]!;
	expect(first.prediction.observedAt).toBe(Date.parse("2026-01-01T02:00:00Z"));
	expect(first.prediction.actualFinish).toBe(Date.parse("2026-01-01T02:00:00Z"));
	expect(first.censoredAt).toBeUndefined();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-replay-"));
	try {
		const file = path.join(dir, "seed.jsonl");
		const writer = new TodoPlanCalibrationStore(file);
		for (const record of result.records) await writer.append(record);
		const reader = new TodoPlanCalibrationStore(file);
		await reader.refresh();
		expect(reader.snapshot(Date.parse("2026-01-02T00:00:00Z"))).toContainEqual(first.prediction);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("reset and replacement censor original membership instead of certifying a later namesake", async () => {
	for (const name of ["reset", "removed"]) {
		const result = await replay(name);
		expect(result.records[0]!.censoredAt).toBe(Date.parse("2026-01-01T01:00:00Z"));
		expect(result.records[0]!.prediction.actualFinish).toBeUndefined();
	}
});
test("future outcome suffix cannot change the raw earlier forecast", async () => {
	const file = path.join(fixtures, "closure.jsonl");
	const text = await Bun.file(file).text();
	const boundary = text.indexOf("2026-01-01T01:00:00Z");
	const upper = text.lastIndexOf("\n", boundary) + 1;
	const prefix = await replayTodoJournals([{ path: file, upper_byte: upper }]);
	const full = await replay("closure");
	expect(prefix.records[0]!.prediction.rawP50Finish).toBe(full.records[0]!.prediction.rawP50Finish);
	expect(prefix.records[0]!.prediction.upperFinish).toBeUndefined();
});
test("explicit harness exclusion prevents fixture closures entering calibration", async () => {
	const file = path.join(fixtures, "closure.jsonl");
	const result = await replayTodoJournals([
		{ path: file, upper_byte: (await fs.stat(file)).size, excluded_fixture: true },
	]);
	expect(result.records).toEqual([]);
	expect(result.scan.excluded).toBe(1);
});
test("compact schedule and unrelated entries preserve one target and its eventual closure", async () => {
	const result = await replay("compact");
	expect(result.records).toHaveLength(1);
	expect(result.records[0]!.prediction.actualFinish).toBe(Date.parse("2026-01-01T02:00:00Z"));
	expect(result.records[0]!.members).toEqual(['["work","A",0]']);
});
