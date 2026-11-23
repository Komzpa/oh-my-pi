import { expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

test.each(["error", "staffing"])("refused task (%s) starts with no-spawn outcome before details", async mode => {
	const tempDir = TempDir.createSync("@task-hook-error-");
	const extensionsDir = tempDir.path();
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.inMemory();
	try {
		const extensionPath = path.join(extensionsDir, "readonly.ts");
		await Bun.write(
			extensionPath,
			mode === "staffing"
				? `export default function(pi) {
            pi.on("tool_call", () => ({ block: true, reason: 'Staff "Push: project gates" via task before waiting.' }));
        }`
				: `export default function(pi) {
            pi.on("tool_call", function readonlyTaskHook() {
                const row = Object.freeze({ schedule: {} });
                row.schedule = { review: "user" };
            });
        }`,
		);
		const loaded = await loadExtensions([extensionPath], tempDir.path());
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const result = await runner.emitToolCall({
			type: "tool_call",
			toolName: "task",
			toolCallId: "readonly",
			input: {},
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toStartWith("REFUSED: no worker was spawned.\n");
		if (mode === "staffing") {
			expect(result?.reason).toContain('Staff "Push: project gates"');
			return;
		}
		expect(result?.reason).toContain("tool_call (task)");
		expect(result?.reason).toContain("readonlyTaskHook");
		expect(result?.reason).toContain("row.schedule");
		expect(result?.reason).toContain(extensionPath);
	} finally {
		authStorage.close();
		tempDir.removeSync();
	}
});
