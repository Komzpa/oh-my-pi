import { expect, test } from "bun:test";
import { chiefFixNow, fixNowIdentity, fixNowQuestion } from "./fix_now";
import { AskTool } from "../../coding-agent/src/tools/ask";
import { validateToolCall } from "@oh-my-pi/pi-ai/utils/validation";
import { decideGateCall } from "./todo_dispatch";
test("late and churn notices contain complete schema-valid executable remedies, vague items are dropped", () => {
	const defects = [
		fixNowQuestion("late", "", "late:deadline"),
		fixNowQuestion("churn", "Cooling trunks", "churn:Cooling trunks"),
	];
	const ask = new AskTool({} as never);
	for (const d of defects) {
		const call = { ...d.call!, id: "probe", type: "toolCall" as const };
		expect(validateToolCall([ask], call)).toEqual(call.arguments);
		expect(decideGateCall(call, [{ id: "unrelated", remedy: "todo", satisfies: () => false }]).allowed).toBe(true);
	}
	const rendered = chiefFixNow(
		{ main: true, defects: [...defects, { row: "X", action: "Break churn", severity: 0 }] },
		true,
	);
	expect(rendered).toContain(JSON.stringify(defects[1]!.call!.arguments));
	expect(rendered).not.toContain("Break churn");
	expect(fixNowIdentity(defects)).toBe(fixNowIdentity([...defects].reverse()));
	expect(chiefFixNow({ main: false, defects })).toBe("");
});
