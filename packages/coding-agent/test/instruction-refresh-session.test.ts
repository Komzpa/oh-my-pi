import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { cfgInstructionRefreshEnabled } from "../src/session/context-settings";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { loadProjectContextFiles } from "../src/system-prompt";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

// Real SDK loading, tools, session hook and request serialization; no provider traffic.
describe("instruction refresh at the model boundary", () => {
	for (const route of [
		"read",
		"bash",
		"invocation",
		"context",
		"disabled",
		"short-child",
		"mature-child",
		"import",
		"fixed",
		"opt-in",
		"tool-loop",
		"side",
		"advisor",
	] as const) {
		it(`refreshes loaded instructions via ${route} with the configured eligibility`, async () => {
			using dir = TempDir.createSync("@instruction-session-");
			const file = dir.join(route === "context" ? "RULES.md" : route === "import" ? "details.md" : "SKILL.md");
			await Bun.write(file, "original instruction\n");
			if (route === "import") await Bun.write(dir.join("AGENTS.md"), "@./details.md\n");
			const contextFiles =
				route === "import"
					? await loadProjectContextFiles({ cwd: dir.path() })
					: route === "context" || route === "fixed" || route === "opt-in"
						? [{ path: file, content: "original instruction\n" }]
						: [];
			const auth = await AuthStorage.create(dir.join("auth.db"));
			if (route === "advisor") auth.keys.setRuntime("anthropic", "test-key");
			const registry = new ModelRegistry(auth, dir.join("models.yml"));
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const settings = Settings.isolated({
				"instructionRefresh.enabled": route !== "disabled" && route !== "opt-in",
				"instructionRefresh.subagentMinAgeMs": route === "mature-child" ? 0 : 300000,
				"async.enabled": false,
				"advisor.enabled": route === "advisor",
				"marketplace.autoUpdate": "off",
				"autolearn.enabled": false,
				"ttsr.enabled": false,
				"task.eager": "default",
			});
			if (route === "advisor") settings.setModelRole("advisor", `${model.provider}/${model.id}`);
			const { session } = await createAgentSession({
				systemPrompt: route === "fixed" ? "fixed prompt" : undefined,
				cwd: dir.path(),
				agentDir: dir.path(),
				model,
				modelRegistry: registry,
				settings,
				taskDepth: route === "short-child" || route === "mature-child" ? 1 : 0,
				sessionManager: SessionManager.inMemory(dir.path()),
				skills: [],
				contextFiles,
				noContextFiles: true,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				toolNames: ["read", "bash"],
				workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			});
			try {
				const requests: string[] = [];
				session.agent.streamFn = (_model, context) => {
					requests.push(context.systemPrompt?.join("\n") ?? "");
					const stream = new AssistantMessageEventStream();
					const message = createAssistantMessage("done");
					if (route === "tool-loop" && requests.length === 1) {
						message.content = [
							{
								type: "toolCall",
								id: "change",
								name: "bash",
								arguments: { command: `echo continuation-rule > ${file}` },
							},
						];
						message.stopReason = "toolUse";
						stream.push({ type: "done", reason: "toolUse", message });
						stream.end(message);
						return stream;
					}
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				};
				if (route === "invocation") {
					await session.buildUserSkillPrompt(
						{ name: "fixture", filePath: file, baseDir: dir.path() },
						{ args: "" },
					);
				} else if (route === "bash") {
					const result = await session.getToolByName("bash")!.execute("load", { command: `cat '${file}'` });
					expect(result.isError).not.toBe(true);
				} else if (route !== "context" && route !== "import" && route !== "fixed" && route !== "opt-in") {
					const result = await session.getToolByName("read")!.execute("load", { path: file });
					expect(result.isError).not.toBe(true);
				}
				if (route === "import") {
					await session.agent.prompt("before change");
					expect(requests[0]).not.toContain("changed since you loaded it");
					requests.length = 0;
				}
				await Bun.write(file, "updated instruction\n");
				await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
				if (route === "advisor") {
					const advisorFile = dir.join("AGENTS.md");
					await Bun.write(advisorFile, "advisor original");
					const advisorRead = session.getAdvisorAgent()?.state.tools.find(tool => tool.name === "read");
					if (!advisorRead) throw new Error("Expected advisor read tool");
					await advisorRead.execute("advisor-load", { path: advisorFile });
					await Bun.write(advisorFile, "advisor-only-changed-rule");
				}
				if (route === "opt-in") cfgInstructionRefreshEnabled.override(settings, true);
				if (route === "side") {
					let sidePrompt = "";
					const boundary = spyOn(session.agent, "buildSideRequestContext").mockImplementation(async () => {
						sidePrompt = session.agent.state.systemPrompt.join("\n");
						throw new Error("side boundary reached");
					});
					try {
						await expect(session.runEphemeralTurn({ promptText: "side", tools: false })).rejects.toThrow(
							"side boundary reached",
						);
						expect(sidePrompt).toContain("updated instruction");
					} finally {
						boundary.mockRestore();
					}
					return;
				}
				await session.agent.prompt("first");
				if (route === "tool-loop") {
					expect(requests).toHaveLength(2);
					expect(requests[0]).not.toContain("continuation-rule");
					expect(requests[1]).toContain("continuation-rule");
					return;
				}
				if (route === "advisor") expect(requests[0]).not.toContain("advisor-only-changed-rule");
				const eligible = route !== "disabled" && route !== "short-child" && route !== "fixed";
				if (eligible) {
					expect(requests[0]).toContain("updated instruction\n");
					expect(requests[0].split("changed since you loaded it")).toHaveLength(2);
					await session.agent.prompt("second");
					expect(requests[1].split("changed since you loaded it")).toHaveLength(2);
					await Bun.write(file, "another instruction\n");
					await session.agent.prompt("third");
					expect(requests[2]).toContain("another instruction\n");
					expect(requests[2]).not.toContain("updated instruction\n");
				} else {
					expect(requests[0]).not.toContain("updated instruction");
				}
			} finally {
				await session.dispose();
				auth.close();
			}
		}, 30000);
	}
});
