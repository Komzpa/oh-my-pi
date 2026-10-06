import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionSliceName } from "@oh-my-pi/pi-natives";
import { toolSessionEnvironment } from "../src/exec/session-slice";

let root: string;
let env: Record<string, string>;
const sid = "0123abcd-qa-slice-shim";

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-slice-shim-"));
	const real = path.join(root, "real-systemd-run");
	await fs.writeFile(real, '#!/bin/sh\nprintf "%s\\0" "$@"\n', { mode: 0o700 });
	env = await toolSessionEnvironment(
		sid,
		{ OMP_SYSTEMD_RUN_REAL: real, PATH: "/usr/bin:/bin" },
		path.join(root, "bin"),
	);
});
afterAll(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
});

async function argumentsOf(args: string[]): Promise<string[]> {
	const proc = Bun.spawn([path.join(root, "bin", "systemd-run"), ...args], { env, stdout: "pipe", stderr: "pipe" });
	const text = await new Response(proc.stdout).text();
	expect(await proc.exited).toBe(0);
	return text.split("\0").slice(0, -1);
}

describe("session process boundary", () => {
	it("exports stable session naming independent of the process or job", () => {
		expect(sessionSliceName(sid)).toBe("omp-tool-0123abcd.slice");
		expect(sessionSliceName("0123abcd-other-job")).toBe(sessionSliceName(sid));
		expect(() => sessionSliceName("bad/name")).toThrow();
	});
	it("adds the session slice and keeps command argument bytes unchanged", async () => {
		const args = ["--user", "--unit=qa-slice-a", "--", "/bin/echo", "a b", "$value"];
		expect(await argumentsOf(args)).toEqual(["--slice=omp-tool-0123abcd.slice", ...args]);
		expect(env.OMP_SESSION_ID).toBe(sid);
		expect(env.PATH?.split(":")[0]).toBe(path.join(root, "bin"));
	});
	it("preserves the explicit keep path in both slice syntaxes", async () => {
		for (const slice of [["--slice=omp-keep.slice"], ["--slice", "omp-keep.slice"]]) {
			const args = ["--user", "--unit", "qa-slice-keep", ...slice, "/bin/true"];
			expect(await argumentsOf(args)).toEqual(args);
		}
	});
	it("does not confuse option values or payload slice flags with manager options", async () => {
		const args = [
			"--user",
			"-u",
			"--slice=description",
			"--property",
			"Type=exec",
			"/bin/echo",
			"--slice=not-a-manager-option",
		];
		expect(await argumentsOf(args)).toEqual(["--slice=omp-tool-0123abcd.slice", ...args]);
	});
	it("leaves explicit neighboring slices and unowned environments untouched", async () => {
		const args = ["--user", "--slice=app.slice", "/bin/true"];
		expect(await argumentsOf(args)).toEqual(args);
		const unowned = { PATH: "/usr/bin:/bin", VARIABLE: "unchanged" };
		expect(await toolSessionEnvironment(undefined, unowned)).toBe(unowned);
	});
	it("can apply the environment twice without recursive shims or PATH duplication", async () => {
		const again = await toolSessionEnvironment(sid, env, path.join(root, "bin"));
		expect(again).toEqual(env);
	});
});

it.skipIf(process.platform !== "linux" || process.env.OMP_SLICE_LIVE_TEST !== "1")(
	"stops only the owned session slice, leaving an outside unit and explicit keep unit alive",
	async () => {
		const liveSid = crypto.randomUUID();
		const slice = sessionSliceName(liveSid);
		const prefix = `qa-slice-${process.pid}`;
		const managerEnv = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` };
		const run = (args: string[], childEnv: NodeJS.ProcessEnv = managerEnv) => {
			const result = Bun.spawnSync(args, { env: childEnv, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
			return result.stdout.toString().trim();
		};
		const pid = (unit: string) => Number(run(["systemctl", "--user", "show", unit, "-p", "MainPID", "--value"]));
		const units = [`${prefix}-outside.service`, `${prefix}-owned.service`, `${prefix}-keep.service`];
		try {
			run(["systemd-run", "--user", "--collect", `--unit=${units[0]}`, "--slice=app.slice", "/bin/sleep", "60"]);
			const outsidePid = pid(units[0]!);
			expect(outsidePid).toBeGreaterThan(0);
			const liveEnv = await toolSessionEnvironment(
				liveSid,
				managerEnv as Record<string, string>,
				path.join(root, "live-bin"),
			);
			const shim = path.join(root, "live-bin", "systemd-run");
			run([shim, "--user", "--collect", `--unit=${units[1]}`, "/bin/sleep", "60"], liveEnv);
			run(
				[shim, "--user", "--collect", `--unit=${units[2]}`, "--slice=omp-keep.slice", "/bin/sleep", "60"],
				liveEnv,
			);
			const ownedPid = pid(units[1]!);
			const keepPid = pid(units[2]!);
			expect(ownedPid).toBeGreaterThan(0);
			expect(keepPid).toBeGreaterThan(0);
			const cgroup = await Bun.file(`/proc/${ownedPid}/cgroup`).text();
			expect(cgroup).toContain(`/${slice}/`);
			run(["systemctl", "--user", "stop", slice]);
			expect(await Bun.file(`/proc/${ownedPid}/stat`).exists()).toBe(false);
			expect(pid(units[0]!)).toBe(outsidePid);
			expect(pid(units[2]!)).toBe(keepPid);
			console.log(
				`qa-slice negative control: ${units[0]} pid=${outsidePid} unchanged; ${units[1]} pid=${ownedPid} gone; ${units[2]} pid=${keepPid} survives`,
			);
		} finally {
			// Only fixtures created by this test, never the keep slice or existing units.
			for (const unit of units) Bun.spawnSync(["systemctl", "--user", "stop", unit], { env: managerEnv });
		}
	},
);
