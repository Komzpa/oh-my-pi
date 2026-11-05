import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export type ReviewPageOpener = (url: string) => void;
export type ReviewPageStatus = (url: string) => Promise<number>;

/** Caller supplies the lead-only boundary. The set belongs to that lead session. */
export async function openReviewPages(
	phases: TodoScheduleInput,
	opened: Set<string>,
	probe: ReviewPageStatus = async url => {
		const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
		await response.body?.cancel();
		return response.status;
	},
	open: ReviewPageOpener = openPath,
): Promise<void> {
	for (const row of phases.flatMap(phase => phase.tasks)) {
		const url = row.schedule?.reviewPage;
		if (!url || !URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) continue;
		const key = `${row.content}\0${url}`;
		if (opened.has(key)) continue;
		// Claim before awaiting so concurrent plan checks cannot launch two browsers.
		opened.add(key);
		try {
			if (await probe(url) === 200) open(url);
			else opened.delete(key);
		} catch {
			opened.delete(key);
		}
	}
}
