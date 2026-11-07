import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";

const CHILDREN_ENV = "OMP_RESTART_CHILDREN";

/** Only pre-exec children: never compete with Bun for a new subprocess's status. */
export function restartChildrenEnvironment(): Record<string, string> {
	if (process.platform !== "linux") return {};
	const children = new Set<string>();
	for (const task of fs.readdirSync("/proc/self/task")) {
		try {
			for (const pid of fs.readFileSync(`/proc/self/task/${task}/children`, "utf8").trim().split(/\s+/)) {
				if (/^[1-9]\d*$/.test(pid)) children.add(pid);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return { [CHILDREN_ENV]: `${process.pid}:${[...children].join(",")}` };
}

const inherited = process.env[CHILDREN_ENV];
delete process.env[CHILDREN_ENV];
if (process.platform === "linux" && inherited?.startsWith(`${process.pid}:`)) {
	const children = new Set(
		inherited
			.split(":")[1]!
			.split(",")
			.filter(pid => /^[1-9]\d*$/.test(pid))
			.map(Number),
	);
	if (children.size) {
		const libc = dlopen("libc.so.6", {
			waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		});
		const reap = (): void => {
			for (const pid of children) {
				// WNOHANG: a child still running may finish after session restoration.
				if (libc.symbols.waitpid(pid, null, 1) !== 0) children.delete(pid);
			}
			if (!children.size) {
				clearInterval(timer);
				libc.close();
			}
		};
		const timer = setInterval(reap, 100);
		timer.unref();
		reap();
	}
}
