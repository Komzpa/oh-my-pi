import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	applyModelPreset,
	clearSessionModelPreset,
	createSessionModelPresetActions,
	formatModelPresetSwitch,
	getModelPreset,
	getSessionModelPreset,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgModelPresets, cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgWorkspaceAdditionalDirectories } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgDefaultThinkingLevel, cfgTierOpenai } from "@oh-my-pi/pi-coding-agent/session/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

const SONNET = "anthropic/claude-sonnet-4-5";
const SONNET_46 = "anthropic/claude-sonnet-4-6";
const OPUS = "anthropic/claude-opus-4-5";

function bundled(selector: string) {
	const [, id] = selector.split("/");
	const model = getBundledModel("anthropic", id!);
	if (!model) throw new Error(`missing bundled model ${selector}`);
	return model;
}

describe("session-scoped model presets", () => {
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const tempDirs: TempDir[] = [];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-session-preset-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	function createSession(settings: Settings, initialModel = SONNET, thinkingLevel: Effort = Effort.High) {
		const agent = new Agent({
			initialState: { model: bundled(initialModel), systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel },
		});
		const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		sessions.push(session);
		return session;
	}

	it("applies roles, thinking level and settings as runtime overrides and switches the live model", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		settings.setModelRole("slow", SONNET_46);
		cfgModelPresets.setEntry(settings, "fast", {
			modelRoles: { default: OPUS },
			defaultThinkingLevel: Effort.Low,
			settings: { "tier.openai": "priority" },
		});
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "fast", { scope: "session" });

		expect(result.kind).toBe("switched");
		if (result.kind === "switched") {
			expect(result.shadowed).toEqual([]);
			expect(formatModelPresetSwitch("fast", result, "session")).toBe(
				'Switched to preset "fast" for this session (anthropic/claude-opus-4-5 · low)',
			);
		}
		// Roles the preset leaves out are hidden for the session, as a global switch clears them.
		expect({ ...settings.getModelRoles() }).toEqual({ default: OPUS });
		expect(settings.getModelRoleProvenance("default")).toBe("runtime");
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.Low);
		expect(cfgTierOpenai.get(settings)).toBe("priority");
		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(getSessionModelPreset(settings)).toBe("fast");
	});

	it("a preset without `default` keeps the configured default instead of the automatic pick", async () => {
		const settings = Settings.isolated({ modelRoles: { default: SONNET, slow: SONNET_46 } });
		cfgModelPresets.setEntry(settings, "noDefault", { modelRoles: { smol: OPUS } });
		const session = createSession(settings, OPUS);

		const result = await applyModelPreset(settings, session, "noDefault", { scope: "session" });

		expect(result.kind).toBe("switched");
		expect(settings.getModelRole("default")).toBe(SONNET);
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		// Other omitted roles are still hidden for the session.
		expect({ ...settings.getModelRoles() }).toEqual({ default: SONNET, smol: OPUS });
		clearSessionModelPreset(settings);
		expect(settings.getModelRole("default")).toBe(SONNET);
	});

	it("keeps the configured default alias chain while hiding unrelated omitted roles", async () => {
		const settings = Settings.isolated({ modelRoles: { default: "@slow", slow: "@deep", deep: SONNET, tiny: OPUS } });
		cfgModelPresets.setEntry(settings, "noDefault", { modelRoles: { smol: OPUS } });
		const session = createSession(settings, OPUS);
		const result = await applyModelPreset(settings, session, "noDefault", { scope: "session" });
		expect(result.kind).toBe("switched");
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(settings.getModelRole("default")).toBe("@slow");
		expect(settings.getModelRole("slow")).toBe("@deep");
		expect(settings.getModelRole("deep")).toBe(SONNET);
		expect(settings.getModelRole("tiny")).toBeUndefined();
		clearSessionModelPreset(settings);
		expect(settings.getModelRole("tiny")).toBe(OPUS);
	});

	describe("persistence across resume", () => {
		const PRESET = {
			modelRoles: { default: OPUS, smol: SONNET_46 },
			defaultThinkingLevel: Effort.Low,
			settings: { "tier.openai": "priority" },
		};

		function freshSettings() {
			const settings = Settings.isolated({ modelRoles: { default: SONNET, slow: SONNET_46 } });
			cfgModelPresets.setEntry(settings, "brrrr", PRESET);
			return settings;
		}

		async function persistedManager() {
			const dir = TempDir.createSync("@pi-session-preset-resume-");
			tempDirs.push(dir);
			const manager = SessionManager.create(dir.path(), dir.path());
			manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("seed reply"));
			return { dir, manager };
		}

		async function resume(dir: TempDir, file: string, settings: Settings, additionalDirectories?: string[]) {
			const result = await createAgentSession({
				cwd: dir.path(),
				additionalDirectories,
				agentDir: dir.path(),
				sessionManager: await SessionManager.open(file),
				model: bundled(SONNET),
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			sessions.push(result.session);
			return result.session;
		}

		it("resumed preset initializes secrets before session request transforms", async () => {
			const { dir, manager } = await persistedManager();
			await Bun.write(
				dir.join("secrets.yml"),
				"- type: plain\n  content: synthetic-private-token\n  friendlyName: token\n  mode: obfuscate\n",
			);
			const settings = freshSettings();
			cfgModelPresets.setEntry(settings, "protected", { modelRoles: {}, settings: { "secrets.enabled": true } });
			manager.appendCustomEntry("session-model-preset", { name: "protected" });
			await manager.flush();
			const session = await resume(dir, manager.getSessionFile()!, settings);
			expect(session.obfuscator?.hasSecrets()).toBe(true);
		});

		it("resume replaces configured workspace roots and preserves explicit directory options", async () => {
			for (const explicit of [false, true]) {
				const { dir, manager } = await persistedManager();
				const baseline = dir.join("baseline");
				const replacement = dir.join("replacement");
				const chosen = dir.join("chosen");
				for (const root of [baseline, replacement, chosen]) fs.mkdirSync(root);
				await manager.setAdditionalDirectories([baseline]);
				const settings = freshSettings();
				cfgWorkspaceAdditionalDirectories.override(settings, [baseline]);
				cfgModelPresets.setEntry(settings, "roots", {
					modelRoles: {},
					settings: { "workspace.additionalDirectories": [replacement] },
				});
				manager.appendCustomEntry("session-model-preset", { name: "roots" });
				await manager.flush();
				const session = await resume(dir, manager.getSessionFile()!, settings, explicit ? [chosen] : undefined);
				const roots = session.sessionManager.getAdditionalDirectories();
				expect(roots).toContain(explicit ? chosen : replacement);
				expect(roots.includes(replacement)).toBe(!explicit);
				if (!explicit) expect(roots).not.toContain(baseline);
			}
		});

		it("SDK sessions sharing settings keep their preset overrides independent", async () => {
			const first = await persistedManager();
			const second = await persistedManager();
			const shared = freshSettings();
			const a = await resume(first.dir, first.manager.getSessionFile()!, shared);
			await applyModelPreset(a.settings, a, "brrrr", { scope: "session" });
			const b = await resume(second.dir, second.manager.getSessionFile()!, shared);
			expect(getSessionModelPreset(b.settings)).toBeUndefined();
			expect(b.settings.getModelRole("default")).toBe(SONNET);
			expect(clearSessionModelPreset(b.settings)).toBeUndefined();
			expect(getSessionModelPreset(a.settings)).toBe("brrrr");
			expect(a.settings.getModelRole("default")).toBe(OPUS);
			expect(shared.getModelRole("default")).toBe(SONNET);
		});

		it("re-applies the session preset when the same session file is resumed", async () => {
			const { dir, manager } = await persistedManager();
			const settings = freshSettings();
			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model: bundled(SONNET),
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.High,
					},
				}),
				sessionManager: manager,
				settings,
				modelRegistry,
			});
			sessions.push(session);
			expect((await applyModelPreset(settings, session, "brrrr", { scope: "session" })).kind).toBe("switched");
			await manager.flush();
			const file = manager.getSessionFile()!;

			// A restart: a new process has fresh settings with no runtime overrides.
			const restarted = freshSettings();
			expect(getSessionModelPreset(restarted)).toBeUndefined();
			const restored = (await resume(dir, file, restarted)).settings;

			expect(getSessionModelPreset(restored)).toBe("brrrr");
			expect({ ...restored.getModelRoles() }).toEqual({ default: OPUS, smol: SONNET_46 });
			expect(restored.getModelRole("default")).toBe(OPUS);
			expect(cfgTierOpenai.get(restored)).toBe("priority");
			expect(cfgDefaultThinkingLevel.get(restored)).toBe(Effort.Low);
		});

		it("stays cleared after resume once the preset was cleared", async () => {
			const { dir, manager } = await persistedManager();
			const settings = freshSettings();
			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model: bundled(SONNET),
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.High,
					},
				}),
				sessionManager: manager,
				settings,
				modelRegistry,
			});
			sessions.push(session);
			await applyModelPreset(settings, session, "brrrr", { scope: "session" });
			expect(clearSessionModelPreset(settings, session.sessionManager)).toBe("brrrr");
			await manager.flush();

			const restarted = freshSettings();
			await resume(dir, manager.getSessionFile()!, restarted);

			expect(getSessionModelPreset(restarted)).toBeUndefined();
			expect({ ...restarted.getModelRoles() }).toEqual({ default: SONNET, slow: SONNET_46 });
			expect(cfgTierOpenai.get(restarted)).toBe("none");
		});

		it("does not give a fresh session the preset", async () => {
			const { dir, manager } = await persistedManager();
			const settings = freshSettings();
			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model: bundled(SONNET),
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.High,
					},
				}),
				sessionManager: manager,
				settings,
				modelRegistry,
			});
			sessions.push(session);
			await applyModelPreset(settings, session, "brrrr", { scope: "session" });
			await manager.flush();

			const other = SessionManager.create(dir.path(), dir.path());
			other.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
			other.appendMessage(createAssistantMessage("other reply"));
			await other.flush();
			const restarted = freshSettings();
			await resume(dir, other.getSessionFile()!, restarted);

			expect(getSessionModelPreset(restarted)).toBeUndefined();
			expect(restarted.getModelRole("default")).toBe(SONNET);
		});
	});

	it("clearing restores exact prior values, including pre-existing runtime overrides", async () => {
		const settings = Settings.isolated({
			modelRoles: { default: SONNET, smol: SONNET_46 },
			"tier.openai": "flex",
		});
		settings.setModelRole("slow", OPUS);
		cfgModelPresets.setEntry(settings, "fast", {
			modelRoles: { default: OPUS },
			defaultThinkingLevel: Effort.Low,
			settings: { "tier.openai": "priority", "tier.google": "flex" },
		});
		const session = createSession(settings);
		const before = {
			roles: { ...settings.getModelRoles() },
			override: settings.runtimeOverrideValue(cfgModelRoles),
			openai: cfgTierOpenai.get(settings),
			thinking: cfgDefaultThinkingLevel.get(settings),
			thinkingProvenance: cfgDefaultThinkingLevel.provenance(settings),
		};

		await applyModelPreset(settings, session, "fast", { scope: "session" });
		expect(clearSessionModelPreset(settings)).toBe("fast");

		expect({ ...settings.getModelRoles() }).toEqual(before.roles);
		expect(settings.runtimeOverrideValue(cfgModelRoles)).toEqual(before.override);
		expect(cfgTierOpenai.get(settings)).toBe(before.openai);
		expect(cfgTierOpenai.provenance(settings)).toBe("runtime");
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(before.thinking);
		expect(cfgDefaultThinkingLevel.provenance(settings)).toBe(before.thinkingProvenance);
		expect(settings.runtimeOverrideValue(cfgDefaultThinkingLevel)).toBeUndefined();
		expect(getSessionModelPreset(settings)).toBeUndefined();
		expect(clearSessionModelPreset(settings)).toBeUndefined();
	});

	it("one-argument clear persists the cleared marker through the apply recorder", async () => {
		const settings = Settings.isolated({ modelRoles: { default: SONNET } });
		cfgModelPresets.setEntry(settings, "local", { modelRoles: { default: OPUS } });
		const session = createSession(settings);
		await applyModelPreset(settings, session, "local", { scope: "session" });
		clearSessionModelPreset(settings);
		const markers = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "session-model-preset");
		expect(markers.at(-1)).toMatchObject({ data: { name: null } });
	});

	it("retained default alias roles do not make a session switch fail", async () => {
		const settings = Settings.isolated({ modelRoles: { default: "@slow", slow: SONNET } });
		cfgModelPresets.setEntry(settings, "local", { modelRoles: { smol: OPUS } });
		const result = await applyModelPreset(settings, createSession(settings), "local", { scope: "session" });
		expect(result.kind).toBe("switched");
		if (result.kind !== "switched") throw new Error("switch failed");
		expect(result.shadowed).toEqual([]);
	});

	it("rejects an unavailable retained default before replacing an active session preset", async () => {
		const settings = Settings.isolated({ modelRoles: { default: "missing/model" } });
		cfgModelPresets.setEntry(settings, "valid", { modelRoles: { default: OPUS } });
		cfgModelPresets.setEntry(settings, "invalid", { modelRoles: { smol: SONNET } });
		const session = createSession(settings);
		await applyModelPreset(settings, session, "valid", { scope: "session" });
		const result = await applyModelPreset(settings, session, "invalid", { scope: "session" });
		expect(result.kind).toBe("unavailable");
		expect(getSessionModelPreset(settings)).toBe("valid");
		expect(settings.getModelRole("default")).toBe(OPUS);
		expect(session.model?.id).toBe(bundled(OPUS).id);
	});

	it("clearing restores protocol defaults as soft pins", async () => {
		const settings = Settings.isolated({ modelRoles: { default: SONNET } });
		cfgTierOpenai.pinDefault(settings);
		cfgModelPresets.setEntry(settings, "local", { modelRoles: {}, settings: { "tier.openai": "priority" } });
		await applyModelPreset(settings, createSession(settings), "local", { scope: "session" });
		clearSessionModelPreset(settings);
		cfgTierOpenai.set(settings, "flex");
		expect(cfgTierOpenai.get(settings)).toBe("flex");
	});

	it("switching session presets keeps the original baseline", async () => {
		const settings = Settings.isolated({ modelRoles: { default: SONNET } });
		cfgModelPresets.setEntry(settings, "a", {
			modelRoles: { default: OPUS },
			settings: { "tier.openai": "priority" },
		});
		cfgModelPresets.setEntry(settings, "b", { modelRoles: { default: SONNET_46 } });
		const session = createSession(settings);

		await applyModelPreset(settings, session, "a", { scope: "session" });
		await applyModelPreset(settings, session, "b", { scope: "session" });
		expect(getSessionModelPreset(settings)).toBe("b");
		// "a"'s tier override is gone: "b" does not carry it.
		expect(settings.runtimeOverrideValue(cfgTierOpenai)).toBeUndefined();

		clearSessionModelPreset(settings);
		expect(settings.getModelRole("default")).toBe(SONNET);
		expect(settings.runtimeOverrideValue(cfgModelRoles)).toEqual({ default: SONNET });
	});

	it("validates the preset settings map against the settings registry", () => {
		const settings = Settings.isolated();
		const lookup = (settingsMap: unknown) => {
			cfgModelPresets.setEntry(settings, "p", { modelRoles: { default: OPUS }, settings: settingsMap } as never);
			return getModelPreset(settings, "p");
		};

		expect(lookup({ "tier.openai": "priority" }).kind).toBe("found");
		expect(lookup({ "no.such.setting": 1 })).toEqual({
			kind: "invalid",
			reason: "`settings` names unknown setting `no.such.setting`",
		});
		const badValue = lookup({ "tier.openai": "warp" });
		expect(badValue.kind).toBe("invalid");
		if (badValue.kind === "invalid") expect(badValue.reason).toContain("`settings.tier.openai`: Invalid value");
		expect(lookup({ defaultThinkingLevel: "low" })).toEqual({
			kind: "invalid",
			reason: "`settings.defaultThinkingLevel` is set by a dedicated preset field",
		});
		expect(lookup(["tier.openai"])).toEqual({ kind: "invalid", reason: "`settings` is not a mapping" });
	});

	it("an invalid settings map leaves the session untouched", async () => {
		const settings = Settings.isolated({ modelRoles: { default: SONNET } });
		cfgModelPresets.setEntry(settings, "bad", {
			modelRoles: { default: OPUS },
			settings: { "no.such.setting": 1 },
		} as never);
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "bad", { scope: "session" });

		expect(result.kind).toBe("invalid");
		expect(settings.runtimeOverrideValue(cfgModelRoles)).toEqual({ default: SONNET });
		expect(getSessionModelPreset(settings)).toBeUndefined();
	});

	it("subagent settings spawned after the switch inherit it and follow clear", async () => {
		const settings = Settings.isolated({ modelRoles: { default: SONNET } });
		cfgModelPresets.setEntry(settings, "fast", {
			modelRoles: { default: OPUS },
			defaultThinkingLevel: Effort.Low,
			settings: { "tier.openai": "priority" },
		});
		const session = createSession(settings);
		const before = createSubagentSettings(settings);
		expect(cfgTierOpenai.get(before)).toBe("none");

		await applyModelPreset(settings, session, "fast", { scope: "session" });
		const child = createSubagentSettings(settings);

		expect(child.getModelRole("default")).toBe(OPUS);
		expect(cfgDefaultThinkingLevel.get(child)).toBe(Effort.Low);
		expect(cfgTierOpenai.get(child)).toBe("priority");
		// The overlay reads through live: a role edit by a later switch reaches an existing child.
		clearSessionModelPreset(settings);
		expect(child.getModelRole("default")).toBe(SONNET);
	});

	it("never writes the global config", async () => {
		const dir = TempDir.createSync("@pi-session-preset-config-");
		tempDirs.push(dir);
		const agentDir = path.join(dir.path(), "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const configPath = path.join(agentDir, "config.yml");
		fs.writeFileSync(
			configPath,
			[
				"modelRoles:",
				`  default: ${SONNET}`,
				"modelPresets:",
				"  fast:",
				"    modelRoles:",
				`      default: ${OPUS}`,
				"    settings:",
				"      tier.openai: priority",
				"",
			].join("\n"),
		);
		const settings = await Settings.init({ cwd: dir.path(), agentDir });
		const raw = fs.readFileSync(configPath, "utf8");
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "fast", { scope: "session" });
		expect(result.kind).toBe("switched");
		await settings.flush();
		expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
		expect(settings.getGlobalModelRole("default")).toBe(SONNET);

		clearSessionModelPreset(settings);
		await settings.flush();
		expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
	});

	it("a global switch reports preset settings it does not apply", async () => {
		const settings = Settings.isolated();
		cfgModelPresets.setEntry(settings, "fast", {
			modelRoles: { default: OPUS },
			settings: { "tier.openai": "priority" },
		});
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "fast");

		expect(result.kind).toBe("switched");
		if (result.kind === "switched") expect(result.skippedSettings).toEqual(["tier.openai"]);
		expect(cfgTierOpenai.get(settings)).toBe("none");
		expect(settings.runtimeOverrideValue(cfgTierOpenai)).toBeUndefined();
	});

	it("exposes the extension actions bound to the session settings", async () => {
		const settings = Settings.isolated({ modelRoles: { default: SONNET } });
		cfgModelPresets.setEntry(settings, "fast", { modelRoles: { default: OPUS } });
		const session = createSession(settings);
		const actions = createSessionModelPresetActions(session);

		expect((await actions.applySessionModelPreset("fast")).kind).toBe("switched");
		expect(actions.getSessionModelPreset()).toBe("fast");
		expect(actions.clearSessionModelPreset()).toBe("fast");
		expect(actions.getSessionModelPreset()).toBeUndefined();
	});
});

