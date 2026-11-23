/**
 * Per-provider LLM concurrency cap, applied around each provider HTTP request.
 *
 * The semaphore brackets only the streaming request itself, not the whole
 * agent lifetime: a parent subagent releases its slot the moment its LLM
 * stream finishes producing, so children spawned during tool execution can
 * acquire slots for their own turns. Holding the slot across the parent's
 * full conversation deadlocks any spawn tree whose width exceeds
 * `maxConcurrency` because the parents wait for children that wait for
 * slots the parents are holding (issue
 * [#3749](https://github.com/can1357/oh-my-pi/issues/3749)).
 */

import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Setting } from "../config/registry";
import type { Settings } from "../config/settings";

import { Semaphore } from "./parallel";
import { cfgProvidersOllamaCloudMaxConcurrency } from "../session/settings";

const PROVIDER_MAX_CONCURRENCY_SETTINGS: Record<string, Setting<number>> = {
	"ollama-cloud": cfgProvidersOllamaCloudMaxConcurrency,
};

interface ProviderSemaphoreEntry {
	limit: number;
	semaphore: ProviderSemaphore;
}

/** Main owns the counters; worker instances only proxy acquisitions to main. */
export interface ProviderConcurrencyBridge {
	acquire(provider: string, limit: number, signal?: AbortSignal): Promise<() => void | Promise<void>>;
	resize(provider: string, limit: number): void;
}

export interface ProviderSemaphore {
	acquire(signal?: AbortSignal): Promise<void>;
	release(): void;
	resize(limit: number): void;
	acquireLease(signal?: AbortSignal): Promise<() => void>;
}

const providerSemaphores = new Map<string, ProviderSemaphoreEntry>();
let workerBridge: ProviderConcurrencyBridge | undefined;

/** Installed by the subagent thread service before any worker session starts. */
export function installProviderConcurrencyBridge(bridge: ProviderConcurrencyBridge): void {
	workerBridge = bridge;
	// No session may acquire before boot; discard any pre-bootstrap module-local instances.
	providerSemaphores.clear();
}

class LocalProviderSemaphore extends Semaphore implements ProviderSemaphore {
	async acquireLease(signal?: AbortSignal): Promise<() => void> {
		await this.acquire(signal);
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			signal?.removeEventListener("abort", release);
			this.release();
		};
		signal?.addEventListener("abort", release, { once: true });
		if (signal?.aborted) {
			release();
			signal.throwIfAborted();
		}
		return release;
	}
}

class RemoteProviderSemaphore implements ProviderSemaphore {
	readonly #releases: Array<() => void> = [];
	#limit: number;

	constructor(
		readonly provider: string,
		readonly bridge: ProviderConcurrencyBridge,
		limit: number,
	) {
		this.#limit = limit;
	}

	async acquireLease(signal?: AbortSignal): Promise<() => void> {
		const release = await this.bridge.acquire(this.provider, this.#limit, signal);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			// Link closure is expected during worker shutdown; main reclaims its leases.
			Promise.resolve(release()).catch(() => {});
		};
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		this.#releases.push(await this.acquireLease(signal));
	}

	release(): void {
		this.#releases.shift()?.();
	}

	resize(limit: number): void {
		this.#limit = limit;
		this.bridge.resize(this.provider, limit);
	}
}

/** Numeric entry point shared by main's thread service and local settings callers. */
export function getProviderSemaphoreForLimit(provider: string, limit: number): ProviderSemaphore {
	const existing = providerSemaphores.get(provider);
	if (existing) {
		if (existing.limit !== limit) {
			existing.limit = limit;
			existing.semaphore.resize(limit);
		}
		return existing.semaphore;
	}
	const semaphore = workerBridge
		? new RemoteProviderSemaphore(provider, workerBridge, limit)
		: new LocalProviderSemaphore(limit);
	providerSemaphores.set(provider, { limit, semaphore });
	return semaphore;
}

/**
 * Resolve the configured concurrency ceiling for a provider, or `undefined`
 * when the provider has no cap concept at all. A configured value `<= 0` means
 * "unlimited" and maps to `Infinity` — still a tracked ceiling, so every run
 * holds a slot and a later finite resize counts work started while unlimited.
 */
export function getProviderConcurrencyLimit(settings: Settings, provider: string): number | undefined {
	const setting = PROVIDER_MAX_CONCURRENCY_SETTINGS[provider];
	if (!setting) return undefined;
	const raw = setting.get(settings);
	const limit = Number.isFinite(raw) ? Math.trunc(raw) : 0;
	return limit > 0 ? limit : Number.POSITIVE_INFINITY;
}

/**
 * Hand out the single shared limiter for `provider` (creating one lazily) and
 * resize it in place when the configured limit changes. Replacing the
 * semaphore would orphan in-flight slots on the old instance and let a
 * runtime or mixed limit value exceed the cap (issue #3464 review feedback).
 */
export function getProviderSemaphore(settings: Settings, provider: string): ProviderSemaphore | undefined {
	const limit = getProviderConcurrencyLimit(settings, provider);
	return limit === undefined ? undefined : getProviderSemaphoreForLimit(provider, limit);
}

/**
 * Wrap a {@link StreamFn} so every LLM HTTP request acquires the provider's
 * concurrency slot before the request goes out and releases it when the
 * stream finishes producing (success, error, or abort). Providers without a
 * configured cap pass straight through.
 *
 * The acquire bracket is intentionally narrow (one slot per LLM call), so
 * spawn trees deeper than `maxConcurrency` no longer deadlock on themselves —
 * see the module-level comment for the failure mode this fixes.
 */
export function wrapStreamFnWithProviderConcurrency(settings: Settings, base: StreamFn): StreamFn {
	return async (model, context, options) => {
		const semaphore = getProviderSemaphore(settings, model.provider);
		if (!semaphore) return base(model, context, options);
		const release = await semaphore.acquireLease(options?.signal);
		try {
			options?.signal?.throwIfAborted();
			const stream = await base(model, context, options);
			// EventStream.result() settles when the producer pushes 'done'/'error'
			// or calls fail() — i.e. once the provider has finished producing.
			// Releasing here keeps the slot held for the network request and
			// nothing else.
			stream.result().then(release, release);
			return stream;
		} catch (err) {
			release();
			throw err;
		}
	};
}
