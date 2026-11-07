import { chiefFixNow, fixNowQuestion } from "./fix_now";
import { harness } from "./fix-now.fixture";
export async function fixNowScenarios() {
	const scenarios = [];
	for (const kind of ["late", "churn"] as const) {
		const defect = fixNowQuestion(kind, kind === "churn" ? "Keep accepted label layout" : "", `${kind}:fixture`);
		scenarios.push({
			id: `fix-now-${kind}`,
			context: chiefFixNow({ main: true, defects: [defect] }, true),
			expected: { tool: defect.call!.name, args: defect.call!.arguments },
		});
	}
	const h = await harness([
		{
			content: "Keep accepted label layout",
			status: "pending",
			schedule: { dependencies: [], estimateMinutes: 10, reestimateCount: 3 },
		},
	]);
	const messages = Array.from({ length: 3 }, () => ({
		role: "toolResult",
		content: [
			{ type: "text", text: "receipt" },
			{ type: "text", text: "FIX NOW: old", harnessNotice: true },
		],
	}));
	const shaped = await h.hooks.get("context")({ messages }, h.ctx);
	scenarios.push({
		id: "fix-now-repeated",
		context: JSON.stringify(shaped.messages),
		expected: { tool: "ask", args: fixNowQuestion("churn", "Keep accepted label layout", "fixture").call!.arguments },
	});
	scenarios.push({
		id: "reply-then-wait",
		context:
			"User: wait for SpawnProbe result, then print it. SpawnProbe is running; no plan is needed.\nHarness (not Darafei): Reply in text to the user before wait/stop. Text alongside the wait tool call is accepted. Then call wait for the running result.",
		expected: { tool: "wait", args: {} },
	});
	return scenarios;
}
