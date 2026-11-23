import * as fs from "node:fs/promises";
import { dlopen, FFIType } from "bun:ffi";
import "../../src/restart-control";

const [mode, report, childPid] = process.argv.slice(2);
const libc = dlopen("libc.so.6", {
	getpgrp: { args: [], returns: FFIType.i32 },
	tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
});
if (mode !== "background") {
	process.stdin.setRawMode(true);
	process.stdin.resume();
}
// The old child exits after exec; a fresh child must retain Bun's exit status.
const fresh = Bun.spawn(["sh", "-c", "exit 7"], { stdout: "ignore", stderr: "ignore" });
const freshExit = await fresh.exited;
await Bun.sleep(1000);
let reaped = false;
try {
	await fs.stat(`/proc/${childPid}`);
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	reaped = true;
}
await Bun.write(
	`${report}.done`,
	JSON.stringify({
		pid: process.pid,
		pgid: libc.symbols.getpgrp(),
		foreground: libc.symbols.tcgetpgrp(0),
		reaped,
		freshExit,
	}),
);
if (mode !== "background") {
	process.stdin.pause();
	process.stdin.setRawMode(false);
}
// Keep the job alive until the parent has checked foreground ownership.
await Bun.sleep(10000);
