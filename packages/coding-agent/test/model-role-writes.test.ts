import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const openHubs: ModelHubComponent[] = [];

function makeModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

function createController(settings: Settings, models: Model[]): ModelHubComponent {
	let hub: ModelHubComponent | undefined;
	const registry = {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		authStorage: { keys: { source: () => undefined } },
	} as unknown as ModelRegistry;
	const ctx = {
		settings,
		ui: {
			showOverlay: (component: ModelHubComponent) => {
				hub = component;
				return { hide: () => {} };
			},
			setFocus: () => {},
			requestRender: () => {},
			terminal: { rows: 40 },
		},
		session: {
			modelRegistry: registry,
			scopedModels: models.map(model => ({ model })),
			getAvailableModels: () => models,
			setModel: async () => ({ switched: true }),
			setThinkingLevel: () => {},
		},
		showStatus: () => {},
		showError: (message: string) => {
			throw new Error(message);
		},
	} as unknown as InteractiveModeContext;

	new SelectorController(ctx).showModelSelector();
	if (!hub) throw new Error("SelectorController did not open the model hub");
	openHubs.push(hub);
	return hub;
}

function enterRolesView(hub: ModelHubComponent): void {
	hub.handleInput(UP);
	hub.handleInput("\n");
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for model-role write tests");
	setThemeInstance(theme);
});

afterEach(() => {
	for (const hub of openHubs.splice(0)) hub.dispose();
});

describe("model role writes through SelectorController", () => {
	test("project and global role assignments and removals update only their stored layer", () => {
		const model = makeModel("role-write-model");
		const settings = Settings.isolated({ modelRoleStorage: "project" });
		const hub = createController(settings, [model]);

		// The scope chips are ordered project default, global default, project smol, global smol.
		hub.handleInput("\n");
		hub.handleInput("\x1br"); // Alt+R opens role choices without consuming search text.
		hub.handleInput(DOWN);
		hub.handleInput(DOWN);
		hub.handleInput("\n");
		expect(settings.getProjectModelRole("smol")).toBe("test/role-write-model");
		expect(settings.getGlobalModelRole("smol")).toBeUndefined();

		const globalAssign = createController(settings, [model]);
		globalAssign.handleInput("\n");
		globalAssign.handleInput("\x1br"); // Alt+R opens role choices without consuming search text.
		globalAssign.handleInput(DOWN);
		globalAssign.handleInput(DOWN);
		globalAssign.handleInput(DOWN);
		globalAssign.handleInput("\n");
		expect(settings.getGlobalModelRole("smol")).toBe("test/role-write-model");
		expect(settings.getProjectModelRole("smol")).toBe("test/role-write-model");

		const projectUnassign = createController(settings, [model]);
		projectUnassign.handleInput("\n");
		projectUnassign.handleInput("\x1br"); // Alt+R opens role choices without consuming search text.
		projectUnassign.handleInput(DOWN);
		projectUnassign.handleInput(DOWN);
		projectUnassign.handleInput("\n");
		expect(settings.getProjectModelRole("smol")).toBeUndefined();
		expect(settings.getGlobalModelRole("smol")).toBe("test/role-write-model");

		const globalUnassign = createController(settings, [model]);
		globalUnassign.handleInput("\n");
		globalUnassign.handleInput("\x1br"); // Alt+R opens role choices without consuming search text.
		globalUnassign.handleInput(DOWN);
		globalUnassign.handleInput(DOWN);
		globalUnassign.handleInput(DOWN);
		globalUnassign.handleInput("\n");
		expect(settings.getGlobalModelRole("smol")).toBeUndefined();
		expect(settings.getProjectModelRole("smol")).toBeUndefined();
	});
});

describe("fallback-chain writes through SelectorController", () => {
	test("appending a fallback stores the picked selector under the selected role key", () => {
		const model = makeModel("chain-append");
		const settings = Settings.isolated({});
		const hub = createController(settings, [model]);

		enterRolesView(hub);
		hub.handleInput("f");
		hub.handleInput("\n");
		hub.handleInput("\n");

		expect(cfgRetryFallbackChains.get(settings)).toEqual({ default: ["test/chain-append"] });
	});

	test("replacing a fallback writes the new value without dropping another role key", () => {
		const first = makeModel("chain-first");
		const replacement = makeModel("chain-replacement");
		const settings = Settings.isolated({});
		cfgRetryFallbackChains.set(settings, { default: ["test/chain-first"], task: ["test/keep-task"] });
		const hub = createController(settings, [first, replacement]);

		enterRolesView(hub);
		hub.handleInput(DOWN); // default → its first fallback row
		hub.handleInput("\n");
		for (const ch of "chain-replacement") hub.handleInput(ch);
		hub.handleInput("\n");

		expect(cfgRetryFallbackChains.get(settings)).toEqual({
			default: ["test/chain-replacement"],
			task: ["test/keep-task"],
		});
	});

	test("removing the last fallback deletes only that chain key", () => {
		const model = makeModel("chain-remove");
		const settings = Settings.isolated({});
		cfgRetryFallbackChains.set(settings, { default: ["test/chain-remove"], task: ["test/keep-task"] });
		const hub = createController(settings, [model]);

		enterRolesView(hub);
		hub.handleInput(DOWN); // default → its first fallback row
		hub.handleInput("x");

		expect(cfgRetryFallbackChains.get(settings)).toEqual({ task: ["test/keep-task"] });
	});
});
