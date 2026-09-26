import type { ToolSession } from "..";
import type { TodoReworkAttempt } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { runSubagentFollowUpTurn } from "./executor";
import type { StructuredSubagentResult } from "./structured-subagent";

const REFLECTION_QUESTION = "What was wrong with your approach, and what should the next attempt do differently?";
const REFLECTION_TIMEOUT_MS = 120_000;

export interface ReworkReflectionResult {
	answer?: string;
	noAnswerReason?: string;
	/** The same worker session, advanced through its reflection turn. */
	resumed?: StructuredSubagentResult;
}

/** Ask the completed worker itself once, without broadcasting a task lifecycle event for this non-attempt turn. */
export async function captureReworkReflection(options: {
	session: ToolSession;
	previous: StructuredSubagentResult;
	reason: string;
	signal?: AbortSignal;
}): Promise<ReworkReflectionResult> {
	const { previous, signal } = options;
	const id = previous.result.id;
	if (previous.result.exitCode !== 0 || previous.result.aborted || previous.result.error) {
		return { noAnswerReason: `worker ${id} did not complete successfully` };
	}
	if (signal?.aborted) return { noAnswerReason: "reflection was cancelled" };
	const timeout = AbortSignal.timeout(REFLECTION_TIMEOUT_MS);
	const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		// The follow-up owner revives this id against the existing JSONL session. Omitting
		// event buses keeps the reflection turn from replacing the row's executor observation.
		// Omitting artifactsDir leaves the accepted attempt's final report intact.
		const result = await runSubagentFollowUpTurn({
			id,
			agent: previous.policy.effectiveAgent,
			message: `${REFLECTION_QUESTION}\n\nThe chief rejected your completed attempt: ${options.reason}\nAnswer the question directly, then answer exactly: "Is there a much simpler different way?" Do not continue implementation. Yield both answers.`,
			modelRole: previous.policy.modelRole,
			maxRuntimeMs: REFLECTION_TIMEOUT_MS,
			signal: boundedSignal,
		});
		if (result.aborted || result.exitCode !== 0 || result.error) {
			return {
				noAnswerReason: timeout.aborted
					? "reflection timed out after 120 seconds"
					: result.error ?? result.abortReason ?? `reflection exited ${result.exitCode}`,
			};
		}
		if (!result.output.trim()) return { noAnswerReason: "worker returned no reflection answer" };
		return {
			answer: result.output,
			resumed: { ...previous, result },
		};
	} catch (error) {
		return {
			noAnswerReason: timeout.aborted
				? "reflection timed out after 120 seconds"
				: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Render an oldest-first, row-local chain without compressing the worker's or chief's words. */
export function renderPreviousAttempts(attempts: readonly TodoReworkAttempt[]): string {
	if (attempts.length === 0) return "";
	const lines = attempts.map((attempt, index) => {
		if (attempt.terminalStatus !== "completed") {
			return attempt.infraFailureLine ?? `attempt ${index + 1} failed: ${attempt.infraFailureError ?? attempt.terminalStatus}`;
		}
		return [
			`Attempt ${index + 1}:`,
			`Worker: ${attempt.workerName}`,
			`Resolved model:effort: ${attempt.resolvedModel}:${attempt.effort}`,
			`Started: ${new Date(attempt.startedAt).toISOString()}`,
			`Finished: ${new Date(attempt.finishedAt).toISOString()}`,
			`Duration: ${attempt.durationMs} ms`,
			`Status: ${attempt.terminalStatus}`,
			`Deliverable paths: ${attempt.deliverablePaths.join(", ") || "(none)"}`,
			`Rejection reason: ${attempt.rejectionReason ?? "(not provided)"}`,
			`Worker reflection: ${attempt.reflectionAnswer ?? `no answer (${attempt.noAnswerReason ?? "unavailable"})`}`,
			`Final report paragraph: ${attempt.finalReportParagraph ?? "(unavailable)"}`,
		].join("\n");
	});
	return attempts.some(attempt => attempt.terminalStatus === "completed")
		? `Previous attempts:\n${lines.join("\n\n")}`
		: lines.join("\n");
}
