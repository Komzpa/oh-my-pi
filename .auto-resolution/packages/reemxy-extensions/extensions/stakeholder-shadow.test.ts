import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { type Skill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";

const packageRoot = path.resolve(import.meta.dir, "..");

test("extension root lists the shipped stakeholder skill and ignores a file entrypoint", async () => {
	using dir = TempDir.createSync("stakeholder-discovery-");
	const load = (root: string) =>
		loadCapability<Skill>(skillCapability.id, {
			cwd: path.resolve(dir.path()),
			providers: ["omp-plugins"],
			extensionRoots: { explicit: [root], mode: "explicit-only", configured: [], configuredLevel: "user" },
		});
	const shipped = await load(packageRoot);
	expect(shipped.items.find(skill => skill.name === "stakeholder-shadow")?.path).toBe(
		path.join(packageRoot, "skills/stakeholder-shadow/SKILL.md"),
	);
	const fileOnly = await load(path.join(packageRoot, "extensions/todo_dispatch.ts"));
	expect(fileOnly.items.some(skill => skill.name === "stakeholder-shadow")).toBe(false);
});

test("project-local stakeholder skill owns the bare name over the shipped fallback", async () => {
	using dir = TempDir.createSync("stakeholder-override-");
	const local = path.join(path.resolve(dir.path()), ".agents/skills/stakeholder-shadow/SKILL.md");
	await Bun.write(
		local,
		"---\nname: stakeholder-shadow\ndescription: Project-specific panel.\n---\nRead the project panel.\n",
	);
	const result = await loadSkills({
		cwd: path.resolve(dir.path()),
		enablePiUser: false,
		enablePiProject: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
		enableCodexUser: false,
		enableAgentsUser: false,
		enableAgentsProject: true,
		extensionRoots: { explicit: [packageRoot], mode: "explicit-only", configured: [], configuredLevel: "user" },
	});
	expect(result.skills.find(skill => skill.name === "stakeholder-shadow")?.filePath).toBe(local);
});
