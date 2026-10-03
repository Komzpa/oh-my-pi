import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogsDir, popLoopPhase, pushLoopPhase } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

export const DEFAULT_FRAME_DROP_THRESHOLD_MS = 250;
const WINDOW_MS = 5_000;
const STATUS_UPDATE_MS = 1_000;
const STACK_LINE_LIMIT = 5;
const LOG_FILE_PATTERN = /^omp\.\d{4}-\d{2}-\d{2}\.\d+\.log(?:\.\d+)?$/;

export interface FrameTelemetrySnapshot {
	readonly fps: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly maxMs: number;
	readonly lagMs: number;
	readonly text: string;
}

export interface FrameDropEvent {
	readonly kind: "frame-gap" | "loop-block";
	readonly durationMs: number;
	readonly cpuMs?: number;
	readonly phase: string;
	readonly lastInputAtMs?: number;
	readonly msSinceLastInput?: number;
	readonly renderTarget?: string;
	readonly handling?: string;
	readonly stack?: string;
}

interface FrameSample {
	readonly atMs: number;
	readonly renderMs: number;
	readonly lagMs: number;
}

export interface FrameTelemetryOptions {
	readonly now?: () => number;
	readonly dateNow?: () => number;
	readonly thresholdMs?: number;
	readonly loggerWarn?: (message: string, context?: Record<string, unknown>) => void;
}

