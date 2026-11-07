import { rowRequirementQuotes, requirementConflict } from "./requirement_quotes";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { selectBranchEntries } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import bindingBrief from "./plan-critic-binding.md" with { type: "text" };
import brief from "./plan-critic.md" with { type: "text" };
import {
	analyzeTrajectory,
	buildTrajectoryDigest,
	compactTrajectoryDigest,
	trajectoryTriggers,
} from "./plan-trajectory";

export const PLAN_CRITIC_ENTRY = "lead-plan-critic";
export interface PlanAction {
	id: string;
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
	trigger?: string;
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
	return binding.verdict.actions.filter(action => !binding.addressed[action.id]);
}
/** Evidence is a successful native tool call plus its observed plan mutation, never lead prose. */
export function actionObserved(action: PlanAction, before: TodoScheduleInput, after: TodoScheduleInput): boolean {
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
			return false; // A concrete question must be explicitly recorded by the binding tool.
	}
}
export function criticInterval(value: string | undefined): number {
	const minutes = value === undefined ? 45 : Number(value);
	if (!Number.isFinite(minutes) || minutes < 30 || minutes > 60)
		throw new Error("OMP_PLAN_CRITIC_MINUTES must be between 30 and 60");
	return minutes * 60_000;
}

export default function planCritic(pi: ExtensionAPI): void {
	const { Type } = pi.typebox;
	const interval = criticInterval(Bun.env.OMP_PLAN_CRITIC_MINUTES);
	let binding: Binding | undefined;
	let lastAttempt = 0;
	let lastSuccess = 0;
	let inFlight = false;
	let generation = 0;
	let lastTrigger = "";
	let timer: Timer | undefined;
	const before = new Map<string, TodoScheduleInput>();
	const phases = (ctx: ExtensionContext): TodoScheduleInput => ctx.getTodoPhases?.() ?? [];
	const main = (ctx: ExtensionContext) => {
		const header = ctx.sessionManager.getHeader();
		return !!header && !header.parentSession;
	};
	const save = () => {
		if (binding) pi.appendEntry(PLAN_CRITIC_ENTRY, structuredClone(binding));
	};
	const notify = (escalated: boolean) => {
		if (!binding || !pendingActions(binding).length) return;
		pi.sendMessage(
			{
				customType: PLAN_CRITIC_ENTRY,
				display: true,
				content: prompt.render(bindingBrief, {
					verdictId: binding.id,
					escalated,
					pending: JSON.stringify(pendingActions(binding)),
				}),
				details: { verdictId: binding.id, escalated },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};
	const wake = () => {
		if (!binding || !pendingActions(binding).length) return;
		binding.wakes++;
		save();
		notify(binding.wakes > 1);
	};
	const tick = async (ctx: ExtensionContext) => {
		if (!main(ctx) || inFlight) return;
		const now = Date.now();
		const current = phases(ctx);
		if (!current.some(phase => phase.tasks.some(row => row.status !== "completed" && row.status !== "abandoned")))
			return;
		if (binding && pendingActions(binding).length) return;
		const entries = selectBranchEntries(
			ctx.sessionManager,
			metadata =>
				["user_todo_edit", "todo-dispatch-time-note", "goal-deadline-time-note"].includes(
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
		if (!urgent && (now - lastAttempt < 60_000 || now - lastSuccess < interval)) return;
		if (!ctx.runDeliveryCritic) return;
		lastAttempt = now;
		lastTrigger = trigger;
		inFlight = true;
		const token = generation;
		try {
			const task = prompt.render(brief, {
				digest: compactTrajectoryDigest(digest),
				requirementAuthority: JSON.stringify(current.flatMap(phase => phase.tasks).map(row => ({ row: row.content, quotes: rowRequirementQuotes(ctx, row.content), conflict: requirementConflict(row), evidence: row.schedule?.progress?.evidence }))),
				assessment: JSON.stringify({
					converging: analyzeTrajectory(digest).converging,
					criticalPathBlocker: analyzeTrajectory(digest).criticalPathBlocker,
					triggers: trajectoryTriggers(digest),
				}),
			});
			const result = await ctx.runDeliveryCritic(task, AbortSignal.timeout(10 * 60_000));
			if (token !== generation) return;
			const details = result.details as { results?: Array<{ output?: unknown }> } | undefined;
			const verdict = parsePlanVerdict(details?.results?.[0]?.output);
			if (!verdict) throw new Error("Plan critic returned an invalid verdict");
			const titles = new Set(current.flatMap(phase => phase.tasks.map(row => row.content)));
			if (verdict.actions.some(action => !titles.has(action.row)))
				throw new Error("Plan critic named an unknown row");
			binding = { id: crypto.randomUUID(), at: now, verdict, addressed: {}, wakes: 0, trigger };
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
	const start = (_event: unknown, ctx: ExtensionContext) => {
		generation++;
		inFlight = false;
		before.clear();
		binding = undefined;
		lastAttempt = 0;
		lastSuccess = 0;
		for (const entry of selectBranchEntries(
			ctx.sessionManager,
			metadata => metadata.type === "custom" && metadata.customType === PLAN_CRITIC_ENTRY,
		)) {
			if (entry.type === "custom") binding = entry.data as Binding;
		}
		lastSuccess = binding?.at ?? 0;
		lastTrigger = binding?.trigger ?? "";
		if (timer) ctx.clearTimer(timer);
		if (!main(ctx)) return;
		timer = ctx.setInterval(() => {
			wake();
			void tick(ctx);
		}, interval);
		void tick(ctx);
	};
	pi.on("session_start", start);
	pi.on("session_switch", start);
	pi.on("session_branch", start);
	pi.on("session_tree", start);
	pi.on("agent_end", (_event, ctx) => {
		if (main(ctx)) wake();
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
				if (actionObserved(action, previous, phases(ctx)))
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
			"Explicitly reject a plan critic action with a reason, or record the concrete owner question for an escalation. Executed actions are verified automatically from successful todo/task mutations.",
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
			if (params.decision === "escalate")
				pi.sendMessage({
					customType: "lead-plan-critic-question",
					display: true,
					content: params.reason,
					details: { verdictId: binding.id, actionId: action.id },
				});
			binding.addressed[action.id] = { reason: `${params.decision}: ${params.reason}` };
			save();
			return { content: [{ type: "text", text: JSON.stringify({ remaining: pendingActions(binding) }) }] };
		},
	});
}
