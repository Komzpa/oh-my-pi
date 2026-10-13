/** Owner work settles before yield reminders, never after terminal acceptance. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createSessionDefaults } from "../helpers/session-defaults";

const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function assistantStopMessage(text: string, totalTokens = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: totalTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface AsyncQuiescenceHarness {
	session: AgentSession;
	prompts: string[];
	abortCalls: () => number;
	settleCalls: () => number;
	emitTerminalYield: (data: unknown) => void;
	emitAssistant: (text: string, totalTokens?: number) => void;
	finishJob: () => void;
}

interface AsyncSessionOptions {
	abort?: () => Promise<void>;
	dispose?: () => Promise<void>;
	asyncJobManager?: AsyncJobManager;
}

/** Mock owner work completes during settlement, injecting an async result. */
function createAsyncSession(
	onPrompt: (params: { text: string; promptIndex: number; harness: AsyncQuiescenceHarness }) => void,
	options: AsyncSessionOptions = {},
): AsyncQuiescenceHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const prompts: string[] = [];
	let abortCount = 0;
	let settleCount = 0;
	let pendingAsync = true;
	let runningJobs: Array<{ id: string; label?: string }> = [{ id: "job-1", label: "background build" }];
	let toolCallSeq = 0;

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};

	const emitTerminalYield = (data: unknown) => {
		toolCallSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `yield-${toolCallSeq}`,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
		} as AgentSessionEvent);
	};

	const finishJob = () => {
		pendingAsync = false;
		runningJobs = [];
		// Owner job completed: the session injects the async-result follow-up
		// turn. The model reacts with text only — no fresh yield.
		emit({
			type: "message_start",
			message: {
				role: "custom",
				customType: "async-result",
				content: "<system-notice>Background job job-1 has completed.\nexit 1: build FAILED</system-notice>",
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			},
		} as AgentSessionEvent);
		const reaction = assistantStopMessage("The background build failed after I yielded.");
		state.messages.push(reaction);
		emit({ type: "message_end", message: reaction } as AgentSessionEvent);
	};
	const emitAssistant = (text: string, totalTokens = 0) => {
		const message = assistantStopMessage(text, totalTokens);
		state.messages.push(message);
		emit({ type: "message_end", message } as AgentSessionEvent);
	};

	const harness: AsyncQuiescenceHarness = {
		session: undefined as unknown as AgentSession,
		prompts,
		abortCalls: () => abortCount,
		settleCalls: () => settleCount,
		emitTerminalYield,
		emitAssistant,
		finishJob,
	};

	const session = {
		...createSessionDefaults(),
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		asyncJobManager: options.asyncJobManager,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			prompts.push(text);
			onPrompt({ text, promptIndex: prompts.length, harness });
			return true;
		},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		hasPendingAsyncWork: () => pendingAsync,
		getAsyncJobSnapshot: () => ({ running: runningJobs, recent: [] }),
		settleAsyncWork: async () => {
			settleCount += 1;
			harness.finishJob();
		},
		abort: async () => {
			abortCount += 1;
			await options.abort?.();
		},
		dispose: options.dispose ?? (async () => {}),
	};
	harness.session = session as unknown as AgentSession;
	return harness;
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as CreateAgentSessionResult);
}

