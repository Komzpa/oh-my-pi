import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoPlanPrediction } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { selectBranchNewestFirst, type BranchSource } from "../session/branch-selection";

export const TODO_PLAN_HISTORY_CUSTOM_TYPE = "todo_plan_prediction";
export interface TodoPlanHistoryRecord {
	prediction: TodoPlanPrediction;
	/** Frozen phase/content/duplicate ordinal; no semantic lineage is inferred. */
	members: string[];
	censoredAt?: number;
}

export function todoPlanMembers(phases: readonly TodoPhase[]): Map<string, { status: string; finishedAt?: number }> {
	const result = new Map<string, { status: string; finishedAt?: number }>();
	const ordinals = new Map<string, number>();
	for (const phase of phases)
		for (const task of phase.tasks) {
			const base = JSON.stringify([phase.name, task.content]);
			const ordinal = ordinals.get(base) ?? 0;
			ordinals.set(base, ordinal + 1);
			result.set(JSON.stringify([phase.name, task.content, ordinal]), {
				status: task.status,
				finishedAt: task.schedule?.finishedAt,
			});
		}
	return result;
}

/** Terminal records are new append-only observations; the original prediction never changes. */
export function settleTodoPlanRecord(
	record: TodoPlanHistoryRecord,
	phases: readonly TodoPhase[],
	now: number,
	reset = false,
): TodoPlanHistoryRecord | undefined {
	if (record.censoredAt !== undefined || record.prediction.observedAt !== undefined) return undefined;
	const rows = todoPlanMembers(phases);
	const members = record.members.map(key => rows.get(key));
	if (reset || members.some(row => !row || row.status === "abandoned")) return { ...record, censoredAt: now };
	if (
		!members.every(
			row =>
				row?.status === "completed" &&
				row.finishedAt !== undefined &&
				row.finishedAt <= now &&
				row.finishedAt >= record.prediction.originAt,
		)
	)
		return undefined;
	return {
		...record,
		prediction: {
			...record.prediction,
			actualFinish: Math.max(...members.map(row => row!.finishedAt!)),
			observedAt: now,
		},
	};
}

const caches = new WeakMap<object, { leaf: unknown; revision?: number; records: Map<string, TodoPlanHistoryRecord> }>();
const keyOf = (record: TodoPlanHistoryRecord): string =>
	`${record.prediction.sessionId}:${Math.floor(record.prediction.originAt / 3_600_000)}`;
export function isTodoPlanHistoryRecord(value: unknown): value is TodoPlanHistoryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as TodoPlanHistoryRecord;
	const p = record.prediction;
	return (
		!!p &&
		typeof p.sessionId === "string" &&
		Number.isFinite(p.originAt) &&
		Number.isFinite(p.rawP50Finish) &&
		typeof p.predictionVersion === "string" &&
		typeof p.membershipFingerprint === "string" &&
		Array.isArray(record.members) &&
		record.members.length > 0 &&
		record.members.every(member => typeof member === "string") &&
		(p.observedAt === undefined || Number.isFinite(p.observedAt)) &&
		(p.actualFinish === undefined || Number.isFinite(p.actualFinish))
	);
}

/** Indexed branch scan only at the mutation owner. Rewind/fork rebuilds from durable records. */
export function readTodoPlanHistory(
	manager: (BranchSource & { bodyRevision?: number }) | undefined,
): TodoPlanHistoryRecord[] {
	if (!manager) return [];
	const cached = caches.get(manager);
	const fresh: TodoPlanHistoryRecord[] = [];
	let leaf: unknown;
	let extendsCache = false;
	for (const entry of selectBranchNewestFirst(
		manager,
		metadata => metadata.type === "custom" && metadata.customType === TODO_PLAN_HISTORY_CUSTOM_TYPE,
	)) {
		leaf ??= entry.id ?? entry;
		if (cached && cached.revision === manager.bodyRevision && (entry.id ?? entry) === cached.leaf) {
			extendsCache = true;
			break;
		}
		if (entry.type === "custom" && isTodoPlanHistoryRecord(entry.data)) fresh.push(structuredClone(entry.data));
	}
	const records = extendsCache ? new Map(cached!.records) : new Map<string, TodoPlanHistoryRecord>();
	for (const record of fresh.reverse()) {
		const key = keyOf(record);
		const previous = records.get(key);
		// A terminal observation may label only the exact immutable origin it references.
		if (
			!previous ||
			(previous.prediction.originAt === record.prediction.originAt &&
				previous.prediction.rawP50Finish === record.prediction.rawP50Finish &&
				previous.prediction.membershipFingerprint === record.prediction.membershipFingerprint &&
				previous.prediction.predictionVersion === record.prediction.predictionVersion &&
				JSON.stringify(previous.members) === JSON.stringify(record.members) &&
				previous.prediction.observedAt === undefined &&
				previous.censoredAt === undefined)
		)
			records.set(key, record);
	}
	caches.set(manager, { leaf, revision: manager.bodyRevision, records });
	return [...records.values()];
}

export function todoPlanCalibrationHistory(
	records: readonly TodoPlanHistoryRecord[],
	now: number,
): TodoPlanPrediction[] {
	return records
		.filter(
			record =>
				record.censoredAt === undefined &&
				record.prediction.originAt < now &&
				record.prediction.observedAt !== undefined &&
				record.prediction.observedAt < now,
		)
		.map(record => ({ ...record.prediction }));
}
