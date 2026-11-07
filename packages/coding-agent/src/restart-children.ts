import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import { isMainThread } from "node:worker_threads";

const CHILDREN_ENV = "OMP_RESTART_CHILDREN";

/** Only pre-exec children: never compete with Bun for a new subprocess's status. */
function currentChildren(): Set<string> {
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
	return children;
}

/** Called only by the early CLI entrypoint, before it creates subprocesses.
 * An older image may exec without OMP_RESTART_CHILDREN. Those children still
 * belong to this PID, but Bun's new image has no subprocess handles for them.
 */
export function reapStartupChildren(): void {
	if (process.platform === "linux" && isMainThread) reapChildren(new Set([...currentChildren()].map(Number)));
}

export function restartChildrenEnvironment(): Record<string, string> {
	if (process.platform !== "linux") return {};
	return { [CHILDREN_ENV]: `${process.pid}:${[...currentChildren()].join(",")}` };
}

function reapChildren(children: Set<number>): void {
	if (!children.size) return;
	const libc = dlopen("libc.so.6", {
		waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	});
	const reap = (): void => {
		for (const pid of children) {
			// WNOHANG: an inherited child may finish after session restoration.
			// Use pinned PIDs, never -1: new Bun children own their exit status.
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

const inherited = process.env[CHILDREN_ENV];
delete process.env[CHILDREN_ENV];
if (process.platform === "linux" && isMainThread && inherited?.startsWith(`${process.pid}:`)) {
	reapChildren(
		new Set(
			inherited
				.split(":")[1]!
				.split(",")
				.filter(pid => /^[1-9]\d*$/.test(pid))
				.map(Number),
		),
	);
}
