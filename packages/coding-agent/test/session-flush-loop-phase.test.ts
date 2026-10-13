import { expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { currentLoopPhase } from "@oh-my-pi/pi-utils";

test("session flush does not label unrelated work during storage drain", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	class PausedStorage extends MemorySessionStorage {
		override async drain(): Promise<void> {
			entered.resolve();
			await release.promise;
		}
	}
	const storage = new PausedStorage();
	const manager = SessionManager.create("/cwd", "/sessions", storage);
	const pending = manager.flush();
	await entered.promise;
	const phase = currentLoopPhase();
	release.resolve();
	await pending;
	expect(phase).toBeUndefined();
});
