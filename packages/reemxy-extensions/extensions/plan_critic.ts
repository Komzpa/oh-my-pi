import { rowRequirementQuotes, requirementConflict } from "./requirement_quotes";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { selectBranchEntriesCooperatively } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import bindingBrief from "./plan-critic-binding.md" with { type: "text" };
import brief from "./plan-critic.md" with { type: "text" };
import {
	analyzeTrajectory,
	buildTrajectoryDigest,
	compactTrajectoryDigest,
	trajectoryTriggers,
} from "./plan-trajectory";

export const PLAN_CRITIC_MIN_MS = 30 * 60_000;
export function planCriticDue(now: number, lastAttempt: number, lastSuccess: number, interval: number, urgent: boolean): boolean {
	return now - lastAttempt >= PLAN_CRITIC_MIN_MS && (urgent || now - lastSuccess >= interval);
}

export const PLAN_CRITIC_ENTRY = "lead-plan-critic";
export interface PlanAction {
	id: string;
	severity?: "blocker" | "later";
	kind: "dispatch" | "cut_dependency" | "split" | "cut" | "escalate";
	row: string;
	dependency?: string;
	newRows?: string[];
	reason: string;
	next: string;
}
export interface PlanVerdict {
	converging: boolean;
	criticalPathBlocker: string | null;
	falseDependencies: Array<{ row: string; dependency: string; reason: string }>;
	split: string[];
	cut: string[];
	escalate: string[];
	actions: PlanAction[];
}
export interface Binding {
	id: string;
	at: number;
	verdict: PlanVerdict;
	addressed: Record<string, { reason: string; toolCallId?: string }>;
	wakes: number;
	leadTurns?: number;
	/** Persisted once-only delivery across session resumes. */
	notified?: boolean;
	trigger?: string;
	/** Row evidence at the time of the decision; absent on legacy journal entries. */
	trajectories?: Record<string, string>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
export function parsePlanVerdict(value: unknown): PlanVerdict | undefined {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return;
		}
	}
	if (
		!object(value) ||
		typeof value.converging !== "boolean" ||
		!(value.criticalPathBlocker === null || text(value.criticalPathBlocker)) ||
		!strings(value.split) ||
		!strings(value.cut) ||
		!strings(value.escalate) ||
		!Array.isArray(value.falseDependencies) ||
		!Array.isArray(value.actions)
	)
		return;
	if (
		!value.falseDependencies.every(
			item => object(item) && text(item.row) && text(item.dependency) && text(item.reason),
		)
	)
		return;
	const actions: PlanAction[] = [];
	for (const action of value.actions) {
		if (
			!object(action) ||
			!text(action.id) ||
			!text(action.row) ||
			!text(action.reason) ||
			!text(action.next) ||
			(action.severity !== undefined && action.severity !== "blocker" && action.severity !== "later") ||
			!["dispatch", "cut_dependency", "split", "cut", "escalate"].includes(String(action.kind)) ||
			(action.kind === "cut_dependency" && !text(action.dependency)) ||
			actions.some(item => item.id === action.id)
		)
			return;
		if (action.kind === "split" && (!strings(action.newRows) || action.newRows.length < 2)) return;
		actions.push(action as unknown as PlanAction);
	}
	if (
		(value.converging && actions.length) ||
		(!value.converging && (!actions.length || !text(value.criticalPathBlocker)))
	)
		return;
	return { ...value, actions } as unknown as PlanVerdict;
}
export function pendingActions(binding: Binding): PlanAction[] {
	return binding.verdict.actions.filter(action => action.severity === "blocker" && action.kind !== "escalate" && !binding.addressed[action.id]);
}
export interface CriticOwnerRunState {
	content: string;
	owner: string | null;
	running: boolean;
	outcome?: string;
}
const chiefRefresh = new WeakMap<ExtensionContext["sessionManager"], () => void>();
const chiefBindings = new WeakMap<ExtensionContext["sessionManager"], Binding>();
/** Projection of the live binding; completed/deleted rows disappear immediately. */
export function chiefCriticFixes(ctx: ExtensionContext): Array<{ row: string; action: string; severity?: number }> {
	if (ctx.agent?.kind === "sub") return [];
	chiefRefresh.get(ctx.sessionManager)?.();
	const binding = chiefBindings.get(ctx.sessionManager);
	if (!binding) return [];
	const rows = ctx.getTodoPhases?.()?.flatMap(phase => phase.tasks) ?? [];
	const verbs = { dispatch: "Staff", cut_dependency: "Unblock", split: "Split", cut: "Cut", escalate: "Decide" };
	return pendingActions(binding).filter(action => {
		const row = rows.find(row => row.content === action.row);
		if (!row || row.status === "completed" || row.status === "abandoned") return false;
		if (action.kind === "cut_dependency" && !row.schedule?.dependencies?.includes(action.dependency!)) return false;
		return true;
	}).map(action => ({ row: action.row, action: verbs[action.kind], ...((binding.leadTurns ?? 0) >= 2 ? { severity: -1 } : {}) }));
}
/** Evidence is a successful native tool call plus its observed plan mutation, never lead prose. */
export function actionObserved(action: PlanAction, before: TodoScheduleInput, after: TodoScheduleInput, run?: CriticOwnerRunState): boolean {
	const oldRows = before.flatMap(phase => phase.tasks);
	const rows = after.flatMap(phase => phase.tasks);
	const previous = oldRows.find(row => row.content === action.row);
	const current = rows.find(row => row.content === action.row);
	if (!previous) return false;
	switch (action.kind) {
		case "cut_dependency":
			return (
				!!current &&
				!!previous.schedule?.dependencies?.includes(action.dependency!) &&
				!current.schedule?.dependencies?.includes(action.dependency!)
			);
		case "dispatch":
			return (
				!!current?.schedule?.executor?.workerId &&
				(run?.running === true || (run ? run.outcome : current.schedule.executor.outcome) === "completed") &&
				(current.schedule.executor.workerId !== previous.schedule?.executor?.workerId ||
					current.schedule.executor.startedAt !== previous.schedule?.executor?.startedAt)
			);
		case "cut":
			return !!current && current.status === "abandoned" && previous.status !== "abandoned";
		case "split":
			return (
				!!action.newRows &&
				action.newRows.length >= 2 &&
				action.newRows.every(
					title => !oldRows.some(row => row.content === title) && rows.some(row => row.content === title),
				) &&
				(!current || current.status === "abandoned" || current.status === "completed")
			);
		case "escalate":
			return false; // Escalations are dropped until a real owner-question path handles them.
	}
}
export function criticInterval(value: string | undefined): number {
	const minutes = value === undefined ? 45 : Number(value);
	if (!Number.isFinite(minutes) || minutes < 30 || minutes > 60)
		throw new Error("OMP_PLAN_CRITIC_MINUTES must be between 30 and 60");
	return minutes * 60_000;
}

