import { describe, expect, it, spyOn } from "bun:test";
import {
	resolveAgentModelSelection,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { drawPoolOrder } from "@oh-my-pi/pi-coding-agent/config/model-role-pools";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const FREE = "or/free-a, or/free-b, or/free-c";
const FAST = "fast/one, fast/two";

function poolSettings(pools: Record<string, Record<string, number>>): Settings {
	return Settings.isolated({
		modelRoles: { free: FREE, fast: FAST, plain: "p/one, p/two, p/three" },
		modelRolePools: pools,
	});
}

describe("modelRolePools", () => {
	it("keeps invalid YAML weights behind positive and unlisted members", () => {
		const settings = Settings.isolated({
			modelRoles: { pool: "a, b, c, d" },
			modelRolePools: { pool: { a: "0", b: null, c: 1 } },
		});
		for (let i = 0; i < 20; i++) {
			expect(resolveConfiguredModelPatterns("@pool", settings, `seed-${i}`).slice(2)).toEqual(["a", "b"]);
		}
	});

	it("draws huge finite weights like proportional small weights without overflow", () => {
		for (let i = 0; i < 20; i++) {
			const seed = `seed-${i}`;
			expect(drawPoolOrder(["a", "b", "c"], { a: 1e308, b: 1e308, c: 0 }, seed)).toEqual(
				drawPoolOrder(["a", "b", "c"], { a: 1, b: 1, c: 0 }, seed),
			);
		}
	});

	it("draws members in proportion to their weights", () => {
		const settings = poolSettings({ free: { "or/free-a": 3, "or/free-b": 1 } });
		const firsts = new Map<string, number>();
		const draws = 10_000;
		for (let i = 0; i < draws; i++) {
			const first = resolveConfiguredModelPatterns("@free", settings, `spawn-${i}`)[0];
			firsts.set(first, (firsts.get(first) ?? 0) + 1);
		}
		// Weights 3:1:1 (unlisted member weighs 1) -> 60% / 20% / 20%.
		expect((firsts.get("or/free-a") ?? 0) / draws).toBeCloseTo(0.6, 1);
		expect((firsts.get("or/free-b") ?? 0) / draws).toBeCloseTo(0.2, 1);
		expect((firsts.get("or/free-c") ?? 0) / draws).toBeCloseTo(0.2, 1);
	});

	it("renormalizes a draw over available members without losing the unavailable fallback position", () => {
		const blocked = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const left = getBundledModel("openai", "gpt-4o-mini")!;
		const right = getBundledModel("google", "gemini-1.5-pro")!;
		const selectors = [blocked, left, right].map(model => `${model.provider}/${model.id}`);
		const settings = Settings.isolated({
			modelRoles: { pool: selectors.join(", ") },
			modelRolePools: { pool: { [selectors[0]]: 100, [selectors[1]]: 3, [selectors[2]]: 1 } },
		});
		const registry = { getAvailable: () => [left, right] };
		const counts = new Map<string, number>();
		let recoveryOrder: string[] = [];
		for (let i = 0; i < 2_000; i++) {
			const { patterns } = resolveAgentModelSelection({ agentModel: "@pool", settings, seed: `draw-${i}` });
			const { model } = resolveModelOverride(patterns, registry, settings);
			if (!model) throw new Error("An available pool member must resolve");
			counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
			if (patterns[0] === selectors[0]) recoveryOrder = patterns;
		}
		expect(counts.get(blocked.provider)).toBeUndefined();
		expect((counts.get(left.provider) ?? 0) / 2_000).toBeCloseTo(0.75, 1);
		expect((counts.get(right.provider) ?? 0) / 2_000).toBeCloseTo(0.25, 1);
		// The same spawn order can use the recovered provider again; selection did not delete it.
		expect(resolveModelOverride(recoveryOrder, { getAvailable: () => [blocked, left, right] }, settings).model).toBe(
			blocked,
		);
	});

	it("never puts a zero-weight member first and keeps it at the tail in original order", () => {
		const members = ["a", "b", "c", "d"];
		for (let i = 0; i < 500; i++) {
			const order = drawPoolOrder(members, { a: 0, c: 0 }, `seed-${i}`);
			expect(order.slice(0, 2).sort()).toEqual(["b", "d"]);
			expect(order.slice(2)).toEqual(["a", "c"]);
		}
	});

	it("keeps the configured order for roles that are not pools, and without a seed", () => {
		const settings = poolSettings({ free: { "or/free-a": 1 } });
		expect(resolveConfiguredModelPatterns("@plain", settings, "any-seed")).toEqual(["p/one", "p/two", "p/three"]);
		expect(resolveConfiguredModelPatterns("@free", settings)).toEqual(["or/free-a", "or/free-b", "or/free-c"]);
	});

	it("shuffles each role inside its own segment and preserves segment order", () => {
		const settings = poolSettings({ free: {}, fast: {} });
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const patterns = resolveConfiguredModelPatterns("@free, @fast", settings, `s${i}`);
			expect(patterns.slice(0, 3).every(p => p.startsWith("or/"))).toBe(true);
			expect(patterns.slice(3).every(p => p.startsWith("fast/"))).toBe(true);
			expect([...patterns].sort()).toEqual(["fast/one", "fast/two", "or/free-a", "or/free-b", "or/free-c"]);
			seen.add(patterns.join());
		}
		expect(seen.size).toBeGreaterThan(1);
	});

	it("returns the same order for the same seed", () => {
		const settings = poolSettings({ free: {} });
		const first = resolveConfiguredModelPatterns("@free", settings, "agent-7");
		for (let i = 0; i < 20; i++) {
			expect(resolveConfiguredModelPatterns("@free", settings, "agent-7")).toEqual(first);
		}
	});

	it("applies a thinking suffix on the alias to the reordered members", () => {
		const settings = poolSettings({ free: { "or/free-a": 0, "or/free-b": 0 } });
		expect(resolveConfiguredModelPatterns("@free:high", settings, "x")).toEqual([
			"or/free-c:high",
			"or/free-a:high",
			"or/free-b:high",
		]);
	});

	it("hands the agent spawn path one reordered list whose tail is the fallback order", () => {
		const settings = poolSettings({ free: { "or/free-a": 1 } });
		const selection = resolveAgentModelSelection({ agentModel: "@free, @fast", settings, seed: "agent-1" });
		const again = resolveAgentModelSelection({ agentModel: "@free, @fast", settings, seed: "agent-1" });
		expect(selection).toEqual(again);
		expect(selection.role).toBe("free");
		expect(selection.patterns.slice(3)).toEqual(["fast/one", "fast/two"]);
	});
});

