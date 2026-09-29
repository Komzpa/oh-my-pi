import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

const executionTail = [
	"claude-bridge/claude-sonnet-5",
	"codex-lb/Qwen3.8-27B",
	"openrouter/thinkingmachines/inkling:free",
];
const judgmentTail = ["claude-bridge/claude-sonnet-5"];

function extensionProfiles() {
	return readdirSync(new URL("./agents/", import.meta.url))
		.filter(file => file.endsWith(".md"))
		.map(file => {
			const filePath = new URL(`./agents/${file}`, import.meta.url);
			return parseAgent(filePath.pathname, readFileSync(filePath, "utf8"), "user");
		});
}

describe("Reemxy extension agent model chains", () => {
	test("all parsed execution profiles have the live tail in fallback order", () => {
		const profiles = extensionProfiles();
		const execution = profiles.filter(
			agent =>
				![
					"reviewer",
					"security-reviewer",
					"architect",
					"plan-doctor",
					"retro-facilitator",
					"coder-strong",
					"ui-coder-strong",
				].includes(agent.name),
		);
		expect(execution.map(agent => agent.name).sort()).toEqual([
			"business-analyst",
			"coder",
			"creative",
			"gate-runner",
			"git-pr-owner",
			"researcher",
			"scout",
			"scribe",
			"ui-coder",
			"workhorse",
		]);
		for (const agent of execution) expect(agent.model?.slice(-3)).toEqual(executionTail);
		const uiCoder = execution.find(agent => agent.name === "ui-coder");
		expect(uiCoder?.model).not.toContain("anthropic/claude-sonnet-5:medium");
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
			expect(profile?.model?.slice(-1)).toEqual(judgmentTail);
			expect(profile?.model?.some(model => model === "codex-lb/Qwen3.8-27B" || model.endsWith(":free"))).toBe(false);
		}
	});
});
