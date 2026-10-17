import { waitForRestartAdmission } from "../../src/restart-admission";
import { SessionManager } from "../../src/session/session-manager";

const file = process.argv[2]!;
try {
	await waitForRestartAdmission(file);
	process.send?.({ type: "admitted" });
	const manager = await SessionManager.open(file);
	const result = { type: "draft", text: await manager.consumeDraft(), entries: manager.getEntries() };
	process.send?.(result);
	if (process.argv[3]) await Bun.write(process.argv[3], JSON.stringify(result));
	await manager.close();
	process.disconnect?.();
} catch (error) {
	process.send?.({ type: "rejected", message: String(error) });
	process.disconnect?.();
	process.exitCode = 1;
}