it("reuses role expansion until settings change without freezing seeded draws or sharing mutable output", () => {
	const settings = Settings.isolated({
		modelRoles: { outer: "@pool", pool: "a, b, c" },
		modelRolePools: { pool: {} },
	});
	const lookup = spyOn(settings, "getModelRole");
	try {
		const first = resolveConfiguredModelPatterns("@outer", settings, "frame");
		const calls = lookup.mock.calls.length;
		for (let frame = 0; frame < 100; frame++) {
			const patterns = resolveConfiguredModelPatterns("@outer", settings, "frame");
			expect(patterns).toEqual(first);
			patterns.pop();
		}
		expect(lookup.mock.calls.length).toBe(calls);
		const draws = new Set(
			Array.from({ length: 20 }, (_, i) => resolveConfiguredModelPatterns("@outer", settings, `worker-${i}`).join()),
		);
		expect(draws.size).toBeGreaterThan(1);
		settings.setModelRole("pool", "d, e");
		const before = lookup.mock.calls.length;
		expect(resolveConfiguredModelPatterns("@outer", settings, "frame").sort()).toEqual(["d", "e"]);
		expect(lookup.mock.calls.length).toBeGreaterThan(before);
	} finally {
		lookup.mockRestore();
	}
});

it("refreshes mutable custom role lookups without a revision", () => {
	let role = "a, b";
	const lookup = { getModelRole: () => role };
	expect(resolveConfiguredModelPatterns("@pool", lookup)).toEqual(["a", "b"]);
	role = "c";
	expect(resolveConfiguredModelPatterns("@pool", lookup)).toEqual(["c"]);
});
