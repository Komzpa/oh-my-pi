import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { selectLatestBranchEntry } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	TODO_ROW_AUDITOR,
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
export type RowAuditCheck = { command: string; exitCode: number };
export type RowAuditScreenshot = { path: string; width?: number };
export type RowAuditVerdict = {
	row: string;
	verdict: "pass" | "fail" | "inconclusive";
	findings: string;
	checks: RowAuditCheck[];
	screenshots: RowAuditScreenshot[];
};
export interface RowAuditBatch {
	repoPath: string;
	head: string;
	rows: Array<RowAuditRow & { attempt: number; retry?: string }>;
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
	// A yield tool wraps its payload in `data`.
	if (value && typeof value === "object" && "data" in value && !("rows" in value)) value = value.data;
	if (!value || typeof value !== "object" || !("rows" in value) || !Array.isArray(value.rows)) return;
	const verdicts: RowAuditVerdict[] = [];
	for (const item of value.rows) {
		if (!item || typeof item !== "object" || typeof item.row !== "string") return;
		if (item.verdict !== "pass" && item.verdict !== "fail" && item.verdict !== "inconclusive") return;
		verdicts.push({
			row: item.row,
			verdict: item.verdict,
			findings: typeof item.findings === "string" ? item.findings.trim() : "",
			checks: (Array.isArray(item.checks) ? item.checks : []).filter(
				(check: unknown): check is RowAuditCheck =>
					!!check &&
					typeof check === "object" &&
					typeof (check as RowAuditCheck).command === "string" &&
					typeof (check as RowAuditCheck).exitCode === "number",
			),
			screenshots: (Array.isArray(item.screenshots) ? item.screenshots : []).filter(
				(shot: unknown): shot is RowAuditScreenshot =>
					!!shot && typeof shot === "object" && typeof (shot as RowAuditScreenshot).path === "string",
			),
		});
	}
	return verdicts;
}

// Identity reads confirm which revision is checked out; they verify nothing about the row.
const IDENTITY_READ = /^\s*git\s+(?:-C\s+\S+\s+)?(?:rev-parse|status|log|show|branch|describe)\b/;

/**
 * The recorded outcome of one row's audit. Only a verdict backed by a check run or a captured
 * screenshot counts; anything else verified nothing and is inconclusive, never a defect.
 */
export function settleRowAuditVerdict(
	verdict: RowAuditVerdict | undefined,
	fileExists: (path: string) => boolean = existsSync,
): { verdict: "pass" | "fail" | "inconclusive"; findings: string } {
	if (!verdict) return { verdict: "inconclusive", findings: "auditor returned no verdict for this row" };
	if (verdict.verdict === "inconclusive")
		return { verdict: "inconclusive", findings: verdict.findings || "auditor could not verify" };
	const checked =
		verdict.checks.some(check => !IDENTITY_READ.test(check.command)) ||
		verdict.screenshots.some(shot => fileExists(shot.path));
	if (!checked)
		return {
			verdict: "inconclusive",
			findings: `"${verdict.verdict}" without a check or screenshot at HEAD${verdict.findings ? `: ${verdict.findings}` : ""}`,
		};
	return { verdict: verdict.verdict, findings: verdict.findings };
}

function rowRepo(row: RowAuditRow, cwd: string): string {
	return row.artifactCwd ?? row.schedule?.executor?.gitCommits?.[0]?.repoPath ?? cwd;
}

/**
 * Delivered rows whose audit must be (re)launched, one batch per repository head. A row whose
 * pending audit already runs at the current head (`inFlight`) is skipped; a pending audit at an
 * older head, or one no longer running in this process, is audited again at the current head. An
 * inconclusive audit is relaunched once naming the missing piece, and again only after the lead
 * records new evidence on the row.
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
		const audit = after.audit?.head === head ? after.audit : undefined;
		if (audit?.verdict === "pass") continue;
		let attempt = audit?.attempts ?? 1;
		let retry: string | undefined;
		if (audit?.verdict === "inconclusive") {
			const newEvidence = (row.schedule?.progress?.at ?? 0) > (audit.at ?? Infinity);
			if (attempt >= 2 && !newEvidence) continue;
			attempt = newEvidence ? 1 : attempt + 1;
			retry = audit.findings;
		}
		if (inFlight(repoPath, head)) continue;
		const key = JSON.stringify([repoPath, head]);
		const batch = batches.get(key) ?? { repoPath, head, rows: [] };
		batch.rows.push({ ...row, attempt, ...(retry ? { retry } : {}) });
		batches.set(key, batch);
	}
	return [...batches.values()];
}

export function rowAuditTask(batch: RowAuditBatch, requirementsFor: (row: string) => string[] = () => []): string {
	const rows = batch.rows
		.map(row =>
			[
				`- Row: ${JSON.stringify(row.content)}`,
				...requirementsFor(row.content).map(text => `  Linked requirement: ${text.replace(/\s+/g, " ").trim()}`),
				`  Recorded evidence (commits and checks to re-run at HEAD): ${row.schedule?.progress?.evidence ?? "none recorded"}`,
				`  Previous worker (context only, not proof): agent://${row.schedule?.executor?.workerId ?? "unknown"}`,
				...(row.retry ? [`  Previous audit was inconclusive: ${row.retry}. Obtain exactly that piece now.`] : []),
			].join("\n"),
		)
		.join("\n");
	return prompt.render(brief, { root: batch.repoPath, head: batch.head, rows });
}

/** Linked requirement texts from the session's requirements ledger wire entry, when one exists. */
function ledgerRequirements(ctx: ExtensionContext): (row: string) => string[] {
	const entry = selectLatestBranchEntry(
		ctx.sessionManager,
		metadata => metadata.type === "custom" && metadata.customType === "requirements_ledger",
	) as { data?: { requirements?: unknown } } | undefined;
	const items = Array.isArray(entry?.data?.requirements) ? entry.data.requirements : [];
	return row =>
		items.flatMap(item =>
			item &&
			typeof item === "object" &&
			Array.isArray(item.rows) &&
			item.rows.includes(row) &&
			typeof item.rawText === "string" &&
			item.classification !== "not-a-requirement"
				? [`${typeof item.id === "string" ? `${item.id}: ` : ""}${item.rawText}`]
				: [],
		);
}

