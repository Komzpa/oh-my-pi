import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
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

/** Pure classification: a partial report needs a concrete external reason to stop. */
export function shouldContinueWorker(report: string, role: string, budgetStop: boolean): boolean {
	if (budgetStop || READ_ONLY_ROLES.has(role) || !PARTIAL.test(report)) return false;
	return !report
		.split(/\n|[.!?](?:\s|$)/)
		.some(
			line =>
				BLOCKER.test(line) &&
				!/\b(?:no|without|not|neither)\b[^:;]{0,35}$/i.test(line.slice(0, line.search(BLOCKER))),
		);
}

/** The current synthetic budget reminder is authoritative; prose in a report is not. */
export function workerYieldRefusal(
	input: unknown,
	ctx: ExtensionContext,
	continuedWorkers: Set<string>,
	toolCallId?: string,
): string | undefined {
	if (ctx.agent.kind !== "sub" || continuedWorkers.has(ctx.agent.id)) return;
	const messages = buildSessionContext(ctx.sessionManager.getBranch(), undefined, undefined, {
		inFlightToolCallIds: toolCallId ? new Set([toolCallId]) : undefined,
	}).messages;
	let budgetStop = false;
	const prose = toolCallId ? (resolveYieldReportText(messages, toolCallId) ?? "") : "";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user") break;
		if (
			message.role === "developer" &&
			message.synthetic &&
			messageText(message)
				.trimStart()
				.startsWith("<system-reminder>\nRequest budget crossed; in-flight turn stopped → forced wrap-up.")
		)
			budgetStop = true;
	}
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	// Incremental sections are progress, not an attempt to end the worker.
	if (Array.isArray(args.type) && args.type.length > 0) return;
	const report = [prose, args.data === undefined ? "" : JSON.stringify(args.data), args.error]
		.filter(value => typeof value === "string")
		.join("\n");
	if (!shouldContinueWorker(report, ctx.agent.name, budgetStop)) return;
	continuedWorkers.add(ctx.agent.id);
	return continueReminder.trim();
}
