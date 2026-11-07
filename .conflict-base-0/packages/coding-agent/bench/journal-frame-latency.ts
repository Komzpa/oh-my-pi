/**
 * Run with isolated configuration before imports:
 * PI_TEST_RUNTIME=1 PI_CONFIG_DIR=../../tmp/dc-bench-private PI_CODING_AGENT_DIR=/tmp/dc-bench-private/agent \
 * bun --cpu-prof ./packages/coding-agent/bench/journal-frame-latency.ts
 */
import { expect, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as costProjection from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import * as persistedAgents from "../src/registry/persisted-agents";
import * as titleGenerator from "../src/utils/title-generator";
import * as tui from "@oh-my-pi/pi-tui";
import {
	initTerminalTitleState,
	setSessionTerminalTitle,
	setTerminalTitle,
	setTerminalTitleState,
	disposeTerminalTitleState,
} from "../src/utils/title-generator";
import { Type } from "@oh-my-pi/omptype/typebox";
import { collectSubSessions } from "../src/session/sub-sessions";
import dcSizes from "./fixtures/dc-worker-sizes.json";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getAgentDir, getConfigRootDir, getLogsDir, pathIsWithin } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { resetLoopPhaseWindow, takeLoopPhaseAttribution, withLoopPhase } from "@oh-my-pi/pi-utils/loop-phase";
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

