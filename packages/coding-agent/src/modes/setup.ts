import { getOAuthCredentialProvider } from "@oh-my-pi/pi-ai/oauth";
import { runProviderSetupWizard as runProviderWizard } from "@oh-my-pi/pi-tui/setup/lazy";
import type { SetupHost, SetupScene } from "@oh-my-pi/pi-tui/setup/scenes/types";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	runSetupWizard as runWizard,
	type RunSetupWizardOptions,
	selectSetupScenes as selectScenes,
	type SetupSceneSelectionOptions,
	setupWizardAllowed,
} from "@oh-my-pi/pi-tui/setup/wizard";
import type { Settings } from "../config/settings";
import { canSelfUpdate } from "../cli/update-cli";
import { captureBrowserSession } from "../utils/browser-session";
import { createModelBrowserSource } from "./model-browser-source";
import type { InteractiveModeContext } from "./types";

import {
	cfgColorBlindMode,
	cfgComposerShape,
	cfgSetupVersion,
	cfgSymbolPreset,
	cfgThemeDark,
	cfgThemeLight,
	cfgUpdateAuto,
} from "./settings";
import { cfgDisabledProviders, cfgModelRoleStorage } from "../config/model-settings";

export { ALL_SCENES, CURRENT_SETUP_VERSION, setupWizardAllowed };
export type { SetupScene, SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
export { runStartupSplash } from "@oh-my-pi/pi-tui/setup/startup-splash";

/**
 * The persisting instance behind a session's settings. A session reads through an in-memory
 * overlay of the launch settings, and overlay writes never reach config.yml; setup answers
 * and completion must be saved on the root or the next launch asks again.
 */
function persistentSettings(settings: Settings): Settings {
	let root = settings;
	for (let parent = root.overlayParent(); parent; parent = root.overlayParent()) root = parent;
	return root;
}

/**
 * Apply a setup answer to the session's settings, which the running UI reads (a launch or
 * project layer may shadow the root), and to the persisting root so it survives the launch.
 */
function applySetupChoice(session: Settings, apply: (target: Settings) => void): Settings {
	const root = persistentSettings(session);
	apply(session);
	if (root !== session) apply(root);
	return root;
}

async function saveSetupChoice(session: Settings, apply: (target: Settings) => void): Promise<void> {
	await applySetupChoice(session, apply).flush();
}

/** Bind application preferences and runtime effects to the setup presentation. */
export function createSetupHost(ctx: InteractiveModeContext): SetupHost {
	const modelSource = createModelBrowserSource(ctx.settings, model => ctx.session.effectiveServiceTier(model));
	return {
		ui: ctx.ui,
		get statusLine() {
			return ctx.statusLine;
		},
		get composerShape() {
			return cfgComposerShape.get(ctx.settings);
		},
		get symbolPreset() {
			return cfgSymbolPreset.get(ctx.settings);
		},
		get colorBlindMode() {
			return cfgColorBlindMode.get(ctx.settings);
		},
		get disabledProviders() {
			return cfgDisabledProviders.get(ctx.settings);
		},
		get autoUpdate() {
			return cfgUpdateAuto.get(ctx.settings);
		},
		get authStorage() {
			return ctx.session.modelRegistry.authStorage;
		},
		modelSource,
		getModels: () => ({
			available: ctx.session.modelRegistry.getAvailable("all"),
			all: ctx.session.modelRegistry.getAll("all"),
			current: ctx.session.model,
		}),
		refreshModels: () => ctx.session.modelRegistry.refresh("online-if-uncached"),
		selectModel: async (model, selector) => {
			const projectScope = cfgModelRoleStorage.get(ctx.settings) === "project";
			await ctx.session.setModel(model, "default", { selector, persist: !projectScope });
			if (projectScope)
				await saveSetupChoice(ctx.settings, target => target.setProjectModelRole("default", selector));
		},
		refreshProvider: async provider => {
			// An OAuth alias (`openai-codex-device`) stores its credential under the base provider.
			await ctx.session.modelRegistry.refreshProvider(getOAuthCredentialProvider(provider), "online");
			await ctx.session.refreshScopedModels();
		},
		saveComposerShape: async shape => {
			await saveSetupChoice(ctx.settings, target => cfgComposerShape.set(target, shape));
		},
		saveSymbolPreset: preset => {
			applySetupChoice(ctx.settings, target => cfgSymbolPreset.set(target, preset));
		},
		saveColorBlindMode: enabled => {
			applySetupChoice(ctx.settings, target => cfgColorBlindMode.set(target, enabled));
		},
		saveTheme: (mode, name) => {
			applySetupChoice(ctx.settings, target => (mode === "dark" ? cfgThemeDark : cfgThemeLight).set(target, name));
		},
		canAutoUpdate: () => canSelfUpdate(),
		saveAutoUpdate: async enabled => {
			await saveSetupChoice(ctx.settings, target => cfgUpdateAuto.set(target, enabled));
		},
		captureBrowserSession,
		openInBrowser: url => ctx.openInBrowser(url),
		markComplete: version => markSetupWizardComplete(ctx.settings, version),
		playWelcomeIntro: () => ctx.playWelcomeIntro(),
		showError: message => ctx.showError(message),
	};
}

/** Persist completion only after the setup overlay finishes. */
export async function markSetupWizardComplete(settings: Settings, version = CURRENT_SETUP_VERSION): Promise<void> {
	const persistent = persistentSettings(settings);
	cfgSetupVersion.set(persistent, version);
	await persistent.flush();
}

/** Select eligible setup scenes using the application's live capabilities. */
export function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	ctx?: InteractiveModeContext,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	return selectScenes(storedVersion, scenes, ctx ? createSetupHost(ctx) : undefined, options);
}

/** Run setup with application-owned persistence and provider effects. */
export function runSetupWizard(
	ctx: InteractiveModeContext,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<void> {
	return runWizard(createSetupHost(ctx), scenes, options);
}

/** Open provider setup without advancing onboarding or replaying the welcome intro. */
export function runProviderSetupWizard(ctx: InteractiveModeContext): Promise<void> {
	return runProviderWizard(createSetupHost(ctx));
}