describe("runSubprocess async work and terminal acceptance", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	it("cancels and reaps pending owner jobs when a follow-up accepts terminal yield", async () => {
		const id = "follow-up-owner-cleanup";
		const manager = new AsyncJobManager({});
		const ownerStopped = Promise.withResolvers<void>();
		const otherStopped = Promise.withResolvers<void>();
		const ownerJobId = manager.register(
			"eval",
			"pending follow-up work",
			async ({ signal }) => {
				signal.addEventListener("abort", () => ownerStopped.resolve(), { once: true });
				await ownerStopped.promise;
				return "owner stopped";
			},
			{ ownerId: id },
		);
		const otherJobId = manager.register(
			"eval",
			"another owner's work",
			async ({ signal }) => {
				signal.addEventListener("abort", () => otherStopped.resolve(), { once: true });
				await otherStopped.promise;
				return "other owner stopped";
			},
			{ ownerId: "another-owner" },
		);
		const harness = createAsyncSession(
			({ harness: h }) => {
				expect(manager.getJob(ownerJobId)?.status).toBe("running");
				h.emitTerminalYield({ report: "FIRST" });
			},
			{ asyncJobManager: manager },
		);
		harness.session.setWorkPoolYieldItems = async () => {};
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(harness.session);

		try {
			const result = await runSubagentFollowUpTurn({ id, agent: baseAgent, message: "continue" });

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ report: "FIRST" });
			expect(manager.getJob(ownerJobId)?.abortController.signal.aborted).toBe(true);
			expect(manager.getJob(ownerJobId)?.status).toBe("cancelled");
			expect(manager.getJob(ownerJobId)?.endTime).toBeNumber();
			expect(manager.getJob(otherJobId)?.status).toBe("running");
			expect(manager.getJob(otherJobId)?.abortController.signal.aborted).toBe(false);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("keeps terminal acceptance final when a late async result is delivered", async () => {
		const harness = createAsyncSession(({ harness: h }) => {
			h.emitTerminalYield({ report: "FIRST" });
			h.finishJob();
			h.emitTerminalYield({ report: "LATER" });
		});
		mockCreateAgentSession(harness.session);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "quiescence-first-yield",
		});

		expect(harness.prompts).toHaveLength(1);
		expect(harness.settleCalls()).toBe(0);
		expect(harness.abortCalls()).toBe(1);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "FIRST" });
		expect(result.extractedToolData?.yield).toHaveLength(1);
	});

	it("waits for a pending owner job before spending a yield reminder", async () => {
		const harness = createAsyncSession(({ harness: h }) => {
			if (h.settleCalls() === 0) {
				h.emitAssistant("Waiting for job-1.");
				return;
			}
			h.emitTerminalYield({ report: "Build failed; job-1 delivered its result." });
		});
		mockCreateAgentSession(harness.session);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "verify the build",
			index: 0,
			id: "quiescence-wait-before-yield",
		});

		expect(harness.settleCalls()).toBe(1);
		expect(harness.prompts).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Build failed; job-1 delivered its result.");
	});

	it("does not demand a refreshed yield after terminal acceptance", async () => {
		const harness = createAsyncSession(({ harness: h }) => {
			h.emitTerminalYield({ report: "FIRST" });
		});
		mockCreateAgentSession(harness.session);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "quiescence-no-refresh",
		});

		expect(harness.prompts).toHaveLength(1);
		expect(harness.settleCalls()).toBe(0);
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ report: "FIRST" });
	});

	it("terminates immediately on yield when no owner async work is pending", async () => {
		const harness = createAsyncSession(({ promptIndex, harness: h }) => {
			if (promptIndex === 1) {
				h.finishJob();
				h.emitTerminalYield({ report: "done" });
			}
		});
		mockCreateAgentSession(harness.session);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "quiescence-no-async",
		});

		expect(harness.prompts).toHaveLength(1);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("done");
	});

	it("does not wait on a second idle barrier after a terminal yield", async () => {
		const harness = createAsyncSession(({ promptIndex, harness: h }) => {
			if (promptIndex === 1) {
				h.finishJob();
				h.emitTerminalYield({ report: "done" });
			}
		});
		const idleStarted = Promise.withResolvers<void>();
		const releaseIdle = Promise.withResolvers<void>();
		let idleCalls = 0;
		harness.session.waitForIdle = async () => {
			idleCalls += 1;
			idleStarted.resolve();
			await releaseIdle.promise;
		};
		mockCreateAgentSession(harness.session);

		const run = runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "quiescence-no-second-idle",
		});
		const outcome = await Promise.race([
			run.then(() => "completed" as const),
			idleStarted.promise.then(() => "blocked" as const),
		]);
		releaseIdle.resolve();
		const result = await run;

		expect(outcome).toBe("completed");
		expect(idleCalls).toBe(0);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("done");
	});

	it("preserves a successful yield across deferred cleanup and waits for every late resource", async () => {
		const abortStarted = Promise.withResolvers<void>();
		const abortGate = Promise.withResolvers<void>();
		const disposeGate = Promise.withResolvers<void>();
		const lateJobGate = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({});
		const cleanupGraceMs = 0;
		let lateJobId: string | undefined;
		let deferredCleanup: Promise<void> | undefined;
		const harness = createAsyncSession(
			({ promptIndex, harness: h }) => {
				if (promptIndex !== 1) return;
				h.finishJob();
				h.emitAssistant("captured before cleanup", 7);
				h.emitTerminalYield({ report: "yielded output" });
			},
			{
				abort: async () => {
					abortStarted.resolve();
					await abortGate.promise;
				},
				dispose: async () => {
					lateJobId = manager.register(
						"task",
						"shutdown-time job",
						async () => {
							await lateJobGate.promise;
							return "late result";
						},
						{ ownerId: "cleanup-timeout" },
					);
					await disposeGate.promise;
				},
			},
		);
		mockCreateAgentSession(harness.session);

		const run = runSubprocess({
			cwd: "/tmp",
			asyncJobManager: manager,
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "cleanup-timeout",
			keepAlive: false,
			cleanupGraceMs,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
			},
		});
		await abortStarted.promise;
		// abortStarted synchronizes with the in-flight cleanup; a zero grace
		// exercises the deadline/deferred-ownership transition without sleeping.

		const result = await run;
		// The run yielded successfully; a teardown that drains past the cleanup
		// deadline is handed off asynchronously and MUST NOT overwrite the
		// successful outcome with an aborted status (issue #9670).
		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
		expect(result.output).toContain("yielded output");
		expect(result.usage?.totalTokens).toBe(7);
		expect(lateJobId).toBeDefined();
		expect(deferredCleanup).toBeDefined();

		let cleanupSettled = false;
		const cleanupOutcome = deferredCleanup?.then(
			() => {
				cleanupSettled = true;
			},
			() => {
				cleanupSettled = true;
			},
		);
		abortGate.resolve();
		disposeGate.reject(new Error("dispose failed"));
		for (let attempt = 0; attempt < 10 && manager.getJob(lateJobId ?? "")?.status === "running"; attempt += 1) {
			await Promise.resolve();
		}
		expect(cleanupSettled).toBe(false);
		expect(manager.getJob(lateJobId ?? "")?.status).toBe("cancelled");

		lateJobGate.resolve();
		await cleanupOutcome;
		expect(cleanupSettled).toBe(true);
	}, 15_000);
});

