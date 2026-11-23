import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts, executeInVmContext } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { executeBash, releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { PtySession } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";

function ownNiceness(): number {
	const stat = fs.readFileSync("/proc/self/stat", "utf8");
	// Field 3 follows the parenthesized comm; field 19 is offset 16 from there.
	return Number(
		stat
			.slice(stat.lastIndexOf(")") + 1)
			.trim()
			.split(/\s+/)[16],
	);
}

function ownIoPriority(): string {
	const result = Bun.spawnSync(["ionice", "-p", String(process.pid)]);
	expect(result.exitCode).toBe(0);
	return result.stdout.toString().trim();
}

function expectBackgroundPriority(output: string): void {
	const [niceness, ioPriority] = output.trim().split(/\r?\n/);
	expect(Number(niceness)).toBe(19);
	expect(ioPriority).toMatch(/^(best-effort: prio 7|idle)$/);
	console.log(`child nice=${niceness}, ionice=${ioPriority}`);
}

const bashProbe = 'read -r stat < /proc/self/stat; set -- $stat; shift 18; printf "%s\\n" "$1"; /usr/bin/ionice -p $$';
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe.skipIf(process.platform !== "linux")("native tool-child background priority", () => {
	let parentNice: number;
	let parentIo: string;

	beforeAll(async () => {
		parentNice = ownNiceness();
		parentIo = ownIoPriority();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		console.log(`parent before nice=${parentNice}, ionice=${parentIo}`);
	});

	afterAll(async () => {
		releaseShellSessions("priority-bash");
		await disposeAllVmContexts();
		resetSettingsForTest();
	});

	it("runs the real Bash executor child at background priority with an overridden PATH", async () => {
		using cwd = TempDir.createSync("@tool-priority-bash-");
		const result = await executeBash(`/bin/bash -c ${shellQuote(bashProbe)}`, {
			cwd: cwd.path(),
			timeout: 30_000,
			sessionKey: "priority-bash",
			env: { PATH: "/no-tool-binaries" },
		});
		expect(result.exitCode).toBe(0);
		expectBackgroundPriority(result.output);
	}, 60_000);

	it("runs the real PTY child at background priority", async () => {
		using cwd = TempDir.createSync("@tool-priority-pty-");
		const pty = new PtySession();
		let output = "";
		const result = await pty.start(
			{ shell: "/bin/bash", command: bashProbe, cwd: cwd.path(), timeoutMs: 30_000 },
			(_error, chunk) => {
				output += chunk;
			},
		);
		expect(result.exitCode).toBe(0);
		expectBackgroundPriority(output);
	}, 60_000);

	it("runs a real retained Python eval kernel at background priority", async () => {
		using cwd = TempDir.createSync("@tool-priority-python-");
		const kernel = await PythonKernel.start({ cwd: cwd.path() });
		let output = "";
		try {
			const result = await kernel.execute(
				"import pathlib, subprocess, os\nprint(pathlib.Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[16])\nprint(subprocess.check_output(['/usr/bin/ionice', '-p', str(os.getpid())], text=True).strip())",
				{
					onChunk: text => {
						output += text;
					},
				},
			);
			expect(result.status).toBe("ok");
			expectBackgroundPriority(output);
		} finally {
			await kernel.shutdown();
		}
	}, 60_000);

	it("runs a real retained JavaScript eval subprocess at background priority", async () => {
		using cwd = TempDir.createSync("@tool-priority-js-");
		const session: ToolSession = {
			cwd: cwd.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};
		let output = "";
		await executeInVmContext({
			sessionKey: "priority-js",
			sessionId: "priority-js",
			cwd: cwd.path(),
			session,
			code: "console.log((await Bun.file('/proc/self/stat').text()).split(')').at(-1).trim().split(/\\s+/)[16]); console.log(Bun.spawnSync(['/usr/bin/ionice', '-p', String(process.pid)]).stdout.toString().trim());",
			filename: "[priority-js].js",
			timeoutMs: 30_000,
			runState: { onText: text => (output += text) },
		});
		expectBackgroundPriority(output);
	}, 60_000);

	it("leaves the omp test process CPU and IO priority unchanged (negative control)", () => {
		expect(ownNiceness()).toBe(parentNice);
		expect(ownIoPriority()).toBe(parentIo);
		console.log(`parent after nice=${ownNiceness()}, ionice=${ownIoPriority()}`);
	});
});
