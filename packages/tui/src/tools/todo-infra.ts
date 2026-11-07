import type { TodoReworkAttempt } from "./todo-schedule";

/** Admission records never ran; short harness failures did not perform row work. */
export function todoAttemptIsInfra(attempt: TodoReworkAttempt): boolean {
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
	return history.filter(attempt => !todoAttemptIsInfra(attempt));
}

export function todoInfraBreaker(history: readonly TodoReworkAttempt[] = []): string | undefined {
	const tail = history.slice(-3);
	if (tail.length !== 3 || !tail.every(todoAttemptIsInfra)) return;
	const signature = (attempt: TodoReworkAttempt) => (attempt.infraFailureError ?? "").replace(/\s+/g, " ").trim();
	const cause = signature(tail[0]!);
	if (cause && tail.every(attempt => signature(attempt) === cause)) return cause;
}
