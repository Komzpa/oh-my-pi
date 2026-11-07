import { dlopen, FFIType } from "bun:ffi";
import * as os from "node:os";

/** Protect tty operations throughout a restart, including asynchronous cleanup. */
export function beginRestartTerminalHandoff(): { reclaim(): void; restore(): void } {
	if (process.platform === "win32" || !process.stdin.isTTY) return { reclaim() {}, restore() {} };
	const candidates = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		let libc;
		try {
			libc = dlopen(candidate, {
				getpgrp: { args: [], returns: FFIType.i32 },
				tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
				tcsetpgrp: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				signal: { args: [FFIType.i32, FFIType.u64], returns: FFIType.u64 },
			});
		} catch {
			continue;
		}
		const ops = libc.symbols;
		const saved = [os.constants.signals.SIGTTOU, os.constants.signals.SIGTTIN].map(signal => ({
			signal,
			handler: ops.signal(signal, 1), // SIG_IGN; caught JS handlers do not make tcsetpgrp safe.
		}));
		let restored = false;
		const reclaim = (): void => {
			if (restored) return;
			const group = ops.getpgrp();
			const foreground = ops.tcgetpgrp(0);
			if (foreground >= 0 && foreground !== group && ops.tcsetpgrp(0, group) !== 0)
				throw new Error("Could not restore the restart process to the terminal foreground");
		};
		const restore = (): void => {
			if (restored) return;
			restored = true;
			for (const item of saved) ops.signal(item.signal, item.handler);
			libc.close();
		};
		try {
			reclaim();
		} catch (error) {
			restore();
			throw error;
		}
		return { reclaim, restore };
	}
	throw new Error("Could not load terminal foreground operations for restart");
}
