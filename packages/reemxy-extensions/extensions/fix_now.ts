import { prompt } from "@oh-my-pi/pi-utils";
import instructions from "./fix-now.md" with { type: "text" };

export interface ChiefDefect {
	row: string;
	action: string;
	severity: number;
	detail?: string;
}
export interface ChiefDefectState {
	main: boolean;
	defects: readonly ChiefDefect[];
}
const bound = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Project already-derived gate facts, never infer task status from notice prose. */
export function chiefFixNow(state: ChiefDefectState, supervisor = false): string {
	if (!state.main) return "";
	const seen = new Set<string>();
	const items = [...state.defects]
		.sort((a, b) => a.severity - b.severity)
		.flatMap(defect => {
			const key = defect.row || defect.action;
			if (seen.has(key)) return [];
			seen.add(key);
			const row = defect.row.replace(/[\r\n\t]+/g, " ");
			const suffix = defect.detail ? ` (${defect.detail})` : "";
			return [
				bound(
					`${defect.action}${row ? ` «${bound(row, Math.max(8, 68 - defect.action.length - suffix.length))}»` : ""}${suffix}`,
					70,
				),
			];
		})
		.slice(0, 5);
	if (!items.length) return "";
	// Number outside the template index: Handlebars indices start at zero.
	const numbered = items.map((item, index) => `${index + 1}. ${item}`).join("; ");
	return bound(prompt.render(instructions, { supervisor, items: numbered }).trim(), 400);
}

export function withChiefFixNow(content: string, block: string): string {
	const clean = content.replace(/\n\nFIX NOW: [\s\S]*$/, "");
	return block ? `${clean}\n\n${block}` : clean;
}
