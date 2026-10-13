// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const DEFAULTS = {
	floorTokens: 150_000,
	ceilingTokens: 260_000,
	askStepTokens: 10_000,
	settledThreshold: 0.65,
	heavyThreshold: 0.7,
	fragileThreshold: 0.35,
	timeoutMs: 15_000,
} as const;

type TimingAction = "idle" | "ask" | "compact" | "hold";

export interface TimingVerdict {
	action: TimingAction;
	reason: string;
}

export interface TimingScores {
	settled: number;
	heavy: number;
	fragile: number;
}

export function compactionBand(tokens: number): TimingVerdict {
	if (!Number.isFinite(tokens) || tokens < DEFAULTS.floorTokens) {
		return { action: "idle", reason: "below-floor" };
	}
	if (tokens >= DEFAULTS.ceilingTokens) {
		return { action: "compact", reason: "ceiling" };
	}
	return { action: "ask", reason: "semantic-window" };
}

export function semanticVerdict(scores: TimingScores): TimingVerdict {
	if (scores.fragile >= DEFAULTS.fragileThreshold) {
		return { action: "hold", reason: `fragile:${scores.fragile.toFixed(2)}` };
	}
	if (scores.settled >= DEFAULTS.settledThreshold) {
		return { action: "compact", reason: `settled:${scores.settled.toFixed(2)}` };
	}
	if (scores.heavy >= DEFAULTS.heavyThreshold) {
		return { action: "compact", reason: `heavy:${scores.heavy.toFixed(2)}` };
	}
	return { action: "hold", reason: "mid-work" };
}

function textOf(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: unknown } => Boolean(part) && typeof part === "object" && "type" in part)
		.filter(part => part.type === "text" && typeof part.text === "string")
		.map(part => String(part.text))
		.join(" ");
}

export function conversationTail(messages: readonly unknown[]): string[] {
	return messages
		.filter(message => {
			if (!message || typeof message !== "object") return false;
			return ["user", "assistant"].includes(String((message as { role?: unknown }).role));
		})
		.map(message => `${String((message as { role?: unknown }).role)}: ${textOf(message).replace(/\s+/g, " ").trim().slice(0, 1_200)}`)
		.filter(line => !line.endsWith(": "))
		.slice(-12);
}

async function apiKey(): Promise<string> {
	const path = join(homedir(), ".local/share/tasks-loop/state/secrets/typesafe-reemxy.json");
	const parsed = JSON.parse(await readFile(path, "utf8")) as { api_key?: unknown };
	if (typeof parsed.api_key !== "string" || !parsed.api_key.trim()) throw new Error("missing TypeSafe key");
	return parsed.api_key;
}

export function systemOneEndpoint(): { url: string; model: string; local: boolean } {
	const url = process.env.SYSTEM_ONE_URL?.trim() || "http://127.0.0.1:18765/v1/systemone";
	const host = new URL(url).hostname;
	return {
		url,
		model: process.env.SYSTEM_ONE_MODEL?.trim() || (host === "127.0.0.1" || host === "localhost" ? "gemma4:12b" : "jev-latest"),
		local: host === "127.0.0.1" || host === "localhost" || host === "[::1]",
	};
}

function probability(answers: unknown, id: string): number {
	if (!answers || typeof answers !== "object") throw new Error("missing TypeSafe answers");
	const answer = (answers as Record<string, unknown>)[id];
	if (!answer || typeof answer !== "object") throw new Error(`missing TypeSafe answer: ${id}`);
	const value = (answer as { noul?: unknown }).noul;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`invalid TypeSafe answer: ${id}`);
	}
	return value;
}

async function askJev(state: Record<string, unknown>, signal?: AbortSignal): Promise<TimingScores> {
	const endpoint = systemOneEndpoint();
	const key = endpoint.local ? "" : await apiKey();
	const timeout = AbortSignal.timeout(DEFAULTS.timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(endpoint.url, {
		method: "POST",
		headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
		body: JSON.stringify({
			model: endpoint.model,
			state,
			questions: {
				work_settled: {
					type: "noul",
					instructions: "The user's latest request is finished and reported. Nothing is half-done, mid-edit, unverified, or waiting on another step.",
					criteria: { true: "clean stopping point", false: "work remains in flight" },
				},
				heavy_work_ahead: {
					type: "noul",
					instructions: "The next concrete work in this conversation is large enough that reclaiming context now materially reduces the risk of running out of room.",
					criteria: { true: "substantial work is lined up", false: "next work is small or unspecified" },
				},
				fragile_context: {
					type: "noul",
					instructions: "Important detail exists only in this transcript, not in a file, commit, note, task state, or other durable artifact, and compaction could lose it.",
					criteria: { true: "load-bearing detail is transcript-only", false: "important state is durable" },
				},
			},
		}),
		signal: combined,
	});
	if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
	const body = await response.json() as { answers?: unknown };
	return {
		settled: probability(body.answers, "work_settled"),
		heavy: probability(body.answers, "heavy_work_ahead"),
		fragile: probability(body.answers, "fragile_context"),
	};
}

function isSubagent(ctx: ExtensionContext): boolean {
	const header = ctx.sessionManager.getHeader();
	return header !== null && typeof header.parentSession === "string";
}

export default function jevCompactionTiming(pi: ExtensionAPI): void {
	let lastAskedTokens = 0;
	let compacting = false;

	pi.on("session_start", () => {
		lastAskedTokens = 0;
		compacting = false;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue || compacting || isSubagent(ctx)) return;
		const usage = ctx.getContextUsage();
		if (!usage || typeof usage.tokens !== "number") return;
		const band = compactionBand(usage.tokens);
		if (band.action === "idle") return;
		if (band.action === "ask" && lastAskedTokens > 0 && usage.tokens - lastAskedTokens < DEFAULTS.askStepTokens) return;

		let verdict = band;
		if (band.action === "ask") {
			lastAskedTokens = usage.tokens;
			try {
				verdict = semanticVerdict(await askJev({
					conversation: conversationTail(event.messages),
					tokens_in_context_now: usage.tokens,
					model_context_window_tokens: usage.contextWindow,
					asking_starts_at_tokens: DEFAULTS.floorTokens,
					compacted_without_asking_at_tokens: DEFAULTS.ceilingTokens,
					tokens_left_before_ceiling: Math.max(0, DEFAULTS.ceilingTokens - usage.tokens),
				}, undefined));
			} catch (error) {
				pi.logger.warn("OMP JEV compaction timing check failed open", {
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
		}
		if (verdict.action !== "compact") return;

		compacting = true;
		try {
			await ctx.compact({
				internalGuidance: "Preserve the active user objective, unfinished work, exact verification state, decisions, artifact paths, and next action. Remove superseded exploration and stale tool output.",
			});
			ctx.ui.notify(`JEV compacted context (${verdict.reason})`, "info");
		} catch (error) {
			pi.logger.warn("OMP JEV-requested compaction failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			compacting = false;
		}
	});
}
