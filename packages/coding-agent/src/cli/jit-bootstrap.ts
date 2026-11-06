/**
 * JSC reads its options before evaluating JavaScript. Restart the Linux CLI
 * once with GDB JIT registration enabled so a later debugger attach can name
 * busy JavaScript frames. Explicit operator settings, including 0, win.
 */
export function bootstrapJitDebugInfo(compiled: boolean): void {
	if (process.platform !== "linux" || process.env.BUN_JSC_useGdbJITInfo !== undefined) return;
	if (!process.execve) return;
	const args = compiled
		? [process.execPath, ...process.argv.slice(2)]
		: [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
	process.execve(process.execPath, args, { ...process.env, BUN_JSC_useGdbJITInfo: "1" });
}
