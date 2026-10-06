import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionSliceName } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { PythonKernel } from "../../src/eval/py/kernel";
import { disposeAllVmContexts, executeInVmContext } from "../../src/eval/js/context-manager";
import { closeDaemonClients, daemonClientForProject } from "../../src/launch/client";
import { readStoredDaemonRecord } from "../../src/launch/paths";
import { startService } from "../../src/launch/services";
import { ensureSharedBrowser } from "../../src/tools/browser/shared-daemon";
import { loadPuppeteer } from "../../src/tools/browser/launch";
import type { ToolSession } from "../../src/tools";

const live = process.platform === "linux" && process.env.OMP_SESSION_SLICE_LIVE_TEST === "1";

async function cgroupPids(directory: string): Promise<number[]> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const direct = (await Bun.file(path.join(directory, "cgroup.procs")).text())
			.split("\n")
			.filter(Boolean)
			.map(Number);
		const nested = await Promise.all(
			entries.filter(entry => entry.isDirectory()).map(entry => cgroupPids(path.join(directory, entry.name))),
		);
		return direct.concat(...nested);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

describe("daemon birth identity", () => {
	it("prunes a reused pid and retains the matching birth identity", async () => {
		if (process.platform !== "linux") return;
		using temp = TempDir.createSync("qa-slice-record-");
		const stat = await Bun.file(`/proc/${process.pid}/stat`).text();
		const birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		for (const [name, startTime] of [
			["stale", "0"],
			["valid", birth],
		] as const) {
			const dir = path.join(temp.path(), name);
			await fs.mkdir(dir);
			await Bun.write(
				path.join(dir, "meta.json"),
				JSON.stringify({ daemon: { pid: process.pid }, processStartTime: startTime }),
			);
			await Bun.write(path.join(dir, "spec.json"), "{}");
			const record = await readStoredDaemonRecord(dir);
			expect(record !== undefined).toBe(name === "valid");
			expect(await fs.exists(dir)).toBe(name === "valid");
		}
	});
	it("prunes a gone pid without pruning terminal history", async () => {
		if (process.platform !== "linux") return;
		using temp = TempDir.createSync("qa-slice-record-");
		const child = Bun.spawn(["true"]);
		await child.exited;
		for (const [name, daemon] of [
			["gone", { pid: child.pid }],
			["history", { state: "exited" }],
		] as const) {
			const dir = path.join(temp.path(), name);
			await fs.mkdir(dir);
			await Bun.write(path.join(dir, "meta.json"), JSON.stringify({ daemon, processStartTime: "0" }));
			await Bun.write(path.join(dir, "spec.json"), "{}");
			expect((await readStoredDaemonRecord(dir)) !== undefined).toBe(name === "history");
		}
	});
	it("negative control: retains a matching live record and terminal history", async () => {
		if (process.platform !== "linux") return;
		using temp = TempDir.createSync("qa-slice-control-");
		const stat = await Bun.file(`/proc/${process.pid}/stat`).text();
		const birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		await Bun.write(
			path.join(temp.path(), "meta.json"),
			JSON.stringify({ daemon: { pid: process.pid }, processStartTime: birth }),
		);
		await Bun.write(path.join(temp.path(), "spec.json"), "{}");
		expect(await readStoredDaemonRecord(temp.path())).toBeDefined();
	});
});

