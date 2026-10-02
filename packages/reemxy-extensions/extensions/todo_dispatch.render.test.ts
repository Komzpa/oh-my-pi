import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { slipReestimateRefusal } from "./todo_dispatch";

test("the collapsed Todo error card keeps the recovery action and row visible", async () => {
	const now = Date.now();
	const title = "Publish amber panel";
	const phases = [{ name: "Delivery", tasks: [{ content: title, status: "in_progress" as const, schedule: {
		owner: "PanelOwner", dependencies: [], reestimateCount: 2,
		estimate: { optimisticSeconds: 30, likelySeconds: 60, pessimisticSeconds: 90, confidence: "medium" as const, basis: "known remaining panel", updatedAt: now },
	} }] }];
	const reason = slipReestimateRefusal({ updates: [{ task: title, estimate: { likelySeconds: 120, updatedAt: now + 1 } }], rows: forecastTodoPlan(phases, { now }).rows, runningProfiles: new Map([["PanelOwner", "coder"]]), now });
	expect(reason).toBeDefined();
	const action = reason!.split("\n")[0]!;
	expect(action.length).toBeLessThanOrEqual(100);
	expect(action).toContain(title);
	expect(action).toContain("Kill PanelOwner");
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("dark theme unavailable");
	setThemeInstance(loaded);
	const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
	const component = new ToolExecutionComponent("todo", { op: "schedule" }, { showImages: false }, undefined, ui, process.cwd());
	component.updateResult({ content: [{ type: "text", text: reason! }], isError: true }, false);
	const lines = component.render(120).map(stripVTControlCharacters);
	expect(lines.some(line => line.includes(action))).toBe(true);
	expect(lines.every(line => Bun.stringWidth(line) <= 120)).toBe(true);
	console.log(lines.join("\n"));
});
