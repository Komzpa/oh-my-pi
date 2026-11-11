import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseAgent } from "../../src/task/agents";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { refreshAgentDiscovery, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

import { cfgExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

const REFRESHED_AGENTS = [
	{
		name: "task",
		description: "Refreshed task agent",
		systemPrompt: "You are the refreshed task agent.",
		source: "bundled" as const,
	},
];

function createSession(cwd: string, extensions: readonly string[] = []): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ extensions: [...extensions] }),
		effectiveExtensionRoots: () => ({
			explicit: [],
			mode: "merge",
			configured: [...extensions],
			configuredLevel: "user",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("TaskTool.create discovery memo", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuses one discovery scan across repeated creations with the same cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		const first = await TaskTool.create(createSession("/tmp"));
		const second = await TaskTool.create(createSession("/tmp"));

		expect(spy).toHaveBeenCalledTimes(1);
		expect(first.projectInstructions).toBe(second.projectInstructions);
	});

	it("rescans for a different cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await TaskTool.create(createSession("/tmp"));
		await TaskTool.create(createSession("/tmp/omp-memo-other"));

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("isolates sessions sharing a cwd when effective extensions differ", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValueOnce({ agents: TEST_AGENTS, projectAgentsDir: null })
			.mockResolvedValueOnce({ agents: REFRESHED_AGENTS, projectAgentsDir: null });

		const first = await TaskTool.create(createSession("/tmp/omp-memo-shared", ["/extensions/first"]));
		const second = await TaskTool.create(createSession("/tmp/omp-memo-shared", ["/extensions/second"]));

		expect(spy).toHaveBeenCalledTimes(2);
		expect(first.projectInstructions).toContain("General-purpose task agent");
		expect(second.projectInstructions).toContain("Refreshed task agent");
	});

	it("does not cache a rejected discovery", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await expect(TaskTool.create(createSession("/tmp"))).rejects.toThrow("boom");
		const tool = await TaskTool.create(createSession("/tmp"));

		expect(tool.projectInstructions).toContain("task");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("reflects a runtime settings override through the live provider (no stale snapshot)", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValueOnce({ agents: TEST_AGENTS, projectAgentsDir: null })
			.mockResolvedValueOnce({ agents: REFRESHED_AGENTS, projectAgentsDir: null });
		const settings = Settings.isolated({ extensions: [] });
		const session = {
			cwd: "/tmp/omp-memo-live",
			hasUI: false,
			settings,
			// Provider reads settings live — a stored snapshot would freeze the key.
			effectiveExtensionRoots: () => ({
				explicit: [],
				mode: "merge" as const,
				configured: cfgExtensions.get(settings) ?? [],
				configuredLevel: "user" as const,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;

		const before = await TaskTool.create(session);
		expect(before.projectInstructions).toContain("General-purpose task agent");

		cfgExtensions.override(settings, ["/extensions/live"]);
		const after = await TaskTool.create(session);
		expect(after.projectInstructions).toContain("Refreshed task agent");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("publishes refreshed definitions to existing and future tools", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValueOnce({ agents: TEST_AGENTS, projectAgentsDir: null })
			.mockResolvedValueOnce({ agents: REFRESHED_AGENTS, projectAgentsDir: null });
		const session = createSession("/tmp/omp-memo-refresh");
		const existing = await TaskTool.create(session);

		expect(existing.projectInstructions).toContain("General-purpose task agent");
		await refreshAgentDiscovery(session.cwd, session.effectiveExtensionRoots?.());

		expect(existing.projectInstructions).toContain("Refreshed task agent");
		expect(existing.projectInstructions).not.toContain("General-purpose task agent");
		const future = await TaskTool.create(session);
		expect(future.projectInstructions).toContain("Refreshed task agent");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

it("staffing advertises ui-coder publication limits before the lead writes a brief", async () => {
	const profile = new URL("../../../reemxy-extensions/extensions/agents/ui-coder.md", import.meta.url);
	const agent = parseAgent(profile.pathname, await Bun.file(profile).text(), "project");
	const spy = vi
		.spyOn(discoveryModule, "discoverAgents")
		.mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	try {
		const tool = await TaskTool.create(createSession("/tmp/ui-coder-staffing-contract"));
		const advertised = tool.description.split("# Available Agents")[1]!;
		expect(advertised).toContain("no push or merge");
		expect(advertised).toContain("git-pr-owner");
		expect(advertised).toContain("isolated");
	} finally {
		spy.mockRestore();
	}
});