export class FrameTelemetry {
	#now: () => number;
	#dateNow: () => number;
	#thresholdMs: number;
	#loggerWarn: (message: string, context?: Record<string, unknown>) => void;
	#samples: FrameSample[] = [];
	#lastFrameAtMs: number | undefined;
	#lastFrameStartedAtMs: number | undefined;
	#lastInputAtMs: number | undefined;
	#handling: string | undefined;
	#renderTarget: string | undefined;
	#phaseStack: string[] = [];
	#lastStatusUpdateMs = Number.NEGATIVE_INFINITY;
	#lastStatusText = "";
	#snapshot: FrameTelemetrySnapshot = {
		fps: 0,
		p50Ms: 0,
		p95Ms: 0,
		maxMs: 0,
		lagMs: 0,
		text: "0fps p50 0ms p95 0ms max 0ms lag 0ms",
	};
	#listeners = new Set<(text: string) => void>();

	constructor(options: FrameTelemetryOptions = {}) {
		this.#now = options.now ?? (() => performance.now());
		this.#dateNow = options.dateNow ?? (() => Date.now());
		this.#thresholdMs = options.thresholdMs ?? DEFAULT_FRAME_DROP_THRESHOLD_MS;
		this.#loggerWarn = options.loggerWarn ?? logger.warn;
	}

	get thresholdMs(): number {
		return this.#thresholdMs;
	}

	setThresholdMs(thresholdMs: number): void {
		if (Number.isFinite(thresholdMs) && thresholdMs > 0) this.#thresholdMs = thresholdMs;
	}

	get statusText(): string {
		return this.#snapshot.text;
	}

	get snapshot(): FrameTelemetrySnapshot {
		return this.#snapshot;
	}

	onStatusTextChange(listener: (text: string) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	recordInput(label = "key"): void {
		this.#lastInputAtMs = this.#dateNow();
		this.#handling = label;
	}

	beginRender(target: string): void {
		this.#renderTarget = target;
		this.#lastFrameStartedAtMs = this.#now();
		this.pushPhase(`render:${target}`);
	}

	endRender(target: string, rendered: boolean): void {
		const now = this.#now();
		const startedAt = this.#lastFrameStartedAtMs ?? now;
		const phase = this.currentPhase();
		const stack = this.phaseStackTop();
		this.popPhase();
		this.#lastFrameStartedAtMs = undefined;
		this.#renderTarget = undefined;
		if (!rendered) return;

		const renderMs = Math.max(0, now - startedAt);
		const gapMs = this.#lastFrameAtMs === undefined ? 0 : Math.max(0, now - this.#lastFrameAtMs);
		const lagMs = Math.max(0, gapMs - renderMs);
		this.#lastFrameAtMs = now;
		this.#samples.push({ atMs: now, renderMs, lagMs });
		this.#trim(now);
		if (gapMs > this.#thresholdMs) {
			this.logDrop({
				kind: "frame-gap",
				durationMs: gapMs,
				phase,
				renderTarget: target,
				stack,
			});
		}
		this.#refreshStatus(now);
	}

	logLoopBlock(blockedMs: number, cpuMs: number, phase: string): void {
		this.logDrop({
			kind: "loop-block",
			durationMs: blockedMs,
			cpuMs,
			phase,
			renderTarget: this.#renderTarget,
			handling: this.#handling,
			stack: this.phaseStackTop(),
		});
	}

	logDrop(event: FrameDropEvent): void {
		const lastInputAtMs = event.lastInputAtMs ?? this.#lastInputAtMs;
		const context: Record<string, unknown> = {
			kind: event.kind,
			durationMs: Math.round(event.durationMs),
			phase: event.phase,
		};
		if (event.cpuMs !== undefined) context.cpuMs = Math.round(event.cpuMs);
		if (lastInputAtMs !== undefined) {
			context.lastInputAt = new Date(lastInputAtMs).toISOString();
			context.msSinceLastInput = Math.max(0, Math.round(this.#dateNow() - lastInputAtMs));
		}
		const renderTarget = event.renderTarget ?? this.#renderTarget;
		if (renderTarget) context.renderTarget = renderTarget;
		const handling = event.handling ?? this.#handling;
		if (handling) context.handling = handling;
		const stack = event.stack ?? this.phaseStackTop();
		if (stack) context.stack = stack;
		this.#loggerWarn("ui.frame-drop", context);
	}

	pushPhase(phase: string): void {
		pushLoopPhase(phase);
		this.#phaseStack.push(phase);
	}

	popPhase(): void {
		if (this.#phaseStack.length === 0) return;
		this.#phaseStack.pop();
		popLoopPhase();
	}

	currentPhase(): string {
		return this.#phaseStack[this.#phaseStack.length - 1] ?? "unknown";
	}

	phaseStackTop(): string | undefined {
		if (this.#phaseStack.length === 0) return undefined;
		return this.#phaseStack.slice(-STACK_LINE_LIMIT).join(" > ");
	}

	#trim(now: number): void {
		const minAt = now - WINDOW_MS;
		while (this.#samples[0] && this.#samples[0].atMs < minAt) this.#samples.shift();
	}

	#refreshStatus(now: number): void {
		if (now - this.#lastStatusUpdateMs < STATUS_UPDATE_MS) return;
		this.#lastStatusUpdateMs = now;
		const snapshot = this.#buildSnapshot(now);
		if (snapshot.text === this.#lastStatusText) return;
		this.#lastStatusText = snapshot.text;
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) listener(snapshot.text);
	}

	#buildSnapshot(now: number): FrameTelemetrySnapshot {
		this.#trim(now);
		const samples = this.#samples;
		const fps = (samples.length / WINDOW_MS) * 1_000;
		const renderTimes = samples.map(sample => sample.renderMs).sort((a, b) => a - b);
		const p50Ms = percentile(renderTimes, 0.5);
		const p95Ms = percentile(renderTimes, 0.95);
		const maxMs = renderTimes[renderTimes.length - 1] ?? 0;
		const lagMs = samples.reduce((max, sample) => Math.max(max, sample.lagMs), 0);
		const text = `${Math.round(fps)}fps p50 ${formatMs(p50Ms)} p95 ${formatMs(p95Ms)} max ${formatMs(
			maxMs,
		)} lag ${formatLag(lagMs)}`;
		return { fps, p50Ms, p95Ms, maxMs, lagMs, text };
	}
}

function percentile(sorted: readonly number[], quantile: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.ceil(sorted.length * quantile) - 1;
	return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

function formatMs(value: number): string {
	return `${Math.round(value)}ms`;
}

function formatLag(value: number): string {
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}s`;
	return formatMs(value);
}

export const frameTelemetry = new FrameTelemetry();

export interface FrameDropLogEntry {
	readonly timestamp: string;
	readonly pid?: number;
	readonly kind: string;
	readonly durationMs: number;
	readonly cpuMs?: number;
	readonly phase: string;
	readonly lastInputAt?: string;
	readonly msSinceLastInput?: number;
	readonly renderTarget?: string;
	readonly handling?: string;
	readonly stack?: string;
	readonly file: string;
}

export interface FrameDropPhaseSummary {
	readonly phase: string;
	readonly count: number;
	readonly worstMs: number;
	readonly p95Ms: number;
	readonly drops: readonly FrameDropLogEntry[];
}

export async function readRecentFrameDrops(minutes: number, limit = 5): Promise<FrameDropPhaseSummary[]> {
	const cutoff = Date.now() - Math.max(1, minutes) * 60_000;
	const entries = await collectFrameDropEntries(cutoff);
	const byPhase = new Map<string, FrameDropLogEntry[]>();
	for (const entry of entries) {
		const list = byPhase.get(entry.phase) ?? [];
		list.push(entry);
		byPhase.set(entry.phase, list);
	}
	return Array.from(byPhase.entries())
		.map(([phase, drops]) => {
			const durations = drops.map(drop => drop.durationMs).sort((a, b) => a - b);
			const ranked = [...drops].sort((a, b) => b.durationMs - a.durationMs);
			return {
				phase,
				count: drops.length,
				worstMs: durations[durations.length - 1] ?? 0,
				p95Ms: percentile(durations, 0.95),
				drops: ranked.slice(0, limit),
			};
		})
		.sort((a, b) => b.worstMs - a.worstMs || b.count - a.count || a.phase.localeCompare(b.phase));
}

async function collectFrameDropEntries(cutoff: number): Promise<FrameDropLogEntry[]> {
	const logsDir = getLogsDir();
	let files: string[];
	try {
		const dirents = await fs.readdir(logsDir, { withFileTypes: true });
		files = dirents.filter(entry => entry.isFile() && LOG_FILE_PATTERN.test(entry.name)).map(entry => entry.name);
	} catch {
		return [];
	}
	const entries: FrameDropLogEntry[] = [];
	await Promise.all(
		files.map(async file => {
			const filePath = path.join(logsDir, file);
			let text: string;
			try {
				text = await Bun.file(filePath).text();
			} catch {
				return;
			}
			for (const line of text.split("\n")) {
				if (!line.includes('"message":"ui.frame-drop"')) continue;
				const parsed = parseFrameDropLogLine(line, file);
				if (!parsed) continue;
				const at = Date.parse(parsed.timestamp);
				if (Number.isFinite(at) && at >= cutoff) entries.push(parsed);
			}
		}),
	);
	return entries;
}

export function parseFrameDropLogLine(line: string, file = ""): FrameDropLogEntry | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	if (obj.message !== "ui.frame-drop") return null;
	if (typeof obj.timestamp !== "string" || typeof obj.durationMs !== "number") return null;
	return {
		timestamp: obj.timestamp,
		pid: typeof obj.pid === "number" ? obj.pid : undefined,
		kind: typeof obj.kind === "string" ? obj.kind : "unknown",
		durationMs: obj.durationMs,
		cpuMs: typeof obj.cpuMs === "number" ? obj.cpuMs : undefined,
		phase: typeof obj.phase === "string" ? obj.phase : "unknown",
		lastInputAt: typeof obj.lastInputAt === "string" ? obj.lastInputAt : undefined,
		msSinceLastInput: typeof obj.msSinceLastInput === "number" ? obj.msSinceLastInput : undefined,
		renderTarget: typeof obj.renderTarget === "string" ? obj.renderTarget : undefined,
		handling: typeof obj.handling === "string" ? obj.handling : undefined,
		stack: typeof obj.stack === "string" ? obj.stack : undefined,
		file,
	};
}
