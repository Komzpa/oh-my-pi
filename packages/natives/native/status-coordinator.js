const INTERVAL = 10_000;

/** Create an isolated coordinator; dependencies are injectable for simulated-clock tests. */
export function createStatusCoordinator({ now = () => globalThis.performance.now(), setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = INTERVAL } = {}) {
	const repos = new Map();
	function state(key) {
		let value = repos.get(key);
		if (!value) {
			value = { lastStart: -Infinity, timer: null, cache: new Map(), queue: [], running: false, runningItem: null, generation: 0 };
			repos.set(key, value);
		}
		return value;
	}
	function pump(repo) {
		if (repo.running || repo.queue.length === 0) return;
		const delay = repo.lastStart + intervalMs - now();
		if (delay > 0) {
			if (!repo.timer) {
				repo.timer = setTimer(() => { repo.timer = null; pump(repo); }, delay);
			}
			return;
		}
		const item = repo.queue.shift();
		repo.lastStart = now();
		repo.running = true;
		repo.runningItem = item;
		let result;
		try {
			result = item.run();
		} catch (error) {
			result = Promise.reject(error);
		}
		Promise.resolve(result).then(value => {
			if (item.generation === repo.generation) {
				repo.cache.set(item.snapshot, { metadata: item.metadata, value, completedAt: now() });
			}
			for (const waiter of item.waiters) waiter.resolve(value);
		}, error => {
			for (const waiter of item.waiters) waiter.reject(error);
		}).finally(() => {
			repo.running = false;
			repo.runningItem = null;
			pump(repo);
		});
	}
	function request(key, snapshot, meta, run, signal, fresh = false) {
		if (signal?.aborted) return Promise.reject(abortError());
		const repo = state(key);
		const cached = repo.cache.get(snapshot);
		if (!fresh && cached?.metadata === meta && now() - cached.completedAt < intervalMs) {
			return abortable(Promise.resolve(cached.value), signal);
		}
		let item = fresh ? null : [repo.runningItem, ...repo.queue].find(entry => entry?.snapshot === snapshot && entry.metadata === meta && entry.generation === repo.generation);
		if (!item) {
			item = { snapshot, metadata: meta, generation: repo.generation, run, waiters: [] };
			repo.queue.push(item);
		}
		const waiter = Promise.withResolvers();
		item.waiters.push(waiter);
		const promise = waiter.promise;
		pump(repo);
		return abortable(promise, signal, () => {
			waiter.reject(abortError());
			item.waiters = item.waiters.filter(entry => entry !== waiter);
			if (item !== repo.runningItem && item.waiters.length === 0) {
				repo.queue = repo.queue.filter(entry => entry !== item);
				if (repo.queue.length === 0 && repo.timer) {
					clearTimer(repo.timer);
					repo.timer = null;
				}
			}
		});
	}
	function abortError() {
		return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
	}
	function abortable(promise, signal, onAbort = () => {}) {
		if (!signal) return promise;
		const waiter = Promise.withResolvers();
		const abort = () => { onAbort(); waiter.reject(abortError()); };
		signal.addEventListener("abort", abort, { once: true });
		promise.then(waiter.resolve, waiter.reject).finally(() => signal.removeEventListener("abort", abort));
		return waiter.promise;
	}

	function invalidate(key) {
		if (key) state(key);
		for (const [repoKey, repo] of repos) {
			if (key && repoKey !== key) continue;
			repo.generation++;
			repo.cache.clear();
		}
	}
	function epoch(key) {
		return repos.get(key)?.generation ?? 0;
	}
	return { request, invalidate, epoch };
}

export const statusCoordinator = createStatusCoordinator();
