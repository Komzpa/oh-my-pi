import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { readDurationHistory } from "../packages/reemxy-extensions/extensions/todo_calibration";
const file = "/tmp/journalscan-router-1g.jsonl";
if (!fs.existsSync(file)) {
	const fd = fs.openSync(file, "w");
	const line = JSON.stringify({ padding: "x".repeat(65520) }) + "\n";
	for (let i = 0; i < Math.ceil(1073741824 / line.length); i++) fs.writeSync(fd, line);
	fs.closeSync(fd);
}
readDurationHistory(file);
const append =
	JSON.stringify({
		kind: "outcome",
		status: "completed",
		agent: "coder",
		spawnKey: crypto.randomUUID(),
		durationMs: 3000,
	}) + "\n";
fs.appendFileSync(file, append);
const reads = spyOn(fs, "readSync");
const fullReads = spyOn(fs, "readFileSync");
const timerStart = performance.now();
const timer = Promise.withResolvers<number>();
setTimeout(() => timer.resolve(performance.now() - timerStart), 0);
const start = performance.now();
const history = readDurationHistory(file);
const elapsed = performance.now() - start;
console.log(
	JSON.stringify({
		fixtureBytes: fs.statSync(file).size,
		appendBytes: append.length,
		readBytes:
			reads.mock.results.reduce((sum, result) => sum + Number(result.value), 0) +
			fullReads.mock.results.reduce((sum, result) => sum + result.value.length, 0),
		syncMs: elapsed,
		timerDelayMs: await timer.promise,
		samples: history.samples.length,
	}),
);
