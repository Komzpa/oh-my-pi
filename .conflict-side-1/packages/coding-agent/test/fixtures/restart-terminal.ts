import { execRestartSuccessor } from "../../src/restart-control";
execRestartSuccessor(
	[
		process.execPath,
		"-e",
		`
const { dlopen, FFIType } = require("bun:ffi");
const libc = dlopen("libc.so.6", {
  getpgrp: { args: [], returns: FFIType.i32 },
  tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
});
process.stdin.setRawMode(true);
if (libc.symbols.getpgrp() !== libc.symbols.tcgetpgrp(0)) process.exit(2);
process.stdout.write("restart tty write\\n");
process.stdin.setRawMode(false);
libc.close();
`,
	],
	"pty-session",
);
