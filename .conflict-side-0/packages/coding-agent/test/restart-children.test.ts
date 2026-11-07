import { expect, it } from "bun:test";
import * as path from "node:path";

for (const mode of ["legacy", "late"]) {
	it.skipIf(process.platform !== "linux")(`startup reaps inherited zombies with ${mode} child metadata`, async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "fixtures/restart-children-legacy.ts"),
				path.join(import.meta.dir, "fixtures/restart-children-legacy.py"),
				path.join(import.meta.dir, "fixtures/restart-children-startup.ts"),
				mode,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [code, output, errors] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code, errors }).toEqual({ code: 0, errors: "" });
		expect(JSON.parse(output)).toEqual({ exists: false, freshExit: 7 });
	});
}
