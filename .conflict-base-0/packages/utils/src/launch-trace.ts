import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise } from "node:util/types";
import * as logger from "./logger";
import { pushLoopPhase, popLoopPhase, withLoopPhase, setLoopPhaseFallback } from "./loop-phase";

interface Span {
	name: string;
	count: number;
	wallMs: number;
	/** Synchronous prefix only; excludes uninstrumented continuations. */
	syncPrefixMs: number;
	startOffsetMs: number;
	endOffsetMs: number;
}
interface Boundary {
	name: string;
	kind: "start" | "end";
	offsetMs: number;
	token: object;
}
interface Gap {
	startOffsetMs: number;
	wallMs: number;
	before: string;
	after: string;
}
interface LagSample {
	startOffsetMs: number;
	driftMs: number;
}
interface Trace {
	spans: Map<string, Span>;
	identity: Record<string, string | number>;
	started: number;
	metrics: Record<string, number>;
	overflow: number;
	closed: boolean;
	boundary: Boundary;
	boundaryGaps: Gap[];
	boundaryGapMs: number;
	leafIntervalMs: number;
	gapCount: number;
	lagSamples: LagSample[];
	lagCount: number;
	lagDeadline: number;
	lagTimer?: Timer;
}
interface Scope {
	trace?: Trace;
	depth?: number;
}
const storage = new AsyncLocalStorage<Scope>();
interface PendingPhase {
	trace: Trace;
	name: string;
	start: number;
	end: number;
	depth: number;
}
const pendingPhases = new Set<PendingPhase>();
const completedPhases: PendingPhase[] = [];

/** Wall-overlap candidates, not CPU attribution. Drained once per watchdog tick. */
export function takeLaunchPhaseCandidates(start: number, end: number): string[] {
	const phases = [...completedPhases.splice(0), ...pendingPhases];
	const relevant = phases
		.filter(phase => phase.start < end && phase.end > start)
		.sort((a, b) => b.depth - a.depth || a.start - b.start);
	return [...new Set(relevant.map(phase => phase.name))].slice(0, 3);
}
setLoopPhaseFallback((start, end) => {
	const candidates = takeLaunchPhaseCandidates(start, end);
	return candidates.length ? `launch-overlap:${candidates.join("|")}` : undefined;
});
const maxSpans = 256;
const maxName = 160;
// Boundary intervals partition wall time. A direct start/end pair is inside a
// leaf span; every other interval is a boundary gap. Gaps can still be inside
// an inclusive async span: they do not prove CPU work or an uninstrumented await.
const maxSamples = 16;
const lagIntervalMs = 100;
function boundary(trace: Trace, name: string, kind: "start" | "end", token: object, now: number): void {
	const previous = trace.boundary;
	const offsetMs = now - trace.started;
	const wallMs = offsetMs - previous.offsetMs;
	if (previous.kind === "start" && kind === "end" && previous.token === token) {
		trace.leafIntervalMs += wallMs;
	} else if (wallMs > 0) {
		trace.boundaryGapMs += wallMs;
		trace.gapCount++;
		trace.boundaryGaps.push({
			startOffsetMs: previous.offsetMs,
			wallMs,
			before: `${previous.name}:${previous.kind}`,
			after: `${name}:${kind}`,
		});
		trace.boundaryGaps.sort((a, b) => b.wallMs - a.wallMs);
		trace.boundaryGaps.length = Math.min(trace.boundaryGaps.length, maxSamples);
	}
	trace.boundary = { name, kind, token, offsetMs };
}
function sampleLag(trace: Trace, now: number): void {
	if (now < trace.lagDeadline) return;
	trace.lagCount++;
	trace.lagSamples.push({ startOffsetMs: trace.lagDeadline - trace.started, driftMs: now - trace.lagDeadline });
	trace.lagSamples.sort((a, b) => b.driftMs - a.driftMs);
	trace.lagSamples.length = Math.min(trace.lagSamples.length, maxSamples);
}
function armLagProbe(trace: Trace): void {
	trace.lagDeadline = performance.now() + lagIntervalMs;
	trace.lagTimer = setTimeout(() => {
		if (trace.closed) return;
		sampleLag(trace, performance.now());
		armLagProbe(trace);
	}, lagIntervalMs);
	trace.lagTimer.unref();
}
/** Names only the synchronous prefix: no process-global label survives an await. */
export async function withAsyncLoopPhase<T>(label: string, fn: () => Promise<T>): Promise<T> {
	return withLoopPhase(label.slice(0, maxName), fn);
}

/** Records one bounded launch summary, also on failure. Nested callers share it. */
export async function runLaunchTrace<T>(identity: Record<string, string | number>, fn: () => Promise<T>): Promise<T> {
	const parent = storage.getStore()?.trace;
	if (parent && !parent.closed) return fn();
	const started = performance.now();
	const trace: Trace = {
		spans: new Map(),
		identity: Object.fromEntries(
			Object.entries(identity)
				.slice(0, 8)
				.map(([key, value]) => [key.slice(0, 40), typeof value === "string" ? value.slice(0, maxName) : value]),
		),
		started,
		metrics: Object.create(null) as Record<string, number>,
		overflow: 0,
		closed: false,
		boundary: { name: "launch", kind: "start", offsetMs: 0, token: {} },
		boundaryGaps: [],
		boundaryGapMs: 0,
		leafIntervalMs: 0,
		gapCount: 0,
		lagSamples: [],
		lagCount: 0,
		lagDeadline: started + lagIntervalMs,
	};
	armLagProbe(trace);
	return storage.run({ trace }, async () => {
		let failed = true;
		try {
			const result = await withAsyncLoopPhase("subagent.launch", fn);
			failed = false;
			return result;
		} finally {
			finishLaunchTrace(failed);
		}
	});
}

