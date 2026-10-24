import { beforeAll, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	createRequirementCandidates,
	evaluateRequirementDoneGate,
	formatDoneGateRefusal,
} from "../../src/tools/requirements-ledger";

beforeAll(async () => {
	await initTheme();
});

it("keeps the R92 classify action visible in the collapsed Todo error card", async () => {
	const requirements = createRequirementCandidates([], ["Handle the sweep"], "2026-10-24T00:00:00.000Z");
	requirements[0]!.id = "R92";
	const issues = await evaluateRequirementDoneGate(requirements, ["Close sweep"], async () => ({
		head: null,
		dirty: false,
	}));
	const refusal = formatDoneGateRefusal(issues);
	const firstLine = refusal.split("\n")[0]!;
	expect(firstLine.length).toBeLessThanOrEqual(100);
	expect(firstLine).toContain("R92");
	expect(firstLine).toMatch(/classify/i);
	const component = new ToolExecutionComponent(
		"todo",
		{ op: "done", task: "Close sweep" },
		{ showImages: false, useBuiltInRenderer: true },
		undefined,
		{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
	);
	component.updateResult({ content: [{ type: "text", text: refusal }], isError: true }, false);
	const rendered = component.render(110).map(line => Bun.stripANSI(line));
	expect(rendered.join("\n")).toContain(firstLine);
	expect(rendered.every(line => Bun.stringWidth(line) <= 110)).toBe(true);
});