describe("/modelpreset session", () => {
	const command = lookupBuiltinSlashCommand("modelpreset");

	it("lists the session subcommand for completion", () => {
		expect(command?.subcommands?.map(sub => sub.name)).toContain("session");
	});

	it("applies, reports and clears a session preset without touching config", async () => {
		const settings = Settings.isolated({ modelRoles: { default: SONNET } });
		cfgModelPresets.setEntry(settings, "fast", { modelRoles: { default: OPUS } });
		const applied: Array<string> = [];
		const session = {
			settings,
			scopedModels: [],
			modelRegistry: { hasConfiguredAuth: () => true, hasConcreteAuth: () => true },
			getAvailableModels: () => [getBundledModel("anthropic", "claude-opus-4-5")!],
			setModel: async (model: { id: string }) => {
				applied.push(model.id);
			},
			setThinkingLevel: () => {},
		} as unknown as AgentSession;
		const outputs: string[] = [];
		let configChanges = 0;
		const run = async (args: string) => {
			await command?.handle?.(
				{ name: "modelpreset", args, raw: `/modelpreset ${args}` } as never,
				{
					session,
					settings,
					output: async (text: string) => void outputs.push(text),
					notifyConfigChanged: async () => {
						configChanges++;
					},
				} as never,
			);
			return outputs.at(-1);
		};

		expect(await run("session")).toContain("No session model preset");
		expect(await run("session fast")).toBe(
			'Switched to preset "fast" for this session (anthropic/claude-opus-4-5 · high)',
		);
		expect(applied).toEqual(["claude-opus-4-5"]);
		expect(configChanges).toBe(1);
		expect(settings.getModelRole("default")).toBe(OPUS);
		expect(await run("session")).toContain("Session model preset: fast");
		expect(await run("session off")).toContain('Cleared session model preset "fast"');
		expect(settings.getModelRole("default")).toBe(SONNET);
		expect(configChanges).toBe(2);
		expect(await run("session off")).toBe("No session model preset to clear");
		expect(await run("session nope")).toBe("Preset not found: nope");
	});
});
