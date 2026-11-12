import * as path from "node:path";
import { expect, it, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it("SDK disposal preserves the caller's restart and drain options", async () => {
	await initTheme(false);
	using temp = TempDir.createSync("@omp-sdk-dispose-options-");
	const auth = createInMemoryAuthStorage();
	const original = AgentSession.prototype.dispose;
	const observed: unknown[] = [];
	const spy = spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession, options) {
		observed.push(options);
		return original.call(this, options);
	});
	try {
		const { session } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			sessionManager: SessionManager.inMemory(temp.path()),
			modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
			model: createMockModel(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
		});
		const options = { preserveServices: true, drainTimeoutMs: 37, mnemopiConsolidateTimeoutMs: 19 };
		await session.dispose(options);
		expect(observed).toContainEqual(options);
	} finally {
		spy.mockRestore();
		auth.close();
	}
});
