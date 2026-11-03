import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { prompt } from "@oh-my-pi/pi-utils";
import { resolveYieldReportText } from "@oh-my-pi/pi-coding-agent/tools/yield";
import continueReminder from "./worker-continue.md" with { type: "text" };

const READ_ONLY_ROLES = new Set([
	"scout",
	"researcher",
	"reviewer",
	"visual-qa",
	"adversary",
	"user-shadow",
	"qa-auditor",
	"security-reviewer",
	"architect",
	"plan-doctor",
	"business-analyst",
	"retro-facilitator",
]);
const PARTIAL =
	/\b(?:partial|not done|incomplete|next I would|remaining(?=\s*:)|checkpoint incomplete|did not commit|ran out|stopping here)\b/i;
const BLOCKER =
	/\b(?:permission denied|sandbox(?:ed| restriction| denial| blocked)?|missing credentials?|credentials? (?:missing|unavailable)|(?:RAM|host|memory)[^.!?\n]{0,60}(?:refus(?:al|ed|es|ing)?|denied|unavailable|exhaust|pressure)|upstream (?:outage|unavailable)|(?:outside|lack|missing|requires?|awaiting)[^.!?\n]{0,40}(?:authority|ownership)|(?:authority|ownership) (?:conflict|boundary|denied)|owner (?:decision|approval) (?:needed|required)|awaiting (?:the )?owner|awaiting lead answer)\b/i;

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

export const MAX_WORKER_REFUSALS = 6;
export const BLOCKER_YIELDS_REQUIRED = 3;
export const GOAL_CAP_ANNOTATION = "goal cap reached; partial";

export interface WorkerContinuationState {
	refusals: number;
	blocker?: string;
	blockerYields: number;
	budgetStopped: boolean;
}

function concreteBlocker(report: string): string | undefined {
	const blockers = report.split(/\n|[.!?](?:\s|$)/).flatMap(rawLine => {
		const line = rawLine.replace(/\s+/g, " ");
		const start = line.search(BLOCKER);
		if (start < 0 || /\b(?:no|without|not|neither)\b[^:;]{0,35}$/i.test(line.slice(0, start))) return [];
		return [
			line
				.slice(start)
				.toLowerCase()
				.replace(/\s+/g, " ")
				.trim()
				.replace(/[.;:]+$/, ""),
		];
	});
	return blockers.length ? [...new Set(blockers)].sort().join("\n") : undefined;
}

/** Pure classification: a partial report needs a concrete external reason to stop. */
export function shouldContinueWorker(report: string, role: string, budgetStop: boolean): boolean {
	return !budgetStop && !READ_ONLY_ROLES.has(role) && PARTIAL.test(report) && !concreteBlocker(report);
}

function dataText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(dataText).join("\n");
	if (value && typeof value === "object") return Object.values(value).map(dataText).join("\n");
	return "";
}

/** A list with evidence per requirement; the worker must verify coverage against its brief. */
function hasCompletionAudit(report: string): boolean {
	const rows = report.split(/\r?\n/).filter(line => /^\s*(?:[-*+] |\d+[.)] )/.test(line));
	return (
		rows.length > 0 &&
		rows.every(
			line =>
				/\b[0-9a-f]{7,40}\b/i.test(line) ||
				/(?:^|[\s`(])(?:\.?\.?\/|~\/)?[a-zA-Z_.@-][\w.@-]*\/[\w./@-]+/.test(line) ||
				/`[^`]+`\s*(?:→|=>|:|—|->)\s*\S/.test(line),
		)
	);
}

/** The synthetic budget-stop path is authoritative; prose in a report is not. */
export function workerYieldRefusal(
	input: unknown,
	ctx: ExtensionContext,
	workers: Map<string, WorkerContinuationState>,
	toolCallId?: string,
): ToolCallEventResult | undefined {
	if (ctx.agent.kind !== "sub" || READ_ONLY_ROLES.has(ctx.agent.name)) return;
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	// Incremental sections are progress, not an attempt to end the worker.
	if (Array.isArray(args.type) && args.type.length > 0) return;
	const state = workers.get(ctx.agent.id) ?? { refusals: 0, blockerYields: 0, budgetStopped: false };
	workers.set(ctx.agent.id, state);
	const messages = buildSessionContext(ctx.sessionManager.getBranch(), undefined, undefined, {
		inFlightToolCallIds: toolCallId ? new Set([toolCallId]) : undefined,
	}).messages;
	state.budgetStopped ||= messages.some(
		message =>
			message.role === "developer" &&
			message.synthetic &&
			/^<system-reminder>\s*(?:Request|Token) budget crossed; in-flight turn stopped → forced wrap-up\./.test(
				messageText(message).trimStart(),
			),
	);
	if (state.budgetStopped) return;
	const prose = toolCallId ? (resolveYieldReportText(messages, toolCallId) ?? "") : "";
	const report = [prose, dataText(args.data), typeof args.error === "string" ? args.error : ""].join("\n");
	const blocker = concreteBlocker(report);
	state.blockerYields = blocker ? (blocker === state.blocker ? state.blockerYields + 1 : 1) : 0;
	state.blocker = blocker;
	if (blocker && state.blockerYields >= BLOCKER_YIELDS_REQUIRED) return;
	const partial = PARTIAL.test(report);
	if (!blocker && !partial && hasCompletionAudit(report)) return;
	if (state.refusals >= MAX_WORKER_REFUSALS) {
		// Error yields bypass success-schema validation and reach the lead as partial,
		// including when the original call was data-less or carried structured data.
		return {
			input: {
				error: `${GOAL_CAP_ANNOTATION}\n${[prose, args.data == null ? "" : typeof args.data === "string" ? args.data : JSON.stringify(args.data), args.error].filter(value => typeof value === "string" && value.trim()).join("\n")}`,
			},
		};
	}
	state.refusals++;
	return {
		block: true,
		reason: prompt.render(continueReminder, { blocker: Boolean(blocker), partial: !blocker && partial }).trim(),
	};
}
