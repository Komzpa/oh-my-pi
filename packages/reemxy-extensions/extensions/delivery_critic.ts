import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import brief from "./delivery-critic.md" with { type: "text" };

export const CRITIC_TIMEOUT_MS = 15 * 60_000;
type Finding = { kind: "collateral_defect" | "requirement_violation" | "contradicts_decision"; evidence: string };
export type DeliveryVerdict = { verdict: "clean" | "defects"; findings: Finding[] };
export type DeliveryRow = { content: string; artifactCwd?: string; schedule?: TodoSchedule };

export function parseDeliveryVerdict(output: unknown): DeliveryVerdict | undefined {
	let value = output;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return;
		}
	}
	if (
		!value ||
		typeof value !== "object" ||
		!("verdict" in value) ||
		!("findings" in value) ||
		!Array.isArray(value.findings)
	)
		return;
	if (value.verdict !== "clean" && value.verdict !== "defects") return;
	const findings: Finding[] = [];
	for (const finding of value.findings) {
		if (
			!finding ||
			typeof finding !== "object" ||
			!["collateral_defect", "requirement_violation", "contradicts_decision"].includes(finding.kind) ||
			typeof finding.evidence !== "string" ||
			!finding.evidence.trim()
		)
			return;
		findings.push(finding);
	}
	if ((value.verdict === "clean") !== (findings.length === 0)) return;
	return { verdict: value.verdict, findings };
}

/** Pre-batch compatibility ledger: predict --kind delivery currently requires a published card. */
export async function recordDeliveryVerdict(
	row: DeliveryRow,
	verdict: DeliveryVerdict,
	file = "/home/kom/Dropbox/Reemxy/tasks-loop/memory/user-shadow/predictions.jsonl",
): Promise<void> {
	const entry = {
		id: row.schedule?.deliveryCritic?.key,
		kind: "delivery",
		page: "",
		card: row.content,
		content_sha: row.schedule?.deliveryCritic?.key,
		choice: verdict.verdict === "clean" ? "accept" : "redo",
		confidence: 1,
		why: verdict.verdict,
		precedents: [],
		complaints: [],
		question: "valid",
		question_evidence: null,
		conditions: [],
		findings: verdict.findings.map(finding => ({ ...finding, text: finding.evidence })),
		landed: {
			row: row.content,
			commits: row.schedule?.executor?.gitCommits ?? [],
			preview: row.schedule?.reviewPage,
		},
		verdict: verdict.verdict,
		by: "omp-user-shadow",
		at: new Date().toISOString(),
	};
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, `${JSON.stringify(entry)}\n`);
}

/** Persist before launching; duplicate events and resumed sessions cannot launch a second critic. */
const armed = new Set<string>();
export function resetDeliveryCriticTimers(ctx: ExtensionContext): void {
	const prefix = `${ctx.sessionManager.getHeader()?.id}:`;
	for (const key of armed) if (key.startsWith(prefix)) armed.delete(key);
}

const attemptKey = (schedule: TodoSchedule) =>
	JSON.stringify([schedule.executor?.workerId, schedule.executor?.startedAt, schedule.executor?.finishedAt]);

export function queueDeliveryCritic(
	ctx: ExtensionContext,
	row: DeliveryRow,
	receipt = "",
	record = recordDeliveryVerdict,
	now = Date.now(),
	previewPath?: string,
): boolean {
	const schedule = row.schedule ?? {};
	const attempt = schedule.executor;
	const commits = attempt?.gitCommits ?? [];
	const preview = previewPath ?? schedule.reviewPage ?? "";
	if (attempt?.outcome !== "completed" || (!commits.length && !preview)) return false;
	const key = attemptKey(schedule);
	const existing = schedule.deliveryCritic?.key === key ? schedule.deliveryCritic : undefined;
	if (existing && (existing.verdict !== "pending" || existing.timedOut)) return true;
	const state = existing ?? { key, startedAt: now, verdict: "pending" as const };
	const timerKey = `${ctx.sessionManager.getHeader()?.id}:${row.content}:${key}`;
	if (armed.has(timerKey)) return true;
	if (
		!existing &&
		!ctx.updateTodoSchedule?.(row.content, { deliveryCritic: state, handoffPending: false, review: undefined })
	)
		return false;
	armed.add(timerKey);
	const current = () =>
		ctx
			.getTodoPhases?.()
			?.flatMap(phase => phase.tasks)
			.find(candidate => candidate.content === row.content);
	const timer = ctx.setTimeout(
		() => {
			const latest = current();
			if (
				latest?.schedule?.deliveryCritic?.key !== key ||
				attemptKey(latest.schedule) !== key ||
				latest.schedule.deliveryCritic.verdict !== "pending"
			)
				return;
			ctx.updateTodoSchedule?.(row.content, {
				deliveryCritic: { ...state, timedOut: true },
				handoffPending: true,
				review: "user",
				firstDeliveredAt: Date.now(),
			});
		},
		Math.max(0, state.startedAt + CRITIC_TIMEOUT_MS - now),
	);
	if (existing) return true;
	const task = prompt.render(brief, {
		request: row.content,
		root: row.artifactCwd ?? commits[0]?.repoPath ?? ctx.cwd,
		commits: JSON.stringify(commits),
		preview,
		receipt,
	});
	// The role is blocking inside the native task call; the delivery hook never awaits it.
	void (async () => {
		try {
			const result = await ctx.runDeliveryCritic?.(task);
			const details = result?.details as { results?: Array<{ output?: unknown }> } | undefined;
			const verdict = parseDeliveryVerdict(details?.results?.[0]?.output);
			if (!verdict) return;
			await record({ ...row, schedule: { ...schedule, deliveryCritic: state } }, verdict).catch(error => {
				logger.error("Delivery critic verdict ledger failed", { row: row.content, error: String(error) });
			});
			const latest = current();
			if (latest?.schedule?.deliveryCritic?.key !== key || attemptKey(latest.schedule) !== key) return;
			const evidence = verdict.findings.map(finding => `${finding.kind}: ${finding.evidence}`).join("\n");
			ctx.updateTodoSchedule?.(row.content, {
				deliveryCritic: { ...state, verdict: verdict.verdict, evidence },
				handoffPending: verdict.verdict === "clean",
				review: verdict.verdict === "clean" ? "user" : "redo",
				...(verdict.verdict === "defects"
					? { progress: { at: Date.now(), evidence } }
					: { firstDeliveredAt: Date.now() }),
			});
			ctx.clearTimer(timer);
		} catch (error) {
			logger.warn("Delivery critic pending until handoff timeout", { row: row.content, error: String(error) });
		}
	})();
	return true;
}
