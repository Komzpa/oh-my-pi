import * as fs from "node:fs";
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

let cache:
	| {
			file: string;
			stat: fs.Stats;
			offset: number;
			history: DurationHistory;
	  }
	| undefined;

/** Read the router journal; a missing or unreadable file is an empty history, never an error. */
export function readDurationHistory(file: string = defaultStateFile()): DurationHistory {
	const empty: DurationHistory = { samples: [], spawns: new Map() };
	try {
		const stat = fs.statSync(file);
		const sameFile = cache?.file === file && cache.stat.dev === stat.dev && cache.stat.ino === stat.ino;
		if (
			sameFile &&
			cache &&
			cache.stat.mtimeMs === stat.mtimeMs &&
			cache.stat.size === stat.size &&
			cache.stat.ctimeMs === stat.ctimeMs
		)
			return cache.history;
		const append = sameFile && cache && stat.size > cache.stat.size;
		const history: DurationHistory = append ? cache!.history : { samples: [], spawns: new Map() };
		let offset = append ? cache!.offset : 0;
		const fd = fs.openSync(file, "r");
		try {
			// Only complete records advance the cursor: an in-flight append is replayed next time.
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let pending = Buffer.alloc(0);
			let position = offset;
			while (position < stat.size) {
				const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
				if (!count) break;
				position += count;
				const chunk = pending.length
					? Buffer.concat([pending, buffer.subarray(0, count)])
					: buffer.subarray(0, count);
				let start = 0;
				for (let i = 0; i < chunk.length; i++) {
					if (chunk[i] !== 10) continue;
					const line = chunk.toString("utf8", start, i);
					offset += i - start + 1;
					start = i + 1;
					consume(line, history);
				}
				pending = Buffer.from(chunk.subarray(start));
			}
		} finally {
			fs.closeSync(fd);
		}
		cache = { file, stat, offset, history };
		return history;
	} catch {
		cache = undefined;
		return empty;
	}
}

function consume(line: string, history: DurationHistory): void {
	if (!line.trim()) return;
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}
	const role = typeof record.agent === "string" ? record.agent : undefined;
	const key = typeof record.spawnKey === "string" ? record.spawnKey : undefined;
	if (!role || !key) return;
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
