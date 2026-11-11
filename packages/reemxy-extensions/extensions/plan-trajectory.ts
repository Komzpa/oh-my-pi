import type { TodoEstimate, TodoScheduleInput, TodoScheduleInputTask } from "@oh-my-pi/pi-tui/tools/todo-schedule";

export interface CriticAction {
	id: string;
	kind: "cut_dependency" | "split" | "cut" | "escalate" | "dispatch";
	row: string;
	dependency?: string;
	reason: string;
}
export interface CriticVerdict {
	converging: boolean;
	criticalPathBlocker: string | null;
	falseDependencies: string[];
	rowsToSplit: string[];
	rowsToCut: string[];
	rowsToEscalate: string[];
	actions: CriticAction[];
}
export interface TrajectorySample {
	at: number;
	open: number;
	active: number;
	done?: number;
	ready: number;
}
export interface TrajectoryDeadline {
	at: number;
	due: number;
	status: string;
}
export interface TrajectoryRow {
	row: string;
	status: string;
	dependencies: string[];
	blocker?: string;
	owner?: string;
	firstEstimate?: TodoEstimate;
	firstObservedEstimate?: TodoEstimate;
	estimate?: TodoEstimate;
	elapsedSeconds: number;
	attempts: number;
	attemptSeconds: number;
	reestimates: number;
	audit?: string;
	evidence?: string;
	launchFailures: string[];
	postDeadline: boolean;
	workers: { id: string; startedAt?: number; finishedAt?: number; outcome?: string; rejection?: string }[];
	auditHistory: { at: number; verdict: string }[];
}
export interface TrajectoryDigest {
	now: number;
	samples: TrajectorySample[];
	deadlines: TrajectoryDeadline[];
	rows: TrajectoryRow[];
	graphSamples: { at: number; edges: [string, string][] }[];
	omittedRows: number;
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function endpoints<T>(values: T[], count: number): T[] {
	return values.length <= count ? values : [values[0]!, ...values.slice(-(count - 1))];
}
function phasesAt(entry: Record<string, unknown>): TodoScheduleInput | undefined {
	const data = record(entry.data);
	const details = record(record(entry.message)?.details);
	const phases = data?.phases ?? details?.phases;
	return Array.isArray(phases) ? (phases as TodoScheduleInput) : undefined;
}
function rowDigest(task: TodoScheduleInputTask, now: number, baseline?: TodoEstimate): TrajectoryRow {
	const s = task.schedule;
	const attempts = s?.attemptHistory ?? [];
	return {
		row: task.content,
		status: task.status,
		dependencies: s?.dependencies ?? [],
		blocker: task.blocker,
		owner: s?.owner,
		firstEstimate: s?.firstEstimate,
		firstObservedEstimate: baseline,
		estimate: s?.estimate,
		elapsedSeconds: Math.max(0, (now - (s?.firstRequirementAt ?? s?.visibleAt ?? s?.startedAt ?? now)) / 1000),
		attempts: attempts.length,
		attemptSeconds: attempts.reduce((n, a) => n + a.durationMs / 1000, 0),
		reestimates: s?.cumulativeReestimateCount ?? Math.max(s?.reestimateCount ?? 0, (s?.estimateRevision ?? 1) - 1),
		audit: s?.audit?.verdict,
		evidence: s?.progress?.evidence?.slice(0, 500),
		launchFailures: attempts
			.filter(a => a.infraFailureError || a.infraFailureLine)
			.map(a => (a.infraFailureError ?? a.infraFailureLine ?? "").slice(0, 240))
			.slice(-3),
		postDeadline: s?.postDeadline === true,
		workers: [
			...attempts.map(a => ({
				id: a.attemptId,
				startedAt: a.startedAt,
				finishedAt: a.finishedAt,
				outcome: a.terminalStatus,
				rejection: a.rejectionReason?.slice(0, 200),
			})),
			...(s?.executor
				? [
						{
							id: s.executor.workerId,
							startedAt: s.executor.startedAt,
							finishedAt: s.executor.finishedAt,
							outcome: s.executor.outcome,
						},
					]
				: []),
		].slice(-8),
		auditHistory: s?.audit ? [{ at: s.audit.at ?? s.audit.startedAt, verdict: s.audit.verdict }] : [],
	};
}
/** Pure port of progress.py's note accounting and blocked_rows.py's row evidence; no subprocesses. */
export function buildTrajectoryDigest(
	entries: readonly unknown[],
	phases: TodoScheduleInput,
	now: number,
): TrajectoryDigest {
	const samples: TrajectorySample[] = [];
	const deadlines: TrajectoryDeadline[] = [];
	const graphSamples: TrajectoryDigest["graphSamples"] = [];
	const auditHistory = new Map<string, { at: number; verdict: string }[]>();
	const baselines = new Map<string, TodoEstimate>();
	for (const raw of entries) {
		const entry = record(raw);
		if (!entry) continue;
		const at = Date.parse(String(entry.timestamp));
		if (!Number.isFinite(at)) continue;
		const first = String(entry.content ?? "").split("\n", 1)[0]!;
		const todo = /TODO status: (\d+) open · (\d+) active workers · (\d+) ready without/.exec(first);
		if (entry.customType === "todo-dispatch-time-note" && todo)
			samples.push({ at, open: Number(todo[1]), active: Number(todo[2]), ready: Number(todo[3]) });
		const dl = /deadline (\d\d):(\d\d) (on track|at risk|missed)/.exec(first);
		if (entry.customType === "goal-deadline-time-note" && dl) {
			const local = new Date(at + 4 * 3600_000);
			let due = Date.UTC(
				local.getUTCFullYear(),
				local.getUTCMonth(),
				local.getUTCDate(),
				Number(dl[1]) - 4,
				Number(dl[2]),
			);
			if (due < at - 12 * 3600_000) due += 24 * 3600_000;
			deadlines.push({ at, due, status: dl[3]! });
		}
		const snapshot = phasesAt(entry);
		if (snapshot) {
			const edges: [string, string][] = [];
			const tasks = snapshot.flatMap(p => p.tasks);
			samples.push({
				at,
				open: tasks.filter(t => t.status !== "completed" && t.status !== "abandoned").length,
				done: tasks.filter(t => t.status === "completed").length,
				active: tasks.filter(t => t.schedule?.executor && !t.schedule.executor.outcome).length,
				ready: tasks.filter(t => t.status === "pending" && !t.schedule?.dependencies?.length && !t.schedule?.owner)
					.length,
			});
			for (const phase of snapshot)
				for (const task of phase.tasks) {
					if (!baselines.has(task.content) && task.schedule?.estimate)
						baselines.set(task.content, task.schedule.firstEstimate ?? task.schedule.estimate);
					if (task.schedule?.audit) {
						const audit = task.schedule.audit;
						const history = auditHistory.get(task.content) ?? [];
						if (history.at(-1)?.verdict !== audit.verdict)
							history.push({ at: audit.at ?? at, verdict: audit.verdict });
						auditHistory.set(task.content, history.slice(-8));
					}
					for (const dep of task.schedule?.dependencies ?? []) edges.push([task.content, dep]);
				}
			graphSamples.push({ at, edges });
		}
	}
	samples.sort((a, b) => a.at - b.at);
	deadlines.sort((a, b) => a.at - b.at);
	return {
		now,
		samples: endpoints(samples, 32),
		deadlines: endpoints(deadlines, 16),
		graphSamples: endpoints(graphSamples, 3),
		rows: phases
			.flatMap(p => p.tasks)
			.map(t => ({
				...rowDigest(t, now, baselines.get(t.content)),
				...(auditHistory.has(t.content) ? { auditHistory: auditHistory.get(t.content)! } : {}),
			})),
		omittedRows: 0,
	};
}
const open = (row: TrajectoryRow): boolean => row.status !== "completed" && row.status !== "abandoned";
export function trajectoryTriggers(d: TrajectoryDigest): string[] {
	const flags: string[] = [];
	const last = d.samples.at(-1);
	const older = d.samples.filter(s => s.at <= d.now - 90 * 60_000).at(-1);
	const recent = d.samples.filter(s => s.at > d.now - 90 * 60_000);
	if (
		older &&
		recent.length &&
		last &&
		last.open > 0 &&
		recent.every(s => s.open >= older.open) &&
		recent.some(s => s.active > 0)
	)
		flags.push("STALL");
	if (d.deadlines.length && d.deadlines.at(-1)!.due > d.deadlines[0]!.due + 10 * 60_000) flags.push("SLIP");
	if (d.deadlines.length && (d.deadlines[0]!.due < d.now || d.deadlines.at(-1)!.status === "missed"))
		flags.push("MISSED");
	if (d.samples.length && d.samples.filter(s => s.ready > 0).length > d.samples.length / 2) flags.push("IDLE");
	if (d.rows.some(r => open(r) && (r.attempts >= 2 || r.reestimates >= 2))) flags.push("CHURN");
	if (
		d.rows.some(
			r =>
				open(r) &&
				(r.firstEstimate ?? r.firstObservedEstimate ?? r.estimate) &&
				r.elapsedSeconds > (r.firstEstimate ?? r.firstObservedEstimate ?? r.estimate)!.pessimisticSeconds,
		)
	)
		flags.push("OVERDUE");
	if (
		d.rows.some(
			r =>
				open(r) &&
				(r.audit === "fail" ||
					r.audit === "inconclusive" ||
					/^\s*audit (fail|inconclusive)/i.test(r.evidence ?? "")),
		)
	)
		flags.push("AUDIT-FAIL");
	return flags;
}
export function analyzeTrajectory(d: TrajectoryDigest): CriticVerdict {
	const flags = trajectoryTriggers(d);
	const rows = d.rows.filter(open);
	const dependents = (title: string): number => {
		const seen = new Set<string>([title]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const r of rows)
				if (!seen.has(r.row) && r.dependencies.some(dep => seen.has(dep))) {
					seen.add(r.row);
					changed = true;
				}
		}
		return seen.size - 1;
	};
	const troubled = rows.filter(
		r =>
			r.attempts >= 2 ||
			r.reestimates >= 2 ||
			r.audit === "fail" ||
			((r.firstEstimate ?? r.firstObservedEstimate ?? r.estimate) &&
				r.elapsedSeconds > (r.firstEstimate ?? r.firstObservedEstimate ?? r.estimate)!.pessimisticSeconds),
	);
	const ranked = [...troubled].sort((a, b) => dependents(b.row) - dependents(a.row) || b.attempts - a.attempts);
	const actions: CriticAction[] = [];
	for (const row of troubled) {
		const kind = row.blocker && /waits? for (?:the )?user:/i.test(row.blocker) ? "escalate" : "split";
		actions.push({
			id: JSON.stringify([kind, row.row]),
			kind,
			row: row.row,
			reason: `${flags.join(", ")}: ${row.attempts} attempts, ${row.reestimates} reestimates; ${dependents(row.row)} downstream rows. Preserve the requested outcome; separate a shippable piece.`,
		});
	}
	if (!actions.length && flags.length && rows[0])
		actions.push({
			id: JSON.stringify(["escalate", rows[0].row]),
			kind: "escalate",
			row: rows[0].row,
			reason: `${flags.join(", ")}: replan against the original deadline.`,
		});
	return {
		converging: flags.length === 0,
		criticalPathBlocker: ranked[0]?.row ?? null,
		falseDependencies: [],
		rowsToSplit: actions.filter(a => a.kind === "split").map(a => a.row),
		rowsToCut: [],
		rowsToEscalate: actions.filter(a => a.kind === "escalate").map(a => a.row),
		actions,
	};
}
/** Keep old baselines and the latest sample, and disclose omitted rows rather than silently overflowing. */
export function compactTrajectoryDigest(digest: TrajectoryDigest): string {
	const d = structuredClone(digest);
	d.rows.sort((a, b) => Number(open(b)) - Number(open(a)) || b.attempts - a.attempts);
	const bytes = (): number => new TextEncoder().encode(JSON.stringify(d)).byteLength;
	while (bytes() > 12288 && d.graphSamples.length) d.graphSamples.shift();
	while (bytes() > 12288 && d.rows.some(r => r.evidence || r.launchFailures.length)) {
		for (const r of d.rows) {
			r.evidence = undefined;
			r.launchFailures = [];
		}
	}
	while (bytes() > 12288 && d.rows.length) {
		d.rows.pop();
		d.omittedRows++;
	}
	return JSON.stringify(d);
}
