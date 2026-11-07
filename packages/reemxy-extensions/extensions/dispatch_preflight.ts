import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { parseCommandArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";

export function fileToolTargets(input: Record<string, unknown>): string[] {
	const targets = [
		typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined,
	];
	if (Array.isArray(input.paths))
		targets.push(...input.paths.filter((target): target is string => typeof target === "string"));
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (edit && typeof edit === "object" && typeof (edit as Record<string, unknown>).rename === "string") {
				targets.push((edit as Record<string, string>).rename);
			}
		}
	}
	if (typeof input.input === "string") {
		for (const line of input.input.split(/\r?\n/)) {
			const hashline = /^\[([^\]]+)\]$/.exec(line.trim());
			const patchFile = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/.exec(line.trim());
			const patchMove = /^\*\*\*\s+Move to:\s*(.+)$/.exec(line.trim());
			const unified = /^(?:--- a\/|\+\+\+ b\/)(.+)$/.exec(line.trim());
			const target =
				hashline?.[1]?.replace(/#[0-9a-f]{4}$/i, "") ?? patchFile?.[1] ?? patchMove?.[1] ?? unified?.[1];
			if (target && target !== "/dev/null") targets.push(target);
		}
	}
	return [...new Set(targets.filter((target): target is string => Boolean(target)))];
}
export interface TestProcess {
	pid: number;
	ppid?: number;
	cwd: string;
	command: string;
	argv?: string[];
}
export interface HostTestResources {
	memAvailableKiB?: number;
	processes: TestProcess[];
	cpus: number;
	gpuFreeMiB?: number[];
}
export interface HostResourceProbes {
	meminfo: () => Promise<string>;
	processes: () => Promise<TestProcess[]>;
	cpus?: () => number;
	gpuFreeMiB?: () => Promise<number[]>;
}

/** Tokenize shell syntax outside quotes, then reuse the central quote decoder. */
function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote = "";
	const flush = () => {
		if (token) tokens.push(token);
		token = "";
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (char === "\\" && quote !== "'") {
			token += char + (command[++i] ?? "");
			continue;
		}
		if (quote) {
			token += char;
			if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '\"') {
			quote = char;
			token += char;
			continue;
		}
		if ([";", "&", "|", "\n", ">", "<"].includes(char)) {
			flush();
			if (command[i + 1] === char && char !== "\n") {
				tokens.push(char + char);
				i++;
			} else tokens.push(char);
			continue;
		}
		if (char === " " || char === "\t") {
			flush();
			continue;
		}
		token += char;
	}
	if (quote) return [];
	flush();
	return tokens;
}
function decode(token: string): string | undefined {
	if (["$", "`", "*", "?"].some(char => token.includes(char))) return;
	try {
		return parseCommandArgs(token, { strict: true })[0];
	} catch {
		return;
	}
}
export function commandArgv(command: string): string[] {
	const tokens = shellTokens(command);
	if (tokens.some(token => [";", "&&", "||", "|", "\n", ">", ">>"].includes(token))) return [];
	return tokens.flatMap(token => {
		const value = decode(token);
		return value === undefined ? [] : [value];
	});
}
function unwrap(argv: string[]): string[] {
	while (argv[0]?.includes("=")) argv = argv.slice(1);
	const executable = path.basename(argv[0] ?? "");
	if (["command", "nohup", "env"].includes(executable)) {
		let rest = argv.slice(1);
		while (rest[0]?.startsWith("-")) rest = rest.slice(1);
		return unwrap(rest);
	}
	if (executable === "timeout") return unwrap(argv.slice(2));
	return argv;
}
interface ShellAction {
	argv: string[];
	cwd: string;
	targets: string[];
}
function shellActions(command: string, cwd: string, depth = 0): ShellAction[] {
	if (depth > 4) return [];
	const actions: ShellAction[] = [];
	let argv: string[] = [];
	let targets: string[] = [];
	const flush = () => {
		argv = unwrap(argv);
		if (argv[0] === "cd" && argv[1]) cwd = path.resolve(cwd, argv[1]);
		else if (
			["bash", "sh", "zsh"].includes(path.basename(argv[0] ?? "")) &&
			["-c", "-lc"].includes(argv[1] ?? "") &&
			argv[2]
		)
			actions.push(...shellActions(argv[2], cwd, depth + 1));
		else actions.push({ argv, cwd, targets });
		argv = [];
		targets = [];
	};
	const tokens = shellTokens(command);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if ([";", "&&", "||", "|", "&", "\n"].includes(token)) {
			flush();
			continue;
		}
		if (token === ">" || token === ">>") {
			const target = decode(tokens[++i] ?? "");
			if (target && target !== "&1" && target !== "&2") targets.push(target);
			continue;
		}
		const value = decode(token);
		if (value !== undefined) argv.push(value);
	}
	flush();
	return actions;
}

