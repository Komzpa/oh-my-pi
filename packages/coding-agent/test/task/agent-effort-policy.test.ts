import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { capImplementationWorkerEffortCeiling } from "@oh-my-pi/pi-coding-agent/task/executor";

function requiredModel(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing fixture ${provider}/${id}`);
	return model;
}

function worker(agent: string, initial: Model) {
	let model = initial;
	let sent: Effort | undefined;
	const controls = new ModelControls(
		{
			model: () => model,
			agent: {
				setThinkingLevel: (level: Effort | undefined) => {
					sent = level;
				},
				setDisableReasoning: () => {},
			},
			clearInheritedProviderPromptCacheKey: () => {},
			sessionManager: { appendThinkingLevelChange: () => {} },
			emit: () => {},
		} as unknown as ModelControlsHost,
		{
			thinkingLevel: Effort.Max,
			thinkingLevelCeiling: active => capImplementationWorkerEffortCeiling(agent, active, undefined, {}),
		},
	);
	return {
		controls,
		sent: () => sent,
		switchTo: (next: Model) => {
			model = next;
			controls.setThinkingLevel(Effort.Max);
		},
	};
}

describe("task effort policy on the effective model", () => {
	it("caps a deferred hosted Claude and follows GPT/Claude fallback transitions", () => {
		const claude = requiredModel("amazon-bedrock", "anthropic.claude-opus-4-6-v1");
		const gpt = requiredModel("openai-codex", "gpt-5.6-sol");
		// This is the model selected after SDK deferred resolution, rather than the
		// undefined initial override or the stale model recorded in session_init.
		const child = worker("sonic", claude);
		expect(child.sent()).toBe(Effort.High);
		child.switchTo(gpt);
		expect(child.sent()).toBe(Effort.Max);
		child.switchTo(claude);
		expect(child.sent()).toBe(Effort.High);
		expect(child.controls.getAvailableEffortSelectors()).not.toContain(Effort.Max);
	});

	it("leaves judgment workers on the same hosted Claude free to use max", () => {
		const child = worker("reviewer", requiredModel("amazon-bedrock", "anthropic.claude-opus-4-6-v1"));
		expect(child.sent()).toBe(Effort.Max);
	});

	it("rejects an incompatible resolved model instead of running above the agent ceiling", () => {
		const mini = requiredModel("azure", "gpt-5.1-codex-mini");
		expect(
			() =>
				new ModelControls(
					{
						model: () => mini,
						agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} },
					} as unknown as ModelControlsHost,
					{
						thinkingLevel: Effort.High,
						thinkingLevelCeiling: active =>
							capImplementationWorkerEffortCeiling("scout", active, undefined, { scout: Effort.Low }),
					},
				),
		).toThrow(/cannot honor effort ceiling low/);
	});
});
