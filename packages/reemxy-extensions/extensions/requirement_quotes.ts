import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { selectBranchEntries, selectLatestBranchEntry } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { TodoScheduleInputTask } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import brief from "./requirement-quotes.md" with { type: "text" };

export interface RequirementQuote {
	id: string;
	quote: string;
}

export function rowRequirementQuotes(ctx: ExtensionContext, row: string, entries?: readonly SessionEntry[]): RequirementQuote[] {
	if (!ctx.sessionManager.getBranch) return [];
	const entry = entries ? entries.findLast(entry => entry.type === "custom" && entry.customType === "requirements_ledger") : selectLatestBranchEntry(
		ctx.sessionManager,
		m => m.type === "custom" && m.customType === "requirements_ledger",
	);
	const data = entry && "data" in entry && isRecord(entry.data) ? entry.data : {};
	const items = Array.isArray(data.requirements) ? data.requirements : [];
	return items.flatMap(item => {
		if (
			!isRecord(item) ||
			!Array.isArray(item.rows) ||
			!item.rows.includes(row) ||
			item.classification === "not-a-requirement"
		)
			return [];
		// rawText is the ledger's original user input, never its synthesized requirement text.
		return typeof item.rawText === "string" && item.rawText.trim()
			? [{ id: String(item.id ?? ""), quote: item.rawText }]
			: [];
	});
}

export function editsRequirements(row: TodoScheduleInputTask): boolean {
	return /\bPRD\b|product[- ]requirements|requirements? (?:doc|document|rewrite|edit)/i.test(
		[row.content, ...(row.schedule?.resources ?? [])].join("\n"),
	);
}

export function requirementConflict(row: TodoScheduleInputTask): string | undefined {
	const evidence = [
		row.blocker,
		row.schedule?.progress?.evidence,
		row.schedule?.audit?.findings,
		row.schedule?.attemptHistory?.at(-1)?.finalReportParagraph,
	]
		.filter(Boolean)
		.join("\n");
	return evidence.includes("BLOCKED_BY_CONFLICTING_PRODUCT_CONTRACT") ? evidence : undefined;
}

/** A fresh successful resolution tool receipt is required; row prose cannot clear the conflict. */
export function prepareRequirementBrief(
	row: TodoScheduleInputTask,
	ctx: ExtensionContext,
	task: string,
): { task: string; refusal?: string } {
	const quotes = rowRequirementQuotes(ctx, row.content);
	const conflict = requirementConflict(row);
	const resolution = selectBranchEntries(
		ctx.sessionManager,
		m => m.type === "custom" && m.customType === "requirement-contract-resolution",
	).findLast(entry => "data" in entry && isRecord(entry.data) && entry.data.row === row.content);
	const record = resolution && "data" in resolution && isRecord(resolution.data) ? resolution.data : {};
	const resolved =
		record.row === row.content &&
		record.conflict === conflict &&
		record.quotes === JSON.stringify(quotes) &&
		typeof record.resolution === "string" &&
		record.resolution.trim();
	const missing = editsRequirements(row) && quotes.length === 0;
	const content = prompt
		.render(brief, {
			row: row.content,
			quotes: quotes.map(q => `${q.id}: ${JSON.stringify(q.quote)}`),
			missing,
			conflict: Boolean(conflict && !resolved),
			resolution: resolved ? record.resolution : undefined,
		})
		.trim();
	if (missing || (conflict && !resolved)) return { task, refusal: content };
	return {
		task: editsRequirements(row) || conflict ? `${task}\n\n${content}` : task,
	};
}

export function installRequirementResolution(pi: ExtensionAPI): void {
	if (!pi.typebox || !pi.registerTool) return;
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "resolve_requirement_conflict",
		label: "Resolve requirement conflict",
		approval: "write",
		loadMode: "essential",
		description:
			"Resolve a worker product contract conflict from verbatim linked user quotes. If they do not settle it, ask the owner through ask first. Does not authorize a wider requirement.",
		parameters: Type.Object({ row: Type.String(), quoteIds: Type.Array(Type.String()), resolution: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			if (ctx.sessionManager.getHeader()?.parentSession)
				throw new Error("Only the lead can resolve a requirement conflict");
			const row = (ctx.getTodoSnapshot?.() ?? ctx.getTodoPhases?.())
				?.flatMap(p => p.tasks)
				.find(r => r.content === params.row);
			if (!row) throw new Error("Unknown row");
			const conflict = requirementConflict(row);
			const quotes = rowRequirementQuotes(ctx, row.content);
			if (
				!conflict ||
				!quotes.length ||
				!params.resolution.trim() ||
				!params.quoteIds.length ||
				params.quoteIds.some(id => !quotes.some(q => q.id === id))
			)
				throw new Error(
					"An active conflict, exact linked quote IDs and a concrete resolution are required; otherwise ask the owner",
				);
			pi.appendEntry("requirement-contract-resolution", {
				row: row.content,
				conflict,
				quotes: JSON.stringify(quotes),
				resolution: params.resolution,
				at: Date.now(),
			});
			return {
				content: [{ type: "text", text: JSON.stringify({ row: row.content, resolution: params.resolution }) }],
			};
		},
	});
}
