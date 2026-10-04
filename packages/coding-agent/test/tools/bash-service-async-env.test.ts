import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { AsyncJobManager } from "../../src/async/job-manager";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import * as daemonClient from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { BashTool } from "../../src/tools/bash";
import type { ToolSession } from "../../src/tools";

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previous = [
		process.env[DAEMON_PROJECT_DIR_ENV],
		process.env[DAEMON_RUNTIME_DIR_ENV],
		process.env[DAEMON_IDLE_GRACE_ENV],
	];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	for (const [index, key] of [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].entries()) {
		if (previous[index] === undefined) delete process.env[key];
		else process.env[key] = previous[index];
	}
	return broker;
}

function toolSession(cwd: string, manager?: AsyncJobManager): ToolSession {
	return {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		asyncJobManager: manager,
		settings: Settings.isolated({
			"launch.enabled": true,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: "/bin/sh",
		}),
	} as unknown as ToolSession;
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");

describe("bash service async/env passthrough (grievances 552/578/607/631/645/651/666)", () => {
	it("starts a service call with no async or timeout arguments", async () => {
		using temp = TempDir.createSync("@omp-bash-service-env-");
		const cwd = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(cwd);
		const client = await createDaemonBrokerClient(cwd, { runtimeDir, idleGraceMs: 5_000 });
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const oldTitle = process.title;
		const broker = startBroker(cwd, runtimeDir);
		const manager = new AsyncJobManager({});
		const session = toolSession(cwd, manager);
		const bash = new BashTool(session);
		try {
			// No async/timeout keys at all.
			const started = await bash.execute("svc-plain", {
				command: "printf 'READY\\n'; sleep 30",
				name: "plain-service",
				ready: { log: "READY", timeout: 5 },
				pty: false,
			});
			expect(started.details?.service?.ready).toBeTrue();
			expect(textOf(started)).toContain("plain-service");
			// Materialized placeholders (async:false, timeout:0) are "not set" too.
			const placeholders = await bash.execute("svc-placeholders", {
				command: "printf 'READY2\\n'; sleep 30",
				name: "placeholder-service",
				ready: { log: "READY2", timeout: 5 },
				pty: false,
				async: false,
				timeout: 0,
			});
			expect(placeholders.details?.service?.ready).toBeTrue();
			expect(textOf(placeholders)).toContain("placeholder-service");
			// Explicit requests still reject per the documented no-async/timeout contract.
			await expect(
				bash.execute("svc-async", { command: "true", name: "bad", async: true, pty: false }),
			).rejects.toThrow("does not accept async or timeout");
			await expect(
				bash.execute("svc-timeout", { command: "true", name: "bad", timeout: 60, pty: false }),
			).rejects.toThrow("does not accept async or timeout");
		} finally {
			await client.request({ op: "stop", name: "plain-service", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "stop", name: "placeholder-service", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			await manager.dispose({ timeoutMs: 1_000 });
			client.close();
			await broker;
			setProcessName(oldTitle);
			spy.mockRestore();
		}
	}, 25_000);

	it("passes env through on a finite command", async () => {
		const bash = new BashTool(toolSession(process.cwd()));
		const result = await bash.execute("finite-env", {
			command: "echo $OMP_TEST_FOO",
			env: { OMP_TEST_FOO: "bar" },
			timeout: 30,
			pty: false,
		});
		expect(textOf(result)).toContain("bar");
	});
});
