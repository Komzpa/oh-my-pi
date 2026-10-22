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

/** Role groups are defined by the owner in config.yml; a missing role falls back to `default` in core. */
const GROUPS: Record<string, string[]> = {
	scout: ["@free", "@fast"],
	scribe: ["@free", "@fast"],
	workhorse: ["@free", "@fast"],
	"gate-runner": ["@free", "@fast"],
	"git-pr-owner": ["@free", "@fast"],
	"minor-coder": ["@free", "@fast", "@code"],
	coder: ["@free", "@code"],
	"coder-strong": ["@strong"],
	"ui-coder": ["@free", "@vision-code"],
	"ui-coder-strong": ["@strong"],
	reviewer: ["@judgment"],
	architect: ["@judgment"],
	"plan-doctor": ["@judgment"],
	adversary: ["@judgment"],
	"security-reviewer": ["@judgment"],
	"retro-facilitator": ["@judgment"],
	"business-analyst": ["@judgment"],
	creative: ["@judgment"],
	researcher: ["@free", "@judgment"],
};

describe("Reemxy extension agent model chains", () => {
	test("profiles name role groups, not literal models", () => {
		for (const profile of extensionProfiles()) {
			if (profile.name === "deepseek") continue;
			expect(profile.model, profile.name).toEqual(GROUPS[profile.name]);
		}
	});

	test("every grouped profile is covered and none pins an effort", () => {
		const names = extensionProfiles().map(profile => profile.name);
		for (const name of Object.keys(GROUPS)) expect(names, name).toContain(name);
		for (const profile of extensionProfiles()) {
			if (profile.name === "deepseek") continue;
			expect(profile.thinkingLevel, profile.name).toBeUndefined();
			expect((profile.model ?? []).some(model => /:(?:minimal|low|medium|high|xhigh|max)$/.test(model))).toBe(false);
		}
	});

	test("judgment and strong profiles never include the free group", () => {
		for (const profile of extensionProfiles()) {
			if (["reviewer", "architect", "plan-doctor", "adversary", "security-reviewer", "retro-facilitator", "coder-strong", "ui-coder-strong"].includes(profile.name))
				expect(profile.model, profile.name).not.toContain("@free");
		}
	});
});
