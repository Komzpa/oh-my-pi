import { describe, expect, it } from "bun:test";
import {
	resolveAgentModelSelection,
	resolveConfiguredModelPatterns,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
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
