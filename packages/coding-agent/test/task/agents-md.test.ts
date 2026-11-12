import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { $ } from "bun";
import { loadProjectAgentsMd } from "@oh-my-pi/pi-coding-agent/discovery/project-agents-md";
import { TempDir } from "@oh-my-pi/pi-utils";

const dirs: TempDir[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await dir.remove();
});

it("stops at the repository root and applies overrides along the cwd chain", async () => {
	const dir = await TempDir.create("@task-agents-md-");
	dirs.push(dir);
	await Bun.write(dir.join("AGENTS.md"), "above-root rules");
	await Bun.write(dir.join("repo/AGENTS.md"), "root rules\n@inside.md\n@../outside.md\n@linked.md");
	await Bun.write(dir.join("repo/inside.md"), "inside rules\n@../outside.md");
	await Bun.write(dir.join("outside.md"), "outside rules");
	await Bun.write(dir.join("repo/sub/AGENTS.md"), "replaced rules");
	await Bun.write(dir.join("repo/sub/AGENTS.override.md"), "override rules");
	await fs.symlink(dir.join("outside.md"), dir.join("repo/linked.md"));
	await $`git init ${dir.join("repo")}`.quiet();
	const files = await loadProjectAgentsMd(dir.join("repo/sub"));
	expect(files.map(file => file.path)).toEqual([dir.join("repo/AGENTS.md"), dir.join("repo/sub/AGENTS.override.md")]);
	expect(files[0].content).toContain("inside rules");
	expect(files[0].content).not.toContain("outside rules");
	expect(files[1].content).toBe("override rules");
});
