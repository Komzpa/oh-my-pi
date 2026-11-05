import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export type ReviewPageOpener = (url: string) => void;
export type ReviewPageStatus = (url: string, row?: string) => Promise<number>;

/** Resolve the published kit manifest, not just an unrelated HTTP 200 page. */
export const probeReviewPage: ReviewPageStatus = async (url, row) => {
	if (!URL.canParse(url)) return 400;
	const page = new URL(url);
	if (!["http:", "https:"].includes(page.protocol) || page.port !== "8767") return 400;
	const response = await fetch(page, { signal: AbortSignal.timeout(5000) });
	await response.body?.cancel();
	if (response.status !== 200) return response.status;
	page.hash = "";
	page.search = "";
	if (!page.pathname.endsWith("/")) page.pathname += "/";
	const manifest = await fetch(new URL("cards.json", page), { signal: AbortSignal.timeout(5000) });
	if (manifest.status !== 200) return manifest.status;
	const data = (await manifest.json()) as {
		cards?: Array<{ disposition?: { kind?: string }; landed?: string | { row?: string } }>;
	};
	return data.cards?.some(
		card =>
			card.disposition?.kind === "delivered-change" &&
			(typeof card.landed === "string"
				? card.landed.match(/(?:^|— )row: (.*)$/i)?.[1] === row
				: card.landed?.row === row),
	)
		? 200
		: 422;
};

/** Caller supplies the lead-only boundary. The set belongs to that lead session. */
export async function openReviewPages(
	phases: TodoScheduleInput,
	opened: Set<string>,
	probe: ReviewPageStatus = probeReviewPage,
	open: ReviewPageOpener = openPath,
): Promise<void> {
	for (const row of phases.flatMap(phase => phase.tasks)) {
		const url = row.schedule?.reviewPage;
		if (!url || !URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) continue;
		const key = url;
		if (opened.has(key)) continue;
		// Claim before awaiting so concurrent plan checks cannot launch two browsers.
		opened.add(key);
		try {
			if ((await probe(url, row.content)) === 200) open(url);
			else opened.delete(key);
		} catch {
			opened.delete(key);
		}
	}
}
