import * as net from "node:net";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	listRestartControls,
	publishRestartControl,
	RESTART_CONTROL_PROTOCOL_VERSION,
	sendRestartControl,
	waitForRestartResult,
	type RestartControlSource,
} from "../src/restart-control";
import type { RestartControlIdentity, RestartControlSnapshot } from "../src/task/restart-queue";

const tempDirs: string[] = [];
const publications: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
	for (const publication of publications.splice(0).reverse()) await publication.dispose();
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setupDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "restart-control-test-"));
	tempDirs.push(dir);
	return dir;
}

function fixture(identity: RestartControlIdentity): { source: RestartControlSource; requests: string[] } {
	const requests: string[] = [];
	const source: RestartControlSource = {
		snapshot: () => ({ identity, pid: process.pid, cwd: "/workspace", request: null }),
		async handle(request) {
			requests.push(request.op);
			return { identity, pid: process.pid, cwd: "/workspace", request: null } satisfies RestartControlSnapshot;
		},
	};
	return { source, requests };
}

describe("restart-control local IPC", () => {
	it("routes valid cancellation only to its endpoint and rejects a neighboring stale generation", async () => {
		const runtimeDir = await setupDir();
		const firstIdentity: RestartControlIdentity = {
			instanceId: "instance-one-1234",
			sessionId: "session-one",
			generation: 7,
		};
		const neighborIdentity: RestartControlIdentity = {
			instanceId: "instance-two-1234",
			sessionId: "session-two",
			generation: 9,
		};
		const first = fixture(firstIdentity);
		const neighbor = fixture(neighborIdentity);
		publications.push(await publishRestartControl(first.source, { runtimeDir }));
		publications.push(await publishRestartControl(neighbor.source, { runtimeDir }));

		const listed = await listRestartControls({ runtimeDir });
		expect(listed.map(item => item.identity.instanceId).sort()).toEqual(["instance-one-1234", "instance-two-1234"]);

		await expect(
			sendRestartControl(
				{ identity: { ...neighborIdentity, generation: 10 }, op: "cancel", requestId: "request-neighbor" },
				{ runtimeDir },
			),
		).rejects.toMatchObject({ name: "RestartControlError", code: "stale_identity" });
		expect(first.requests).toEqual([]);
		expect(neighbor.requests).toEqual([]);

		const cancelled = await sendRestartControl(
			{ identity: firstIdentity, op: "cancel", requestId: "request-1" },
			{ runtimeDir },
		);
		expect(cancelled.identity).toEqual(firstIdentity);
		expect(first.requests).toEqual(["cancel"]);
		expect(neighbor.requests).toEqual([]);
	});

	it("does not fall back to another endpoint when the exact instance metadata is missing", async () => {
		const runtimeDir = await setupDir();
		const identity: RestartControlIdentity = {
			instanceId: "instance-live-1234",
			sessionId: "session-live",
			generation: 2,
		};
		const live = fixture(identity);
		publications.push(await publishRestartControl(live.source, { runtimeDir }));

		await expect(
			sendRestartControl(
				{
					identity: { instanceId: "instance-missing-1234", sessionId: "session-live", generation: 2 },
					op: "status",
				},
				{ runtimeDir },
			),
		).rejects.toMatchObject({ name: "RestartControlError", code: "target_not_found" });
		expect(live.requests).toEqual([]);
	});

	it("reports a generation change rather than dispatching against a stale identity", async () => {
		const runtimeDir = await setupDir();
		const identity: RestartControlIdentity = {
			instanceId: "instance-stale-1234",
			sessionId: "session-stale",
			generation: 3,
		};
		const current: RestartControlIdentity = { ...identity, generation: 4 };
		const live = fixture(current);
		publications.push(await publishRestartControl(live.source, { runtimeDir }));

		await expect(sendRestartControl({ identity, op: "request" }, { runtimeDir })).rejects.toMatchObject({
			name: "RestartControlError",
			code: "stale_identity",
		});
		expect(live.requests).toEqual([]);
	});

	it("returns a bounded handler rejection reason to the control caller", async () => {
		const runtimeDir = await setupDir();
		const identity: RestartControlIdentity = {
			instanceId: "instance-reason-1234",
			sessionId: "session-reason",
			generation: 5,
		};
		const reason = "Restart blocked: checkpoint already started";
		const source: RestartControlSource = {
			snapshot: () => ({ identity, pid: process.pid, cwd: "/workspace", request: null }),
			async handle() {
				throw new Error(reason);
			},
		};
		publications.push(await publishRestartControl(source, { runtimeDir }));

		await expect(
			sendRestartControl({ identity, op: "cancel", requestId: "reason-request" }, { runtimeDir }),
		).rejects.toMatchObject({
			name: "RestartControlError",
			code: "handler_failed",
			message: reason,
		});
	});

	it("consumes one complete frame before async dispatch so later chunks cannot duplicate it", async () => {
		const runtimeDir = await setupDir();
		const identity: RestartControlIdentity = {
			instanceId: "instance-frame-1234",
			sessionId: "session-frame",
			generation: 1,
		};
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let calls = 0;
		const source: RestartControlSource = {
			snapshot: () => ({ identity, pid: process.pid, cwd: "/workspace", request: null }),
			async handle() {
				calls++;
				entered.resolve();
				await resume.promise;
				return { identity, pid: process.pid, cwd: "/workspace", request: null };
			},
		};
		publications.push(await publishRestartControl(source, { runtimeDir }));
		const metadata = JSON.parse(await Bun.file(path.join(runtimeDir, `${identity.instanceId}.json`)).text()) as {
			endpoint: string;
			token: string;
		};
		const socket = net.createConnection({ path: metadata.endpoint });
		const connected = Promise.withResolvers<void>();
		const response = Promise.withResolvers<string>();
		let responseText = "";
		socket.setEncoding("utf8");
		socket.once("connect", connected.resolve);
		socket.on("data", chunk => {
			responseText += chunk;
			if (responseText.includes("\n")) response.resolve(responseText);
		});
		await connected.promise;
		socket.write(
			`${JSON.stringify({
				v: RESTART_CONTROL_PROTOCOL_VERSION,
				token: metadata.token,
				op: "cancel",
				request: { identity, op: "cancel", requestId: "frame-request" },
			})}\n`,
		);
		await entered.promise;
		socket.write("\n");
		// This integration probe needs a real peer event-loop turn to deliver the second frame chunk while handle() is suspended.
		await Bun.sleep(25);
		expect(calls).toBe(1);
		resume.resolve();
		const payload = await response.promise;
		expect(JSON.parse(payload).ok).toBe(true);
		socket.destroy();
	});
});

