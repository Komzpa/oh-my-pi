import {
	readOnlyClaim,
	checkoutScopesFromResources,
	checkoutScopesOverlap,
	checkoutScopesContain,
} from "./checkout_scope";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { restoringAgentIds } from "@oh-my-pi/pi-coding-agent/registry/restoring-agents";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import type { TodoScheduleInputTask, TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
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
			if (char === ">" && command[i + 1] === "&") {
				tokens.push(">&");
				i++;
				continue;
			}
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
	if (tokens.some(token => [";", "&&", "||", "|", "\n", ">", ">>", ">&"].includes(token))) return [];
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
		if (token === ">" || token === ">>" || token === ">&") {
			const target = decode(tokens[++i] ?? "");
			if (token === ">&" && target && /^(?:\d+|-)$/.test(target)) continue;
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
	const operands: string[] = [];
	const valueOptions: Record<string, Record<string, string>> = {
		mkdir: { m: "mode" },
		touch: { d: "date", r: "reference", t: "time" },
		truncate: { s: "size", r: "reference" },
		cp: { t: "target-directory", S: "suffix" },
		install: { t: "target-directory", m: "mode", o: "owner", g: "group", S: "suffix" },
		mv: { t: "target-directory", S: "suffix" },
	};
	const values = valueOptions[executable] ?? {};
	let targetDirectory: string | undefined;
	let directoryMode = false;
	let options = true;
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index]!;
		if (options && arg === "--") {
			options = false;
			continue;
		}
		if (options && arg.startsWith("-")) {
			if (arg.startsWith("--")) {
				const [name, attached] = arg.slice(2).split(/=(.*)/s);
				if (
					Object.values(values).includes(name!) ||
					(executable === "touch" && name === "time") ||
					(executable === "install" && name === "strip-program")
				) {
					const value = attached ?? argv[++index];
					if (name === "target-directory") targetDirectory = value;
				}
				if (executable === "install" && name === "directory") directoryMode = true;
			} else {
				for (let offset = 1; offset < arg.length; offset++) {
					const option = arg[offset]!;
					if (executable === "install" && option === "d") directoryMode = true;
					if (!(option in values)) continue;
					const value = arg.slice(offset + 1) || argv[++index];
					if (option === "t" && values.t === "target-directory") targetDirectory = value;
					break;
				}
			}
			continue;
		}
		operands.push(arg);
	}
	if (["touch", "mkdir", "rm", "rmdir", "truncate", "tee"].includes(executable)) return operands;
	if (targetDirectory !== undefined && ["cp", "install", "mv"].includes(executable)) {
		const destinations = operands.map(source => path.join(targetDirectory!, path.basename(source)));
		return executable === "mv" ? [...operands, ...destinations] : destinations;
	}
	if (executable === "install" && directoryMode) return operands;
	if (["cp", "install"].includes(executable)) return operands.length >= 2 ? operands.slice(-1) : [];
	if (executable === "mv") return operands.length >= 2 ? operands : [];
	return [];
}

export function currentRowOwner(
	row: TodoScheduleInputTask,
	owner: string,
	registry: AgentRegistryApi = AgentRegistry.global(),
): boolean {
	if (row.status === "completed" || row.status === "abandoned") return false;
	const executor = row.schedule?.executor;
	const settled = executor?.finishedAt !== undefined || executor?.outcome !== undefined;
	if (row.schedule?.owner !== owner && (row.schedule?.owner || executor?.workerId !== owner || settled)) return false;
	const ref = registry.get(owner);
	if (ref?.todoRow && ref.todoRow !== row.content) return false;
	if (executor?.workerId !== owner || !settled) return true;
	// Historical settlement does not revoke a currently assigned IRC continuation.
	// A different current assignment, or a genuinely idle settled owner, still revokes it.
	return Boolean(ref && registry.isRunning(ref)) || restoringAgentIds(registry).includes(owner);
}

/** Read the parent's current plan, never the child's copied TODO snapshot. */
export function workerRowScope(ctx: ExtensionContext) {
	const registry = ctx.agentRegistry ?? AgentRegistry.global();
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
		const rows = phases.flatMap(phase => phase.tasks).filter(row => currentRowOwner(row, owner, registry));
		if (rows.length) return { rows, phases, lead: lead!, registry };
	}
	// A known parent with no current assignment is a revoked/missing grant,
	// never permission to inherit the entire working directory after a restart.
	return lead ? { rows: [], phases, lead, registry } : undefined;
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

/** The same current assignment grants worker scope and protects it from competing admission. */
export function holdsWriteCustody(
	row: TodoScheduleInputTask,
	registry: AgentRegistryApi = AgentRegistry.global(),
): boolean {
	const owner = row.schedule?.owner ?? row.schedule?.executor?.workerId;
	return (
		row.status !== "completed" &&
		row.status !== "abandoned" &&
		!readOnlyClaim(row) &&
		row.schedule?.resourceWait === undefined &&
		(owner ? currentRowOwner(row, owner, registry) : row.status !== "pending")
	);
}

// Per canonical lead session, retained only while the owning row remains open.
const writeClaims = new WeakMap<object, Map<string, string[]>>();

