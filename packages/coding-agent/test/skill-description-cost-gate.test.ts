import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import * as descriptions from "../src/extensibility/skill-descriptions";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import type { AgentSession } from "../src/session/agent-session";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("startup skill compression respects exhausted=%s and meters allowed work", async exhausted => {
	using temp = TempDir.createSync("@skill-cost-startup-");
	const cwd = temp.path();
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "fixture-key");
	const settings = Settings.isolated({
		"marketplace.autoUpdate": "off",
		"session.maxCost": 1,
		modelRoles: { smol: "anthropic/claude-sonnet-4-5" },
	});
	const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
	const model = registry.getAvailable().find(model => model.id === "claude-sonnet-4-5")!;
	const manager = SessionManager.inMemory(cwd);
	if (exhausted) {
		const previous = createAssistantMessage("Previous billed turn");
		previous.usage.cost.total = 1;
		manager.appendMessage(previous);
	}
	const store = descriptions.SkillDescriptionStore.open(path.join(cwd, "skill-descriptions.db"));
	vi.spyOn(descriptions, "openSessionSkillDescriptionStore").mockReturnValue(store);
	const billed = createAssistantMessage("Use for safe data migrations.");
	billed.usage.cost.total = 0.25;
	const send = vi.spyOn(agentCore, "instrumentedCompleteSimple").mockResolvedValue(billed);
	const render = vi.spyOn(descriptions.SkillDescriptionCatalog.prototype, "render");
	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: manager,
			authStorage: auth,
			modelRegistry: registry,
			settings,
			model,
			disableExtensionDiscovery: true,
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			skills: [
				{
					name: "migrations",
					description:
						"Use when planning multi-step migrations across production services, checking dependencies and preserving data consistency while preparing safe rollback procedures.",
					filePath: path.join(cwd, "SKILL.md"),
					baseDir: cwd,
					source: "native:project",
				},
			],
		}));
		const catalog = render.mock.contexts[0] as descriptions.SkillDescriptionCatalog;
		expect(catalog).toBeInstanceOf(descriptions.SkillDescriptionCatalog);
		await catalog.waitForPending();
		expect(send).toHaveBeenCalledTimes(exhausted ? 0 : 1);
		expect(session.costGate.spent).toBeCloseTo(exhausted ? 1 : 0.25, 8);
		expect(session.agent.state.systemPrompt.join("\n")).toContain("migrations");
	} finally {
		await session?.dispose();
		await store.close();
		auth.close();
	}
});
