import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutScopesFromResources, checkoutScopesOverlap } from "./checkout_scope";

describe("checkoutScopesFromResources", () => {
	test("a relative file next to an absolute worktree keeps the worktree scope", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-scope-")));
		try {
			const laneA = join(dir, "lane-a");
			const laneB = join(dir, "lane-b");
			for (const repo of [laneA, laneB]) {
				mkdirSync(repo);
				execFileSync("git", ["init", "-q", repo]);
			}
			const a = checkoutScopesFromResources([laneA, "src/canvas.ts"]);
			const b = checkoutScopesFromResources([laneB, "src/canvas.ts:source-writer"]);
			expect(a).toEqual([`${laneA}\0.`, `${laneA}\0src/canvas.ts`]);
			expect(b).toEqual([`${laneB}\0.`, `${laneB}\0src/canvas.ts`]);
			expect(checkoutScopesOverlap(a!, b!)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("relative paths without exactly one worktree, and bare words, stay unknown", () => {
		expect(checkoutScopesFromResources(["src/canvas.ts"])).toBeUndefined();
		expect(checkoutScopesFromResources(["/tmp/a", "/tmp/b", "src/canvas.ts"])).toBeUndefined();
		expect(checkoutScopesFromResources(["/tmp/a", "ambiguous"])).toBeUndefined();
	});
});
