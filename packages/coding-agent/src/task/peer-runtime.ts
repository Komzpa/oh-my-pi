import * as fs from "node:fs/promises";
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
			for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
				try {
					const target = await fs.readlink(`/proc/${pid}/fd/${fd}`);
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
								if ([">", ">>", ">|", "&>", "&>>"].includes(redir.op)) this.touch(redir.target);
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
	async initialize(): Promise<void> {
		const repository = vcs.git(this.#scopeRoot());
		if (!repository) return;
		const status = await repository.statusPorcelain({ untracked: "all", nulTerminated: true });
		this.#baseline = await this.#snapshot(repository.info().repoRoot ?? this.cwd, status);
		this.#head = await repository.headSha();
		this.#branch = await repository.currentBranch();
	}
	#scopeRoot(): string {
		return path.resolve(this.cwd, this.registry.get(this.id)?.history?.peerCoordination?.scope.root ?? this.cwd);
	}
	async #snapshot(root: string, status: string): Promise<Map<string, string>> {
		const snapshot = new Map<string, string>();
		for (const entry of parseDirtyPathsWithStatus(status)) {
			try {
				const stat = await fs.lstat(path.resolve(root, entry.path), { bigint: true });
				snapshot.set(entry.path, `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`);
			} catch {
				// A deletion still changes the observed Git state.
				snapshot.set(entry.path, "deleted");
			}
		}
		return snapshot;
	}

	touch(value: string): void {
		if (!value.includes("://")) this.#coordination.touch([`path:${path.resolve(this.cwd, value)}`]);
	}
	async #observe(): Promise<void> {
		const scopeRoot = this.#scopeRoot();
		const repository = vcs.git(scopeRoot);
		if (repository) {
			const status = await repository.statusPorcelain({ untracked: "all", nulTerminated: true });
			const root = repository.info().repoRoot ?? this.cwd;
			const snapshot = await this.#snapshot(root, status);
			const state = this.registry.get(this.id)?.history?.peerCoordination;
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
			const owned = (state?.scope.paths ?? []).map(value => path.resolve(scopeRoot, value));
			this.#coordination.touch(
				paths
					.filter(
						value => !shared || owned.some(scope => value === scope || value.startsWith(`${scope}${path.sep}`)),
					)
					.map(value => `path:${value}`),
			);
			const branch = await repository.currentBranch();
			const head = await repository.headSha();
			if (!shared && branch && (branch !== this.#branch || head !== this.#head)) {
				this.#coordination.touch([`branch:${root}:${branch}`]);
			}
			this.#branch = branch;
			this.#head = head;
		}
		this.#coordination.touch((await listeningPorts([...this.#pids])).map(port => `port:${port}`));
	}
	async checkHandover(value: unknown): Promise<string | undefined> {
		await this.#pending;
		await this.#observe();
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
		this.#unsubscribe();
		this.#coordination.dispose();
		runtimes.delete(this.session);
	}
}
