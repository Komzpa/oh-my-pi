/*
 * Clean-checkout prerequisite: /home/kom/.bun/bin/bun --cwd packages/collab-web scripts/build-tool-views.ts
 * Run: /home/kom/.bun/bin/bun packages/coding-agent/bench/streaming-session-latency.bench.ts
 * A real AgentSession → EventController → InteractiveMode/Composer/TUI replay,
 * with a byte-sink terminal. No provider calls, files, or live user state.
 * Baseline and controlled clone bypass are separate fresh-process invocations:
 *   STREAM_CLONE_VARIANT=skip-reveal /home/kom/.bun/bin/bun packages/coding-agent/bench/streaming-session-latency.bench.ts
 * Optional active-text scaling: STREAM_PRETOOL_BYTES=8388608 (default 3960).
 * The bypass is diagnostic ONLY; it does not edit production code or qualify as a fix.
 */
import { Database } from "bun:sqlite";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Terminal, TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import type { RenderScheduler } from "@oh-my-pi/pi-tui/tui";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const variant = Bun.env.STREAM_CLONE_VARIANT ?? "baseline";
if (variant !== "baseline" && variant !== "skip-reveal") throw new Error(`Unknown variant ${variant}`);
const preToolTargetBytes = Number(Bun.env.STREAM_PRETOOL_BYTES ?? 3960);
if (!Number.isSafeInteger(preToolTargetBytes) || preToolTargetBytes < 100 || preToolTargetBytes > 8 * 1024 * 1024) {
	throw new Error(`Invalid STREAM_PRETOOL_BYTES: ${preToolTargetBytes}`);
}
const HISTORY_COUNT = 96;
const HISTORY_TEXT_BYTES = 192 * 1024;
const PLAN_ROWS = 400;
const SUBAGENTS = 100;
const UPDATES = 60;
const KEYPRESSES = 60;
const WIDTH = 120;
const HEIGHT = 48;
const MIN_BYTES = 10 * 1024 * 1024;

/** Per-event attribution buckets. Populated only by bench-installed wrappers;
 *  production code is untouched. Times are milliseconds on the main thread.
 *    clone         structuredClone of the reveal tool-boundary snapshot (streaming-reveal.ts:314)
 *    deepCompare   Bun.deepEquals against the snapped snapshot (streaming-reveal.ts:304)
 *    renderContent AssistantMessageComponent.updateContent (streaming-reveal.ts:311)
 *    paint         drained scheduleRender callbacks (TUI render tree walk + terminal write)
 *    immediate     drained scheduleImmediate callbacks (the #scheduleRender hop)
 *    other         unattributed delivery+frame residual; may include allocation/GC
 * Heap deltas and explicit full-GC probes are reported separately; neither is a
 * direct count of all allocated bytes or naturally occurring GC pause time. */
type PartitionBucket = {
	clone: number;
	deepCompare: number;
	renderContent: number;
	paint: number;
	immediate: number;
	gcMs: number;
	heapBefore: number;
	heapAfter: number;
	delivery: number;
	frame: number;
	other: number;
};
let activePartition: PartitionBucket | undefined;

