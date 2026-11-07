import type { AssistantRetryRecovery } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "./session-entries";

export const RETRY_RECOVERY_ENTRY = "omp:retry-recovery";

export function retryRecoveryEntryData(
	entry: SessionEntry,
): { entryId: string; retryRecovery: AssistantRetryRecovery } | undefined {
	if (entry.type !== "custom" || entry.customType !== RETRY_RECOVERY_ENTRY) return undefined;
	const data = entry.data as { entryId?: string; retryRecovery?: AssistantRetryRecovery } | undefined;
	if (typeof data?.entryId !== "string" || data.retryRecovery?.kind !== "auto-retry") return undefined;
	return { entryId: data.entryId, retryRecovery: data.retryRecovery };
}

/** Apply branch-local recovery annotations without mutating archival message objects. */
export function projectRetryRecoveries(entries: readonly SessionEntry[]): SessionEntry[] {
	const recoveries = new Map<string, AssistantRetryRecovery>();
	for (const entry of entries) {
		const annotation = retryRecoveryEntryData(entry);
		if (annotation) recoveries.set(annotation.entryId, annotation.retryRecovery);
	}
	return entries.map(entry => {
		const recovery = recoveries.get(entry.id);
		return entry.type === "message" && entry.message.role === "assistant" && recovery
			? { ...entry, message: { ...entry.message, retryRecovery: recovery } }
			: entry;
	});
}
