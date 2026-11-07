import { expect, test } from "bun:test";
import { chiefFixNow, type ChiefDefect } from "./fix_now";

test("large live-shaped open-defect snapshot is ranked, deduped and bounded on both delivery surfaces", () => {
	const defects: ChiefDefect[] = [
		{ row: "Cooling", action: "Staff", severity: 1 },
		{ row: "Power", action: "Repair refused staffing for", severity: 2 },
		{ row: "Push branch", action: "Push", severity: 2 },
		{ row: "Frame", action: "Staff", severity: 3 },
		...Array.from({ length: 12 }, (_, i) => ({
			row: `Audit ${i}: ${"long title ".repeat(12)}`,
			action: "Audit",
			severity: 4,
		})),
		{ row: "Cooling", action: "Staff", severity: 3 },
	];
	for (const supervisor of [false, true]) {
		const rendered = chiefFixNow({ main: true, defects }, supervisor);
		expect(rendered.length).toBeLessThanOrEqual(400);
		const items = rendered.split("FIX NOW: ")[1]!.split(/; \d\. /);
		expect(items).toHaveLength(5);
		for (const item of items) expect(item.replace(/^1\. /, "").length).toBeLessThanOrEqual(70);
		expect(rendered.indexOf("Cooling")).toBeLessThan(rendered.indexOf("Power"));
		expect(rendered.match(/Cooling/g)).toHaveLength(1);
		expect(rendered).not.toMatch(/authoriz|approv|permission/i);
	}
	expect(chiefFixNow({ main: true, defects: [] })).toBe("");
	expect(chiefFixNow({ main: false, defects })).toBe("");
});
