/**
 * A kept-alive subagent that parks must release its AgentSession while its
 * adoption (and therefore revivability) survives. The lifecycle manager holds
 * the run's reviver closure for as long as the agent stays adopted, so anything
 * that closure keeps reachable is retained for the life of the process; a
 * reviver that pins the disposed session leaks one full session graph per
 * spawned subagent.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { DeveloperMessage, Message } from "@oh-my-pi/pi-ai";
import { isPersistedSubagentElapsedNote } from "@oh-my-pi/pi-ai/utils/subagent-elapsed-note";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgContextPromotionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const AGENT_ID = "ParkedRelease";
const MOCK_API_SOURCE = "test/parked-subagent-session-release";
// After earlier files warm the session code, JSC's optimizing-JIT worklist can
// keep an object referenced by an in-flight compile reachable for a few seconds
// (observed ~4 s locally, >8 s on loaded CI runners); collection is polled past
// that window. A healthy release returns on the first poll that sees it collected,
// so the deadline only bounds how long a real leak takes to fail.
const COLLECT_DEADLINE_MS = 15_000;

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parked-release-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// The subagent session opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Kept out of the test body so no strong local binding outlives the capture. */
function weakRefToLiveSession(id: string): WeakRef<AgentSession> {
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error(`subagent ${id} has no live session to observe`);
	return new WeakRef(localSession(session));
}

async function collected(ref: WeakRef<object>, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		Bun.gc(true);
		if (ref.deref() === undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(100);
	}
}

/** Makes a settings write in the live session's own overlay, then observes the overlay weakly (outside the test body). */
function writeAndObserveLiveSettings(id: string): WeakRef<Settings> {
	const session = localSession(AgentRegistry.global().get(id)?.session);
	cfgContextPromotionEnabled.set(session, true);
	return new WeakRef(session.settings);
}

/** Runs `AGENT_ID` to a finished keep-alive state; `release` drops the mock's session-bound recordings. */
async function runKeptAliveSubagent(
	checkpoints?: {
		advanceClock(): void;
		requests: Message[][];
	},
	invokedAt?: number,
): Promise<{ release(): void; close(): void }> {
	// Under the isolated HOME: project discovery walks up from cwd and stops at os.homedir(). On Windows
	// os.tmpdir() lives under the real home, so a cwd outside the fake HOME would walk into the real
	// ~/.omp and load the developer's installed plugins as project plugins.
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const fixture = path.join(cwd, "checkpoint.txt");
	if (checkpoints) await Bun.write(fixture, "checkpoint fixture");
	const mock = createMockModel({
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
			if (checkpoints) {
				checkpoints.requests.push(structuredClone(context.messages));
				if (checkpoints.requests.length === 1) checkpoints.advanceClock();
				if (checkpoints.requests.length < 3)
					return { content: [{ type: "toolCall", name: "read", arguments: { path: fixture } }] };
			}
			return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	const availableSpy = vi
		.spyOn(modelRegistry, "getAvailable")
		.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			invokedAt,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				// No TTL timer: the test parks explicitly through the same path the timer takes.
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);
	} catch (error) {
		authStorage.close();
		throw error;
	}
	return {
		// Recorded mock calls carry stream options with closures bound to the session.
		release: () => {
			mock.reset();
			availableSpy.mockRestore();
		},
		close: () => authStorage.close(),
	};
}

