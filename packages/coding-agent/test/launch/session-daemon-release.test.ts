// Integration test — real timers are required (ts-no-test-timers exception): this drives real
// cross-process daemon brokers whose idle-shutdown timers live in another OS process, and broker
// exit is observed through the runtime-dir pid lease. Fake timers cannot control the broker
// process clock or the unix-socket RPC, and the short polling sleep only bounds the exit wait —
// a leaked broker surfaces as the waitForBrokerExit timeout, not a guessed-duration assertion.
// Real broker/process lifecycle test for per-session daemon client release.
// Uses short idle graces and TempDir-isolated projects so only test-spawned
// brokers are observed; no live omp/claude processes are touched.
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PathLike, StatOptions } from "node:fs";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { setProcessName, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { type } from "@oh-my-pi/omptype";
import { AsyncJobManager } from "../../src/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime } from "../../src/extensibility/extensions/loader";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as daemonPaths from "../../src/launch/paths";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as sdkModule from "../../src/sdk";
import { attachIrcWakeTurnMonitor, finalizeSubagentLifecycle, runSubprocess } from "../../src/task/executor";
import { EventBus } from "../../src/utils/event-bus";
import {
	createDaemonBrokerClient,
	type DaemonBrokerClient,
	daemonClientForProject,
	hasCachedDaemonClientForSession,
	releaseDaemonClientsForSession,
} from "../../src/launch/client";
import { readLiveDaemonBrokerPid } from "../../src/launch/presence";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const IDLE_GRACE_MS = 100;
// Disposal includes the established 5s drain and bounded transport/slice teardown.
const SHUTDOWN_OBSERVE_TIMEOUT_MS = 10_000;

async function waitForBrokerExit(runtimeDir: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await readLiveDaemonBrokerPid(runtimeDir)) === undefined) return;
		if (Date.now() >= deadline) {
			throw new Error(`Broker for ${runtimeDir} did not exit within ${timeoutMs}ms`);
		}
		await Bun.sleep(50);
	}
}

async function startFixtureDaemon(
	client: DaemonBrokerClient,
	name: string,
	options: { ignoreTerm?: boolean; detached?: boolean } = {},
): Promise<Process> {
	// The real child ignores SIGTERM so cleanup crosses the former 3s deadline.
	// Its keepalive runs in another process, outside this test's fake-timer clock.
	const started = await client.request({
		op: "start",
		spec: {
			name,
			application: process.execPath,
			args: [
				"-e",
				`${options.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""} setInterval(() => {}, 1000); console.log("READY");`,
			],
			env: {},
			cwd: client.projectDir,
			pty: false,
			ready: { log: "READY", timeoutMs: 5_000 },
			restart: "no",
			persist: !options.detached,
			detached: options.detached ?? false,
		},
	});
	if (started.op !== "start" || started.readyTimedOut || started.daemon.pid === undefined) {
		throw new Error(`Fixture daemon ${name} did not become ready`);
	}
	const processRef = Process.fromPid(started.daemon.pid);
	if (!processRef) throw new Error(`Fixture daemon ${name} disappeared before its transition`);
	return processRef;
}

