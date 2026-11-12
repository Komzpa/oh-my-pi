// Resolve against omp's PATH, not a tool's possibly restricted environment.
const nice = process.platform === "linux" ? Bun.which("nice") : null;
const ionice = process.platform === "linux" ? Bun.which("ionice") : null;

/** Lower only tool children, before their executable can start work. */
export function backgroundCommand(command: string[]): string[] {
	if (!nice && !ionice) return command;
	return [...(nice ? [nice, "-n", "19"] : []), ...(ionice ? [ionice, "-c2", "-n7"] : []), ...command];
}
/** Prefix words for Bun Shell `$` templates: interpolate `${backgroundShellPrefix}` first. Empty off Linux. */
export const backgroundShellPrefix: string[] = backgroundCommand([]);

// Preserve Bun's overloads and stream types at each caller. Both forms share
// the same argv policy; no child environment or stdio options are changed.
export const spawnBackground = ((command: string[] | { cmd: string[] }, options?: object) => {
	if (Array.isArray(command)) return Bun.spawn(backgroundCommand(command), options);
	return Bun.spawn({ ...command, cmd: backgroundCommand(command.cmd) });
}) as typeof Bun.spawn;

export const spawnBackgroundSync = ((command: string[] | { cmd: string[] }, options?: object) => {
	if (Array.isArray(command)) return Bun.spawnSync(backgroundCommand(command), options);
	return Bun.spawnSync({ ...command, cmd: backgroundCommand(command.cmd) });
}) as typeof Bun.spawnSync;
