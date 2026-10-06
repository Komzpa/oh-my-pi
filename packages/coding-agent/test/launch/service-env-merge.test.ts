import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { Settings } from "../../src/config/settings";
import * as brokerClients from "../../src/launch/client";
import type { DaemonBrokerClient } from "../../src/launch/client";
import { startService } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";

describe("startService caller env", () => {
	afterEach(() => vi.restoreAllMocks());

	it("merges caller env over shell defaults", async () => {
		const settings = Settings.isolated();
		const shell = settings.getShellConfig();
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		let captured: DaemonSpec | undefined;
		const client = {
			onCompletion: () => () => {},
			request: async (operation: { op: string; spec?: DaemonSpec }) => {
				if (operation.op === "start") {
					captured = operation.spec;
					return {
						op: "start",
						daemon: { id: "env-probe", name: "env-probe", state: "running", startedAt: 1 },
						readyTimedOut: false,
					};
				}
				return { op: "logs", name: "env-probe", text: "" };
			},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
		const shellKey = Object.keys(shell.env)[0];
		await startService(session, {
			name: "env-probe",
			command: "true",
			pty: false,
			env: {
				OMP_SLICE_ENV_PROBE: "caller",
				...(shellKey === undefined ? {} : { [shellKey]: "caller-wins" }),
			},
		});
		expect(captured).toBeDefined();
		expect(captured?.env["OMP_SLICE_ENV_PROBE"]).toBe("caller");
		if (shellKey !== undefined) expect(captured?.env[shellKey]).toBe("caller-wins");
	});
});
