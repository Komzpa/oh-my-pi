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
	test("OpenRouter entries are explicitly free light-worker models", () => {
		const lightRoles: Record<string, true> = {
			coder: true,
			"minor-coder": true,
			"ui-coder": true,
			scout: true,
			scribe: true,
			workhorse: true,
			"gate-runner": true,
			researcher: true,
			task: true,
		};
		for (const profile of extensionProfiles()) {
			for (const model of profile.model ?? []) {
				if (!model.startsWith("openrouter/")) continue;
				expect(model.endsWith(":free"), `${profile.name}: ${model}`).toBe(true);
				if (model.endsWith(":free")) expect(lightRoles[profile.name] === true, profile.name).toBe(true);
			}
		}
		// coder, ui-coder and minor-coder open on a measured non-free head (2026-10-22 pool policy).
		const headNotFree = new Set(["coder", "ui-coder", "minor-coder"]);
		for (const profile of extensionProfiles()) {
			if (lightRoles[profile.name] !== true || headNotFree.has(profile.name)) continue;
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

	test("inception mercury-3 is a mechanical-role pool member right after luna, never in strong roles", () => {
		const expected: Record<string, string> = {
			scout: "inception/mercury-3:low",
			workhorse: "inception/mercury-3:low",
			"gate-runner": "inception/mercury-3:low",
			scribe: "inception/mercury-3:low",
			"minor-coder": "inception/mercury-3:low",
		};
		// Roles whose head is not luna: mercury-3 stays in the chain at the pinned effort.
		const withoutLuna: Record<string, string> = {
			"git-pr-owner": "inception/mercury-3:low",
			coder: "inception/mercury-3:medium",
			"ui-coder": "inception/mercury-3:medium",
		};
		for (const profile of extensionProfiles()) {
			const models = profile.model ?? [];
			const want = expected[profile.name];
			if (withoutLuna[profile.name]) {
				expect(models, profile.name).toContain(withoutLuna[profile.name]);
				expect(
					models.some(model => model.startsWith("codex-lb/gpt-6-luna")),
					profile.name,
				).toBe(false);
				continue;
			}
			if (!want) {
				expect(models.some(model => model.startsWith("inception/")), profile.name).toBe(false);
				continue;
			}
			const luna = models.findIndex(model => model.startsWith("codex-lb/gpt-6-luna"));
			expect(luna, profile.name).toBeGreaterThanOrEqual(0);
			expect(models[luna + 1], profile.name).toBe(want);
		}
	});
});
