import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

// Real SDK loading, tools, session hook and request serialization; no provider traffic.
describe("instruction refresh at the model boundary", () => {
	for (const route of ["read", "bash", "invocation", "context", "disabled", "short-child", "mature-child"] as const) {
		it(`refreshes loaded instructions via ${route} with the configured eligibility`, async () => {
			using dir = TempDir.createSync("@instruction-session-");
			const file = dir.join(route === "context" ? "RULES.md" : "SKILL.md");
			await Bun.write(file, "original instruction\n");
			const auth = await AuthStorage.create(dir.join("auth.db"));
			const registry = new ModelRegistry(auth, dir.join("models.yml"));
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const settings = Settings.isolated({
				"instructionRefresh.enabled": route !== "disabled",
				"instructionRefresh.subagentMinAgeMs": route === "mature-child" ? 0 : 300000,
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
				"autolearn.enabled": false,
				"ttsr.enabled": false,
				"task.eager": "default",
			});
			const { session } = await createAgentSession({
				cwd: dir.path(),
				agentDir: dir.path(),
				model,
				modelRegistry: registry,
				settings,
				taskDepth: route === "short-child" || route === "mature-child" ? 1 : 0,
				sessionManager: SessionManager.inMemory(dir.path()),
				skills: [],
				contextFiles: route === "context" ? [{ path: file, content: "original instruction\n" }] : [],
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
				} else if (route !== "context") {
					const result = await session.getToolByName("read")!.execute("load", { path: file });
					expect(result.isError).not.toBe(true);
				}
				await Bun.write(file, "updated instruction\n");
				await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
				await session.agent.prompt("first");
				const eligible = route !== "disabled" && route !== "short-child";
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
