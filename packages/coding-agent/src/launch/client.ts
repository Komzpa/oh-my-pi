import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, ToolResourceScope } from "@oh-my-pi/pi-natives";
import { toolSessionEnvironment } from "../exec/session-slice";
import { getGlobalDaemonRuntimeDir, isEexist, isEnoent, logger, postmortem } from "@oh-my-pi/pi-utils";
import { spawnBackground } from "@oh-my-pi/pi-utils/background-priority";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { canonicalProjectDir, daemonBrokerEndpoint, daemonRuntimeDir } from "./paths";
import { readLiveDaemonBrokerPid } from "./presence";
import {
	DAEMON_BROKER_WORKER_ARG,
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
	type DaemonOperation,
	type DaemonRpcResult,
	type DaemonWireMessage,
	parseDaemonRpcResult,
	parseDaemonWireMessage,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 50;
/**
 * Delay before a connect poll may conclude the spawned broker died without
 * binding and spawn a replacement (grievance #976). Short enough to stay
 * inside the connect budget, long enough that a normally starting broker has
 * written its pid lease by the time the first liveness probe runs.
 */
const CONNECT_RESPAWN_GRACE_MS = 1_000;
const TOKEN_FILE = "broker.token";
/**
 * The broker must outlive whichever omp process happened to spawn it: other
 * clients (and persistent daemons) still hold its lease. Bun on Windows puts
 * every non-detached child in a kill-on-close job object owned by the parent,
 * so an undetached broker died with its spawner and took the scope's daemons
 * with it. Detached, it has no console; its daemons then spawn hidden.
 */
const BROKER_SPAWN_OPTIONS = { detached: true, windowsHide: true } as const;

interface PendingRequest {
	operation: DaemonOperation;
	resolve: (result: DaemonRpcResult) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	removeAbort?: () => void;
}

/** Broker location and lifecycle overrides used by smoke tests and isolated consumers. */
export interface DaemonBrokerClientOptions {
	sessionId?: string;
	/** Runtime directory override; defaults to the project-scoped config path. */
	runtimeDir?: string;
	/** Last-client shutdown grace override in milliseconds. */
	idleGraceMs?: number;
}

export interface DaemonCompletionUnregisterOptions {
	/** Detach this process without deleting broker-persisted pending notifications. */
	preservePending?: boolean;
}

/** Persistent per-process connection to one project or global daemon broker. */
export interface DaemonBrokerClient {
	onCompletion(
		owner: string,
		sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void;
	/** Canonical project directory or synthetic directory identifying a global scope. */
	readonly projectDir: string;
	readonly runtimeDir: string;
	/** True once close() has run; closed clients reject new requests. */
	readonly closed: boolean;
	request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult>;
	close(): void;
}

/** A request reached the broker and the broker rejected the operation. */
export class DaemonBrokerRejectedError extends Error {}

async function readOrCreateToken(runtimeDir: string): Promise<string> {
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const tokenPath = path.join(runtimeDir, TOKEN_FILE);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			// node:fs, not Bun.file().text(): on Windows (Bun 1.4.2) a Bun.file
			// read that rejects with ENOENT holds no event-loop ref, so the loop
			// drains mid-await — `omp --smoke-test` exited 1 via the unsettled-entry
			// guard, and a bare script silently stops at that await.
			const token = (await fs.readFile(tokenPath, "utf8")).trim();
			if (token.length > 0) return token;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		try {
			const handle = await fs.open(tokenPath, "wx", 0o600);
			try {
				const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
				await handle.writeFile(token, "utf8");
				return token;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out initializing daemon broker token in ${runtimeDir}`);
}

function requestTimeoutMs(operation: DaemonOperation): number {
	switch (operation.op) {
		case "start":
			return (operation.spec.ready?.timeoutMs ?? CONNECT_TIMEOUT_MS) + 5_000;
		case "wait":
		case "logs":
		case "stop":
			return operation.timeoutMs + 5_000;
		case "release":
			return operation.timeoutMs * 2 + 30_000;
		default:
			return 30_000;
	}
}

class SocketDaemonClient implements DaemonBrokerClient {
	readonly projectDir: string;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	#token: string;
	readonly #seenCompletionIds = new Set<string>();
	readonly #idleGraceMs: number | undefined;
	readonly #sessionId: string | undefined;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #completionSinks = new Map<string, (notification: DaemonCompletionNotification) => Promise<void> | void>();
	readonly #completionUnsubscribes = new Set<string>();
	readonly #preservedCompletionOwners = new Set<string>();
	readonly #completionReplays = new Set<string>();
	readonly #inFlightCompletionIds = new Set<string>();
	readonly #completionSubscriptionId = crypto.randomUUID();
	#socket: IpcConnection | undefined;
	#connectPromise: Promise<void> | undefined;
	#closed = false;
	#hasConnected = false;
	#completionReconnectTimer: NodeJS.Timeout | undefined;

	constructor(projectDir: string, runtimeDir: string, token: string, options: DaemonBrokerClientOptions) {
		this.#sessionId = options.sessionId;
		this.projectDir = projectDir;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = daemonBrokerEndpoint(runtimeDir);
		this.#token = token;
		this.#idleGraceMs = options.idleGraceMs;
	}

	get runtimeDir(): string {
		return this.#runtimeDir;
	}

	get closed(): boolean {
		return this.#closed;
	}

	async request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult> {
		if (this.#closed) throw new Error("Daemon broker client is closed");
		if (signal?.aborted) throw new Error("Daemon broker request aborted");
		// A failed acquisition has no admitted operations to drain. In-flight
		// connects still settle before release; previously connected scopes may
		// need recovery after a disconnect, including their detached daemons.
		if (operation.op === "release" && !this.#connectPromise && !this.#hasConnected) return { op: "release" };
		await this.#connect();
		if (this.#closed) throw new Error("Daemon broker client is closed");
		const socket = this.#socket;
		if (!socket || socket.closed) throw new Error("Daemon broker socket is unavailable");

		const completionUnsubscribes = [...this.#completionUnsubscribes];
		const completionReplays = [...this.#completionReplays];
		const id = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<DaemonRpcResult>();
		const timer = setTimeout(() => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			pending.removeAbort?.();
			reject(new Error(`Daemon ${operation.op} request timed out`));
		}, requestTimeoutMs(operation));
		const pending: PendingRequest = { operation, resolve, reject, timer };
		if (signal) {
			const abort = (): void => {
				if (!this.#pending.delete(id)) return;
				clearTimeout(timer);
				reject(new Error("Daemon broker request aborted"));
				// Dropping the local entry alone leaves the broker polling a wait or
				// follow until its own timeout; ask it to stop. The answer is unread.
				if ((operation.op === "wait" || operation.op === "logs") && !socket.closed) {
					socket.send(
						JSON.stringify({
							id: crypto.randomUUID(),
							token: this.#token,
							operation: { op: "cancel", requestId: id } satisfies DaemonOperation,
						}),
					);
				}
			};
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.#pending.set(id, pending);
		socket.send(
			JSON.stringify({
				id,
				token: this.#token,
				owners: [...this.#completionSinks.keys()],
				detachedOwners: [...this.#preservedCompletionOwners],
				completionEvents: true,
				completionUnsubscribes,
				completionReplays,
				completionSubscriptionId: this.#completionSubscriptionId,
				operation,
			}),
		);
		const result = await promise;
		for (const owner of completionUnsubscribes) {
			if (!this.#completionSinks.has(owner)) this.#completionUnsubscribes.delete(owner);
		}
		for (const owner of completionReplays) {
			if (this.#completionSinks.has(owner)) this.#completionReplays.delete(owner);
		}
		return result;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#completionReconnectTimer);
		this.#completionReconnectTimer = undefined;
		this.#socket?.destroy();
		this.#completionSinks.clear();
		this.#preservedCompletionOwners.clear();
		this.#completionReplays.clear();
		this.#socket = undefined;
		this.#rejectPending(new Error("Daemon broker client closed"));
	}

	onCompletion(
		owner: string,
		sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void {
		this.#completionUnsubscribes.delete(owner);
		if (this.#preservedCompletionOwners.delete(owner)) this.#completionReplays.add(owner);
		this.#completionSinks.set(owner, sink);
		this.#publishCompletionOwners();
		return options => {
			if (this.#completionSinks.get(owner) !== sink) return;
			this.#completionSinks.delete(owner);
			if (options?.preservePending) {
				this.#preservedCompletionOwners.add(owner);
			} else {
				this.#preservedCompletionOwners.delete(owner);
				this.#completionUnsubscribes.add(owner);
			}
			if (this.#completionSinks.size === 0 && this.#completionReconnectTimer) {
				clearTimeout(this.#completionReconnectTimer);
				this.#completionReconnectTimer = undefined;
			}
			this.#publishCompletionOwners();
		};
	}

	#publishCompletionOwners(): void {
		if (this.#closed) return;
		void this.request({ op: "ping" }).catch(() => this.#scheduleCompletionReconnect());
	}

	#scheduleCompletionReconnect(): void {
		if (
			this.#closed ||
			this.#completionSinks.size === 0 ||
			this.#completionReconnectTimer !== undefined ||
			(this.#socket !== undefined && !this.#socket.closed)
		) {
			return;
		}
		this.#completionReconnectTimer = setTimeout(() => {
			this.#completionReconnectTimer = undefined;
			this.#publishCompletionOwners();
		}, CONNECT_RETRY_MS);
		this.#completionReconnectTimer.unref();
	}

	async #connect(): Promise<void> {
		if (this.#socket && !this.#socket.closed) return;
		if (this.#connectPromise) return this.#connectPromise;
		this.#connectPromise = this.#connectOnce();
		try {
			await this.#connectPromise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async #connectOnce(): Promise<void> {
		// The broker authenticates against the token file it read at startup. A
		// replacement broker may have started from a different file, or a deleted
		// runtime dir may need a fresh one before any broker can start.
		this.#token = await readOrCreateToken(this.#runtimeDir);
		try {
			this.#bindSocket(await IpcConnection.connect(this.#endpoint, { framing: "lines", timeoutMs: 250 }));
			return;
		} catch {
			// No live broker. Multiple clients may race to spawn; the broker's
			// process-owned lease selects one winner before any candidate touches
			// the socket.
		}
		if (this.#closed) throw new Error("Daemon broker client is closed");
		await this.#spawnBroker();
		let lastSpawnAt = Date.now();
		const deadline = lastSpawnAt + CONNECT_TIMEOUT_MS;
		let lastError: Error | undefined;
		let respawned = false;
		while (Date.now() < deadline) {
			if (this.#closed) throw new Error("Daemon broker client is closed");
			try {
				this.#bindSocket(await IpcConnection.connect(this.#endpoint, { framing: "lines", timeoutMs: 250 }));
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				// A missing endpoint with no live broker pid means the spawn died
				// without binding (crash, or a lease winner that then died): nobody
				// is coming, so spawn one bounded replacement instead of waiting out
				// the budget on a dead scope. A live pid means a broker owns the
				// scope and may still bind, so keep waiting for it.
				if (!respawned && Date.now() - lastSpawnAt >= CONNECT_RESPAWN_GRACE_MS) {
					if ((await readLiveDaemonBrokerPid(this.#runtimeDir)) === undefined) {
						respawned = true;
						lastSpawnAt = Date.now();
						try {
							await this.#spawnBroker();
						} catch (spawnError) {
							lastError = spawnError instanceof Error ? spawnError : new Error(String(spawnError));
						}
					}
				}
				await Bun.sleep(CONNECT_RETRY_MS);
			}
		}
		throw new Error(
			`Failed to start daemon broker at ${this.#endpoint} after ${CONNECT_TIMEOUT_MS / 1000}s: ` +
				`${lastError?.message ?? "socket unavailable"}. Scope: ${this.#runtimeDir}. ` +
				"Run `omp --smoke-test` to verify broker startup, or `omp ps` to inspect supervised processes.",
		);
	}

	async #spawnBroker(): Promise<void> {
		const spawn = resolveWorkerSpawnCmd(DAEMON_BROKER_WORKER_ARG);
		const overlay: Record<string, string> = {
			[DAEMON_PROJECT_DIR_ENV]: this.projectDir,
			[DAEMON_RUNTIME_DIR_ENV]: this.#runtimeDir,
		};
		if (this.#idleGraceMs !== undefined) overlay[DAEMON_IDLE_GRACE_ENV] = String(this.#idleGraceMs);
		const env = await toolSessionEnvironment(this.#sessionId, workerEnvFromParent(overlay));
		if (this.#closed) throw new Error("Daemon broker client is closed");
		const scope = this.#sessionId ? new ToolResourceScope() : undefined;
		const command = scope ? await scope.wrapCommandAsync(spawn.cmd, env) : spawn.cmd;
		if (this.#closed) {
			scope?.close();
			throw new Error("Daemon broker client is closed");
		}
		const child = spawnBackground(command, {
			cwd: spawn.cwd,
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			...BROKER_SPAWN_OPTIONS,
		});
		child.unref();
		if (scope) void child.exited.finally(() => scope.close());
	}

	#bindSocket(socket: IpcConnection): void {
		this.#socket = socket;
		this.#hasConnected = true;
		socket.start(
			line => this.#onLine(line),
			() => {
				// One stable error regardless of the close reason.
				if (this.#socket === socket) this.#socket = undefined;
				this.#rejectPending(new Error("Daemon broker connection closed"));
				this.#scheduleCompletionReconnect();
			},
		);
	}

	#onLine(line: string): void {
		let decoded: unknown;
		try {
			decoded = JSON.parse(line);
		} catch (error) {
			this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		let message: DaemonWireMessage;
		try {
			message = parseDaemonWireMessage(decoded);
		} catch (error) {
			const parseError = error instanceof Error ? error : new Error(String(error));
			if (
				typeof decoded === "object" &&
				decoded !== null &&
				"event" in decoded &&
				decoded.event === "daemon-completed"
			) {
				logger.warn("Ignoring malformed daemon completion", { error: parseError.message });
				return;
			}
			this.#rejectPending(parseError);
			return;
		}
		if ("event" in message) {
			void this.#deliverCompletion(message);
			return;
		}
		const response = message;
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		this.#pending.delete(response.id);
		clearTimeout(pending.timer);
		pending.removeAbort?.();
		if (!response.ok) {
			pending.reject(new DaemonBrokerRejectedError(response.error));
			return;
		}
		try {
			pending.resolve(parseDaemonRpcResult(pending.operation, response.result));
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	async #deliverCompletion(message: DaemonCompletionNotification): Promise<void> {
		if (this.#seenCompletionIds.has(message.completionId)) {
			this.#ackCompletion(message.completionId);
			return;
		}
		if (this.#inFlightCompletionIds.has(message.completionId)) return;
		const sink = this.#completionSinks.get(message.owner);
		if (!sink) return;
		this.#inFlightCompletionIds.add(message.completionId);
		try {
			await sink(message);
			if (this.#seenCompletionIds.size >= 512) {
				const oldest = this.#seenCompletionIds.values().next().value;
				if (oldest !== undefined) this.#seenCompletionIds.delete(oldest);
			}
			this.#seenCompletionIds.add(message.completionId);
			this.#ackCompletion(message.completionId);
		} catch (error) {
			logger.warn("Daemon completion sink failed", {
				owner: message.owner,
				completionId: message.completionId,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#socket?.destroy();
		} finally {
			this.#inFlightCompletionIds.delete(message.completionId);
		}
	}

	#ackCompletion(completionId: string): void {
		const socket = this.#socket;
		if (!socket || socket.closed) return;
		socket.send(
			JSON.stringify({
				id: crypto.randomUUID(),
				token: this.#token,
				owners: [...this.#completionSinks.keys()],
				detachedOwners: [...this.#preservedCompletionOwners],
				completionEvents: true,
				completionAcks: [completionId],
				completionUnsubscribes: [...this.#completionUnsubscribes],
				completionSubscriptionId: this.#completionSubscriptionId,
				operation: { op: "ping" },
			}),
		);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

type SharedClientKind = "project" | "global";
interface SharedClientEntry {
	promise: Promise<DaemonBrokerClient>;
	kind: SharedClientKind;
	/** Exact owning transcript session id for project clients; undefined for main/global. */
	sessionId?: string;
	release?: Promise<void>;
}
const sharedClients = new Map<string, SharedClientEntry>();
interface SessionClientActivity {
	generation: number;
	lookups: number;
	releases: Set<Promise<void>>;
}
/** Entries exist only while lookups or release work are in flight, never as tombstones. */
const sessionClientActivities = new Map<string, SessionClientActivity>();

function sessionClientActivity(sessionId: string): SessionClientActivity {
	let activity = sessionClientActivities.get(sessionId);
	if (!activity) {
		activity = { generation: 0, lookups: 0, releases: new Set() };
		sessionClientActivities.set(sessionId, activity);
	}
	return activity;
}

function forgetIdleSessionClientActivity(sessionId: string, activity: SessionClientActivity): void {
	if (activity.lookups === 0 && activity.releases.size === 0 && sessionClientActivities.get(sessionId) === activity) {
		sessionClientActivities.delete(sessionId);
	}
}

function withSessionClientRelease(sessionId: string, release: () => Promise<void>): Promise<void> {
	const activity = sessionClientActivity(sessionId);
	activity.generation++;
	const completion = Promise.resolve()
		.then(release)
		.finally(() => {
			activity.releases.delete(completion);
			forgetIdleSessionClientActivity(sessionId, activity);
		});
	activity.releases.add(completion);
	return completion;
}
let cancelExitCleanup: (() => void) | undefined;

const DAEMON_STOP_TIMEOUT_MS = 5_000;

async function stopAllDaemons(client: DaemonBrokerClient): Promise<void> {
	await client.request({ op: "release", timeoutMs: DAEMON_STOP_TIMEOUT_MS });
}

function sharedDaemonClient(
	key: string,
	entry: Omit<SharedClientEntry, "promise">,
	create: () => Promise<DaemonBrokerClient>,
): Promise<DaemonBrokerClient> {
	let existing = sharedClients.get(key);
	if (existing?.release) throw new Error("Daemon broker client is being released");
	if (!existing) {
		existing = { promise: create(), kind: entry.kind, sessionId: entry.sessionId };
		sharedClients.set(key, existing);
		if (!cancelExitCleanup) {
			cancelExitCleanup = postmortem.register("daemon-broker-clients", () => closeDaemonClients());
		}
	}
	return existing.promise;
}

/** Create an independent socket connection to one daemon broker scope. */
export async function createDaemonBrokerClient(
	projectDir: string,
	options: DaemonBrokerClientOptions = {},
): Promise<DaemonBrokerClient> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir =
		options.runtimeDir ??
		(options.sessionId
			? `${daemonRuntimeDir(canonical)}-${Bun.hash(options.sessionId).toString(16)}`
			: daemonRuntimeDir(canonical));
	const token = await readOrCreateToken(runtimeDir);
	return new SocketDaemonClient(canonical, runtimeDir, token, options);
}

/** Get the process-shared daemon broker client for one canonical project directory. */
export async function daemonClientForProject(
	projectDir: string,
	sessionId?: string,
	options?: Pick<DaemonBrokerClientOptions, "idleGraceMs">,
): Promise<DaemonBrokerClient> {
	const normalizedSessionId = sessionId && sessionId.length > 0 ? sessionId : undefined;
	const activity = normalizedSessionId ? sessionClientActivity(normalizedSessionId) : undefined;
	const generation = activity?.generation;
	if (activity) activity.lookups++;
	try {
		if (activity && activity.releases.size > 0) {
			throw new Error("Daemon broker session lookup was superseded by release");
		}
		const canonical = await canonicalProjectDir(projectDir);
		if (activity && (activity.generation !== generation || activity.releases.size > 0)) {
			throw new Error("Daemon broker session lookup was superseded by release");
		}
		return await sharedDaemonClient(
			`project:${canonical}:${normalizedSessionId ?? ""}`,
			{ kind: "project", sessionId: normalizedSessionId },
			() => createDaemonBrokerClient(canonical, { sessionId, idleGraceMs: options?.idleGraceMs }),
		);
	} finally {
		if (activity && normalizedSessionId) {
			activity.lookups--;
			forgetIdleSessionClientActivity(normalizedSessionId, activity);
		}
	}
}

function releaseSharedDaemonClient(key: string, entry: SharedClientEntry): Promise<void> {
	if (entry.release) return entry.release;
	entry.release = entry.promise
		.then(async client => {
			try {
				await stopAllDaemons(client);
			} finally {
				client.close();
			}
		})
		.finally(() => {
			if (sharedClients.get(key) === entry) sharedClients.delete(key);
			if (sharedClients.size === 0) {
				cancelExitCleanup?.();
				cancelExitCleanup = undefined;
			}
		});
	return entry.release;
}

/** Non-creating cache oracle for tests: true while a project client for the exact session is cached. */
export async function hasCachedDaemonClientForSession(projectDir: string, sessionId: string): Promise<boolean> {
	if (sessionId.length === 0) return false;
	const canonical = await canonicalProjectDir(projectDir);
	const entry = sharedClients.get(`project:${canonical}:${sessionId}`);
	return entry?.kind === "project" && entry.sessionId === sessionId;
}

/** Stop and close one session-owned project client without touching other scopes. */
export async function releaseDaemonClientForSession(projectDir: string, sessionId: string): Promise<void> {
	if (sessionId.length === 0) return;
	await withSessionClientRelease(sessionId, async () => {
		const canonical = await canonicalProjectDir(projectDir);
		const key = `project:${canonical}:${sessionId}`;
		const entry = sharedClients.get(key);
		if (!entry || entry.kind !== "project" || entry.sessionId !== sessionId) return;
		await releaseSharedDaemonClient(key, entry);
	});
}

/** Quiesce accepted broker starts, stop daemons, and close this session's exact project clients. */
export async function releaseDaemonClientsForSession(sessionId: string): Promise<void> {
	if (sessionId.length === 0) return;
	await withSessionClientRelease(sessionId, async () => {
		const releases: Promise<void>[] = [];
		for (const [key, entry] of sharedClients) {
			if (entry.kind === "project" && entry.sessionId === sessionId) {
				releases.push(releaseSharedDaemonClient(key, entry));
			}
		}
		const results = await Promise.allSettled(releases);
		const failures = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length > 0)
			throw new AggregateError(failures, `Failed to release daemon clients for session ${sessionId}`);
	});
}

/** Get the process-shared client that leases one profile-independent, machine-global daemon broker. */
export async function daemonClientForGlobal(service: string): Promise<DaemonBrokerClient> {
	const runtimeDir = getGlobalDaemonRuntimeDir(service);
	// Canonicalize only after creation so the first caller and later callers
	// derive the same Windows pipe key even when an ancestor is a symlink.
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const canonical = await fs.realpath(runtimeDir);
	return sharedDaemonClient(`global:${canonical}`, { kind: "global" }, () =>
		createDaemonBrokerClient(canonical, {
			runtimeDir: canonical,
		}),
	);
}

/** Close every project and machine-global broker connection held by this omp process. */
export async function closeDaemonClients(): Promise<void> {
	const entries = [...sharedClients.values()];
	sharedClients.clear();
	for (const entry of await Promise.allSettled(entries.map(item => item.promise))) {
		if (entry.status === "fulfilled") entry.value.close();
	}
	cancelExitCleanup?.();
	cancelExitCleanup = undefined;
}

/** Exercise worker-host broker startup and authenticated RPC for distribution smoke tests. */
export async function smokeTestDaemonBroker(): Promise<void> {
	// Keep the broker's runtime dir under a private parent this process owns, so
	// the broker's dead-scope sweep (pruneDeadDaemonRuntimeDirs, fired on startup)
	// can only ever reclaim siblings inside it — never unrelated neighbours in
	// os.tmpdir() such as tmux/ssh sockets or build trees (issue #8721).
	const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-smoke-"));
	const projectDir = path.join(smokeRoot, "project");
	const runtimeDir = path.join(smokeRoot, "run");
	await fs.mkdir(projectDir, { recursive: true });
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	try {
		const ping = await client.request({ op: "ping" });
		if (ping.op !== "ping" || ping.projectDir !== client.projectDir) throw new Error("daemon broker ping mismatch");
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
		await fs.rm(smokeRoot, { recursive: true, force: true });
	}
}
