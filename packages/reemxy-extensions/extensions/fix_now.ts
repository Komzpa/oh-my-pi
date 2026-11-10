import { prompt } from "@oh-my-pi/pi-utils";
import instructions from "./fix-now.md" with { type: "text" };

export interface ChiefDefect {
	row: string;
	action: string;
	severity: number;
	detail?: string;
	call?: { name: string; arguments: Record<string, unknown> };
	identity?: string;
}
export interface ChiefDefectState {
	main: boolean;
	defects: readonly ChiefDefect[];
}
export function fixNowIdentity(defects: readonly ChiefDefect[]): string {
	return JSON.stringify(
		defects
			.filter(d => d.call)
			.map(d => d.identity ?? JSON.stringify(d.call))
			.sort(),
	);
}
/** Only executable calls ship. Never truncate arguments or identifiers. */
export function chiefFixNow(state: ChiefDefectState, supervisor = false): string {
	if (!state.main) return "";
	const seen = new Set<string>();
	const items = [...state.defects]
		.sort((a, b) => a.severity - b.severity)
		.flatMap(d => {
			if (!d.call) return [];
			const key = d.identity ?? JSON.stringify(d.call);
			if (seen.has(key)) return [];
			seen.add(key);
			return [`${d.call.name} ${JSON.stringify(d.call.arguments)}`];
		})
		.slice(0, 5);
	return items.length
		? prompt
				.render(instructions, { supervisor, items: items.map((item, i) => `${i + 1}. ${item}`).join("; ") })
				.trim()
		: "";
}
export function withChiefFixNow(content: string, block: string): string {
	const clean = content.replace(/\n\nFIX NOW: [\s\S]*$/, "");
	return block ? `${clean}\n\n${block}` : clean;
}

/** Pre-provenance runtimes stored this exact generated list as its own text part. */
export function isLegacyFixNow(text: string): boolean {
	return /^FIX NOW: 1\. Plan late \d+m: cut\/split\/parallelize or ask owner(?:; [2-5]\. [^\n]*)?$/.test(text);
}
