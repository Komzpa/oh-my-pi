import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

function extensionProfiles() {
	return readdirSync(new URL("./agents/", import.meta.url))
		.filter(file => file.endsWith(".md"))
		.map(file => {
			const filePath = new URL(`./agents/${file}`, import.meta.url);
			return parseAgent(filePath.pathname, readFileSync(filePath, "utf8"), "user");
		});
}

describe("Reemxy extension agent model chains", () => {
	test("every openrouter entry ends with :free and appears only in light worker roles", () => {
		const lightRoles: Record<string, true> = {
			scout: true,
			scribe: true,
			workhorse: true,
			"gate-runner": true,
			researcher: true,
		};
		for (const profile of extensionProfiles()) {
			for (const model of profile.model ?? []) {
				if (!model.startsWith("openrouter/")) continue;
				expect(model.endsWith(":free"), `${profile.name}: ${model}`).toBe(true);
				expect(lightRoles[profile.name] === true, profile.name).toBe(true);
			}
		}
		for (const profile of extensionProfiles()) {
			if (lightRoles[profile.name] !== true) continue;
			expect(profile.model?.[0]?.startsWith("openrouter/"), profile.name).toBe(true);
		}
	});

	test("judgment profiles never delegate to a weak free model", () => {
		const profiles = extensionProfiles();
		// The -strong coders are the escalation rung a chief picks when luna could not do a row.
		for (const name of [
			"reviewer",
			"security-reviewer",
			"architect",
			"plan-doctor",
			"retro-facilitator",
			"coder-strong",
			"ui-coder-strong",
		]) {
			const profile = profiles.find(agent => agent.name === name);
			expect(profile?.model?.length).toBeGreaterThan(0);
			expect(profile?.model?.some(model => model === "codex-lb/Qwen3.8-27B" || model.endsWith(":free"))).toBe(false);
		}
	});
});
