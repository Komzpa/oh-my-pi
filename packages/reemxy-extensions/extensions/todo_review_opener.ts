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

interface ReviewCard {
	id?: string;
	content_sha?: string;
	disposition?: { kind?: string };
	landed?: string | { row?: string };
}

/** Only current delivered cards for this row can request another decision. */
export async function pendingReviewVersion(url: string, row: string): Promise<string | undefined> {
	const page = new URL(url);
	page.hash = "";
	page.search = "";
	if (!page.pathname.endsWith("/")) page.pathname += "/";
	const manifest = await fetch(new URL("cards.json", page), { signal: AbortSignal.timeout(5000) });
	if (!manifest.ok) return;
	const data = (await manifest.json()) as { cards?: ReviewCard[] };
	const cards = data.cards?.filter(
		card =>
			card.disposition?.kind === "delivered-change" &&
			(typeof card.landed === "string"
				? card.landed.match(/(?:^|— )row: (.*)$/i)?.[1] === row
				: card.landed?.row === row),
	);
	if (!cards?.length) return;
	// Older manifests put the current content hash on the rendered card only.
	if (cards.some(card => !card.content_sha)) {
		const html = await fetch(page, { signal: AbortSignal.timeout(5000) });
		if (!html.ok) return;
		await new HTMLRewriter()
			.on("[data-id][data-sha]", {
				element(element) {
					const card = cards.find(card => card.id === element.getAttribute("data-id"));
					if (card && !card.content_sha) card.content_sha = element.getAttribute("data-sha") ?? undefined;
				},
			})
			.transform(html)
			.text();
	}
	const response = await fetch(new URL("answers.json", page), { signal: AbortSignal.timeout(5000) });
	if (!response.ok && response.status !== 404) return;
	const answers = response.ok
		? ((await response.json()) as Record<string, { answer?: string; content_sha?: string }>)
		: {};
	if (
		cards.every(card => {
			const answer = card.id ? answers[card.id] : undefined;
			return !!answer?.answer && (!card.content_sha || answer.content_sha === card.content_sha);
		})
	)
		return;
	return JSON.stringify(
		cards.map(card => [card.id, card.content_sha ?? Bun.hash(JSON.stringify(card)).toString()]).sort(),
	);
}

/** Caller supplies the lead-only boundary and durable claims from the session branch. */
export async function openReviewPages(
	phases: TodoScheduleInput,
	opened: Set<string>,
	probe: ReviewPageStatus = probeReviewPage,
	open: ReviewPageOpener = openPath,
	persist: (key: string) => void = () => {},
): Promise<void> {
	for (const row of phases.flatMap(phase => phase.tasks)) {
		const url = row.schedule?.reviewPage;
		if (
			row.status === "completed" ||
			row.status === "abandoned" ||
			row.schedule?.review !== "user" ||
			row.schedule.handoffPending === false
		)
			continue;
		if (!url || !URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) continue;
		const pending = `pending:${url}`;
		if (opened.has(pending)) continue;
		// Keep a URL claim across all awaits, including the browser launch.
		opened.add(pending);
		try {
			if ((await probe(url, row.content)) !== 200) continue;
			const current = await pendingReviewVersion(url, row.content);
			if (current === undefined) continue;
			const key = JSON.stringify([url, row.content, current]);
			if (opened.has(key)) continue;
			persist(key);
			opened.add(key);
			open(url);
		} catch {
			// Retry unreachable pages on a later check.
		} finally {
			opened.delete(pending);
		}
	}
}