/** The row auditor as the runtime agent registry resolves it; never a substitute profile. */
export async function registryAuditor(cwd: string, home = homedir()): Promise<string | undefined> {
	try {
		const discovery = await discoverAgents(cwd, home);
		return getAgent(discovery.agents, TODO_ROW_AUDITOR) ? TODO_ROW_AUDITOR : undefined;
	} catch {
		return undefined;
	}
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
	/** Resolves the auditor profile; undefined means none is installed and nothing launches. */
	resolveAuditor?: () => Promise<string | undefined>;
	requirementsFor?: (row: string) => string[];
	fileExists?: (path: string) => boolean;
}

/** In-flight batches survive extension reloads in this process; a new process relaunches each once. */
const inFlight = new Set<string>();
const failedAt = new Map<string, number>();

export function resetRowAuditsForTest(): void {
	inFlight.clear();
	failedAt.clear();
}

/**
 * Runtime-owned post-completion step: every delivered, unverified row is audited at its repository
 * head by the registry's qa-auditor, in batches (at most ROW_AUDIT_CAP at once). A pass closes the
 * row through the schedule callback; only a defect observed at the head returns it to "needs
 * worker". Inconclusive audits keep the row verifying and relaunch once naming the missing piece.
 * Without an auditor profile nothing launches and the rows stay "verifying: auditor unavailable".
 * A head that moved while the audit ran discards its verdicts and re-audits once at the new head.
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
	const batches = planRowAudits(candidates, heads, ctx.cwd, isLive, busy);
	if (!batches.length) return 0;
	const agent = await (options.resolveAuditor ?? (() => registryAuditor(ctx.cwd)))();
	if (!agent) {
		for (const batch of batches)
			for (const row of batch.rows) {
				const current = row.schedule?.audit;
				const delivery = todoRowDeliveryKey(row.schedule);
				if (current?.verdict === "unavailable" && current.delivery === delivery && current.head === batch.head)
					continue;
				ctx.updateTodoSchedule(row.content, {
					audit: {
						delivery,
						repoPath: batch.repoPath,
						head: batch.head,
						startedAt: now(),
						verdict: "unavailable",
						agent: TODO_ROW_AUDITOR,
						findings: `no ${TODO_ROW_AUDITOR} profile resolves in the agent registry`,
						at: now(),
					},
				});
			}
		return 0;
	}
	const requirementsFor = options.requirementsFor ?? ledgerRequirements(ctx);
	const fileExists = options.fileExists ?? existsSync;
	let launched = 0;
	for (const batch of batches) {
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
				attempts: row.attempt,
			};
			// Persist before launching: a resumed session sees the pending audit, never a bare delivery.
			if (ctx.updateTodoSchedule(row.content, { audit })) records.set(row.content, audit);
		}
		if (!records.size) continue;
		inFlight.add(key);
		launched++;
		void (async () => {
			let retry = false;
			try {
				const result = await ctx.runRowAudit!(rowAuditTask(batch, requirementsFor), agent, undefined, workerId => {
					for (const [content, audit] of records) {
						if (audit.workerId === workerId) continue;
						audit.workerId = workerId;
						const current = ctx
							.getTodoPhases?.()
							?.flatMap(phase => phase.tasks)
							.find(row => row.content === content)?.schedule?.audit;
						if (current?.delivery === audit.delivery && current.startedAt === audit.startedAt)
							ctx.updateTodoSchedule!(content, { audit: { ...audit } });
					}
				});
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
					const at = now();
					const settled = settleRowAuditVerdict(
						verdicts.find(item => item.row === content),
						fileExists,
					);
					const record: TodoRowAudit = { ...audit, verdict: settled.verdict, findings: settled.findings, at };
					if (settled.verdict === "inconclusive") {
						// Nothing was verified: the row stays verifying and the evidence the lead recorded stays.
						if ((audit.attempts ?? 1) < 2) retry = true;
						ctx.updateTodoSchedule!(content, { audit: record });
						continue;
					}
					ctx.updateTodoSchedule!(content, {
						audit: record,
						progress: {
							at,
							evidence: `audit ${settled.verdict} at ${batch.head.slice(0, 12)}${settled.findings ? `: ${settled.findings}` : ""}`,
						},
					});
				}
			} catch (error) {
				failedAt.set(key, now());
				logger.warn("Row audit did not run", { repo: batch.repoPath, head: batch.head, error: String(error) });
			} finally {
				inFlight.delete(key);
			}
			if (retry) await checkRowAudits(ctx, options).catch(() => 0);
		})();
	}
	return launched;
}
