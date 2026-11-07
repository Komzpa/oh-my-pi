import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { isShellTrace } from "@oh-my-pi/pi-wire";
import { parseDirtyPathsWithStatus } from "../autoresearch/git";
import { IrcBus } from "../irc/bus";
import type { AgentRegistryApi } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { PeerCoordination, type Deconfliction } from "./peer-coordination";

const runtimes = new WeakMap<AgentSession, PeerRuntime>();
export function checkPeerSessionHandover(session: AgentSession): Promise<string | undefined> {
	return runtimes.get(session)?.checkHandover(undefined) ?? Promise.resolve(undefined);
}

/** Read actual Linux listening sockets owned by recorded shell children, never infer ports from commands. */
export async function listeningPorts(pids: readonly number[]): Promise<number[]> {
	if (process.platform !== "linux") return [];
	const inodes = new Set<string>();
	const pending = [...pids];
	const seen = new Set<number>();
	for (const pid of pending) {
		if (seen.has(pid) || !Number.isSafeInteger(pid) || pid <= 0) continue;
		seen.add(pid);
		try {
			const children = await Bun.file(`/proc/${pid}/task/${pid}/children`).text();
			pending.push(...children.trim().split(/\s+/).map(Number));
			for (const fd of await fs.promises.readdir(`/proc/${pid}/fd`)) {
				try {
					const target = await fs.promises.readlink(`/proc/${pid}/fd/${fd}`);
					if (target.startsWith("socket:[")) inodes.add(target.slice(8, -1));
				} catch {
					/* Process/descriptor closed during observation. */
				}
			}
		} catch {
			/* The recorded child has already exited. */
		}
	}
	const ports = new Set<number>();
	for (const table of ["tcp", "tcp6"]) {
		const text = await Bun.file(`/proc/net/${table}`).text();
		for (const line of text.split("\n").slice(1)) {
			const columns = line.trim().split(/\s+/);
			if (columns[3] === "0A" && inodes.has(columns[9])) ports.add(Number.parseInt(columns[1].split(":")[1], 16));
		}
	}
	return [...ports];
}

