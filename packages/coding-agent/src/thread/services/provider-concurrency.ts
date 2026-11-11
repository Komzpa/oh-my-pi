/** Main-owned provider request leases, reclaimed when a worker aborts or exits. */
import {
	getProviderSemaphoreForLimit,
	installProviderConcurrencyBridge,
	type ProviderConcurrencyBridge,
} from "../../task/provider-concurrency";
import type { ThreadId } from "../identity";
import { rpcSync } from "../rpc";
import type { ThreadService } from "../services";
import { releasingOnce } from "./support";

const exits = new Map<ThreadId, AbortController>();

export const providerConcurrencyThreadService: ThreadService = {
	name: "provider-concurrency",
	globals(peer): ProviderConcurrencyBridge {
		const exit = new AbortController();
		exits.set(peer.threadId, exit);
		return {
			async acquire(provider, limit, signal) {
				const lifetime = signal ? AbortSignal.any([exit.signal, signal]) : exit.signal;
				const release = await getProviderSemaphoreForLimit(provider, limit).acquireLease(lifetime);
				return releasingOnce(release);
			},
			resize: rpcSync((provider, limit) => {
				getProviderSemaphoreForLimit(provider, limit);
			}),
		};
	},
	onWorkerExit(peer, reason) {
		const exit = exits.get(peer.threadId);
		exits.delete(peer.threadId);
		exit?.abort(new Error(`Provider lease owner exited: ${reason}`));
	},
	boot(globals) {
		installProviderConcurrencyBridge(globals as ProviderConcurrencyBridge);
	},
};
