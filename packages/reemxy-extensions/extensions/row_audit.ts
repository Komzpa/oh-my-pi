import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type TodoRowAudit,
	type TodoScheduleInputTask,
	todoRowAfterWorker,
	todoRowDeliveryKey,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import brief from "./row-audit.md" with { type: "text" };

/** Concurrent audit batches per session, the same ceiling as the requirements auditor pool. */
export const ROW_AUDIT_CAP = 4;
/** A batch whose launch threw is not retried before this delay, so a missing agent cannot spin. */
export const ROW_AUDIT_RETRY_MS = 10 * 60_000;

export type RowAuditRow = TodoScheduleInputTask & { artifactCwd?: string };
export type RowAuditVerdict = { row: string; verdict: "pass" | "fail"; findings: string };
export interface RowAuditBatch {
	repoPath: string;
	head: string;
	rows: RowAuditRow[];
}

export function parseRowAuditVerdicts(output: unknown): RowAuditVerdict[] | undefined {
	let value = output;
	if (typeof value === "string") {
		const text = value.trim();
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start < 0 || end < start) return;
		try {
			value = JSON.parse(text.slice(start, end + 1));
		} catch {
			return;
		}
	}
	if (!value || typeof value !== "object" || !("rows" in value) || !Array.isArray(value.rows)) return;
	const verdicts: RowAuditVerdict[] = [];
	for (const item of value.rows) {
		if (!item || typeof item !== "object" || typeof item.row !== "string") return;
		if (item.verdict !== "pass" && item.verdict !== "fail") return;
		verdicts.push({
			row: item.row,
			verdict: item.verdict,
			findings: typeof item.findings === "string" ? item.findings : "",
		});
	}
	return verdicts;
}

function rowRepo(row: RowAuditRow, cwd: string): string {
	return row.artifactCwd ?? row.schedule?.executor?.gitCommits?.[0]?.repoPath ?? cwd;
}

/**
 * Delivered rows whose audit must be (re)launched, one batch per repository head. A row whose
 * pending audit already runs at the current head (`inFlight`) is skipped; a pending audit at an
 * older head, or one no longer running in this process, is audited again at the current head.
 */
export function planRowAudits(
	rows: readonly RowAuditRow[],
	heads: ReadonlyMap<string, string>,
	cwd: string,
	isLive: (row: RowAuditRow) => boolean,
	inFlight: (repoPath: string, head: string) => boolean,
): RowAuditBatch[] {
	const batches = new Map<string, RowAuditBatch>();
	for (const row of rows) {
		if (isLive(row)) continue;
		const after = todoRowAfterWorker(row);
		if (after?.kind !== "verify" || after.via !== "audit") continue;
		const repoPath = rowRepo(row, cwd);
		const head = heads.get(repoPath) ?? "unknown";
		if (after.audit?.verdict === "pass") continue;
		if (inFlight(repoPath, head)) continue;
		const key = JSON.stringify([repoPath, head]);
		const batch = batches.get(key) ?? { repoPath, head, rows: [] };
		batch.rows.push(row);
		batches.set(key, batch);
	}
	return [...batches.values()];
}

export function rowAuditTask(batch: RowAuditBatch): string {
	const rows = batch.rows
		.map(row =>
			[
				`- Row: ${JSON.stringify(row.content)}`,
				`  Delivered evidence: ${row.schedule?.progress?.evidence ?? "none recorded"}`,
				`  Worker output: agent://${row.schedule?.executor?.workerId ?? "unknown"}`,
			].join("\n"),
		)
		.join("\n");
	return prompt.render(brief, { root: batch.repoPath, head: batch.head, rows });
}

