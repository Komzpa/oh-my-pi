import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const READ_ONLY = new Set(["scout", "researcher", "reviewer", "visual-qa", "adversary", "user-shadow"]);
const PATH =
	/(?:~\/|\/[\w.-]|\.\.?\/)[^\s`'",;()[\]<>]*|\b[\w.-]+(?:\/[\w.*-]+)+\/?|\b[\w.-]+\/|\b[\w-]+\.[a-z][a-z0-9]*\b/g;

function paths(text: string): string[] {
	return [...text.matchAll(PATH)].map(match => match[0].replace(/[:.]\d+(?:-\d+)?$/, "").replace(/[.:]+$/, ""));
}

function absolute(value: string, cwd: string): string {
	return path.resolve(
		cwd,
		value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value.replace(/[.,;]+$/, ""),
	);
}

/** Only explicit change clauses are targets: references and read-only evidence are not writes. */
export function uncoveredWriteTargets(brief: string, cwd: string, agent: string): string[] {
	if (READ_ONLY.has(agent.replace(/-strong$/, ""))) return [];
	const worktree = brief.match(/\b(?:Worktree\s*:|ROOT\s*=)\s*[`'"]?([^\s`'",;)]+)/i)?.[1];
	const base = worktree ? absolute(worktree, cwd) : cwd;
	const roots: string[] = [];
	const targets: string[] = [];
	let rootList = false;
	let changeSection = false;
	let targetList = false;
	for (let line of brief.split("\n")) {
		const declaration = line.match(/\b(?:write\s+roots?\s*:?|write\s+only\b|write(?=\s+[`'"]?(?:\/|~\/)))\s*(.*)/i);
		if (declaration) {
			const rest = declaration[1]!;
			const boundary = rest.search(/\.(?=\s+[A-Z])|\b(?:Do not|Never)\b/i);
			roots.push(...paths(boundary < 0 ? rest : rest.slice(0, boundary)));
			rootList = rest.trim() === "";
			if (boundary < 0) continue;
			line = rest.slice(boundary).replace(/^\.\s*/, "");
		}
		if (rootList && /^\s*[-*]\s+/.test(line)) {
			roots.push(...paths(line));
			continue;
		}
		rootList = false;
		if (/\b(?:files|paths|targets)\s+(?:to\s+)?(?:change|edit|modify)\s*:\s*$/i.test(line)) {
			targetList = true;
			continue;
		}
		if (targetList && /^\s*[-*]\s+/.test(line)) {
			targets.push(...paths(line));
			continue;
		}
		targetList = false;
		if (/^\s*#/.test(line)) changeSection = /\b(?:change|fix|edit|implement|targets?)\b/i.test(line);
		// Sentence boundaries keep "Read foo.ts. Update bar.ts" from treating the reference as a target.
		for (const clause of line.split(/(?<=[.!?])\s+|;/)) {
			if (/\b(?:do not|don't|never|read.only|read|inspect|reference|source|evidence)\b/i.test(clause)) continue;
			if (
				changeSection ||
				/\b(?:change|edit|modify|update|fix|create|delete|remove|rewrite|patch|touch|implement|targets?)\b/i.test(
					clause,
				)
			)
				targets.push(...paths(clause));
		}
	}
	// A worktree is the writable fallback only when there is no narrower declaration.
	if (!roots.length && worktree && /\bWorktree\s*:/i.test(brief)) roots.push(base);
	if (!roots.length) return [];
	const allowed = roots.map(root => absolute(root, base).replace(/\/\*\*?$/, ""));
	return [...new Set(targets.map(target => absolute(target, base)))].filter(
		target => !allowed.some(root => target === root || target.startsWith(`${root}${path.sep}`)),
	);
}

export function heavyTestBrief(brief: string): boolean {
	return /\b(?:e2e|browser|playwright|full[ -]suite)\b/i.test(brief);
}

export interface TestProcess {
	pid: number;
	cwd: string;
	command: string;
}
export interface HostTestResources {
	memAvailableKiB?: number;
	processes: TestProcess[];
}
export interface HostResourceProbes {
	meminfo: () => Promise<string>;
	processes: () => Promise<TestProcess[]>;
}

/** A process disappearing during the scan is normal. No shell or user browser access. */
async function testProcesses(): Promise<TestProcess[]> {
	const entries = await fs.readdir("/proc");
	const found: TestProcess[] = [];
	for (const pid of entries.filter(entry => /^\d+$/.test(entry))) {
		try {
			const command = (await Bun.file(`/proc/${pid}/cmdline`).text()).replaceAll("\0", " ");
			if (!/\b(?:playwright|chromium|chrome-headless-shell)\b/i.test(command)) continue;
			found.push({ pid: Number(pid), command, cwd: await fs.readlink(`/proc/${pid}/cwd`) });
		} catch {
			/* exited or inaccessible */
		}
	}
	return found;
}

export async function probeHostTestResources(
	probes: HostResourceProbes = {
		meminfo: () => Bun.file("/proc/meminfo").text(),
		processes: testProcesses,
	},
): Promise<HostTestResources> {
	const [memory, processes] = await Promise.allSettled([probes.meminfo(), probes.processes()]);
	const available =
		memory.status === "fulfilled" ? memory.value.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1] : undefined;
	return {
		memAvailableKiB: available === undefined ? undefined : Number(available),
		processes: processes.status === "fulfilled" ? processes.value : [],
	};
}

export function ramThresholdGiB(value = process.env.OMP_DISPATCH_MIN_RAM_GIB): number {
	const parsed = Number(value);
	return value?.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : 8;
}

/** Pure admission decision; a browser elsewhere on the host is not this project's suite. */
export function heavyTestRefusal(
	brief: string,
	cwd: string,
	resources: HostTestResources,
	thresholdGiB = 8,
): string | undefined {
	if (!heavyTestBrief(brief)) return undefined;
	const project = absolute(brief.match(/\b(?:Worktree\s*:|ROOT\s*=)\s*[`'"]?([^\s`'",;)]+)/i)?.[1] ?? cwd, cwd);
	const running = resources.processes.filter(proc => {
		const inProject = proc.cwd === project || proc.cwd.startsWith(`${project}${path.sep}`);
		return inProject && /\b(?:playwright\b.*\btest\b|chromium|chrome-headless-shell)\b/i.test(proc.command);
	});
	const available = resources.memAvailableKiB;
	if ((available === undefined || available >= thresholdGiB * 1024 ** 2) && !running.length) return undefined;
	return `Queue it behind the running suite (one suite at a time) or run only targeted specs. MemAvailable=${available === undefined ? "unknown" : `${(available / 1024 ** 2).toFixed(2)} GiB (${available} KiB)`}; minimum=${thresholdGiB} GiB; same-project test processes=${running.length}${running.length ? ` (PIDs ${running.map(proc => proc.pid).join(", ")})` : ""}; project=${project}.`;
}
