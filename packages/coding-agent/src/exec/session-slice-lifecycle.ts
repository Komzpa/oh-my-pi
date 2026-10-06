import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionSliceName } from "@oh-my-pi/pi-natives";
import { getDaemonRuntimeRoot, logger, postmortem, prompt } from "@oh-my-pi/pi-utils";
import { hasLiveIsolationOwner, ISOLATION_OWNER_FILE, writeIsolationOwner } from "../task/isolation-ownership";
import cpuNoticeTemplate from "../prompts/session/owned-cpu.md" with { type: "text" };

const registryRoot = path.join(path.dirname(getDaemonRuntimeRoot()), "session-slices");
const sessionSlicePattern = /^omp-tool-[A-Za-z0-9]+\.slice$/;

async function systemctl(args: string[]): Promise<string> {
	const child = Bun.spawn(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe", timeout: 3_000 });
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`systemctl ${args.join(" ")}: ${error.trim()}`);
	return out.trim();
}

/** Unknown/pre-cutover units are never reclaimed: a name alone is not ownership. */
export async function reapOrphanSessionSlices(root = registryRoot): Promise<string[]> {
	if (process.platform !== "linux") return [];
	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const reaped: string[] = [];
	for (const slice of entries) {
		if (!sessionSlicePattern.test(slice)) continue;
		const directory = path.join(root, slice);
		try {
			const owner: unknown = await Bun.file(path.join(directory, ISOLATION_OWNER_FILE)).json();
			const boot = await Bun.file(path.join(directory, "boot-id")).text();
			if (
				typeof owner !== "object" ||
				owner === null ||
				!("id" in owner) ||
				typeof owner.id !== "string" ||
				!("pid" in owner) ||
				typeof owner.pid !== "number" ||
				!Number.isInteger(owner.pid) ||
				owner.pid <= 0 ||
				!("startToken" in owner) ||
				typeof owner.startToken !== "string" ||
				!owner.startToken ||
				!/^[0-9a-f-]{36}\n?$/.test(boot)
			)
				continue;
			if (sessionSliceName(owner.id) !== slice) continue;
			// Only ESRCH or a different start token/boot proves the recorded instance gone.
			const currentBoot = await Bun.file("/proc/sys/kernel/random/boot_id").text();
			if (boot === currentBoot && (await hasLiveIsolationOwner(directory))) continue;
			await systemctl(["stop", slice]);
			await fs.rm(directory, { recursive: true, force: true });
			reaped.push(slice);
		} catch (error) {
			logger.debug("Leaving unproven session slice alone", { slice, error: String(error) });
		}
	}
	return reaped;
}

export interface CpuGroup {
	name: string;
	usage: number;
	pids: number[];
}

/** One user-visible status line per hidden sustained-CPU notice. */
export function formatHogUserLine(unit: string, cores: number): string {
	return `sustained CPU in session slice: ${unit} ${Math.round(cores * 100)}% — agent notified`;
}

async function cpuGroups(directory: string, name: string): Promise<CpuGroup[]> {
	const stat = await Bun.file(path.join(directory, "cpu.stat")).text();
	const usage = Number(/^usage_usec (\d+)$/m.exec(stat)?.[1]);
	const pids = (await Bun.file(path.join(directory, "cgroup.procs")).text())
		.trim()
		.split(/\s+/)
		.map(Number)
		.filter(pid => pid > 0);
	const groups: CpuGroup[] = [{ name, usage, pids }];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		try {
			groups.push(...(await cpuGroups(path.join(directory, entry.name), entry.name)));
		} catch {
			// A child exiting between directory enumeration and cpu.stat is normal.
		}
	}
	return groups;
}

export interface SessionSliceHost {
	sessionId: string;
	isIdleOrWaiting(): boolean;
	sendNotice(content: string): Promise<void>;
	/** User-visible status line; fires exactly as often as sendNotice. */
	sendUserLine?(line: string): void | Promise<void>;
}

/** Owns the transcript boundary, not the model/provider cache identity. */
export class SessionSliceLifecycle {
	readonly slice: string;
	readonly ready: Promise<void>;
	#host: SessionSliceHost;
	#root: string;
	#groupsFn: (slice: string) => Promise<CpuGroup[]>;
	#owned = false;
	#stopped = false;
	#stopCall?: Promise<void>;
	#timer?: NodeJS.Timeout;
	#polling = false;
	#previous = new Map<string, number>();
	#previousAt = 0;
	#hotSamples = 0;
	#lastPicture = "";
	#cancelExit?: () => void;
	#exitSync: () => void;

