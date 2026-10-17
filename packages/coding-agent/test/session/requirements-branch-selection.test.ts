import { describe, expect, it } from "bun:test";
import { matchingRequirementBranch } from "../../src/session/requirements-branch-selection";
import { SessionManager } from "../../src/session/session-manager";

describe("requirements branch selection", () => {
	it("uses indexed metadata without materializing unrelated conversation bodies", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("requirements_ledger", { requirements: [] });
		const entries = manager.getBranch();
		let selected = false;
		Object.assign(manager, {
			getBranchMatching: (predicate: (entry: { type: "custom"; customType: string }) => boolean) => {
				selected = true;
				expect(predicate({ type: "custom", customType: "requirements_ledger" })).toBe(true);
				expect(predicate({ type: "custom", customType: "unrelated" })).toBe(false);
				return entries;
			},
			getBranch: () => {
				throw new Error("Unrelated history must not be decoded");
			},
		});
		expect(matchingRequirementBranch(manager, entry => entry.customType === "requirements_ledger")).toEqual(entries);
		expect(selected).toBe(true);
	});

	it("preserves selection with the resident session backend", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("unrelated", { text: "keep out" });
		manager.appendCustomEntry("requirements_ledger", { requirements: [] });
		const selected = matchingRequirementBranch(manager, entry => entry.customType === "requirements_ledger");
		expect(selected).toHaveLength(1);
		expect(selected[0]).toMatchObject({ type: "custom", customType: "requirements_ledger" });
	});
});
