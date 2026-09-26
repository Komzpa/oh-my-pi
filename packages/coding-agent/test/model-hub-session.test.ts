import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const openHubs: ModelHubComponent[] = [];
const tempDirs: string[] = [];
const sessions: AgentSession[] = [];
const DOWN = "\x1b[B";

function makeTargetModel(): Model {
	return buildModel({
		id: "model-hub-session-target",
		name: "model-hub-session-target",
		api: "ollama-chat",
		provider: "session-test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

describe("model hub primary Enter is session-only", () => {
	let authDir: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme for model-hub session tests");
		setThemeInstance(theme);
		authDir = path.join(os.tmpdir(), `pi-model-hub-session-auth-${Snowflake.next()}`);
		await fs.mkdir(authDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
	});

	afterEach(async () => {
		for (const hub of openHubs.splice(0)) hub.dispose();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	afterAll(() => {
		removeSyncWithRetries(authDir);
	});

	test("selecting the highlighted model changes this session and preserves both modelRoles config layers", async () => {
		const root = path.join(os.tmpdir(), `pi-model-hub-session-${Snowflake.next()}`);
		tempDirs.push(root);
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const projectConfigPath = path.join(cwd, ".omp", "config.yml");
		const globalConfigPath = path.join(agentDir, "config.yml");
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });

		const globalConfig = "modelRoleStorage: project\nmodelRoles:\n  default: global-session-baseline\n";
		const projectConfig = "modelRoles:\n  smol: project-session-baseline\n";
		await fs.writeFile(globalConfigPath, globalConfig);
		await fs.writeFile(projectConfigPath, projectConfig);
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		const initialModel = getBundledModel("openai", "gpt-4o-mini");
		if (!initialModel) throw new Error("Expected bundled model openai/gpt-4o-mini");
		const targetModel = makeTargetModel();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: initialModel,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
		});
		sessions.push(session);

		// The real AgentSession and SessionManager perform the switch and append its
		// durable branch entry. Only discovery/auth are supplied for this neutral test model.
		const registry = session.modelRegistry as unknown as {
			getAvailable: () => Model[];
			getAll: () => Model[];
			find: (provider: string, id: string) => Model | undefined;
			hasConfiguredAuth: (model: Model) => boolean;
			refreshSelectedModelMetadata: (model: Model) => Promise<Model>;
		};
		registry.getAvailable = () => [initialModel, targetModel];
		registry.getAll = () => [initialModel, targetModel];
		registry.find = (provider, id) =>
			[initialModel, targetModel].find(model => model.provider === provider && model.id === id);
		registry.hasConfiguredAuth = model => model.provider === targetModel.provider;
		registry.refreshSelectedModelMetadata = async model => model;

		let hub: ModelHubComponent | undefined;
		const selection = Promise.withResolvers<void>();
		const failed = Promise.withResolvers<never>();
		const context = createInteractiveModeContext({
			settings,
			session,
			showStatus: message => {
				if (message.includes("Session-only model: session-test/model-hub-session-target")) {
					selection.resolve();
				}
			},
			showError: message => failed.reject(new Error(message)),
			ui: {
				showOverlay: (component: ModelHubComponent) => {
					hub = component;
					return { hide: () => {} };
				},
				terminal: { rows: 40 },
			} as never,
		});
		const switchSettled = Promise.race([selection.promise, failed.promise]);
		new SelectorController(context).showModelSelector();
		if (!hub) throw new Error("SelectorController did not open the model hub");
		openHubs.push(hub);

		expect(session.model).toBe(initialModel);
		expect(settings.getGlobalModelRole("default")).toBe("global-session-baseline");
		expect(settings.getProjectModelRole("smol")).toBe("project-session-baseline");

		// Sidebar → model list, landing on its first item; move down to the distinct session-only target.
		hub.handleInput("\n");
		hub.handleInput(DOWN);
		hub.handleInput("\n");
		await switchSettled;
		await settings.flush();

		expect(session.model?.provider).toBe(targetModel.provider);
		expect(session.model?.id).toBe(targetModel.id);
		const changes = session.sessionManager.getBranch().filter(entry => entry.type === "model_change");
		expect(changes).toContainEqual(expect.objectContaining({
			type: "model_change",
			model: "session-test/model-hub-session-target",
			role: "temporary",
			resolvedModelIsFallback: false,
		}));
		expect(settings.getGlobalModelRole("default")).toBe("global-session-baseline");
		expect(settings.getProjectModelRole("smol")).toBe("project-session-baseline");
		expect(await fs.readFile(globalConfigPath, "utf8")).toBe(globalConfig);
		expect(await fs.readFile(projectConfigPath, "utf8")).toBe(projectConfig);
	});
});