const BROWSERS = new Set([
	"chromium",
	"chromium-browser",
	"chrome",
	"google-chrome",
	"chrome-headless-shell",
	"firefox",
]);
const RUNNERS = new Set(["vitest", "jest", "pytest", "nextest"]);
export function launchesTestProcess(argv: readonly string[]): boolean {
	argv = unwrap([...argv]);
	const executable = path.basename(argv[0] ?? "");
	if (BROWSERS.has(executable)) return !argv.some(arg => arg.startsWith("--type="));
	if (RUNNERS.has(executable)) return true;
	if (executable === "playwright") return argv[1] === "test" || argv[1] === "screenshot";
	if (
		["bun", "npm", "pnpm", "yarn", "cargo"].includes(executable) &&
		(/^test(?::|$)/.test(argv[1] ?? "") || (argv[1] === "run" && /^test(?::|$)/.test(argv[2] ?? "")))
	)
		return true;
	if (["npx", "bunx"].includes(executable)) return launchesTestProcess(argv.slice(1));
	if (["node", "bun", "python", "python3"].includes(executable)) {
		if (argv[1] === "-m") return RUNNERS.has(argv[2] ?? "");
		const script = path.basename(argv[1] ?? "");
		if (["playwright", "playwright.js", "cli.js"].includes(script) && argv[2] === "test") return true;
		return RUNNERS.has(script) || RUNNERS.has(script.slice(0, -3));
	}
	return false;
}

async function testProcesses(): Promise<TestProcess[]> {
	const found: TestProcess[] = [];
	const parents = new Map<number, number>();
	for (const pid of await fs.readdir("/proc")) {
		if (!Number.isInteger(Number(pid))) continue;
		try {
			const argv = (await Bun.file(`/proc/${pid}/cmdline`).text()).split("\0").filter(Boolean);
			const stat = await Bun.file(`/proc/${pid}/stat`).text();
			const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
			parents.set(Number(pid), ppid);
			if (!launchesTestProcess(argv)) continue;
			found.push({
				pid: Number(pid),
				ppid,
				argv,
				command: argv.join(" "),
				cwd: await fs.readlink(`/proc/${pid}/cwd`),
			});
		} catch {
			/* exited or inaccessible */
		}
	}
	// A runner, its worker and Chromium descendants are one run, not three slots.
	const launches = new Set(found.map(proc => proc.pid));
	return found.filter(proc => {
		let parent = proc.ppid;
		const visited = new Set<number>();
		while (parent && !visited.has(parent)) {
			if (launches.has(parent)) return false;
			visited.add(parent);
			parent = parents.get(parent);
		}
		return true;
	});
}

// RAM budget: 4 GiB, rounded above 2x the measured 1.58 GiB fixture peak.
// See browser-capacity.md. GPU runs reserve 1 GiB plus a 1 GiB device floor.
export const TEST_RUN_KIB = 4 * 1024 ** 2;
export const GPU_RUN_MIB = 1024;
export const GPU_FLOOR_MIB = 1024;

export function requiresHardwareGpu(argv: readonly string[]): boolean {
	return argv.some(
		arg => arg === "OMP_TEST_GPU=1" || /(?:^|[\/_.-])(?:perf|performance|timing|frame-cap)(?:[\/_.=-]|$)/i.test(arg),
	);
}

