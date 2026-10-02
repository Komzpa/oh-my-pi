import { existsSync, readFileSync, statSync } from "node:fs";
import { defaultStateFile } from "./agent_router";

/**
 * Calibration hints for `todo schedule`. The agent router already persists one `outcome` record per
 * finished worker (role, model, wall-clock duration, status) in its spawn journal; this module only
 * reads that journal, so no second store exists. Durations are per worker session, which is the unit a
 * row's owner runs in.
 */

/** Samples a role/model needs before its history is shown; fewer is noise, not calibration. */
export const CALIBRATION_MIN_SAMPLES = 10;

export interface DurationSample {
	spawnKey: string;
	role: string;
	/** Model without its trailing thinking-level suffix, e.g. `provider/model`. */
	model: string | undefined;
	seconds: number;
}

export interface DurationHistory {
	/** Completed workers only: a cancelled or failed run says nothing about how long the work takes. */
	samples: DurationSample[];
	/** Every spawn seen, completed or not, so an owner id can be resolved to its role before it finishes. */
	spawns: Map<string, { role: string; model: string | undefined }>;
}

export function stripThinkingSuffix(spec: string): string {
	return spec.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "");
}

let cache: { file: string; mtimeMs: number; size: number; history: DurationHistory } | undefined;

/** Read the router journal; a missing or unreadable file is an empty history, never an error. */
export function readDurationHistory(file: string = defaultStateFile()): DurationHistory {
	const empty: DurationHistory = { samples: [], spawns: new Map() };
	try {
		if (!existsSync(file)) return empty;
		const stat = statSync(file);
		if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.history;
		const history: DurationHistory = { samples: [], spawns: new Map() };
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const role = typeof record.agent === "string" ? record.agent : undefined;
			const key = typeof record.spawnKey === "string" ? record.spawnKey : undefined;
			if (!role || !key) continue;
			const modelSpec =
				typeof record.resolvedModel === "string"
					? record.resolvedModel
					: typeof record.chosen === "string"
						? record.chosen
						: undefined;
			const model = modelSpec ? stripThinkingSuffix(modelSpec) : undefined;
			history.spawns.set(key, { role, model });
			if (
				record.kind === "outcome" &&
				record.status === "completed" &&
				typeof record.durationMs === "number" &&
				Number.isFinite(record.durationMs) &&
				record.durationMs > 0
			) {
				history.samples.push({ spawnKey: key, role, model, seconds: record.durationMs / 1000 });
			}
		}
		cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, history };
		return history;
	} catch {
		return empty;
	}
}

export function percentile(sortedAscending: readonly number[], fraction: number): number {
	if (sortedAscending.length === 0) return Number.NaN;
	const index = (sortedAscending.length - 1) * fraction;
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	return sortedAscending[lower]! + (sortedAscending[upper]! - sortedAscending[lower]!) * (index - lower);
}

export interface CalibrationTarget {
	task: string;
	owner: string;
}

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

/**
 * One line per distinct role/model among the rows' owners that has enough history. An owner resolves
 * to the role/model of the worker it names, or, when it names a role itself, to that role's whole
 * history. Rows whose owner is unknown, or whose history is thin, add nothing.
 */
export function calibrationHints(
	targets: readonly CalibrationTarget[],
	history: DurationHistory,
	minSamples: number = CALIBRATION_MIN_SAMPLES,
): string[] {
	const roles = new Set(history.samples.map(sample => sample.role));
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const { owner } of targets) {
		const spawn = history.spawns.get(owner);
		const role = spawn?.role ?? (roles.has(owner) ? owner : undefined);
		if (!role) continue;
		const model = spawn?.model;
		const label = model ? `${role}/${model}` : role;
		if (seen.has(label)) continue;
		seen.add(label);
		const durations = history.samples
			.filter(sample => sample.role === role && (model === undefined || sample.model === model))
			.map(sample => sample.seconds)
			.sort((a, b) => a - b);
		if (durations.length < minSamples) continue;
		lines.push(
			`history for ${label}: median ${minutes(percentile(durations, 0.5))} min, p90 ${minutes(percentile(durations, 0.9))} min (${durations.length} finished runs)`,
		);
	}
	return lines;
}
