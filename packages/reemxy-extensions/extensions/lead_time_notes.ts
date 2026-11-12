import { formatLocalTimestamp, type DeadlineState } from "./deadlines";
import { prompt } from "@oh-my-pi/pi-utils";
import { singleLine, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { TodoScheduleInput, TodoPlanForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import chainInstructions from "./todo_dispatch-chain.md" with { type: "text" };
import { todoRowAfterWorker } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import planfactNote from "./planfact-note.md" with { type: "text" };
import { selectBranchNewestFirst } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

export const LEAD_NOTE_MAX_CHARS = 8192;
export const LEAD_NOTE_INTERVAL_MS = 5 * 60_000;

type TimedNoteMessage = Extract<SessionEntry, { type: "custom_message" }>;
type TimedNoteIdentity = { semanticKey: string; timestamp: number };
type TimedNotePi = Pick<ExtensionAPI, "sendMessage">;
type TimedNoteContext = Pick<ExtensionContext, "sessionManager">;

function readIdentity(entry: TimedNoteMessage): TimedNoteIdentity | undefined {
	const details = entry.details;
	if (!details || typeof details !== "object" || !("semanticKey" in details) || typeof details.semanticKey !== "string") return undefined;
	const timestamp = "emittedAt" in details && typeof details.emittedAt === "number" ? details.emittedAt : Date.parse(entry.timestamp);
	return Number.isFinite(timestamp) ? { semanticKey: details.semanticKey, timestamp } : undefined;
}

function latestIdentity(ctx: TimedNoteContext, customType: string): TimedNoteIdentity | undefined {
	for (const entry of selectBranchNewestFirst(ctx.sessionManager, metadata => metadata.type === "custom_message" && (metadata.customType === undefined || metadata.customType === customType))) {
		if (entry?.type !== "custom_message" || entry.customType !== customType) continue;
		return readIdentity(entry);
	}
	return undefined;
}

export function shouldAppendTimedNote(
	previous: TimedNoteIdentity | undefined,
	semanticKey: string,
	now: number,
	workOpen: boolean,
): boolean {
	if (!previous || previous.semanticKey !== semanticKey) return true;
	return workOpen && now - previous.timestamp >= LEAD_NOTE_INTERVAL_MS;
}

export async function appendTimedNote(
	pi: TimedNotePi,
	ctx: TimedNoteContext,
	customType: string,
	content: string,
	semanticKey: string,
	localClock: string,
	workOpen: boolean,
	now = Date.now(),
	forecastIdentity?: { membershipFingerprint?: string; predictionVersion?: string; anchorId?: string; rows?: Record<string, string>; shared?: string[]; contextBoundary?: string },
	/** The model no longer holds an earlier note (compaction), so deliver regardless of the journal identity. */
	force = false,
): Promise<boolean> {
	if (!content.trim()) return false;
	const identity = Bun.hash(semanticKey).toString(16);
	if (!force && !shouldAppendTimedNote(latestIdentity(ctx, customType), identity, now, workOpen)) return false;
	const delivery = { deliverAs: "aside" as const, triggerTurn: false, interruptWait: false, supersedes: customType };
	await pi.sendMessage(
		{
			customType,
			content: customType === "todo-dispatch-time-note" ? `${localClock} · ${content}` : `${localClock} · ${content}`.slice(0, LEAD_NOTE_MAX_CHARS),
			display: false,
			details: { semanticKey: identity, emittedAt: now, ...forecastIdentity },
			attribution: "agent",
		},
		delivery,
	);
	return true;
}

/** True when the note would be delivered; lets the caller skip building its body otherwise. */
export function timedNoteDue(ctx: TimedNoteContext, customType: string, semanticKey: string, workOpen: boolean, now = Date.now()): boolean {
	return shouldAppendTimedNote(latestIdentity(ctx, customType), Bun.hash(semanticKey).toString(16), now, workOpen);
}

/** What a delivered note already told the model: a row signature per row and the shared paragraphs it carried. */
export type NoteWindow = { rows: Record<string, string>; shared: string[] };
export type RowBlock = { row: string; text: string; sig: string; shared: string[] };

type NoteContextMessage = { role: string; customType?: string; details?: unknown; timestamp?: number; summary?: string };

/** The canonical context producer identifies the active compaction, including retained pre-compaction notes. */
export function noteContextBoundary(messages: readonly NoteContextMessage[]): string | undefined {
	const boundary = messages.findLast(item => item.role === "compactionSummary");
	return boundary ? Bun.hash(JSON.stringify([boundary.timestamp, boundary.summary])).toString(16) : undefined;
}

/** Only notes delivered in this context window can suppress full instructions. */
export function deliveredNoteWindow(messages: readonly NoteContextMessage[], customType: string): NoteWindow | undefined {
	const message = messages.findLast(item => item.role === "custom" && item.customType === customType);
	const details = message?.details as { rows?: unknown; shared?: unknown; contextBoundary?: string } | undefined;
	if (!details || details.contextBoundary !== noteContextBoundary(messages) || typeof details.rows !== "object" || details.rows === null) return undefined;
	return { rows: details.rows as Record<string, string>, shared: Array.isArray(details.shared) ? details.shared.filter((item): item is string => typeof item === "string") : [] };
}

/**
 * Full instructions only for rows whose signature differs from the delivered window; unchanged rows
 * collapse to one count (all WAIT) or one short line (NEXT ACTION still open). Paragraphs shared by
 * rows are written once per window.
 */
export function projectRowBlocks(blocks: RowBlock[], previous: NoteWindow | undefined, sharedText: (kind: string) => string, deltaText: (data: { row: string; waiting: boolean } | { count: number }) => string): { text: string; rows: Record<string, string>; shared: string[] } {
	const delivered = new Set(previous?.shared ?? []);
	const changed = blocks.filter(block => previous?.rows[block.row] !== block.sig);
	const unchanged = blocks.filter(block => previous?.rows[block.row] === block.sig);
	const fresh = [...new Set(changed.flatMap(block => block.shared))].filter(kind => !delivered.has(kind));
	const waiting = unchanged.filter(block => /^WAIT:/m.test(block.text) && !/^NEXT ACTION:/m.test(block.text));
	const open = unchanged.filter(block => !waiting.includes(block));
	const lines = [
		...fresh.map(sharedText),
		...changed.map(block => block.text),
		...open.map(block => deltaText({ row: block.row, waiting: false })),
		...(open.length ? waiting.map(block => deltaText({ row: block.row, waiting: true })) : waiting.length ? [deltaText({ count: waiting.length })] : []),
	];
	return {
		text: lines.join("\n"),
		rows: Object.fromEntries(blocks.map(block => [block.row, block.sig])),
		shared: [...delivered, ...fresh],
	};
}

/** Elapsed lateness against the original anchor, shared by notes and FIX NOW. */
export function planSlipMinutes(deadlineAt: number | undefined, now: number, hasOpen = true): number {
	return deadlineAt === undefined || !hasOpen ? 0 : Math.max(0, Math.ceil((now - deadlineAt) / 60_000));
}

/** The shared churn predicate, before presentation limits or dependency-chain filtering. */
export function planChurnRows(phases: TodoScheduleInput): Array<{ row: string; failures: number; reestimates: number }> {
	return phases.flatMap(phase => phase.tasks).flatMap(row => {
		if (row.status === "completed" || row.status === "abandoned" || row.schedule?.auditOrigin?.supersededAt) return [];
		const failures = row.schedule?.attemptHistory?.filter(attempt => attempt.terminalStatus !== "completed" || attempt.rejectionReason).length ?? 0;
		const reestimates = row.schedule?.cumulativeReestimateCount ?? row.schedule?.reestimateCount ?? 0;
		return failures >= 3 || reestimates >= 3 ? [{ row: row.content, failures, reestimates }] : [];
	});
}

/** Open prerequisite paths, including dangling links and cycles that need plan repair. */
export function unfinishedDependencyChains(phases: TodoScheduleInput, title: string): string[][] {
	const rows = new Map(phases.flatMap(phase => phase.tasks).map(row => [row.content, row]));
	const walk = (name: string, path: string[]): string[][] => {
		const pending = (rows.get(name)?.schedule?.dependencies ?? []).filter(dep => {
			const row = rows.get(dep);
			return !row || (row.status !== "completed" && row.status !== "abandoned");
		});
		if (!pending.length) return path.length > 1 ? [path] : [];
		return pending.flatMap(dep => path.includes(dep) ? [[...path, dep]] : walk(dep, [...path, dep]));
	};
	return walk(title, [title]);
}

/** Retry pressure only applies when the row's prerequisites permit a changed attempt. */
export function actionableChurnRows(phases: TodoScheduleInput): Array<{ row: string; failures: number; reestimates: number }> {
	const rows = phases.flatMap(phase => phase.tasks);
	return planChurnRows(phases).filter(item => {
		const row = rows.find(row => row.content === item.row);
		return row !== undefined && todoRowAfterWorker(row)?.kind !== "verify" && unfinishedDependencyChains(phases, item.row).length === 0;
	});
}

export function renderPlanFactNote(
	phases: TodoScheduleInput,
	now: number,
	deadlineAt: number | undefined,
	questions: Array<{ worker: string; question: string }> = [],
	_forecastFinish?: number,
): string {
	const open = phases.flatMap(phase => phase.tasks).filter(row => row.status !== "completed" && row.status !== "abandoned");
	const churn = actionableChurnRows(phases).slice(0, 8).map(item => ({ ...item, row: item.row.slice(0, 180) }));
	const slipMinutes = planSlipMinutes(deadlineAt, now, open.length > 0);
	return prompt.render(planfactNote, {
		churn, slipped: slipMinutes > 0, slipMinutes,
		questions: questions.slice(0, 4).map(item => ({ worker: item.worker.slice(0, 80), question: item.question.slice(0, 400) })),
	}).trim();
}

export type WaitChainDemand = { key: string; action: string; churn: true; row: string; edges: Array<{ task: string; dependency: string }> };

/** Review logical edges, not resource ordering. Traverse through every open descendant. */
export function waitChainDemands(phases: TodoScheduleInput): WaitChainDemand[] {
	const rows = phases.flatMap(phase => phase.tasks).filter(row => row.status !== "completed" && row.status !== "abandoned" && !row.schedule?.auditOrigin?.supersededAt);
	const churnRows = new Set(actionableChurnRows(phases).map(row => row.row));
	return rows.flatMap(head => {
		if (unfinishedDependencyChains(phases, head.content).length) return [];
		const churn = churnRows.has(head.content);
		const afterWorker = todoRowAfterWorker(head);
		if (!churn && !(afterWorker?.kind === "needs-worker" && afterWorker.reason === "audit-failed")) return [];
		const reached = new Set([head.content]);
		const edges: WaitChainDemand["edges"] = [];
		for (let changed = true; changed;) {
			changed = false;
			for (const row of rows) {
				if (reached.has(row.content)) continue;
				if (!(row.schedule?.dependencies ?? []).some(dep => reached.has(dep))) continue;
				reached.add(row.content);
				changed = true;
			}
		}
		for (const row of rows) for (const dependency of row.schedule?.dependencies ?? []) {
			if (row.content !== head.content && reached.has(row.content) && reached.has(dependency)) edges.push({ task: row.content, dependency });
		}
		// At least two rows including the head; cycles cannot inflate the count.
		if (reached.size < 2) return [];
		edges.sort((a, b) => a.task.localeCompare(b.task) || a.dependency.localeCompare(b.dependency));
		const key = `chain:${Bun.hash(JSON.stringify([head.content, edges])).toString(16)}`;
		return [{ key, edges, row: head.content, churn: true as const,
			action: prompt.render(chainInstructions, { head: head.content, edges, key }).trim() }];
	});
}

export function waitChainAction(
	demand: WaitChainDemand,
	toolName: string,
	input: { op?: string; isolated?: boolean; tasks?: Array<{ name?: string; task?: string; isolated?: boolean }> } | undefined,
	before: TodoScheduleInput,
	after: TodoScheduleInput,
): boolean {
	const rows = after.flatMap(phase => phase.tasks);
	if (toolName === "task") return input?.tasks?.some(task => demand.edges.some(edge => {
		const row = rows.find(row => row.content === edge.task);
		return (task.task === edge.task || (!!row?.schedule?.owner && task.name === row.schedule.owner)) && (task.isolated ?? input.isolated) === true && row !== undefined && row.status !== "blocked" &&
			(row?.schedule?.dependencies ?? []).every(dep => rows.some(other => other.content === dep && (other.status === "completed" || other.status === "abandoned")));
	})) ?? false;
	if (toolName !== "todo") return false;
	const previous = before.flatMap(phase => phase.tasks);
	return demand.edges.some(edge => {
		const row = rows.find(row => row.content === edge.task);
		const prior = previous.find(row => row.content === edge.task);
		return prior?.schedule?.dependencies?.includes(edge.dependency) && row !== undefined && !row.schedule?.dependencies?.includes(edge.dependency);
	});
}

/** Explicit refusal is persisted on the head, and must explain every reviewed link. */
export function waitChainRejection(demand: WaitChainDemand, phases: TodoScheduleInput): string | undefined {
	const head = phases.flatMap(phase => phase.tasks).find(row => row.content === demand.row);
	// Audit handoff retains schedule evidence after progress moves on to the audit result.
	return [...(head?.schedule?.dependencyReviews?.[demand.key] ?? []), head?.schedule?.progress?.evidence, head?.schedule?.audit?.evidence].find(reason =>
		reason?.startsWith(`Dependency review ${demand.key}:`) &&
		demand.edges.every(edge => reason.split("\n").some(line => line.startsWith(`${edge.task} <- ${edge.dependency}: `) && line.slice(`${edge.task} <- ${edge.dependency}: `.length).trim().length > 0)));
}

/** Dates are always included so a finish after midnight cannot look earlier than the baseline. */
export function renderCurrentSetForecast(plan: TodoPlanForecast, anchor: DeadlineState | null, now: number): string {
	const stamp = (value: number | undefined) => value === undefined ? "unknown" : formatLocalTimestamp(value, anchor?.timezone);
	const point = plan.unresolvedCount ? undefined : plan.rawP50Finish;
	const upper = plan.unresolvedCount ? undefined : plan.calibratedUpperFinish;
	const coverage = plan.calibrationCoverage;
	const empirical = plan.calibrationStatus === "sufficient" && upper !== undefined
		? `${stamp(upper)} (experimental; observed coverage ${coverage?.covered ?? 0}/${coverage?.total ?? 0}, ${plan.calibrationSessions} sessions)`
		: `unavailable (insufficient calibration; ${plan.calibrationOrigins ?? 0} origins, ${plan.calibrationSessions ?? 0} sessions)`;
	const allowance = upper !== undefined && point !== undefined ? Math.max(0, upper - point) / 3_600_000 : undefined;
	const baseline = anchor?.baselineDeadlineAt;
	const lateMinutes = planSlipMinutes(baseline === undefined ? undefined : baseline * 1_000, now);
	const endpoint = plan.rows.filter(row => row.status !== "completed" && row.status !== "abandoned" && row.expectedResourceFinish !== undefined)
		.sort((a, b) => b.expectedResourceFinish! - a.expectedResourceFinish!)[0];
	const title = endpoint?.content.match(/^Collateral for "[^"]*"/)?.[0] ?? endpoint?.content.split(/\r?\n/, 1)[0];
	const driver = endpoint ? `${truncateToWidth(singleLine(title ?? endpoint.content), 80).slice(0, 80)}${endpoint.owner ? ` (owner ${singleLine(endpoint.owner)})` : ""}` : "unknown";
	return [
		`Current set: point ${stamp(point)}; empirical upper ${empirical}.${plan.capacityAssumptions?.executableObserved === false ? " Conditional on executable worker capacity." : ""}`,
		`Driver: ${driver}; empirical allowance ${allowance === undefined ? "unknown" : `${allowance.toFixed(2)}h`}.`,
		baseline === undefined ? "Original baseline unknown." : `Original ${anchor?.auto ? "initial forecast" : "baseline"} ${stamp(baseline * 1_000)}, now ${lateMinutes}m late.`,
		`Scope since anchor: genuine additions unknown; ${anchor?.autoScopeGrowthRows?.length ?? 0} labels with unknown split/addition lineage.`,
		`External gate: ${plan.unresolvedCount ? "unknown; forecast conditional on unresolved work" : "none recorded"}.`,
	].join(" ");
}