async function gpuFreeMemory(): Promise<number[]> {
	const result = await $`nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error("nvidia-smi unavailable");
	const values = result.text().trim().split("\n").map(Number);
	if (!values.length || values.some(value => !Number.isFinite(value) || value < 0))
		throw new Error("Invalid GPU memory probe");
	return values;
}

export async function probeHostTestResources(
	probes: HostResourceProbes = {
		meminfo: () => Bun.file("/proc/meminfo").text(),
		processes: testProcesses,
		gpuFreeMiB: gpuFreeMemory,
	},
): Promise<HostTestResources> {
	const [memory, processes, gpu] = await Promise.allSettled([
		probes.meminfo(),
		probes.processes(),
		probes.gpuFreeMiB?.(),
	]);
	const fields =
		memory.status === "fulfilled"
			? memory.value
					.split("\n")
					.find(line => line.startsWith("MemAvailable:"))
					?.split(/\s+/)
			: undefined;
	return {
		memAvailableKiB: fields && Number.isFinite(Number(fields[1])) ? Number(fields[1]) : undefined,
		cpus: Math.max(1, probes.cpus?.() ?? os.availableParallelism()),
		gpuFreeMiB: gpu.status === "fulfilled" ? gpu.value : undefined,
		processes: processes.status === "fulfilled" ? processes.value : [],
	};
}

export function ramThresholdGiB(value = process.env.OMP_DISPATCH_MIN_RAM_GIB): number {
	const parsed = Number(value);
	return value?.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : 8;
}

async function canonical(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		const parent = path.dirname(target);
		return parent === target ? target : path.join(await canonical(parent), path.basename(target));
	}
}
function inside(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${path.sep}`);
}

/** Known operands only; opaque scripts and substitutions are not guessed from prose. */
function bashWriteTargets(argv: string[]): string[] {
	const executable = path.basename(argv[0] ?? "");
	const operands = argv.slice(1).filter(arg => !arg.startsWith("-"));
	if (["touch", "mkdir", "rm", "rmdir", "truncate", "tee"].includes(executable)) return operands;
	if (["cp", "install"].includes(executable)) return operands.length >= 2 ? operands.slice(-1) : [];
	if (executable === "mv") return operands.length >= 2 ? operands : [];
	return [];
}

/** Read the parent's current plan, never the child's copied TODO snapshot. */
export function workerRowScope(ctx: ExtensionContext) {
	const registry = AgentRegistry.global();
	const workers: string[] = [];
	let workerId = ctx.agent?.id;
	let parentId = ctx.agent?.parentId;
	const seen = new Set<string>();
	let lead;
	while (workerId && parentId && !seen.has(parentId)) {
		seen.add(parentId);
		workers.push(workerId);
		const parent = registry.get(parentId);
		if (!parent) break;
		lead = parent;
		workerId = parentId;
		parentId = parent.parentId;
	}
	const phases = lead?.session?.getTodoPhases() ?? [];
	for (const owner of workers.reverse()) {
		const rows = phases
			.flatMap(phase => phase.tasks)
			.filter(
				row =>
					row.status !== "completed" &&
					row.status !== "abandoned" &&
					(row.schedule?.owner === owner || row.schedule?.executor?.workerId === owner),
			);
		if (rows.length) return { rows, phases, lead: lead! };
	}
	return undefined;
}

export function liveWorkerRows(ctx: ExtensionContext) {
	return workerRowScope(ctx)?.rows ?? [];
}

export async function workerScopeCovers(ctx: ExtensionContext, paths: string[]): Promise<boolean> {
	const scope = workerRowScope(ctx);
	const resources = (scope?.rows.flatMap(row => row.schedule?.resources ?? []) ?? [])
		.map(resource => resource.replace(/^(?:path|repo|repository|checkout|worktree):/, "").replace(/:[^/]+$/, ""))
		.filter(resource => path.isAbsolute(resource));
	const roots = await Promise.all(
		resources.map(resource =>
			canonical(
				path.resolve(
					ctx.cwd,
					resource.replace(/^(?:path|repo|repository|checkout|worktree):/, "").replace(/:[^/]+$/, ""),
				),
			),
		),
	);
	if (!roots.length) return false;
	for (const target of paths) {
		const resolved = await canonical(path.resolve(ctx.cwd, target));
		if (!roots.some(root => inside(root, resolved))) return false;
	}
	return true;
}

