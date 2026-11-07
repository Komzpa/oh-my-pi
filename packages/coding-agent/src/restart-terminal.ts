import { dlopen, FFIType } from "bun:ffi";
import * as os from "node:os";

const TERMINAL_ENV = "OMP_RESTART_TERMINAL";

function openTerminal() {
	if (process.platform === "win32" || !process.stdin.isTTY) return;
	const candidates = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		try {
			return dlopen(candidate, {
				getpgrp: { args: [], returns: FFIType.i32 },
				tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
				tcsetpgrp: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				signal: { args: [FFIType.i32, FFIType.u64], returns: FFIType.u64 },
			});
		} catch {}
	}
}

// Capture ownership at startup, before cleanup or a child can change it. A genuine
// background launch must never acquire foreground rights by requesting a restart.
const terminal = openTerminal();
const ops = terminal?.symbols;
const inherited = process.env[TERMINAL_ENV];
delete process.env[TERMINAL_ENV];
const handoff = inherited?.split(":").map(Number);
const inheritedForeground =
	!!ops && handoff?.length === 4 && handoff[0] === process.pid && handoff[1] === ops.getpgrp();
const ownedForeground = !!ops && (inheritedForeground || ops.tcgetpgrp(0) === ops.getpgrp());
const signals = [os.constants.signals.SIGTTOU, os.constants.signals.SIGTTIN];
if (ops && inheritedForeground) {
	// SIG_IGN survives exec. Keep it until the successor owns the tty, then
	// restore the dispositions exec would have produced (caught => default).
	if (ops.tcsetpgrp(0, ops.getpgrp()) !== 0) throw new Error("Could not restore restart terminal foreground");
	for (const [index, signal] of signals.entries()) ops.signal(signal, handoff![index + 2] === 1 ? 1 : 0);
}

export interface RestartTerminalHandoff {
	reclaim(): void;
	restore(): void;
	execEnvironment(): Record<string, string>;
}

/** Protect teardown AND exec/startup; only the original foreground owner may reclaim. */
export function beginRestartTerminalHandoff(): RestartTerminalHandoff {
	if (!ops || !ownedForeground) return { reclaim() {}, restore() {}, execEnvironment: () => ({}) };
	const saved = signals.map(signal => ({ signal, handler: ops.signal(signal, 1) }));
	let restored = false;
	const reclaim = (): void => {
		if (restored) return;
		if (ops.tcgetpgrp(0) !== ops.getpgrp() && ops.tcsetpgrp(0, ops.getpgrp()) !== 0)
			throw new Error("Could not restore the restart process to the terminal foreground");
	};
	const restore = (): void => {
		if (restored) return;
		restored = true;
		for (const item of saved) ops.signal(item.signal, item.handler);
	};
	try {
		reclaim();
	} catch (error) {
		restore();
		throw error;
	}
	return {
		reclaim,
		restore,
		execEnvironment: () => ({
			[TERMINAL_ENV]: [process.pid, ops.getpgrp(), ...saved.map(item => (Number(item.handler) === 1 ? 1 : 0))].join(
				":",
			),
		}),
	};
}
