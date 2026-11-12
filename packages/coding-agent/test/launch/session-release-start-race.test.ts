// Integration test — real timers are required: this drives real cross-process
// daemon brokers whose spawn timing and idle-shutdown timers live in another OS
// process. Uses TempDir-isolated projects so only test-spawned brokers are
// observed; no live omp/claude processes are touched.
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as backgroundPriority from "@oh-my-pi/pi-utils/background-priority";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import * as sessionEnvironment from "../../src/exec/session-slice";
import {
	createDaemonBrokerClient,
	daemonClientForProject,
	hasCachedDaemonClientForSession,
	releaseDaemonClientsForSession,
} from "../../src/launch/client";
import { readLiveDaemonBrokerPid } from "../../src/launch/presence";

const IDLE_GRACE_MS = 100;

// ts-no-test-timers exception: broker exit is observed through the runtime-dir
// pid lease of another OS process; fake timers cannot advance that clock.
async function waitForBrokerExit(runtimeDir: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await readLiveDaemonBrokerPid(runtimeDir)) === undefined) return;
		if (Date.now() >= deadline) {
			throw new Error(`Broker for ${runtimeDir} did not exit within ${timeoutMs}ms`);
		}
		await Bun.sleep(50);
	}
}

describe("session broker startup and release/start race", () => {
	it("does not spawn a broker to release a session whose acquisition failed", async () => {
		using tempDir = TempDir.createSync("@omp-release-failed-acquisition-");
		const sessionId = crypto.randomUUID();
		const client = await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS });
		const spawnSpy = spyOn(backgroundPriority, "spawnBackground").mockImplementationOnce(() =>
			Bun.spawn([path.join(tempDir.path(), "missing-broker-executable")]),
		);
		try {
			await expect(client.request({ op: "ping" })).rejects.toThrow("ENOENT");
			expect(await readLiveDaemonBrokerPid(client.runtimeDir)).toBeUndefined();
			await releaseDaemonClientsForSession(sessionId);
			expect(spawnSpy).toHaveBeenCalledTimes(1);
			expect(client.closed).toBe(true);
			expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
			await expect(client.request({ op: "ping" })).rejects.toThrow("closed");
		} finally {
			spawnSpy.mockRestore();
			await releaseDaemonClientsForSession(sessionId);
			client.close();
			await waitForBrokerExit(client.runtimeDir);
		}
	}, 30_000);

	for (const transition of ["close", "release"] as const) {
		it(`${transition} during replacement preparation leaves no late broker`, async () => {
			using tempDir = TempDir.createSync("@omp-release-preparing-respawn-");
			const sessionId = crypto.randomUUID();
			const client =
				transition === "release"
					? await daemonClientForProject(tempDir.path(), sessionId, { idleGraceMs: IDLE_GRACE_MS })
					: await createDaemonBrokerClient(tempDir.path(), { sessionId, idleGraceMs: IDLE_GRACE_MS });
			const preparing = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const environment = sessionEnvironment.toolSessionEnvironment;
			let preparations = 0;
			const environmentSpy = spyOn(sessionEnvironment, "toolSessionEnvironment").mockImplementation(
				async (...args) => {
					const env = await environment(...args);
					if (++preparations === 2) {
						preparing.resolve();
						await resume.promise;
					}
					return env;
				},
			);
			// Real failed child: no broker lease or socket is ever created by it.
			const spawnSpy = spyOn(backgroundPriority, "spawnBackground").mockImplementationOnce(() =>
				Bun.spawn([process.execPath, "-e", "process.exit(1)"], { stdout: "ignore", stderr: "ignore" }),
			);
			const connecting = client.request({ op: "ping" });
			void connecting.catch(() => {});
			let releasing: Promise<void> | undefined;
			try {
				await withTimeout(preparing.promise, 10_000, "Replacement preparation did not begin");
				if (transition === "close") client.close();
				else releasing = releaseDaemonClientsForSession(sessionId);
				resume.resolve();
				if (transition === "close") {
					await expect(connecting).rejects.toThrow("closed");
					expect(spawnSpy).toHaveBeenCalledTimes(1);
				} else {
					// Release quiesces a replacement already admitted by the active
					// client, then drains its RPC before closing and evicting it.
					expect((await connecting).op).toBe("ping");
					await releasing;
					expect(spawnSpy).toHaveBeenCalledTimes(2);
					expect(await hasCachedDaemonClientForSession(tempDir.path(), sessionId)).toBe(false);
				}
				expect(client.closed).toBe(true);
				await expect(client.request({ op: "ping" })).rejects.toThrow("closed");
				await waitForBrokerExit(client.runtimeDir);
			} finally {
				resume.resolve();
				await Promise.allSettled([connecting, ...(releasing ? [releasing] : [])]);
				environmentSpy.mockRestore();
				spawnSpy.mockRestore();
				if (transition === "release") await releaseDaemonClientsForSession(sessionId);
				client.close();
				await waitForBrokerExit(client.runtimeDir);
			}
		}, 30_000);
	}

	it("respawns a dead first spawn instead of failing ENOENT after 10s", async () => {
		using tempDir = TempDir.createSync("@omp-broker-dead-spawn-respawn-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir, { recursive: true });
		const unique = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
		const sessionId = `test-dead-spawn-${unique}`;
		const prime = await daemonClientForProject(projectDir, sessionId, { idleGraceMs: IDLE_GRACE_MS });
		expect((await prime.request({ op: "ping" })).op).toBe("ping");
		const runtimeDir = prime.runtimeDir;
		await releaseDaemonClientsForSession(sessionId);
		await waitForBrokerExit(runtimeDir);

		// Only the first launch is replaced with a real process that exits
		// without creating a broker lease or socket; the replacement is real.
		const spawnSpy = spyOn(backgroundPriority, "spawnBackground").mockImplementationOnce(() =>
			Bun.spawn([process.execPath, "-e", "process.exit(1)"], { stdout: "ignore", stderr: "ignore" }),
		);
		const fresh = await createDaemonBrokerClient(projectDir, { runtimeDir, sessionId, idleGraceMs: IDLE_GRACE_MS });
		try {
			// Before the respawn fix this rejects after 10s with
			// "Failed to start daemon broker ... ENOENT".
			expect((await fresh.request({ op: "ping" })).op).toBe("ping");
			expect(spawnSpy).toHaveBeenCalledTimes(2);
			expect(await readLiveDaemonBrokerPid(runtimeDir)).toBeDefined();
		} finally {
			spawnSpy.mockRestore();
			fresh.close();
			await releaseDaemonClientsForSession(sessionId);
			await waitForBrokerExit(runtimeDir);
		}
	}, 30_000);

	it("same-session release racing service start leaves no running daemon", async () => {
		using tempDir = TempDir.createSync("@omp-release-start-race-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir, { recursive: true });
		const unique = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
		const sessionId = `test-release-start-race-${unique}`;
		const client = await daemonClientForProject(projectDir, sessionId, { idleGraceMs: IDLE_GRACE_MS });
		await client.request({ op: "ping" });
		const observer = await createDaemonBrokerClient(projectDir, {
			runtimeDir: client.runtimeDir,
			idleGraceMs: IDLE_GRACE_MS,
		});
		try {
			await observer.request({ op: "ping" });
			const daemonName = "race-service";
			// Whichever side wins, the end state must be clean: an admitted start
			// is drained and stopped by release, a late start is fenced.
			// The start outcome itself is racy and intentionally unasserted.
			const start = client.request({
				op: "start",
				spec: {
					name: daemonName,
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000)"],
					env: {},
					cwd: client.projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner: sessionId,
				replace: true,
			});
			const release = releaseDaemonClientsForSession(sessionId);
			const [, releaseResult] = await Promise.allSettled([start, release]);
			expect(releaseResult.status).toBe("fulfilled");
			const listed = await observer.request({ op: "list" });
			if (listed.op !== "list") throw new Error("Expected daemon list after race");
			expect(
				listed.daemons.filter(
					daemon =>
						daemon.name === daemonName &&
						(daemon.state === "running" || daemon.state === "starting" || daemon.state === "ready"),
				),
			).toEqual([]);
			expect(client.closed).toBe(true);
			expect(await hasCachedDaemonClientForSession(projectDir, sessionId)).toBe(false);
		} finally {
			await observer.request({ op: "stop", name: "race-service", timeoutMs: 5_000 }).catch(() => {});
			await observer.request({ op: "shutdown" }).catch(() => {});
			observer.close();
			client.close();
			await releaseDaemonClientsForSession(sessionId);
			await waitForBrokerExit(client.runtimeDir);
		}
	}, 30_000);
});
