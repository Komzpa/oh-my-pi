import { expect, test } from "bun:test";

const probe = `${import.meta.dir}/fixtures/jit-bootstrap-probe.ts`;

test.skipIf(process.platform !== "linux")(
	"Linux CLI restart preserves PID and arguments while enabling debugger attach",
	async () => {
		const env = { ...process.env };
		delete env.BUN_JSC_useGdbJITInfo;
		const child = Bun.spawn([process.execPath, probe, "two words", "--model=fixture"], { env, stdout: "pipe" });
		const output = await new Response(child.stdout).json();
		expect(await child.exited).toBe(0);
		expect(output).toEqual({ args: ["two words", "--model=fixture"], pid: child.pid, jit: "1" });
	},
);

test.skipIf(process.platform !== "linux")("operator can explicitly disable GDB registration", async () => {
	const child = Bun.spawn([process.execPath, probe, "keep"], {
		env: { ...process.env, BUN_JSC_useGdbJITInfo: "0" },
		stdout: "pipe",
	});
	const output = await new Response(child.stdout).json();
	expect(await child.exited).toBe(0);
	expect(output).toEqual({ args: ["keep"], pid: child.pid, jit: "0" });
});
