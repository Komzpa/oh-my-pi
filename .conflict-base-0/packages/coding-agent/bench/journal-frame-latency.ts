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
import * as utils from "@oh-my-pi/pi-utils";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage } from "../test/helpers/agent-session-setup";
import { ModelRegistry } from "../src/config/model-registry";
import { resolveConfiguredModelPatterns } from "../src/config/model-resolver";
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
const extended = process.env.JOURNAL_BENCH_SHAPE === "dc";
const workers = extended ? 6_000 : 1_000;
const workerFiles = extended ? 8_338 : workers;
const timestamp = "2026-11-06T12:00:00.000Z";

async function fixture(dir: string): Promise<string> {
	const file = path.join(dir, "main.jsonl");
	const writer = Bun.file(file).writer();
	writer.write(
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "benchmark", timestamp, cwd: dir })}\n`,
	);
	const padding = "x".repeat(extended ? 10_350 : 2700);
	for (let i = 0; i < entries; i++) {
		writer.write(
			`${JSON.stringify({ type: "custom", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp, customType: "benchmark-archive", data: { padding } })}\n`,
		);
		if (i % 1024 === 0) await writer.flush();
	}
	writer.write(
		`${JSON.stringify({ type: "custom", id: "todo", parentId: `e${entries - 1}`, timestamp, customType: "user_todo_edit", data: { phases: [{ name: "Benchmark", tasks: Array.from({ length: extended ? 250 : 1 }, (_, index) => ({ content: index ? `work ${index}` : "work", status: index ? "pending" : "in_progress", ...(extended ? { schedule: { agentProfile: "task", dependencies: [], resources: [], owner: "task", estimate: { optimisticSeconds: 1, likelySeconds: 2, pessimisticSeconds: 5, confidence: "high", basis: "synthetic benchmark", updatedAt: Date.now() } } } : {}) })) }] } })}\n`,
	);
	if (extended) {
		writer.write(
			`${JSON.stringify({ type: "custom", id: "requirements", parentId: "todo", timestamp, customType: "requirements_ledger", data: { version: 1, requirements: Array.from({ length: 250 }, (_, index) => ({ id: `R${index + 1}`, at: timestamp, rawText: `Synthetic requirement ${index}`, classification: "linked", rows: [index ? `work ${index}` : "work"] })) } })}\n`,
		);
	}
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
		const transcript = Bun.file(path.join(workerDir, `Worker${i}.jsonl`)).writer();
		transcript.write(`${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		if (extended) {
			// 5,992 short transcripts and eight large ones: valid records, no sparse-file substitute.
			const record = `${JSON.stringify({ type: "custom", id: "archive", parentId: "answer", timestamp, customType: "worker-archive", data: { padding: "x".repeat(16_000) } })}\n`;
			const targetBytes = i < 8 ? 205_000_000 : 160_000;
			for (let bytes = 0; bytes < targetBytes; bytes += record.length) {
				transcript.write(record);
				if (bytes % (record.length * 256) === 0) await transcript.flush();
			}
		}
		await transcript.end();
	}
	if (extended) {
		for (let i = workers; i < workerFiles; i++)
			await Bun.write(
				path.join(workerDir, i < 8_000 ? `deliverable-${i}.md` : `restart-${i}.marker`),
				"Synthetic worker deliverable\n",
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
	const scratch = path.resolve(".tmp");
	await fs.mkdir(scratch, { recursive: true });
	const dir = await fs.mkdtemp(path.join(scratch, "omp-journal-frames-"));
	// The risk loader and agent discovery use homedir; isolate their real file APIs too.
	if (extended) vi.spyOn(os, "homedir").mockReturnValue(dir);
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;
	let totalPositionedReads = 0;
	let totalJsonlParses = 0;
	let totalPlanClones = 0;
	const originalParse = utils.parseJsonlLenient;
	const parseSpy = vi
		.spyOn(utils, "parseJsonlLenient")
		.mockImplementation((...args: Parameters<typeof originalParse>) => {
			parseSpy.mockClear();
			totalJsonlParses++;
			return originalParse(...args);
		});
	const originalClone = globalThis.structuredClone;
	const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
		cloneSpy.mockClear();
		if (
			value &&
			typeof value === "object" &&
			("phases" in value ||
				(Array.isArray(value) && value.some(phase => phase && typeof phase === "object" && "tasks" in phase)))
		)
			totalPlanClones++;
		return originalClone(value, options);
	});
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
		if (extended) {
			const generatedAt = new Date().toISOString();
			const quantiles = { q: [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95], v: [1, 1, 1, 1, 1, 1, 1] };
			await Bun.write(
				path.join(dir, ".omp/agent/row-risk.json"),
				JSON.stringify({
					version: 1,
					generatedAt,
					window: { start: generatedAt, end: generatedAt },
					source: { runs: "synthetic", labels: "synthetic" },
					unit: "ratio",
					components: {
						"*": {
							"*": {
								n: 100,
								n_eff: 100,
								p_redo: [0.1, 0.05, 0],
								attempt_ratio: quantiles,
								gap_ratio: quantiles,
							},
						},
					},
				}),
			);
		}
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
		const settings = Settings.isolated(
			extended
				? {
						modelRoles: {
							task: "@benchmark_outer",
							benchmark_outer: "@benchmark_inner:high",
							benchmark_inner: "journal-benchmark/journal-benchmark",
						},
					}
				: {},
		);
		if (extended) vi.spyOn(models, "getAvailable").mockReturnValue([model]);
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
			settings,
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
		if (extended) {
			const hud = mode as InteractiveMode & {
				renderRequirementHudSegment?: (
					base: (width: number) => readonly string[],
					width: number,
				) => readonly string[];
			};
			if (!hud.renderRequirementHudSegment)
				throw new Error(
					"DC shape requires the requirements-ledger owner PR in the assembled tree; run original shape for standalone #93",
				);
			expect(Bun.stripANSI(hud.renderRequirementHudSegment(() => [], 240).join("\n"))).toContain("requirements 250");
		}
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
			if (extended) resolveConfiguredModelPatterns("@task", settings);
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
		const parsesBeforeProgressWindow = totalJsonlParses;
		const clonesBeforeProgressWindow = totalPlanClones;
		for (let i = 0; i < 10; i++) {
			if (extended) resolveConfiguredModelPatterns("@task", settings);
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				agent: "task",
				agentSource: "builtin",
				task: "work",
				progress: { id: "Worker0", description: "work", durationMs: i * 20 },
			});
			render();
			await Bun.sleep(20);
		}
		await Bun.sleep(120);
		const progressWindowPositionedReads = totalPositionedReads - beforeProgressWindow;
		const actualWorkerFiles = (await fs.readdir(file.slice(0, -6))).length;
		const workerDirectoryBytes = await directoryBytes(file.slice(0, -6));
		if (extended) {
			expect(actualWorkerFiles).toBe(workerFiles);
			expect(workerDirectoryBytes).toBeGreaterThanOrEqual(2_600_000_000);
		}
		const result = {
			shape: extended ? "dc" : "original",
			workerFiles: actualWorkerFiles,
			journalBytes,
			journalEntries: manager.getEntryCount(),
			workerTranscripts: workers,
			workerTranscriptBytes: workerDirectoryBytes,
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
			progressWindowJsonlParses: totalJsonlParses - parsesBeforeProgressWindow,
			progressWindowPlanClones: totalPlanClones - clonesBeforeProgressWindow,
			totalPositionedReads,
			memory: process.memoryUsage(),
		};
		console.log(`JOURNAL_BENCH_RESULT ${JSON.stringify(result)}`);
		if (process.env.JOURNAL_BENCH_OUTPUT)
			await Bun.write(process.env.JOURNAL_BENCH_OUTPUT, JSON.stringify(result, null, 2));
		expect(turnEnds).toBeGreaterThan(0);
		expect(readsInFrames).toBe(0);
		expect(progressWindowPositionedReads).toBe(0);
		expect(result.progressWindowJsonlParses).toBe(0);
		expect(result.progressWindowPlanClones).toBe(0);
		expect(result.p95Ms).toBeLessThan(extended ? 50 : 100);
		expect(result.maxGapMs).toBeLessThan(extended ? 200 : 500);
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
