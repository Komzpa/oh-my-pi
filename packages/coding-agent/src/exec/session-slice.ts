import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionSliceName } from "@oh-my-pi/pi-natives";
import { getDaemonRuntimeRoot } from "@oh-my-pi/pi-utils";

const shimSource = `#!/bin/sh
# Only manager options count; a command's own --slice argument does not.
needs_value=no
explicit_slice=no
scope=no
for arg do
  if [ "$needs_value" = yes ]; then needs_value=no; continue; fi
  case "$arg" in
    --slice) explicit_slice=yes; needs_value=yes ;;
    --slice=*) explicit_slice=yes ;;
    --scope) scope=yes ;;
    --) break ;;
    -H|-M|-C|-u|-p|-E|--host|--machine|--capsule|--unit|--property|--description|--service-type|--uid|--gid|--nice|--working-directory|--root-directory|--setenv|--expand-environment|--output|--json|--job-mode|--background|--path-property|--socket-property|--on-active|--on-boot|--on-startup|--on-unit-active|--on-unit-inactive|--on-calendar|--timer-property) needs_value=yes ;;
    -*) ;;
    *) break ;;
  esac
done
# Services do not inherit the caller environment; scopes already do.
if [ "$scope" = no ]; then set -- "--setenv=OMP_SESSION_ID=$OMP_SESSION_ID" "$@"; fi
if [ "$explicit_slice" = no ]; then set -- "--slice=$OMP_SESSION_SLICE" "$@"; fi
exec "$OMP_SYSTEMD_RUN_REAL" "$@"
`;

const shims = new Map<string, Promise<void>>();

/** Add the session owner and put the systemd-run shim first on a local tool PATH. */
export async function toolSessionEnvironment(
	sessionId: string | undefined,
	env: Record<string, string>,
	shimDir = path.join(path.dirname(getDaemonRuntimeRoot()), "tool-bin"),
): Promise<Record<string, string>> {
	if (process.platform !== "linux" || !sessionId) return env;
	const slice = sessionSliceName(sessionId);
	const searchPath = env.PATH ?? process.env.PATH ?? "";
	const real = env.OMP_SYSTEMD_RUN_REAL ?? Bun.which("systemd-run", { PATH: searchPath });
	if (!real) throw new Error("systemd-run is required for session-owned tool processes");
	let ready = shims.get(shimDir);
	if (!ready) {
		ready = (async () => {
			await fs.mkdir(shimDir, { recursive: true, mode: 0o700 });
			const target = path.join(shimDir, "systemd-run");
			const temporary = `${target}.${process.pid}.tmp`;
			await fs.writeFile(temporary, shimSource, { mode: 0o700 });
			await fs.rename(temporary, target);
		})();
		shims.set(shimDir, ready);
	}
	await ready;
	const rest = searchPath
		.split(path.delimiter)
		.filter(entry => entry !== shimDir)
		.join(path.delimiter);
	return {
		...env,
		OMP_SESSION_ID: sessionId,
		OMP_SESSION_SLICE: slice,
		OMP_SYSTEMD_RUN_REAL: real,
		PATH: `${shimDir}${path.delimiter}${rest}`,
	};
}

/** Apply ownership after the PTY caller has composed its environment overlays. */
export async function sessionPtyOptions<T extends { env?: Record<string, string> }>(
	sessionId: string | undefined,
	options: T,
): Promise<T> {
	return { ...options, env: await toolSessionEnvironment(sessionId, options.env ?? {}) };
}