const execGit = (repoPath: string): Promise<string | undefined> =>
	new Promise(resolve => {
		execFile(
			"git",
			["rev-parse", "HEAD"],
			{ cwd: repoPath, encoding: "utf8", timeout: 5_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
			(error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
		);
	});

export interface RowAuditOptions {
	now?: () => number;
	readHead?: (repoPath: string) => Promise<string | undefined>;
	agent?: string;
}

/** In-flight batches survive extension reloads in this process; a new process relaunches each once. */
const inFlight = new Set<string>();
const failedAt = new Map<string, number>();

export function resetRowAuditsForTest(): void {
	inFlight.clear();
	failedAt.clear();
}

function auditAgent(): string {
	return existsSync(new URL("./agents/qa-auditor.md", import.meta.url)) ? "qa-auditor" : "gate-runner";
}

/**
 * Runtime-owned post-completion step: every delivered, unverified row is audited at its repository
 * head in batches (at most ROW_AUDIT_CAP at once). A pass closes the row through the schedule
 * callback; a fail records findings and returns the row to "needs worker". A head that moved while
 * the audit ran discards its verdicts and re-audits once at the new head.
 */
export async function checkRowAudits(ctx: ExtensionContext, options: RowAuditOptions = {}): Promise<number> {
	if (!ctx.runRowAudit || !ctx.getTodoPhases || !ctx.updateTodoSchedule) return 0;
	const now = options.now ?? Date.now;
	const readHead = options.readHead ?? execGit;
	const session = ctx.sessionManager.getHeader()?.id ?? "";
	const batchKey = (repoPath: string, head: string) => JSON.stringify([session, repoPath, head]);
	const rows = (ctx.getTodoPhases() ?? []).flatMap(phase => phase.tasks) as RowAuditRow[];
	const jobs = ctx.getAsyncJobSnapshot?.()?.running ?? [];
	const liveIds = new Set(jobs.flatMap(job => [job.id, job.agentId].filter((id): id is string => !!id)));
	const isLive = (row: RowAuditRow) =>
		[row.schedule?.owner, row.schedule?.executor?.workerId].some(id => typeof id === "string" && liveIds.has(id));
	const candidates = rows.filter(row => {
		const after = isLive(row) ? undefined : todoRowAfterWorker(row);
		return after?.kind === "verify" && after.via === "audit";
	});
	if (!candidates.length) return 0;
	const heads = new Map<string, string>();
	for (const repoPath of new Set(candidates.map(row => rowRepo(row, ctx.cwd))))
		heads.set(repoPath, (await readHead(repoPath)) ?? "unknown");
	const busy = (repoPath: string, head: string) => {
		const key = batchKey(repoPath, head);
		return inFlight.has(key) || now() - (failedAt.get(key) ?? -Infinity) < ROW_AUDIT_RETRY_MS;
	};
	const running = () => [...inFlight].filter(key => key.startsWith(`[${JSON.stringify(session)},`)).length;
	const agent = options.agent ?? auditAgent();
	let launched = 0;
	for (const batch of planRowAudits(candidates, heads, ctx.cwd, isLive, busy)) {
		if (running() >= ROW_AUDIT_CAP) break;
		const key = batchKey(batch.repoPath, batch.head);
		const startedAt = now();
		const records = new Map<string, TodoRowAudit>();
		for (const row of batch.rows) {
			const audit: TodoRowAudit = {
				delivery: todoRowDeliveryKey(row.schedule),
				repoPath: batch.repoPath,
				head: batch.head,
				startedAt,
				verdict: "pending",
				agent,
			};
			// Persist before launching: a resumed session sees the pending audit, never a bare delivery.
			if (ctx.updateTodoSchedule(row.content, { audit })) records.set(row.content, audit);
		}
		if (!records.size) continue;
		inFlight.add(key);
		launched++;
		void (async () => {
			try {
				const result = await ctx.runRowAudit!(rowAuditTask(batch), agent);
				const details = result?.details as { results?: Array<{ output?: unknown }> } | undefined;
				const verdicts = parseRowAuditVerdicts(details?.results?.[0]?.output) ?? [];
				const head = (await readHead(batch.repoPath)) ?? "unknown";
				// A moved head makes these verdicts stale; the next check audits once at the new head.
				if (head !== batch.head) return;
				const latest = (ctx.getTodoPhases?.() ?? []).flatMap(phase => phase.tasks);
				for (const [content, audit] of records) {
					const row = latest.find(candidate => candidate.content === content);
					const current = row?.schedule?.audit;
					if (
						!row ||
						current?.delivery !== audit.delivery ||
						current.head !== audit.head ||
						current.startedAt !== audit.startedAt
					)
						continue;
					const verdict = verdicts.find(item => item.row === content);
					const at = now();
					const findings = verdict?.findings.trim() || (verdict ? "" : "auditor returned no verdict for this row");
					const pass = verdict?.verdict === "pass";
					ctx.updateTodoSchedule!(content, {
						audit: { ...audit, verdict: pass ? "pass" : "fail", findings, at },
						progress: {
							at,
							evidence: `audit ${pass ? "pass" : "fail"} at ${batch.head.slice(0, 12)}${findings ? `: ${findings}` : ""}`,
						},
					});
				}
			} catch (error) {
				failedAt.set(key, now());
				logger.warn("Row audit did not run", { repo: batch.repoPath, head: batch.head, error: String(error) });
			} finally {
				inFlight.delete(key);
			}
		})();
	}
	return launched;
}