export async function workerToolPreflight(
	event: { toolName: string; input?: unknown },
	ctx: ExtensionContext,
	probes?: HostResourceProbes,
): Promise<{ block: true; reason: string } | undefined> {
	if (ctx.agent?.kind !== "sub" || !ctx.cwd) return;
	const input = (event.input ?? {}) as Record<string, unknown>;
	const bashCwd = typeof input.cwd === "string" && input.cwd ? resolveToCwd(input.cwd, ctx.cwd) : ctx.cwd;
	const actions =
		event.toolName === "bash" && typeof input.command === "string" ? shellActions(input.command, bashCwd) : [];
	const targets = ["edit", "write", "ast_edit"].includes(event.toolName) ? fileToolTargets(input) : [];
	for (const action of actions)
		targets.push(
			...[...action.targets, ...bashWriteTargets(action.argv)].map(target => path.resolve(action.cwd, target)),
		);
	const root = await canonical(path.resolve(ctx.cwd));
	const scope = workerRowScope(ctx);
	const rows = scope?.rows ?? [];
	if (targets.length && rows.some(row => readOnlyClaim(row)))
		return { block: true, reason: "Read-only row cannot mutate files; dispatch a writer on a separate row." };
	const declared = rows
		.flatMap(row => row.schedule?.resources ?? [])
		.map(resource => resource.replace(/^(?:path|repo|repository|checkout|worktree):/, "").replace(/:[^/]+$/, ""))
		.filter(resource => path.isAbsolute(resource));
	// Explicit scope, including [], replaces the legacy cwd permission. A
	// declaration without filesystem paths grants no writes. Only an absent
	// declaration keeps cwd access, still subject to other workers' leases.
	const hasDeclaredScope =
		Boolean(ctx.agent?.parentId && !rows.length) || rows.some(row => Array.isArray(row.schedule?.resources));
	const roots = declared.length ? await Promise.all(declared.map(canonical)) : hasDeclaredScope ? [] : [root];
	const resolvedTargets: string[] = [];
	for (const target of targets) {
		if (target.includes("://")) continue;
		const resolved = await canonical(
			path.resolve(ctx.cwd, target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target),
		);
		resolvedTargets.push(resolved);
		for (const other of scope?.phases.flatMap(phase => phase.tasks) ?? []) {
			if (rows.includes(other) || !holdsWriteCustody(other, scope?.registry)) continue;
			for (const resource of other.schedule?.resources ?? []) {
				const resourcePath = resource
					.replace(/^(?:path|repo|repository|checkout|worktree):/, "")
					.replace(/:[^/]+$/, "");
				if (
					path.isAbsolute(resourcePath) &&
					(inside(await canonical(resourcePath), resolved) || inside(resolved, await canonical(resourcePath)))
				)
					return {
						block: true,
						reason: `Write conflicts with row ${JSON.stringify(other.content)} (owner ${other.schedule?.owner ?? other.schedule?.executor?.workerId ?? "unassigned"}); wait for that writer, or have Main call todo {op:"schedule",updates:[{task:${JSON.stringify(rows[0]?.content ?? "<worker row>")},resources:[<disjoint absolute paths>]}]}.`,
					};
			}
		}
		if (!roots.some(allowed => inside(allowed, resolved)))
			return {
				block: true,
				reason: `Outside your worktree: add ${resolved} to row ${JSON.stringify(rows.map(row => row.content).join(", ") || ctx.agent?.id || "<worker row>")} resources via todo schedule; applies to the running worker. Use an absolute path. If its worktree disappeared, restore it or put the replacement absolute worktree path in that row resources, then retry. Call resource_scope {paths:[${JSON.stringify(resolved)}]}, then yield with error:"Scope pending: awaiting lead schedule" if pending; Main receives the exact todo schedule call.`,
			};
	}
	if (scope?.lead.session && targets.length) {
		const owner = rows[0]?.schedule?.owner ?? ctx.agent?.id;
		const incoming = checkoutScopesFromResources(resolvedTargets);
		if (owner && incoming) {
			const claims = writeClaims.get(scope.lead.session) ?? new Map<string, string[]>();
			writeClaims.set(scope.lead.session, claims);
			const open = scope.phases.flatMap(phase => phase.tasks).filter(row => holdsWriteCustody(row, scope.registry));
			// No await between observing and acquiring exact write targets.
			for (const [holder, held] of claims) {
				const holderRows = open.filter(row => currentRowOwner(row, holder, scope.registry));
				const retained = held.filter(target =>
					holderRows.some(row => {
						if (!Array.isArray(row.schedule?.resources)) return true;
						const allowed = checkoutScopesFromResources(
							row.schedule.resources.filter(resource => !resource.startsWith("git:")),
						);
						return allowed && checkoutScopesContain(allowed, [target]);
					}),
				);
				if (!retained.length) {
					claims.delete(holder);
					continue;
				}
				claims.set(holder, retained);
				if (holder !== owner && checkoutScopesOverlap(incoming, retained))
					return {
						block: true,
						reason: `Write conflicts with worker ${holder} on ${JSON.stringify(targets)}; narrow tasks[].resources or wait for its row to finish.`,
					};
			}
			claims.set(owner, [...new Set([...(claims.get(owner) ?? []), ...incoming])]);
		}
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