function startIsolatedBroker(client: DaemonBrokerClient): { listening: Promise<void>; finished: Promise<void> } {
	const previousTitle = process.title;
	const previousEnv = {
		[DAEMON_PROJECT_DIR_ENV]: process.env[DAEMON_PROJECT_DIR_ENV],
		[DAEMON_RUNTIME_DIR_ENV]: process.env[DAEMON_RUNTIME_DIR_ENV],
		[DAEMON_IDLE_GRACE_ENV]: process.env[DAEMON_IDLE_GRACE_ENV],
	};
	process.env[DAEMON_PROJECT_DIR_ENV] = client.projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = client.runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(IDLE_GRACE_MS);
	const listening = Promise.withResolvers<void>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve() }).finally(() =>
		setProcessName(previousTitle),
	);
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return { listening: listening.promise, finished };
}
describe("per-session daemon client release", () => {
	for (const outcome of ["complete", "fail", "abort"] as const) {
		it(`releases a kept-alive transcript after an autonomous IRC wake ${outcome}`, async () => {
			using tempDir = TempDir.createSync("@omp-irc-wake-release-");
			const projectDir = tempDir.path();
			const authStorage = createInMemoryAuthStorage();
			const manager = SessionManager.inMemory(projectDir);
			const laneId = `wake-${crypto.randomUUID()}`;
			const parentId = `parent-${crypto.randomUUID()}`;
			const siblingId = `sibling-${crypto.randomUUID()}`;
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const mock = createMockModel({
				responses: [
					async () => {
						entered.resolve();
						await gate.promise;
						return outcome === "fail"
							? { stopReason: "error", errorMessage: "fixture failure" }
							: { content: ["wake complete"], delayMs: outcome === "abort" ? 30_000 : 0 };
					},
				],
			});
			const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
			const session = new AgentSession({
				agent: new Agent({
					initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
					getApiKey: () => "test-key",
					convertToLlm,
					streamFn: mock.stream,
				}),
				agentId: laneId,
				agentKind: "sub",
				sessionManager: manager,
				settings,
				modelRegistry: new ModelRegistry(authStorage, path.join(projectDir, "models.yml")),
				toolRegistry: new Map(),
			});
			const registry = AgentRegistry.global();
			const ref = registry.register({ id: laneId, displayName: laneId, kind: "sub", session, status: "idle" });
			attachIrcWakeTurnMonitor(session, {
				id: laneId,
				agent: { name: "task", description: "test", systemPrompt: "Test", source: "bundled" },
				structured: false,
			});
			const sessionId = manager.getSessionId();
			const client = await daemonClientForProject(projectDir, sessionId, { idleGraceMs: IDLE_GRACE_MS });
			const parent = await daemonClientForProject(projectDir, parentId, { idleGraceMs: IDLE_GRACE_MS });
			const sibling = await daemonClientForProject(projectDir, siblingId, { idleGraceMs: IDLE_GRACE_MS });
			try {
				const daemon = await startFixtureDaemon(client, "wake-owned");
				const parentDaemon = await startFixtureDaemon(parent, "wake-parent");
				const siblingDaemon = await startFixtureDaemon(sibling, "wake-sibling");
				expect((await IrcBus.global().send({ from: parentId, to: laneId, body: "wake" })).outcome).toBe("woken");
				await withTimeout(entered.promise, 5_000, "Wake did not reach provider");
				expect(daemon.status()).toBe(ProcessStatus.Running);
				expect(client.closed).toBe(false);
				if (outcome === "abort") {
					gate.resolve();
					await session.abort();
				} else gate.resolve();
				await withTimeout(session.waitForIrcReplies(), 15_000, "Wake did not finish");
				expect(session.getLastAssistantMessage()?.stopReason).toBe(
					outcome === "complete" ? "stop" : outcome === "fail" ? "error" : "aborted",
				);
				expect(daemon.status()).toBe(ProcessStatus.Exited);
				expect(client.closed).toBe(true);
				await expect(client.request({ op: "ping" })).rejects.toThrow();
				expect(await hasCachedDaemonClientForSession(projectDir, sessionId)).toBe(false);
				expect(session.isDisposed).toBe(false);
				expect(registry.get(laneId)).toBe(ref);
				for (const [control, process] of [
					[parent, parentDaemon],
					[sibling, siblingDaemon],
				] as const) {
					expect(process.status()).toBe(ProcessStatus.Running);
					expect(control.closed).toBe(false);
					expect((await control.request({ op: "ping" })).op).toBe("ping");
				}
				await waitForBrokerExit(client.runtimeDir);
			} finally {
				gate.resolve();
				registry.unregister(laneId);
				await session.dispose();
				for (const id of [sessionId, parentId, siblingId]) await releaseDaemonClientsForSession(id);
				await Promise.all([client, parent, sibling].map(control => waitForBrokerExit(control.runtimeDir)));
				authStorage.close();
			}
		}, 30_000);
	}
	it("retains a persistent server across runtime replacement and still stops it on final release", async () => {
		using temp = TempDir.createSync("@omp-restart-daemon-");
		const id = `restart-${crypto.randomUUID()}`;
		const client = await daemonClientForProject(temp.path(), id, { idleGraceMs: IDLE_GRACE_MS });
		try {
			const daemon = await startFixtureDaemon(client, "review-server");
			await releaseDaemonClientsForSession(id, true);
			expect(client.closed).toBe(true);
			const resumed = await daemonClientForProject(temp.path(), id, { idleGraceMs: IDLE_GRACE_MS });
			const listed = await resumed.request({ op: "list" });
			expect(listed.op).toBe("list");
			if (listed.op !== "list") throw new Error("expected list");
			expect(listed.daemons.some(record => record.name === "review-server")).toBe(true);
			expect(daemon.status()).toBe(ProcessStatus.Running);
			await releaseDaemonClientsForSession(id);
			expect(daemon.status()).toBe(ProcessStatus.Exited);
		} finally {
			await releaseDaemonClientsForSession(id);
		}
	});

	it("releases N sequential sessions: closed client, cache removal, broker exit; keeps parent/sibling alive", async () => {
		using tempDir = TempDir.createSync("@omp-session-daemon-release-");
		const root = tempDir.path();
		const unique = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
		const released: string[] = [];
		let releasedMainClient: DaemonBrokerClient | undefined;
		try {
			// N sequential per-session broker/client lifecycles with a live daemon each.
			for (let i = 0; i < 3; i++) {
				const projectDir = path.join(root, `proj-seq-${i}`);
				await fs.mkdir(projectDir, { recursive: true });
				const sessionId = `test-release-seq-${unique}-${i}`;
				released.push(sessionId);
				const client = await daemonClientForProject(projectDir, sessionId, {
					idleGraceMs: IDLE_GRACE_MS,
				});
				expect((await client.request({ op: "ping" })).op).toBe("ping");
				const runtimeDir = client.runtimeDir;
				expect(await readLiveDaemonBrokerPid(runtimeDir)).toBeDefined();
				const daemonName = `seq-daemon-${i}`;
				const started = await client.request({
					op: "start",
					spec: {
						name: daemonName,
						application: process.execPath,
						args: ["-e", "process.stdin.resume()"],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: false,
						detached: false,
					},
				});
				expect(started.op).toBe("start");
				const listedBefore = await client.request({ op: "list" });
				expect(listedBefore.op).toBe("list");
				if (listedBefore.op !== "list") throw new Error("expected list");
				expect(listedBefore.daemons.some(d => d.name === daemonName)).toBe(true);

				await releaseDaemonClientsForSession(sessionId);

				// Closed state and non-creating cache oracle (no replacement lookup).
				expect(client.closed).toBe(true);
				await expect(client.request({ op: "ping" })).rejects.toThrow();
				expect(await hasCachedDaemonClientForSession(projectDir, sessionId)).toBe(false);

				// Release stopped the live daemon: probe the same runtime dir with an
				// independent uncached client and observe no running daemon.
				const probe = await createDaemonBrokerClient(projectDir, {
					runtimeDir,
					idleGraceMs: IDLE_GRACE_MS,
				});
				try {
					const listedAfter = await probe.request({ op: "list" });
					expect(listedAfter.op).toBe("list");
					if (listedAfter.op !== "list") throw new Error("expected list");
					expect(
						listedAfter.daemons.filter(
							d =>
								d.name === daemonName &&
								(d.state === "running" || d.state === "starting" || d.state === "ready"),
						),
					).toEqual([]);
				} finally {
					probe.close();
				}

				// Broker exit within idle grace (daemons stopped, no remaining clients).
				await waitForBrokerExit(runtimeDir);
			}

			// Negative controls: live parent (empty main key + named parent) and
			// a still-running sibling stay usable/alive while another session releases.
			const parentProject = path.join(root, "proj-parent");
			await fs.mkdir(parentProject, { recursive: true });
			const parentSessionId = `test-release-parent-${unique}`;
			const siblingSessionId = `test-release-sibling-${unique}`;
			const victimSessionId = `test-release-victim-${unique}`;
			released.push(parentSessionId, siblingSessionId, victimSessionId);

			const mainClient = await createDaemonBrokerClient(parentProject, { idleGraceMs: IDLE_GRACE_MS });
			releasedMainClient = mainClient;
			const parentClient = await daemonClientForProject(parentProject, parentSessionId, {
				idleGraceMs: IDLE_GRACE_MS,
			});
			const siblingClient = await daemonClientForProject(parentProject, siblingSessionId, {
				idleGraceMs: IDLE_GRACE_MS,
			});
			const victimClient = await daemonClientForProject(parentProject, victimSessionId, {
				idleGraceMs: IDLE_GRACE_MS,
			});
			for (const client of [mainClient, parentClient, siblingClient, victimClient]) {
				expect((await client.request({ op: "ping" })).op).toBe("ping");
			}
			const parentRuntimeDir = parentClient.runtimeDir;
			const siblingRuntimeDir = siblingClient.runtimeDir;
			const victimRuntimeDir = victimClient.runtimeDir;
			expect(await readLiveDaemonBrokerPid(parentRuntimeDir)).toBeDefined();
			expect(await readLiveDaemonBrokerPid(siblingRuntimeDir)).toBeDefined();
			const victimDaemon = "victim-daemon";
			expect(
				(
					await victimClient.request({
						op: "start",
						spec: {
							name: victimDaemon,
							application: process.execPath,
							args: ["-e", "process.stdin.resume()"],
							env: {},
							cwd: parentProject,
							pty: false,
							restart: "no",
							persist: false,
							detached: false,
						},
					})
				).op,
			).toBe("start");

			await releaseDaemonClientsForSession(victimSessionId);

			// Victim closed and evicted without a replacement lookup.
			expect(victimClient.closed).toBe(true);
			await expect(victimClient.request({ op: "ping" })).rejects.toThrow();
			expect(await hasCachedDaemonClientForSession(parentProject, victimSessionId)).toBe(false);
			expect(await hasCachedDaemonClientForSession(parentProject, siblingSessionId)).toBe(true);
			expect(await hasCachedDaemonClientForSession(parentProject, parentSessionId)).toBe(true);

			// Victim daemon stopped: probe the victim runtime dir directly.
			const victimProbe = await createDaemonBrokerClient(parentProject, {
				runtimeDir: victimRuntimeDir,
				idleGraceMs: IDLE_GRACE_MS,
			});
			try {
				const listed = await victimProbe.request({ op: "list" });
				expect(listed.op).toBe("list");
				if (listed.op !== "list") throw new Error("expected list");
				expect(
					listed.daemons.filter(
						d =>
							d.name === victimDaemon &&
							(d.state === "running" || d.state === "starting" || d.state === "ready"),
					),
				).toEqual([]);
			} finally {
				victimProbe.close();
			}

			// Parent, sibling, and main preserved: still open and still serving RPC,
			// with live broker leases.
			expect(parentClient.closed).toBe(false);
			expect(siblingClient.closed).toBe(false);
			expect(mainClient.closed).toBe(false);
			expect((await parentClient.request({ op: "ping" })).op).toBe("ping");
			expect((await siblingClient.request({ op: "ping" })).op).toBe("ping");
			expect((await mainClient.request({ op: "ping" })).op).toBe("ping");
			expect(await readLiveDaemonBrokerPid(parentRuntimeDir)).toBeDefined();
			expect(await readLiveDaemonBrokerPid(siblingRuntimeDir)).toBeDefined();

			// Victim broker (short grace, daemon stopped) exits; parent/sibling brokers stay.
			await waitForBrokerExit(victimRuntimeDir);
			expect(await readLiveDaemonBrokerPid(parentRuntimeDir)).toBeDefined();
			expect(await readLiveDaemonBrokerPid(siblingRuntimeDir)).toBeDefined();
		} finally {
			releasedMainClient?.close();
			for (const sessionId of released) {
				await releaseDaemonClientsForSession(sessionId);
			}
		}
	}, 60_000);
	it("never matches a colon session id by suffix: releasing :b leaves :a:b alive", async () => {
		using tempDir = TempDir.createSync("@omp-session-daemon-colon-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir, { recursive: true });
		const shortId = `colon-b-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
		const longId = `prefix:${shortId}`;
		const shortClient = await daemonClientForProject(projectDir, shortId, { idleGraceMs: IDLE_GRACE_MS });
		const longClient = await daemonClientForProject(projectDir, longId, { idleGraceMs: IDLE_GRACE_MS });
		try {
			expect((await shortClient.request({ op: "ping" })).op).toBe("ping");
			expect((await longClient.request({ op: "ping" })).op).toBe("ping");
			await releaseDaemonClientsForSession(shortId);
			expect(shortClient.closed).toBe(true);
			expect(longClient.closed).toBe(false);
			expect((await longClient.request({ op: "ping" })).op).toBe("ping");
			expect(await hasCachedDaemonClientForSession(projectDir, longId)).toBe(true);
			expect(await hasCachedDaemonClientForSession(projectDir, shortId)).toBe(false);
		} finally {
			await releaseDaemonClientsForSession(shortId);
			await releaseDaemonClientsForSession(longId);
		}
	}, 30_000);
	it("close during connection rejects the in-flight request without retaining a broker lease", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-close-connect-");
		const options = { runtimeDir: path.join(tempDir.path(), "runtime"), idleGraceMs: IDLE_GRACE_MS };
		const keeper = await createDaemonBrokerClient(tempDir.path(), options);
		const closing = await createDaemonBrokerClient(tempDir.path(), options);
		try {
			await keeper.request({ op: "ping" });
			// Bun's expect(...).rejects matcher settles eagerly before the next
			// statement runs: creating it before close() skips the trigger and lets
			// the in-flight request resolve. Trigger first, then assert the settled
			// error; the native handler keeps an early rejection handled.
			const closingRequest = closing.request({ op: "ping" });
			void closingRequest.catch(() => {});
			closing.close();
			const rejected = expect(closingRequest).rejects.toThrow();
			await rejected;
			expect(closing.closed).toBe(true);
			keeper.close();
			await waitForBrokerExit(options.runtimeDir);
		} finally {
			// Only this test's broker is addressed, including cleanup of the failing path.
			if (!keeper.closed) await keeper.request({ op: "shutdown" }).catch(() => {});
			closing.close();
			keeper.close();
			await waitForBrokerExit(options.runtimeDir);
		}
	}, 30_000);

	it("concurrent release callers await daemon exit and cannot replace a closing session client", async () => {
		using tempDir = TempDir.createSync("@omp-concurrent-daemon-release-");
		const sessionId = crypto.randomUUID();
		const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
		try {
			const daemon = await startFixtureDaemon(client, "slow-stop", { ignoreTerm: true });
			const first = releaseDaemonClientsForSession(sessionId);
			const second = releaseDaemonClientsForSession(sessionId);
			await expect(daemonClientForProject(tempDir.path(), sessionId)).rejects.toThrow();
			await second;
			expect(daemon.status()).toBe(ProcessStatus.Exited);
			expect(client.closed).toBe(true);
			expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
			await first;
			await waitForBrokerExit(client.runtimeDir);
		} finally {
			await releaseDaemonClientsForSession(sessionId);
		}
	}, 30_000);

	it("drains a broker-accepted start before record insertion, even after the local request aborts", async () => {
		using tempDir = TempDir.createSync("@omp-release-accepted-start-");
		const sessionId = crypto.randomUUID();
		const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
		const observer = await createDaemonBrokerClient(tempDir.path(), { runtimeDir: client.runtimeDir });
		const broker = startIsolatedBroker(client);
		await broker.listening;
		await client.request({ op: "ping" });
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const stat = fs.stat;
		const spawned = Promise.withResolvers<void>();
		const finishLaunch = Promise.withResolvers<void>();
		const open = fs.open;
		let restoreClose: (() => void) | undefined;
		const openSpy = spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
			const handle = await open(target, flags, mode);
			if (String(target) === path.join(client.runtimeDir, "daemons", "accepted-before-release", "output.log")) {
				const close = handle.close.bind(handle);
				const closing = spyOn(handle, "close").mockImplementation(async () => {
					spawned.resolve();
					await finishLaunch.promise;
					await close();
				});
				restoreClose = () => closing.mockRestore();
			}
			return handle;
		});
		let blocked = false;
		const statSpy = spyOn(fs, "stat").mockImplementation((async (target: PathLike, options?: StatOptions) => {
			if (!blocked && String(target) === client.projectDir) {
				blocked = true;
				entered.resolve();
				await resume.promise;
			}
			return stat(target, options);
		}) as typeof fs.stat);
		const controller = new AbortController();
		const spec = {
			name: "accepted-before-release",
			application: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			env: {},
			cwd: client.projectDir,
			pty: false,
			restart: "no" as const,
			persist: true,
			detached: true,
		};
		try {
			const started = client.request({ op: "start", spec }, controller.signal);
			// Bun's expect(...).rejects matcher settles eagerly before the next
			// statement runs: created before controller.abort() it would skip the
			// abort trigger and the start would only time out. The native handler
			// keeps a rejection during the entered gate handled; assert the settled
			// error only after the abort.
			void started.catch(() => {});
			await entered.promise;
			controller.abort();
			const aborted = expect(started).rejects.toThrow("aborted");
			await aborted;
			let released = false;
			const release = releaseDaemonClientsForSession(sessionId).then(() => {
				released = true;
			});
			// Send ping on the same connection after release was queued: the broker
			// has established its barrier when this ping replies, without a sleep.
			await Promise.resolve();
			await client.request({ op: "ping" });
			expect(released).toBe(false);
			await expect(observer.request({ op: "start", spec: { ...spec, name: "too-late" } })).rejects.toThrow(
				"released",
			);
			resume.resolve();
			await spawned.promise;
			const live = await observer.request({ op: "describe", name: spec.name });
			if (live.op !== "describe" || live.daemon.pid === undefined) throw new Error("Expected accepted daemon PID");
			const daemon = Process.fromPid(live.daemon.pid);
			if (!daemon) throw new Error("Accepted daemon disappeared before release");
			expect(daemon.status()).toBe(ProcessStatus.Running);
			finishLaunch.resolve();
			await release;
			expect(daemon.status()).toBe(ProcessStatus.Exited);
			const result = await observer.request({ op: "describe", name: spec.name });
			if (result.op !== "describe") throw new Error("Expected accepted start record");
			expect(result.daemon.state).toBe("exited");
			expect(result.daemon.pid).toBeUndefined();
			expect(client.closed).toBe(true);
			expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
		} finally {
			resume.resolve();
			finishLaunch.resolve();
			openSpy.mockRestore();
			restoreClose?.();
			statSpy.mockRestore();
			await releaseDaemonClientsForSession(sessionId);
			await observer.request({ op: "shutdown" });
			observer.close();
			client.close();
			await broker.finished;
		}
	}, 30_000);

	it("rejects a pre-release canonicalization lookup after eviction but permits a fresh resumed client", async () => {
		using tempDir = TempDir.createSync("@omp-release-lookup-generation-");
		const sessionId = crypto.randomUUID();
		const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
		await client.request({ op: "ping" });
		const canonical = Promise.withResolvers<string>();
		const lookupSpy = spyOn(daemonPaths, "canonicalProjectDir").mockImplementationOnce(() => canonical.promise);
		try {
			// Bun's expect(...).rejects matcher settles eagerly before the next
			// statement runs: created before the release and lookup-resolution
			// triggers it would block them forever. Trigger first, then assert the
			// settled error; the native handler keeps the pending lookup handled.
			const stale = daemonClientForProject(tempDir.path(), sessionId);
			void stale.catch(() => {});
			await releaseDaemonClientsForSession(sessionId);
			canonical.resolve(client.projectDir);
			await expect(stale).rejects.toThrow("superseded");
			expect(client.closed).toBe(true);
			expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
			const resumed = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
			const daemon = await startFixtureDaemon(resumed, "resumed-service");
			expect(daemon.status()).toBe(ProcessStatus.Running);
			await releaseDaemonClientsForSession(sessionId);
			expect(daemon.status()).toBe(ProcessStatus.Exited);
			await waitForBrokerExit(resumed.runtimeDir);
		} finally {
			canonical.resolve(client.projectDir);
			lookupSpy.mockRestore();
			await releaseDaemonClientsForSession(sessionId);
		}
	}, 30_000);

	it("surfaces release RPC failure while still closing and evicting the original client", async () => {
		using tempDir = TempDir.createSync("@omp-release-rpc-failure-");
		const sessionId = crypto.randomUUID();
		const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
		const observer = await createDaemonBrokerClient(tempDir.path(), { runtimeDir: client.runtimeDir });
		const daemon = await startFixtureDaemon(client, "release-failure", { detached: true });
		await observer.request({ op: "ping" });
		const failed = spyOn(client, "request").mockRejectedValueOnce(new Error("release transport failed"));
		try {
			await expect(releaseDaemonClientsForSession(sessionId)).rejects.toBeInstanceOf(AggregateError);
			expect(client.closed).toBe(true);
			expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
			// Failure is not a successful process-exit receipt.
			expect(daemon.status()).toBe(ProcessStatus.Running);
		} finally {
			failed.mockRestore();
			await observer.request({ op: "stop", name: "release-failure", timeoutMs: 5_000 });
			expect(daemon.status()).toBe(ProcessStatus.Exited);
			observer.close();
			await releaseDaemonClientsForSession(sessionId);
			await waitForBrokerExit(client.runtimeDir);
		}
	}, 30_000);

	it.each([false, true])(
		"adopted agent services survive only restart disposal (retain=%s)",
		async preserveServices => {
			using temp = TempDir.createSync("@omp-adopted-service-restart-");
			const auth = createInMemoryAuthStorage();
			const manager = SessionManager.inMemory(temp.path());
			const session = new AgentSession({
				agent: new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
				modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
			});
			const id = crypto.randomUUID();
			const registry = AgentRegistry.global();
			const lifecycle = AgentLifecycleManager.global();
			registry.register({
				id,
				displayName: "server owner",
				kind: "sub",
				session,
				sessionFile: null,
				status: "idle",
			});
			lifecycle.adopt(id, { idleTtlMs: 0 });
			const client = await daemonClientForProject(temp.path(), manager.getSessionId(), {
				idleGraceMs: IDLE_GRACE_MS,
			});
			const observer = await createDaemonBrokerClient(temp.path(), { runtimeDir: client.runtimeDir });
			try {
				const daemon = await startFixtureDaemon(client, "question-server");
				await observer.request({ op: "ping" });
				await lifecycle.dispose(undefined, preserveServices);
				expect(daemon.status()).toBe(preserveServices ? ProcessStatus.Running : ProcessStatus.Exited);
			} finally {
				await observer.request({ op: "stop", name: "question-server", timeoutMs: 5_000 });
				observer.close();
				await session.dispose();
				await releaseDaemonClientsForSession(manager.getSessionId());
				await waitForBrokerExit(client.runtimeDir);
				auth.close();
			}
		},
		30_000,
	);

	it("AgentSession disposal rejects a failed broker release after closing and evicting its client", async () => {
		using tempDir = TempDir.createSync("@omp-dispose-release-failure-");
		const authStorage = createInMemoryAuthStorage();
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		const sessionId = manager.getSessionId();
		const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
		const observer = await createDaemonBrokerClient(tempDir.path(), { runtimeDir: client.runtimeDir });
		const daemon = await startFixtureDaemon(client, "dispose-release-failure", { detached: true });
		await observer.request({ op: "ping" });
		const failed = spyOn(client, "request").mockRejectedValueOnce(new Error("release transport failed"));
		try {
			await expect(session.dispose()).rejects.toBeInstanceOf(AggregateError);
			expect(session.isDisposed).toBe(true);
			expect(client.closed).toBe(true);
			expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
		} finally {
			failed.mockRestore();
			const snapshot = await observer.request({ op: "list" });
			if (snapshot.op !== "list") throw new Error("Expected owned daemon snapshot during cleanup");
			if (snapshot.daemons.some(record => record.name === "dispose-release-failure")) {
				await observer.request({ op: "stop", name: "dispose-release-failure", timeoutMs: 5_000 });
			}
			expect(daemon.status()).toBe(ProcessStatus.Exited);
			observer.close();
			await session.dispose().catch(() => {});
			await releaseDaemonClientsForSession(sessionId);
			await waitForBrokerExit(client.runtimeDir);
			authStorage.close();
		}
	}, 30_000);

	for (const blockedDrain of ["active-run", "post-prompt"] as const) {
		it(`bounds a hung ${blockedDrain} before broker release and defers terminal session teardown`, async () => {
			using tempDir = TempDir.createSync("@omp-task-drain-deadline-");
			const authStorage = createInMemoryAuthStorage();
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let workSettled = false;
			const blockedWork = gate.promise.then(() => {
				workSettled = true;
			});
			const mock = createMockModel({ responses: [{ content: ["drained"] }] });
			const agent = new Agent({
				initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
				getApiKey: () => "test-key",
				// Core races abort against stream iteration, so a held mock response
				// can outlive an already-idle run. Hold asynchronous stream acquisition
				// instead: waitForIdle genuinely owns this uncooperative provider work.
				streamFn: async (model, context, options) => {
					entered.resolve();
					await blockedWork;
					return mock.stream(model, context, options);
				},
			});
			const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			});
			const sessionId = manager.getSessionId();
			const parentId = crypto.randomUUID();
			const laneId = `drain-lane-${crypto.randomUUID()}`;
			const registry = AgentRegistry.global();
			const ref = registry.register({ id: laneId, displayName: laneId, kind: "sub", session });
			const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
			const parent = await daemonClientForProject(tempDir.path(), parentId, { idleGraceMs: IDLE_GRACE_MS });
			let running: Promise<void> | undefined;
			let deferredShutdown: Promise<void> | undefined;
			let settlement: Promise<void> | undefined;
			let runSettled = false;
			let shutdownSettled = false;
			try {
				const daemon = await startFixtureDaemon(client, "blocked-drain-service");
				const parentDaemon = await startFixtureDaemon(parent, "parent-drain-control");
				if (blockedDrain === "active-run") {
					running = agent.prompt("start blocked provider work").finally(() => {
						runSettled = true;
					});
					await withTimeout(entered.promise, 2_000, "Agent run never started");
					agent.abort();
					expect(runSettled).toBe(false);
				} else {
					session.trackPostPromptTaskForTests(blockedWork);
					expect(session.hasPostPromptWork).toBe(true);
				}
				settlement = finalizeSubagentLifecycle({
					id: laneId,
					session,
					aborted: true,
					abortKind: "signal",
					keepAlive: false,
					isolated: false,
					agentIdleTtlMs: 0,
					reviveSession: null,
					cleanupDeadlineAt: Date.now() - 1,
					onCleanupDeferred: completion => {
						deferredShutdown = completion.then(() => {
							shutdownSettled = true;
						});
					},
				});
				await withTimeout(settlement, 8_000, "Hung drain prevented task settlement and broker release");
				// Settlement releases processes without resolving the held work. The
				// public streaming flag is not a cleanup or work-completion receipt.
				expect(workSettled).toBe(false);
				if (blockedDrain === "active-run") expect(runSettled).toBe(false);
				else expect(session.hasPostPromptWork).toBe(true);
				expect(deferredShutdown).toBeDefined();
				expect(shutdownSettled).toBe(false);
				expect(ref.status).toBe("aborted");
				expect(ref.session).toBeNull();
				expect(daemon.status()).toBe(ProcessStatus.Exited);
				expect(client.closed).toBe(true);
				expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
				await waitForBrokerExit(client.runtimeDir);
				// Negative control: the still-live parent owns a different broker.
				expect(parentDaemon.status()).toBe(ProcessStatus.Running);
				expect((await parent.request({ op: "ping" })).op).toBe("ping");
				expect(workSettled).toBe(false);
				if (blockedDrain === "active-run") {
					expect(runSettled).toBe(false);
					expect(shutdownSettled).toBe(false);
				}
				gate.resolve();
				if (!deferredShutdown) throw new Error("Terminal teardown was not retained for deferred cleanup");
				await withTimeout(
					Promise.all([blockedWork, running ?? Promise.resolve(), deferredShutdown]),
					SHUTDOWN_OBSERVE_TIMEOUT_MS,
					"Held work and deferred session teardown did not settle after opening the gate",
				);
				expect(workSettled).toBe(true);
				expect(shutdownSettled).toBe(true);
				if (blockedDrain === "active-run") expect(runSettled).toBe(true);
				expect(session.isDisposed).toBe(true);
				expect(session.messages).toHaveLength(0);
				expect(manager.getEntries()).toHaveLength(0);
			} finally {
				gate.resolve();
				await running;
				await settlement;
				await deferredShutdown;
				await session.dispose();
				registry.unregister(laneId, ref);
				for (const id of [sessionId, parentId]) await releaseDaemonClientsForSession(id);
				await Promise.all([client, parent].map(control => waitForBrokerExit(control.runtimeDir)));
				authStorage.close();
			}
		}, 30_000);
	}
	it("direct dispose bounds uncooperative provider acquisition before broker release", async () => {
		using tempDir = TempDir.createSync("@omp-direct-dispose-drain-");
		const authStorage = createInMemoryAuthStorage();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let workSettled = false;
		const blockedWork = gate.promise.then(() => {
			workSettled = true;
		});
		const mock = createMockModel({ responses: [{ content: ["drained"] }] });
		const agent = new Agent({
			initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
			getApiKey: () => "test-key",
			// Same held-acquisition fixture as the lane drain test: waitForIdle
			// genuinely owns this uncooperative provider work.
			streamFn: async (model, context, options) => {
				entered.resolve();
				await blockedWork;
				return mock.stream(model, context, options);
			},
		});
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		const sessionId = manager.getSessionId();
		const parentId = crypto.randomUUID();
		const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
		const parent = await daemonClientForProject(tempDir.path(), parentId, { idleGraceMs: IDLE_GRACE_MS });
		let running: Promise<void> | undefined;
		let runSettled = false;
		const finalized = Promise.withResolvers<void>();
		let finalizationSettled = false;
		const finalization = finalized.promise.then(() => {
			finalizationSettled = true;
		});
		let memoryReleases = 0;
		const releaseEntries = manager.releaseRetainedEntries.bind(manager);
		const memoryRelease = spyOn(manager, "releaseRetainedEntries").mockImplementation(() => {
			releaseEntries();
			if (++memoryReleases === 2) finalized.resolve();
		});
		try {
			const daemon = await startFixtureDaemon(client, "direct-dispose-service");
			const parentDaemon = await startFixtureDaemon(parent, "parent-direct-control");
			running = agent.prompt("start blocked provider work").finally(() => {
				runSettled = true;
			});
			await withTimeout(entered.promise, 2_000, "Agent run never started");
			agent.abort();
			expect(runSettled).toBe(false);
			const disposing = session.dispose();
			await withTimeout(disposing, 8_000, "Direct dispose hung on uncooperative provider acquisition");
			// Dispose settled bounded while the held acquisition is still pending.
			expect(workSettled).toBe(false);
			expect(runSettled).toBe(false);
			expect(session.isDisposed).toBe(true);
			expect(session.messages).toHaveLength(0);
			expect(manager.getEntries()).toHaveLength(0);
			expect(finalizationSettled).toBe(false);
			// Actual broker release, not a streaming-flag receipt.
			expect(daemon.status()).toBe(ProcessStatus.Exited);
			expect(client.closed).toBe(true);
			expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
			await waitForBrokerExit(client.runtimeDir);
			// Negative control: a live parent on a different broker stays usable.
			expect(parentDaemon.status()).toBe(ProcessStatus.Running);
			expect((await parent.request({ op: "ping" })).op).toBe("ping");
			gate.resolve();
			await withTimeout(
				Promise.all([blockedWork, running, finalization]),
				SHUTDOWN_OBSERVE_TIMEOUT_MS,
				"Held provider acquisition did not settle after opening the gate",
			);
			expect(workSettled).toBe(true);
			expect(runSettled).toBe(true);
			expect(finalizationSettled).toBe(true);
			expect(session.messages).toHaveLength(0);
			expect(manager.getEntries()).toHaveLength(0);
		} finally {
			gate.resolve();
			await running;
			await session.dispose().catch(() => {});
			memoryRelease.mockRestore();
			for (const id of [sessionId, parentId]) await releaseDaemonClientsForSession(id);
			await Promise.all([client, parent].map(control => waitForBrokerExit(control.runtimeDir)));
			authStorage.close();
		}
	}, 30_000);

	for (const [keepAlive, yieldStatus] of [
		[false, "success"],
		[true, "success"],
		[false, "aborted"],
		[true, "aborted"],
	] as const) {
		it(`publishes a failed release receipt with keepAlive=${keepAlive} and yield=${yieldStatus} without skipping lifecycle or reaping`, async () => {
			using tempDir = TempDir.createSync("@omp-task-release-failure-");
			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			const mock = createMockModel({
				responses: [{ content: [{ type: "toolCall", name: "yield", arguments: {} }] }, { content: ["finished"] }],
			});
			const yieldTool: AgentTool = {
				name: "yield",
				label: "Yield",
				description: "Submit this test run's actual tool result",
				parameters: type({}),
				execute: async () => ({
					content: [{ type: "text", text: "Result submitted." }],
					details:
						yieldStatus === "aborted"
							? { status: "aborted", error: "aborted by test" }
							: { status: "success", data: { report: "finished" } },
				}),
			};
			const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
			settings.setModelRole("task", `${model.provider}/${model.id}`);
			const laneId = `failed-release-lane-${crypto.randomUUID()}`;
			const mcpDisconnected = Promise.withResolvers<void>();
			const jobs = new AsyncJobManager({});
			const session = new AgentSession({
				agent: new Agent({
					initialState: { model, systemPrompt: ["Test"], tools: [yieldTool], messages: [] },
					getApiKey: () => "test-key",
					streamFn: mock.stream,
				}),
				agentId: laneId,
				agentKind: "sub",
				sessionManager: manager,
				settings,
				modelRegistry,
				asyncJobManager: jobs,
				toolRegistry: new Map([["yield", yieldTool]]),
				disconnectOwnedMcpManager: async () => {
					mcpDisconnected.resolve();
				},
			});
			const registry = AgentRegistry.global();
			const ref = registry.register({ id: laneId, displayName: laneId, kind: "sub", session });
			const sessionId = manager.getSessionId();
			const parentId = crypto.randomUUID();
			const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
			const parent = await daemonClientForProject(tempDir.path(), parentId, { idleGraceMs: IDLE_GRACE_MS });
			await client.request({ op: "ping" });
			await parent.request({ op: "ping" });
			// Only the factory and failing transport are substituted. The session,
			// core tool run, registry, lifecycle, disposal and job manager are real.
			const factory = spyOn(sdkModule, "createAgentSession").mockResolvedValue({
				session,
				extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			});
			const failed = spyOn(client, "request").mockRejectedValueOnce(new Error("release transport failed"));
			const jobGate = Promise.withResolvers<void>();
			const jobAborted = Promise.withResolvers<void>();
			let shutdownJobId: string | undefined;
			let deferredCleanup: Promise<void> | undefined;
			try {
				const result = await withTimeout(
					runSubprocess({
						cwd: tempDir.path(),
						agent: { name: "task", description: "test", systemPrompt: "Test", source: "bundled" },
						task: "submit the result",
						index: 0,
						id: laneId,
						settings,
						modelRegistry,
						asyncJobManager: jobs,
						keepAlive,
						enableIrc: false,
						enableMCP: false,
						enableLsp: false,
						cleanupGraceMs: 0,
						onCleanupDeferred: completion => {
							deferredCleanup = completion;
						},
						onRelease: async () => {
							// This job begins during shutdown, after the first owner reap.
							shutdownJobId = jobs.register(
								"bash",
								"shutdown follow-up",
								async ({ signal }) => {
									if (signal.aborted) jobAborted.resolve();
									else signal.addEventListener("abort", () => jobAborted.resolve(), { once: true });
									await jobGate.promise;
									return "shutdown work settled";
								},
								{ ownerId: laneId },
							);
						},
					}),
					8_000,
					"Rejected teardown prevented the final task receipt",
				);
				expect(result.exitCode).toBe(1);
				expect(result.error).toContain("Subagent teardown failed");
				expect(result.error).toContain("Failed to release daemon clients");
				expect(result.aborted).toBe(yieldStatus === "aborted");
				if (yieldStatus === "aborted") {
					expect(result.abortReason).toBe("aborted by test");
					expect(JSON.parse(result.output)).toEqual({ aborted: true, error: "aborted by test" });
				} else {
					expect(result.output).toContain("finished");
				}
				expect(client.closed).toBe(true);
				expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
				if (keepAlive) {
					expect(registry.get(laneId)).toBe(ref);
					expect(ref.status).toBe("idle");
					expect(ref.lifecycle?.acceptedAt).toBeNumber();
					expect(session.isDisposed).toBe(false);
				} else {
					const teardownDeadlineAt = Date.now() + SHUTDOWN_OBSERVE_TIMEOUT_MS;
					await withTimeout(
						Promise.all([session.dispose(), mcpDisconnected.promise, jobAborted.promise]),
						SHUTDOWN_OBSERVE_TIMEOUT_MS,
						"One-shot session disposal or owner reap did not settle",
					);
					expect(registry.get(laneId)).toBeUndefined();
					expect(session.isDisposed).toBe(true);
					expect(session.messages).toHaveLength(0);
					expect(manager.getEntries()).toHaveLength(0);
					if (shutdownJobId === undefined || deferredCleanup === undefined) {
						throw new Error("Shutdown work was not retained for deferred owner reaping");
					}
					expect(jobs.getJob(shutdownJobId)?.status).toBe("cancelled");
					jobGate.resolve();
					await withTimeout(
						deferredCleanup,
						Math.max(1, teardownDeadlineAt - Date.now()),
						"Deferred shutdown cleanup lost ownership",
					);
				}
				// Negative control: the parent's cached client remains live and usable.
				expect(parent.closed).toBe(false);
				expect((await parent.request({ op: "ping" })).op).toBe("ping");
				await waitForBrokerExit(client.runtimeDir);
			} finally {
				failed.mockRestore();
				factory.mockRestore();
				jobGate.resolve();
				await deferredCleanup;
				await AgentLifecycleManager.global().release(laneId, ref);
				await session.dispose();
				await jobs.dispose({ timeoutMs: 2_000 });
				for (const id of [sessionId, parentId]) await releaseDaemonClientsForSession(id);
				await Promise.all([client, parent].map(control => waitForBrokerExit(control.runtimeDir)));
				authStorage.close();
			}
		}, 30_000);
	}

	for (const transition of [
		"switch",
		"new",
		"dispose",
		"new-rebuild-failure",
		"keep-alive-complete",
		"keep-alive-budget-abort",
	] as const) {
		it(`AgentSession ${transition} returns only after owned daemons stop, preserving parent and sibling`, async () => {
			using tempDir = TempDir.createSync("@omp-agent-session-daemon-release-");
			const projectDir = tempDir.path();
			const authStorage = createInMemoryAuthStorage();
			const manager = SessionManager.create(projectDir, path.join(projectDir, "sessions"));
			manager.appendMessage({ role: "user", content: "source session", timestamp: 1 });
			await manager.ensureOnDisk();
			await manager.flush();
			const sourceFile = manager.getSessionFile();
			if (!sourceFile) throw new Error("Expected persisted source session");
			const session = new AgentSession({
				agent: new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage, path.join(projectDir, "models.yml")),
			});
			const previousId = manager.getSessionId();
			const parentId = crypto.randomUUID();
			const siblingId = crypto.randomUUID();
			const registry = AgentRegistry.global();
			const laneId = `release-lane-${crypto.randomUUID()}`;
			let laneRegistered = false;
			const client = await daemonClientForProject(projectDir, previousId, { idleGraceMs: IDLE_GRACE_MS });
			const parent = await daemonClientForProject(projectDir, parentId, { idleGraceMs: IDLE_GRACE_MS });
			const sibling = await daemonClientForProject(projectDir, siblingId, { idleGraceMs: IDLE_GRACE_MS });
			const observer = await createDaemonBrokerClient(projectDir, {
				runtimeDir: client.runtimeDir,
				idleGraceMs: IDLE_GRACE_MS,
			});
			try {
				const persistentDaemon = await startFixtureDaemon(client, "persistent-slow-stop", { ignoreTerm: true });
				const detachedDaemon = await startFixtureDaemon(client, "detached-slow-stop", {
					ignoreTerm: true,
					detached: true,
				});
				const parentDaemon = await startFixtureDaemon(parent, "parent-service");
				const siblingDaemon = await startFixtureDaemon(sibling, "sibling-service");
				await observer.request({ op: "ping" });
				// Ordinary root turn cancellation is not a transcript end.
				await session.abort();
				expect(client.closed).toBe(false);
				expect(persistentDaemon.status()).toBe(ProcessStatus.Running);
				expect(detachedDaemon.status()).toBe(ProcessStatus.Running);

				if (transition === "switch") {
					// Reload and a rolled-back cwd adoption must leave the source session live.
					expect(await session.switchSession(sourceFile)).toBe(true);
					expect(manager.getSessionId()).toBe(previousId);
					expect(client.closed).toBe(false);
					expect(persistentDaemon.status()).toBe(ProcessStatus.Running);
					const targetDir = path.join(projectDir, "target");
					await fs.mkdir(targetDir);
					const target = SessionManager.create(targetDir, path.join(targetDir, "sessions"));
					let targetFile: string;
					const targetId = target.getSessionId();
					try {
						target.appendMessage({ role: "user", content: "target session", timestamp: 2 });
						await target.ensureOnDisk();
						await target.flush();
						const persisted = target.getSessionFile();
						if (!persisted) throw new Error("Expected persisted target session");
						targetFile = persisted;
					} finally {
						await target.close();
					}
					expect(await session.switchSession(targetFile)).toBe(false);
					expect(manager.getSessionId()).toBe(previousId);
					expect(client.closed).toBe(false);
					expect(detachedDaemon.status()).toBe(ProcessStatus.Running);
					expect(await hasCachedDaemonClientForSession(projectDir, previousId)).toBe(true);
					expect(await session.switchSession(targetFile, { onCwdChange: async () => true })).toBe(true);
					expect(manager.getSessionId()).toBe(targetId);
				} else if (transition.startsWith("keep-alive")) {
					const ref = registry.register({
						id: laneId,
						displayName: laneId,
						kind: "sub",
						session,
						sessionFile: sourceFile,
					});
					laneRegistered = true;
					await finalizeSubagentLifecycle({
						id: laneId,
						session,
						aborted: transition === "keep-alive-budget-abort",
						abortKind: transition === "keep-alive-budget-abort" ? "budget" : undefined,
						keepAlive: true,
						isolated: false,
						agentIdleTtlMs: 0,
						reviveSession: async () => session,
						cleanupDeadlineAt: Date.now() - 1,
						onCleanupDeferred: () => {
							throw new Error("Daemon release was deferred past lane settle");
						},
					});
					expect(session.isDisposed).toBe(false);
					expect(registry.get(laneId)).toBe(ref);
					expect(ref.status).toBe("idle");
					expect(ref.session).toBe(session);
				} else if (transition === "dispose") {
					const disposing = session.dispose();
					expect(session.dispose()).toBe(disposing);
					await disposing;
					expect(session.isDisposed).toBe(true);
				} else if (transition === "new-rebuild-failure") {
					const failure = new Error("New-session prompt rebuild failed");
					const refresh = spyOn(session, "refreshBaseSystemPrompt").mockRejectedValueOnce(failure);
					try {
						await expect(session.newSession()).rejects.toBe(failure);
					} finally {
						refresh.mockRestore();
					}
					expect(manager.getSessionId()).not.toBe(previousId);
				} else {
					expect(await session.newSession()).toBe(true);
					expect(manager.getSessionId()).not.toBe(previousId);
				}

				expect(persistentDaemon.status()).toBe(ProcessStatus.Exited);
				expect(detachedDaemon.status()).toBe(ProcessStatus.Exited);
				expect(client.closed).toBe(true);
				await expect(client.request({ op: "ping" })).rejects.toThrow();
				expect(await hasCachedDaemonClientForSession(projectDir, previousId)).toBe(false);
				const stopped = await observer.request({ op: "list" });
				if (stopped.op !== "list") throw new Error("Expected daemon list after transition");
				expect(stopped.daemons).toHaveLength(2);
				expect(stopped.daemons.every(daemon => daemon.state === "exited" || daemon.state === "failed")).toBe(true);

				expect(parentDaemon.status()).toBe(ProcessStatus.Running);
				expect(siblingDaemon.status()).toBe(ProcessStatus.Running);
				for (const control of [parent, sibling]) {
					expect(control.closed).toBe(false);
					expect((await control.request({ op: "ping" })).op).toBe("ping");
					expect(await readLiveDaemonBrokerPid(control.runtimeDir)).toBeDefined();
				}
				observer.close();
				await waitForBrokerExit(client.runtimeDir);
			} finally {
				observer.close();
				if (laneRegistered) await AgentLifecycleManager.global().release(laneId);
				await session.dispose();
				for (const id of [previousId, parentId, siblingId]) await releaseDaemonClientsForSession(id);
				await Promise.all([client, parent, sibling].map(control => waitForBrokerExit(control.runtimeDir)));
				authStorage.close();
			}
		}, 60_000);
	}
});
