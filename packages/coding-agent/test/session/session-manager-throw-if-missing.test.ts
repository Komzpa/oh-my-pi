import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
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

describe("strict resume source freshness", () => {
	for (const change of ["unchanged", "delete", "truncate", "replace", "append"] as const) {
		it(`handles ${change} during the cwd probe`, async () => {
			const root = makeTempDir("@pi-open-freshness-");
			const file = path.join(root, "session.jsonl");
			const header = (id: string) =>
				JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root }) + "\n";
			await Bun.write(file, header("original"));
			const originalAccess = fs.promises.access;
			let changed = false;
			const access = spyOn(fs.promises, "access").mockImplementation(async (target, mode) => {
				if (target === root && !changed) {
					changed = true;
					if (change === "delete") fs.unlinkSync(file);
					if (change === "truncate") fs.truncateSync(file);
					if (change === "replace") {
						fs.writeFileSync(file + ".new", header("replaced"));
						fs.renameSync(file + ".new", file);
					}
					if (change === "append")
						fs.appendFileSync(
							file,
							JSON.stringify({
								type: "custom",
								id: "added",
								parentId: null,
								timestamp: new Date().toISOString(),
								customType: "freshness-test",
								data: {},
							}) + "\n",
						);
				}
				return originalAccess(target, mode);
			});
			try {
				if (change === "delete" || change === "truncate") {
					await expect(SessionManager.open(file, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
						change === "delete" ? /ENOENT/ : /holds no entries/,
					);
				} else {
					const session = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
					try {
						expect(session.getSessionId()).toBe(change === "replace" ? "replaced" : "original");
						if (change === "append") expect(session.getEntries().some(entry => entry.id === "added")).toBe(true);
					} finally {
						await session.close();
					}
				}
				expect(changed).toBe(true);
			} finally {
				access.mockRestore();
			}
		});
	}
});