/** Omit whole actions rather than truncating an owner's quote into a different meaning. */
export function compactBindingHistory(bindings: Binding[]): string {
	const recent = bindings.slice(-3).reverse().map(item => ({
		id: item.id,
		actions: item.verdict.actions.map(action => ({ ...action, addressed: item.addressed[action.id] })),
		omittedActions: 0,
	}));
	while (new TextEncoder().encode(JSON.stringify(recent)).byteLength > 4096) {
		const oldest = recent.at(-1)!;
		if (recent.length > 1) recent.pop();
		else if (oldest.actions.length) { oldest.actions.pop(); oldest.omittedActions++; }
		else return "[]";
	}
	return JSON.stringify(recent);
}
function rowTrajectories(current: TodoScheduleInput, owners: CriticOwnerRunState[] = []): Record<string, string> {
	const digest = buildTrajectoryDigest([], current, 0);
	return Object.fromEntries(current.flatMap(phase => phase.tasks).map(task => {
		const row = digest.rows.find(item => item.row === task.content)!;
		return [task.content, JSON.stringify({
			task, run: owners.find(item => item.content === task.content),
			attempts: task.schedule?.attemptHistory ?? [], reestimates: row.reestimates,
			audit: task.schedule?.audit, evidence: task.schedule?.progress?.evidence,
			executor: task.schedule?.executor, status: task.status, dependencies: row.dependencies,
			owner: row.owner, blocker: row.blocker,
		})];
	}));
}

