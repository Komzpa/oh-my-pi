import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type AgentDefinition, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const DISCOVERED: AgentDefinition[] = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	},
];

function tagged(name: string, selector: string): AgentDefinition {
	return {
		name,
		description: `Pinned to ${selector}.`,
		systemPrompt: "You are a task agent.",
		model: [selector],
		source: "bundled",
	};
}

function createSession(
	sessionAgents: () => AgentDefinition[],
	advertisedSessionAgents?: () => AgentDefinition[],
): ToolSession {
	return {
		cwd: "/tmp/omp-session-agent-description",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: sessionAgents,
		advertisedSessionAgents,
	} as unknown as ToolSession;
}

describe("task description session agents", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps session model tags out of the cached schema across registrations", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const committed = [tagged("m1", "b/y")];
		const live = [tagged("m1", "b/y")];
		const tool = await TaskTool.create(
			createSession(
				() => live,
				() => committed,
			),
		);
		expect(tool.description).not.toContain("`m1`");
		expect(tool.description).not.toContain("b/y");

		// A mid-session `^c/w` registration only reaches the live set. The
		// model-facing description must not change: it is part of the provider tool
		// prefix, and mutating it would drop the prompt cache for the whole turn.
		const frozen = tool.description;
		live.push(tagged("m2", "c/w"));
		expect(tool.description).toBe(frozen);
		expect(tool.description).not.toContain("m2");
	});

	it("keeps embedded session tags out of the schema too", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const live: AgentDefinition[] = [];
		const tool = await TaskTool.create(createSession(() => live));
		expect(tool.description).not.toContain("`m1`");

		live.push(tagged("m1", "b/y"));
		expect(tool.description).not.toContain("`m1`");
	});
});
