import type { TodoReworkAttempt } from "./todo-schedule";

/** Admission records never ran; short harness failures did not perform row work. */
export function todoAttemptIsInfra(attempt: TodoReworkAttempt): boolean {
	if (attempt.interruption === "restart") return false;
	return (
		attempt.infraFailureLine?.startsWith("infra failure:") === true ||
		(attempt.terminalStatus !== "completed" &&
			attempt.durationMs < 1000 &&
			/\b(?:harness|resource[ -]conflict|spawn[ -]error|gate[ -]refusal)\b|resources? .*conflict|resources .*held by|spawn.*(?:failed|error)|blocked by.*gate/i.test(
				attempt.infraFailureError ?? "",
			))
	);
}

export function todoWorkAttempts(history: readonly TodoReworkAttempt[] = []): TodoReworkAttempt[] {
	return history.filter(attempt => !attempt.interruption && !todoAttemptIsInfra(attempt));
}

export function todoInfraBreaker(history: readonly TodoReworkAttempt[] = []): string | undefined {
	const latest = history.at(-1);
	if (!latest || !todoAttemptIsInfra(latest)) return;
	const signature = (attempt: TodoReworkAttempt) => (attempt.infraFailureError ?? "").replace(/\s+/g, " ").trim();
	const cause = signature(latest);
	if (!cause) return;
	let matches = 0;
	for (let index = history.length - 1; index >= 0; index--) {
		const attempt = history[index]!;
		if (!todoAttemptIsInfra(attempt)) break;
		if (signature(attempt) === cause && ++matches >= 3) return cause;
	}
}
