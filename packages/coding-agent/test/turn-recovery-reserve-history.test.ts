import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";

afterEach(() => vi.restoreAllMocks());

function recovery(manager: SessionManager): TurnRecovery {
	return new TurnRecovery({ sessionManager: manager } as TurnRecoveryHost, { deferFallbackChainValidation: true });
}

describe("reserve decision history", () => {
	it("clears a recent reserve choice without hydrating older branch payloads", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("usage-reserve-decision", { primary: "anthropic/test", decision: "stay" });
		const branch = [...manager.getBranchView()];
		branch.unshift(branch[0]);
		Object.defineProperty(branch, 0, {
			get() {
				throw new Error("Historical payload was hydrated");
			},
		});
		vi.spyOn(manager, "getBranch").mockImplementation(() => branch.slice());
		vi.spyOn(manager, "getBranchView").mockReturnValue(branch);
		recovery(manager).clearActiveRetryFallback();
		const latest = manager.getEntries().at(-1);
		expect(latest?.type === "custom" && latest.customType).toBe("usage-reserve-decision");
		expect(latest?.type === "custom" && latest.data).toBeNull();
	});

	it("uses indexed metadata for absent choices and respects clears and the active branch", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendCustomEntry("unrelated", null);
		const choice = manager.appendCustomEntry("usage-reserve-decision", {
			primary: "anthropic/test",
			decision: "switch",
		});
		const branchView = manager.getBranchView.bind(manager);
		Object.assign(manager, {
			getLatestBranchMatching(
				predicate: (metadata: { type: string; customType?: string }) => boolean,
			): SessionEntry | undefined {
				return branchView().findLast(predicate);
			},
		});
		vi.spyOn(manager, "getBranch").mockImplementation(() => {
			throw new Error("Indexed reserve lookup hydrated the whole journal");
		});
		vi.spyOn(manager, "getBranchView").mockImplementation(() => {
			throw new Error("Indexed reserve lookup read unrelated branch payloads");
		});
		const turnRecovery = recovery(manager);
		turnRecovery.clearActiveRetryFallback();
		const clearedCount = manager.getEntries().length;
		turnRecovery.clearActiveRetryFallback();
		expect(manager.getEntries()).toHaveLength(clearedCount);
		manager.branch(root);
		turnRecovery.clearActiveRetryFallback();
		expect(manager.getEntries()).toHaveLength(clearedCount);
		manager.branch(choice);
		turnRecovery.clearActiveRetryFallback();
		expect(manager.getEntries()).toHaveLength(clearedCount + 1);
		expect(manager.getEntries().at(-1)).toMatchObject({
			type: "custom",
			customType: "usage-reserve-decision",
			data: null,
		});
	});
});