class SinkTerminal implements Terminal {
	bytes = 0;
	writes = 0;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(text: string): void {
		this.bytes += Buffer.byteLength(text);
		this.writes++;
	}
	get columns(): number { return WIDTH; }
	get rows(): number { return HEIGHT; }
	get kittyProtocolActive(): boolean { return false; }
	get kittyEnableSequence(): string | null { return null; }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	refreshAppearance(_token?: TerminalAppearanceRequestToken): void {}
	get appearance(): TerminalAppearance | undefined { return undefined; }
}
class DrainScheduler implements RenderScheduler {
	#immediate: Array<() => void> = [];
	#renders = new Map<number, () => void>();
	#next = 0;
	now(): number { return performance.now(); }
	scheduleImmediate(callback: () => void): void { this.#immediate.push(callback); }
	scheduleRender(callback: () => void, _delayMs: number): { cancel(): void } {
		const id = this.#next++;
		this.#renders.set(id, callback);
		return { cancel: () => void this.#renders.delete(id) };
	}
	drain(): number {
		const start = performance.now();
		for (let i = 0; this.#immediate.length || this.#renders.size; i++) {
			if (i > 100) throw new Error("render scheduler did not settle");
			const immediate = this.#immediate.splice(0);
			for (const callback of immediate) {
				const cbStart = performance.now();
				callback();
				if (activePartition) activePartition.immediate += performance.now() - cbStart;
			}
			const renders = [...this.#renders.values()];
			this.#renders.clear();
			for (const callback of renders) {
				const cbStart = performance.now();
				callback();
				if (activePartition) activePartition.paint += performance.now() - cbStart;
			}
		}
		return performance.now() - start;
	}
}
function percentiles(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		n: sorted.length,
		p50: sorted[Math.floor((sorted.length - 1) * 0.5)]!,
		p90: sorted[Math.floor((sorted.length - 1) * 0.9)]!,
		max: sorted.at(-1)!,
	};
}
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "bench",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: Date.now(),
	};
}

const settings = await Settings.init({ inMemory: true, cwd: process.cwd() });
await initTheme("dark");
const manager = SessionManager.inMemory(process.cwd());
const db = new Database(":memory:");
const registry = new ModelRegistry(new AuthStorage(new SqliteAuthCredentialStore(db)));
const model = registry.getAll()[0];
if (!model) throw new Error("Bundled model catalog empty");
const history: AssistantMessage[] = [];
let historyBytes = 0;
for (let index = 0; index < HISTORY_COUNT; index++) {
	// Unique ASCII text per message; count the UTF-8 bytes actually retained in Agent.state.messages.
	const text = `${index.toString().padStart(4, "0")} ${"session transcript, code review and tool output. ".repeat(Math.ceil(HISTORY_TEXT_BYTES / 48))}`.slice(0, HISTORY_TEXT_BYTES);
	const message = assistant([{ type: "text", text }]);
	history.push(message);
	historyBytes += Buffer.byteLength(text);
	manager.appendMessage(message);
}
if (historyBytes < MIN_BYTES) throw new Error(`History too small: ${historyBytes}`);
const phases: TodoPhase[] = [{ name: "Plan", tasks: Array.from({ length: PLAN_ROWS }, (_, i) => ({
	content: `Implement and verify plan row ${i.toString().padStart(3, "0")}`,
	status: i < 40 ? "completed" as const : "pending" as const,
})) }];
const todo: ToolResultMessage<{ op: "init"; phases: TodoPhase[] }> = {
	role: "toolResult", toolCallId: "plan-fixture", toolName: "todo", content: [{ type: "text", text: "Plan initialized" }],
	details: { op: "init", phases }, isError: false, timestamp: Date.now(),
};
manager.appendMessage(todo);
const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: history } });
const session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry: registry, memoryEnabled: false,
	disableExtensionDiscovery: true });
const agents = AgentRegistry.global();
for (let index = 0; index < SUBAGENTS; index++) {
	agents.register({ id: `sub-${index}`, displayName: `Subagent ${index}`, kind: "sub", parentId: "Main",
		status: "parked", session: null, activity: `Plan row ${index}` });
}
const terminal = new SinkTerminal();
const scheduler = new DrainScheduler();
const composer = new Composer({ terminal, tuiOptions: { renderScheduler: scheduler }, preferences: { quiet: true } });
const mode = new InteractiveMode(session, "bench", undefined, undefined, undefined, undefined, undefined, composer);

