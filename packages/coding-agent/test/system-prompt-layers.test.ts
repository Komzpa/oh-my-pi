import { afterEach, expect, it, vi } from "bun:test";
import * as agentDiscovery from "../src/task/discovery";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { buildAnthropicSystemBlocks, convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { createTools, type ToolSession } from "../src/tools";
import { buildSystemPrompt, buildSystemPromptToolMetadata } from "../src/system-prompt";

afterEach(() => vi.restoreAllMocks());

it("preserves global, agent and project cache prefixes across the agent/project/time matrix on provider wires", async () => {
	using dir = TempDir.createSync("@prompt-layers-");
	const rows = [];
	vi.spyOn(agentDiscovery, "discoverAgents").mockImplementation(async cwd => ({
		agents: [{ name: "task", description: `Project catalog: ${cwd}`, systemPrompt: "Task role", source: "bundled" }],
		projectAgentsDir: null,
	}));
	for (const agent of ["main", "task"]) {
		for (const project of ["alpha", "beta"]) {
			for (const time of ["TIME-ONE-RECALL-ONE", "TIME-TWO-RECALL-TWO"]) {
				const cwd = dir.join(project);
				const toolNames = agent === "main" ? ["read", "bash", "task"] : ["read", "bash"];
				const tools = await createTools(
					{
						cwd,
						hasUI: false,
						settings: Settings.isolated(),
						getSessionFile: () => null,
						getSessionSpawns: () => "*",
					} as ToolSession,
					toolNames,
				);
				const rendered = await buildSystemPrompt({
					cwd,
					noContextFiles: true,
					subagent: agent === "task",
					agentRolePrompt: agent === "task" ? "Task role: implement the assigned change." : undefined,
					contextFiles: [{ path: `${cwd}/AGENTS.md`, content: `Project ${project} rules` }],
					skills: [
						{
							name: project,
							description: `${project} skill`,
							filePath: `${cwd}/SKILL.md`,
							baseDir: cwd,
							source: "test",
						},
					],
					rules: [{ name: project, path: `${cwd}/rule.md`, description: `${project} domain` }],
					toolNames,
					tools: buildSystemPromptToolMetadata(new Map(tools.map(tool => [tool.name, tool]))),
					includeWorkspaceTree: true,
					workspaceTree: { rootPath: cwd, rendered: time, truncated: false, totalLines: 1, agentsMdFiles: [] },
					activeRepoContext: null,
				});
				rows.push({
					agent,
					project,
					time,
					tools: tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
					...rendered,
				});
			}
		}
	}
	// This behavioral assertion also runs on the pre-layer upstream builder: project rules
	// used to change the leading system block, defeating reuse across directories.
	expect(rows[0].systemPrompt[0]).toBe(rows[2].systemPrompt[0]);
	for (const row of rows) {
		const index = row.layers;
		if (!index) throw new Error("Renderer did not record layer boundaries");
		const text = row.systemPrompt.join("\n\n");
		if (row.agent === "main") expect(text.slice(index.agent)).toContain(`Project catalog: ${dir.join(row.project)}`);
		expect(text.slice(0, index.project)).not.toContain(row.time);
		expect(row.conversationContext).toContain(row.time);
		const context: Context = {
			systemPrompt: row.systemPrompt,
			tools: row.tools,
			messages: [
				{ role: "developer", content: row.conversationContext!, timestamp: 1 },
				{ role: "user", content: "Do the task", timestamp: 2 },
			],
		};
		const anthropic = buildAnthropicSystemBlocks(context.systemPrompt)!;
		expect(anthropic.map(block => block.text).join("\n\n")).toBe(text);
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		expect(JSON.stringify(convertAnthropicMessages(context.messages, anthropicModel, false))).toContain(row.time);
		const responsesModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;
		const responses = buildParams(responsesModel, context, undefined, undefined).params;
		expect(responses.instructions).toBe(text);
		expect(JSON.stringify(responses.input)).toContain(row.time);
		const reasoningModel = getBundledModel("openai", "o4-mini") as Model<"openai-responses">;
		const reasoning = buildParams(reasoningModel, context, undefined, undefined).params;
		expect(
			reasoning
				.input!.slice(0, row.systemPrompt.length)
				.map(message => ("content" in message ? message.content : ""))
				.join("\n\n"),
		).toBe(text);
		const chatModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		for (const multiple of [false, true]) {
			const chat = convertMessages(chatModel, context, {
				...chatModel.compat,
				supportsMultipleSystemMessages: multiple,
			});
			expect(
				chat
					.filter(message => message.role === "system")
					.map(message => message.content)
					.join("\n\n"),
			).toBe(text);
		}
		for (const other of rows) {
			const boundary =
				row.agent !== other.agent ? index.global : row.project !== other.project ? index.agent : index.project;
			expect(text.slice(0, boundary)).toBe(other.systemPrompt.join("\n\n").slice(0, boundary));
			if (row.agent === other.agent) expect(JSON.stringify(row.tools)).toBe(JSON.stringify(other.tools));
		}
	}
});
