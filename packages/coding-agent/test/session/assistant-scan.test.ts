import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "../../src/session/session-storage";

function readBytes(): number {
	return Number(fs.readFileSync("/proc/self/io", "utf8").match(/^rchar: (\d+)/m)![1]);
}

it.skipIf(process.platform !== "linux")(
	"listing an appended journal reads only new records and observes replacement",
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-scan-"));
		const file = path.join(dir, "session.jsonl");
		const user = `${JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(8192) } })}\r\n`;
		try {
			await Bun.write(file, user.repeat(1024));
			expect(await new FileSessionStorage().hasAssistantTurn(file)).toBe(false);
			fs.appendFileSync(file, user);
			const before = readBytes();
			expect(await new FileSessionStorage().hasAssistantTurn(file)).toBe(false);
			expect(readBytes() - before).toBeLessThan(256 * 1024);
			fs.appendFileSync(file, '{"type":"message","message":{"role":"assis');
			expect(await new FileSessionStorage().hasAssistantTurn(file)).toBe(false);
			fs.appendFileSync(file, 'tant","content":[]}}\n');
			expect(await new FileSessionStorage().hasAssistantTurn(file)).toBe(true);
			fs.appendFileSync(file, user);
			const positiveBefore = readBytes();
			expect(await new FileSessionStorage().hasAssistantTurn(file)).toBe(true);
			expect(readBytes() - positiveBefore).toBeLessThan(256 * 1024);
			await Bun.write(path.join(dir, "replacement"), user);
			fs.renameSync(path.join(dir, "replacement"), file);
			expect(await new FileSessionStorage().hasAssistantTurn(file)).toBe(false);
			await Bun.write(file, "{}\n");
			expect(await new FileSessionStorage().hasAssistantTurn(file)).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);
