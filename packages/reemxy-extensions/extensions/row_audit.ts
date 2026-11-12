import { auditFindingPatch, findingSeverity, type AuditFinding } from "./audit-findings";
import { editsRequirements, rowRequirementQuotes, type RequirementQuote } from "./requirement_quotes";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { homedir } from "node:os";
import { selectLatestBranchEntry } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	TODO_ROW_AUDITOR,
	type TodoRowAudit,
	type TodoScheduleInputTask,
	todoArtifactGitBinding,
	todoArtifactRepository,
	todoAuditResourcesKey,
	todoAuditHasNewMaterialInputs,
	todoAuditMatchesResources,
	todoMaterialInputsKey,
	todoRowAfterWorker,
	todoRowDeliveryKey,
} from "@oh-my-pi/pi-tui/tools/todo-schedule";
import brief from "./row-audit.md" with { type: "text" };
import { checkoutScopesFromResources } from "./checkout_scope";

/** Concurrent audit batches per session, the same ceiling as the requirements auditor pool. */
export const ROW_AUDIT_CAP = 4;
/** A batch whose launch threw is not retried before this delay, so a missing agent cannot spin. */
export const ROW_AUDIT_RETRY_MS = 10 * 60_000;

export type RowAuditRow = TodoScheduleInputTask & { artifactCwd?: string };
export type RowAuditCheck = { command: string; exitCode: number; gate?: boolean };
export type RowAuditScreenshot = { path: string; width?: number };
export type RowAuditVerdict = {
	row: string;
	verdict: "pass" | "fail" | "inconclusive";
	findings: string;
	issues?: AuditFinding[];
	checks: RowAuditCheck[];
	screenshots: RowAuditScreenshot[];
	requirementDiffs?: Array<{ before: string; after: string; quoteIds: string[]; widening: boolean; reason: string }>;
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
		if (item.issues !== undefined && (!Array.isArray(item.issues) || item.issues.some((issue: AuditFinding) => !issue || typeof issue.kind !== "string" || typeof issue.evidence !== "string" || (issue.action !== undefined && typeof issue.action !== "string") || (issue.severity !== undefined && issue.severity !== "blocker" && issue.severity !== "later")))) return;
		verdicts.push({
			issues: item.issues,
			row: item.row,
			requirementDiffs: item.requirementDiffs,
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
	quotes?: RequirementQuote[],
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
	if (quotes !== undefined) {
		const diffs = verdict.requirementDiffs;
		if (!quotes.length || !Array.isArray(diffs) || !diffs.length || diffs.some(diff =>
			!diff || typeof diff.before !== "string" || typeof diff.after !== "string" || typeof diff.widening !== "boolean" ||
			!diff.reason?.trim() || !Array.isArray(diff.quoteIds) || !diff.quoteIds.length || diff.quoteIds.some(id => !quotes.some(q => q.id === id))))
			return { verdict: "inconclusive", findings: "Requirement diff must be checked hunk by hunk against linked verbatim quotes" };
		const widened = diffs.filter(diff => diff.widening);
		if (widened.length) return { verdict: "fail", findings: widened.map(diff => diff.reason).join("; ") };
	}
	const issues = rowAuditIssues(verdict);
	const blockers = issues.filter(issue => findingSeverity(issue) === "blocker");
	return { verdict: blockers.length ? "fail" : "pass", findings: blockers.length ? blockers.map(issue => `${issue.evidence}${issue.action ? `; next: ${issue.action}` : ""}`).join("\n") : verdict.findings };
}

export function rowAuditIssues(verdict: RowAuditVerdict): AuditFinding[] {
	return [
		...(verdict.issues ?? (verdict.verdict === "fail" && verdict.findings ? [{ kind: "legacy_finding", evidence: verdict.findings }] : [])),
		...verdict.checks.filter(check => check.exitCode !== 0 && (check.gate === true || verdict.verdict === "fail") && !IDENTITY_READ.test(check.command)).map(check => ({ kind: "broken_gate", evidence: `${check.command}: exit ${check.exitCode}`, severity: "blocker" as const })),
		...(verdict.requirementDiffs ?? []).filter(diff => diff.widening).map(diff => ({ kind: "requirement_violation", evidence: diff.reason, severity: "blocker" as const })),
	];
}

function rowDeliveryCommits(row: RowAuditRow): { commit: string; repoPath: string }[] {
	return row.schedule?.executor?.gitCommits ?? row.schedule?.attemptHistory?.at(-1)?.gitCommits ?? [];
}

/** Resolve the same file scopes as dispatch; ambiguity must never select the session checkout. */
export function rowAuditRepository(row: RowAuditRow, cwd: string): { repoPath: string } | { blocker: string } {
	const resources = row.schedule?.resources ?? [];
	const pins = [...new Set(resources.filter(resource => resource.startsWith("git:")))];
	const binding = todoArtifactGitBinding(row);
	if (pins.length && (!binding || pins.length !== 1))
		return {
			blocker:
				"Audit repository is ambiguous: conflicting or invalid git pins; keep one exact git:<checkout>@<40-character commit> binding",
		};
	const paths = resources.filter(resource => !resource.startsWith("git:"));
	const scopes = checkoutScopesFromResources(paths);
	if (paths.length && !scopes)
		return {
			blocker:
				"Audit repository cannot be resolved from its resources; supply absolute checkout/file paths and one matching git pin before audit",
		};
	// Non-git output directories carry evidence, not source checkout identity.
	const roots = new Set(
		(scopes?.map(scope => scope.split("\0")[0]!) ?? []).filter(root => existsSync(`${root}/.git`)),
	);
	for (const receipt of rowDeliveryCommits(row)) roots.add(receipt.repoPath);
	if (binding) roots.add(binding.repoPath);
	if (roots.size > 1)
		return {
			blocker: `Audit repository is ambiguous: resources span ${[...roots].join(", ")}; split the delivery by checkout or correct its resources`,
		};
	if (binding) return { repoPath: binding.repoPath };
	const root = [...roots][0];
	if (root) return { repoPath: root };
	if (paths.length)
		return {
			blocker: "Audit resources identify no source checkout; supply its absolute path or an exact git pin before audit",
		};
	return { repoPath: todoArtifactRepository(row, cwd) };
}

function rowRepo(row: RowAuditRow, cwd: string): string | undefined {
	const identity = rowAuditRepository(row, cwd);
	return "repoPath" in identity ? identity.repoPath : undefined;
}

/**
 * Delivered rows whose audit must be (re)launched, batches grouped by repository head. A row whose
 * pending audit already runs at the current head (`inFlight`) is skipped; a pending audit at an
 * older head, or one no longer running in this process, is audited again at the current head. Omitted verdicts retry individually once; two inconclusive verdicts
 * return the row to staffing for the missing evidence.
 */
export function planRowAudits(
	rows: readonly RowAuditRow[],
	heads: ReadonlyMap<string, string>,
	cwd: string,
	isLive: (row: RowAuditRow) => boolean,
	inFlight: (repoPath: string, head: string, row: RowAuditRow) => boolean,
): RowAuditBatch[] {
	const batches = new Map<string, RowAuditBatch>();
	for (const row of rows) {
		if (isLive(row) || row.schedule?.auditEscalation) continue;
		const after = todoRowAfterWorker(row);
		if (
			!(after?.kind === "verify" && after.via === "audit") &&
			!(after?.kind === "needs-worker" && after.reason === "audit-inconclusive")
		)
			continue;
		const repoPath = rowRepo(row, cwd);
		if (!repoPath) continue;
		const head = heads.get(repoPath) ?? "unknown";
		const binding = todoArtifactGitBinding(row);
		if (head === "unknown" || (binding && (binding.repoPath !== repoPath || binding.head !== head))) continue;
		const previous = after.kind === "verify" ? after.audit : row.schedule?.audit;
		const audit = previous?.head === head && previous.repoPath === repoPath ? previous : undefined;
		if (audit?.verdict === "pass" || audit?.cancelled) continue;
		const omitted = audit?.verdict === "omitted" || audit?.findings === "auditor returned no verdict for this row";
		let attempt = audit?.attempts ?? 1;
		let retry: string | undefined;
		if (audit?.verdict === "inconclusive" || audit?.verdict === "omitted") {
			const newEvidence = todoAuditHasNewMaterialInputs(row.schedule, audit);
			if (attempt >= 2 && !newEvidence) continue;
			attempt = newEvidence ? 1 : attempt + 1;
			retry = audit.findings;
		}
		if (inFlight(repoPath, head, row)) continue;
		const key = JSON.stringify([repoPath, head, ...(omitted ? [row.content] : [])]);
		const batch = batches.get(key) ?? { repoPath, head, rows: [] };
		batch.rows.push({ ...row, schedule: row.schedule && { ...row.schedule, resources: row.schedule.resources && [...row.schedule.resources] }, attempt, ...(retry ? { retry } : {}) });
		batches.set(key, batch);
	}
	return [...batches.values()];
}

/** Prior observations remain retrieval context only while revision, delivery and criterion agree. */
function auditEvidenceHistory(
	row: RowAuditRow,
	head: string,
	repoPath: string,
): { inputsKey: string; evidence: string }[] {
	const audit = row.schedule?.audit;
	if (
		!audit ||
		audit.head !== head ||
		audit.repoPath !== repoPath ||
		audit.delivery !== todoRowDeliveryKey(row.schedule) ||
		!todoAuditMatchesResources(row.schedule, audit) ||
		audit.materialInputs?.criterion !== row.schedule?.materialInputs?.criterion
	)
		return [];
	const history = [
		...(audit.evidenceHistory ?? []),
		...[audit.evidence, audit.findings]
			.filter((evidence): evidence is string => !!evidence)
			.map(evidence => ({ inputsKey: todoMaterialInputsKey(audit.materialInputs), evidence })),
	];
	return history.filter(
		(entry, index) =>
			history.findIndex(other => other.inputsKey === entry.inputsKey && other.evidence === entry.evidence) === index,
	);
}

export function rowAuditTask(batch: RowAuditBatch, requirementsFor: (row: string) => string[] = () => []): string {
	const rows = batch.rows
		.map(row =>
			[
				`- Row: ${JSON.stringify(row.content)}`,
				...(row.schedule?.auditOrigin ? [`  auditOrigin: ${JSON.stringify(row.schedule.auditOrigin)}`] : []),
				...requirementsFor(row.content).map(text => `  Linked requirement: ${text.replace(/\s+/g, " ").trim()}`),
				`  Material inputs: ${todoMaterialInputsKey(row.schedule?.materialInputs)}`,
				`  Assigned resources: ${JSON.stringify(row.schedule?.resources ?? [])}`,
				`  Delivery commits: ${JSON.stringify(rowDeliveryCommits(row))}`,
				`  Recorded evidence (commits and checks to re-run at HEAD): ${row.schedule?.progress?.evidence ?? "none recorded"}`,
				...auditEvidenceHistory(row, batch.head, batch.repoPath).map(entry => `  Prior observation (recheck, not acceptance; inputs ${entry.inputsKey}): ${entry.evidence}`),
				`  Audit base: ${row.schedule?.auditBase ?? "first audit: full delivered range"}`,
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
	containsCommit?: (repoPath: string, commit: string, head: string) => Promise<boolean>;
	readTarget?: (repoPath: string) => Promise<{ remote?: string; branch?: string }>;
	/** Resolves the auditor profile; undefined means none is installed and nothing launches. */
	resolveAuditor?: () => Promise<string | undefined>;
	requirementsFor?: (row: string) => string[];
	fileExists?: (path: string) => boolean;
	recordRequirementDiff?: (data: {
		row: string; head: string; delivery: string; quotes: RequirementQuote[];
		diffs: RowAuditVerdict["requirementDiffs"]; verdict: string; findings: string; at: number;
	}) => void;
}

/** In-flight batches survive reloads; restored owners are checked before a new process relaunches. */
const inFlight = new Map<string, Set<string>>();
const failedAt = new Map<string, number>();

export function resetRowAuditsForTest(): void {
	inFlight.clear();
	failedAt.clear();
}

/**
 * Runtime-owned post-completion step: every delivered, unverified row is audited at its repository
 * head by the registry's qa-auditor, in batches (at most ROW_AUDIT_CAP at once). A pass closes the
 * row through the schedule callback; only a defect observed at the head returns it to "needs
 * worker". Inconclusive audits relaunch once, then return the missing evidence to staffing.
 * Without an auditor profile nothing launches and rows show the audit queue.
 * A head that moved while the audit ran discards its verdicts and re-audits once at the new head.
 */
export async function checkRowAudits(ctx: ExtensionContext, options: RowAuditOptions = {}): Promise<number> {
	if (!ctx.runRowAudit || !ctx.getTodoPhases || !ctx.updateTodoSchedule) return 0;
	const now = options.now ?? Date.now;
	const readHead = options.readHead ?? execGit;
	const session = ctx.sessionManager.getHeader()?.id ?? "";
	const rowKey = (row: RowAuditRow) => JSON.stringify([session, row.content]);
	const batchKey = (batch: RowAuditBatch) =>
		JSON.stringify([session, batch.repoPath, batch.head, batch.rows.map(rowKey).sort()]);
	const rows = (ctx.getTodoPhases() ?? []).flatMap(phase => phase.tasks) as RowAuditRow[];
	const snapshot = ctx.getAsyncJobSnapshot?.();
	const jobs = snapshot?.running ?? [];
	const liveIds = new Set([
		...jobs.flatMap(job => [job.id, job.agentId].filter((id): id is string => !!id)),
		// The canonical snapshot includes restart reservations before their jobs exist.
		...(snapshot?.nonJobAgents ?? []).filter(agent => agent.live).map(agent => agent.id),
	]);
	const isLive = (row: RowAuditRow) =>
		[row.schedule?.owner, row.schedule?.executor?.workerId,
			row.schedule?.audit?.verdict === "pending" ? row.schedule.audit.workerId : undefined,
		].some(id => typeof id === "string" && liveIds.has(id));
	for (const row of rows) {
		const audit = row.schedule?.audit;
		const owned = [...inFlight.values()].some(keys => keys.has(rowKey(row)));
		if (row.schedule?.auditOrigin?.resolution === "retarget" && audit?.verdict === "pending" && !owned && !isLive(row))
			ctx.updateTodoSchedule(row.content, { audit: { ...audit, verdict: "inconclusive", findings: "one-shot check interrupted; finding not carried forward", at: now() } });
	}
	const candidates = rows
		.map(row => ({
			...row,
			schedule: row.schedule && {
				...row.schedule,
				resources: row.schedule.resources && [...row.schedule.resources],
				executor: row.schedule.executor && {
					...row.schedule.executor,
					gitCommits: row.schedule.executor.gitCommits?.map(receipt => ({ ...receipt })),
				},
				attemptHistory: row.schedule.attemptHistory?.map(attempt => ({
					...attempt,
					gitCommits: attempt.gitCommits?.map(receipt => ({ ...receipt })),
				})),
				materialInputs: row.schedule.materialInputs && structuredClone(row.schedule.materialInputs),
				audit: row.schedule.audit && structuredClone(row.schedule.audit),
			},
		}))
		.filter(row => {
			const after = isLive(row) ? undefined : todoRowAfterWorker(row);
			return (
				(after?.kind === "verify" && after.via === "audit") ||
				(after?.kind === "needs-worker" && (after.reason === "audit-inconclusive" || after.reason === "audit-failed"))
			);
		});
	if (!candidates.length) return 0;
	const heads = new Map<string, string>();
	for (const repoPath of new Set(
		candidates.map(row => rowRepo(row, ctx.cwd)).filter((repo): repo is string => !!repo),
	))
		heads.set(repoPath, (await readHead(repoPath)) ?? "unknown");
	const blocked = new Set<string>();
	for (const row of candidates) {
		const binding = todoArtifactGitBinding(row);
		const repoPath = rowRepo(row, ctx.cwd);
		const identity = rowAuditRepository(row, ctx.cwd);
		const head = repoPath ? (heads.get(repoPath) ?? "unknown") : "unknown";
		let receiptBlocker: string | undefined;
		const integrationCommits: string[] = [];
		if (repoPath && !("blocker" in identity)) {
			for (const receipt of rowDeliveryCommits(row)) {
				try {
					if (head === "unknown") {
						receiptBlocker = `Cannot verify delivery commit ${receipt.commit} in ${repoPath}@${head}; restore the repository and commit before audit`;
					} else if (!(await (options.containsCommit ?? vcs.isAncestor)(repoPath, receipt.commit, head))) {
						integrationCommits.push(receipt.commit);
					}
				} catch {
					receiptBlocker = `Cannot verify delivery commit ${receipt.commit} in ${repoPath}@${head}; restore the repository and commit before audit`;
				}
				if (receiptBlocker) break;
			}
		}
		const awaitingIntegration = !receiptBlocker && integrationCommits.length > 0;
		if (
			!("blocker" in identity) &&
			!receiptBlocker &&
			!awaitingIntegration &&
			(!binding || (binding.repoPath === repoPath && binding.head === head))
		)
			continue;
		blocked.add(rowKey(row));
		const latest = ctx
			.getTodoPhases?.()
			?.flatMap(phase => phase.tasks)
			.find(candidate => candidate.content === row.content);
		if (
			!latest ||
			todoRowDeliveryKey(latest.schedule) !== todoRowDeliveryKey(row.schedule) ||
			JSON.stringify([...(latest.schedule?.resources ?? [])].sort()) !==
				JSON.stringify([...(row.schedule?.resources ?? [])].sort()) ||
			JSON.stringify(latest.schedule?.audit) !== JSON.stringify(row.schedule?.audit) ||
			JSON.stringify(rowDeliveryCommits(latest)) !== JSON.stringify(rowDeliveryCommits(row))
		)
			continue;
		const delivery = todoRowDeliveryKey(row.schedule);
		const findings =
			"blocker" in identity
				? identity.blocker
				: (receiptBlocker ?? (awaitingIntegration
					? `Delivery awaits integration of ${integrationCommits.join(", ")} into ${repoPath}@${head}`
					: `Pinned delivery ${binding!.repoPath}@${binding!.head} does not match checkout ${repoPath}@${head}; restore or rebind the artifact before audit`));
		if (
			row.schedule?.audit?.delivery === delivery &&
			row.schedule.audit.head === head &&
			row.schedule.audit.findings === findings
		)
			continue;
		ctx.updateTodoSchedule(row.content, {
			audit: {
				delivery,
				repoPath: repoPath ?? "",
				head,
				resourcesKey: todoAuditResourcesKey(row.schedule),
				bindingMismatch: !awaitingIntegration,
				...(awaitingIntegration ? { integrationCommits } : {}),
				startedAt: now(),
				verdict: awaitingIntegration ? "awaiting-integration" : "inconclusive",
				agent: TODO_ROW_AUDITOR,
				attempts: awaitingIntegration ? 0 : 2,
				evidence: row.schedule?.progress?.evidence ?? "",
				findings,
				at: now(),
			},
		});
	}
	const busy = (_repoPath: string, _head: string, row: RowAuditRow) => {
		const key = rowKey(row);
		return (
			[...inFlight.values()].some(rows => rows.has(key)) ||
			now() - (failedAt.get(key) ?? -Infinity) < ROW_AUDIT_RETRY_MS
		);
	};
	const running = () => [...inFlight.keys()].filter(key => key.startsWith(`[${JSON.stringify(session)},`)).length;
	const batches = planRowAudits(
		candidates.filter(row => !blocked.has(rowKey(row))),
		heads,
		ctx.cwd,
		isLive,
		busy,
	);
	if (!batches.length) return 0;
	// A row may be rebound while registry resolution or an auditor is in flight.
	// Resource identity is separate from executor delivery identity.
	const resourceKey = (row: RowAuditRow) => todoAuditResourcesKey(row.schedule);
	const latestFor = (row: RowAuditRow, batch: RowAuditBatch) => {
		const latest = ctx
			.getTodoPhases?.()
			?.flatMap(phase => phase.tasks)
			.find(candidate => candidate.content === row.content);
		if (
			!latest ||
			latest.schedule?.review === "accepted" ||
			todoRowDeliveryKey(latest.schedule) !== todoRowDeliveryKey(row.schedule) ||
			todoMaterialInputsKey(latest.schedule?.materialInputs) !==
				todoMaterialInputsKey(row.schedule?.materialInputs) ||
			resourceKey(latest) !== resourceKey(row) ||
			JSON.stringify(rowDeliveryCommits(latest)) !== JSON.stringify(rowDeliveryCommits(row)) ||
			rowRepo(latest, ctx.cwd) !== batch.repoPath
		)
			return undefined;
		const binding = todoArtifactGitBinding(latest);
		return binding && (binding.repoPath !== batch.repoPath || binding.head !== batch.head) ? undefined : latest;
	};
	const agent = await (options.resolveAuditor ?? (() => registryAuditor(ctx.cwd)))();
	if (!agent) {
		for (const batch of batches)
			for (const row of batch.rows) {
				const latest = latestFor(row, batch);
				if (!latest) continue;
				const current = latest.schedule?.audit;
				if (JSON.stringify(current) !== JSON.stringify(row.schedule?.audit)) continue;
				const delivery = todoRowDeliveryKey(row.schedule);
				if (current?.verdict === "unavailable" && current.delivery === delivery && current.head === batch.head)
					continue;
				ctx.updateTodoSchedule(row.content, {
					audit: {
						delivery,
						repoPath: batch.repoPath,
						head: batch.head,
						resourcesKey: todoAuditResourcesKey(row.schedule),
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
	const linked = options.requirementsFor ?? ledgerRequirements(ctx);
	const requirementsFor = (row: string) => [...linked(row), ...rowRequirementQuotes(ctx, row).map(q => `VERBATIM USER QUOTE ${q.id}: ${JSON.stringify(q.quote)}`)];
	const fileExists = options.fileExists ?? existsSync;
	let launched = 0;
	for (const batch of batches) {
		if (running() >= ROW_AUDIT_CAP) break;
		// Claim capacity and rows synchronously, before target lookup yields to another tick.
		batch.rows = batch.rows.filter(row => latestFor(row, batch) && !busy(batch.repoPath, batch.head, row));
		if (!batch.rows.length) continue;
		const key = batchKey(batch);
		const claim = new Set(batch.rows.map(rowKey));
		inFlight.set(key, claim);
		const records = new Map<string, TodoRowAudit>();
		try {
			const target = await options.readTarget?.(batch.repoPath);
			batch.rows = batch.rows.filter(row => {
				const latest = latestFor(row, batch);
				const after = latest && todoRowAfterWorker(latest);
				return latest && !latest.schedule?.auditEscalation && !isLive(latest) &&
					((after?.kind === "verify" && after.via === "audit") || (after?.kind === "needs-worker" && after.reason === "audit-inconclusive"));
			});
			const startedAt = now();
			for (const row of batch.rows) {
				const audit: TodoRowAudit = {
					...target,
					delivery: todoRowDeliveryKey(row.schedule),
					repoPath: batch.repoPath,
					head: batch.head,
					resourcesKey: todoAuditResourcesKey(row.schedule),
					startedAt,
					verdict: "pending",
					agent,
					attempts: row.attempt,
					materialInputs: row.schedule?.materialInputs && structuredClone(row.schedule.materialInputs),
					evidenceHistory: auditEvidenceHistory(row, batch.head, batch.repoPath),
					evidence: row.schedule?.progress?.evidence ?? "",
				};
				// Persist before launching: a resumed session sees the pending audit, never a bare delivery.
				if (ctx.updateTodoSchedule(row.content, { audit })) records.set(row.content, audit);
			}
		} catch (error) {
			if (inFlight.get(key) === claim) inFlight.delete(key);
			throw error;
		}
		if (!records.size) {
			if (inFlight.get(key) === claim) inFlight.delete(key);
			continue;
		}
		launched++;
		void (async () => {
			let retry = false;
			const apply = async (output: unknown) => {
				const verdicts = parseRowAuditVerdicts(output) ?? [];
				const head = (await readHead(batch.repoPath)) ?? "unknown";
				// A moved head makes these verdicts stale; the next check audits once at the new head.
				if (head !== batch.head) return;
				for (const [content, audit] of records) {
					const original = batch.rows.find(candidate => candidate.content === content)!;
					const row = latestFor(original, batch);
					const current = row?.schedule?.audit;
					if (
						!row ||
						rowRepo(row, ctx.cwd) !== batch.repoPath ||
						current?.delivery !== audit.delivery ||
						current.head !== audit.head ||
						current.startedAt !== audit.startedAt ||
						current.attempts !== audit.attempts ||
						(current.verdict !== "pending" && current.verdict !== "omitted")
					)
						continue;
					if (row.schedule?.deliveryCritic?.key === audit.delivery && row.schedule.deliveryCritic.verdict === "clean" && row.schedule.deliveryCritic.classified) continue;
					const at = now();
					const verdict = verdicts.find(item => item.row === content);
					if (!verdict) {
						ctx.updateTodoSchedule!(content, {
							audit: {
								...audit,
								verdict: "omitted",
								findings:
									"auditor returned no verdict for this row; produce revision-bound executable checks and inspected screenshots required by the row",
								at,
							},
						});
						if (!row.schedule?.auditOrigin?.supersededAt && (audit.attempts ?? 1) < 2) retry = true;
						continue;
					}
					const requirementEdit = editsRequirements(row) || (verdict.requirementDiffs?.length ?? 0) > 0;
					const settled = settleRowAuditVerdict(verdict, fileExists, requirementEdit ? rowRequirementQuotes(ctx, row.content) : undefined);
					if (requirementEdit) options.recordRequirementDiff?.({
						row: row.content, head: batch.head, delivery: audit.delivery,
						quotes: rowRequirementQuotes(ctx, row.content),
						diffs: verdict.requirementDiffs ?? [], ...settled, at,
					});
					const record: TodoRowAudit = { ...audit, issues: rowAuditIssues(verdict).map(issue => ({ ...issue, severity: findingSeverity(issue) })), verdict: settled.verdict, findings: settled.findings, at };
					if (settled.verdict === "inconclusive") {
						// A second inconclusive result returns the findings to staffing through todoRowAfterWorker.
						if (!row.schedule?.auditOrigin?.supersededAt && (audit.attempts ?? 1) < 2) retry = true;
						ctx.updateTodoSchedule!(content, { audit: record });
						continue;
					}
					ctx.updateTodoSchedule!(content, {
						...auditFindingPatch(row.schedule ?? {}, rowAuditIssues(verdict), batch.head),
						audit: record,
						progress: {
							at,
							evidence: `audit ${settled.verdict} at ${batch.head.slice(0, 12)}${settled.findings ? `: ${settled.findings}` : ""}`,
						},
					});
				}
			};
			let updates = Promise.resolve();
			const submit = (output: unknown) => {
				updates = updates.then(() => apply(output));
				return updates;
			};
			try {
				const result = await ctx.runRowAudit!(rowAuditTask(batch, requirementsFor), agent, undefined, workerId => {
					for (const [content, audit] of records) {
						if (audit.workerId === workerId) continue;
						audit.workerId = workerId;
						const original = batch.rows.find(row => row.content === content)!;
						const current = latestFor(original, batch)?.schedule?.audit;
						if (current?.delivery === audit.delivery && current.startedAt === audit.startedAt && current.verdict === "pending")
							ctx.updateTodoSchedule!(content, { audit: { ...audit } });
					}
				}, batch.rows.map(row => row.content).join(" "), batch.rows.map(row => row.content), output => {
					void submit(output).catch(error => logger.warn("Row audit update failed", { error: String(error) }));
				});
				const details = result?.details as {
					results?: Array<{ output?: unknown; aborted?: boolean; error?: string; exitCode?: number }>;
				} | undefined;
				const aborted = details?.results?.find(item => item.aborted);
				if (aborted) {
					const at = now();
					for (const [content, audit] of records) {
						const original = batch.rows.find(row => row.content === content)!;
						const current = latestFor(original, batch)?.schedule?.audit;
						if (
							current?.delivery === audit.delivery &&
							current.head === audit.head &&
							current.startedAt === audit.startedAt &&
							(current.verdict === "pending" || current.verdict === "omitted")
						)
							ctx.updateTodoSchedule!(content, {
								audit: {
									...audit,
									verdict: "unavailable",
									cancelled: true,
									findings: aborted.error || "audit worker stopped before a verdict",
									at,
								},
							});
					}
					return;
				}
				await submit(details?.results?.[0]?.output);
			} catch (error) {
				for (const row of batch.rows) {
					const audit = records.get(row.content);
					const current = latestFor(row, batch)?.schedule?.audit;
					if (audit && current?.delivery === audit.delivery && current.head === audit.head &&
						current.startedAt === audit.startedAt && (current.verdict === "pending" || current.verdict === "omitted")) {
						failedAt.set(rowKey(row), now());
						ctx.updateTodoSchedule!(row.content, {
							audit: { ...audit, verdict: "unavailable", findings: String(error), at: now() },
						});
					}
				}
				logger.warn("Row audit did not run", { repo: batch.repoPath, head: batch.head, error: String(error) });
			} finally {
				if (inFlight.get(key) === claim) inFlight.delete(key);
			}
			if (retry) await checkRowAudits(ctx, options).catch(() => 0);
		})();
	}
	return launched;
}
