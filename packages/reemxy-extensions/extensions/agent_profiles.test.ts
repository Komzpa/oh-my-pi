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
	test("no subagent profile routes through OpenRouter, including judgment roles", () => {
		for (const profile of extensionProfiles()) {
			expect(
				profile.model?.some(model => model.startsWith("openrouter/")),
				profile.name,
			).toBe(false);
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
