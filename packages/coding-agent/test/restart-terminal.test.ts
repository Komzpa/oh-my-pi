import { expect, it } from "bun:test";
import * as path from "node:path";

it.skipIf(process.platform !== "linux")("reclaims a changed foreground pgrp without a job-control stop", async () => {
	const probe = path.join(import.meta.dir, "fixtures/restart-terminal.ts");
	const child = Bun.spawn(
		[
			"python3",
			"-c",
			`
import os, pty, signal, sys, time, fcntl, termios
master, slave = pty.openpty()
os.setsid()
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
signal.signal(signal.SIGTTOU, signal.SIG_IGN)
pid = os.fork()
if pid == 0:
    os.setpgid(0, 0)
    for fd in (0, 1, 2): os.dup2(slave, fd)
    signal.signal(signal.SIGTTOU, signal.SIG_DFL)
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2]])
os.setpgid(pid, pid)
# The simulated shell owns the tty while the restarting process is backgrounded.
os.tcsetpgrp(slave, os.getpgrp())
deadline = time.monotonic() + 5
try:
    while time.monotonic() < deadline:
        got, status = os.waitpid(pid, os.WNOHANG | os.WUNTRACED)
        if got:
            if os.WIFSTOPPED(status): raise RuntimeError('restart stopped by signal ' + str(os.WSTOPSIG(status)))
            if os.waitstatus_to_exitcode(status) != 0: raise RuntimeError('probe failed')
            print('foreground restored; no stop')
            break
        time.sleep(.01)
    else: raise RuntimeError('restart timed out')
finally:
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
`,
			process.execPath,
			probe,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [code, output, errors] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ code, errors }).toEqual({ code: 0, errors: "" });
	expect(output).toContain("foreground restored; no stop");
});