/** Close once at readiness. Later task execution and cleanup cannot inflate launch time.
 * All durations are milliseconds. Wall totals include nested/overlapping steps,
 * so summing them does not yield elapsed launch time or CPU work.
 */
export function finishLaunchTrace(failed = false): void {
	const trace = storage.getStore()?.trace;
	if (!trace || trace.closed) return;
	trace.closed = true;
	const ended = performance.now();
	clearTimeout(trace.lagTimer);
	sampleLag(trace, ended);
	boundary(trace, "launch", "end", trace, ended);
	const totalMs = ended - trace.started;
	for (const phase of pendingPhases) {
		if (phase.trace !== trace) continue;
		phase.end = ended;
		pendingPhases.delete(phase);
		if (completedPhases.length === maxSpans) completedPhases.shift();
		completedPhases.push(phase);
	}
	const spans = [...trace.spans.values()];
	logger.debug("subagent launch spans", {
		...trace.identity,
		totalMs,
		failed,
		unit: "ms",
		spans,
		boundaryGaps: trace.boundaryGaps,
		boundaryGapMs: trace.boundaryGapMs,
		leafIntervalMs: trace.leafIntervalMs,
		gapCount: trace.gapCount,
		loopLag: { intervalMs: lagIntervalMs, count: trace.lagCount, samples: trace.lagSamples },
		metrics: trace.metrics,
		overflow: trace.overflow,
	});
	if (totalMs > 2000)
		logger.warn("subagent launch slow", {
			...trace.identity,
			totalMs,
			failed,
			top: spans.sort((a, b) => b.wallMs - a.wallMs).slice(0, 3),
		});
}

function recordSpan(trace: Trace, name: string, wallMs: number, syncPrefixMs: number, started: number): void {
	const previous = trace.spans.get(name);
	if (previous) {
		previous.startOffsetMs = Math.min(previous.startOffsetMs, started - trace.started);
		previous.endOffsetMs = Math.max(previous.endOffsetMs, started + wallMs - trace.started);
		previous.count++;
		previous.wallMs += wallMs;
		previous.syncPrefixMs += syncPrefixMs;
		return;
	}
	if (trace.spans.size >= maxSpans) {
		trace.overflow++;
		let smallest: Span | undefined;
		for (const span of trace.spans.values()) {
			if (!smallest || span.wallMs < smallest.wallMs) smallest = span;
		}
		if (!smallest || smallest.wallMs >= wallMs) return;
		trace.spans.delete(smallest.name);
	}
	trace.spans.set(name, {
		name,
		count: 1,
		wallMs,
		syncPrefixMs,
		startOffsetMs: started - trace.started,
		endOffsetMs: started + wallMs - trace.started,
	});
}

/** Wall duration, inclusive of nested steps. `.wait` labels identify explicit waits. */
export function launchStep<T, A extends unknown[]>(name: string, fn: (...args: A) => T, ...args: A): T {
	const trace = storage.getStore()?.trace;
	if (!trace || trace.closed) return withLoopPhase(name.slice(0, maxName), () => fn(...args));
	const label = name.slice(0, maxName);
	const started = performance.now();
	const token = {};
	boundary(trace, label, "start", token, started);
	let syncPrefixMs = 0;
	const finish = () => {
		const ended = performance.now();
		if (pendingPhases.delete(phase)) {
			phase.end = ended;
			if (completedPhases.length === maxSpans) completedPhases.shift();
			completedPhases.push(phase);
		}
		if (trace.closed) return;
		boundary(trace, label, "end", token, ended);
		recordSpan(trace, label, ended - started, syncPrefixMs, started);
	};
	const depth = (storage.getStore()?.depth ?? 0) + 1;
	const phase: PendingPhase = { trace, name: label, start: started, end: Number.POSITIVE_INFINITY, depth };
	if (pendingPhases.size < maxSpans) pendingPhases.add(phase);
	const scope: Scope = { trace, depth };
	try {
		const result = storage.run(scope, () => withLoopPhase(label, () => fn(...args)));
		syncPrefixMs = performance.now() - started;
		if (isPromise(result)) {
			return result.finally(() => {
				finish();
			}) as T;
		}
		finish();
		return result;
	} catch (error) {
		syncPrefixMs = performance.now() - started;
		finish();
		throw error;
	}
}

export function launchMetric(name: string, value: number): void {
	const trace = storage.getStore()?.trace;
	if (!trace || trace.closed || !Number.isFinite(value)) return;
	const key = name.slice(0, maxName);
	if (Object.hasOwn(trace.metrics, key) || Object.keys(trace.metrics).length < maxSpans) trace.metrics[key] = value;
	else trace.overflow++;
}

logger.setTimingObserver(launchStep);

/** Time a constructor without an extra async boundary. */
export function launchConstruct<T, A extends unknown[]>(name: string, ctor: new (...args: A) => T, ...args: A): T {
	return launchStep(name, () => new ctor(...args));
}

/** Synchronous functions only: dispose before any await or async return boundary. */
export function launchScope(name: string): Disposable {
	const trace = storage.getStore()?.trace;
	const label = name.slice(0, maxName);
	const started = trace && !trace.closed ? performance.now() : undefined;
	const token = {};
	if (trace && !trace.closed && started !== undefined) boundary(trace, label, "start", token, started);
	pushLoopPhase(label);
	return {
		[Symbol.dispose]() {
			popLoopPhase();
			if (trace && !trace.closed && started !== undefined) {
				const elapsed = performance.now() - started;
				boundary(trace, label, "end", token, started + elapsed);
				recordSpan(trace, label, elapsed, elapsed, started);
			}
		},
	};
}
