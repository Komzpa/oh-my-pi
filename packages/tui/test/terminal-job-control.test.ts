import { expect, test } from "bun:test";
import * as path from "node:path";

for (const shell of ["/bin/bash", "/bin/zsh"]) {
	for (const scenario of ["TSTP", "TTIN", "STOP", "bg-continue", "background"]) {
		for (const keyboard of ["kitty", "modifyOtherKeys"]) {
			test.skipIf(process.platform !== "linux" || !Bun.which("python3") || !Bun.which(shell))(
				`${shell} ${scenario} ${keyboard}: fg restores raw input; Delete edits; background preserves shell`,
				async () => {
					const child = Bun.spawn(
						[
							"python3",
							path.join(import.meta.dir, "fixtures/job-control.py"),
							process.execPath,
							path.join(import.meta.dir, "fixtures/job-control.ts"),
							shell,
							scenario,
							keyboard,
						],
						{ stdout: "pipe", stderr: "pipe" },
					);
					const [stdout, stderr, code] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect({ code, stderr, stdout }).toMatchObject({ code: 0, stderr: "" });
				},
				40_000,
			);
		}
	}
}
