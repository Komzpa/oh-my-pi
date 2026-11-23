import { expect, spyOn, test } from "bun:test";
import { SessionEntryIndex, SessionManager } from "../../src/session/session-manager";

test("model selection reads only the newest assigned role past temporary fallback hops", async () => {
	const manager = SessionManager.inMemory();
	for (let i = 0; i < 300_000; i++) manager.appendModelChange("test/model", "old");
	const assigned = manager.appendModelChange("test/model", "worker");
	manager.appendModelChange("test/model", "fallback");
	manager.appendModelChange("test/model", "prewalk");
	let decoded = 0;
	const original = SessionEntryIndex.prototype.get;
	const read = spyOn(SessionEntryIndex.prototype, "get").mockImplementation(
		function (this: SessionEntryIndex, id, retain) {
			read.mockClear();
			decoded++;
			return original.call(this, id, retain);
		},
	);
	try {
		expect(manager.getLastModelChangeRole()).toBe("prewalk");
		expect(decoded).toBe(1);
		decoded = 0;
		expect(manager.getLastModelChangeRole({ skipEphemeral: true })).toBe("worker");
		expect(decoded).toBe(3);
		manager.branch(assigned);
		expect(manager.getLastModelChangeRole()).toBe("worker");
	} finally {
		read.mockRestore();
		await manager.close();
	}
});
