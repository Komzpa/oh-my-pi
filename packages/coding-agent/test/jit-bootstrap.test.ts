import { expect, test } from "bun:test";

const probe = `${import.meta.dir}/fixtures/jit-bootstrap-probe.ts`;

interface ProbeOutput {
	args: string[];
	pid: number;
	jit?: string;
	inherited?: string;
}

function cleanEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, ...extra };
	delete env.BUN_JSC_useGdbJITInfo;
	delete env.OMP_JIT_DEBUG_REEXEC;
	return { ...env, ...extra };
}

async function runProbe(args: string[], env: Record<string, string | undefined>) {
	const child = Bun.spawn([process.execPath, probe, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const output = (await new Response(child.stdout).json()) as ProbeOutput;
	expect(await child.exited).toBe(0);
	return { output, pid: child.pid };
}

test.skipIf(process.platform !== "linux")(
	"interactive Linux CLI restart preserves PID and arguments while enabling debugger attach",
	async () => {
		const { output, pid } = await runProbe(["two words", "--model=fixture"], cleanEnv());
		expect(output).toEqual({ args: ["two words", "--model=fixture"], pid, jit: "1" });
	},
);

test.skipIf(process.platform !== "linux")("restarted CLI does not pass the JSC setting to subprocesses", async () => {
	const { output } = await runProbe(["keep"], cleanEnv());
	expect(output.jit).toBe("1");
	expect(output.inherited).toBeUndefined();
});

test.skipIf(process.platform !== "linux")("scripted invocations are not restarted", async () => {
	const { output } = await runProbe(["--version"], cleanEnv({ PROBE_INTERACTIVE: "0" }));
	expect(output.jit).toBeUndefined();
});

test.skipIf(process.platform !== "linux")("operator can explicitly disable GDB registration", async () => {
	const { output, pid } = await runProbe(["keep"], { ...cleanEnv(), BUN_JSC_useGdbJITInfo: "0" });
	expect(output).toEqual({ args: ["keep"], pid, jit: "0", inherited: "0" });
});

test.skipIf(process.platform !== "linux")("worker threads never restart the process", async () => {
	const worker = new Worker(`${import.meta.dir}/fixtures/jit-bootstrap-worker.ts`);
	const result = await new Promise<string>((resolve, reject) => {
		worker.addEventListener("message", event => resolve(String(event.data)));
		worker.addEventListener("error", event => reject(new Error(event.message)));
	});
	worker.terminate();
	expect(result).toBe("ok");
});
