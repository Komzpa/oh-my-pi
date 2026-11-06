/**
 * Run with isolated configuration before imports:
 * PI_TEST_RUNTIME=1 PI_CONFIG_DIR=../../tmp/dc-bench-private PI_CODING_AGENT_DIR=/tmp/dc-bench-private/agent \
 * bun --cpu-prof ./packages/coding-agent/bench/journal-frame-latency.ts
 */
import { expect, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getAgentDir, getConfigRootDir, getLogsDir, pathIsWithin } from "@oh-my-pi/pi-utils";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage } from "../test/helpers/agent-session-setup";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentRegistry } from "../src/registry/agent-registry";
import { registerPersistedSubagents } from "../src/registry/persisted-agents";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import * as loader from "../src/session/session-loader";
import { SessionManager } from "../src/session/session-manager";
import { CURRENT_SESSION_VERSION } from "../src/session/session-entries";
import { EventBus } from "../src/utils/event-bus";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";

const entries = 200_000;
const workers = 1_000;
const timestamp = "2026-11-06T12:00:00.000Z";

async function fixture(dir: string): Promise<string> {
	const file = path.join(dir, "main.jsonl");
	const writer = Bun.file(file).writer();
	writer.write(
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "benchmark", timestamp, cwd: dir })}\n`,
	);
	const padding = "x".repeat(2700);
	for (let i = 0; i < entries; i++) {
		writer.write(
			`${JSON.stringify({ type: "custom", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp, customType: "benchmark-archive", data: { padding } })}\n`,
		);
		if (i % 1024 === 0) await writer.flush();
	}
	writer.write(
		`${JSON.stringify({ type: "custom", id: "todo", parentId: `e${entries - 1}`, timestamp, customType: "user_todo_edit", data: { phases: [{ name: "Benchmark", tasks: [{ content: "work", status: "in_progress" }] }] } })}\n`,
	);
	await writer.end();
	const workerDir = file.slice(0, -6);
	await fs.mkdir(workerDir);
	for (let i = 0; i < workers; i++) {
		const records = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: `worker-${i}`, timestamp, cwd: dir },
			{ type: "session_init", id: "init", parentId: null, timestamp, agent: "task", task: "synthetic work" },
			{
				type: "message",
				id: "answer",
				parentId: "init",
				timestamp,
				message: { role: "user", content: padding, timestamp: 1 },
			},
		];
		await Bun.write(
			path.join(workerDir, `Worker${i}.jsonl`),
			`${records.map(record => JSON.stringify(record)).join("\n")}\n`,
		);
	}
	return file;
}

async function directoryBytes(dir: string): Promise<number> {
	let total = 0;
	for (const entry of await fs.readdir(dir)) total += (await fs.stat(path.join(dir, entry))).size;
	return total;
}

function quantile(values: number[], percentile: number): number {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))] ?? 0;
}

export async function runJournalFrameBenchmark(): Promise<void> {
	if (process.env.PI_TEST_RUNTIME !== "1" || !process.env.PI_CONFIG_DIR) {
		throw new Error("Set PI_TEST_RUNTIME=1 and an isolated PI_CONFIG_DIR before starting this benchmark");
	}
	const isolatedPaths = { config: getConfigRootDir(), agent: getAgentDir(), logs: getLogsDir() };
	for (const location of Object.values(isolatedPaths)) {
		if (pathIsWithin(path.join(os.homedir(), ".omp"), location)) {
			throw new Error(`Benchmark path resolves inside live ~/.omp: ${location}`);
		}
	}
	console.error(`BENCH_PATHS ${JSON.stringify(isolatedPaths)}`);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-journal-frames-"));
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;
	let totalPositionedReads = 0;
	let stopFrameClock: (() => void) | undefined;
	const originalRead = loader.readPositionedSessionEntry;
	const readSpy = vi
		.spyOn(loader, "readPositionedSessionEntry")
		.mockImplementation((...args: Parameters<typeof originalRead>) => {
			// Bun spies retain return values. Clearing inside the callback keeps
			// the measurement from becoming a strong cache of journal payloads.
			readSpy.mockClear();
			totalPositionedReads++;
			return originalRead(...args);
		});
	try {
		console.error(`BENCH_STAGE fixture-start ${Date.now()}`);
		const file = await fixture(dir);
		console.error(`BENCH_STAGE fixture-done ${Date.now()}`);
		const journalBytes = (await fs.stat(file)).size;
		expect(journalBytes).toBeGreaterThanOrEqual(500_000_000);
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: dir });
		auth = await AuthStorage.create(path.join(dir, "auth.db"));
		auth.keys.setRuntime("journal-benchmark", "synthetic-never-sent");
		const models = new ModelRegistry(auth);
		const model = buildModel({
			id: "journal-benchmark",
			name: "Synthetic journal benchmark",
			api: "journal-benchmark",
			provider: "journal-benchmark",
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 4096,
		} as ModelSpec<Api>) as Model<Api>;
		const started = performance.now();
		console.error(`BENCH_STAGE open-start ${Date.now()}`);
		const manager = await SessionManager.open(file, dir, undefined, { suppressBreadcrumb: true });
		console.error(`BENCH_STAGE open-done ${Date.now()}`);
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, file, { hydrateHistory: false });
		console.error(`BENCH_STAGE registry-done ${Date.now()}`);
		const eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Benchmark"], tools: [], messages: [] },
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() =>
						stream.push({
							type: "done",
							reason: "stop",
							message: {
								...createAssistantMessage("ok"),
								api: model.api,
								provider: model.provider,
								model: model.id,
							},
						}),
					);
					return stream;
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: models,
		});
		const terminal = new VirtualTerminal(120, 40);
		let firstPaintAt: number | undefined;
		const composer = new Composer({
			terminal,
			tuiOptions: {
				onPaint: () => {
					firstPaintAt ??= performance.now();
				},
			},
		});
		mode = new InteractiveMode(session, "benchmark", undefined, undefined, undefined, eventBus, composer);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		console.error(`BENCH_STAGE mode-init ${Date.now()}`);
		await mode.init();
		console.error(`BENCH_STAGE mode-ready ${Date.now()}`);
		// Render the real TUI to the in-process terminal; no desktop or process stdin.
		const render = () => {
			mode!.ui.renderNow();
		};
		render();
		if (firstPaintAt === undefined) throw new Error("No TUI paint was observed");
		const startupMs = firstPaintAt - started;
		const startupReadyMs = performance.now() - started;
		const intervals: number[] = [];
		let last = performance.now();
		let frameCount = 0;
		let readsInFrames = 0;
		let turns = 0;
		let turnEnds = 0;
		let pendingTurn: Promise<boolean> | undefined;
		session.subscribe(event => {
			if (event.type === "turn_end") turnEnds++;
		});
		const timer = setInterval(() => {
			render();
			const now = performance.now();
			intervals.push(now - last);
			last = now;
		}, 16);
		stopFrameClock = () => clearInterval(timer);
		const durationMs = Number(process.env.JOURNAL_BENCH_DURATION_MS ?? "6000");
		const runStart = performance.now();
		while (performance.now() - runStart < durationMs) {
			// GC is deliberately outside frame call-count measurement: WeakRef cache
			// retention must not hide re-reading a branch after normal collection.
			readSpy.mockClear();
			if (frameCount % 50 === 0) Bun.gc(true);
			const before = totalPositionedReads;
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				agent: "task",
				agentSource: "builtin",
				task: "work",
				progress: { id: "Worker0", description: "work", durationMs: frameCount * 20 },
			});
			readsInFrames += totalPositionedReads - before;
			if (frameCount % 25 === 0) {
				if (!pendingTurn) {
					pendingTurn = session.prompt("Benchmark turn").finally(() => {
						pendingTurn = undefined;
					});
				}
				eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id: "Worker0",
					index: 0,
					agent: "task",
					agentSource: "builtin",
					status: "completed",
					description: "work",
				});
				turns++;
			}
			frameCount++;
			await Bun.sleep(Math.max(0, runStart + frameCount * 20 - performance.now()));
		}
		console.error(`BENCH_STAGE emitted ${Date.now()}`);
		const emissionElapsedMs = performance.now() - runStart;
		await pendingTurn;
		console.error(`BENCH_STAGE turns-done ${Date.now()}`);
		await Bun.sleep(120);
		clearInterval(timer);
		// Include delayed coalesced observer work in the zero-read contract,
		// after turn/lifecycle work has settled and without starting another turn.
		readSpy.mockClear();
		Bun.gc(true);
		const beforeProgressWindow = totalPositionedReads;
		for (let i = 0; i < 10; i++) {
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				agent: "task",
				agentSource: "builtin",
				task: "work",
				progress: { id: "Worker0", description: "work", durationMs: i * 20 },
			});
			await Bun.sleep(20);
		}
		await Bun.sleep(120);
		const progressWindowPositionedReads = totalPositionedReads - beforeProgressWindow;
		const result = {
			journalBytes,
			journalEntries: manager.getEntryCount(),
			workerTranscripts: workers,
			workerTranscriptBytes: await directoryBytes(file.slice(0, -6)),
			retainedRegistryRefs: registry.list().length,
			startupMs,
			startupReadyMs,
			frameCount,
			turns,
			turnEnds,
			emissionElapsedMs,
			actualSubagentFramesPerSecond: frameCount / (emissionElapsedMs / 1000),
			frameSamples: intervals.length,
			p95Ms: quantile(intervals, 0.95),
			maxGapMs: Math.max(...intervals),
			readsInFrames,
			progressWindowPositionedReads,
			totalPositionedReads,
			memory: process.memoryUsage(),
		};
		console.log(`JOURNAL_BENCH_RESULT ${JSON.stringify(result)}`);
		if (process.env.JOURNAL_BENCH_OUTPUT)
			await Bun.write(process.env.JOURNAL_BENCH_OUTPUT, JSON.stringify(result, null, 2));
		expect(turnEnds).toBeGreaterThan(0);
		expect(readsInFrames).toBe(0);
		expect(progressWindowPositionedReads).toBe(0);
		expect(result.p95Ms).toBeLessThan(100);
		expect(result.maxGapMs).toBeLessThan(500);
		expect(frameCount).toBeGreaterThanOrEqual(Math.floor(durationMs / 20) - 1);
	} finally {
		stopFrameClock?.();
		mode?.stop();
		await session?.dispose();
		auth?.close();
		vi.restoreAllMocks();
		await fs.rm(dir, { recursive: true, force: true });
		resetSettingsForTest();
	}
}

if (import.meta.main) {
	const keepAlive = setInterval(() => {}, 1000);
	try {
		await runJournalFrameBenchmark();
	} finally {
		clearInterval(keepAlive);
	}
}
