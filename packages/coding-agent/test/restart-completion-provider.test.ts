import { expect, it } from "bun:test";
import * as path from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";

interface FixtureResult {
	before: { pid: number; identity: { instanceId: string; sessionId: string } }[];
	after: { pid: number; identity: { instanceId: string; sessionId: string }; request: { state: string } }[];
	ack: { request: { rootWasRunning: boolean } };
	calls: { successor: boolean; messages: Message[] }[];
}

it.skipIf(process.platform !== "linux" || !Bun.which("tmux") || !Bun.which("python3")).each([false, true])(
	"exec successor's first provider request ends restart hold before restored input (pending: %s)",
	async pending => {
		using root = TempDir.createSync("@omp-restart-provider-");
		const child = Bun.spawn(
			[
				"python3",
				path.join(import.meta.dir, "fixtures/restart-completion-provider.py"),
				root.path(),
				pending ? "1" : "0",
				process.execPath,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const result = JSON.parse(stdout) as FixtureResult;
		expect(result.after[0]!.request.state).toBe("completed");
		expect(result.after[0]!.identity.sessionId).toBe(result.before[0]!.identity.sessionId);
		expect(result.after[0]!.pid).toBe(result.before[0]!.pid);
		expect(result.after[0]!.identity.instanceId).not.toBe(result.before[0]!.identity.instanceId);
		expect(result.ack.request.rootWasRunning).toBe(pending);
		const first = result.calls[0]!;
		expect(first.successor).toBe(true);
		const restart = first.messages.filter(message =>
			JSON.stringify(message).includes("Harness (not Darafei): Restart"),
		);
		expect(restart).toHaveLength(1);
		expect(restart[0]!.role).toBe("user");
		expect(JSON.stringify(restart[0])).toMatch(
			/completed at \d\d:\d\d; build [a-f0-9]+; nothing pending — resume your plan\./,
		);
		for (const call of result.calls) expect(JSON.stringify(call.messages)).not.toContain("is queued.");
		const pendingDeliveries = result.calls
			.flatMap(call => call.messages)
			.filter(message => JSON.stringify(message).includes("Pending fixture context"));
		if (pending) expect(pendingDeliveries.length).toBeGreaterThan(0);
		else expect(pendingDeliveries).toHaveLength(0);
	},
	60_000,
);