export async function workerToolPreflight(
	event: { toolName: string; input?: unknown },
	ctx: ExtensionContext,
	probes?: HostResourceProbes,
): Promise<{ block: true; reason: string } | undefined> {
	if (ctx.agent?.kind !== "sub" || !ctx.cwd) return;
	const input = (event.input ?? {}) as Record<string, unknown>;
	const actions =
		event.toolName === "bash" && typeof input.command === "string" ? shellActions(input.command, ctx.cwd) : [];
	const targets = ["edit", "write", "ast_edit"].includes(event.toolName) ? fileToolTargets(input) : [];
	for (const action of actions)
		targets.push(
			...[...action.targets, ...bashWriteTargets(action.argv)].map(target => path.resolve(action.cwd, target)),
		);
	const root = await canonical(path.resolve(ctx.cwd));
	const scope = workerRowScope(ctx);
	const rows = scope?.rows ?? [];
	const declared = rows
		.flatMap(row => row.schedule?.resources ?? [])
		.map(resource => resource.replace(/^(?:path|repo|repository|checkout|worktree):/, "").replace(/:[^/]+$/, ""))
		.filter(resource => path.isAbsolute(resource));
	const roots = declared.length ? await Promise.all(declared.map(canonical)) : [root];
	for (const target of targets) {
		if (target.includes("://")) continue;
		const resolved = await canonical(
			path.resolve(ctx.cwd, target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target),
		);
		for (const other of scope?.phases.flatMap(phase => phase.tasks) ?? []) {
			if (rows.includes(other) || other.status === "completed" || other.status === "abandoned") continue;
			for (const resource of other.schedule?.resources ?? []) {
				const resourcePath = resource
					.replace(/^(?:path|repo|repository|checkout|worktree):/, "")
					.replace(/:[^/]+$/, "");
				if (path.isAbsolute(resourcePath) && inside(await canonical(resourcePath), resolved))
					return { block: true, reason: `Write conflicts with row ${JSON.stringify(other.content)}.` };
			}
		}
		if (!roots.some(allowed => inside(allowed, resolved)))
			return {
				block: true,
				reason: `Outside your worktree: add ${resolved} to row ${JSON.stringify(rows.map(row => row.content).join(", ") || ctx.agent?.id || "<worker row>")} resources via todo schedule; applies to the running worker. Use an absolute path. If its worktree disappeared, restore it or put the replacement absolute worktree path in that row resources, then retry. Call resource_scope with the absolute paths; assigned paths return granted immediately.`,
			};
	}
	const app = input.app as { relay?: boolean; cdp_url?: string } | undefined;
	const opensBrowser = event.toolName === "browser" && input.action === "open" && app?.relay !== true && !app?.cdp_url;
	if (!opensBrowser && !actions.some(action => launchesTestProcess(action.argv))) return;
	const resources = await probeHostTestResources(probes);
	const running = resources.processes.filter(
		proc => inside(root, path.resolve(proc.cwd)) && launchesTestProcess(proc.argv ?? commandArgv(proc.command)),
	);
	const available = resources.memAvailableKiB;
	const minimum = ramThresholdGiB();
	const capacity =
		available === undefined
			? 0
			: Math.min(resources.cpus, Math.floor(Math.max(0, available - minimum * 1024 ** 2) / TEST_RUN_KIB));
	const gpuRun =
		input.gpu === true ||
		actions.some(action => requiresHardwareGpu(action.argv)) ||
		(typeof input.command === "string" && /(?:^|\s)OMP_TEST_GPU=1(?:\s|$)/.test(input.command));
	const gpuCapacity =
		resources.gpuFreeMiB?.reduce(
			(sum, free) => sum + Math.floor(Math.max(0, free - GPU_FLOOR_MIB) / GPU_RUN_MIB),
			0,
		) ?? 0;
	if (running.length < capacity && (!gpuRun || gpuCapacity > 0)) return;
	return {
		block: true,
		reason: `Test capacity refused: MemAvailable=${available === undefined ? "unknown" : `${(available / 1024 ** 2).toFixed(2)} GiB (${available} KiB)`}; minimum=${minimum} GiB; budget=4 GiB/run; CPUs=${resources.cpus}; N=${capacity}; same-project test processes=${running.length} (PIDs ${running.map(proc => proc.pid).join(", ")}); project=${root}. ${gpuRun ? `Hardware GPU free MiB per device=${JSON.stringify(resources.gpuFreeMiB ?? "unknown")}; GPU budget=${GPU_RUN_MIB} MiB/run; device floor=${GPU_FLOOR_MIB} MiB; additional GPU slots=${gpuCapacity}. ` : ""}Retry when running count is below N and MemAvailable covers the floor plus one 4 GiB run${gpuRun ? " and a hardware GPU has at least 2048 MiB free" : ""}; a listed PID exiting releases its run, but admission re-probes memory and CPUs. Wait 30–60 s or do independent work; never stop another run.`,
	};
}
