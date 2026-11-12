import { expect, test, spyOn } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { todoToolRenderer } from "@oh-my-pi/pi-tui/tools/todo";
import { slipReestimateRefusal } from "./todo_dispatch";

test("the collapsed Todo error card keeps the recovery action and row visible", async () => {
	const now = Date.now();
	const title = "Publish amber panel";
	const phases = [
		{
			name: "Delivery",
			tasks: [
				{
					content: title,
					status: "in_progress" as const,
					schedule: {
						owner: "PanelOwner",
						dependencies: [],
						reestimateCount: 2,
						estimate: {
							optimisticSeconds: 30,
							likelySeconds: 60,
							pessimisticSeconds: 90,
							confidence: "medium" as const,
							basis: "known remaining panel",
							updatedAt: now,
						},
					},
				},
			],
		},
	];
	const reason = slipReestimateRefusal({
		updates: [{ task: title, estimate: { likelySeconds: 120, updatedAt: now + 1 } }],
		rows: forecastTodoPlan(phases, { now }).rows,
		runningProfiles: new Map([["PanelOwner", "coder"]]),
		now,
	});
	expect(reason).toBeDefined();
	const action = reason!.split("\n")[0]!;
	expect(action.length).toBeLessThanOrEqual(100);
	expect(action).toContain(title);
	expect(action).toContain("Split remainder");
	expect(reason).not.toContain("/kill");
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("dark theme unavailable");
	setThemeInstance(loaded);
	const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
	const component = new ToolExecutionComponent(
		"todo",
		{ op: "schedule" },
		{ showImages: false },
		undefined,
		ui,
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: reason! }], isError: true }, false);
	const lines = component.render(120).map(stripVTControlCharacters);
	expect(lines.some(line => line.includes(action))).toBe(true);
	expect(lines.every(line => Bun.stringWidth(line) <= 120)).toBe(true);
	console.log(lines.join("\n"));
});


test("accepted open rows render as closing without overdue error colour", async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("dark theme unavailable");
	const now = Date.now();
	const phases = [{ name: "Delivery", tasks: [{ content: "Accepted panel", status: "in_progress" as const, schedule: {
		review: "accepted" as const, reviewClosingBlocked: "QA pass missing", dependencies: [], startedAt: now - 3600000,
		estimate: { optimisticSeconds: 1, likelySeconds: 2, pessimisticSeconds: 3, confidence: "high" as const, basis: "panel receipt", updatedAt: now - 3600000 },
	} }] }];
	const colours: Array<{ colour: string; text: string }> = [];
	const original = loaded.fg.bind(loaded);
	const spy = spyOn(loaded, "fg").mockImplementation((colour, text) => {
		colours.push({ colour, text });
		return original(colour, text);
	});
	try {
		const card = todoToolRenderer.renderResult({ content: [], details: { op: "view", phases, storage: "memory", forecastAt: now } }, { expanded: true, isPartial: false }, loaded);
		const text = card.render(160).map(stripVTControlCharacters).join("\n");
		expect(text).toContain("accepted by user, closing blocked: QA pass missing");
		expect(text).not.toContain("overdue");
		expect(colours.filter(call => call.colour === "error" && (call.text.includes("Accepted panel") || call.text.includes("closing")))).toEqual([]);
	} finally { spy.mockRestore(); }
});

test("a two-minute successor can replan despite a legacy inherited cap", () => {
	const now = Date.now();
	const rows = forecastTodoPlan(
		[
			{
				name: "Work",
				tasks: [
					{
						content: "Adaptive levels",
						status: "in_progress",
						schedule: {
							owner: "Adaptive-7",
							reestimateCount: 4,
							dependencies: [],
							estimate: {
								optimisticSeconds: 30,
								likelySeconds: 60,
								pessimisticSeconds: 90,
								confidence: "medium",
								basis: "old attempt",
								updatedAt: now - 3600000,
							},
						},
					},
				],
			},
		],
		{ now },
	).rows;
	expect(
		slipReestimateRefusal({
			updates: [{ task: "Adaptive levels", estimate: { likelySeconds: 120 } }],
			rows,
			runningProfiles: new Map([["Adaptive-7", "ui-coder"]]),
			runningStartedAt: new Map([["Adaptive-7", now - 120000]]),
			now,
		}),
	).toBeUndefined();
});
