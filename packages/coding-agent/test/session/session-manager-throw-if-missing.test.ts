import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("SessionManager.open with throwIfMissing", () => {
	it("rejects a missing file without creating it", async () => {
		const root = makeTempDir("@pi-open-throw-missing-");
		const missing = path.join(root, "missing.jsonl");

		await expect(SessionManager.open(missing, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			/ENOENT/,
		);
		// Fail closed means no phantom session is materialized at the requested path.
		expect(await Bun.file(missing).exists()).toBe(false);
	});

	it("still mints at a missing path when the flag is omitted, keeping --session working", async () => {
		const root = makeTempDir("@pi-open-mint-default-");
		const fresh = path.join(root, "fresh.jsonl");

		const manager = await SessionManager.open(fresh, undefined, undefined, { initialCwd: root });
		expect(manager.getSessionFile()).toBe(path.resolve(fresh));
		expect(await Bun.file(fresh).exists()).toBe(true);
		await manager.close();
	});

	it("rejects an existing but empty file instead of rewriting it", async () => {
		const root = makeTempDir("@pi-open-throw-empty-");
		const empty = path.join(root, "empty.jsonl");
		await Bun.write(empty, "");

		await expect(SessionManager.open(empty, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			/holds no entries/,
		);
		expect(await Bun.file(empty).text()).toBe("");
	});
});

it("freshness reopen adopts a replacement after probing and rejects a truncated replacement", async () => {
	const root = makeTempDir("@pi-open-freshness-");
	const file = path.join(root, "saved.jsonl");
	const header = JSON.stringify({ type: "session", version: 3, id: "saved", timestamp: "2026-01-01", cwd: root });
	const transcript = (value: string) =>
		`${header}\n${JSON.stringify({ type: "custom", id: value, parentId: null, timestamp: "2026-01-01", customType: "snapshot", data: { value } })}\n`;
	for (const replacement of [transcript("fresh"), ""]) {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(file, transcript("stale"));
		const read = storage.readText.bind(storage);
		const probe = spyOn(storage, "readText").mockImplementationOnce(async path => {
			const body = await read(path);
			storage.writeTextSync(path, replacement);
			return body;
		});
		try {
			const opening = SessionManager.open(file, root, storage, { throwIfMissing: true, suppressBreadcrumb: true });
			if (replacement) {
				const manager = await opening;
				expect(manager.getEntries().map(entry => entry.id)).toEqual(["fresh"]);
				await manager.close();
			} else {
				await expect(opening).rejects.toThrow(/holds no entries/);
				expect(await read(file)).toBe("");
			}
		} finally {
			probe.mockRestore();
		}
	}
});
