import { expect, it } from "bun:test";
import { measurePromptLayers } from "../src/prompt-layers";
import { DateCwdReminderInjector } from "../src/session/date-cwd-reminder";

it("reports date reminders as dynamic while preserving the user-turn hash", () => {
	const previous = Bun.env.OMP_PROMPT_LAYERS;
	Bun.env.OMP_PROMPT_LAYERS = "1";
	try {
		const systemPrompt = ["global", "agent", "project"];
		const index = { global: 6, agent: 13, project: 22 };
		const report = (date: string) => {
			const context = new DateCwdReminderInjector().transform(
				{ systemPrompt, messages: [{ role: "user", content: "User task", timestamp: 1 }] },
				date,
				"/project",
			);
			return measurePromptLayers(systemPrompt, index, context.messages);
		};
		const first = report("2026-01-01");
		const second = report("2026-01-02");
		expect(first.layers?.find(layer => layer.layer === "dynamic")?.sha256).not.toBe(
			second.layers?.find(layer => layer.layer === "dynamic")?.sha256,
		);
		expect(first.layers?.find(layer => layer.layer === "turns")?.sha256).toBe(
			second.layers?.find(layer => layer.layer === "turns")?.sha256,
		);
		expect(first.layers?.slice(0, 3)).toEqual(second.layers?.slice(0, 3));
	} finally {
		if (previous === undefined) delete Bun.env.OMP_PROMPT_LAYERS;
		else Bun.env.OMP_PROMPT_LAYERS = previous;
	}
});
