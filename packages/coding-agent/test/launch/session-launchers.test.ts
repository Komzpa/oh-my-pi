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
				["browser", snapshot.daemon.pid],
				["service", service.daemon.pid],
				["python", Number(python.trim())],
				["bun", Number(bun.trim())],
			] as const) {
				const cgroup = (await Bun.file(`/proc/${pid}/cgroup`).text()).trim();
				rows.push({ kind, pid, cgroup });
			}
			const negative = (await Bun.file(`/proc/${unrelated.pid}/cgroup`).text()).trim();
			console.log(
				JSON.stringify({ fixtureId: id, slice, rows, negativeControl: { pid: unrelated.pid, cgroup: negative } }),
			);
			for (const row of rows) expect(row.cgroup).toContain(`/${slice}/`);
			expect(negative).not.toContain(`/${slice}/`);
		} finally {
			await kernel?.shutdown();
			await disposeAllVmContexts();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			await closeDaemonClients();
			const stopped = Bun.spawn(["systemctl", "--user", "stop", slice], { stdout: "ignore", stderr: "pipe" });
			expect(await stopped.exited).toBe(0);
			unrelated.kill();
			await unrelated.exited;
		}
	}, 120_000);
});