/** One monitor on the session's home thread, including revived sessions. */
export class PeerRuntime {
	readonly #coordination: PeerCoordination;
	readonly #unsubscribe: () => void;
	readonly #pids = new Set<number>();
	#baseline = new Map<string, string>();
	#head: string | null | undefined;
	#branch: string | null | undefined;
	#pending: Promise<void> = Promise.resolve();
	readonly #abort = new AbortController();
	#initialization: Promise<void> | undefined;
	#startupWatcher: fs.FSWatcher | undefined;
	readonly #startupPaths = new Set<string>();
	#toolStarted = false;
	constructor(
		readonly session: AgentSession,
		readonly id: string,
		readonly cwd: string,
		readonly registry: AgentRegistryApi,
	) {
		this.#coordination = new PeerCoordination(registry, id, IrcBus.global(), content => {
			void session
				.sendCustomMessage(
					{ customType: "peer-coordination", content, display: false },
					{ deliverAs: "aside", wakeIdle: false },
				)
				.catch(error => logger.debug("Peer notice failed", { id, error: String(error) }));
		});
		this.#unsubscribe = session.subscribe(event => {
			if (this.#abort.signal.aborted) return;
			if (event.type === "tool_execution_start") this.#toolStarted = true;
			if (event.type !== "tool_execution_end" && event.type !== "tool_execution_update") return;
			const result: unknown = event.type === "tool_execution_end" ? event.result : event.partialResult;
			const details = isRecord(result) ? result.details : undefined;
			const trace = isRecord(details) ? details.trace : undefined;
			if (isShellTrace(trace)) {
				for (const unit of trace.units)
					for (const node of unit.nodes) {
						if (node.pid) this.#pids.add(node.pid);
						if (node.state === "ok")
							for (const redir of node.redirs ?? []) {
								// Upstream ShellTraceBytes: a non-UTF-8 target arrives as raw bytes and names no trackable path.
								const target: unknown = redir.target;
								if (typeof target === "string" && [">", ">>", ">|", "&>", "&>>"].includes(redir.op))
									this.touch(target);
							}
					}
			}
			if (event.type === "tool_execution_end")
				this.#pending = this.#pending
					.then(() => this.#observe())
					.catch(error => {
						logger.debug("Peer observation failed", { id, error: String(error) });
					});
		});
		runtimes.set(session, this);
	}
	/** Optional repository metadata must never gate SDK readiness. */
	startInitialization(): void {
		this.#pending = this.initialize().catch(error => {
			if (!this.#abort.signal.aborted) logger.debug("Peer baseline failed", { id: this.id, error: String(error) });
		});
	}
	initialize(): Promise<void> {
		return (this.#initialization ??= this.#initialize());
	}
	async #initialize(): Promise<void> {
		const signal = this.#abort.signal;
		if (signal.aborted) return;
		const repository = vcs.git(this.#scopeRoot());
		if (!repository) return;
		const root = repository.info().repoRoot ?? this.cwd;
		// HEAD is cheap and synchronous: an early commit must not become our baseline.
		const head = repository.headSync();
		this.#head = head.commit;
		this.#branch = head.branch;
		// Status can sit in the shared cooldown while tools already run. Retain filesystem
		// changes in that window, including edits to dirty files and deletions, without
		// mistaking all pre-existing dirty work for this worker's mutations.
		// The watcher is best-effort attribution. A recursive watch can fail on deep or
		// unusual trees (ENAMETOOLONG, EMFILE, ENOSPC) either synchronously or as an
		// async "error" event; neither may take down the host process.
		const dropWatcher = (error: unknown) => {
			logger.warn("Peer startup watcher unavailable; early-path attribution degraded", {
				root,
				error: String(error),
			});
			try {
				this.#startupWatcher?.close();
			} catch {}
			this.#startupWatcher = undefined;
		};
		// Opt-in: a recursive watch walks the whole worktree (node_modules, tmp trees) on
		// every launch; on the DC repo it crashed the lead (ENAMETOOLONG) and blocked
		// the main thread. Without it, early edits fall back to status-diff attribution.
		if (process.env.OMP_PEER_STARTUP_WATCH === "1")
			try {
				this.#startupWatcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
					if (
						!signal.aborted &&
						this.#toolStarted &&
						filename &&
						filename !== ".git" &&
						!filename.startsWith(`.git${path.sep}`)
					)
						this.#startupPaths.add(path.resolve(root, filename));
				});
				this.#startupWatcher.on("error", dropWatcher);
			} catch (error) {
				dropWatcher(error);
			}
		try {
			const status = await repository.statusPorcelain({ untracked: "all", nulTerminated: true }, signal);
			if (signal.aborted) return;
			const baseline = await this.#snapshot(root, status);
			if (signal.aborted) return;
			// Drain filesystem notifications before replacing the startup watcher with status diffs.
			await Bun.sleep(0);
			if (signal.aborted) return;
			this.#baseline = baseline;
			if (this.#startupPaths.size) {
				const [tracked, untracked] = await Promise.all([
					repository.lsFiles(false, true, signal),
					repository.lsFiles(true, true, signal),
				]);
				if (signal.aborted) return;
				const candidates = new Set(
					[...baseline.keys(), ...tracked, ...untracked].map(value => path.resolve(root, value)),
				);
				this.#touchObservedPaths([...this.#startupPaths].filter(value => candidates.has(value)));
			}
		} finally {
			this.#startupWatcher?.close();
			this.#startupWatcher = undefined;
			this.#startupPaths.clear();
		}
	}
	#touchObservedPaths(paths: string[]): void {
		if (this.#abort.signal.aborted) return;
		const scopeRoot = this.#scopeRoot();
		const state = this.registry.get(this.id)?.history?.peerCoordination;
		const shared = this.registry
			.list()
			.some(
				peer =>
					peer.id !== this.id &&
					peer.status === "running" &&
					peer.history?.peerCoordination?.scope.root === scopeRoot,
			);
		const owned = (state?.scope.paths ?? []).map(value => path.resolve(scopeRoot, value));
		this.#coordination.touch(
			paths
				.filter(value => !shared || owned.some(scope => value === scope || value.startsWith(`${scope}${path.sep}`)))
				.map(value => `path:${value}`),
		);
	}
	#scopeRoot(): string {
		return path.resolve(this.cwd, this.registry.get(this.id)?.history?.peerCoordination?.scope.root ?? this.cwd);
	}
	async #snapshot(root: string, status: string): Promise<Map<string, string>> {
		const snapshot = new Map<string, string>();
		for (const entry of parseDirtyPathsWithStatus(status)) {
			if (this.#abort.signal.aborted) break;
			try {
				const stat = await fs.promises.lstat(path.resolve(root, entry.path), { bigint: true });
				snapshot.set(entry.path, `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`);
			} catch {
				// A deletion still changes the observed Git state.
				snapshot.set(entry.path, "deleted");
			}
		}
		return snapshot;
	}

	touch(value: string): void {
		if (!this.#abort.signal.aborted && !value.includes("://"))
			this.#coordination.touch([`path:${path.resolve(this.cwd, value)}`]);
	}
	async #observe(): Promise<void> {
		if (this.#abort.signal.aborted) return;
		const scopeRoot = this.#scopeRoot();
		const repository = vcs.git(scopeRoot);
		if (repository) {
			const status = await repository.statusPorcelain({ untracked: "all", nulTerminated: true }, this.#abort.signal);
			if (this.#abort.signal.aborted) return;
			const root = repository.info().repoRoot ?? this.cwd;
			const snapshot = await this.#snapshot(root, status);
			if (this.#abort.signal.aborted) return;
			const shared = this.registry
				.list()
				.some(
					peer =>
						peer.id !== this.id &&
						peer.status === "running" &&
						peer.history?.peerCoordination?.scope.root === scopeRoot,
				);
			// Git status belongs to a checkout, not to an agent. In a shared checkout only
			// corroborate the worker's declared paths; actual tool mutations are attributed directly.
			const paths = [...new Set([...snapshot.keys(), ...this.#baseline.keys()])]
				.filter(value => this.#baseline.get(value) !== snapshot.get(value))
				.map(value => path.resolve(root, value));
			this.#baseline = snapshot;
			this.#touchObservedPaths(paths);
			const branch = await repository.currentBranch(this.#abort.signal);
			const head = await repository.headSha(this.#abort.signal);
			if (this.#abort.signal.aborted) return;
			if (!shared && branch && (branch !== this.#branch || head !== this.#head)) {
				this.#coordination.touch([`branch:${root}:${branch}`]);
			}
			this.#branch = branch;
			this.#head = head;
		}
		const ports = await listeningPorts([...this.#pids]);
		if (!this.#abort.signal.aborted) this.#coordination.touch(ports.map(port => `port:${port}`));
	}
	async checkHandover(value: unknown): Promise<string | undefined> {
		await this.#pending;
		if (this.#abort.signal.aborted) return;
		await this.#observe();
		if (this.#abort.signal.aborted) return;
		const entries = Array.isArray(value)
			? value.filter(
					(entry): entry is Deconfliction =>
						isRecord(entry) &&
						typeof entry.peer === "string" &&
						typeof entry.resource === "string" &&
						typeof entry.agreement === "string",
				)
			: [];
		return this.#coordination.checkHandover(entries);
	}
	dispose(): void {
		this.#abort.abort();
		this.#startupWatcher?.close();
		this.#startupWatcher = undefined;
		this.#startupPaths.clear();
		this.#unsubscribe();
		this.#coordination.dispose();
		runtimes.delete(this.session);
	}
}