// Observe the actual structuredClone calls on the main thread. The only optional bypass
// applies to the reveal controller's tool-boundary snapshot (streaming-reveal.ts:278,314).
const realClone = globalThis.structuredClone;
const cloneSamples: Record<string, number[]> = { reveal: [], other: [] };
const cloneCounts: Record<string, number> = { reveal: 0, other: 0 };
globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
	const stack = new Error().stack ?? "";
	const site = stack.includes("streaming-reveal.ts") ? "reveal" : "other";
	cloneCounts[site]++;
	if (site === "reveal" && variant === "skip-reveal") return value;
	const start = performance.now();
	const result = realClone(value, options);
	const ms = performance.now() - start;
	cloneSamples[site].push(ms);
	if (activePartition && site === "reveal") activePartition.clone += ms;
	return result;
}) as typeof structuredClone;

// --- Stall partition instrumentation (bench-only monkey patches; no production edits) ---
// Attribute per message_update event time to the reveal clone, the reveal deep
// comparison, streaming component update, drained paint, and the residual. Heap
// and explicit full-GC probes provide separate allocation/GC-visible observations.
const deepCompareSamples: Array<{ ms: number; site: string }> = [];
const deepCompareCounts: Record<string, number> = { reveal: 0, other: 0 };
const renderContentSamples: Array<{ ms: number; site: string }> = [];
// Bun exposes deepEquals as a writable own property (verified by descriptor check
// in this bench); rebind through a named boundary instead of an inline cast.
const bunMutable: { deepEquals: typeof Bun.deepEquals } = Bun;
const realDeepEquals: typeof Bun.deepEquals = Bun.deepEquals;
const patchedDeepEquals: typeof Bun.deepEquals = (a, b, options) => {
	const start = performance.now();
	const result = realDeepEquals(a, b, options);
	const ms = performance.now() - start;
	if (activePartition) {
		const site = (new Error().stack ?? "").includes("streaming-reveal.ts") ? "reveal" : "other";
		deepCompareCounts[site]++;
		activePartition.deepCompare += ms;
		deepCompareSamples.push({ ms, site });
	}
	return result;
};
bunMutable.deepEquals = patchedDeepEquals;
const realUpdateContent = AssistantMessageComponent.prototype.updateContent;
AssistantMessageComponent.prototype.updateContent = function (
	this: AssistantMessageComponent,
	message: Parameters<AssistantMessageComponent["updateContent"]>[0],
	opts?: Parameters<AssistantMessageComponent["updateContent"]>[1],
) {
	const start = performance.now();
	const result = realUpdateContent.call(this, message, opts);
	const ms = performance.now() - start;
	if (activePartition) {
		activePartition.renderContent += ms;
		const stack = new Error().stack ?? "";
		const site = stack.includes("streaming-reveal.ts")
			? "reveal"
			: stack.includes("event-controller.ts")
				? "event-controller"
				: "other";
		renderContentSamples.push({ ms, site });
	}
	return result;
};

