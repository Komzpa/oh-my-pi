import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "../src/session/session-storage";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-scan-bench-"));
const file = path.join(dir, "session.jsonl");
const row = `${JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(8192) } })}\n`;
const chunk = row.repeat(1024);
const fd = fs.openSync(file, "w");
for (let n = 0; n < 128; n++) fs.writeSync(fd, chunk);
fs.closeSync(fd);
function readBytes(): number {
	return Number(fs.readFileSync("/proc/self/io", "utf8").match(/^rchar: (\d+)/m)![1]);
}
async function tick(label: string): Promise<void> {
	let last = performance.now();
	let maxDelayMs = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxDelayMs = Math.max(maxDelayMs, now - last - 1);
		last = now;
	}, 1);
	const bytes = readBytes();
	const start = performance.now();
	const found = await new FileSessionStorage().scanAssistantTurn(file);
	const elapsedMs = performance.now() - start;
	const read = readBytes() - bytes;
	await Bun.sleep(2);
	clearInterval(timer);
	console.log(
		JSON.stringify({ label, fixtureBytes: fs.statSync(file).size, found, readBytes: read, elapsedMs, maxDelayMs }),
	);
}
try {
	await tick("cold");
	fs.appendFileSync(file, row);
	await tick("append");
	await tick("unchanged");
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