it("releases a parked keep-alive subagent's session while the agent stays revivable", async () => {
	const run = await runKeptAliveSubagent();
	try {
		const sessionRef = weakRefToLiveSession(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		expect(AgentRegistry.global().get(AGENT_ID)).toMatchObject({ status: "parked", session: null });
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);

		run.release();
		expect(await collected(sessionRef, COLLECT_DEADLINE_MS)).toBe(true);
		// Still adopted after collection: the release did not come from dropping the reviver.
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);

it("parks without retaining the run's settings overlay and revives with the settings it wrote", async () => {
	const run = await runKeptAliveSubagent();
	try {
		// A write the subagent made to its own settings during the run.
		const settingsRef = writeAndObserveLiveSettings(AGENT_ID);

		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		// The reviver held the run's whole overlay — merged view, memoized values, listener buckets —
		// for as long as the parked agent stayed adopted.
		expect(await collected(settingsRef, COLLECT_DEADLINE_MS)).toBe(true);

		const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));
		expect(cfgContextPromotionEnabled.get(revived)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);

it("retains a five-minute checkpoint as a stable prefix across later tool requests and the transcript", async () => {
	let now = Date.now();
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const requests: Message[][] = [];
	const run = await runKeptAliveSubagent({
		advanceClock: () => {
			now += 5 * 60_000;
		},
		requests,
	});
	try {
		const assertRetained = () => {
			expect(requests).toHaveLength(3);
			const checkpoint = requests[1]!.filter(isPersistedSubagentElapsedNote).at(-1)!;
			expect(checkpoint.timestamp).toBe(now);
			// Responses continuation requires every previously sent message to remain
			// the same prefix, including the checkpoint first sent on request two.
			expect(requests[2]!.slice(0, requests[1]!.length)).toEqual(requests[1]);
			const session = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
			const notes = (messages: readonly AgentMessage[]) =>
				messages
					.filter(
						(message): message is DeveloperMessage =>
							message.role === "developer" && isPersistedSubagentElapsedNote(message),
					)
					.map(message => ({ content: message.content, timestamp: message.timestamp }));
			expect(notes(session.messages)).toEqual(notes(requests[2]!));
			const order = (messages: readonly AgentMessage[]) =>
				messages.flatMap(message =>
					message.role === "developer" && isPersistedSubagentElapsedNote(message)
						? [`checkpoint:${message.timestamp}`]
						: message.role === "user"
							? ["user"]
							: [],
				);
			expect(order(session.messages)).toEqual(order(requests[2]!));
			const transcript = session.sessionManager
				.getBranch()
				.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
			expect(notes(transcript)).toEqual(notes(requests[2]!));
			expect(order(transcript)).toEqual(order(requests[2]!));
		};
		assertRetained();
		await AgentLifecycleManager.global().park(AGENT_ID);
		requests.length = 0;
		// Expire the cadence before the follow-up is folded into the live loop.
		now += 5 * 60_000;
		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "check again after revival",
		});
		expect(result.exitCode).toBe(0);
		assertRetained();
	} finally {
		clock.mockRestore();
		run.release();
		run.close();
	}
}, 30_000);

it("redispatches an old assignment with a fresh persisted attempt checkpoint", async () => {
	const originalAssignmentStart = Date.now();
	let now = originalAssignmentStart;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const first = await runKeptAliveSubagent(undefined, originalAssignmentStart);
	try {
		await AgentLifecycleManager.global().release(AGENT_ID);
		first.release();
		now += 8 * 24 * 60 * 60_000;
		const requests: Message[][] = [];
		const redispatched = await runKeptAliveSubagent({ requests, advanceClock: () => {} }, originalAssignmentStart);
		try {
			const checkpoint = requests[0]!.filter(isPersistedSubagentElapsedNote).at(-1)!;
			expect(checkpoint.timestamp).toBe(now);
			expect(checkpoint.content).toContain("elapsed 0m in this attempt");
			const session = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
			const init = session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "session_init")
				.at(-1)!;
			expect(init.assignmentStartedAt).toBe(originalAssignmentStart);
			expect(init.attemptStartedAt).toBe(now);
			const persisted = session.sessionManager
				.getBranch()
				.flatMap(entry => (entry.type === "message" ? [entry.message] : []))
				.filter(message => message.role === "developer" && isPersistedSubagentElapsedNote(message))
				.at(-1)!;
			expect(persisted).toMatchObject({
				role: checkpoint.role,
				content: checkpoint.content,
				timestamp: checkpoint.timestamp,
			});
		} finally {
			redispatched.release();
			redispatched.close();
		}
	} finally {
		first.release();
		first.close();
		clock.mockRestore();
	}
}, 30_000);