describe("real executor terminal yield with worker-owned bash", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	// Event-based file wait: the fixture child signals through files, so the
	// test awaits the real filesystem event instead of polling on a timer.
	async function waitForFile(pathname: string): Promise<void> {
		if (await Bun.file(pathname).exists()) return;
		const dir = path.dirname(pathname);
		const base = path.basename(pathname);
		const { promise, resolve } = Promise.withResolvers<void>();
		const watcher = fs.watch(dir, (_event, filename) => {
			if (filename === base) {
				watcher.close();
				resolve();
			}
		});
		void Bun.file(pathname)
			.exists()
			.then(exists => {
				if (exists) {
					watcher.close();
					resolve();
				}
			});
		await promise;
	}

	async function runOwnedJob(options: { autoBackground?: boolean; finish?: "before-yield" | "after-refusal" } = {}) {
		using root = TempDir.createSync("@omp-yield-live-job-");
		const id = "yield-live-job";
		const dir = root.path();
		const accepted = path.join(dir, "accepted");
		const release = path.join(dir, "release");
		const cutover = path.join(dir, "cutover");
		const fixture = path.join(dir, "fixture.ts");
		// Updater-shaped fixture: writes an accepted marker, pauses before
		// cutover, then writes the cutover marker. The pause is file-gated
		// (after-refusal), immediate (before-yield), or never-ending
		// (abandonment). A module file with static imports lets the gated
		// child watch the filesystem directly; the test awaits filesystem
		// events and job promises, never a guessed duration.
		if (options.finish === "before-yield") {
			await Bun.write(
				fixture,
				`await Bun.write(${JSON.stringify(accepted)}, "accepted"); await Bun.write(${JSON.stringify(cutover)}, "installed");`,
			);
		} else if (options.finish === "after-refusal") {
			await Bun.write(
				fixture,
				`import { watch } from "node:fs"; await Bun.write(${JSON.stringify(accepted)}, "accepted"); const gated = Promise.withResolvers(); const watcher = watch(${JSON.stringify(dir)}, (_event, filename) => { if (filename === "release") { watcher.close(); gated.resolve(); } }); if (await Bun.file(${JSON.stringify(release)}).exists()) { watcher.close(); } else { await gated.promise; } await Bun.write(${JSON.stringify(cutover)}, "installed");`,
			);
		} else {
			await Bun.write(
				fixture,
				`await Bun.write(${JSON.stringify(accepted)}, "accepted"); await Promise.withResolvers().promise;`,
			);
		}
		const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
		const manager = new AsyncJobManager({});
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(auth);
		const sessionRef: { current?: AgentSession } = {};
		let jobStarted = false;
		let jobId = "";
		let jobCommand = "";
		let jobStartedAt = 0;
		let refused = 0;
		const mock = createMockModel({
			handler: async () => {
				const session = sessionRef.current;
				if (!session) throw new Error("session not ready");
				if (!jobStarted) {
					jobStarted = true;
					return {
						content: [
							{
								type: "toolCall",
								id: "start-job",
								name: "bash",
								arguments: { command, timeout: 30, ...(options.autoBackground ? {} : { async: true }) },
							},
						],
					};
				}
				const firstResult = session.messages.find(
					message => message.role === "toolResult" && message.toolCallId === "first-yield",
				);
				if (!firstResult) {
					await waitForFile(accepted);
					expect(await Bun.file(accepted).text()).toBe("accepted");
					const job = manager.getRunningOwnerJobs(id)[0] ?? manager.getAllJobs({ ownerId: id })[0];
					if (!job) throw new Error("worker-owned bash job missing");
					expect(job.type).toBe("bash");
					jobId = job.id;
					jobCommand = (job.process?.command ?? job.label).replace(/\s+/g, " ").slice(0, 120);
					jobStartedAt = job.startTime;
					expect(
						JSON.stringify(
							session.messages.find(
								message => message.role === "toolResult" && message.toolCallId === "start-job",
							),
						),
					).toContain("still running and owned by this worker");
					// Watched delivery is suppressed, like the incident's
					// bg_113 row: the guard must still see the running job.
					if (options.finish === undefined) manager.watchJobs([jobId]);
					if (options.finish === "before-yield") await job.promise;
					return {
						content: [
							{
								type: "toolCall" as const,
								id: "first-yield",
								name: "yield",
								arguments: { data: { report: "done" } },
							},
						],
					};
				}
				if (
					session.messages.find(
						message => message.role === "toolResult" && message.toolCallId === "finished-yield",
					) ??
					session.messages.find(message => message.role === "toolResult" && message.toolCallId === "second-yield")
				) {
					throw new Error("unexpected extra model turn after terminal acceptance");
				}
				if (session.messages.find(message => message.role === "toolResult" && message.toolCallId === "wait-job")) {
					expect(manager.getJob(jobId)?.status).toBe("completed");
					return {
						content: [
							{
								type: "toolCall" as const,
								id: "finished-yield",
								name: "yield",
								arguments: { data: { report: "done" } },
							},
						],
					};
				}
				if (firstResult.isError !== true) throw new Error("first yield was accepted without refusal");
				refused += 1;
				expect(JSON.stringify(firstResult)).toContain(jobId);
				expect(JSON.stringify(firstResult)).toContain("elapsed");
				expect(JSON.stringify(firstResult)).toContain(process.execPath);
				expect(manager.getJob(jobId)?.status).toBe("running");
				expect(manager.getJob(jobId)?.abortController.signal.aborted).toBe(false);
				if (options.finish === "after-refusal") {
					await Bun.write(release, "go");
					return { content: [{ type: "toolCall", id: "wait-job", name: "wait", arguments: {} }] };
				}
				return {
					content: [
						{
							type: "toolCall" as const,
							id: "second-yield",
							name: "yield",
							arguments: { data: { report: "done" } },
						},
					],
				};
			},
		});
		const created = await sdkModule.createAgentSession({
			cwd: root.path(),
			agentDir: root.path(),
			modelRegistry,
			model: mock,
			sessionManager: SessionManager.inMemory(root.path()),
			asyncJobManager: manager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"async.enabled": true,
				"launch.enabled": false,
				"bash.autoBackground.enabled": options.autoBackground ?? false,
				"bash.autoBackground.thresholdMs": 0,
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			requireYieldTool: true,
			toolNames: ["bash", "wait", "yield"],
			parentTaskPrefix: id,
			agentId: id,
			taskDepth: 1,
		});
		sessionRef.current = created.session;
		const session = created.session;
		session.agent.streamFn = mock.stream;
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(session);
		try {
			const result = await runSubagentFollowUpTurn({ id, agent: baseAgent, message: "run the updater fixture" });
			const installed = await Bun.file(cutover).exists();
			const job = manager.getJob(jobId);
			return {
				result,
				refused,
				installed,
				jobId,
				command: jobCommand,
				jobStatus: job?.status,
				startedAt: jobStartedAt,
			};
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			await session.dispose();
			auth.close();
		}
	}

	for (const autoBackground of [false, true]) {
		it(`refuses once before accepting abandonment through the real executor (auto-background=${autoBackground})`, async () => {
			const { result, refused, installed, jobId, command, jobStatus, startedAt } = await runOwnedJob({
				autoBackground,
			});
			expect(result.exitCode).toBe(0);
			expect(refused).toBe(1);
			expect(result.abandonedJobs).toEqual([
				{
					id: jobId,
					type: "bash",
					command,
					startedAt,
					elapsedMs: expect.any(Number),
				},
			]);
			expect(result.extractedToolData?.yield).toHaveLength(1);
			expect(result.stderr).toContain(jobId);
			expect(jobStatus).toBe("cancelled");
			expect(installed).toBe(false);
		}, 20_000);
	}

	it("preserves the updater through refusal and accepts its receipt after wait", async () => {
		const { result, refused, installed } = await runOwnedJob({ finish: "after-refusal" });
		expect(result.exitCode).toBe(0);
		expect(refused).toBe(1);
		expect(installed).toBe(true);
		expect(result.abandonedJobs).toBeUndefined();
		expect(result.stderr).toBe("");
	}, 20_000);

	it("accepts the first terminal yield when the job has already finished", async () => {
		const { result, refused, installed } = await runOwnedJob({ finish: "before-yield" });
		expect(result.exitCode).toBe(0);
		expect(refused).toBe(0);
		expect(installed).toBe(true);
		expect(result.abandonedJobs).toBeUndefined();
	}, 20_000);
});