export default function planCritic(pi: ExtensionAPI, ownerRunStates: (ctx: ExtensionContext) => CriticOwnerRunState[] = () => []): void {
	// Partial SDK harnesses without tool registration cannot host the critic.
	if (!pi.typebox || !pi.registerTool) return;
	const { Type } = pi.typebox;
	const interval = criticInterval(Bun.env.OMP_PLAN_CRITIC_MINUTES);
	let binding: Binding | undefined;
	let currentContext: ExtensionContext | undefined;
	let history: Binding[] = [];
	let lastSaved = "";
	let lastAttempt = 0;
	let lastSuccess = 0;
	let inFlight = false;
	let generation = 0;
	let lastTrigger = "";
	let timer: Timer | undefined;
	let lastWake = 0;
	const skipped = new Set<string>();
	const skip = (reason: string) => {
		if (skipped.has(reason)) return;
		skipped.add(reason);
		logger.debug("Plan critic skipped", { reason });
		logger.warn("Plan critic skipped", { reason });
	};
	const before = new Map<string, TodoScheduleInput>();
	const phases = (ctx: ExtensionContext): TodoScheduleInput => ctx.getTodoPhases?.() ?? [];
	const main = (ctx: ExtensionContext) => {
		const header = ctx.sessionManager.getHeader();
		return !!header && (ctx.agent ? ctx.agent.kind === "main" : !header.parentSession);
	};
	const save = () => {
		if (!binding) return;
		if (currentContext) chiefBindings.set(currentContext.sessionManager, binding);
		const serialized = JSON.stringify(binding);
		if (serialized === lastSaved) return;
		pi.appendEntry(PLAN_CRITIC_ENTRY, structuredClone(binding));
		lastSaved = serialized;
		history = [...history.filter(item => item.id !== binding!.id), structuredClone(binding)].slice(-3);
	};
	const refresh = () => {
		if (!binding || !currentContext) return;
		const current = phases(currentContext);
		const owners = ownerRunStates(currentContext);
		const snapshots = rowTrajectories(current, owners);
		let changed = false;
		for (const action of binding.verdict.actions) {
			if (binding.addressed[action.id]) continue;
			const row = current.flatMap(phase => phase.tasks).find(row => row.content === action.row);
			const dependency = current.flatMap(phase => phase.tasks).find(row => row.content === action.dependency);
			const run = owners.find(item => item.content === action.row);
			let reason: string | undefined;
			if (action.kind === "escalate") reason = "escalation dropped: requires a concrete owner question through review page and ask";
			else if (!row) reason = "row removed or superseded";
			else if (row.status === "completed" || row.status === "abandoned") reason = `row ${row.status}; custody no longer active`;
			else if (!run?.running && (run ? run.outcome : row.schedule?.executor?.outcome) === "completed") reason = "worker completed and released custody";
			else if (action.kind === "dispatch" && run?.running) reason = "row already staffed";
			else if (action.kind === "cut_dependency" && !row.schedule?.dependencies?.includes(action.dependency!)) reason = "dependency already removed";
			else if (dependency && (dependency.status === "completed" || dependency.status === "abandoned")) reason = "prerequisite no longer blocks the row";
			else if (action.dependency && binding.trajectories?.[action.dependency] !== snapshots[action.dependency]) reason = "prerequisite changed since verdict; regenerate";
			// Failed redispatch changes the trajectory too; it does not satisfy staffing.
			else if (action.kind !== "dispatch" && (!binding.trajectories?.[action.row] || binding.trajectories[action.row] !== snapshots[action.row])) reason = "row or owner run changed since verdict; regenerate";
			if (reason) {
				binding.addressed[action.id] = { reason: `auto-closed: ${reason}` };
				changed = true;
			}
		}
		if (changed) {
			lastSuccess = 0;
			save();
		}
	};
	const notify = (escalated: boolean) => {
		if (!binding || !pendingActions(binding).length || binding.notified || binding.wakes > 0) return;
		pi.sendMessage(
			{
				customType: PLAN_CRITIC_ENTRY,
				display: true,
				content: prompt.render(bindingBrief, {
					verdictId: binding.id,
				}),
				details: { verdictId: binding.id, escalated },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
		binding.notified = true;
	};
	const wake = () => {
		refresh();
		if (!binding || !pendingActions(binding).length || binding.notified || binding.wakes > 0) return;
		notify(false);
		binding.wakes = 1;
		save();
	};
	const tick = async (ctx: ExtensionContext) => {
		if (!main(ctx)) return skip("tick:not-main");
		if (inFlight) return skip("tick:in-flight");
		refresh();
		const now = Date.now();
		const current = structuredClone(phases(ctx));
		const owners = structuredClone(ownerRunStates(ctx));
		if (!current.some(phase => phase.tasks.some(row => row.status !== "completed" && row.status !== "abandoned")))
			return skip("tick:no-open-rows");
		if (binding && pendingActions(binding).length) return skip("tick:pending-actions");
		if (!ctx.runDeliveryCritic) return skip("tick:no-reviewer");
		inFlight = true;
		const token = generation;
		try {
			const entries = await selectBranchEntriesCooperatively(
				ctx.sessionManager,
				metadata =>
					["user_todo_edit", "todo-dispatch-time-note", "goal-deadline-time-note", "requirement-diff-audit", "requirements_ledger"].includes(
						metadata.customType ?? "",
					) ||
					(metadata.messageRole === "toolResult" && metadata.toolName === "todo"),
			);
			const digest = buildTrajectoryDigest(entries, current, now);
			const trigger = JSON.stringify([
				trajectoryTriggers(digest),
				digest.rows.map(row => [row.row, row.attempts, row.reestimates, row.audit, row.dependencies]),
				digest.deadlines.at(-1)?.due,
			]);
			const urgent = trajectoryTriggers(digest).length > 0 && trigger !== lastTrigger;
			if (token !== generation) return skip("tick:session-changed");
			if (!planCriticDue(now, lastAttempt, lastSuccess, interval, urgent)) return skip("tick:not-due");
			lastAttempt = now;
			pi.appendEntry(`${PLAN_CRITIC_ENTRY}-attempt`, { at: now });
			lastTrigger = trigger;
			const requirementAudits = entries.filter(entry => entry.type === "custom" && entry.customType === "requirement-diff-audit")
				.flatMap(entry => "data" in entry && object(entry.data) ? [entry.data] : []);
			const task = prompt.render(brief, {
				digest: compactTrajectoryDigest(digest),
				ownerRunStates: JSON.stringify(owners),
				priorBindings: compactBindingHistory(history),
				requirementAuthority: JSON.stringify(current.flatMap(phase => phase.tasks).map(row => ({
					row: row.content, quotes: rowRequirementQuotes(ctx, row.content, entries), conflict: requirementConflict(row),
					evidence: row.schedule?.progress?.evidence, head: row.schedule?.audit?.head,
					diffAudit: requirementAudits.findLast(data => data.row === row.content &&
						data.head === row.schedule?.audit?.head && data.delivery === row.schedule?.audit?.delivery),
				}))),
				assessment: JSON.stringify({
					converging: analyzeTrajectory(digest).converging,
					criticalPathBlocker: analyzeTrajectory(digest).criticalPathBlocker,
					triggers: trajectoryTriggers(digest),
				}),
			});
			const result = await ctx.runDeliveryCritic(task, AbortSignal.timeout(10 * 60_000), "Plan");
			if (token !== generation) return skip("tick:session-changed");
			const details = result.details as { results?: Array<{ output?: unknown }> } | undefined;
			const verdict = parsePlanVerdict(details?.results?.[0]?.output);
			if (!verdict) throw new Error("Plan critic returned an invalid verdict");
			const titles = new Set(current.flatMap(phase => phase.tasks.map(row => row.content)));
			if (verdict.actions.some(action => !titles.has(action.row)))
				throw new Error("Plan critic named an unknown row");
			for (const action of verdict.actions.filter(action => action.severity !== "blocker")) {
				const row = phases(ctx).flatMap(phase => phase.tasks).find(row => row.content === action.row);
				ctx.updateTodoSchedule?.(action.row, { auditFollowUps: [...new Set([...(row?.schedule?.auditFollowUps ?? []), action.next])] });
			}
			const trajectories = rowTrajectories(current, owners);
			const addressed: Binding["addressed"] = {};
			for (const action of verdict.actions) {
				for (const previous of history.toReversed()) {
					const prior = previous.verdict.actions.find(item => item.kind === action.kind && item.row === action.row);
					const reason = prior && previous.addressed[prior.id]?.reason;
					if (reason && (reason.startsWith("reject: ") || reason.startsWith("previously rejected: ")) &&
						previous.trajectories?.[action.row] === trajectories[action.row]) {
						addressed[action.id] = { reason: reason.startsWith("previously rejected: ") ? reason : `previously rejected: ${reason.slice(8)}` };
						break;
					}
				}
			}
			binding = { id: crypto.randomUUID(), at: now, verdict, addressed, wakes: 0, trigger, trajectories };
			lastSuccess = now;
			lastTrigger = trigger;
			save();
			wake();
		} catch (error) {
			if (token === generation) pi.appendEntry(`${PLAN_CRITIC_ENTRY}-error`, { at: now, error: String(error) });
			logger.warn("Plan critic failed", { error: String(error) });
		} finally {
			if (token === generation) inFlight = false;
		}
	};
	const start = async (_event: unknown, ctx: ExtensionContext) => {
		if (currentContext) chiefRefresh.delete(currentContext.sessionManager);
		currentContext = ctx;
		chiefRefresh.set(ctx.sessionManager, refresh);
		chiefBindings.delete(ctx.sessionManager);
		generation++;
		inFlight = false;
		before.clear();
		binding = undefined;
		history = [];
		lastSaved = "";
		lastAttempt = 0;
		lastSuccess = 0;
		if (timer) {
			ctx.clearTimer(timer);
			timer = undefined;
		}
		if (!main(ctx)) return skip("start:not-main");
		if (typeof ctx.setInterval !== "function") return skip("start:no-timer");
		const token = generation;
		const saved = await selectBranchEntriesCooperatively(
			ctx.sessionManager,
			metadata => metadata.type === "custom" && [PLAN_CRITIC_ENTRY, `${PLAN_CRITIC_ENTRY}-attempt`].includes(metadata.customType ?? ""),
		);
		if (token !== generation) return skip("start:session-changed");
		for (const entry of saved) {
			if (entry.type === "custom" && entry.customType === `${PLAN_CRITIC_ENTRY}-attempt`) {
				lastAttempt = Math.max(lastAttempt, (entry.data as { at: number }).at);
			} else if (entry.type === "custom") {
				binding = entry.data as Binding;
				history = [...history.filter(item => item.id !== binding!.id), binding].slice(-3);
			}
		}
		if (binding) chiefBindings.set(ctx.sessionManager, binding);
		lastSaved = binding ? JSON.stringify(binding) : "";
		lastSuccess = binding?.at ?? 0;
		lastAttempt = Math.max(lastAttempt, lastSuccess);
		lastTrigger = binding?.trigger ?? "";
		lastWake = Date.now();
		timer = ctx.setInterval(() => {
			if (Date.now() - lastWake >= interval) {
				lastWake = Date.now();
				wake();
			}
			void tick(ctx);
		}, 60_000);
		void tick(ctx);
	};
	pi.on("session_start", start);
	pi.on("session_switch", start);
	pi.on("session_branch", start);
	pi.on("session_tree", start);
	pi.on("agent_end", (_event, ctx) => {
		if (main(ctx)) {
			if (binding?.notified && pendingActions(binding).length && (binding.leadTurns ?? 0) < 2) {
				binding.leadTurns = (binding.leadTurns ?? 0) + 1;
				save();
			}
			wake();
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		generation++;
		if (timer) ctx.clearTimer(timer);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (main(ctx)) {
			wake();
			void tick(ctx);
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (!main(ctx)) return;
		refresh();
		if (event.toolName === "todo" || event.toolName === "task")
			before.set(event.toolCallId, structuredClone(phases(ctx)));
		if (binding && pendingActions(binding).length && ["wait", "yield"].includes(event.toolName))
			return {
				block: true,
				reason: `Plan critic ${binding.id} has unaddressed actions: ${pendingActions(binding)
					.map(action => action.id)
					.join(", ")}. Execute or explicitly reject each via plan_critic_action.`,
			};
	});
	pi.on("tool_result", (event, ctx) => {
		const previous = before.get(event.toolCallId);
		before.delete(event.toolCallId);
		if (!main(ctx)) return;
		if (binding && previous && !event.isError) {
			for (const action of pendingActions(binding))
				if (actionObserved(action, previous, phases(ctx), ownerRunStates(ctx).find(run => run.content === action.row)))
					binding.addressed[action.id] = { reason: "Observed native plan mutation", toolCallId: event.toolCallId };
			save();
		}
		if (event.toolName === "todo" || event.toolName === "task") void tick(ctx);
	});
	pi.registerTool({
		name: "plan_critic_action",
		label: "Plan critic action",
		approval: "write",
		loadMode: "essential",
		description:
			"Explicitly reject a plan critic action with a reason. Executed actions are verified automatically from successful todo/task mutations. Escalations are dropped by this critic; they require a real owner-question path.",
		parameters: Type.Object({
			verdictId: Type.String(),
			actionId: Type.String(),
			decision: Type.Union([Type.Literal("reject"), Type.Literal("escalate")]),
			reason: Type.String(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (!main(ctx) || !binding || binding.id !== params.verdictId) throw new Error("Unknown plan critic verdict");
			const action = pendingActions(binding).find(item => item.id === params.actionId);
			if (!action || !params.reason.trim()) throw new Error("Pending action and nonempty reason required");
			if (params.decision === "escalate" && action.kind !== "escalate")
				throw new Error("Only escalation actions accept an owner question");
			if (params.decision === "escalate") throw new Error("Escalations require a real owner question outside the critic");
			binding.addressed[action.id] = { reason: `${params.decision}: ${params.reason}` };
			binding.trajectories = { ...binding.trajectories, [action.row]: rowTrajectories(phases(ctx), ownerRunStates(ctx))[action.row]! };
			save();
			return { content: [{ type: "text", text: JSON.stringify({ remaining: pendingActions(binding) }) }] };
		},
	});
}
