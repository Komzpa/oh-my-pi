import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, pathIsWithin } from "@oh-my-pi/pi-utils";
import { expandProjectAtImports } from "./at-imports";

/** Discover only the worker checkout's root-to-cwd instruction chain. */
export async function loadProjectAgentsMd(cwd: string): Promise<Array<{ path: string; content: string }>> {
	const resolvedCwd = await fs.realpath(cwd);
	const root = vcs.git(resolvedCwd)?.info().repoRoot;
	if (!root) return [];
	const files: Array<{ path: string; content: string }> = [];
	let dir = resolvedCwd;
	while (true) {
		for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
			const filePath = path.join(dir, name);
			try {
				if (!pathIsWithin(root, await fs.realpath(filePath))) break;
				const content = await Bun.file(filePath).text();
				files.unshift({ path: filePath, content: await expandProjectAtImports(content, filePath, root) });
				break;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		if (dir === path.resolve(root)) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return files;
}
