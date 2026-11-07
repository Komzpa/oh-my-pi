import { dlopen, FFIType } from "bun:ffi";
import { execRestartSuccessor } from "../../src/restart-control";

const [mode, report, wrapper, python, successor] = process.argv.slice(2);
const libc = dlopen("libc.so.6", {
	getpgrp: { args: [], returns: FFIType.i32 },
	tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
});
await Bun.write(report!, JSON.stringify({ pid: process.pid, pgid: libc.symbols.getpgrp() }));
// Let the parent observe the running process before crossing exec.
await Bun.sleep(100);
if (mode !== "background") {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.pause();
	process.stdin.setRawMode(false);
}
const child = Bun.spawn([python!, "-c", "import time; time.sleep(.5)"], { stdout: "ignore", stderr: "ignore" });
execRestartSuccessor(
	[python!, wrapper!, process.execPath, successor!, mode!, report!, String(child.pid)],
	"pty-session",
);