	constructor(
		host: SessionSliceHost,
		root = registryRoot,
		deps: { groups?: (slice: string) => Promise<CpuGroup[]> } = {},
	) {
		this.#host = host;
		this.#root = root;
		this.#groupsFn = deps.groups ?? (slice => this.#groups(slice));
		this.slice = sessionSliceName(host.sessionId);
		this.#exitSync = () => {
			if (!this.#owned) return;
			// Raw process.exit cannot await postmortem. Leave the marker on failure so startup retries.
			Bun.spawnSync(["systemctl", "--user", "stop", this.slice], {
				timeout: 3_000,
				stdout: "ignore",
				stderr: "ignore",
			});
		};
		this.ready = this.#start();
		this.#cancelExit = postmortem.register(`session-slice:${this.slice}`, () => this.stop(), { exitOnly: true });
		process.on("exit", this.#exitSync);
		void this.ready.catch(error =>
			logger.warn("Session slice ownership unavailable", { slice: this.slice, error: String(error) }),
		);
	}

	async #start(): Promise<void> {
		if (process.platform !== "linux") return;
		await reapOrphanSessionSlices(this.#root);
		const directory = path.join(this.#root, this.slice);
		await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
		// Exclusive creation prevents another live process from stealing the canonical slice.
		await fs.mkdir(directory, { mode: 0o700 });
		await writeIsolationOwner(directory, this.#host.sessionId);
		await Bun.write(path.join(directory, "boot-id"), await Bun.file("/proc/sys/kernel/random/boot_id").text());
		this.#owned = true;
		if (this.#stopped) return;
		this.#timer = setInterval(
			() =>
				void this.poll().catch(error => logger.debug("Session CPU sample unavailable", { error: String(error) })),
			15_000,
		);
		this.#timer.unref();
		await this.poll().catch(error =>
			logger.debug("Initial session CPU sample unavailable", { error: String(error) }),
		);
	}

	async #groups(slice: string): Promise<CpuGroup[]> {
		const cgroup = await systemctl(["show", slice, "-p", "ControlGroup", "--value"]);
		if (!cgroup.startsWith("/") || cgroup === "/" || cgroup.split("/").includes("..")) return [];
		return cpuGroups(path.join("/sys/fs/cgroup", cgroup), slice);
	}

	async keptMembers(): Promise<string[]> {
		const members: string[] = [];
		let groups: CpuGroup[];
		try {
			groups = await this.#groups("omp-keep.slice");
		} catch {
			return members;
		}
		for (const group of groups) {
			for (const pid of group.pids) {
				try {
					const environment = (await Bun.file(`/proc/${pid}/environ`).text()).split("\0");
					if (environment.includes(`OMP_SESSION_ID=${this.#host.sessionId}`))
						members.push(`${group.name} pid=${pid}`);
				} catch {
					// A name alone cannot attribute another session's kept process.
				}
			}
		}
		return members.sort();
	}

	async poll(now = Date.now()): Promise<void> {
		if (!this.#owned || this.#stopped || this.#polling) return;
		this.#polling = true;
		try {
			const groups = await this.#groupsFn(this.slice);
			const total = groups[0];
			if (!total) return;
			const elapsed = (now - this.#previousAt) / 1_000;
			const delta = total.usage - (this.#previous.get(this.slice) ?? total.usage);
			const candidates = groups.filter(group => group.pids.length > 0);
			candidates.sort(
				(a, b) =>
					b.usage - (this.#previous.get(b.name) ?? b.usage) - (a.usage - (this.#previous.get(a.name) ?? a.usage)),
			);
			this.#previous = new Map(groups.map(group => [group.name, group.usage]));
			this.#previousAt = now;
			// Two 15s windows at >= half a core ignore startup bursts but catch a forgotten busy loop in ~30s.
			const cores = elapsed > 0 ? delta / 1_000_000 / elapsed : 0;
			if (!this.#host.isIdleOrWaiting() || elapsed < 10 || cores < 0.5) {
				this.#hotSamples = 0;
				return;
			}
			if (++this.#hotSamples < 2) return;
			const top = candidates[0] ?? total;
			const kept = await this.keptMembers();
			// CPU seconds monotonically increase; they must NOT be part of the dedupe key.
			const picture = JSON.stringify([top.name, top.pids, cores < 4 ? "ordinary" : "many", kept]);
			if (picture === this.#lastPicture || this.#stopped) return;
			await this.#host.sendNotice(
				prompt.render(cpuNoticeTemplate, {
					slice: this.slice,
					top: top.name,
					pid: top.pids[0],
					seconds: (top.usage / 1_000_000).toFixed(1),
					kept: kept.length ? kept.join(", ") : "none",
				}),
			);
			await this.#host.sendUserLine?.(formatHogUserLine(top.name, cores));
			this.#lastPicture = picture;
		} finally {
			this.#polling = false;
		}
	}

	stop(): Promise<void> {
		if (!this.#stopCall) this.#stopCall = this.#stop();
		return this.#stopCall;
	}

	async #stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#timer);
		try {
			await this.ready;
		} finally {
			if (!this.#owned) {
				this.#cancelExit?.();
				process.off("exit", this.#exitSync);
			}
		}
		if (!this.#owned) return;
		const kept = await this.keptMembers();
		if (kept.length)
			logger.info("Session kept processes survive exit", { sessionId: this.#host.sessionId, members: kept });
		await systemctl(["stop", this.slice]);
		this.#owned = false;
		this.#cancelExit?.();
		process.off("exit", this.#exitSync);
		await fs.rm(path.join(this.#root, this.slice), { recursive: true, force: true });
	}
}
