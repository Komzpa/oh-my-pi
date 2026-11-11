import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentRegistryApi, AgentRef } from "../registry/agent-registry";
import type { IrcBusApi } from "../irc/bus";
import noticeTemplate from "../prompts/system/peer-coordination-notice.md" with { type: "text" };

export interface PeerScope {
	root?: string;
	branch?: string;
	paths?: string[];
	resources?: string[];
	ports?: number[];
}
export interface PeerCoordinationState {
	task: string;
	profile: string;
	scope: PeerScope;
	touched: string[];
}
export interface Deconfliction {
	peer: string;
	resource: string;
	agreement: string;
}
interface Clash {
	peer: string;
	resource: string;
	since: number;
	generation: number;
}

function declared(state: PeerCoordinationState): string[] {
	const root = state.scope.root ?? "/";
	return [
		...(state.scope.paths ?? []).map(value => `path:${path.resolve(root, value)}`),
		...(state.scope.resources ?? []).map(value => `resource:${value}`),
		...(state.scope.ports ?? []).map(value => `port:${value}`),
		...(state.scope.branch ? [`branch:${root}:${state.scope.branch}`] : []),
	];
}
function overlaps(a: string, b: string): boolean {
	if (!a.startsWith("path:") || !b.startsWith("path:")) return a === b;
	const x = path.resolve(a.slice(5));
	const y = path.resolve(b.slice(5));
	return x === y || x.startsWith(`${y}${path.sep}`) || y.startsWith(`${x}${path.sep}`);
}

/** Registry-backed state crosses worker boundaries through the existing registry RPC. */
export class PeerCoordination {
	#known: Map<string, AgentRef>;
	#clashes = new Map<string, Clash>();
	#unsubscribe: () => void;
	#queued = false;
	#disposed = false;
	constructor(
		readonly registry: AgentRegistryApi,
		readonly self: string,
		readonly bus: IrcBusApi,
		readonly notice: (text: string) => void,
	) {
		this.#known = new Map(this.#peers().map(peer => [peer.id, { ...peer }]));
		this.#unsubscribe = registry.onChange(() => this.#schedule());
		this.#schedule();
	}
	#peers(): AgentRef[] {
		const me = this.registry.get(this.self);
		if (!me) return [];
		return this.registry
			.list()
			.filter(
				peer =>
					peer.id !== this.self &&
					peer.kind === "sub" &&
					peer.parentId === me.parentId &&
					peer.status === "running" &&
					!peer.lifecycle?.acceptedAt,
			);
	}
	#schedule(): void {
		if (this.#queued || this.#disposed) return;
		this.#queued = true;
		queueMicrotask(() => {
			if (this.#queued) this.flush();
		});
	}
	flush(): void {
		this.#queued = false;
		if (this.#disposed) return;
		const me = this.registry.get(this.self);
		if (!me || me.status !== "running" || me.lifecycle?.acceptedAt) return;
		const peers = this.#peers();
		const now = new Map(peers.map(peer => [peer.id, { ...peer }]));
		const updates: { kind: string; peer: string; task: string; scope: string; resource?: string }[] = [];
		const update = (kind: string, peer: AgentRef, resource?: string) => ({
			kind,
			peer: peer.id,
			resource,
			task: peer.history?.peerCoordination?.task.slice(0, 160) ?? peer.displayName.slice(0, 160),
			scope: JSON.stringify(peer.history?.peerCoordination?.scope ?? {}).slice(0, 600),
		});
		for (const peer of peers) if (!this.#known.has(peer.id)) updates.push(update("joined", peer));
		for (const [id, peer] of this.#known) if (!now.has(id)) updates.push(update("left", peer));
		this.#known = now;
		const mine = me.history?.peerCoordination;
		if (mine)
			for (const peer of peers) {
				const theirs = peer.history?.peerCoordination;
				if (!theirs) continue;
				for (const resource of mine.touched) {
					if (![...declared(theirs), ...theirs.touched].some(other => overlaps(resource, other))) continue;
					const key = `${peer.id}\0${peer.generation}\0${resource}`;
					if (this.#clashes.has(key)) continue;
					this.#clashes.set(key, {
						peer: peer.id,
						resource,
						since: this.bus.exchangeCursor(),
						generation: peer.generation,
					});
					updates.push(update("clash", peer, resource));
				}
			}
		if (updates.length)
			this.notice(
				prompt.render(noticeTemplate, { updates: updates.slice(0, 20), omitted: Math.max(0, updates.length - 20) }),
			);
	}
	touch(resources: string[]): void {
		const ref = this.registry.get(this.self);
		const state = ref?.history?.peerCoordination;
		if (!state) return;
		const touched = [...new Set([...state.touched, ...resources])];
		if (touched.length !== state.touched.length)
			this.registry.setHistory(this.self, { peerCoordination: { ...state, touched } });
		this.flush();
	}
	checkHandover(entries: Deconfliction[] = []): string | undefined {
		this.flush();
		const unresolved: Clash[] = [];
		for (const clash of this.#clashes.values()) {
			const peer = this.registry.get(clash.peer);
			if (!peer || peer.generation !== clash.generation || peer.status !== "running" || peer.lifecycle?.acceptedAt)
				continue;
			if (
				entries.some(
					entry => entry.peer === clash.peer && entry.resource === clash.resource && entry.agreement.trim(),
				)
			)
				continue;
			if (this.bus.exchangedSince(this.self, clash.peer, clash.since)) continue;
			unresolved.push(clash);
		}
		if (!unresolved.length) return;
		return prompt.render(noticeTemplate, {
			refusal: true,
			updates: unresolved.slice(0, 20).map(clash => ({ kind: "clash", ...clash })),
		});
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
	}
}
