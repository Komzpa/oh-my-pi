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
const CHEAP_PROFILES = new Set(["gate-runner", "git-pr-owner"]);
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
	researcher: ["@judgment"],
	"install-owner": ["@code"],
	profiler: ["@strong"],
	"visual-qa": ["@vision-code"],
	rebaser: ["@code"],
};

// Fixed per-type effort so the auto effort judge never picks a worker's level
// (docs/omp-studies-2026-10-23/effort-study.md in tasks-loop).
const LEVELS: Record<string, string> = {
	"retro-facilitator": "low",
	"git-pr-owner": "low",
	"gate-runner": "low",
	scribe: "low",
	scout: "low",
	"minor-coder": "low",
	coder: "medium",
	"ui-coder": "medium",
	workhorse: "medium",
	researcher: "medium",
	"business-analyst": "medium",
	creative: "medium",
	"coder-strong": "high",
	"ui-coder-strong": "high",
	adversary: "high",
	reviewer: "high",
	"security-reviewer": "high",
	"plan-doctor": "high",
	architect: "high",
	"install-owner": "medium",
	profiler: "medium",
	"visual-qa": "medium",
	rebaser: "medium",
};

describe("Reemxy extension agent model chains", () => {
	test("removed user-shadow role is absent from the extension inventory", () => {
		expect(extensionProfiles().map(profile => profile.name)).not.toContain("user-shadow");
	});
	test("all 18 shared preambles escalate brief mismatches to the lead and follow the answer", () => {
		const profiles = extensionProfiles().filter(profile =>
			profile.systemPrompt.includes("Before starting, verify the brief gives the goal"),
		);
		expect(profiles).toHaveLength(18);
		const line =
			"ask your lead before acting on it: send exactly one message with `write` to `agent://Main`";
		for (const profile of profiles) {
			expect(profile.systemPrompt, profile.name).toContain(line);
			expect(profile.systemPrompt, profile.name).toContain("NOT STARTED: <reason>");
			expect(profile.systemPrompt, profile.name).toContain("follow it exactly and quote it in your receipt");
			expect(profile.systemPrompt, profile.name).toContain("BLOCKED: awaiting lead answer: <question>");
			expect(profile.systemPrompt, profile.name).toContain("Never resolve the question yourself by guessing.");
			expect(profile.systemPrompt, profile.name).toContain("Every final receipt");
		}
	});

	test("profiles name role groups, not literal models", () => {
		for (const profile of extensionProfiles()) {
			if (!CHEAP_PROFILES.has(profile.name)) expect(profile.model, profile.name).toEqual(GROUPS[profile.name]);
		}
	});

	test("every grouped profile is covered and pins a fixed frontmatter effort, not a model suffix", () => {
		const names = extensionProfiles().map(profile => profile.name);
		for (const name of Object.keys(GROUPS)) expect(names, name).toContain(name);
		for (const profile of extensionProfiles()) {
			expect(profile.thinkingLevel as string | undefined, profile.name).toBe(LEVELS[profile.name]);
			if (!CHEAP_PROFILES.has(profile.name)) expect((profile.model ?? []).some(model => /:(?:minimal|low|medium|high|xhigh|max)$/.test(model))).toBe(false);
		}
	});

	test("judgment and strong profiles never include the free group", () => {
		for (const profile of extensionProfiles()) {
			if (
				[
					"reviewer",
					"architect",
					"plan-doctor",
					"adversary",
					"security-reviewer",
					"retro-facilitator",
					"coder-strong",
					"ui-coder-strong",
					"researcher",
					"install-owner",
					"profiler",
					"visual-qa",
					"rebaser",
				].includes(profile.name)
			)
				expect(profile.model, profile.name).not.toContain("@free");
		}
	});

	test("git-pr-owner runs git against the brief ROOT and does not treat a missing object as a remote hang", () => {
		const owner = extensionProfiles().find(profile => profile.name === "git-pr-owner");
		expect(owner?.systemPrompt).toContain("Run every git command as `git -C <ROOT>` against the brief's ROOT.");
		expect(owner?.systemPrompt).toContain(
			"Treat `bad object` or a missing ref as a wrong-directory or local-object problem first, never as a remote hang.",
		);
	});
});
