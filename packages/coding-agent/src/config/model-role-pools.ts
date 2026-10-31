/**
 * Weighted role pools (`modelRolePools`): a role listed there has its members reordered by a
 * seeded weighted draw without replacement when the role expands. Pure helpers; the settings
 * declaration lives in `model-settings.ts` and the expansion hook in `model-resolver.ts`.
 */

/** Weights for the members of one role, keyed by the selector as it appears in the role. */
export type ModelRolePool = Readonly<Record<string, number>>;

/** FNV-1a (32-bit) over UTF-16 code units; stable across runtimes, unlike `Bun.hash`. */
function hashSeed(seed: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
function createSeededRandom(seed: string): () => number {
	let state = hashSeed(seed);
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function weightOf(pool: ModelRolePool, member: string): number {
	const weight = Object.hasOwn(pool, member) ? pool[member] : 1;
	return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

/**
 * Reorder `members` by a weighted random draw without replacement. Members absent from `pool`
 * weigh 1. Members with weight 0 (or an invalid weight) are never drawn ahead of a positive one
 * and keep their original relative order at the tail. The same `seed` always yields the same order.
 */
export function drawPoolOrder(members: readonly string[], pool: ModelRolePool, seed: string): string[] {
	const random = createSeededRandom(seed);
	const remaining = members.map(member => ({ member, weight: weightOf(pool, member) }));
	const drawn: string[] = [];
	for (;;) {
		let total = 0;
		for (const entry of remaining) total += entry.weight;
		if (total <= 0) break;
		let target = random() * total;
		let pick = remaining.findIndex(entry => {
			if (entry.weight <= 0) return false;
			target -= entry.weight;
			return target < 0;
		});
		// Floating-point slack can leave `target` at 0 after the last positive entry.
		if (pick < 0) pick = remaining.findLastIndex(entry => entry.weight > 0);
		drawn.push(remaining[pick].member);
		remaining.splice(pick, 1);
	}
	return [...drawn, ...remaining.map(entry => entry.member)];
}