describe("restart fail-closed CLI", () => {
	async function runLiveRestart(removeEntry: boolean): Promise<void> {
		const root = await fs.mkdtemp(path.join(process.env.OMP_RESTART_QA_DIR ?? os.tmpdir(), "restart-live-"));
		tempDirs.push(root);
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".omp", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"startup:\n  setupWizard: false\n  checkUpdate: false\n  quiet: true\ncollab:\n  autoStart: false\n",
		);
		const cli = path.resolve(import.meta.dir, "../src/cli.ts");
		const launcher = path.join(root, "launcher.ts");
		await Bun.write(
			launcher,
			`import { runCli } from ${JSON.stringify(cli)};\nimport { declareWorkerHostEntry } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/worker-host.ts"))};\ndeclareWorkerHostEntry();\nawait runCli(process.argv.slice(2));\n`,
		);
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			PI_CONFIG_FILES: "",
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			TMPDIR: process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
			ANTHROPIC_API_KEY: "restart-test-key",
			PI_NO_TITLE: "1",
		};
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		const command = [
			"nice",
			"-n19",
			"ionice",
			"-c2",
			"-n7",
			process.execPath,
			launcher,
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-tools",
			"--no-lsp",
			"--no-title",
			"--no-prewalk",
		]
			.map(quote)
			.join(" ");
		const proc = Bun.spawn(["script", "-qefc", command, "/dev/null"], {
			cwd: root,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = new Response(proc.stdout).text();
		const errors = new Response(proc.stderr).text();
		const runtimeDir = path.join(home, ".omp", "run", "restart-controls");
		try {
			let target: RestartControlSnapshot | undefined;
			// This real PTY/IPC integration needs OS event-loop turns; fake timers cannot advance another process.
			const deadline = Date.now() + 30_000;
			while (!target && Date.now() < deadline && proc.exitCode === null) {
				[target] = await listRestartControls({ runtimeDir });
				if (!target) await Bun.sleep(50);
			}
			if (!target) {
				throw new Error(
					`Throwaway did not publish restart controls: ${proc.exitCode === null ? "still running" : (await output) + (await errors)}`,
				);
			}
			if (removeEntry) await fs.rm(launcher);
			const queued = await sendRestartControl({ identity: target.identity, op: "request" }, { runtimeDir });
			expect(queued.request?.state).toBe("queued");
			if (!removeEntry) {
				const resumed = await waitForRestartResult(queued, { runtimeDir });
				expect(resumed.request?.state, resumed.request?.error).toBe("completed");
				expect(resumed.identity.sessionId).toBe(target.identity.sessionId);
				expect(resumed.identity.instanceId).not.toBe(target.identity.instanceId);
				expect(resumed.pid).not.toBe(target.pid);
				await expect(
					sendRestartControl({ identity: target.identity, op: "request" }, { runtimeDir }),
				).rejects.toMatchObject({ code: "target_not_found" });
				const alive = await sendRestartControl({ identity: resumed.identity, op: "status" }, { runtimeDir });
				expect(alive.request?.state).toBe("completed");
				console.log(
					`throwaway successor: old_pid=${target.pid} new_pid=${resumed.pid} same_session=${resumed.identity.sessionId}`,
				);
				return;
			}
			let status = queued;
			const failureDeadline = Date.now() + 15_000;
			while (status.request?.state !== "failed" && Date.now() < failureDeadline) {
				await Bun.sleep(50);
				status = await sendRestartControl({ identity: target.identity, op: "status" }, { runtimeDir });
			}
			expect(status.request?.state).toBe("failed");
			expect(status.request?.error).toContain("successor");
			expect(status.identity).toEqual(target.identity);
			expect(status.pid).toBe(target.pid);
			expect(proc.exitCode).toBeNull();
			// A second real request must be admitted: a failed callback cannot leave the drain lease held.
			const retry = await sendRestartControl({ identity: target.identity, op: "request" }, { runtimeDir });
			expect(retry.request?.requestId).not.toBe(queued.request?.requestId);
			expect((await waitForRestartResult(retry, { runtimeDir })).request?.state).toBe("failed");
			const requestCli = Bun.spawn(
				[
					"nice",
					"-n19",
					"ionice",
					"-c2",
					"-n7",
					process.execPath,
					cli,
					"restart",
					"request",
					"--instance",
					target.identity.instanceId,
				],
				{ cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			const [requestExit, requestError] = await Promise.all([
				requestCli.exited,
				new Response(requestCli.stderr).text(),
				new Response(requestCli.stdout).text(),
			]);
			expect(requestExit).toBe(1);
			expect(requestError).toContain("Restart successor exited before confirming");
			expect((await sendRestartControl({ identity: target.identity, op: "status" }, { runtimeDir })).pid).toBe(
				target.pid,
			);
			console.log(
				`throwaway fail-closed: pid=${target.pid} session=${target.identity.sessionId} state=${status.request?.state} error=${status.request?.error}`,
			);
		} finally {
			if (proc.exitCode === null) {
				proc.stdin.write("/exit\r");
				proc.stdin.flush();
				await Promise.race([proc.exited, Bun.sleep(5_000)]);
				if (proc.exitCode === null) proc.kill();
			}
			await proc.exited;
			const transcript = await output;
			const stderr = await errors;
			if (!removeEntry && !transcript.includes("Restarted"))
				console.log(`throwaway startup failure: ${transcript.slice(-4_096)}${stderr}`);
		}
	}

	it("keeps the original session usable when the successor entry disappears", () => runLiveRestart(true), 60_000);
	it("hands a healthy restart to a real successor with the same session id", () => runLiveRestart(false), 60_000);
});