describe.skipIf(!live)("session launcher consumer cgroups", () => {
	it("keeps the process-local fallback browser main pid in its inherited session slice", async () => {
		using temp = TempDir.createSync("qa-slice-fallback-");
		const slice = sessionSliceName(crypto.randomUUID());
		const fixture = path.join(temp.path(), "fallback.ts");
		const registry = path.resolve(import.meta.dir, "../../src/tools/browser/registry.ts");
		await Bun.write(
			fixture,
			`
import { acquireBrowser, releaseBrowser } from ${JSON.stringify(registry)};
import { workerHostEntry, isCompiledBinary } from "${path.resolve(import.meta.dir, "../../../utils/src/index.ts")}";
if (isCompiledBinary() || workerHostEntry() !== null) throw new Error("fallback not exercised: CLI host present");
const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: ${JSON.stringify(temp.path())} });
try {
  if (!("browser" in handle) || handle.sharedDaemon) throw new Error("fallback not exercised: broker handle");
  const pid = handle.browser.process()?.pid;
  if (!pid) throw new Error("fallback main pid missing");
  const page = await handle.browser.newPage();
  await page.goto("data:text/html,<title>fallback-ready</title>");
  await page.close();
  const cgroup = (await Bun.file(\`/proc/\${pid}/cgroup\`).text()).trim();
  console.log(JSON.stringify({ fixture: "fallback", pid, slice: ${JSON.stringify(slice)}, cgroup }));
  if (!cgroup.includes("/" + ${JSON.stringify(slice)} + "/")) throw new Error("fallback browser escaped session slice");
} finally { await releaseBrowser(handle, { kill: true }); }
`,
		);
		try {
			const child = Bun.spawn(
				["systemd-run", "--user", "--scope", "--quiet", `--slice=${slice}`, process.execPath, fixture],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			console.log(stdout);
			if (code !== 0) throw new Error(`fallback fixture exited ${code}: ${stderr}`);
			expect(stdout).toContain('"fixture":"fallback"');
		} finally {
			const stop = Bun.spawn(["systemctl", "--user", "stop", slice], { stdout: "ignore", stderr: "pipe" });
			await stop.exited;
		}
	}, 90_000);
	it("owns a browser tab, Python/Bun kernels and a named service without adopting an unrelated child", async () => {
		using temp = TempDir.createSync("qa-slice-consumers-");
		const cwd = path.resolve(temp.path());
		const id = crypto.randomUUID();
		const slice = sessionSliceName(id);
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => id,
			settings: Settings.isolated({ "launch.enabled": true, shellPath: "/bin/sh" }),
		};
		const client = await daemonClientForProject(cwd, id);
		let kernel: PythonKernel | undefined;
		const unrelated = Bun.spawn(["sleep", "90"]);
		let cleanupError: Error | undefined;
		try {
			const browser = await ensureSharedBrowser({ projectDir: cwd, sessionId: id, headless: true });
			expect(browser).not.toBeNull();
			if (!browser) throw new Error("Browser launch unavailable");
			const puppeteer = await loadPuppeteer();
			const connection = await puppeteer.connect({ browserWSEndpoint: browser.wsEndpoint });
			const tab = await connection.newPage();
			await tab.goto("data:text/html,<title>qa-slice</title>");
			await tab.close();
			connection.disconnect();
			const snapshot = await client.request({ op: "describe", name: browser.daemonName });
			if (snapshot.op !== "describe" || snapshot.daemon.pid === undefined) throw new Error("Browser pid missing");
			const service = await startService(session, {
				name: `qa-slice-${process.pid}-service`,
				command: "exec sleep 90",
				pty: false,
			});
			if (service.daemon.pid === undefined) throw new Error("Service pid missing");
			kernel = await PythonKernel.start({ cwd, sessionId: id });
			let python = "";
			const pythonResult = await kernel.execute("import os\nprint(os.getpid())", {
				onChunk: chunk => {
					python += chunk;
				},
			});
			expect(pythonResult.status).toBe("ok");
			let bun = "";
			await executeInVmContext({
				sessionKey: id,
				sessionId: id,
				cwd,
				session,
				code: "console.log(process.pid)",
				filename: "[qa-slice].js",
				timeoutMs: 30_000,
				runState: {
					onText: chunk => {
						bun += chunk;
					},
				},
			});
			const rows = [];
			for (const [kind, pid] of [
				["browser-main", snapshot.daemon.pid],
				["service", service.daemon.pid],
				["python", Number(python.trim())],
				["bun", Number(bun.trim())],
			] as const) {
				const cgroup = (await Bun.file(`/proc/${pid}/cgroup`).text()).trim();
				rows.push({ kind, pid, cgroup });
			}
			const browserMain = rows[0];
			expect(browserMain.kind).toBe("browser-main");
			expect(browserMain.cgroup).toContain(`/${slice}/`);
			const negative = (await Bun.file(`/proc/${unrelated.pid}/cgroup`).text()).trim();
			console.log(
				JSON.stringify({ fixtureId: id, slice, rows, negativeControl: { pid: unrelated.pid, cgroup: negative } }),
			);
			for (const row of rows.slice(1)) expect(row.cgroup).toContain(`/${slice}/`);
			expect(negative).not.toContain(`/${slice}/`);
		} finally {
			await kernel?.shutdown();
			await disposeAllVmContexts();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			await closeDaemonClients();
			const runtimeDir = `/run/user/${process.getuid!()}`;
			const systemdEnv = {
				...process.env,
				XDG_RUNTIME_DIR: runtimeDir,
				DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "bus")}`,
			};
			const stopped = Bun.spawn(["systemctl", "--user", "stop", slice], {
				stdout: "pipe",
				stderr: "pipe",
				env: systemdEnv,
			});
			const [stopStderr, stopCode] = await Promise.all([new Response(stopped.stderr).text(), stopped.exited]);
			const state = Bun.spawn(
				["systemctl", "--user", "show", slice, "-p", "ActiveState,LoadState,SubState,ControlGroup"],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: systemdEnv,
				},
			);
			const [stateOut, stateErr] = await Promise.all([
				new Response(state.stdout).text(),
				new Response(state.stderr).text(),
			]);
			const stateCode = await state.exited;
			const values = Object.fromEntries(
				stateOut
					.trim()
					.split("\n")
					.map(line => line.split("=")),
			);
			const noLongerActive = values.LoadState === "not-found" || values.ActiveState === "inactive";
			const pids = values.ControlGroup ? await cgroupPids(path.join("/sys/fs/cgroup", values.ControlGroup)) : [];
			if (stateCode !== 0 || !noLongerActive || pids.length > 0) {
				const status = Bun.spawn(["systemctl", "--user", "status", slice], {
					stdout: "pipe",
					stderr: "pipe",
					env: systemdEnv,
				});
				const [statusOut, statusErr] = await Promise.all([
					new Response(status.stdout).text(),
					new Response(status.stderr).text(),
				]);
				cleanupError = new Error(
					`systemctl stop ${slice} exited ${stopCode}: ${stopStderr.trim()}\nstate: ${stateOut.trim()} ${stateErr.trim()}\nprocesses: ${pids.join(", ")}\nstatus: ${statusOut.trim()} ${statusErr.trim()}`,
				);
			}
			unrelated.kill();
			await unrelated.exited;
		}
		if (cleanupError) throw cleanupError;
	}, 120_000);
});
