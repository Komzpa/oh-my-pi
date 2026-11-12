import { expect, it } from "bun:test";
import * as path from "node:path";

for (const shell of ["/usr/bin/zsh", "/bin/bash"]) {
	for (const mode of ["foreground", "background", "children"]) {
		it.skipIf(process.platform !== "linux")(
			`${shell} ${mode}: exec preserves job ownership and reaps inherited children`,
			async () => {
				const fixture = (name: string): string => path.join(import.meta.dir, "fixtures", name);
				const child = Bun.spawn(
					[
						"python3",
						fixture("restart-terminal-shell.py"),
						process.execPath,
						fixture("restart-terminal.ts"),
						fixture("restart-terminal-exec.py"),
						fixture("restart-terminal-successor.ts"),
						shell,
						mode,
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const [code, output, errors] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ code, errors, output: code === 0 ? "" : output }).toEqual({ code: 0, errors: "", output: "" });
			},
			15000,
		);
	}
}