try {
	await mode.init({ suppressWelcomeIntro: true });
	await mode.renderInitialMessages({ clearTerminalHistory: true });
	mode.setTodos(phases);
	mode.setTodoExpanded(true);
	scheduler.drain();
	const rows = mode.todoContainer.render(WIDTH).length;
	if (rows < PLAN_ROWS) throw new Error(`Todo HUD did not render 400 rows: ${rows}`);
	if (agents.list().length !== SUBAGENTS) throw new Error("Subagent registry incomplete");
	if (session.messages !== agent.state.messages || session.messages.length !== HISTORY_COUNT) throw new Error("Agent history not retained");

	// Revise the pre-tool text across cumulative deltas: providers can revise a
	// previous block (Cursor). Growing visible units stresses the tool-boundary
	// clone, but short-circuits deepEquals at streaming-reveal.ts:302-304.
	const text = "A streamed response before a tool boundary. ".repeat(Math.ceil(preToolTargetBytes / 44)).slice(0, preToolTargetBytes);
	const preToolBytes = Buffer.byteLength(text) + UPDATES;
	const first = assistant([{ type: "text", text }]);
	const messageStartPartition: PartitionBucket = {
		clone: 0, deepCompare: 0, renderContent: 0, paint: 0, immediate: 0,
		gcMs: 0, heapBefore: process.memoryUsage().heapUsed, heapAfter: 0, delivery: 0, frame: 0, other: 0,
	};
	activePartition = messageStartPartition;
	const messageStartBegan = performance.now();
	await mode.eventController.handleEvent({ type: "message_start", message: first });
	messageStartPartition.delivery = performance.now() - messageStartBegan;
	messageStartPartition.frame = scheduler.drain();
	activePartition = undefined;
	messageStartPartition.heapAfter = process.memoryUsage().heapUsed;
	messageStartPartition.other = messageStartPartition.delivery + messageStartPartition.frame
		- messageStartPartition.clone - messageStartPartition.deepCompare - messageStartPartition.renderContent
		- messageStartPartition.paint - messageStartPartition.immediate;
	const delivery: number[] = [];
	const frame: number[] = [];
	const keys: number[] = [];
	const keyFrame: number[] = [];
	const partitions: PartitionBucket[] = [];
	// Diagnostic variant: force a full GC before each event so per-event time is
	// measured on a clean heap. The GC cost itself is recorded per event (gcMs)
	// and excluded from the delivery/frame buckets it would otherwise inflate.
	const forceGc = Bun.env.STREAM_FORCE_GC === "1";
	let gcAfterSetupMs: number | undefined;
	if (forceGc) {
		const gcStart = performance.now();
		Bun.gc(true);
		gcAfterSetupMs = performance.now() - gcStart;
	}
	for (let index = 0; index < UPDATES; index++) {
		const message = assistant([{ type: "text", text: `${text}${"x".repeat(index + 1)}` }, { type: "toolCall", name: "read", id: "fixture-read",
			arguments: { path: `fixture-${index}.txt` } }]);
		const event = { type: "message_update" as const, message,
			assistantMessageEvent: { type: "toolcall_delta" as const, contentIndex: 1, delta: "x", partial: message } };
		const bucket: PartitionBucket = {
			clone: 0, deepCompare: 0, renderContent: 0, paint: 0, immediate: 0,
			gcMs: 0, heapBefore: 0, heapAfter: 0, delivery: 0, frame: 0, other: 0,
		};
		if (forceGc) {
			const gcStart = performance.now();
			Bun.gc(true);
			bucket.gcMs = performance.now() - gcStart;
		}
		bucket.heapBefore = process.memoryUsage().heapUsed;
		activePartition = bucket;
		const began = performance.now();
		await mode.eventController.handleEvent(event);
		bucket.delivery = performance.now() - began;
		bucket.frame = scheduler.drain();
		activePartition = undefined;
		bucket.heapAfter = process.memoryUsage().heapUsed;
		bucket.other = bucket.delivery + bucket.frame
			- bucket.clone - bucket.deepCompare - bucket.renderContent - bucket.paint - bucket.immediate;
		partitions.push(bucket);
		delivery.push(bucket.delivery);
		frame.push(bucket.frame);
		if (index < KEYPRESSES) {
			const keyStart = performance.now();
			mode.ui.injectDebugInput(index % 2 === 0 ? "x" : "\x7f");
			keys.push(performance.now() - keyStart);
			keyFrame.push(scheduler.drain());
		}
	}
	// Probe the cost of one full GC at the peak heap retained by the loop. Runs
	// after the last event, so it cannot perturb the measured events.
	const gcPeakStart = performance.now();
	Bun.gc(true);
	const gcAtPeakMs = performance.now() - gcPeakStart;
	// Self-measure the instrumentation's own stack-capture overhead so readers can
	// subtract it from the wrapper-attributed buckets (one capture per wrapped call).
	const overheadStart = performance.now();
	for (let i = 0; i < 1000; i++) void (new Error().stack ?? "");
	const stackCaptureMsPerCall = (performance.now() - overheadStart) / 1000;
	const partitionPick = (key: keyof PartitionBucket) => partitions.map(bucket => bucket[key] as number);
	const siteSummary = (samples: Array<{ ms: number; site: string }>) => {
		const bySite: Record<string, number[]> = {};
		for (const sample of samples) {
			(bySite[sample.site] ??= []).push(sample.ms);
		}
		return Object.fromEntries(Object.entries(bySite).map(([site, ms]) => [site, { n: ms.length, ms: percentiles(ms) }]));
	};
	const result = {
		variant, historyBytes, historyMessages: history.length, planRows: PLAN_ROWS,
		renderedTodoRows: rows, registeredSubagents: agents.list().length, preToolBytes,
		updates: UPDATES, keypresses: KEYPRESSES,
		inclusion: "all 60 updates after message_start (await direct EventController.handleEvent), all 60 paired keypresses; scheduler-drained frames measured separately; no event coalescing or timer waits",
		mainThreadMs: { messageUpdateDelivery: percentiles(delivery), messageUpdateFrame: percentiles(frame),
			keypressDelivery: percentiles(keys), keypressFrame: percentiles(keyFrame),
			messageUpdateToPaint: percentiles(delivery.map((ms, i) => ms + frame[i]!)),
			keypressToPaint: percentiles(keys.map((ms, i) => ms + keyFrame[i]!)) },
		clones: { reveal: { count: cloneCounts.reveal, ms: cloneSamples.reveal.length ? percentiles(cloneSamples.reveal) : null },
			other: { count: cloneCounts.other, ms: cloneSamples.other.length ? percentiles(cloneSamples.other) : null } },
		partition: {
			messageStart: { ...messageStartPartition, toPaint: messageStartPartition.delivery + messageStartPartition.frame },
			forceGc,
			gcAfterSetupMs: forceGc ? gcAfterSetupMs : undefined,
			gcAtPeakMs,
			stackCaptureMsPerCall,
			perEvent: partitions,
			summary: {
				clone: percentiles(partitionPick("clone")),
				deepCompare: percentiles(partitionPick("deepCompare")),
				renderContent: percentiles(partitionPick("renderContent")),
				paint: percentiles(partitionPick("paint")),
				immediate: percentiles(partitionPick("immediate")),
				other: percentiles(partitionPick("other")),
				gcMs: percentiles(partitionPick("gcMs")),
				heapDeltaBytes: percentiles(partitions.map(bucket => bucket.heapAfter - bucket.heapBefore)),
			},
			totalsMs: {
				clone: partitions.reduce((sum, bucket) => sum + bucket.clone, 0),
				deepCompare: partitions.reduce((sum, bucket) => sum + bucket.deepCompare, 0),
				renderContent: partitions.reduce((sum, bucket) => sum + bucket.renderContent, 0),
				paint: partitions.reduce((sum, bucket) => sum + bucket.paint, 0),
				immediate: partitions.reduce((sum, bucket) => sum + bucket.immediate, 0),
				other: partitions.reduce((sum, bucket) => sum + bucket.other, 0),
			},
			sites: { deepCompare: siteSummary(deepCompareSamples), renderContent: siteSummary(renderContentSamples) },
			deepCompareCounts: { ...deepCompareCounts },
		},
		terminalWrites: terminal.writes, terminalBytes: terminal.bytes,
	};
	console.log(JSON.stringify(result));
	if (variant === "baseline" && result.mainThreadMs.messageUpdateToPaint.p90 < 100 && result.mainThreadMs.keypressToPaint.p90 < 100) {
		console.error("NONREPRODUCING BASELINE: both p90 frame gaps are below 100ms; do not claim a seconds-scale clone regression");
		process.exitCode = 1;
	}
} finally {
	globalThis.structuredClone = realClone;
	bunMutable.deepEquals = realDeepEquals;
	AssistantMessageComponent.prototype.updateContent = realUpdateContent;
	mode.stop();
	for (let index = 0; index < SUBAGENTS; index++) agents.unregister(`sub-${index}`);
	await session.dispose();
	db.close();
}
