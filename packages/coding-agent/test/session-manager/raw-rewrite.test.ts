import * as path from "node:path";
import { expect, test, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as loader from "../../src/session/session-loader";
import { SessionManager } from "../../src/session/session-manager";
import { CURRENT_SESSION_VERSION } from "../../src/session/session-entries";

test("explicit large rewrites preserve cold UTF-8 records without decoding their payloads", async () => {
	using dir = TempDir.createSync("@pi-raw-rewrite-");
	const file = path.join(dir.path(), "large.jsonl");
	const sink = Bun.file(file).writer();
	sink.write(
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: crypto.randomUUID(), cwd: dir.path(), timestamp: new Date(0).toISOString() })}\n`,
	);
	const payload = "й😺".repeat(5 * 1024 * 1024);
	for (let i = 0; i < 3; i++)
		sink.write(
			`${JSON.stringify({ type: "custom", customType: "fixture", id: String(i), parentId: i === 0 ? null : String(i - 1), timestamp: new Date(0).toISOString(), data: payload })}\n`,
		);
	sink.write(
		`${JSON.stringify({ type: "message", id: "tail", parentId: "2", timestamp: new Date(0).toISOString(), message: { role: "user", content: "tail", timestamp: 0 } })}\n`,
	);
	await sink.end();
	const manager = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
	let decoded = 0;
	const original = loader.readPositionedSessionEntry;
	const reads = spyOn(loader, "readPositionedSessionEntry").mockImplementation((fd, position) => {
		decoded++;
		reads.mockClear();
		return original(fd, position);
	});
	try {
		await manager.rewriteEntries();
		expect(decoded).toBeLessThanOrEqual(1);
		await manager.close();
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		for (let i = 0; i < 3; i++) {
			const entry = reopened.getEntry(String(i));
			expect(entry?.type === "custom" && entry.data === payload).toBe(true);
			expect(entry?.parentId).toBe(i === 0 ? null : String(i - 1));
		}
		await reopened.close();
	} finally {
		reads.mockRestore();
		await manager.close();
	}
}, 120_000);
