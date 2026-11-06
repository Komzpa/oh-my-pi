import { isMainThread } from "node:worker_threads";

/** Marks the process image started by the restart below; never set by operators. */
const REEXEC_MARK = "OMP_JIT_DEBUG_REEXEC";

/**
 * JSC reads its options before evaluating JavaScript. Restart an interactive
 * Linux CLI once with GDB JIT registration enabled so a later debugger attach
 * can name busy JavaScript frames. Explicit operator settings, including 0, win.
 *
 * JSC prints "useGdbJITInfo should be used with OFFLINE_ASM_ALT_ENTRY" to stderr
 * at startup, so scripted invocations (`omp --version`, `omp peers`, piped use)
 * are left alone, and the restarted process removes the setting from its own
 * environment so tool and worker subprocesses do not inherit the warning.
 */
export function bootstrapJitDebugInfo(
	compiled: boolean,
	interactive: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): void {
	// execve replaces the whole process: only the main thread of the CLI process may do it.
	// Subagent workers run this entry inside worker threads, where Bun throws
	// "Calling process.execve is not supported in workers".
	if (process.platform !== "linux" || !isMainThread) return;
	if (process.env[REEXEC_MARK] === "1") {
		delete process.env[REEXEC_MARK];
		delete process.env.BUN_JSC_useGdbJITInfo;
		return;
	}
	if (!interactive || process.env.BUN_JSC_useGdbJITInfo !== undefined) return;
	if (!process.execve) return;
	const args = compiled
		? [process.execPath, ...process.argv.slice(2)]
		: [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
	process.execve(process.execPath, args, { ...process.env, BUN_JSC_useGdbJITInfo: "1", [REEXEC_MARK]: "1" });
}
