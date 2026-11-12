import type { ReviewPageAnswer } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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
	title?: string;
	content?: string;
	id?: string;
	content_sha?: string;
	disposition?: { kind?: string };
	landed?: string | { row?: string };
}

/** Match the recorded slug first; legacy cards must name the exact row uniquely. */
function matchingCards(cards: ReviewCard[], row: string, cardId?: string): ReviewCard[] {
	return cards.filter(card =>
		cardId
			? card.id === cardId
			: card.title === row ||
				card.content === row ||
				(typeof card.landed === "string"
					? card.landed.match(/(?:^|— )row: (.*)$/i)?.[1] === row
					: card.landed?.row === row),
	);
}

async function readReviewPage(url: string, timeoutMs = 3000) {
	const page = new URL(url);
	if (!["http:", "https:"].includes(page.protocol)) return;
	page.hash = "";
	page.search = "";
	if (!page.pathname.endsWith("/")) page.pathname += "/";
	// One deadline includes response bodies and the legacy HTML hash lookup.
	const signal = AbortSignal.timeout(timeoutMs);
	const manifest = await fetch(new URL("cards.json", page), { signal });
	if (!manifest.ok) return;
	const data = (await manifest.json()) as { cards?: ReviewCard[] };
	if (!Array.isArray(data.cards)) return;
	const cards = data.cards;
	if (cards.some(card => !card.content_sha)) {
		const html = await fetch(page, { signal });
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
	const response = await fetch(new URL("api/answers", page), { signal, cache: "no-store" });
	if (!response.ok) return;
	const answers = (await response.json()) as Record<
		string,
		{ answer?: string; content_sha?: string; note?: string } | string
	>;
	return { cards, answers };
}

/** Only current delivered cards for this row can request another decision. */
export async function pendingReviewVersion(url: string, row: string): Promise<string | undefined> {
	const data = await readReviewPage(url);
	if (!data) return;
	const cards = matchingCards(data.cards, row);
	if (!cards.length) return;
	if (
		cards.every(card => {
			const answer = card.id ? data.answers[card.id] : undefined;
			return (
				typeof answer === "object" && answer?.answer && card.content_sha && answer.content_sha === card.content_sha
			);
		})
	)
		return;
	return JSON.stringify(
		cards.map(card => [card.id, card.content_sha ?? Bun.hash(JSON.stringify(card)).toString()]).sort(),
	);
}

/** Existing review-page owner: poll off the render path; receipts live with native TODO rows. */
export class ReviewAnswerPoller {
	#pending?: Promise<void>;
	#lastPoll = 0;
	#stale = new Set<string>();

	poll(
		ctx: Pick<ExtensionContext, "getTodoPhases" | "applyReviewPageAnswer">,
		stale: (row: string, card: string) => void = () => {},
		force = false,
		timeoutMs = 3000,
	): Promise<void> {
		if (!ctx.applyReviewPageAnswer) return Promise.resolve();
		if (this.#pending) return this.#pending;
		if (!force && Date.now() - this.#lastPoll < 45_000) return Promise.resolve();
		this.#lastPoll = Date.now();
		this.#pending = this.#poll(ctx, stale, timeoutMs).finally(() => {
			this.#pending = undefined;
		});
		return this.#pending;
	}

	async #poll(
		ctx: Pick<ExtensionContext, "getTodoPhases" | "applyReviewPageAnswer">,
		stale: (row: string, card: string) => void,
		timeoutMs: number,
	): Promise<void> {
		const rows = (ctx.getTodoPhases?.() ?? [])
			.flatMap(phase => phase.tasks)
			.filter(
				row =>
					row.status !== "abandoned" &&
					row.schedule?.review === "user" &&
					row.schedule.reviewPage &&
					URL.canParse(row.schedule.reviewPage) &&
					["http:", "https:"].includes(new URL(row.schedule.reviewPage).protocol),
			);
		const urls = [...new Set(rows.map(row => row.schedule!.reviewPage!))];
		let applying = Promise.resolve();
		// Four pages at a time; one request chain per page, never per row.
		for (let offset = 0; offset < urls.length; offset += 4) {
			await Promise.all(
				urls.slice(offset, offset + 4).map(async url => {
					try {
						const data = await readReviewPage(url, timeoutMs);
						if (!data) return;
						for (const row of rows.filter(row => row.schedule!.reviewPage === url)) {
							const cards = matchingCards(data.cards, row.content, row.schedule?.reviewCard);
							if (cards.length !== 1 || !cards[0].id) continue;
							const card = cards[0];
							// A legacy card must not map to two rows.
							if (
								rows.filter(
									other =>
										other.schedule?.reviewPage === url &&
										matchingCards([card], other.content, other.schedule?.reviewCard).length,
								).length !== 1
							)
								continue;
							const answer = data.answers[card.id!];
							if (typeof answer !== "object" || !answer) continue;
							if (answer.answer !== "accept" && answer.answer !== "redo" && answer.answer !== "drop") continue;
							if (!card.content_sha || card.content_sha !== answer.content_sha) {
								const key = JSON.stringify([url, card.id, card.content_sha, answer]);
								if (!this.#stale.has(key)) {
									stale(row.content, card.id!);
									this.#stale.add(key);
								}
								continue;
							}
							const decision: ReviewPageAnswer = {
								task: row.content,
								page: url,
								card: card.id!,
								contentSha: card.content_sha,
								answer: answer.answer,
								note: answer.note ?? "",
								at: typeof data.answers.updatedAt === "string" ? data.answers.updatedAt : "unknown",
							};
							applying = applying
								.catch(() => {})
								.then(async () => {
									await ctx.applyReviewPageAnswer?.(decision);
								});
							await applying;
						}
					} catch {
						// Network, malformed data and timeouts mean no answer yet.
					}
				}),
			);
		}
	}
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