const steady = process.env.JOURNAL_BENCH_STEADY === "1";
const timings: Record<string, { calls: number; ms: number; rows?: number }> = {};
function timed<T>(name: string, run: () => T): T {
	const metric = (timings[name] ??= { calls: 0, ms: 0 });
	metric.calls++;
	const start = performance.now();
	try {
		return run();
	} finally {
		metric.ms += performance.now() - start;
	}
}
const entries = steady ? 4_500 : 200_000;
const shape = process.env.JOURNAL_BENCH_SHAPE ?? "original";
const dc = shape === "dc";
const burst = dc && !steady;
const extended = dc || shape === "dc-static";
const workers = steady ? 58 : burst ? dcSizes.sizes.length : extended ? 6_000 : 1_000;
const workerFiles = steady ? workers : burst ? dcSizes.directoryFiles : extended ? 8_338 : workers;
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
		`${JSON.stringify({ type: "custom", id: "todo", parentId: `e${entries - 1}`, timestamp, customType: "user_todo_edit", data: { phases: [{ name: "Benchmark", tasks: Array.from({ length: extended ? 250 : 1 }, (_, index) => ({ content: index ? `work ${index}` : "work", status: index ? "pending" : "in_progress", ...(extended ? { schedule: { agentProfile: "task", dependencies: [], resources: [], owner: dc ? `Worker${index}` : "task", estimate: { optimisticSeconds: 1, likelySeconds: 2, pessimisticSeconds: 5, confidence: "high", basis: "synthetic benchmark", updatedAt: Date.now() } } } : {}) })) }] } })}\n`,
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
				message: {
					...createAssistantMessage(padding),
					usage: {
						input: 100,
						output: 100,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 200,
						cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
					},
				},
			},
		];
		const transcript = Bun.file(path.join(workerDir, `Worker${i}.jsonl`)).writer();
		transcript.write(`${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		if (extended && !steady) {
			// 5,992 short transcripts and eight large ones: valid records, no sparse-file substitute.
			const record = `${JSON.stringify({ type: "custom", id: "archive", parentId: "answer", timestamp, customType: "worker-archive", data: { padding: "x".repeat(16_000) } })}\n`;
			const targetBytes = burst ? dcSizes.sizes[i]! : i < 8 ? 205_000_000 : 160_000;
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
	const wholeParseStacks: string[] = [];
	let totalPlanClones = 0;
	const originalParse = utils.parseJsonlLenient;
	const parseSpy = vi
		.spyOn(utils, "parseJsonlLenient")
		.mockImplementation((...args: Parameters<typeof originalParse>) => {
			parseSpy.mockClear();
			totalJsonlParses++;
			if (wholeParseStacks.length < 12) wholeParseStacks.push(new Error("whole-transcript parse").stack ?? "");
			return originalParse(...args);
		});
	const originalClone = globalThis.structuredClone;
	const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
		cloneSpy.mockClear();
		if (
			value &&
			typeof value === "object" &&
			("phases" in value ||
				("content" in value && "status" in value) ||
				(Array.isArray(value) && value.some(phase => phase && typeof phase === "object" && "tasks" in phase)))
		)
			totalPlanClones++;
		return timed("structuredClone", () => originalClone(value, options));
	});
	let titleWrites = 0;
	const titleWriteTimes: number[] = [];
	vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(true);
	vi.spyOn(utils, "isTerminalHeadless").mockReturnValue(false);
	vi.spyOn(tui, "writeTerminalSequence").mockImplementation(sequence => {
		if (sequence.startsWith("\x1b]0;")) {
			titleWrites++;
			titleWriteTimes.push(performance.now());
		}
	});
	const originalCost = costProjection.aggregateCost;
	const costSpy = vi.spyOn(costProjection, "aggregateCost").mockImplementation(args => {
		costSpy.mockClear();
		const value = timed("aggregateCost", () => originalCost(args));
		timings.aggregateCost!.rows = (timings.aggregateCost!.rows ?? 0) + args.rows.length;
		return value;
	});
	const originalMembership = persistedAgents.sessionFileBelongsToRoot;
	const membershipSpy = vi.spyOn(persistedAgents, "sessionFileBelongsToRoot").mockImplementation((...args) => {
		membershipSpy.mockClear();
		return timed("treeMembership", () => originalMembership(...args));
	});
	const originalTitle = titleGenerator.setTerminalTitle;
	const titleSpy = vi.spyOn(titleGenerator, "setTerminalTitle").mockImplementation(value => {
		titleSpy.mockClear();
		timed("titleSetter", () => originalTitle(value));
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
	const originalLoad = loader.loadSessionFile;
	vi.spyOn(loader, "loadSessionFile").mockImplementation((...args: Parameters<typeof originalLoad>) => {
		if (wholeParseStacks.length < 12) wholeParseStacks.push(new Error("loadSessionFile caller").stack ?? "");
		return originalLoad(...args);
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
		expect(journalBytes).toBeGreaterThanOrEqual(steady ? 40_000_000 : 500_000_000);
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
		let wholeBranchReads = 0;
		const getBranch = manager.getBranch.bind(manager);
		const branchSpy = vi.spyOn(manager, "getBranch").mockImplementation((...args) => {
			branchSpy.mockClear();
			wholeBranchReads++;
			return getBranch(...args);
		});
		console.error(`BENCH_STAGE open-done ${Date.now()}`);
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, file, { hydrateHistory: false });
		console.error(`BENCH_STAGE registry-done ${Date.now()}`);
		const eventBus = new EventBus();
		let burstIssued = false;
		let activeWorkers = 0;
		let peakWorkers = 0;
		let completedWorkers = 0;
		const burstStarted = Promise.withResolvers<void>();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Benchmark"],
					tools: burst
						? [
								{
									name: "benchmark_worker",
									label: "Benchmark worker completion",
									description: "Complete synthetic worker",
									parameters: Type.Object({ index: Type.Number() }),
									execute: async (_id, args) => {
										const id = `Burst${args.index}`;
										const workerFile = path.join(file.slice(0, -6), `${id}.jsonl`);
										await fs.copyFile(
											path.join(file.slice(0, -6), `Worker${Math.floor((args.index * workers) / 5)}.jsonl`),
											workerFile,
										);
										AgentRegistry.global().register({
											id,
											displayName: id,
											kind: "sub",
											session: null,
											sessionFile: workerFile,
											status: "running",
										});
										eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
											id,
											index: args.index,
											agent: "task",
											agentSource: "builtin",
											status: "started",
											description: "burst worker",
										});
										activeWorkers++;
										peakWorkers = Math.max(peakWorkers, activeWorkers);
										if (activeWorkers === 5) burstStarted.resolve();
										await burstStarted.promise;
										await Bun.sleep(20);
										activeWorkers--;
										completedWorkers++;
										AgentRegistry.global().setStatus(id, "parked");
										eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
											id,
											index: args.index,
											agent: "task",
											agentSource: "builtin",
											status: "completed",
											description: "burst worker",
										});
										return { content: [{ type: "text", text: `Completed ${id}` }], details: { id } };
									},
								},
							]
						: [],
					messages: [],
				},
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					const spawn = burst && !burstIssued;
					burstIssued ||= spawn;
					queueMicrotask(() =>
						stream.push({
							type: "done",
							reason: spawn ? "toolUse" : "stop",
							message: {
								...createAssistantMessage("ok"),
								...(spawn
									? {
											stopReason: "toolUse" as const,
											content: Array.from({ length: 5 }, (_, index) => ({
												type: "toolCall" as const,
												id: `burst-${index}`,
												name: "benchmark_worker",
												arguments: { index },
											})),
										}
									: {}),
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
		const syncBadge = mode.syncRunningSubagentBadge.bind(mode);
		const badgeSpy = vi.spyOn(mode, "syncRunningSubagentBadge").mockImplementation(options => {
			badgeSpy.mockClear();
			return timed("badgeSync", () => syncBadge(options));
		});
		const frame = composer.renderFrame.bind(composer);
		const frameSpy = vi.spyOn(composer, "renderFrame").mockImplementation(viewport => {
			frameSpy.mockClear();
			return timed("renderFrame", () => frame(viewport));
		});
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
		// Retain finished workers with billed usage, and keep eight active throughout.
		for (let index = 0; index < (steady ? workers : 58); index++) {
			const id = `Worker${index}`;
			AgentRegistry.global().setStatus(id, index < 8 ? "running" : "parked");
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id,
				index,
				agent: "task",
				agentSource: "builtin",
				status: index < 8 ? "started" : "completed",
				description: `work ${index}`,
				sessionFile: path.join(file.slice(0, -6), `${id}.jsonl`),
				detached: true,
			});
		}
		initTerminalTitleState();
		setSessionTerminalTitle("DC synthetic benchmark", dir);
		setTerminalTitleState("working");
		await Bun.sleep(1200);
		// Render the real TUI to the in-process terminal; no desktop or process stdin.
		const render = () => {
			mode!.ui.renderNow();
		};
		render();
		if (firstPaintAt === undefined) throw new Error("No TUI paint was observed");
		const startupMs = firstPaintAt - started;
		const startupReadyMs = performance.now() - started;
		const intervals: number[] = [];
		const slowFrames: { gapMs: number; renderMs: number; phase?: { label: string; ms: number }; at: number }[] = [];
		let last = performance.now();
		let frameCount = 0;
		const blockingOperations: { op: string; ms: number }[] = [];
		let readsInFrames = 0;
		let turns = 0;
		let turnEnds = 0;
		let pendingTurn: Promise<boolean> | undefined;
		session.subscribe(event => {
			if (event.type === "turn_end") turnEnds++;
		});
		resetLoopPhaseWindow(last + 16);
		const timer = setInterval(() => {
			const beforeRender = performance.now();
			withLoopPhase("journal-bench:render", render);
			const now = performance.now();
			intervals.push(now - last);
			const phase = takeLoopPhaseAttribution(now);
			if (now - last > 100)
				slowFrames.push({ gapMs: now - last, renderMs: now - beforeRender, phase, at: Date.now() });
			resetLoopPhaseWindow(now + 16);
			last = now;
		}, 16);
		stopFrameClock = () => clearInterval(timer);
		const durationMs = Number(process.env.JOURNAL_BENCH_DURATION_MS ?? "6000");
		const parsesBeforeMeasurement = totalJsonlParses;
		const branchReadsBeforeMeasurement = wholeBranchReads;
		for (const key of Object.keys(timings)) delete timings[key];
		const runStart = performance.now();
		const measurementStartUnixMs = Date.now();
		const titleWritesBeforeMeasurement = titleWrites;
		const cpuBeforeMeasurement = process.cpuUsage();
		const threadCpuBeforeMeasurement = process.threadCpuUsage();
		// Exercise the same restore collector used by both restart paths while the UI is painting.
		const restoreOptions = { purpose: "restore" as const, includeCompressed: false };
		const restoration = burst ? collectSubSessions(file, restoreOptions) : undefined;
		while (performance.now() - runStart < durationMs) {
			// GC is deliberately outside frame call-count measurement: WeakRef cache
			// retention must not hide re-reading a branch after normal collection.
			readSpy.mockClear();
			if (!steady && frameCount % 50 === 0) {
				const beforeGc = performance.now();
				withLoopPhase("journal-bench:forced-gc", () => Bun.gc(true));
				blockingOperations.push({ op: "forced-gc", ms: performance.now() - beforeGc });
			}
			const before = totalPositionedReads;
			if (extended) resolveConfiguredModelPatterns("@task", settings);
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: frameCount % 8,
				agent: "task",
				agentSource: "builtin",
				task: "work",
				progress: {
					id: `Worker${frameCount % 8}`,
					description: "work",
					durationMs: frameCount * 20,
					tokens: frameCount + 200,
					requests: 1,
					toolCount: 1,
					cost: 0.02 + frameCount / 10000,
				},
			});
			readsInFrames += totalPositionedReads - before;
			setTerminalTitle(`DC synthetic benchmark ${frameCount}`);
			if (!steady && frameCount % 25 === 0) {
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
		const measurementEndUnixMs = Date.now();
		const measurementCpu = process.cpuUsage(cpuBeforeMeasurement);
		const measurementThreadCpu = process.threadCpuUsage(threadCpuBeforeMeasurement);
		const mainThreadOffCpuShare =
			1 - (measurementThreadCpu.user + measurementThreadCpu.system) / (emissionElapsedMs * 1000);
		const measurementTitleWrites = titleWrites - titleWritesBeforeMeasurement;
		const measurementTimings = Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, { ...value }]));
		await pendingTurn;
		await restoration;
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
				index: frameCount % 8,
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

		const result = {
			shape,
			steady,
			measurementStartUnixMs,
			measurementEndUnixMs,
			measurementTimings,
			measurementCpu,
			measurementThreadCpu,
			mainThreadOffCpuShare,
			measurementTitleWrites,
			titleWriteTimes,
			peakWorkers,
			completedWorkers,
			wholeBranchReads: wholeBranchReads - branchReadsBeforeMeasurement,
			wholeTranscriptParses: totalJsonlParses - parsesBeforeMeasurement,
			wholeParseStacks,
			blockingOperations,
			slowFrames,
			toolResults: session.agent.state.messages
				.filter(message => message.role === "toolResult")
				.map(message => ({
					toolCallId: message.toolCallId,
					isError: message.isError,
					text: message.content
						.filter(part => part.type === "text")
						.map(part => part.text.slice(0, 200))
						.join(" "),
				})),
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
		if (extended && !steady) {
			expect(actualWorkerFiles).toBeGreaterThanOrEqual(workerFiles + (burst ? 5 : 0));
			if (burst)
				expect(
					result.toolResults.filter(message => message.toolCallId.startsWith("burst-") && !message.isError).length,
				).toBe(5);
			expect(workerDirectoryBytes).toBeGreaterThanOrEqual(burst ? dcSizes.totalBytes : 2_600_000_000);
		}
		if (!steady) expect(turnEnds).toBeGreaterThan(0);
		expect(measurementTitleWrites).toBeLessThanOrEqual(Math.ceil(emissionElapsedMs / 1000));
		if (burst) {
			expect(result.wholeTranscriptParses).toBe(0);
			expect(peakWorkers).toBe(5);
			expect(completedWorkers).toBe(5);
		}
		expect(readsInFrames).toBe(0);
		expect(progressWindowPositionedReads).toBe(0);
		expect(result.progressWindowJsonlParses).toBe(0);
		expect(result.progressWindowPlanClones).toBe(0);
		expect(result.p95Ms).toBeLessThan(extended ? 35 : 100);
		expect(result.maxGapMs).toBeLessThan(extended ? 150 : 500);
		expect(frameCount).toBeGreaterThanOrEqual(Math.floor(durationMs / 20) - 1);
	} finally {
		stopFrameClock?.();
		disposeTerminalTitleState();
		resetLoopPhaseWindow();
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
