import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Operator escape hatch, shared by all stop-enforcing harness extensions. */
export function gateSwitchedOff(ctx: ExtensionContext): boolean {
	const dir = process.env.OMP_TODO_DISPATCH_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "omp-todo-dispatch");
	const session = ctx.sessionManager?.getHeader?.()?.id;
	try { fs.statSync(path.join(dir, "off")); return true; } catch {}
	if (session) try { fs.statSync(path.join(dir, `${session}.off`)); return true; } catch {}
	return false;
}
