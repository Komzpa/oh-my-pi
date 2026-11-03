// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { describe, expect, test } from "bun:test";
import { DEFAULTS, compactionBand, conversationTail, semanticVerdict } from "./jev_compaction";

describe("OMP JEV compaction timing", () => {
	test("uses absolute token thresholds rather than model-window percentages", () => {
		expect(compactionBand(DEFAULTS.floorTokens - 1).action).toBe("idle");
		expect(compactionBand(DEFAULTS.floorTokens).action).toBe("ask");
		expect(compactionBand(DEFAULTS.ceilingTokens - 1).action).toBe("ask");
		expect(compactionBand(DEFAULTS.ceilingTokens).action).toBe("compact");
		expect(DEFAULTS.ceilingTokens).toBeLessThan(272_000);
	});

	test("fragile transcript-only state outranks an apparently settled turn", () => {
		expect(semanticVerdict({ settled: 0.99, heavy: 0.99, fragile: 0.35 }).action).toBe("hold");
	});

	test("settled and heavy work independently authorize compaction", () => {
		expect(semanticVerdict({ settled: 0.65, heavy: 0, fragile: 0 }).reason).toBe("settled:0.65");
		expect(semanticVerdict({ settled: 0, heavy: 0.7, fragile: 0 }).reason).toBe("heavy:0.70");
		expect(semanticVerdict({ settled: 0.64, heavy: 0.69, fragile: 0 }).action).toBe("hold");
	});

	test("JEV sees bounded user and assistant text without tool output", () => {
		const tail = conversationTail([
			{ role: "user", content: [{ type: "text", text: "  keep   this  " }] },
			{ role: "toolResult", content: [{ type: "text", text: "secret tool output" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		]);
		expect(tail).toEqual(["user: keep this", "assistant: done"]);
	});
});
