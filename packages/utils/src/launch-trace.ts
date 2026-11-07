import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise } from "node:util/types";
import * as logger from "./logger";
import { withLoopPhase } from "./loop-phase";

interface Span {
	name: string;
	count: number;
	wallMs: number;
	/** Synchronous prefix only; excludes uninstrumented continuations. */
	syncPrefixMs: number;
}
interface Trace {
	spans: Map<string, Span>;
	identity: Record<string, string | number>;
	started: number;
	metrics: Record<string, number>;
	overflow: number;
	closed: boolean;
}
interface Scope {
	trace?: Trace;
	label: string;
	closed: boolean;
}
const storage = new AsyncLocalStorage<Scope>();
const maxSpans = 256;
const maxName = 160;
/** Names only the synchronous prefix: no process-global label survives an await. */
export async function withAsyncLoopPhase<T>(label: string, fn: () => Promise<T>): Promise<T> {
	return withLoopPhase(label.slice(0, maxName), fn);
}

/** Records one bounded launch summary, also on failure. Nested callers share it. */
export async function runLaunchTrace<T>(identity: Record<string, string | number>, fn: () => Promise<T>): Promise<T> {
	if (storage.getStore()?.trace) return fn();
	const trace: Trace = {
		spans: new Map(),
		identity: Object.fromEntries(
			Object.entries(identity)
				.slice(0, 8)
				.map(([key, value]) => [key.slice(0, 40), typeof value === "string" ? value.slice(0, maxName) : value]),
		),
		started: performance.now(),
		metrics: Object.create(null) as Record<string, number>,
		overflow: 0,
		closed: false,
	};
	return storage.run({ trace, label: "subagent.launch", closed: false }, async () => {
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
	const totalMs = performance.now() - trace.started;
	const spans = [...trace.spans.values()];
	logger.debug("subagent launch spans", {
		...trace.identity,
		totalMs,
		failed,
		unit: "ms",
		spans,
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

function recordSpan(trace: Trace, name: string, wallMs: number, syncPrefixMs: number): void {
	const previous = trace.spans.get(name);
	if (previous) {
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
	trace.spans.set(name, { name, count: 1, wallMs, syncPrefixMs });
}

/** Wall duration, inclusive of nested steps. `.wait` labels identify explicit waits. */
export function launchStep<T>(name: string, fn: () => T): T {
	const trace = storage.getStore()?.trace;
	if (!trace || trace.closed) return withLoopPhase(name.slice(0, maxName), fn);
	const label = name.slice(0, maxName);
	const started = performance.now();
	let syncPrefixMs = 0;
	const finish = () => {
		if (trace.closed) return;
		recordSpan(trace, label, performance.now() - started, syncPrefixMs);
	};
	const scope: Scope = { trace, label, closed: false };
	try {
		const result = storage.run(scope, () => withLoopPhase(label, fn));
		syncPrefixMs = performance.now() - started;
		if (isPromise(result)) {
			return result.finally(() => {
				scope.closed = true;
				finish();
			}) as T;
		}
		scope.closed = true;
		finish();
		return result;
	} catch (error) {
		syncPrefixMs = performance.now() - started;
		scope.closed = true;
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
