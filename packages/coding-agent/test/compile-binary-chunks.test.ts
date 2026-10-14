import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { compileCodingAgent } from "../scripts/compile-binary";

it("compiled discovery loaders retain same-named empty and runtime modules from different directories", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omp-compile-chunks-"));
	try {
		for (const directory of ["render", "memory", "dap"]) {
			await Bun.write(path.join(root, directory, "types.ts"), "export interface Shape { value: string }\n");
		}
		for (const directory of ["left", "right"]) {
			await Bun.write(
				path.join(root, directory, "value.ts"),
				`export const value = ${JSON.stringify(directory)};\n`,
			);
		}
		const entrypoint = path.join(root, "entry.ts");
		await Bun.write(
			entrypoint,
			[
				"const loaders = [",
				...["render/types", "memory/types", "dap/types", "left/value", "right/value"].map(
					module => `() => import(${JSON.stringify(`./${module}.ts`)}),`,
				),
				"];",
				"const modules = await Promise.all(loaders.map(load => load()));",
				"console.log(JSON.stringify(modules.map(module => module.value ?? Object.keys(module))));",
			].join("\n"),
		);
		const outfile = path.join(root, "probe");
		await compileCodingAgent({ repoRoot: root, entrypoint, outfile, transformersVersion: "4.2.0", native: null });
		const process = Bun.spawn([outfile], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(stdout)).toEqual([[], [], [], "left", "right"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
