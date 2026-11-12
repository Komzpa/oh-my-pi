import { isRecord } from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionEntry } from "./session-entries";

/** Explicit history references and branch points must survive resume compaction. */
export class ExecutorObservationReferences {
	readonly ids = new Set<string>();
	#previous: string | undefined;

	visit(entry: FileEntry): void {
		if (entry.type === "session") return;
		if (entry.parentId && entry.parentId !== this.#previous) this.ids.add(entry.parentId);
		this.#previous = entry.id;
		if (entry.activeLeafId) this.ids.add(entry.activeLeafId);
		if (entry.type === "compaction") {
			this.ids.add(entry.firstKeptEntryId);
			if (entry.providerReplayThroughEntryId) this.ids.add(entry.providerReplayThroughEntryId);
		}
		if (entry.type === "branch_summary") this.ids.add(entry.fromId);
		if (entry.type === "label") this.ids.add(entry.targetId);
	}
}

function observationKey(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== "user_todo_edit" || !isRecord(entry.data)) return;
	if (entry.data.phases !== undefined) return;
	const edit = entry.data.edit;
	if (!isRecord(edit) || edit.v !== 1 || edit.kind !== "executor" || !isRecord(edit.observation)) return;
	const observation = edit.observation;
	if (
		typeof edit.at !== "number" ||
		!Number.isFinite(edit.at) ||
		typeof observation.workerId !== "string" ||
		typeof observation.startedAt !== "number" ||
		!Number.isFinite(observation.startedAt) ||
		(observation.finishedAt !== undefined &&
			(typeof observation.finishedAt !== "number" || !Number.isFinite(observation.finishedAt))) ||
		(observation.outcome !== undefined &&
			!["completed", "failed", "aborted"].includes(String(observation.outcome))) ||
		(observation.runningWorkerIds !== undefined &&
			(!Array.isArray(observation.runningWorkerIds) ||
				!observation.runningWorkerIds.every(id => typeof id === "string")))
	)
		return;
	return JSON.stringify([
		observation.workerId,
		observation.agentProfile,
		observation.row,
		observation.taskText,
		observation.description,
		observation.runningWorkerIds,
	]);
}

/**
 * Executor observations project the latest worker state; row edits and attempt history
 * are separate records. Collapse only uninterrupted linear runs, keeping the first, latest start and latest
 * observation per worker/assignment and roster. Flush at every history reference and other edit,
 * so historical row views and forks still replay the state at their exact boundary.
 */
export class ExecutorObservationCompactor {
	readonly entries: FileEntry[] = [];
	#pending: SessionEntry | undefined;
	#key: string | undefined;
	#binding: { entry: SessionEntry; startedAt: number } | undefined;
	#parent: string | null = null;
	#previous: string | undefined;

	#last: FileEntry | undefined;

	constructor(
		readonly references: ReadonlySet<string>,
		readonly emit?: (entry: FileEntry, compacted: boolean) => void,
	) {}

	#retain(entry: FileEntry, compacted = false): void {
		this.#last = entry;
		if (this.emit) this.emit(entry, compacted);
		else this.entries.push(entry);
	}

	push(entry: FileEntry): void {
		if (entry.type === "session") {
			this.#retain(entry);
			return;
		}
		const key = observationKey(entry);
		const prior = this.#pending ?? this.#last;
		const before = prior?.type === "custom" && isRecord(prior.data) ? prior.data.edit : undefined;
		const after = entry.type === "custom" && isRecord(entry.data) ? entry.data.edit : undefined;
		// A completion followed by a start of the same attempt can acquire ownership
		// that the completion could not. Do not merge away that transition.
		const restarts =
			isRecord(before) &&
			isRecord(after) &&
			isRecord(before.observation) &&
			isRecord(after.observation) &&
			before.observation.startedAt === after.observation.startedAt &&
			before.observation.finishedAt !== undefined &&
			after.observation.finishedAt === undefined;
		if (
			entry.parentId !== this.#previous ||
			!key ||
			restarts ||
			key !== this.#key ||
			entry.activeLeafId !== undefined ||
			this.references.has(entry.id)
		) {
			this.flush();
			// Keep the first observation too: a start binds ownership even when
			// the final observation is a completion that cannot replace another owner.
			this.#retain(entry);
			this.#key = key;
			this.#parent = entry.id;
		} else {
			const prior = this.#pending ?? this.#last;
			if (prior?.type === "custom" && entry.type === "custom" && isRecord(prior.data) && isRecord(entry.data)) {
				const before = prior.data.edit;
				const after = entry.data.edit;
				if (
					isRecord(before) &&
					isRecord(after) &&
					isRecord(before.observation) &&
					isRecord(after.observation) &&
					before.observation.startedAt === after.observation.startedAt
				) {
					after.observation = { ...before.observation, ...after.observation };
				}
			}
			this.#pending = entry;
		}
		if (key && entry.type === "custom" && isRecord(entry.data)) {
			const edit = entry.data.edit;
			if (isRecord(edit) && isRecord(edit.observation)) {
				const observation = edit.observation;
				if (
					observation.finishedAt === undefined &&
					typeof observation.startedAt === "number" &&
					(!this.#binding || observation.startedAt >= this.#binding.startedAt)
				)
					this.#binding = { entry, startedAt: observation.startedAt };
			}
		}
		this.#previous = entry.id;
	}

	flush(): void {
		if (this.#pending) {
			// An early stale start may not have taken ownership from a newer worker.
			// Keep the newest start that can bind before applying the final completion.
			const binding = this.#binding?.entry;
			if (binding && binding.id !== this.#parent && binding !== this.#pending) {
				binding.parentId = this.#parent;
				this.#retain(binding);
				this.#parent = binding.id;
			}
			this.#pending.parentId = this.#parent;
			this.#retain(this.#pending, true);
			this.#pending = undefined;
		}
		this.#key = undefined;
		this.#binding = undefined;
	}
}
