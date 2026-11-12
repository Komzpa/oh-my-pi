import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createReadOnlyGuard } from "@oh-my-pi/pi-coding-agent/task/read-only-guard";

it("allows read-only commands and untracked build output but detects further edits to an already-dirty file", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "readonly-guard-"));
	try {
		await Bun.$`git init -q ${cwd}`.quiet();
		await Bun.write(path.join(cwd, "tracked"), "indexed");
		await Bun.$`git -C ${cwd} add tracked`.quiet();
		await Bun.write(path.join(cwd, "tracked"), "already dirty");
		const check = await createReadOnlyGuard(cwd);
		await Bun.$`git -C ${cwd} status --short`.quiet();
		await Bun.write(path.join(cwd, "untracked-build"), "output");
		expect(await check?.()).toBeUndefined();
		await Bun.write(path.join(cwd, "tracked"), "another dirty value");
		expect(await check?.()).toContain("tracked checkout changed");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
